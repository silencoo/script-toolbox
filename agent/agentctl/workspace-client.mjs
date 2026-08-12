#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { platformConfigHome } from "../platform-paths.mjs";
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
  WORKSPACE_AGENT_SCHEMA,
  WORKSPACE_ATTACHMENT_SCHEMA,
  WORKSPACE_KIND,
  WORKSPACE_PRESET_SCHEMA,
  WorkspaceSchemaError,
  newWorkspaceAgentBundle,
  normalizeWorkspaceSchema,
  validateWorkspaceAgentBundle
} from "./workspace-schema.mjs";
import {
  ProviderClientError,
  loadProviderSecrets,
  loadProviderStore,
  providerDefaults
} from "./provider-client.mjs";
import {
  ProviderSchemaError,
  newProviderSecrets,
  newProviderStore,
  validateProfileName,
  validateProviderSecrets,
  validateProviderStore
} from "./provider-schema.mjs";
import {
  FailoverClientError,
  failoverDefaults,
  loadFailoverStore
} from "./failover-client.mjs";
import {
  FailoverSchemaError,
  validateFailoverProviders,
  validateFailoverStore
} from "./failover-schema.mjs";
import {
  PricingClientError,
  loadPricingCatalog,
  pricingDefaults
} from "./pricing-client.mjs";
import { PricingError, validatePricingCatalog } from "../pricing/pricing.mjs";

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
  process.stdout.write(`agentctl workspace — encrypted recovery for portable agent catalogs

Usage:
  agentctl workspace init --endpoint <url> [--create-token-file <file>] [--force]
  agentctl workspace status [--json]
  agentctl workspace attach <mcp|skills|prompts> [--remote-config <file>]
  agentctl workspace detach <mcp|skills|prompts>
  agentctl workspace recovery
  agentctl workspace restore [--force]
  agentctl workspace restore --recovery-file <file> [--force]
  agentctl workspace migrate [--yes] [--json]
  agentctl workspace agent <status|push|pull> [--profile <name>]
      [--replace] [--yes] [--json]
  agentctl workspace versions [--limit <1-100>]
  agentctl workspace ui <status|enable|disable>

Options:
  --workspace-config <file>  Master capability file (default:
                             ~/.config/agentctl/workspace-remote.json)
  --remote-config <file>     Isolated child Store capability to attach.
  --recovery-file <file>     Read the toolbox1 recovery code from a private
                             one-line file instead of prompting securely.
  --provider-store <file>    Local portable Provider Store.
  --provider-secrets <file>  Local owner-only provider Secret Store.
  --failover-store <file>    Local portable failover route Store.
  --pricing <file>           Local versioned pricing catalog.
  --profile <name>           Push or pull one Provider profile and only the
                             Secret references used by that profile.
  --replace                  Pull the remote agent bundle as the exact local
                             catalog set instead of merging safely.
  --yes, -y                  Apply a previewed Workspace migration or agent
                             catalog synchronization.

The Workspace snapshot stores child Store capabilities, development presets,
and the agent provider bundle only inside its own end-to-end encrypted
payload. Provider Secret values are restored locally but never printed.
Generated client configs, runtime state, circuit counters, and logs are never
included. Existing isolated recovery codes remain valid.
`);
}

