import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const cli = join(directory, "skillsctl");
const root = await mkdtemp(join(tmpdir(), "skillsctl-test-"));
const store = join(root, "store");
const target = join(root, "codex-skills");

function run(args, extraEnv = {}) {
  return execFileSync(cli, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      SKILLSCTL_CODEX_DIR: target,
      ...extraEnv
    }
  });
}

async function makeSkill(name, description, extra = {}) {
  const path = join(root, "sources", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: >-\n  ${description}\n  across supported agents.\n---\n\n# ${name}\n`
  );
  for (const [relative, content] of Object.entries(extra)) {
    await mkdir(dirname(join(path, relative)), { recursive: true });
    await writeFile(join(path, relative), content);
  }
  return path;
}

run(["init", "--store", store, "--yes"]);
assert.equal(run(["-V"]).trim(), "skillsctl 0.2.0");
assert.match(run(["status", "--store", store]), /Skills: 0[\s\S]*Packs:\s+5/);

const frontend = await makeSkill("frontend-dev", "Build responsive frontend interfaces", {
  "scripts/check.sh": "#!/usr/bin/env sh\nexit 0\n"
});
await chmod(join(frontend, "scripts/check.sh"), 0o755);
const backend = await makeSkill("backend-dev", "Build reliable backend services");

run(["skill", "add", frontend, "--store", store, "--yes"]);
run(["skill", "add", backend, "--store", store, "--yes"]);
assert.match(run(["list", "--store", store]), /frontend-dev\tBuild responsive frontend interfaces across supported agents\./);

run(["pack", "add", "frontend", "frontend-dev", "--store", store, "--yes"]);
run(["pack", "add", "backend", "backend-dev", "--store", store, "--yes"]);
let fullstack = JSON.parse(run(["pack", "show", "fullstack", "--store", store]));
assert.deepEqual(fullstack.resolved, ["backend-dev", "frontend-dev"]);

run(["pack", "disable", "fullstack", "frontend-dev", "--store", store, "--yes"]);
fullstack = JSON.parse(run(["pack", "show", "fullstack", "--store", store]));
assert.deepEqual(fullstack.resolved, ["backend-dev"]);
run(["pack", "remove", "fullstack", "frontend-dev", "--store", store, "--yes"]);

const preview = run(["plan", "--target", "codex", "--pack", "frontend", "--store", store]);
assert.match(preview, /create\s+frontend-dev/);
run(["apply", "--target", "codex", "--pack", "frontend", "--store", store, "--yes"]);
assert.equal((await lstat(join(target, "frontend-dev"))).isSymbolicLink(), true);
assert.equal(
  resolve(dirname(join(target, "frontend-dev")), await readlink(join(target, "frontend-dev"))),
  join(store, "skills", "frontend-dev")
);

const disablePreview = run([
  "skill", "disable", "frontend-dev", "--target", "codex", "--store", store
]);
assert.match(disablePreview, /remove\s+frontend-dev/);
assert.equal((await lstat(join(target, "frontend-dev"))).isSymbolicLink(), true);
run([
  "skill", "disable", "frontend-dev", "--target", "codex", "--store", store, "--yes"
]);
await assert.rejects(lstat(join(target, "frontend-dev")), { code: "ENOENT" });
let codexState = JSON.parse(await readFile(join(store, "state", "codex.json"), "utf8"));
assert.equal(codexState.selection_mode, "manual");
assert.equal(codexState.base_pack, "frontend");
assert.deepEqual(codexState.links, {});

const enablePreview = run([
  "skill", "enable", "frontend-dev", "--target", "codex", "--store", store
]);
assert.match(enablePreview, /create\s+frontend-dev/);
await assert.rejects(lstat(join(target, "frontend-dev")), { code: "ENOENT" });
run([
  "skill", "enable", "frontend-dev", "--target", "codex", "--store", store, "--yes"
]);
assert.equal((await lstat(join(target, "frontend-dev"))).isSymbolicLink(), true);
codexState = JSON.parse(await readFile(join(store, "state", "codex.json"), "utf8"));
assert.equal(codexState.selection_mode, "manual");
assert.equal(codexState.base_pack, "frontend");
assert.deepEqual(Object.keys(codexState.links), ["frontend-dev"]);
assert.match(run(["status", "--store", store]), /codex: 1 managed links \(custom based on frontend\)/);

run(["apply", "--target", "codex", "--pack", "backend", "--store", store, "--yes"]);
await assert.rejects(lstat(join(target, "frontend-dev")), { code: "ENOENT" });
assert.equal((await lstat(join(target, "backend-dev"))).isSymbolicLink(), true);
codexState = JSON.parse(await readFile(join(store, "state", "codex.json"), "utf8"));
assert.equal(codexState.selection_mode, "pack");
assert.equal(codexState.pack, "backend");
run(["apply", "--target", "codex", "--pack", "frontend", "--store", store, "--yes"]);

