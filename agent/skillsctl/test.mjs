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
  realpath,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const engine = join(directory, "skillsctl.mjs");
const root = await mkdtemp(join(tmpdir(), "skillsctl-test-"));
const store = join(root, "store");
const target = join(root, "codex-skills");

function run(args, extraEnv = {}) {
  return execFileSync(process.execPath, [engine, ...args], {
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
assert.equal(run(["-V"]).trim(), "skillsctl 0.4.5");
assert.match(run(["status", "--store", store]), /Skills: 0[\s\S]*Packs:\s+5/);

const frontend = await makeSkill("frontend-dev", "Build responsive frontend interfaces", {
  "scripts/check.sh": "#!/usr/bin/env sh\nexit 0\n",
  // A recursive filesystem walk visits the sibling directory `api` before
  // `api-shield`; flattened path sorting reverses them because it compares
  // '/' with '-'. Keep this regression fixture through export and restore.
  "references/api/api.md": "API\n",
  "references/api-shield/api.md": "Shield\n"
});
await chmod(join(frontend, "scripts/check.sh"), 0o755);
const backend = await makeSkill("backend-dev", "Build reliable backend services");

run(["skill", "add", frontend, "--store", store, "--yes"]);
run(["skill", "add", backend, "--store", store, "--yes"]);
assert.match(run(["list", "--store", store]), /frontend-dev\tBuild responsive frontend interfaces across supported agents\./);
const listedSkills = JSON.parse(run(["list", "--store", store, "--json"]));
assert.deepEqual(listedSkills.map(({ name, description }) => ({ name, description })), [
  { name: "backend-dev", description: "Build reliable backend services across supported agents." },
  { name: "frontend-dev", description: "Build responsive frontend interfaces across supported agents." }
]);
for (const skill of listedSkills) assert.match(skill.sha256, /^[a-f0-9]{64}$/);

// Editing through a managed target link changes the canonical Store directly.
// The named Skill can be reviewed and force re-added to accept its new checksum,
// while normal Store reads continue to reject the unacknowledged drift.
const storedFrontend = join(store, "skills", "frontend-dev");
const storedFrontendMarkdown = join(storedFrontend, "SKILL.md");
const storedBackendMarkdown = join(store, "skills", "backend-dev", "SKILL.md");
await writeFile(
  storedFrontendMarkdown,
  `${await readFile(storedFrontendMarkdown, "utf8")}\nUpdated intentionally.\n`
);
await writeFile(
  storedBackendMarkdown,
  `${await readFile(storedBackendMarkdown, "utf8")}\nUpdated independently.\n`
);
const driftedStatus = spawnSync(process.execPath, [
  engine, "status", "--store", store
], { encoding: "utf8" });
assert.notEqual(driftedStatus.status, 0);
assert.match(driftedStatus.stderr, /changed outside skillsctl/);
const acceptPreview = spawnSync(process.execPath, [
  engine, "skill", "accept", "frontend-dev", "--store", store
], { encoding: "utf8" });
assert.notEqual(acceptPreview.status, 0);
assert.match(acceptPreview.stderr, /preview complete; re-run with --yes/);
assert.match(run([
  "skill", "accept", "frontend-dev", "--store", store, "--yes"
]), /Accepted current files and refreshed checksum/);
const remainingDrift = spawnSync(process.execPath, [
  engine, "status", "--store", store
], { encoding: "utf8" });
assert.notEqual(remainingDrift.status, 0);
assert.match(remainingDrift.stderr, /skill 'backend-dev' changed outside skillsctl/);
assert.match(run([
  "skill", "accept", "backend-dev", "--store", store, "--yes"
]), /Accepted current files and refreshed checksum/);
assert.match(run(["status", "--store", store]), /Skills:\s+2/);
// A later edit must still be rejected until that new content is accepted.
await writeFile(
  storedFrontendMarkdown,
  `${await readFile(storedFrontendMarkdown, "utf8")}\nUpdated again.\n`
);
const reAddPreview = spawnSync(process.execPath, [
  engine, "skill", "add", storedFrontend, "--name", "frontend-dev",
  "--store", store, "--force"
], { encoding: "utf8" });
assert.notEqual(reAddPreview.status, 0);
assert.match(reAddPreview.stderr, /preview complete; re-run with --yes/);
assert.match(run([
  "skill", "add", storedFrontend, "--name", "frontend-dev",
  "--store", store, "--force", "--yes"
]), /Added skill 'frontend-dev'/);
assert.match(run(["status", "--store", store]), /Skills:\s+2/);
assert.match(await readFile(storedFrontendMarkdown, "utf8"), /Updated intentionally\./);
// Keep the later unmanaged-import fixture identical to the accepted Store copy.
await writeFile(
  join(frontend, "SKILL.md"),
  await readFile(storedFrontendMarkdown, "utf8")
);

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
const current = JSON.parse(run([
  "current", "--target", "codex", "--store", store, "--json"
]));
assert.equal(current.pack, "frontend");
assert.deepEqual(current.skills, ["frontend-dev"]);
assert.equal(current.healthy, true);
assert.equal((await lstat(join(target, "frontend-dev"))).isSymbolicLink(), true);
assert.equal(
  await realpath(join(target, "frontend-dev")),
  await realpath(join(store, "skills", "frontend-dev"))
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

const batchState = JSON.parse(run([
  "skill", "set", "--target", "codex", "--enable", "backend-dev",
  "--disable", "frontend-dev", "--store", store, "--yes", "--json"
]));
assert.equal(batchState.selection_mode, "manual");
assert.equal(batchState.base_pack, "frontend");
assert.deepEqual(batchState.base_skills, ["frontend-dev"]);
assert.deepEqual(batchState.skills, ["backend-dev"]);
assert.equal(batchState.healthy, true);
run(["pack", "save", "daily-test", "--target", "codex", "--store", store, "--yes"]);
let dailyTest = JSON.parse(await readFile(join(store, "packs", "daily-test.json"), "utf8"));
assert.deepEqual(dailyTest.extends, ["frontend"]);
assert.deepEqual(dailyTest.target_overrides.codex.enable, ["backend-dev"]);
assert.deepEqual(dailyTest.target_overrides.codex.disable, ["frontend-dev"]);
dailyTest.target_overrides.opencode = { enable: ["frontend-dev"], disable: [] };
await writeFile(join(store, "packs", "daily-test.json"), `${JSON.stringify(dailyTest, null, 2)}\n`);
run([
  "skill", "set", "--target", "codex", "--enable", "frontend-dev",
  "--disable", "backend-dev", "--store", store, "--yes"
]);
run([
  "pack", "save", "daily-test", "--target", "codex", "--store", store,
  "--force", "--yes"
]);
dailyTest = JSON.parse(await readFile(join(store, "packs", "daily-test.json"), "utf8"));
assert.deepEqual(dailyTest.target_overrides.opencode, {
  enable: ["frontend-dev"], disable: []
});
assert.deepEqual(dailyTest.target_overrides.codex.enable, ["frontend-dev"]);
assert.deepEqual(dailyTest.target_overrides.codex.disable, ["backend-dev"]);

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
  process.execPath,
  [
    engine,
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
  await realpath(join(claudeTarget, "frontend-dev")),
  await realpath(join(store, "skills", "frontend-dev"))
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
assert.equal(
  exported.skills["frontend-dev"].files["scripts/check.sh"].mode,
  0o700
);

const restored = join(root, "restored");
run(["restore-file", "--store", restored, "--input", snapshot, "--yes"]);
assert.match(run(["status", "--store", restored]), /Skills: 2[\s\S]*Packs:\s+7/);
await mkdir(join(restored, "skills", "stale-skill"), { recursive: true });
await writeFile(join(restored, "skills", "stale-skill", "SKILL.md"), "# stale\n");
const forcedRestore = run([
  "restore-file", "--store", restored, "--input", snapshot, "--force", "--yes"
]);
assert.match(forcedRestore, /Preserved previous store at/);
await assert.rejects(lstat(join(restored, "skills", "stale-skill")), { code: "ENOENT" });

// Validation and staging failures must leave the active store untouched.
const invalidSnapshot = join(root, "skills-invalid.json");
const invalidExport = structuredClone(exported);
invalidExport.skills["frontend-dev"].files["SKILL.md"].content = "not canonical base64!";
await writeFile(invalidSnapshot, `${JSON.stringify(invalidExport, null, 2)}\n`);
await writeFile(join(restored, "transaction-marker"), "active\n");
const failedRestore = spawnSync(process.execPath, [
  engine, "restore-file", "--store", restored, "--input", invalidSnapshot,
  "--force", "--yes"
], { encoding: "utf8" });
assert.notEqual(failedRestore.status, 0);
assert.equal(await readFile(join(restored, "transaction-marker"), "utf8"), "active\n");

const stagingFailureSnapshot = join(root, "skills-staging-failure.json");
const stagingFailureExport = structuredClone(exported);
stagingFailureExport.skills["frontend-dev"].files.collision = {
  encoding: "base64", mode: 0o600, content: Buffer.from("file").toString("base64")
};
stagingFailureExport.skills["frontend-dev"].files["collision/nested.txt"] = {
  encoding: "base64", mode: 0o600, content: Buffer.from("nested").toString("base64")
};
await writeFile(
  stagingFailureSnapshot,
  `${JSON.stringify(stagingFailureExport, null, 2)}\n`
);
const stagingFailure = spawnSync(process.execPath, [
  engine, "restore-file", "--store", restored, "--input", stagingFailureSnapshot,
  "--force", "--yes"
], { encoding: "utf8" });
assert.notEqual(stagingFailure.status, 0);
assert.equal(await readFile(join(restored, "transaction-marker"), "utf8"), "active\n");

const unsafe = await makeSkill("unsafe-skill", "Contains an accidental secret", {
  ".env": "API_KEY=do-not-copy\n"
});
const rejected = spawnSync(process.execPath, [
  engine, "skill", "add", unsafe, "--store", store, "--yes"
], {
  encoding: "utf8"
});
assert.notEqual(rejected.status, 0);
assert.match(rejected.stderr, /forbidden credential file/);

process.stdout.write(
  "ok  : skillsctl packs, target toggles, safe adoption, links, export, restore, and secret rejection\n"
);