function defaults() {
  const configHome = platformConfigHome();
  const providers = providerDefaults();
  const failover = failoverDefaults();
  const pricing = pricingDefaults();
  return {
    workspaceConfig: process.env.AGENTCTL_WORKSPACE_CONFIG ||
      join(configHome, "agentctl", "workspace-remote.json"),
    childConfig: {
      mcp: process.env.MCPCTL_REMOTE_CONFIG || join(configHome, "mcpctl", "remote.json"),
      skills: process.env.SKILLSCTL_REMOTE_CONFIG || join(configHome, "skillsctl", "remote.json"),
      prompts: process.env.PROMPTCTL_REMOTE_CONFIG || join(configHome, "promptctl", "remote.json")
    },
    providerStore: providers.storePath,
    providerSecrets: providers.secretsPath,
    failoverStore: failover.failoverPath,
    pricing: pricing.pricingPath
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
    profile: "",
    force: false,
    replace: false,
    yes: false,
    json: false,
    limit: 100,
    help: false,
    childConfig: base.childConfig,
    providerStore: base.providerStore,
    providerSecrets: base.providerSecrets,
    failoverStore: base.failoverStore,
    pricing: base.pricing
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
    } else if (argument === "--provider-store") {
      options.providerStore = takeValue(input, argument);
    } else if (argument === "--provider-secrets") {
      options.providerSecrets = takeValue(input, argument);
    } else if (argument === "--failover-store") {
      options.failoverStore = takeValue(input, argument);
    } else if (argument === "--pricing") {
      options.pricing = takeValue(input, argument);
    } else if (argument === "--profile") {
      options.profile = takeValue(input, argument);
    } else if (argument.startsWith("--profile=")) {
      options.profile = argument.slice("--profile=".length);
    } else if (argument === "--limit") {
      options.limit = Number(takeValue(input, argument));
    } else if (argument.startsWith("--limit=")) {
      options.limit = Number(argument.slice("--limit=".length));
    } else if (argument === "--force") {
      options.force = true;
    } else if (argument === "--replace") {
      options.replace = true;
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
  for (const path of ["providerStore", "providerSecrets", "failoverStore", "pricing"]) {
    options[path] = resolve(options[path]);
  }
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
    presets: {},
    agent: newWorkspaceAgentBundle()
  };
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new WorkspaceError(`${label} is invalid`);
  }
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new WorkspaceError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new WorkspaceError(`${label} contains unsupported field '${key}'`);
    }
  }
}

function validateAgentBundle(bundle) {
  try {
    return validateWorkspaceAgentBundle(bundle);
  } catch (error) {
    if (error instanceof WorkspaceSchemaError) throw new WorkspaceError(error.message);
    throw error;
  }
}

function validateWorkspace(snapshot) {
  snapshot = normalizeWorkspaceSchema(snapshot);
  exactKeys(snapshot, [
    "schema", "kind", "name", "created_at", "updated_at", "stores", "presets", "agent"
  ], "Workspace");
  if (!snapshot || snapshot.schema !== SCHEMA || snapshot.kind !== WORKSPACE_KIND ||
      typeof snapshot.name !== "string" || snapshot.name.length < 1 ||
      snapshot.name.length > 200 || !snapshot.stores ||
      typeof snapshot.stores !== "object" || Array.isArray(snapshot.stores) ||
      !snapshot.presets || typeof snapshot.presets !== "object" ||
      Array.isArray(snapshot.presets) || !snapshot.agent) {
    throw new WorkspaceError("remote snapshot is not a valid agentctl Workspace");
  }
  validateTimestamp(snapshot.created_at, "Workspace created_at");
  validateTimestamp(snapshot.updated_at, "Workspace updated_at");
  for (const type of Object.keys(snapshot.stores)) {
    if (!STORE_TYPES.includes(type)) {
      throw new WorkspaceError(`Workspace contains unsupported Store type '${type}'`);
    }
    const child = snapshot.stores[type];
    if (!child || child.schema !== WORKSPACE_ATTACHMENT_SCHEMA || child.type !== type ||
        child.protocol !== PROTOCOLS[type].id) {
      throw new WorkspaceError(`Workspace ${type} attachment is invalid`);
    }
    validateTimestamp(child.attached_at, `${type} attached_at`);
    child.config = validateRemoteConfig(child.config);
  }
  for (const [name, preset] of Object.entries(snapshot.presets)) {
    validatePreset(name, preset);
  }
  validateAgentBundle(snapshot.agent);
  return snapshot;
}

function validatePreset(name, preset) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 ||
      !preset || preset.schema !== WORKSPACE_PRESET_SCHEMA || preset.name !== name ||
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

