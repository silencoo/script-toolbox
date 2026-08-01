import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(directory, "..");
const agentctl = join(directory, "agentctl");
const mcpctl = join(agentRoot, "mcpctl", "mcpctl");
const skillsctl = join(agentRoot, "skillsctl", "skillsctl");
const promptctl = join(agentRoot, "promptctl", "promptctl");
const root = await mkdtemp(join(tmpdir(), "agentctl-preset-test-"));
const home = join(root, "home");
const fakeBin = join(root, "bin");
const mcpStore = join(root, "mcp-store");
const skillsStore = join(root, "skills-store");
const env = {
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
  MCPCTL_STORE: mcpStore,
  MCPCTL_CODEX_CONFIG: join(home, ".codex", "config.toml"),
  MCPCTL_STATE_FILE: join(root, "mcp-state.json"),
  SKILLSCTL_STORE: skillsStore,
  SKILLSCTL_CODEX_DIR: join(home, ".agents", "skills"),
  AGENTCTL_PRESETS_FILE: join(root, "presets.json"),
  AGENTCTL_PRESET_STATE_FILE: join(root, "preset-state.json")
};

function run(executable, args) {
  return execFileSync(executable, args, { encoding: "utf8", env });
}

await mkdir(home, { recursive: true });
await mkdir(fakeBin, { recursive: true });
await writeFile(join(fakeBin, "codex"), "#!/bin/sh\necho 'codex-cli test'\n");
await chmod(join(fakeBin, "codex"), 0o700);
run(mcpctl, ["init"]);
run(mcpctl, ["apply", "--target", "codex", "--profile", "off"]);
run(mcpctl, ["server", "enable", "context7", "--target", "codex"]);
run(skillsctl, ["init", "--yes"]);
const localSkill = join(root, "local-tools");
await mkdir(localSkill, { recursive: true });
await writeFile(
  join(localSkill, "SKILL.md"),
  "---\nname: local-tools\ndescription: Local tools used by the preset rollback test.\n---\n\n# Local tools\n"
);
run(skillsctl, ["skill", "add", localSkill, "--yes"]);
run(skillsctl, ["apply", "--target", "codex", "--pack", "off", "--yes"]);
run(skillsctl, ["skill", "enable", "local-tools", "--target", "codex", "--yes"]);
run(promptctl, ["install", "codex", "--yes"]);
run(promptctl, [
  "profile", "create", "work", "--from", "personal", "--target", "codex", "--yes"
]);

run(agentctl, [
  "preset", "create", "dev", "--mcp", "off", "--skills", "off",
  "--prompt", "work", "--description", "Isolated development preset", "--yes"
]);
const plan = JSON.parse(run(agentctl, ["preset", "plan", "dev", "--target", "codex", "--json"]));
assert.equal(plan.ok, true);
assert.deepEqual(plan.results.map((result) => result.component), ["mcp", "skills", "prompt"]);

const applied = JSON.parse(run(agentctl, [
  "preset", "apply", "dev", "--target", "codex", "--yes", "--json"
]));
assert.equal(applied.preset, "dev");
assert.equal(applied.restart_recommended, true);

let current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.preset, "dev");
assert.equal(current.drift, false);
assert.deepEqual(current.matches, { mcp: true, skills: true, prompt: true });

run(agentctl, [
  "preset", "create", "personal", "--mcp", "off", "--skills", "off",
  "--prompt", "personal", "--yes"
]);
run(agentctl, ["preset", "apply", "personal", "--target", "codex", "--yes", "--json"]);
current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.preset, "personal");
run(agentctl, ["preset", "rollback", "--target", "codex", "--yes", "--json"]);
current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.preset, "dev");
assert.equal(current.actual.prompt.profile, "work");

const failingPromptctl = join(root, "failing-promptctl");
await writeFile(
  failingPromptctl,
  `#!/bin/sh\nif [ "$1" = "apply" ] && [ "$5" = "personal" ]; then echo simulated prompt failure >&2; exit 1; fi\nexec "${promptctl}" "$@"\n`
);
await chmod(failingPromptctl, 0o700);
const failedApply = spawnSync(
  agentctl,
  ["preset", "apply", "personal", "--target", "codex", "--yes"],
  { encoding: "utf8", env: { ...env, AGENTCTL_PROMPTCTL: failingPromptctl } }
);
assert.notEqual(failedApply.status, 0);
assert.match(failedApply.stderr, /previous selections were restored/);
current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.preset, "dev");
assert.equal(current.actual.prompt.profile, "work");

const doctor = JSON.parse(run(agentctl, ["doctor", "codex", "--json"]));
assert.equal(doctor.targets[0].preset.name, "dev");
assert.equal(doctor.targets[0].preset.drift, false);
assert.equal(doctor.targets[0].restart.recommended, true);
assert.ok(doctor.secrets);
assert.ok(doctor.remote);

run(promptctl, ["apply", "--target", "codex", "--profile", "personal", "--yes"]);
current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.drift, true);
assert.equal(current.matches.prompt, false);
const driftDoctor = spawnSync(agentctl, ["doctor", "codex", "--json"], {
  encoding: "utf8", env
});
assert.notEqual(driftDoctor.status, 0);
assert.equal(JSON.parse(driftDoctor.stdout).targets[0].preset.drift, true);

const rolledBack = JSON.parse(run(agentctl, [
  "preset", "rollback", "--target", "codex", "--yes", "--json"
]));
assert.equal(rolledBack.ok, true);
current = JSON.parse(run(agentctl, ["preset", "current", "--target", "codex", "--json"]));
assert.equal(current.preset, null);
assert.equal(current.actual.prompt.profile, "personal");
assert.equal(current.actual.mcp.selection_mode, "manual");
assert.deepEqual(current.actual.mcp.servers, ["context7"]);
assert.equal(current.actual.skills.selection_mode, "manual");
assert.deepEqual(current.actual.skills.skills, ["local-tools"]);

process.stdout.write("ok  : agentctl preset plan/apply/drift/doctor/rollback\n");
