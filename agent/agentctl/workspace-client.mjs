#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  RemoteStoreError,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
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
  validateRemoteConfig,
  writeJsonAtomic
} from "../remote-store.mjs";
import {
  CURRENT_WORKSPACE_SCHEMA,
  WORKSPACE_KIND,
  normalizeWorkspaceSchema
} from "./workspace-schema.mjs";

const SCHEMA = CURRENT_WORKSPACE_SCHEMA;
const STORE_TYPES = Object.freeze(["mcp", "skills", "prompts"]);
const TYPE_ALIASES = Object.freeze({ prompt: "prompts", promptctl: "prompts" });
const PROTOCOLS = Object.freeze({
  mcp: MCP_REMOTE_PROTOCOL,
  skills: SKILLS_REMOTE_PROTOCOL,
  prompts: PROMPT_REMOTE_PROTOCOL
});

class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function usage() {
  process.stdout.write(`agentctl workspace — one recovery code for MCP, Skills, Prompts, and Presets

Usage:
  agentctl workspace init --endpoint <url> [--create-token-file <file>] [--force]
  agentctl workspace status [--json]
  agentctl workspace attach <mcp|skills|prompts> [--remote-config <file>]
  agentctl workspace detach <mcp|skills|prompts>
  agentctl workspace recovery
  agentctl workspace restore [--force]
  agentctl workspace restore --recovery-file <file> [--force]
  agentctl workspace migrate [--yes] [--json]
  agentctl workspace versions [--limit <1-100>]
  agentctl workspace ui <status|enable|disable>

Options:
  --workspace-config <file>  Master capability file (default:
                             ~/.config/agentctl/workspace-remote.json)
  --remote-config <file>     Isolated child Store capability to attach.
  --recovery-file <file>     Read the toolbox1 recovery code from a private
                             one-line file instead of prompting securely.
  --yes, -y                  Confirm an explicit Workspace migration write.

The Workspace snapshot stores child Store capabilities and development preset
definitions only inside its own end-to-end encrypted payload. Existing
isolated recovery codes remain valid.
`);
}

function defaults() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return {
    workspaceConfig: process.env.AGENTCTL_WORKSPACE_CONFIG ||
      join(configHome, "agentctl", "workspace-remote.json"),
    childConfig: {
      mcp: process.env.MCPCTL_REMOTE_CONFIG || join(configHome, "mcpctl", "remote.json"),
      skills: process.env.SKILLSCTL_REMOTE_CONFIG || join(configHome, "skillsctl", "remote.json"),
      prompts: process.env.PROMPTCTL_REMOTE_CONFIG || join(configHome, "promptctl", "remote.json")
    }
  };
}

function takeValue(argv, option) {
  if (argv.length === 0 || argv[0].startsWith("--")) {
    throw new WorkspaceError(`${option} requires a value`);
  }
  return argv.shift();
}

function parseArguments(argv) {
  const base = defaults();
  const positional = [];
  const options = {
    workspaceConfig: base.workspaceConfig,
    remoteConfig: "",
    endpoint: "",
    createTokenFile: "",
    recoveryFile: "",
    force: false,
    yes: false,
    json: false,
    limit: 100,
    help: false,
    childConfig: base.childConfig
  };
  const input = [...argv];
  while (input.length > 0) {
    const argument = input.shift();
    if (argument === "--workspace-config") {
      options.workspaceConfig = takeValue(input, argument);
    } else if (argument.startsWith("--workspace-config=")) {
      options.workspaceConfig = argument.slice("--workspace-config=".length);
    } else if (argument === "--remote-config") {
      options.remoteConfig = takeValue(input, argument);
    } else if (argument.startsWith("--remote-config=")) {
      options.remoteConfig = argument.slice("--remote-config=".length);
    } else if (argument === "--endpoint") {
      options.endpoint = takeValue(input, argument);
    } else if (argument.startsWith("--endpoint=")) {
      options.endpoint = argument.slice("--endpoint=".length);
    } else if (argument === "--create-token-file") {
      options.createTokenFile = takeValue(input, argument);
    } else if (argument.startsWith("--create-token-file=")) {
      options.createTokenFile = argument.slice("--create-token-file=".length);
    } else if (argument === "--recovery-file") {
      options.recoveryFile = takeValue(input, argument);
    } else if (argument.startsWith("--recovery-file=")) {
      options.recoveryFile = argument.slice("--recovery-file=".length);
    } else if (argument === "--limit") {
      options.limit = Number(takeValue(input, argument));
    } else if (argument.startsWith("--limit=")) {
      options.limit = Number(argument.slice("--limit=".length));
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--yes" || argument === "-y") {
      options.yes = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      throw new WorkspaceError(`unknown option '${argument}'`);
    } else {
      positional.push(argument);
    }
  }
  options.workspaceConfig = resolve(options.workspaceConfig);
  if (options.remoteConfig) options.remoteConfig = resolve(options.remoteConfig);
  if (options.createTokenFile) options.createTokenFile = resolve(options.createTokenFile);
  if (options.recoveryFile) options.recoveryFile = resolve(options.recoveryFile);
  return { positional, options };
}