function agentBundleSummary(bundle) {
  return {
    synced: bundle?.providers !== null,
    synced_at: bundle?.synced_at || null,
    profiles: Object.keys(bundle?.providers?.profiles || {}).length,
    secrets: Object.keys(bundle?.secrets?.secrets || {}).length,
    failover_routes: Object.keys(bundle?.failover?.routes || {}).length,
    pricing_rates: Object.keys(bundle?.pricing?.rates || {}).length,
    pricing_version: bundle?.pricing?.version || null,
    secret_values: "hidden"
  };
}

async function localPathState(path, label) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new WorkspaceError(`${label} must be a regular non-symlink file: ${path}`);
    }
    return details;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadLocalAgentState(options) {
  const [providerFile, secretFile, failoverFile, pricingFile] = await Promise.all([
    localPathState(options.providerStore, "Provider Store"),
    localPathState(options.providerSecrets, "provider Secret Store"),
    localPathState(options.failoverStore, "failover Store"),
    localPathState(options.pricing, "pricing catalog")
  ]);
  const [providers, secrets, failover, pricing] = await Promise.all([
    providerFile ? loadProviderStore(options.providerStore) : Promise.resolve(null),
    secretFile ? loadProviderSecrets(options.providerSecrets) : Promise.resolve(null),
    failoverFile ? loadFailoverStore(options.failoverStore) : Promise.resolve(null),
    pricingFile ? loadPricingCatalog(options.pricing) : Promise.resolve(null)
  ]);
  return {
    providers,
    secrets,
    failover,
    pricing,
    present: {
      providers: Boolean(providerFile),
      secrets: Boolean(secretFile),
      failover: Boolean(failoverFile),
      pricing: Boolean(pricingFile)
    }
  };
}

