#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROMPT_REMOTE_PROTOCOL,
  RemoteStoreError,
  downloadRemoteSnapshot,
  getRemoteStatus,
  getRemoteWebUiSetting,
  initializeRemoteStore,
  listRemoteVersions,
  makeRecoveryCode,
  parseRecoveryCode,
  readRemoteConfig,
  setRemoteWebUiEnabled,
  uploadRemoteSnapshot,
  writeJsonAtomic
} from "../remote-store.mjs";

const SCHEMA = 1;
const SNAPSHOT_KIND = "promptctl-store";
const CLIENTS = Object.freeze(["claude", "codex"]);
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

class PromptRemoteError extends Error {
  constructor(message) {
    super(message);
    this.name = "PromptRemoteError";
  }
}

function usage() {
  process.stdout.write(`promptctl remote storage

Usage:
  promptctl remote init --endpoint <url> [--create-token-file <file>] [--force]
  promptctl remote ui <status|enable|disable>
  promptctl backup [--home <directory>]
  promptctl restore --yes [--version <id>] [--force] [--home <directory>]
  promptctl restore --yes --recovery-file <file> [--force]
  promptctl recovery
  promptctl versions [--limit <1-100>]

Options:
  --remote-config <file>  Capability file (default: ~/.config/promptctl/remote.json)
  --home <directory>      Home containing .claude/.codex instruction files.
`);
}

function defaults() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    home: process.env.PROMPTCTL_HOME || homedir(),
    remoteConfig: process.env.PROMPTCTL_REMOTE_CONFIG ||
      join(configHome, "promptctl", "remote.json")
  };
}

function takeValue(input, option) {
  if (input.length === 0 || input[0].startsWith("--")) {
    throw new PromptRemoteError(`${option} requires a value`);
  }
  return input.shift();
}

function parseArguments(argv) {
  const base = defaults();
  const positional = [];
  const options = {
    home: base.home,
    remoteConfig: base.remoteConfig,
    endpoint: "",
    createTokenFile: "",
    recoveryFile: "",
    version: "",
    limit: 100,
    force: false,
    yes: false,
    help: false
  };
  const input = [...argv];
  while (input.length > 0) {
    const argument = input.shift();
    if (argument === "--home") options.home = takeValue(input, argument);
    else if (argument.startsWith("--home=")) options.home = argument.slice(7);
    else if (argument === "--remote-config") options.remoteConfig = takeValue(input, argument);
    else if (argument.startsWith("--remote-config=")) options.remoteConfig = argument.slice(16);
    else if (argument === "--endpoint") options.endpoint = takeValue(input, argument);
    else if (argument.startsWith("--endpoint=")) options.endpoint = argument.slice(11);
    else if (argument === "--create-token-file") options.createTokenFile = takeValue(input, argument);
    else if (argument.startsWith("--create-token-file=")) options.createTokenFile = argument.slice(20);
    else if (argument === "--recovery-file") options.recoveryFile = takeValue(input, argument);
    else if (argument.startsWith("--recovery-file=")) options.recoveryFile = argument.slice(16);
    else if (argument === "--version") options.version = takeValue(input, argument);
    else if (argument.startsWith("--version=")) options.version = argument.slice(10);
    else if (argument === "--limit") options.limit = Number(takeValue(input, argument));
    else if (argument.startsWith("--limit=")) options.limit = Number(argument.slice(8));
    else if (argument === "--force") options.force = true;
    else if (argument === "--yes" || argument === "-y") options.yes = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument.startsWith("-")) throw new PromptRemoteError(`unknown option '${argument}'`);
    else positional.push(argument);
  }
  options.home = resolve(options.home);
  options.remoteConfig = resolve(options.remoteConfig);
  if (options.createTokenFile) options.createTokenFile = resolve(options.createTokenFile);
  if (options.recoveryFile) options.recoveryFile = resolve(options.recoveryFile);
  return { positional, options };
}