function normalizeType(value) {
  const normalized = TYPE_ALIASES[value] || value;
  if (!STORE_TYPES.includes(normalized)) {
    throw new WorkspaceError("store type must be mcp, skills, or prompts");
  }
  return normalized;
}

function newWorkspace() {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    kind: WORKSPACE_KIND,
    name: "Personal agent workspace",
    created_at: now,
    updated_at: now,
    stores: {},
    presets: {}
  };
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new WorkspaceError(`${label} is invalid`);
  }
  return value;
}

function validateWorkspace(snapshot) {
  snapshot = normalizeWorkspaceSchema(snapshot);
  if (!snapshot || snapshot.schema !== SCHEMA || snapshot.kind !== WORKSPACE_KIND ||
      typeof snapshot.name !== "string" || snapshot.name.length < 1 ||
      snapshot.name.length > 200 || !snapshot.stores ||
      typeof snapshot.stores !== "object" || Array.isArray(snapshot.stores) ||
      !snapshot.presets || typeof snapshot.presets !== "object" ||
      Array.isArray(snapshot.presets)) {
    throw new WorkspaceError("remote snapshot is not a valid agentctl Workspace");
  }
  validateTimestamp(snapshot.created_at, "Workspace created_at");
  validateTimestamp(snapshot.updated_at, "Workspace updated_at");
  for (const type of Object.keys(snapshot.stores)) {
    if (!STORE_TYPES.includes(type)) {
      throw new WorkspaceError(`Workspace contains unsupported Store type '${type}'`);
    }
    const child = snapshot.stores[type];
    if (!child || child.schema !== SCHEMA || child.type !== type ||
        child.protocol !== PROTOCOLS[type].id) {
      throw new WorkspaceError(`Workspace ${type} attachment is invalid`);
    }
    validateTimestamp(child.attached_at, `${type} attached_at`);
    child.config = validateRemoteConfig(child.config);
  }
  for (const [name, preset] of Object.entries(snapshot.presets)) {
    validatePreset(name, preset);
  }
  return snapshot;
}

function validatePreset(name, preset) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 ||
      !preset || preset.schema !== SCHEMA || preset.name !== name ||
      typeof preset.description !== "string" || preset.description.length > 500 ||
      !validPresetReference(preset.mcp) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(preset.skills || "") ||
      preset.skills.length > 64 || !validPresetReference(preset.prompt)) {
    throw new WorkspaceError(`Workspace development preset '${name}' is invalid`);
  }
  return preset;
}

function validPresetReference(value) {
  return typeof value === "string" && value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..") &&
    value !== "." && value !== "..";
}

async function readPrivateLine(filePath, label) {
  let details;
  try {
    details = await lstat(filePath);
  } catch {
    throw new WorkspaceError(`${label} not found: ${filePath}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new WorkspaceError(`${label} must be a regular file: ${filePath}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new WorkspaceError(`${label} permissions must not allow group or other access`);
  }
  const value = (await readFile(filePath, "utf8")).trim();
  if (!value || value.includes("\n") || value.includes("\r")) {
    throw new WorkspaceError(`${label} must contain one non-empty line`);
  }
  return value;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new WorkspaceError("standard input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function readHiddenRecoveryCode({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new WorkspaceError(
      "interactive recovery requires a terminal; use --recovery-file <file> for automation"
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    let value = "";
    let settled = false;

    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      try { input.setRawMode(wasRaw); } catch {}
      if (wasFlowing !== true && typeof input.pause === "function") input.pause();
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      if (error) rejectPromise(error);
      else {
        const code = value.trim();
        if (!code) rejectPromise(new WorkspaceError("Workspace recovery code cannot be empty"));
        else resolvePromise(code);
      }
      value = "";
    };
    const onEnd = () => finish(new WorkspaceError("recovery code entry ended unexpectedly"));
    const onError = () => finish(new WorkspaceError("recovery code input failed"));
    const onData = (chunk) => {
      for (const character of Buffer.from(chunk).toString("utf8")) {
        if (character === "\u0003") return finish(new WorkspaceError("recovery code entry cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (character === "\u0015") {
          value = "";
        } else if (character >= " ") {
          value += character;
          if (value.length > 4096) {
            return finish(new WorkspaceError("Workspace recovery code is too long"));
          }
        }
      }
    };

    try {
      input.setRawMode(true);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      input.resume();
      output.write("Workspace recovery code (input hidden): ");
    } catch {
      finish(new WorkspaceError("could not enable hidden recovery-code input"));
    }
  });
}