async function buildLocalAgentBundle(options) {
  const local = await loadLocalAgentState(options);
  if (!local.providers) {
    throw new WorkspaceError(
      `Provider Store not found: ${options.providerStore} (run agentctl provider init --yes first)`
    );
  }
  const secrets = local.secrets || await loadProviderSecrets(
    options.providerSecrets,
    { allowMissing: true }
  );
  const bundle = {
    schema: WORKSPACE_AGENT_SCHEMA,
    synced_at: new Date().toISOString(),
    providers: structuredClone(local.providers),
    secrets: structuredClone(secrets),
    failover: local.failover ? structuredClone(local.failover) : null,
    pricing: local.pricing ? structuredClone(local.pricing) : null
  };
  return validateAgentBundle(bundle);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function profileSecretReferences(profile) {
  const references = new Set();
  const add = (auth) => {
    if (auth?.secret) references.add(auth.secret);
  };
  add(profile.auth);
  for (const override of Object.values(profile.targets || {})) add(override.auth);
  for (const overlay of Object.values(profile.platforms || {})) {
    for (const override of Object.values(overlay.targets || {})) add(override.auth);
  }
  return [...references].sort();
}

function profileTransferPlan({
  name,
  sourceProviders,
  sourceSecrets,
  targetProviders,
  targetSecrets
}) {
  validateProfileName(name);
  const profile = sourceProviders?.profiles?.[name];
  if (!profile) throw new WorkspaceError(`Provider profile '${name}' was not found in the source catalog`);
  const now = new Date().toISOString();
  const providers = targetProviders
    ? structuredClone(targetProviders)
    : {
        ...structuredClone(sourceProviders || newProviderStore(now)),
        profiles: {}
      };
  const secrets = targetSecrets
    ? structuredClone(targetSecrets)
    : {
        ...structuredClone(sourceSecrets || newProviderSecrets(now)),
        secrets: {}
      };
  const profileChanged = !sameJson(providers.profiles[name], profile);
  if (profileChanged) {
    providers.profiles[name] = structuredClone(profile);
    providers.updated_at = now;
  }
  const copiedSecrets = [];
  const missingSecrets = [];
  for (const reference of profileSecretReferences(profile)) {
    const source = sourceSecrets?.secrets?.[reference];
    if (!source) {
      missingSecrets.push(reference);
      continue;
    }
    const current = secrets.secrets[reference];
    if (!current || current.value !== source.value) {
      secrets.secrets[reference] = structuredClone(source);
      copiedSecrets.push(reference);
    }
  }
  const providerStoreChanged = !targetProviders || profileChanged;
  const secretStoreChanged = !targetSecrets || copiedSecrets.length > 0;
  if (secretStoreChanged) secrets.updated_at = now;
  validateProviderStore(providers);
  validateProviderSecrets(secrets);
  return {
    providers,
    secrets,
    profileChanged,
    copiedSecrets,
    missingSecrets,
    providerStoreChanged,
    secretStoreChanged,
    changed: providerStoreChanged || secretStoreChanged
  };
}

function mergeProviderStores(local, remote) {
  if (!local) return structuredClone(remote);
  const next = structuredClone(local);
  let changed = false;
  for (const [name, profile] of Object.entries(remote.profiles)) {
    if (Object.hasOwn(next.profiles, name)) {
      if (!sameJson(next.profiles[name], profile)) {
        throw new WorkspaceError(
          `Provider profile '${name}' conflicts; use --replace to use the Workspace catalog`
        );
      }
      continue;
    }
    next.profiles[name] = structuredClone(profile);
    changed = true;
  }
  if (changed) next.updated_at = new Date().toISOString();
  return validateProviderStore(next);
}

function mergeProviderSecrets(local, remote) {
  if (!local) return structuredClone(remote);
  const next = structuredClone(local);
  let changed = false;
  for (const [name, secret] of Object.entries(remote.secrets)) {
    if (Object.hasOwn(next.secrets, name)) {
      if (next.secrets[name].value !== secret.value) {
        throw new WorkspaceError(
          `provider Secret '${name}' conflicts; use --replace to use the encrypted Workspace value`
        );
      }
      if (Date.parse(secret.updated_at) > Date.parse(next.secrets[name].updated_at)) {
        next.secrets[name] = structuredClone(secret);
        changed = true;
      }
      continue;
    }
    next.secrets[name] = structuredClone(secret);
    changed = true;
  }
  if (changed) next.updated_at = new Date().toISOString();
  return validateProviderSecrets(next);
}

function mergeFailoverStores(local, remote) {
  if (!remote) return local ? structuredClone(local) : null;
  if (!local) return structuredClone(remote);
  const next = structuredClone(local);
  let changed = false;
  for (const [name, route] of Object.entries(remote.routes)) {
    if (Object.hasOwn(next.routes, name)) {
      if (!sameJson(next.routes[name], route)) {
        throw new WorkspaceError(
          `failover route '${name}' conflicts; use --replace to use the Workspace catalog`
        );
      }
      continue;
    }
    next.routes[name] = structuredClone(route);
    changed = true;
  }
  if (changed) next.updated_at = new Date().toISOString();
  return validateFailoverStore(next);
}

function equivalentPricing(left, right) {
  if (!left || !right) return false;
  const local = structuredClone(left);
  const remote = structuredClone(right);
  delete local.updated_at;
  delete remote.updated_at;
  return sameJson(local, remote);
}

function mergePricingCatalogs(local, remote) {
  if (!remote) return local ? structuredClone(local) : null;
  if (!local) return structuredClone(remote);
  if (!equivalentPricing(local, remote)) {
    throw new WorkspaceError(
      "pricing catalog conflicts; use --replace to use the Workspace catalog"
    );
  }
  return structuredClone(
    Date.parse(remote.updated_at) > Date.parse(local.updated_at) ? remote : local
  );
}

function localAgentPaths(options) {
  return {
    providers: options.providerStore,
    secrets: options.providerSecrets,
    failover: options.failoverStore,
    pricing: options.pricing
  };
}

async function snapshotLocalFiles(paths) {
  const snapshots = new Map();
  for (const path of paths) {
    const details = await localPathState(path, "managed agent configuration");
    snapshots.set(path, details ? {
      exists: true,
      bytes: await readFile(path),
      mode: details.mode & 0o777
    } : { exists: false, bytes: null, mode: 0o600 });
  }
  return snapshots;
}

async function writeBytesAtomic(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await localPathState(path, "managed agent configuration");
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, mode);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeLocalJson(path, value) {
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
}

async function removeLocalFile(path) {
  const details = await localPathState(path, "managed agent configuration");
  if (details) await unlink(path);
}

async function restoreLocalFiles(snapshots) {
  const failures = [];
  for (const [path, snapshot] of snapshots) {
    try {
      if (snapshot.exists) await writeBytesAtomic(path, snapshot.bytes, snapshot.mode);
      else await removeLocalFile(path);
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new WorkspaceError(`local agent rollback failed (${failures.join("; ")})`);
  }
}

function pullPlan(remote, local, options) {
  const next = options.replace ? {
    providers: structuredClone(remote.providers),
    secrets: structuredClone(remote.secrets),
    failover: remote.failover ? structuredClone(remote.failover) : null,
    pricing: remote.pricing ? structuredClone(remote.pricing) : null
  } : {
    providers: mergeProviderStores(local.providers, remote.providers),
    secrets: mergeProviderSecrets(local.secrets, remote.secrets),
    failover: mergeFailoverStores(local.failover, remote.failover),
    pricing: mergePricingCatalogs(local.pricing, remote.pricing)
  };
  validateAgentBundle({
    schema: WORKSPACE_AGENT_SCHEMA,
    synced_at: remote.synced_at,
    ...structuredClone(next)
  });
  const paths = localAgentPaths(options);
  const writes = [];
  const deletes = [];
  for (const name of Object.keys(paths)) {
    const current = local[name];
    if (next[name] === null) {
      if (local.present[name] && options.replace) deletes.push(name);
    } else if (!current || !sameJson(current, next[name])) {
      writes.push(name);
    }
  }
  return { next, paths, writes, deletes };
}

async function applyPullPlan(plan) {
  const affected = [...new Set([
    ...plan.writes.map((name) => plan.paths[name]),
    ...plan.deletes.map((name) => plan.paths[name])
  ])];
  const snapshots = await snapshotLocalFiles(affected);
  try {
    for (const name of plan.writes) await writeLocalJson(plan.paths[name], plan.next[name]);
    for (const name of plan.deletes) await removeLocalFile(plan.paths[name]);
  } catch (error) {
    try {
      await restoreLocalFiles(snapshots);
    } catch (rollback) {
      throw new WorkspaceError(`${error.message}; ${rollback.message}`);
    }
    throw error;
  }
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
  const status = await getRemoteStatus(configPath, WORKSPACE_REMOTE_PROTOCOL);
  if (!status.latest) throw new WorkspaceError("Workspace has no encrypted snapshot");
  const snapshot = await downloadRemoteSnapshot(
    configPath,
    WORKSPACE_REMOTE_PROTOCOL,
    status.latest.version
  );
  const sourceSchema = snapshot?.schema;
  const workspace = validateWorkspace(snapshot);
  Object.defineProperty(workspace, "source_schema", {
    value: sourceSchema,
    enumerable: false
  });
  Object.defineProperty(workspace, "source_version", {
    value: status.latest.version,
    writable: true,
    enumerable: false
  });
  return workspace;
}

async function saveWorkspace(configPath, snapshot) {
  snapshot.updated_at = new Date().toISOString();
  validateWorkspace(snapshot);
  const options = snapshot.source_version
    ? { baseVersion: snapshot.source_version }
    : {};
  const result = await uploadRemoteSnapshot(
    configPath,
    WORKSPACE_REMOTE_PROTOCOL,
    snapshot,
    options
  );
  if (Object.hasOwn(snapshot, "source_version")) snapshot.source_version = result.version;
  return result;
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
    migration_pending: workspace.source_schema !== SCHEMA,
    mode: "workspace",
    endpoint: config.endpoint,
    store_id: config.store_id,
    latest: remote.latest,
    web_ui_enabled: remote.web_ui_enabled,
    stores,
    presets: Object.keys(workspace.presets).sort(),
    agent: agentBundleSummary(workspace.agent)
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
  process.stdout.write(
    `agent     ${output.agent.synced ? `${output.agent.profiles} profile(s), ${output.agent.secrets} Secret(s)` : "not backed up"}\n`
  );
}

function localAgentSummary(local) {
  return {
    providers_present: local.present.providers,
    secrets_present: local.present.secrets,
    failover_present: local.present.failover,
    pricing_present: local.present.pricing,
    profiles: Object.keys(local.providers?.profiles || {}).length,
    secrets: Object.keys(local.secrets?.secrets || {}).length,
    failover_routes: Object.keys(local.failover?.routes || {}).length,
    pricing_rates: Object.keys(local.pricing?.rates || {}).length,
    pricing_version: local.pricing?.version || null,
    secret_values: "hidden"
  };
}

function agentSafety() {
  return {
    encryption: "end-to-end encrypted Workspace payload",
    secret_values: "hidden",
    excluded: [
      "generated client configuration",
      "provider selection state",
      "proxy configuration and capability",
      "PIDs, ports, locks, logs, usage rows, and circuit counters"
    ]
  };
}

function emitAgent(value, options, lines) {
  if (options.quiet) return;
  if (options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

async function agentStatus(options) {
  const [workspace, local] = await Promise.all([
    loadWorkspace(options.workspaceConfig),
    loadLocalAgentState(options)
  ]);
  const output = {
    schema: 1,
    remote: agentBundleSummary(workspace.agent),
    local: localAgentSummary(local),
    paths: localAgentPaths(options),
    safety: agentSafety()
  };
  emitAgent(output, options, [
    `Workspace agent bundle: ${output.remote.synced ? `${output.remote.profiles} profile(s)` : "not backed up"}`,
    `Local Provider Store:   ${output.local.providers_present ? `${output.local.profiles} profile(s)` : "not initialized"}`,
    `Local Secrets:          ${output.local.secrets} reference value(s) (hidden)`,
    `Failover / pricing:     ${output.local.failover_routes} route(s) / ${output.local.pricing_rates} rate(s)`,
    "Generated configs, runtime state, logs, and circuit counters are excluded."
  ]);
  return output;
}

async function agentProfilePush(options) {
  if (options.replace) {
    throw new WorkspaceError("--replace cannot be combined with --profile; the selected local profile already replaces only its Workspace counterpart");
  }
  const name = validateProfileName(options.profile);
  const [workspace, local] = await Promise.all([
    loadWorkspace(options.workspaceConfig),
    loadLocalAgentState(options)
  ]);
  if (!local.providers) {
    throw new WorkspaceError(
      `Provider Store not found: ${options.providerStore} (run agentctl provider init --yes first)`
    );
  }
  const plan = profileTransferPlan({
    name,
    sourceProviders: local.providers,
    sourceSecrets: local.secrets,
    targetProviders: workspace.agent.providers,
    targetSecrets: workspace.agent.secrets
  });
  const preview = {
    schema: 1,
    ok: true,
    action: "push",
    scope: "profile",
    profile: name,
    changed: Boolean(options.yes && plan.changed),
    preview: !options.yes,
    profile_changed: plan.profileChanged,
    secrets_copied: plan.copiedSecrets.length,
    missing_secret_references: plan.missingSecrets.length,
    replace_remote_agent_bundle: false,
    secret_values: "hidden",
    safety: agentSafety()
  };
  if (!options.yes) {
    emitAgent(preview, options, [
      `[preview] use the local Provider profile '${name}' in encrypted Workspace.`,
      `${plan.copiedSecrets.length} referenced Secret value(s) would be copied without being printed; every other remote profile and catalog remains unchanged.`,
      "Re-run with --yes to upload this profile only."
    ]);
    return preview;
  }
  if (!plan.changed) {
    emitAgent(preview, options, [
      `Provider profile '${name}' already matches encrypted Workspace; no new version was created.`,
      "Secret values were not printed."
    ]);
    return preview;
  }
  workspace.agent = validateAgentBundle({
    ...structuredClone(workspace.agent),
    schema: WORKSPACE_AGENT_SCHEMA,
    synced_at: new Date().toISOString(),
    providers: plan.providers,
    secrets: plan.secrets
  });
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  const output = { ...preview, changed: true, version: result.version };
  emitAgent(output, options, [
    `Local Provider profile '${name}' saved as Workspace version ${result.version}.`,
    `${plan.copiedSecrets.length} referenced Secret value(s) were encrypted and were not printed; every other remote profile and catalog was preserved.`
  ]);
  return output;
}

async function agentProfilePull(options) {
  if (options.replace) {
    throw new WorkspaceError("--replace cannot be combined with --profile; the selected Workspace profile already replaces only its local counterpart");
  }
  const name = validateProfileName(options.profile);
  const [workspace, local] = await Promise.all([
    loadWorkspace(options.workspaceConfig),
    loadLocalAgentState(options)
  ]);
  if (!workspace.agent.providers || !workspace.agent.secrets) {
    throw new WorkspaceError("Workspace does not contain an agent provider bundle; push one first");
  }
  const plan = profileTransferPlan({
    name,
    sourceProviders: workspace.agent.providers,
    sourceSecrets: workspace.agent.secrets,
    targetProviders: local.providers,
    targetSecrets: local.secrets
  });
  const paths = localAgentPaths(options);
  const writes = [];
  if (plan.providerStoreChanged) writes.push("providers");
  if (plan.secretStoreChanged) writes.push("secrets");
  const preview = {
    schema: 1,
    ok: true,
    action: "pull",
    scope: "profile",
    profile: name,
    mode: "profile-replace",
    changed: Boolean(options.yes && writes.length > 0),
    preview: !options.yes,
    profile_changed: plan.profileChanged,
    secrets_copied: plan.copiedSecrets.length,
    missing_secret_references: plan.missingSecrets.length,
    writes,
    deletes: [],
    secret_values: "hidden",
    safety: agentSafety()
  };
  if (!options.yes) {
    emitAgent(preview, options, [
      `[preview] use encrypted Workspace Provider profile '${name}' in the local catalog.`,
      `${plan.copiedSecrets.length} referenced Secret value(s) would be restored without being printed; every other local profile and catalog remains unchanged.`,
      "Re-run with --yes to restore this profile only."
    ]);
    return preview;
  }
  if (writes.length > 0) {
    await applyPullPlan({
      next: {
        providers: plan.providers,
        secrets: plan.secrets,
        failover: local.failover,
        pricing: local.pricing
      },
      paths,
      writes,
      deletes: []
    });
  }
  emitAgent(preview, options, [
    writes.length > 0
      ? `Workspace Provider profile '${name}' replaced only its local counterpart transactionally.`
      : `Provider profile '${name}' already matches the encrypted Workspace; no local file was changed.`,
    `${plan.copiedSecrets.length} referenced Secret value(s) were restored without being printed; every other local profile and catalog was preserved.`,
    "The device-local applied Provider selection was not changed."
  ]);
  return preview;
}

async function agentPush(options) {
  if (options.profile) return agentProfilePush(options);
  const [workspace, bundle] = await Promise.all([
    loadWorkspace(options.workspaceConfig),
    buildLocalAgentBundle(options)
  ]);
  const summary = agentBundleSummary(bundle);
  const preview = {
    schema: 1,
    ok: true,
    action: "push",
    changed: options.yes,
    preview: !options.yes,
    replace_remote_agent_bundle: true,
    bundle: summary,
    safety: agentSafety()
  };
  if (!options.yes) {
    emitAgent(preview, options, [
      `[preview] replace the encrypted Workspace agent bundle with ${summary.profiles} profile(s), ${summary.secrets} hidden Secret value(s), ${summary.failover_routes} route(s), and ${summary.pricing_rates} rate(s).`,
      "Other Workspace Stores and Presets remain unchanged. Re-run with --yes to upload."
    ]);
    return preview;
  }
  workspace.agent = bundle;
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  const output = { ...preview, preview: false, changed: true, version: result.version };
  emitAgent(output, options, [
    `Encrypted agent bundle saved as Workspace version ${result.version}.`,
    `${summary.secrets} provider Secret value(s) were encrypted and were not printed.`
  ]);
  return output;
}

async function agentPull(options) {
  if (options.profile) return agentProfilePull(options);
  const [workspace, local] = await Promise.all([
    loadWorkspace(options.workspaceConfig),
    loadLocalAgentState(options)
  ]);
  if (workspace.agent.providers === null) {
    throw new WorkspaceError("Workspace does not contain an agent provider bundle; push one first");
  }
  const plan = pullPlan(workspace.agent, local, options);
  const remote = agentBundleSummary(workspace.agent);
  const preview = {
    schema: 1,
    ok: true,
    action: "pull",
    mode: options.replace ? "replace" : "merge",
    changed: options.yes && (plan.writes.length > 0 || plan.deletes.length > 0),
    preview: !options.yes,
    writes: [...plan.writes],
    deletes: [...plan.deletes],
    bundle: remote,
    secret_values: "hidden",
    safety: agentSafety()
  };
  if (!options.yes) {
    emitAgent(preview, options, [
      `[preview] ${options.replace ? "replace" : "merge"} local agent catalogs from encrypted Workspace.`,
      `Writes: ${plan.writes.join(", ") || "none"}; deletes: ${plan.deletes.join(", ") || "none"}.`,
      `${remote.secrets} provider Secret value(s) will remain hidden. Re-run with --yes to apply.`
    ]);
    return preview;
  }
  await applyPullPlan(plan);
  emitAgent(preview, options, [
    `Local agent catalogs ${options.replace ? "replaced" : "merged"} transactionally.`,
    `${remote.secrets} provider Secret value(s) restored without printing them.`,
    "Run agentctl provider plan/apply for the selected machine; generated configs were not restored."
  ]);
  return preview;
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
    schema: WORKSPACE_ATTACHMENT_SCHEMA,
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
  if (workspace.source_schema === SCHEMA) {
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
      from_schema: workspace.source_schema,
      to_schema: SCHEMA
    };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(
        `[preview] Workspace schema ${workspace.source_schema} will be saved as a new schema ${SCHEMA} version.\n` +
        "Existing remote versions remain recoverable. Re-run with --yes to migrate.\n"
      );
    }
    return output;
  }
  const result = await saveWorkspace(options.workspaceConfig, workspace);
  const output = {
    ok: true,
    changed: true,
    from_schema: workspace.source_schema,
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
  if (options.profile && (action !== "agent" || positional.length !== 1 ||
      !["push", "pull"].includes(positional[0]))) {
    throw new WorkspaceError("--profile is supported only by workspace agent push or pull");
  }
  if (action === "init" && positional.length === 0) return init(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "recovery" && positional.length === 0) return recovery(options);
  if (action === "restore" && positional.length === 0) return restore(options);
  if (action === "migrate" && positional.length === 0) return migrate(options);
  if (action === "agent" && positional.length === 1) {
    if (positional[0] === "status") return agentStatus(options);
    if (positional[0] === "push") return agentPush(options);
    if (positional[0] === "pull") return agentPull(options);
  }
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
    const safe = error instanceof WorkspaceError || error instanceof RemoteStoreError ||
      error instanceof ProviderClientError || error instanceof ProviderSchemaError ||
      error instanceof FailoverClientError || error instanceof FailoverSchemaError ||
      error instanceof PricingClientError || error instanceof PricingError
      ? error.message
      : "unexpected Workspace failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export {
  SCHEMA,
  WORKSPACE_KIND,
  agentPull,
  agentPush,
  agentStatus,
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
  validateAgentBundle,
  validatePreset,
  validateWorkspace
};
