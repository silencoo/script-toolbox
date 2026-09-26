import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bashScriptCommand } from "./platform-command.mjs";
import { readCodexCredentialStore, validateCodexSnapshot } from "./codex-runtime.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fakeCodex = join(HERE, "tests", "fake-codex.mjs");
const auth = JSON.stringify({ tokens: { account_id: "fixture-account",
  access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "header.e30.signature" } });

function run(args, env) {
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("Provider apply, status, account save and uninstall share a relocated Codex home", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-codex-home-"));
  const home = join(root, "home");
  const alternate = join(root, "active codex");
  const bin = join(root, "bin");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: alternate,
    AGENTCTL_CODEX_BIN: fakeCodex, AGENTCTL_ACCOUNT_STORE: join(root, "accounts"),
    AGENTCTL_AGENT_ROOT: HERE, AGENTCTL_PROVIDER_STORE: join(root, "providers.json"),
    AGENTCTL_PROVIDER_SECRETS: join(root, "secrets.json"), AGENTCTL_PROVIDER_STATE: join(root, "state.json"),
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
  delete env.AGENTCTL_CODEX_AUTH_FILE;
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(alternate);
    await mkdir(bin);
    await writeFile(join(home, ".codex", "config.toml"), 'model = "untouched"\n');
    await writeFile(join(alternate, "auth.json"), auth, { mode: 0o600 });
    const shellPath = (path) => path.replaceAll("\\", "/").replaceAll("'", "'\\''");
    await writeFile(join(bin, "codex"), `#!/usr/bin/env bash\nexec '${shellPath(process.execPath)}' '${shellPath(fakeCodex)}' "$@"\n`, { mode: 0o700 });
    await chmod(join(bin, "codex"), 0o700);
    const secret = join(root, "dummy.key");
    await writeFile(secret, "dummy-key\n", { mode: 0o600 });
    const provider = join(HERE, "agentctl", "provider-client.mjs");
    run([provider, "init", "--yes"], env);
    run([provider, "create", "gateway", "--protocol", "openai_responses",
      "--base-url", "http://127.0.0.1:9/v1", "--model", "compat-test",
      "--auth-mode", "bearer", "--secret", "fixture", "--yes"], env);
    run([provider, "secret", "set", "fixture", "--secret-file", secret, "--yes"], env);
    run([provider, "use", "gateway", "--target", "codex", "--yes", "--skip-validate"], env);
    const config = await readFile(join(alternate, "config.toml"), "utf8");
    assert.match(config, /model = "compat-test"/);
    assert.ok(config.includes(alternate.replaceAll("\\", "\\\\")));
    if (process.env.AGENTCTL_TEST_CODEX_BIN) {
      assert.equal(await readCodexCredentialStore({ authFile: join(alternate, "auth.json"),
        codexBin: process.env.AGENTCTL_TEST_CODEX_BIN, strictConfig: true }), "file");
    }
    const ctl = bashScriptCommand(join(HERE, "agentctl", "agentctl"), ["status", "codex", "--json"]);
    const status = spawnSync(ctl.executable, ctl.args, { env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const row = JSON.parse(status.stdout);
    assert.equal(row.identity.status, "configured");
    assert.equal(row.model, "compat-test");
    assert.deepEqual(row.config_files, [join(alternate, "config.toml")]);
    const account = join(HERE, "agentctl", "account-client.mjs");
    run([account, "save", "primary", "--yes"], env);
    assert.equal(await readFile(join(root, "accounts", "primary.auth.json"), "utf8"), auth);
    const uninstall = bashScriptCommand(join(HERE, "codex", "setup.sh"), ["--uninstall"]);
    const removed = spawnSync(uninstall.executable, uninstall.args, { env, encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
    assert.doesNotMatch(await readFile(join(alternate, "config.toml"), "utf8"), /script_toolbox_custom/);
    assert.equal(await readFile(join(home, ".codex", "config.toml"), "utf8"), 'model = "untouched"\n');
    assert.equal(await readFile(join(alternate, "auth.json"), "utf8"), auth);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("credential config failures and timeouts fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-codex-rpc-"));
  try {
    const options = { authFile: join(root, "auth.json"), codexBin: fakeCodex };
    await assert.rejects(readCodexCredentialStore({ ...options, codexBin: join(root, "missing") }), /cannot run Codex/);
    await assert.rejects(readCodexCredentialStore({ ...options, timeoutMs: 1 }), /timed out/);
    await assert.rejects(validateCodexSnapshot(Buffer.from(auth), { codexBin: fakeCodex,
      environment: { ...process.env, FAKE_CODEX_REJECT_SNAPSHOT: "1" } }), /could not load/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installed Codex reads legacy snapshots and resolves the real credential store", {
  skip: !process.env.AGENTCTL_TEST_CODEX_BIN
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-real-codex-"));
  const options = { authFile: join(root, "auth.json"), codexBin: process.env.AGENTCTL_TEST_CODEX_BIN };
  try {
    await validateCodexSnapshot(Buffer.from(auth), options);
    const invalid = JSON.parse(auth);
    delete invalid.tokens.id_token;
    await assert.rejects(validateCodexSnapshot(Buffer.from(JSON.stringify(invalid)), options), /could not load/);
    for (const mode of ["file", "ephemeral"]) {
      await writeFile(join(root, "config.toml"), `cli_auth_credentials_store = '${mode}'\n`);
      assert.equal(await readCodexCredentialStore(options), mode);
    }
    await writeFile(join(root, "config.toml"), [
      'cli_auth_credentials_store = "file"', 'model_provider = "openai"',
      'openai_base_url = "http://127.0.0.1:9/backend-api/codex"',
      'experimental_realtime_ws_base_url = "http://127.0.0.1:9/backend-api/codex/realtime"'
    ].join("\n"));
    assert.equal(await readCodexCredentialStore({ ...options, strictConfig: true }), "file");

    const project = join(root, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(project, ".codex"));
    await writeFile(join(project, ".codex", "config.toml"), 'cli_auth_credentials_store = "ephemeral"\n');
    await writeFile(join(root, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      `[projects.${JSON.stringify(project)}]`, 'trust_level = "trusted"'
    ].join("\n"));
    assert.equal(await readCodexCredentialStore({ ...options, cwd: project }), "ephemeral");
  } finally { await rm(root, { recursive: true, force: true }); }
});