async function loadWorkspace(configPath) {
  const snapshot = await downloadRemoteSnapshot(
    configPath,
    WORKSPACE_REMOTE_PROTOCOL
  );
  const sourceSchema = snapshot?.schema;
  const workspace = validateWorkspace(snapshot);
  Object.defineProperty(workspace, "source_schema", {
    value: sourceSchema,
    enumerable: false
  });
  return workspace;
}

async function saveWorkspace(configPath, snapshot) {
  snapshot.updated_at = new Date().toISOString();
  validateWorkspace(snapshot);
  return uploadRemoteSnapshot(configPath, WORKSPACE_REMOTE_PROTOCOL, snapshot);
}

async function init(options) {
  if (!options.endpoint) throw new WorkspaceError("--endpoint is required");
  const createToken = options.createTokenFile
    ? await readPrivateLine(options.createTokenFile, "store creation token")
    : await readStdin();
  const config = await initializeRemoteStore({
    protocol: WORKSPACE_REMOTE_PROTOCOL,
    endpoint: options.endpoint,
    remoteConfig: options.workspaceConfig,
    createToken,
    force: options.force
  });
  await uploadRemoteSnapshot(config, WORKSPACE_REMOTE_PROTOCOL, newWorkspace());
  await setRemoteWebUiEnabled(config, WORKSPACE_REMOTE_PROTOCOL, true);
  if (!options.quiet) {
    process.stdout.write(
      "Workspace initialized. Save this master recovery code offline; it unlocks every attached Store:\n"
    );
    process.stdout.write(`${makeRecoveryCode(config, WORKSPACE_REMOTE_PROTOCOL)}\n`);
  }
  return config;
}

