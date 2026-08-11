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

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "account-client.mjs");

function auth(accountId, marker) {
  return `${JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2026-08-11T00:00:00.000Z",
    tokens: {
      access_token: `access-${marker}`,
      account_id: accountId,
      id_token: `id-${marker}`,
      refresh_token: `refresh-${marker}`
    }
  }, null, 2)}\n`;
}

function run(root, args, { status = 0 } = {}) {
  const authFile = join(root, "home", ".codex", "auth.json");
  const store = join(root, "store");
  const result = spawnSync(process.execPath, [
    CLIENT,
    ...args,
    "--auth-file", authFile,
    "--store", store
  ], { encoding: "utf8" });
  assert.equal(
    result.status,
    status,
    `status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
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
    assert.equal((await lstat(store)).mode & 0o077, 0);
    assert.equal((await lstat(join(store, "primary.auth.json"))).mode & 0o077, 0);

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
