import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { accountDefaults } from "./account-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "account-client.mjs");

test("account paths honor CODEX_HOME and the explicit auth-file override", () => {
  const home = join(tmpdir(), "default-home");
  const alternate = join(tmpdir(), "alternate-codex");
  assert.equal(accountDefaults({ home, environment: { CODEX_HOME: alternate } }).authFile,
    join(alternate, "auth.json"));
  assert.equal(accountDefaults({ home, environment: {
    CODEX_HOME: alternate, AGENTCTL_CODEX_AUTH_FILE: join(home, "explicit", "auth.json")
  } }).authFile, join(home, "explicit", "auth.json"));
});

test("legacy ChatGPT snapshots load but incomplete or malformed tokens never enter the Store", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-account-schema-"));
  const authFile = join(root, "home", ".codex", "auth.json");
  try {
    await mkdir(dirname(authFile), { recursive: true });
    const legacy = JSON.parse(auth("legacy-account", "legacy"));
    delete legacy.auth_mode;
    await writeFile(authFile, JSON.stringify(legacy), { mode: 0o600 });
    run(root, ["save", "legacy", "--yes"]);
    assert.equal(JSON.parse(run(root, ["status", "--json"]).stdout).active.saved_as, "legacy");
    const saved = await readFile(join(root, "store", "legacy.auth.json"));
    for (const modify of [
      (v) => { delete v.tokens.id_token; },
      (v) => { delete v.tokens.refresh_token; },
      (v) => { delete v.tokens.access_token; },
      (v) => { v.tokens.id_token = "broken-jwt"; },
      (v) => { v.tokens.id_token = "h.bnVsbA.s"; },
      (v) => { v.last_refresh = "invalid-date"; },
      (v) => { v.auth_mode = "apikey"; }
    ]) {
      const invalid = structuredClone(legacy);
      modify(invalid);
      const bytes = Buffer.from(JSON.stringify(invalid));
      await writeFile(authFile, bytes);
      const refused = run(root, ["save", "invalid", "--yes"], { status: 1 });
      assert.match(refused.stderr, /not a complete ChatGPT/);
      assert.deepEqual(await readFile(authFile), bytes);
      await assert.rejects(() => lstat(join(root, "store", "invalid.auth.json")), { code: "ENOENT" });
    }
    assert.deepEqual(await readFile(join(root, "store", "legacy.auth.json")), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("account mutations reject non-file effective stores including managed overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-account-stores-"));
  const directory = join(root, "home", ".codex");
  try {
    await mkdir(directory, { recursive: true });
    const before = auth("saved-account", "saved");
    await writeFile(join(directory, "auth.json"), before, { mode: 0o600 });
    run(root, ["save", "primary", "--yes"]);
    for (const mode of ["keyring", "auto", "ephemeral"]) {
      await writeFile(join(directory, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      await writeFile(join(directory, "requirements.toml"), `cli_auth_credentials_store = "${mode}"\n`);
      for (const args of [["use", "primary"], ["save", "other"], ["login", "other"]]) {
        const result = run(root, [...args, "--yes"], { status: 1 });
        assert.match(result.stderr, new RegExp(`Codex uses '${mode}' credentials`));
      }
      const state = JSON.parse(run(root, ["status", "--json"]).stdout);
      assert.equal(state.credential_store, mode);
      assert.equal(state.active.official_login, false);
      assert.equal(state.accounts.some((row) => row.current), false);
      assert.equal(await readFile(join(directory, "auth.json"), "utf8"), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function auth(accountId, marker) {
  return `${JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2026-08-11T00:00:00.000Z",
    tokens: {
      access_token: `access-${marker}`,
      account_id: accountId,
      id_token: `header.${Buffer.from(JSON.stringify({ email: `${marker}@example.invalid` })).toString("base64url")}.signature`,
      refresh_token: `refresh-${marker}`
    }
  }, null, 2)}\n`;
}

function run(root, args, { status = 0, environment = {} } = {}) {
  const authFile = join(root, "home", ".codex", "auth.json");
  const store = join(root, "store");
  const result = spawnSync(process.execPath, [
    CLIENT,
    ...args,
    "--auth-file", authFile,
    "--store", store
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENTCTL_CODEX_BIN: join(HERE, "../tests/fake-codex.mjs"), ...environment }
  });
  assert.equal(
    result.status,
    status,
    `status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

async function fakeCodex(root) {
  const path = join(root, "fake-codex.mjs");
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveConfig } from ${JSON.stringify(new URL("../tests/fake-codex.mjs", import.meta.url).href)};

if (process.argv.includes("app-server")) {
  serveConfig();
} else if (process.argv.includes("status")) {
  process.exitCode = process.env.FAKE_CODEX_REJECT_SNAPSHOT ? 1 : 0;
} else {
const home = process.env.CODEX_HOME;
const args = process.argv.slice(2);
const authFile = join(home, "auth.json");
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  args,
  home,
  auth_preexisting: existsSync(authFile)
}) + "\\n", { mode: 0o600 });
if (!args.includes('cli_auth_credentials_store="file"') ||
    !args.includes("login") || existsSync(authFile)) process.exit(41);
if (process.env.FAKE_CODEX_EXIT) process.exit(Number(process.env.FAKE_CODEX_EXIT));
writeFileSync(authFile, JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  last_refresh: "2026-08-16T00:00:00.000Z",
  tokens: {
    access_token: "access-" + process.env.FAKE_MARKER,
    account_id: process.env.FAKE_ACCOUNT_ID,
    id_token: "header." + Buffer.from(JSON.stringify({ email: process.env.FAKE_MARKER + "@example.invalid" })).toString("base64url") + ".signature",
    refresh_token: "refresh-" + process.env.FAKE_MARKER
  }
}, null, 2) + "\\n", { mode: 0o600 });
process.stderr.write("fake isolated login completed\\n");
}
`);
  if (process.platform !== "win32") await chmod(path, 0o700);
  return path;
}

test("Codex accounts save, refresh, and switch without exposing OAuth material", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-account-"));
  const authFile = join(root, "home", ".codex", "auth.json");
  const configFile = join(root, "home", ".codex", "config.toml");
  const store = join(root, "store");
  const primaryId = "account-primary-must-never-render";
  const backupId = "account-backup-must-never-render";
  try {
    await mkdir(dirname(authFile), { recursive: true });
    await writeFile(authFile, auth(primaryId, "primary-v1"), { mode: 0o600 });
    await chmod(authFile, 0o600);
    await writeFile(configFile, 'model_provider = "third-party"\nmodel = "model-a"\n', {
      mode: 0o600
    });
    const configBefore = await readFile(configFile, "utf8");

    const empty = JSON.parse(run(root, ["status", "--json"]).stdout);
    assert.equal(empty.active.status, "unsaved");
    assert.equal(empty.account_count, 0);

    const preview = JSON.parse(run(root, ["save", "primary", "--json"]).stdout);
    assert.equal(preview.preview, true);
    await assert.rejects(() => lstat(store), { code: "ENOENT" });

    const saved = run(root, ["save", "primary", "--yes", "--json"]);
    assert.equal(JSON.parse(saved.stdout).preview, false);
    assert.equal(saved.stdout.includes(primaryId), false);
    assert.equal(saved.stdout.includes("primary-v1"), false);
    if (process.platform === "win32") {
      assert.equal((await lstat(store)).isDirectory(), true);
      assert.equal((await lstat(join(store, "primary.auth.json"))).isFile(), true);
    } else {
      assert.equal((await lstat(store)).mode & 0o077, 0);
      assert.equal((await lstat(join(store, "primary.auth.json"))).mode & 0o077, 0);
    }

    const current = JSON.parse(run(root, ["list", "--json"]).stdout);
    assert.deepEqual(current.map(({ name, current: selected }) => [name, selected]), [
      ["primary", true]
    ]);

    await writeFile(authFile, auth(backupId, "backup-v1"), { mode: 0o600 });
    await chmod(authFile, 0o600);
    assert.match(
      run(root, ["use", "primary", "--yes"], { status: 1 }).stderr,
      /current official account is not saved/
    );
    run(root, ["save", "backup", "--yes", "--json"]);

    await writeFile(authFile, auth(backupId, "backup-v2"), { mode: 0o600 });
    await chmod(authFile, 0o600);
    const switchPreview = JSON.parse(run(root, ["use", "primary", "--json"]).stdout);
    assert.equal(switchPreview.preview, true);
    assert.match(await readFile(authFile, "utf8"), /backup-v2/);

    // A locally plausible snapshot can still be rejected by the installed
    // Codex parser. Neither the live login nor saved refresh tokens may change.
    const rejectionEnvironment = { FAKE_CODEX_REJECT_SNAPSHOT: "1" };
    const beforeRejection = await readFile(authFile);
    const savedBeforeRejection = await readFile(join(store, "backup.auth.json"));
    for (const args of [["save", "backup"], ["use", "primary"]]) {
      const rejected = run(root, [...args, "--yes"], {
        status: 1, environment: rejectionEnvironment
      });
      assert.match(rejected.stderr, /Codex could not load the account snapshot/);
      assert.deepEqual(await readFile(authFile), beforeRejection);
      assert.deepEqual(await readFile(join(store, "backup.auth.json")), savedBeforeRejection);
    }

    const switched = run(root, ["use", "primary", "--yes", "--json"]);
    assert.equal(switched.stdout.includes(primaryId), false);
    assert.equal(switched.stdout.includes(backupId), false);
    assert.match(await readFile(authFile, "utf8"), /primary-v1/);
    assert.match(await readFile(join(store, "backup.auth.json"), "utf8"), /backup-v2/);
    assert.equal(await readFile(configFile, "utf8"), configBefore);

    run(root, ["use", "backup", "--yes", "--json"]);
    assert.match(await readFile(authFile, "utf8"), /backup-v2/);
    run(root, ["delete", "primary", "--yes", "--json"]);
    await assert.rejects(() => lstat(join(store, "primary.auth.json")), { code: "ENOENT" });
    assert.match(
      run(root, ["delete", "backup", "--yes"], { status: 1 }).stderr,
      /cannot delete the current account/
    );

    const serialized = JSON.stringify(JSON.parse(run(root, ["status", "--json"]).stdout));
    for (const secret of [primaryId, backupId, "primary-v1", "backup-v2", "access-"]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex account mutations reject loose files, symlinks, and label replacement", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "agentctl-account-safety-"));
  const authFile = join(root, "home", ".codex", "auth.json");
  try {
    await mkdir(dirname(authFile), { recursive: true });
    await writeFile(authFile, auth("account-a", "a"), { mode: 0o644 });
    await chmod(authFile, 0o644);
    assert.match(run(root, ["save", "primary", "--yes"], { status: 1 }).stderr, /chmod 600/);

    await chmod(authFile, 0o600);
    run(root, ["save", "primary", "--yes"]);
    await writeFile(authFile, auth("account-b", "b"), { mode: 0o600 });
    await chmod(authFile, 0o600);
    assert.match(
      run(root, ["save", "primary", "--yes"], { status: 1 }).stderr,
      /belongs to a different login/
    );
    run(root, ["save", "primary", "--force", "--yes"]);

    const unsafeRoot = await mkdtemp(join(tmpdir(), "agentctl-account-symlink-"));
    try {
      const target = join(unsafeRoot, "target");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, join(unsafeRoot, "store"));
      const result = spawnSync(process.execPath, [
        CLIENT, "status", "--json",
        "--auth-file", authFile,
        "--store", join(unsafeRoot, "store")
      ], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /regular directory/);
    } finally {
      await rm(unsafeRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentctl account login isolates OAuth revocation, activates verified auth, and cleans staging", {
  skip: process.platform === "win32" ? "test fixture uses a Unix executable script" : false
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentctl-account-login-"));
  const authFile = join(root, "home", ".codex", "auth.json");
  const store = join(root, "store");
  const loginLog = join(root, "fake-codex.jsonl");
  const primaryId = "login-primary-must-never-render";
  const secondaryId = "login-secondary-must-never-render";
  const thirdId = "login-third-must-never-render";
  try {
    await mkdir(dirname(authFile), { recursive: true });
    await writeFile(authFile, auth(primaryId, "primary-live"), { mode: 0o600 });
    await chmod(authFile, 0o600);
    run(root, ["save", "primary", "--yes", "--json"]);
    const codexBin = await fakeCodex(root);
    const loginEnvironment = {
      AGENTCTL_CODEX_BIN: codexBin,
      FAKE_CODEX_LOG: loginLog,
      FAKE_ACCOUNT_ID: secondaryId,
      FAKE_MARKER: "secondary-v1"
    };

    const preview = JSON.parse(run(root, [
      "login", "secondary", "--json"
    ], { environment: loginEnvironment }).stdout);
    assert.equal(preview.preview, true);
    assert.equal(preview.activation, "after verified login");
    await assert.rejects(() => lstat(loginLog), { code: "ENOENT" });
    assert.match(await readFile(authFile, "utf8"), /primary-live/);

    const applied = run(root, [
      "login", "secondary", "--yes", "--json"
    ], { environment: loginEnvironment });
    const appliedValue = JSON.parse(applied.stdout);
    assert.equal(appliedValue.preview, false);
    assert.equal(appliedValue.active_account, "secondary");
    assert.equal(appliedValue.temporary_login_home, "removed");
    assert.match(await readFile(authFile, "utf8"), /secondary-v1/);
    assert.match(await readFile(join(store, "secondary.auth.json"), "utf8"), /secondary-v1/);
    assert.match(await readFile(join(store, "primary.auth.json"), "utf8"), /primary-live/);

    let logRows = (await readFile(loginLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logRows[0].args, [
      "-c", 'cli_auth_credentials_store="file"', "login"
    ]);
    assert.equal(logRows[0].auth_preexisting, false);
    assert.equal(logRows[0].home.startsWith(`${store}/.login-`), true);
    await assert.rejects(() => lstat(logRows[0].home), { code: "ENOENT" });

    const serializedOutput = `${applied.stdout}\n${applied.stderr}`;
    for (const secret of [primaryId, secondaryId, "primary-live", "secondary-v1", "refresh-"]) {
      assert.equal(serializedOutput.includes(secret), false);
    }
    const status = JSON.parse(run(root, ["status", "--json"]).stdout);
    assert.equal(status.active.saved_as, "secondary");
    assert.equal(status.account_count, 2);

    run(root, ["login", "secondary", "--yes", "--json"], {
      environment: { ...loginEnvironment, FAKE_MARKER: "secondary-v2" }
    });
    assert.match(await readFile(authFile, "utf8"), /secondary-v2/);
    assert.match(await readFile(join(store, "secondary.auth.json"), "utf8"), /secondary-v2/);
    assert.equal((await readFile(authFile, "utf8")).includes("secondary-v1"), false);

    run(root, ["login", "third", "--device-auth", "--yes", "--json"], {
      environment: {
        ...loginEnvironment,
        FAKE_ACCOUNT_ID: thirdId,
        FAKE_MARKER: "third-v1"
      }
    });
    logRows = (await readFile(loginLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(logRows.at(-1).args, [
      "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"
    ]);
    assert.match(await readFile(authFile, "utf8"), /third-v1/);
    assert.match(await readFile(join(store, "secondary.auth.json"), "utf8"), /secondary-v2/);
    await assert.rejects(() => lstat(logRows.at(-1).home), { code: "ENOENT" });

    const beforeFailure = await readFile(authFile);
    const failed = run(root, ["login", "failed", "--yes", "--json"], {
      status: 1,
      environment: {
        ...loginEnvironment,
        FAKE_ACCOUNT_ID: "failed-account",
        FAKE_MARKER: "failed-login",
        FAKE_CODEX_EXIT: "9"
      }
    });
    assert.match(failed.stderr, /isolated Codex login failed with exit code 9/);
    assert.deepEqual(await readFile(authFile), beforeFailure);
    await assert.rejects(() => lstat(join(store, "failed.auth.json")), { code: "ENOENT" });
    logRows = (await readFile(loginLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    await assert.rejects(() => lstat(logRows.at(-1).home), { code: "ENOENT" });

    const rejectedSnapshot = run(root, ["login", "rejected", "--yes", "--json"], {
      status: 1,
      environment: { ...loginEnvironment, FAKE_CODEX_REJECT_SNAPSHOT: "1" }
    });
    assert.match(rejectedSnapshot.stderr, /Codex could not load the account snapshot/);
    assert.deepEqual(await readFile(authFile), beforeFailure);
    await assert.rejects(() => lstat(join(store, "rejected.auth.json")), { code: "ENOENT" });
    logRows = (await readFile(loginLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    await assert.rejects(() => lstat(logRows.at(-1).home), { code: "ENOENT" });

    const beforeRollback = await readFile(authFile);
    let rollbackFailure;
    await chmod(dirname(authFile), 0o500);
    try {
      rollbackFailure = run(root, ["login", "rollback", "--yes", "--json"], {
        status: 1,
        environment: {
          ...loginEnvironment,
          FAKE_ACCOUNT_ID: "rollback-account",
          FAKE_MARKER: "rollback-login"
        }
      });
    } finally {
      await chmod(dirname(authFile), 0o700);
    }
    assert.match(
      rollbackFailure.stderr,
      /activation failed; previous account files were restored/
    );
    assert.deepEqual(await readFile(authFile), beforeRollback);
    await assert.rejects(() => lstat(join(store, "rollback.auth.json")), { code: "ENOENT" });
    logRows = (await readFile(loginLog, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    await assert.rejects(() => lstat(logRows.at(-1).home), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