async function status(options) {
  const [config, remote, workspace] = await Promise.all([
    readRemoteConfig(options.workspaceConfig),
    getRemoteStatus(options.workspaceConfig, WORKSPACE_REMOTE_PROTOCOL),
    loadWorkspace(options.workspaceConfig)
  ]);
  const stores = {};
  for (const type of STORE_TYPES) {
    const child = workspace.stores[type];
    stores[type] = child ? {
      attached: true,
      store_id: child.config.store_id,
      endpoint: child.config.endpoint,
      attached_at: child.attached_at
    } : { attached: false };
  }
  const output = {
    schema: SCHEMA,
    remote_schema: workspace.source_schema || SCHEMA,
    migration_pending: workspace.source_schema === 1,
    mode: "workspace",
    endpoint: config.endpoint,
    store_id: config.store_id,
    latest: remote.latest,
    web_ui_enabled: remote.web_ui_enabled,
    stores,
    presets: Object.keys(workspace.presets).sort()
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Workspace: ${config.endpoint}/\n`);
  process.stdout.write(`Web UI:   ${remote.web_ui_enabled ? "enabled" : "disabled"}\n`);
  process.stdout.write(`Version:  ${remote.latest?.version || "none"}\n`);
  for (const type of STORE_TYPES) {
    process.stdout.write(`${type.padEnd(9)} ${stores[type].attached ? "attached" : "not attached"}\n`);
  }
  process.stdout.write(`presets   ${output.presets.length}\n`);
}

async function attach(type, options) {
  const workspace = await loadWorkspace(options.workspaceConfig);
  const configPath = options.remoteConfig || options.childConfig[type];
  const config = await readRemoteConfig(configPath);
  const master = await readRemoteConfig(options.workspaceConfig);
  if (config.endpoint !== master.endpoint) {
    throw new WorkspaceError(
      "attached Stores must use the same endpoint as the Workspace Web UI"
    );
  }
  const childStatus = await getRemoteStatus(config, PROTOCOLS[type]);
  if (!childStatus.latest) {
    throw new WorkspaceError(`${type} Store has no snapshot; run its backup command first`);
  }
  await setRemoteWebUiEnabled(config, PROTOCOLS[type], true);
  workspace.stores[type] = {
    schema: SCHEMA,
    type,
    protocol: PROTOCOLS[type].id,
    attached_at: new Date().toISOString(),
    config
  };
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  process.stdout.write(`Attached ${type} Store to Workspace as ${result.version}.\n`);
}

async function detach(type, options) {
  const workspace = await loadWorkspace(options.workspaceConfig);
  if (!workspace.stores[type]) {
    process.stdout.write(`${type} Store is not attached.\n`);
    return;
  }
  delete workspace.stores[type];
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  process.stdout.write(
    `Detached ${type} Store as ${result.version}; the isolated Store and its recovery code were not deleted.\n`
  );
}

async function recovery(options) {
  const config = await readRemoteConfig(options.workspaceConfig);
  process.stdout.write(`${makeRecoveryCode(config, WORKSPACE_REMOTE_PROTOCOL)}\n`);
}

async function restore(options, { readRecoveryCode = readHiddenRecoveryCode } = {}) {
  const code = options.recoveryFile
    ? await readPrivateLine(options.recoveryFile, "Workspace recovery code")
    : await readRecoveryCode();
  const config = parseRecoveryCode(code, WORKSPACE_REMOTE_PROTOCOL);
  try {
    const existing = await readRemoteConfig(options.workspaceConfig);
    if (JSON.stringify(existing) !== JSON.stringify(config) && !options.force) {
      throw new WorkspaceError(
        `${options.workspaceConfig} points to another Workspace (use --force to replace it)`
      );
    }
  } catch (error) {
    if (!(error instanceof RemoteStoreError) || !/not found/.test(error.message)) throw error;
  }
  const snapshot = await downloadRemoteSnapshot(config, WORKSPACE_REMOTE_PROTOCOL);
  validateWorkspace(snapshot);
  await writeJsonAtomic(options.workspaceConfig, config);
  process.stdout.write(`Restored Workspace capability to ${options.workspaceConfig}.\n`);
}

async function migrate(options) {
  const workspace = await loadWorkspace(options.workspaceConfig);
  if (workspace.source_schema !== 1) {
    const output = { ok: true, changed: false, schema: SCHEMA };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`Workspace already uses schema ${SCHEMA}; no migration is needed.\n`);
    return output;
  }
  if (!options.yes) {
    const output = {
      ok: true,
      changed: false,
      preview: true,
      from_schema: 1,
      to_schema: SCHEMA
    };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(
        `[preview] Workspace schema 1 will be saved as a new schema ${SCHEMA} version.\n` +
        "Existing remote versions remain recoverable. Re-run with --yes to migrate.\n"
      );
    }
    return output;
  }
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  const output = {
    ok: true,
    changed: true,
    from_schema: 1,
    to_schema: SCHEMA,
    version: result.version
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`Migrated Workspace to schema ${SCHEMA} as ${result.version}.\n`);
  return output;
}

async function versions(options) {
  const page = await listRemoteVersions(
    options.workspaceConfig,
    WORKSPACE_REMOTE_PROTOCOL,
    options.limit
  );
  for (const version of page.versions) {
    process.stdout.write(`${version.version}\t${version.created_at}\t${version.size}\n`);
  }
}

async function ui(mode, options) {
  const workspace = await loadWorkspace(options.workspaceConfig);
  const entries = [["workspace", options.workspaceConfig, WORKSPACE_REMOTE_PROTOCOL]];
  for (const type of STORE_TYPES) {
    const child = workspace.stores[type];
    if (child) entries.push([type, child.config, PROTOCOLS[type]]);
  }
  if (mode === "status") {
    for (const [label, config, protocol] of entries) {
      const setting = await getRemoteWebUiSetting(config, protocol);
      process.stdout.write(`${label.padEnd(9)} ${setting.web_ui_enabled ? "enabled" : "disabled"}\n`);
    }
    const master = await readRemoteConfig(options.workspaceConfig);
    process.stdout.write(`URL:      ${master.endpoint}/\n`);
    return;
  }
  const enabled = mode === "enable";
  const ordered = enabled ? entries : [...entries.slice(1), entries[0]];
  for (const [label, config, protocol] of ordered) {
    await setRemoteWebUiEnabled(config, protocol, enabled);
    process.stdout.write(`${label.padEnd(9)} ${enabled ? "enabled" : "disabled"}\n`);
  }
}

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    usage();
    return;
  }
  const action = positional.shift();
  if (action === "init" && positional.length === 0) return init(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "recovery" && positional.length === 0) return recovery(options);
  if (action === "restore" && positional.length === 0) return restore(options);
  if (action === "migrate" && positional.length === 0) return migrate(options);
  if (action === "versions" && positional.length === 0) return versions(options);
  if (action === "attach" && positional.length === 1) {
    return attach(normalizeType(positional[0]), options);
  }
  if (action === "detach" && positional.length === 1) {
    return detach(normalizeType(positional[0]), options);
  }
  if (action === "ui" && positional.length === 1 &&
      ["status", "enable", "disable"].includes(positional[0])) {
    return ui(positional[0], options);
  }
  throw new WorkspaceError("invalid Workspace command; use agentctl workspace --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof WorkspaceError || error instanceof RemoteStoreError
      ? error.message
      : "unexpected Workspace failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export {
  SCHEMA,
  WORKSPACE_KIND,
  attach,
  init,
  loadWorkspace,
  migrate,
  newWorkspace,
  normalizeType,
  readHiddenRecoveryCode,
  restore,
  saveWorkspace,
  ui,
  validatePreset,
  validateWorkspace
};
