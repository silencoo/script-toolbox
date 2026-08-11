#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
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
  agentctl account save <name> [--force] [--yes]
  agentctl account use <name> [--yes]
  agentctl account delete <name> [--yes]

Aliases:
  identity                         Alias for account.
  capture / switch / remove       Aliases for save / use / delete.

Options:
  --store <directory>             Owner-only snapshot directory.
  --auth-file <file>              Live Codex auth.json path.
  --force                         Allow save to replace a different account label.
  --yes                           Apply a mutation; otherwise show a preview.
  --json                          Emit machine-readable, Secret-free output.

Account names use lowercase letters, numbers, and single hyphens. Saved OAuth
tokens are never printed. Switching refreshes the saved copy of the current
account first and refuses to replace an unsaved or unrecognized live auth file.
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
      join(home, ".codex", "auth.json"))
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
    const duplicate = accounts.find((account) =>
      account.fingerprint === active.fingerprint && account.name !== name
    );
    if (duplicate) {
      throw new AccountClientError(
        `current official account is already saved as '${duplicate.name}'`
      );
    }
    const existing = accounts.find((account) => account.name === name);
    if (existing && existing.fingerprint !== active.fingerprint && !options.force) {
      throw new AccountClientError(
        `account label '${name}' belongs to a different login; use --force to replace it`
      );
    }
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
  if (options.force && action !== "save") {
    throw new AccountClientError("--force is supported only by account save");
  }
  if (["status", "list"].includes(action)) {
    if (positional.length > 0) throw new AccountClientError(`${action} accepts no account name`);
    return emitStatus(await accountStatus(options), options, { listOnly: action === "list" });
  }
  const name = positional.shift();
  if (!name || positional.length > 0) {
    throw new AccountClientError(`${action} requires exactly one account name`);
  }
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