function instructionsDirectory(home, client) {
  return join(home, client === "claude" ? ".claude" : ".codex", "instructions");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateName(value, label = "profile name") {
  if (typeof value !== "string" || !SAFE_NAME.test(value) ||
      value === "." || value === ".." || value.includes("..")) {
    throw new PromptRemoteError(`${label} is invalid`);
  }
  return value;
}

function validateContent(value, label) {
  if (typeof value !== "string" || value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new PromptRemoteError(`${label} is invalid or exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  return value;
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA || snapshot.kind !== SNAPSHOT_KIND ||
      typeof snapshot.created_at !== "string" ||
      Number.isNaN(Date.parse(snapshot.created_at)) || !snapshot.profiles ||
      typeof snapshot.profiles !== "object" || Array.isArray(snapshot.profiles)) {
    throw new PromptRemoteError("snapshot is not a valid promptctl store");
  }
  let total = 0;
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    validateName(name);
    if (!profile || profile.schema !== SCHEMA || profile.name !== name ||
        typeof profile.description !== "string" ||
        !profile.documents || typeof profile.documents !== "object" ||
        Array.isArray(profile.documents) ||
        Object.keys(profile.documents).some((client) => !CLIENTS.includes(client))) {
      throw new PromptRemoteError(`prompt profile '${name}' is invalid`);
    }
    for (const [client, document] of Object.entries(profile.documents)) {
      if (!document || document.schema !== SCHEMA || document.client !== client ||
          typeof document.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(document.sha256)) {
        throw new PromptRemoteError(`prompt profile '${name}' ${client} document is invalid`);
      }
      const content = validateContent(document.content, `${name}/${client}`);
      if (sha256(content) !== document.sha256) {
        throw new PromptRemoteError(`prompt profile '${name}' ${client} digest does not match`);
      }
      total += Buffer.byteLength(content, "utf8");
      if (total > MAX_TOTAL_BYTES) {
        throw new PromptRemoteError(`prompt snapshot exceeds ${MAX_TOTAL_BYTES} bytes`);
      }
    }
  }
  return snapshot;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function collectSnapshot(home) {
  const profiles = {};
  let total = 0;
  for (const client of CLIENTS) {
    const directory = instructionsDirectory(home, client);
    if (!await pathExists(directory)) continue;
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new PromptRemoteError(`instructions path must be a real directory: ${directory}`);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md")) continue;
      const name = validateName(entry.name.slice(0, -3));
      const file = join(directory, entry.name);
      const details = await lstat(file);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new PromptRemoteError(`instruction document must be a regular file: ${file}`);
      }
      if (details.size > MAX_DOCUMENT_BYTES) {
        throw new PromptRemoteError(`instruction document is too large: ${file}`);
      }
      const content = validateContent(await readFile(file, "utf8"), file);
      total += Buffer.byteLength(content, "utf8");
      if (total > MAX_TOTAL_BYTES) {
        throw new PromptRemoteError(`prompt snapshot exceeds ${MAX_TOTAL_BYTES} bytes`);
      }
      if (!profiles[name]) {
        profiles[name] = {
          schema: SCHEMA,
          name,
          description: "",
          documents: {}
        };
      }
      profiles[name].documents[client] = {
        schema: SCHEMA,
        client,
        content,
        sha256: sha256(content)
      };
    }
  }
  return validateSnapshot({
    schema: SCHEMA,
    kind: SNAPSHOT_KIND,
    created_at: new Date().toISOString(),
    profiles
  });
}

async function atomicWriteText(path, content) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await pathExists(path)) {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new PromptRemoteError(`refusing to replace non-regular file: ${path}`);
    }
  }
  const temporary = join(parent, `.${path.slice(parent.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeSnapshot(home, snapshot, force) {
  validateSnapshot(snapshot);
  const writes = [];
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    for (const [client, document] of Object.entries(profile.documents)) {
      const path = join(instructionsDirectory(home, client), `${name}.md`);
      if (await pathExists(path)) {
        const current = await readFile(path, "utf8");
        if (current !== document.content && !force) {
          throw new PromptRemoteError(`local document differs: ${path} (use --force)`);
        }
      }
      writes.push([path, document.content]);
    }
  }
  for (const [path, content] of writes) await atomicWriteText(path, content);
}

async function readPrivateLine(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new PromptRemoteError(`${label} not found: ${path}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new PromptRemoteError(`${label} must be a regular file`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new PromptRemoteError(`${label} permissions must not allow group or other access`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new PromptRemoteError(`${label} must contain one non-empty line`);
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 64 * 1024) throw new PromptRemoteError("standard input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function backup(options) {
  const snapshot = await collectSnapshot(options.home);
  const result = await uploadRemoteSnapshot(
    options.remoteConfig,
    PROMPT_REMOTE_PROTOCOL,
    snapshot
  );
  process.stdout.write(
    `Backed up ${Object.keys(snapshot.profiles).length} prompt profiles as ${result.version}.\n`
  );
}

async function remoteInit(options) {
  if (!options.endpoint) throw new PromptRemoteError("--endpoint is required");
  const createToken = options.createTokenFile
    ? await readPrivateLine(options.createTokenFile, "store creation token")
    : await readStdin();
  const config = await initializeRemoteStore({
    protocol: PROMPT_REMOTE_PROTOCOL,
    endpoint: options.endpoint,
    remoteConfig: options.remoteConfig,
    createToken,
    force: options.force
  });
  process.stdout.write(
    "Recovery code (anyone with it can decrypt and update this Prompt Store):\n"
  );
  process.stdout.write(`${makeRecoveryCode(config, PROMPT_REMOTE_PROTOCOL)}\n`);
  await uploadRemoteSnapshot(config, PROMPT_REMOTE_PROTOCOL, await collectSnapshot(options.home));
}

async function remoteUi(mode, options) {
  const setting = mode === "status"
    ? await getRemoteWebUiSetting(options.remoteConfig, PROMPT_REMOTE_PROTOCOL)
    : await setRemoteWebUiEnabled(
      options.remoteConfig,
      PROMPT_REMOTE_PROTOCOL,
      mode === "enable"
    );
  const config = await readRemoteConfig(options.remoteConfig);
  process.stdout.write(`Web UI: ${setting.web_ui_enabled ? "enabled" : "disabled"}\n`);
  process.stdout.write(`URL:    ${config.endpoint}/\n`);
}

async function restore(options) {
  if (!options.yes) throw new PromptRemoteError("restore writes local files; re-run with --yes");
  let config = options.remoteConfig;
  let recovered = null;
  let writeRecoveredConfig = false;
  if (options.recoveryFile) {
    recovered = parseRecoveryCode(
      await readPrivateLine(options.recoveryFile, "recovery code"),
      PROMPT_REMOTE_PROTOCOL
    );
    config = recovered;
    if (await pathExists(options.remoteConfig)) {
      const existing = await readRemoteConfig(options.remoteConfig);
      if (JSON.stringify(existing) !== JSON.stringify(recovered) && !options.force) {
        throw new PromptRemoteError(
          `recovery code differs from ${options.remoteConfig} (use --force)`
        );
      }
      writeRecoveredConfig = JSON.stringify(existing) !== JSON.stringify(recovered);
    } else {
      writeRecoveredConfig = true;
    }
  }
  const snapshot = validateSnapshot(await downloadRemoteSnapshot(
    config,
    PROMPT_REMOTE_PROTOCOL,
    options.version
  ));
  await writeSnapshot(options.home, snapshot, options.force);
  if (writeRecoveredConfig) await writeJsonAtomic(options.remoteConfig, recovered);
  process.stdout.write(
    `Restored ${Object.keys(snapshot.profiles).length} prompt profiles into ${options.home}.\n`
  );
}

async function recovery(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  process.stdout.write(`${makeRecoveryCode(config, PROMPT_REMOTE_PROTOCOL)}\n`);
}

async function versions(options) {
  const page = await listRemoteVersions(
    options.remoteConfig,
    PROMPT_REMOTE_PROTOCOL,
    options.limit
  );
  for (const version of page.versions) {
    process.stdout.write(`${version.version}\t${version.created_at}\t${version.size}\n`);
  }
}

async function status(options) {
  const [config, remote] = await Promise.all([
    readRemoteConfig(options.remoteConfig),
    getRemoteStatus(options.remoteConfig, PROMPT_REMOTE_PROTOCOL)
  ]);
  process.stdout.write(`Remote:  ${config.endpoint}/\n`);
  process.stdout.write(`Version: ${remote.latest?.version || "none"}\n`);
  process.stdout.write(`Web UI:  ${remote.web_ui_enabled ? "enabled" : "disabled"}\n`);
}

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    usage();
    return;
  }
  const action = positional.shift();
  if (action === "backup" && positional.length === 0) return backup(options);
  if (action === "restore" && positional.length === 0) return restore(options);
  if (action === "recovery" && positional.length === 0) return recovery(options);
  if (action === "versions" && positional.length === 0) return versions(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "remote" && positional[0] === "init" && positional.length === 1) {
    return remoteInit(options);
  }
  if (action === "remote" && positional[0] === "ui" && positional.length === 2 &&
      ["status", "enable", "disable"].includes(positional[1])) {
    return remoteUi(positional[1], options);
  }
  throw new PromptRemoteError("invalid remote command; use promptctl remote --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof PromptRemoteError || error instanceof RemoteStoreError
      ? error.message
      : "unexpected Prompt Store failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export { collectSnapshot, validateSnapshot, writeSnapshot };