const claudeTarget = join(root, "claude-skills");
await mkdir(claudeTarget, { recursive: true });
await cp(frontend, join(claudeTarget, "frontend-dev"), { recursive: true });
const unmanagedDisable = spawnSync(
  cli,
  [
    "skill", "disable", "frontend-dev", "--target", "claude", "--store", store, "--yes"
  ],
  {
    encoding: "utf8",
    env: { ...process.env, SKILLSCTL_CLAUDE_DIR: claudeTarget }
  }
);
assert.notEqual(unmanagedDisable.status, 0);
assert.match(unmanagedDisable.stderr, /is not managed by skillsctl/);
assert.equal((await lstat(join(claudeTarget, "frontend-dev"))).isDirectory(), true);

const importPreview = run(
  ["import", "--target", "claude", "--store", store],
  { SKILLSCTL_CLAUDE_DIR: claudeTarget }
);
assert.match(importPreview, /keep\s+adopt\s+frontend-dev/);
assert.equal((await lstat(join(claudeTarget, "frontend-dev"))).isDirectory(), true);
const importOutput = run(
  ["import", "--target", "claude", "--store", store, "--write"],
  { SKILLSCTL_CLAUDE_DIR: claudeTarget }
);
assert.match(importOutput, /Adopted 1 claude skill\(s\)/);
assert.match(importOutput, /Preserved original target entries at/);
assert.equal((await lstat(join(claudeTarget, "frontend-dev"))).isSymbolicLink(), true);
assert.equal(
  resolve(
    dirname(join(claudeTarget, "frontend-dev")),
    await readlink(join(claudeTarget, "frontend-dev"))
  ),
  join(store, "skills", "frontend-dev")
);
const claudeState = JSON.parse(await readFile(join(store, "state", "claude.json"), "utf8"));
assert.equal(claudeState.selection_mode, "pack");
assert.equal(claudeState.pack, "imported-claude");
const importBackups = (await readdir(join(store, "backups")))
  .filter((name) => name.startsWith("import-claude-"));
assert.equal(importBackups.length, 1);
const importBackup = join(store, "backups", importBackups[0]);
assert.equal((await lstat(join(importBackup, "frontend-dev"))).isDirectory(), true);
const importManifest = JSON.parse(await readFile(join(importBackup, "manifest.json"), "utf8"));
assert.equal(importManifest.kind, "skillsctl-import-backup");
assert.deepEqual(importManifest.entries.map((entry) => entry.name), ["frontend-dev"]);
const repeatImport = run(
  ["import", "--target", "claude", "--store", store, "--write"],
  { SKILLSCTL_CLAUDE_DIR: claudeTarget }
);
assert.match(repeatImport, /keep\s+managed\s+frontend-dev/);
assert.doesNotMatch(repeatImport, /Preserved original target entries at/);
assert.equal(
  (await readdir(join(store, "backups"))).filter((name) => name.startsWith("import-claude-")).length,
  1
);

run(
  [
    "skill", "disable", "frontend-dev", "--target", "claude", "--store", store, "--yes"
  ],
  { SKILLSCTL_CLAUDE_DIR: claudeTarget }
);
await assert.rejects(lstat(join(claudeTarget, "frontend-dev")), { code: "ENOENT" });
assert.equal((await lstat(join(importBackup, "frontend-dev"))).isDirectory(), true);
assert.match(run(["doctor", "--store", store]), /OK store, packs, checksums, and managed links/);

const snapshot = join(root, "skills.json");
run(["export", "--store", store, "--output", snapshot]);
const exported = JSON.parse(await readFile(snapshot, "utf8"));
assert.equal(exported.kind, "skillsctl-store");
assert.equal(exported.skills["frontend-dev"].files["scripts/check.sh"].mode, 0o700);

const restored = join(root, "restored");
run(["restore-file", "--store", restored, "--input", snapshot, "--yes"]);
assert.match(run(["status", "--store", restored]), /Skills: 2[\s\S]*Packs:\s+6/);

const unsafe = await makeSkill("unsafe-skill", "Contains an accidental secret", {
  ".env": "API_KEY=do-not-copy\n"
});
const rejected = spawnSync(cli, ["skill", "add", unsafe, "--store", store, "--yes"], {
  encoding: "utf8"
});
assert.notEqual(rejected.status, 0);
assert.match(rejected.stderr, /forbidden credential file/);

process.stdout.write(
  "ok  : skillsctl packs, target toggles, safe adoption, links, export, restore, and secret rejection\n"
);
