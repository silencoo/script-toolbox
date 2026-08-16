#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = 1;
const STORE_KIND = "agentctl-codex-account-store";
const MAX_AUTH_BYTES = 2 * 1024 * 1024;
const ACCOUNT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCOUNT_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.auth\.json$/;

export class AccountClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccountClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl account — owner-only Codex official-login snapshots

Usage:
  agentctl account status [--json]
  agentctl account list [--json]
  agentctl account login <name> [--device-auth] [--force] [--yes]
  agentctl account save <name> [--force] [--yes]
  agentctl account use <name> [--yes]
  agentctl account delete <name> [--yes]

Aliases:
  identity                         Alias for account.
  capture / switch / remove       Aliases for save / use / delete.

Options:
  --store <directory>             Owner-only snapshot directory.
  --auth-file <file>              Live Codex auth.json path.
  --device-auth                   Use Codex's OAuth device-code login flow.
  --force                         Allow login/save to replace a different account label.
  --yes                           Apply a mutation; otherwise show a preview.
  --json                          Emit machine-readable, Secret-free output.

Account names use lowercase letters, numbers, and single hyphens. Saved OAuth
tokens are never printed. Switching refreshes the saved copy of the current
account first and refuses to replace an unsaved or unrecognized live auth file.
Account login runs Codex in an empty temporary CODEX_HOME, verifies the new
official credential, saves it, and activates it without revoking the old login.
`);
}

export function accountDefaults({
  environment = process.env,
  home = homedir()
} = {}) {
  return {
    storePath: resolve(environment.AGENTCTL_ACCOUNT_STORE ||
      join(home, ".config", "agentctl", "codex-accounts")),
    authFile: resolve(environment.AGENTCTL_CODEX_AUTH_FILE ||
      join(home, ".codex", "auth.json")),
    codexBin: environment.AGENTCTL_CODEX_BIN || "codex"
  };
}

function takeValue(argv, option) {
  if (argv.length === 0) throw new AccountClientError(`${option} requires a value`);
  return argv.shift();
}

export function parseArguments(argv, defaults = accountDefaults()) {
  const positional = [];
  const options = {
    ...defaults,
    yes: false,
    force: false,
    deviceAuth: false,
    json: false,
    help: false
  };
  const values = [...argv];
  while (values.length > 0) {
    const argument = values.shift();
    switch (argument) {
      case "--store": options.storePath = resolve(takeValue(values, argument)); break;
      case "--auth-file": options.authFile = resolve(takeValue(values, argument)); break;
      case "--yes": case "-y": options.yes = true; break;
      case "--force": options.force = true; break;
      case "--device-auth": options.deviceAuth = true; break;
      case "--json": options.json = true; break;
      case "--help": case "-h": options.help = true; break;
      default:
        if (argument.startsWith("-")) throw new AccountClientError(`unknown option '${argument}'`);
        positional.push(argument);
    }
  }
  return { positional, options };
}

function validateName(value) {
  if (typeof value !== "string" || value.length > 64 || !ACCOUNT_NAME.test(value)) {
    throw new AccountClientError(
      "account name must use lowercase letters, numbers, and single hyphens"
    );
  }
  return value;
}

function validateCodexBin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AccountClientError("Codex login executable is invalid");
  }
  return value;
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isPrivateMode(details) {
  return process.platform === "win32" || (details.mode & 0o077) === 0;
}

async function validateStore(path, { create = false } = {}) {
  let details = await pathState(path);
  if (!details && create) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path, 0o700);
    details = await lstat(path);
  }
  if (!details) return false;
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new AccountClientError(`account Store must be a regular directory: ${path}`);
  }
  if (!isPrivateMode(details)) {
    throw new AccountClientError(`account Store must be owner-only (chmod 700): ${path}`);
  }
  return true;
}

function accountPath(storePath, name) {
  return join(storePath, `${validateName(name)}.auth.json`);
}

function parseAuth(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_AUTH_BYTES) {
    throw new AccountClientError(`${label} must be a non-empty Codex auth file under 2 MB`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AccountClientError(`${label} is not valid JSON`);
  }
  const tokens = value && typeof value === "object" && !Array.isArray(value)
    ? value.tokens
    : null;
  const accountId = tokens && typeof tokens === "object" && !Array.isArray(tokens)
    ? tokens.account_id
    : null;
  const hasToken = tokens && ["access_token", "refresh_token", "id_token"]
    .some((key) => typeof tokens[key] === "string" && tokens[key].length > 0);
  if (value?.auth_mode !== "chatgpt" || typeof accountId !== "string" ||
      accountId.length === 0 || accountId.length > 1024 || !hasToken) {
    throw new AccountClientError(
      `${label} is not a complete ChatGPT/Codex official login with an account ID`
    );
  }
  return {
    bytes,
    fingerprint: createHash("sha256").update(accountId, "utf8").digest("hex")
  };
}

async function readAuth(path, label) {
  const details = await pathState(path);
  if (!details) throw new AccountClientError(`${label} not found: ${path}`);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new AccountClientError(`${label} must be a regular, non-symlink file: ${path}`);
  }
  if (!isPrivateMode(details)) {
    throw new AccountClientError(`${label} must be owner-only (chmod 600): ${path}`);
  }
  if (details.size > MAX_AUTH_BYTES) {
    throw new AccountClientError(`${label} exceeds the 2 MB safety limit`);
  }
  return {
    ...parseAuth(await readFile(path), label),
    path,
    savedAt: details.mtime.toISOString(),
    private: true
  };
}

async function inspectActive(authFile) {
  const details = await pathState(authFile);
  if (!details) return { status: "not-logged-in", record: null };
  try {
    return { status: "official-login", record: await readAuth(authFile, "live Codex auth") };
  } catch (error) {
    return {
      status: details.isSymbolicLink() || !details.isFile() || !isPrivateMode(details)
        ? "unsafe"
        : "unmanaged",
      record: null,
      error: error.message
    };
  }
}

async function loadAccounts(storePath) {
  if (!await validateStore(storePath)) return [];
  const names = await readdir(storePath);
  const accounts = [];
  for (const file of names.sort()) {
    const match = ACCOUNT_FILE.exec(file);
    if (!match) continue;
    const name = validateName(match[1]);
    accounts.push({ name, ...await readAuth(join(storePath, file), `saved account '${name}'`) });
  }
  const seen = new Map();
  for (const account of accounts) {
    const previous = seen.get(account.fingerprint);
    if (previous) {
      throw new AccountClientError(
        `saved account '${account.name}' duplicates '${previous}'; keep one label per official account`
      );
    }
    seen.set(account.fingerprint, account.name);
  }
  return accounts;
}

function publicAccount(account, activeFingerprint = "") {
  return {
    name: account.name,
    current: Boolean(activeFingerprint && account.fingerprint === activeFingerprint),
    saved_at: account.savedAt,
    credential_private: account.private === true
  };
}

async function accountStatus(options) {
  const [active, accounts] = await Promise.all([
    inspectActive(options.authFile),
    loadAccounts(options.storePath)
  ]);
  const activeFingerprint = active.record?.fingerprint || "";
  const current = accounts.filter((account) => account.fingerprint === activeFingerprint)
    .map((account) => account.name);
  const activeStatus = active.status === "official-login"
    ? current.length ? "saved" : "unsaved"
    : active.status;
  return {
    schema: SCHEMA,
    kind: STORE_KIND,
    store: options.storePath,
    store_exists: await validateStore(options.storePath),
    auth_file: options.authFile,
    active: {
      status: activeStatus,
      official_login: active.status === "official-login",
      saved_as: current[0] || null,
      credential_private: active.record?.private === true
    },
    account_count: accounts.length,
    accounts: accounts.map((account) => publicAccount(account, activeFingerprint))
  };
}

async function writeBytesAtomic(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new AccountClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function withStoreLock(storePath, callback) {
  await validateStore(storePath, { create: true });
  const lockPath = join(storePath, ".agentctl.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new AccountClientError(`account Store is busy; remove a stale lock only after checking: ${lockPath}`);
    }
    throw error;
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function validateSnapshotDestination(name, active, accounts, force) {
  const duplicate = accounts.find((account) =>
    account.fingerprint === active.fingerprint && account.name !== name
  );
  if (duplicate) {
    throw new AccountClientError(
      `official account is already saved as '${duplicate.name}'`
    );
  }
  const existing = accounts.find((account) => account.name === name);
  if (existing && existing.fingerprint !== active.fingerprint && !force) {
    throw new AccountClientError(
      `account label '${name}' belongs to a different login; use --force to replace it`
    );
  }
  return existing || null;
}

function mutationOutput(action, details, options) {
  const output = { ok: true, preview: !options.yes, action, ...details };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`${options.yes ? "[apply]" : "[preview]"} ${action}\n`);
    for (const [key, value] of Object.entries(details)) {
      process.stdout.write(`  ${key.replaceAll("_", " ")}: ${value}\n`);
    }
    if (!options.yes) process.stdout.write("[preview] no account file was changed; re-run with --yes.\n");
  }
  return output;
}

async function saveAccount(name, options) {
  validateName(name);
  const prepare = async () => {
    const active = await readAuth(options.authFile, "live Codex auth");
    const accounts = await loadAccounts(options.storePath);
    const existing = validateSnapshotDestination(name, active, accounts, options.force);
    return { active, replacing: Boolean(existing) };
  };
  const initial = await prepare();
  const action = initial.replacing ? "refresh saved Codex account" : "save Codex account";
  const details = {
    account: name,
    source: options.authFile,
    destination: accountPath(options.storePath, name)
  };
  if (!options.yes) return mutationOutput(action, details, options);
  await withStoreLock(options.storePath, async () => {
    const current = await prepare();
    await writeBytesAtomic(accountPath(options.storePath, name), current.active.bytes);
  });
  return mutationOutput(action, details, options);
}

function loginPreflight(options) {
  return Promise.all([
    inspectActive(options.authFile),
    loadAccounts(options.storePath)
  ]).then(([active, accounts]) => {
    if (["unsafe", "unmanaged"].includes(active.status)) {
      throw new AccountClientError(
        `refusing to replace ${active.status} live Codex auth; preserve or remove it manually first`
      );
    }
    const current = active.record
      ? accounts.find((account) => account.fingerprint === active.record.fingerprint)
      : null;
    if (active.record && !current) {
      throw new AccountClientError(
        "current official account is not saved; run 'agentctl account save <name> --yes' first"
      );
    }
    return {
      active,
      accounts,
      current
    };
  });
}

function runIsolatedCodexLogin(options, codexHome) {
  const executable = validateCodexBin(options.codexBin);
  const args = ["-c", 'cli_auth_credentials_store="file"', "login"];
  if (options.deviceAuth) args.push("--device-auth");
  const environment = { ...process.env, CODEX_HOME: codexHome };
  delete environment.CODEX_ACCESS_TOKEN;
  delete environment.OPENAI_API_KEY;

  return new Promise((resolveLogin, rejectLogin) => {
    const child = spawn(executable, args, {
      env: environment,
      stdio: options.json ? ["inherit", 2, 2] : "inherit",
      windowsHide: false
    });
    let interrupted = null;
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = new Map(signals.map((signal) => [signal, () => {
      interrupted = signal;
      try { child.kill(signal); } catch {}
    }]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const finish = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    child.once("error", (error) => {
      finish();
      const detail = error?.code === "ENOENT"
        ? `Codex executable not found: ${executable}`
        : "could not start the isolated Codex login";
      rejectLogin(new AccountClientError(detail));
    });
    child.once("exit", (code, signal) => {
      finish();
      if (code === 0) resolveLogin();
      else if (interrupted || signal) {
        rejectLogin(new AccountClientError("isolated Codex login was cancelled"));
      } else {
        rejectLogin(new AccountClientError(`isolated Codex login failed with exit code ${code}`));
      }
    });
  });
}

function sameAuthRecord(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return createHash("sha256").update(left.bytes).digest("hex") ===
    createHash("sha256").update(right.bytes).digest("hex");
}

async function restoreAccountFiles(backups) {
  for (const [path, bytes] of backups) {
    if (bytes) await writeBytesAtomic(path, bytes);
    else await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function loginAccount(name, options) {
  validateName(name);
  const initial = await loginPreflight(options);
  const details = {
    account: name,
    login_home: "temporary owner-only isolated CODEX_HOME",
    credential_store: "isolated file",
    device_auth: options.deviceAuth,
    previous: initial.current?.name || "none",
    activation: "after verified login"
  };
  if (!options.yes) return mutationOutput("secure Codex login", details, options);

  await validateStore(options.storePath, { create: true });
  const codexHome = await mkdtemp(join(options.storePath, ".login-"));
  let staged = null;
  try {
    if (process.platform !== "win32") await chmod(codexHome, 0o700);
    await runIsolatedCodexLogin(options, codexHome);
    staged = await readAuth(join(codexHome, "auth.json"), "isolated Codex login");

    await withStoreLock(options.storePath, async () => {
      const currentState = await loginPreflight(options);
      if (!sameAuthRecord(initial.active.record, currentState.active.record)) {
        throw new AccountClientError(
          "live Codex auth changed during isolated login; refusing to activate the staged login"
        );
      }
      validateSnapshotDestination(
        name,
        staged,
        currentState.accounts,
        options.force
      );
      if (currentState.current?.name === name &&
          currentState.current.fingerprint !== staged.fingerprint) {
        throw new AccountClientError(
          "cannot replace the active account label with a different login; choose a new label"
        );
      }

      const affectedNames = new Set([name]);
      if (currentState.current && currentState.current.fingerprint !== staged.fingerprint) {
        affectedNames.add(currentState.current.name);
      }
      const backups = new Map();
      for (const affectedName of affectedNames) {
        const account = currentState.accounts.find((item) => item.name === affectedName);
        backups.set(
          accountPath(options.storePath, affectedName),
          account ? Buffer.from(account.bytes) : null
        );
      }
      const liveBackup = currentState.active.record
        ? Buffer.from(currentState.active.record.bytes)
        : null;
      const changedSnapshots = [];
      let liveWritten = false;
      try {
        if (currentState.current && currentState.current.fingerprint !== staged.fingerprint) {
          const currentPath = accountPath(options.storePath, currentState.current.name);
          await writeBytesAtomic(
            currentPath,
            currentState.active.record.bytes
          );
          changedSnapshots.push(currentPath);
        }
        const targetPath = accountPath(options.storePath, name);
        await writeBytesAtomic(targetPath, staged.bytes);
        changedSnapshots.push(targetPath);
        await writeBytesAtomic(options.authFile, staged.bytes);
        liveWritten = true;
        const [saved, activated] = await Promise.all([
          readAuth(accountPath(options.storePath, name), "saved isolated Codex login"),
          readAuth(options.authFile, "activated isolated Codex login")
        ]);
        try {
          if (saved.fingerprint !== staged.fingerprint ||
              activated.fingerprint !== staged.fingerprint) {
            throw new AccountClientError("isolated Codex login verification failed after activation");
          }
        } finally {
          saved.bytes.fill(0);
          activated.bytes.fill(0);
        }
      } catch (error) {
        let rollbackFailed = false;
        try {
          await restoreAccountFiles(new Map(
            changedSnapshots.map((path) => [path, backups.get(path)])
          ));
          if (liveWritten) {
            if (liveBackup) await writeBytesAtomic(options.authFile, liveBackup);
            else await unlink(options.authFile).catch((unlinkError) => {
              if (unlinkError?.code !== "ENOENT") throw unlinkError;
            });
          }
        } catch {
          rollbackFailed = true;
        } finally {
          for (const bytes of backups.values()) bytes?.fill(0);
          liveBackup?.fill(0);
        }
        if (rollbackFailed) {
          throw new AccountClientError(
            "isolated Codex login activation failed and rollback was incomplete; inspect account files"
          );
        }
        if (error instanceof AccountClientError) throw error;
        throw new AccountClientError(
          "isolated Codex login activation failed; previous account files were restored"
        );
      }
    });
  } finally {
    staged?.bytes.fill(0);
    await rm(codexHome, { recursive: true, force: true });
  }

  return mutationOutput("secure Codex login", {
    ...details,
    active_account: name,
    temporary_login_home: "removed"
  }, options);
}

async function useAccount(name, options) {
  validateName(name);
  const prepare = async () => {
    const accounts = await loadAccounts(options.storePath);
    const target = accounts.find((account) => account.name === name);
    if (!target) throw new AccountClientError(`saved account not found: ${name}`);
    const active = await inspectActive(options.authFile);
    if (["unsafe", "unmanaged"].includes(active.status)) {
      throw new AccountClientError(
        `refusing to replace ${active.status} live Codex auth; preserve or remove it manually first`
      );
    }
    if (!active.record) return { accounts, target, active, current: null, alreadyCurrent: false };
    const current = accounts.find((account) =>
      account.fingerprint === active.record.fingerprint
    );
    if (!current) {
      throw new AccountClientError(
        "current official account is not saved; run 'agentctl account save <name> --yes' first"
      );
    }
    return {
      accounts,
      target,
      active,
      current,
      alreadyCurrent: current.fingerprint === target.fingerprint
    };
  };
  const initial = await prepare();
  const action = initial.alreadyCurrent ? "refresh current Codex account" : "switch Codex account";
  const details = {
    account: name,
    previous: initial.current?.name || "none",
    auth_file: options.authFile,
    provider_config: "unchanged"
  };
  if (!options.yes) return mutationOutput(action, details, options);
  await withStoreLock(options.storePath, async () => {
    const current = await prepare();
    if (current.active.record && current.current) {
      await writeBytesAtomic(
        accountPath(options.storePath, current.current.name),
        current.active.record.bytes
      );
    }
    if (!current.alreadyCurrent) {
      await writeBytesAtomic(options.authFile, current.target.bytes);
      const applied = await readAuth(options.authFile, "switched Codex auth");
      if (applied.fingerprint !== current.target.fingerprint) {
        throw new AccountClientError("Codex account verification failed after the atomic switch");
      }
    }
  });
  return mutationOutput(action, details, options);
}

async function deleteAccount(name, options) {
  validateName(name);
  const prepare = async () => {
    const accounts = await loadAccounts(options.storePath);
    const target = accounts.find((account) => account.name === name);
    if (!target) throw new AccountClientError(`saved account not found: ${name}`);
    const active = await inspectActive(options.authFile);
    if (active.record?.fingerprint === target.fingerprint) {
      throw new AccountClientError("cannot delete the current account; switch to another saved account first");
    }
    return target;
  };
  await prepare();
  const details = {
    account: name,
    active_login: "unchanged"
  };
  if (!options.yes) return mutationOutput("delete saved Codex account", details, options);
  await withStoreLock(options.storePath, async () => {
    await prepare();
    await unlink(accountPath(options.storePath, name));
  });
  return mutationOutput("delete saved Codex account", details, options);
}

function emitStatus(status, options, { listOnly = false } = {}) {
  const output = listOnly ? status.accounts : status;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Codex Accounts: ${status.account_count} saved\n`);
  process.stdout.write(`Active: ${status.active.saved_as || status.active.status}\n`);
  if (status.accounts.length === 0) {
    process.stdout.write("(no saved accounts)\n");
    return;
  }
  for (const account of status.accounts) {
    process.stdout.write(`${account.current ? ">" : " "} ${account.name}${account.current ? " (current)" : ""}\n`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArguments(argv);
  if (options.help) return usage();
  let action = positional.shift() || "status";
  action = { capture: "save", switch: "use", remove: "delete" }[action] || action;
  if (options.force && !["login", "save"].includes(action)) {
    throw new AccountClientError("--force is supported only by account login/save");
  }
  if (options.deviceAuth && action !== "login") {
    throw new AccountClientError("--device-auth is supported only by account login");
  }
  if (["status", "list"].includes(action)) {
    if (positional.length > 0) throw new AccountClientError(`${action} accepts no account name`);
    return emitStatus(await accountStatus(options), options, { listOnly: action === "list" });
  }
  const name = positional.shift();
  if (!name || positional.length > 0) {
    throw new AccountClientError(`${action} requires exactly one account name`);
  }
  if (action === "login") return loginAccount(name, options);
  if (action === "save") return saveAccount(name, options);
  if (action === "use") return useAccount(name, options);
  if (action === "delete") return deleteAccount(name, options);
  throw new AccountClientError(`unknown account action '${action}'`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const safe = error instanceof AccountClientError ? error.message : "unexpected account controller failure";
    process.stderr.write(`ERROR ${safe}\n`);
    process.exitCode = 1;
  });
}
