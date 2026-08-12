#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bashScriptCommand } from "../platform-command.mjs";
import { platformConfigHome, platformStateHome } from "../platform-paths.mjs";
import {
  CURRENT_PROVIDER_SCHEMA,
  PROVIDER_AUTH_MODES,
  PROVIDER_COMPACTION_POLICIES,
  PROVIDER_COMPACTION_UPSTREAMS,
  PROVIDER_PLATFORMS,
  PROVIDER_PROTOCOLS,
  PROVIDER_TARGETS,
  ProviderSchemaError,
  newProviderSecrets,
  newProviderStore,
  normalizeRuntimePlatform,
  resolveProviderProfile,
  validateAuthMode,
  validateAutoCompactTokens,
  validateCompactionPolicy,
  validateCompactionUpstream,
  validateContextWindowTokens,
  validateEndpoint,
  validateModelId,
  validatePlatform,
  validateProfileName,
  validateProtocol,
  validateProviderSecrets,
  validateProviderStore,
  validateReferenceName,
  validateTarget
} from "./provider-schema.mjs";
import {
  builtinModelContext,
  builtinModels,
  builtinNativeAuthProvider,
  builtinProvider,
  builtinProviderCatalog,
  builtinProviderProfile,
  builtinValidationUrl,
  isBuiltinProvider
} from "./provider-catalog.mjs";
import {
  ProviderRendererError,
  allProviderTargets,
  assertApplyPlatform,
  backendArguments,
  managedTargetPaths,
  renderProviderPlan
} from "./provider-renderer.mjs";

const MAX_STORE_BYTES = 5 * 1024 * 1024;

export class ProviderClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl provider — one catalog for built-ins, local profiles, and Workspace restore

Usage:
  agentctl provider status [--json]
  agentctl provider list --target <target> [--platform <platform>] [--json]
  agentctl provider show <profile> [--json]
  agentctl provider resolve <profile> --target <target> [--platform <platform>] [--json]
  agentctl provider plan <profile> --target <target|all> [--platform <platform>] [--json]
  agentctl provider use <profile> --target <target|all> [--model <id>]
      [--context-window-tokens <tokens|auto>] [--auto-compact-tokens <tokens|auto>]
      [--secret-file <private-file>] [--platform <platform>] [--skip-validate] [--yes]
  agentctl provider current [--target <target|all>] [--json]
  agentctl provider migrate ccs [--database <cc-switch.db>]
      [--target <claude|codex|all>] [--force] [--yes] [--json]
  agentctl provider migrate schema [--yes] [--json]
  agentctl provider create <profile> --protocol <protocol> --base-url <url>
      --model <id> [--auth-mode <mode>] [--secret <reference>]
      [--compaction-upstream <capability>] [--compaction-policy <policy>]
      [--context-window-tokens <tokens|auto>]
      [--auto-compact-tokens <tokens|auto>]
      [--description <text>] [--alias <requested=outbound>]... [--yes]
  agentctl provider target <profile> <target> [override options] [--yes]
  agentctl provider platform <profile> <platform> <target> [override options] [--yes]
  agentctl provider delete <profile> [--yes]
  agentctl provider secret <list|status> [name] [--json]
  agentctl provider secret set <name> --secret-file <private-file> [--yes]
  agentctl provider secret delete <name> [--yes]
  agentctl provider export --output <file> [--force] [--yes]
  agentctl provider import --input <file> [--replace] [--yes]
  agentctl provider restore <profile> --input <file> --target <target|all>
      [--replace] [--skip-validate] [--force] [--yes]

Examples:
  agentctl provider list --target claude
  agentctl provider use deepseek --target claude --secret-file ./deepseek.key --yes
  agentctl provider current --target claude

Protocols:
  ${PROVIDER_PROTOCOLS.join(", ")}

Authentication modes:
  ${PROVIDER_AUTH_MODES.join(", ")}

Compaction upstreams: ${PROVIDER_COMPACTION_UPSTREAMS.join(", ")}
Compaction policies:  ${PROVIDER_COMPACTION_POLICIES.join(", ")}

Targets:   ${PROVIDER_TARGETS.join(", ")}
Platforms: ${PROVIDER_PLATFORMS.join(", ")}

Override options:
  --enable | --disable       Override target availability.
  --protocol <protocol>      Override the provider protocol.
  --base-url <url>           Override the provider endpoint.
  --model <id>               Override the requested/default model.
  --auth-mode <mode>         Override the authentication mode.
  --secret <reference>       Override the local Secret reference.
  --compaction-upstream <capability>
                             Declare a verified native upstream capability.
  --compaction-policy <policy>
                             Choose auto, remote, or local behavior.
  --context-window-tokens <tokens|auto>
                             Declare the selected model's real context window.
  --auto-compact-tokens <tokens|auto>
                             Set a client auto-compact trigger independently.
  --inherit                  Remove the entire target/platform override.

Storage options:
  --store <file>             Portable catalog (default: platform config dir).
  --secrets <file>           Local chmod-600 Secret Store.
  --state <file>             Device-local applied-selection state.
  --database <file>          CCS SQLite database used only by migrate ccs.
  --skip-validate            Do not probe the provider models endpoint on use.
  --yes, -y                  Apply the displayed mutation; otherwise preview.

Built-in profiles appear before the local Store is initialized. Using one
materializes it into the portable Store so Workspace backup can synchronize it.
Provider exports contain Secret reference names but never Secret values.
Generated client configuration, absolute config paths, logs, process state,
and proxy health are deliberately outside this Store.
`);
}

export function providerDefaults({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  const configHome = platformConfigHome({ platform, environment, home });
  const stateHome = platformStateHome({ platform, environment, home });
  const root = join(configHome, "agentctl");
  return {
    storePath: environment.AGENTCTL_PROVIDER_STORE || join(root, "providers.json"),
    secretsPath: environment.AGENTCTL_PROVIDER_SECRETS ||
      join(root, "provider-secrets.json"),
    statePath: environment.AGENTCTL_PROVIDER_STATE ||
      join(stateHome, "agentctl", "providers.json")
  };
}

function takeValue(argv, option) {
  if (argv.length === 0 || argv[0].startsWith("--")) {
    throw new ProviderClientError(`${option} requires a value`);
  }
  return argv.shift();
}

export function parseArguments(argv, defaults = providerDefaults()) {
  const options = {
    ...defaults,
    aliases: [],
    yes: false,
    json: false,
    force: false,
    replace: false,
    inherit: false,
    enabled: undefined,
    platform: undefined,
    skipValidate: false
  };
  const positional = [];
  argv = [...argv];
  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--store": options.storePath = takeValue(argv, argument); break;
      case "--secrets": options.secretsPath = takeValue(argv, argument); break;
      case "--state": options.statePath = takeValue(argv, argument); break;
      case "--description": options.description = takeValue(argv, argument); break;
      case "--protocol": options.protocol = takeValue(argv, argument); break;
      case "--base-url":
      case "--endpoint": options.endpoint = takeValue(argv, argument); break;
      case "--model": options.model = takeValue(argv, argument); break;
      case "--auth-mode": options.authMode = takeValue(argv, argument); break;
      case "--secret": options.secret = takeValue(argv, argument); break;
      case "--compaction-upstream":
        options.compactionUpstream = takeValue(argv, argument); break;
      case "--compaction-policy":
        options.compactionPolicy = takeValue(argv, argument); break;
      case "--context-window-tokens":
        options.contextWindowTokens = takeValue(argv, argument); break;
      case "--auto-compact-tokens":
        options.autoCompactTokens = takeValue(argv, argument); break;
      case "--secret-file": options.secretFile = takeValue(argv, argument); break;
      case "--platform": options.platform = takeValue(argv, argument); break;
      case "--target": options.target = takeValue(argv, argument); break;
      case "--alias": options.aliases.push(takeValue(argv, argument)); break;
      case "--output": options.output = takeValue(argv, argument); break;
      case "--input": options.input = takeValue(argv, argument); break;
      case "--database": options.database = takeValue(argv, argument); break;
      case "--enable":
        if (options.enabled === false) throw new ProviderClientError("--enable and --disable conflict");
        options.enabled = true;
        break;
      case "--disable":
        if (options.enabled === true) throw new ProviderClientError("--enable and --disable conflict");
        options.enabled = false;
        break;
      case "--inherit": options.inherit = true; break;
      case "--replace": options.replace = true; break;
      case "--force": options.force = true; break;
      case "--skip-validate": options.skipValidate = true; break;
      case "--yes":
      case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        if (argument.startsWith("-")) {
          throw new ProviderClientError(`unknown option '${argument}'`);
        }
        positional.push(argument);
    }
  }
  options.storePath = resolve(options.storePath);
  options.secretsPath = resolve(options.secretsPath);
  options.statePath = resolve(options.statePath);
  if (options.output) options.output = resolve(options.output);
  if (options.input) options.input = resolve(options.input);
  if (options.secretFile) options.secretFile = resolve(options.secretFile);
  if (options.database) options.database = resolve(options.database);
  return { positional, options };
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(path, label) {
  const details = await pathState(path);
  if (!details) throw new ProviderClientError(`${label} not found: ${path}`);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new ProviderClientError(`${label} must be a regular, non-symlink file: ${path}`);
  }
  if (details.size > MAX_STORE_BYTES) {
    throw new ProviderClientError(`${label} is larger than ${MAX_STORE_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProviderClientError(`${label} is not valid JSON`);
    throw error;
  }
  return value;
}

async function nativeProviderState(target, { home = homedir() } = {}) {
  if (target !== "opencode") {
    return { credentials: new Map(), selected_provider: "", selected_model: "" };
  }
  const credentials = new Map();
  const authPath = join(home, ".local", "share", "opencode", "auth.json");
  try {
    const value = await readJson(authPath, "OpenCode native auth");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [provider, record] of Object.entries(value)) {
        if (!/^[A-Za-z0-9._-]{1,96}$/.test(provider) ||
            !record || typeof record !== "object" || Array.isArray(record)) continue;
        const type = typeof record.type === "string" &&
          /^[A-Za-z0-9._-]{1,32}$/.test(record.type)
          ? record.type
          : "unknown";
        credentials.set(provider, { provider, type });
      }
    }
  } catch {
    // Native client state is advisory. A missing or malformed external file
    // must not make the portable Provider catalog unavailable.
  }

  let selectedProvider = "";
  let selectedModel = "";
  const configPath = join(home, ".config", "opencode", "opencode.json");
  try {
    const value = await readJson(configPath, "OpenCode config");
    const model = typeof value?.model === "string" ? value.model : "";
    const separator = model.indexOf("/");
    if (separator > 0 && separator < model.length - 1) {
      const provider = model.slice(0, separator);
      const selected = model.slice(separator + 1);
      if (/^[A-Za-z0-9._-]{1,96}$/.test(provider) && selected.length <= 240) {
        selectedProvider = provider;
        selectedModel = selected;
      }
    }
  } catch {
    // As above, native state augments rather than gates the portable catalog.
  }
  return {
    credentials,
    selected_provider: selectedProvider,
    selected_model: selectedModel
  };
}

async function writeJsonAtomic(path, value) {
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
}

async function writeBytesAtomic(path, bytes, mode = 0o600) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ProviderClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, {
      flag: "wx",
      mode
    });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function loadProviderStore(path, { allowMissing = false } = {}) {
  const details = await pathState(path);
  if (!details && allowMissing) return newProviderStore();
  return validateProviderStore(await readJson(path, "provider Store"));
}

export async function saveProviderStore(path, store) {
  const next = structuredClone(store);
  next.updated_at = new Date().toISOString();
  validateProviderStore(next);
  await writeJsonAtomic(path, next);
  return next;
}

export async function loadProviderSecrets(path, { allowMissing = false } = {}) {
  const details = await pathState(path);
  if (!details && allowMissing) return newProviderSecrets();
  if (details && process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ProviderClientError(
      `provider Secret Store must be owner-only (chmod 600): ${path}`
    );
  }
  return validateProviderSecrets(await readJson(path, "provider Secret Store"));
}

export async function saveProviderSecrets(path, secrets) {
  const next = structuredClone(secrets);
  next.updated_at = new Date().toISOString();
  validateProviderSecrets(next);
  await writeJsonAtomic(path, next);
  return next;
}

const PROVIDER_STATE_KIND = "agentctl-provider-state";

function newProviderState() {
  return {
    schema: 1,
    kind: PROVIDER_STATE_KIND,
    updated_at: new Date().toISOString(),
    current: {}
  };
}

function validateProviderState(value) {
  if (!value || value.schema !== 1 || value.kind !== PROVIDER_STATE_KIND ||
      typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at)) ||
      !value.current || typeof value.current !== "object" || Array.isArray(value.current)) {
    throw new ProviderClientError("provider selection state is invalid");
  }
  for (const key of Object.keys(value)) {
    if (!["schema", "kind", "updated_at", "current"].includes(key)) {
      throw new ProviderClientError(`provider selection state contains unsupported field '${key}'`);
    }
  }
  for (const [target, record] of Object.entries(value.current)) {
    if (record && typeof record === "object" && !Array.isArray(record)) {
      record.provider_name ??= record.profile;
      record.compaction_upstream ??= "none";
      record.compaction_policy ??= "auto";
      record.compaction_mode ??= "client_local";
      record.context_window_tokens ??= null;
      record.auto_compact_tokens ??= null;
    }
    validateTarget(target, "provider state target");
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.target !== target || typeof record.profile !== "string" ||
        typeof record.platform !== "string" || typeof record.protocol !== "string" ||
        typeof record.endpoint !== "string" || typeof record.requested_model !== "string" ||
        typeof record.outbound_model !== "string" ||
        typeof record.applied_at !== "string" || Number.isNaN(Date.parse(record.applied_at))) {
      throw new ProviderClientError(`provider selection state for '${target}' is invalid`);
    }
    validateProfileName(record.profile, `provider state profile for '${target}'`);
    validatePlatform(record.platform, `provider state platform for '${target}'`);
    validateProtocol(record.protocol, `provider state protocol for '${target}'`);
    validateEndpoint(record.endpoint, `provider state endpoint for '${target}'`);
    validateModelId(record.requested_model, `provider state requested model for '${target}'`);
    validateModelId(record.outbound_model, `provider state outbound model for '${target}'`);
    const allowed = [
      "target", "profile", "platform", "protocol", "endpoint",
      "requested_model", "outbound_model", "provider_name",
      "compaction_upstream", "compaction_policy", "compaction_mode",
      "context_window_tokens", "auto_compact_tokens",
      "official_identity_policy", "applied_at"
    ];
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        throw new ProviderClientError(
          `provider selection state for '${target}' contains unsupported field '${key}'`
        );
      }
    }
    if (record.official_identity_policy !== undefined &&
        (target !== "codex" || record.official_identity_policy !== "preserve")) {
      throw new ProviderClientError(
        `provider selection state for '${target}' has an invalid official Identity policy`
      );
    }
    if (record.provider_name !== undefined && typeof record.provider_name !== "string") {
      throw new ProviderClientError(
        `provider selection state for '${target}' has an invalid rendered Provider name`
      );
    }
    if (record.compaction_upstream !== undefined) {
      validateCompactionUpstream(record.compaction_upstream,
        `provider state compaction upstream for '${target}'`);
    }
    if (record.compaction_policy !== undefined) {
      validateCompactionPolicy(record.compaction_policy,
        `provider state compaction policy for '${target}'`);
    }
    if (record.compaction_mode !== undefined &&
        !["client_local", "remote_native", "messages_native"].includes(record.compaction_mode)) {
      throw new ProviderClientError(
        `provider selection state for '${target}' has an invalid compaction mode`
      );
    }
    validateContextWindowTokens(record.context_window_tokens,
      `provider state context window for '${target}'`);
    validateAutoCompactTokens(record.auto_compact_tokens,
      `provider state auto-compact window for '${target}'`);
    if (record.context_window_tokens !== null && record.auto_compact_tokens !== null &&
        record.auto_compact_tokens > record.context_window_tokens) {
      throw new ProviderClientError(
        `provider selection state for '${target}' has auto-compact above its context window`
      );
    }
  }
  return value;
}

async function loadProviderState(path, { allowMissing = false } = {}) {
  const details = await pathState(path);
  if (!details && allowMissing) return newProviderState();
  return validateProviderState(await readJson(path, "provider selection state"));
}

async function saveProviderState(path, state) {
  const next = structuredClone(state);
  next.updated_at = new Date().toISOString();
  validateProviderState(next);
  await writeJsonAtomic(path, next);
  return next;
}

function printMutation(label, details, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      preview: !options.yes,
      action: label,
      ...details
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${options.yes ? "[apply]" : "[preview]"} ${label}\n`);
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) process.stdout.write(`  ${key}: ${value}\n`);
  }
  if (!options.yes) process.stdout.write("Re-run with --yes to apply.\n");
}

function profileOrThrow(store, name) {
  validateProfileName(name);
  const profile = store.profiles[name];
  if (!profile) throw new ProviderClientError(`provider profile not found: ${name}`);
  return profile;
}

function catalogProfileOrThrow(store, name) {
  validateProfileName(name);
  const profile = store.profiles[name] || builtinProviderProfile(name);
  if (!profile) throw new ProviderClientError(`provider profile not found: ${name}`);
  return profile;
}

function matchesAppliedSelection(current, plan) {
  return current?.profile === plan.profile &&
    current.platform === plan.platform &&
    current.protocol === plan.protocol &&
    current.endpoint === plan.endpoint &&
    current.requested_model === plan.requested_model &&
    current.outbound_model === plan.outbound_model &&
    current.provider_name === plan.provider_name &&
    current.compaction_upstream === plan.compaction.upstream &&
    current.compaction_policy === plan.compaction.policy &&
    current.compaction_mode === plan.compaction.mode &&
    current.context_window_tokens === plan.context.window_tokens &&
    current.auto_compact_tokens === plan.context.auto_compact_tokens;
}

function collectSecretReferences(store) {
  const references = new Map();
  const add = (secret, location) => {
    if (!secret) return;
    const locations = references.get(secret) || [];
    locations.push(location);
    references.set(secret, locations);
  };
  for (const [name, profile] of Object.entries(store.profiles)) {
    add(profile.auth.secret, name);
    for (const [target, override] of Object.entries(profile.targets)) {
      add(override.auth?.secret, `${name}:target:${target}`);
    }
    for (const [platform, overlay] of Object.entries(profile.platforms)) {
      for (const [target, override] of Object.entries(overlay.targets)) {
        add(override.auth?.secret, `${name}:${platform}:${target}`);
      }
    }
  }
  return references;
}

async function init(options) {
  if (options.force) throw new ProviderClientError("provider init does not reset existing Stores");
  const storeExists = Boolean(await pathState(options.storePath));
  const secretsExist = Boolean(await pathState(options.secretsPath));
  if (storeExists) await loadProviderStore(options.storePath);
  if (secretsExist) await loadProviderSecrets(options.secretsPath);
  printMutation("initialize provider Store", {
    catalog: storeExists ? `${options.storePath} (keep)` : options.storePath,
    secrets: secretsExist ? `${options.secretsPath} (keep)` : options.secretsPath
  }, options);
  if (!options.yes) return;
  if (!storeExists) await saveProviderStore(options.storePath, newProviderStore());
  if (!secretsExist) await saveProviderSecrets(options.secretsPath, newProviderSecrets());
}

async function status(options) {
  const storeDetails = await pathState(options.storePath);
  const secretsDetails = await pathState(options.secretsPath);
  const stateDetails = await pathState(options.statePath);
  const store = storeDetails ? await loadProviderStore(options.storePath) : newProviderStore();
  const secrets = secretsDetails
    ? await loadProviderSecrets(options.secretsPath)
    : newProviderSecrets();
  const state = stateDetails
    ? await loadProviderState(options.statePath)
    : newProviderState();
  const references = collectSecretReferences(store);
  const missing = [...references.keys()].filter((name) => !secrets.secrets[name]).sort();
  const output = {
    schema: CURRENT_PROVIDER_SCHEMA,
    platform: normalizeRuntimePlatform(),
    store: options.storePath,
    store_exists: Boolean(storeDetails),
    secrets: options.secretsPath,
    secrets_exists: Boolean(secretsDetails),
    state: options.statePath,
    state_exists: Boolean(stateDetails),
    builtin_count: builtinProviderCatalog().length,
    profile_count: Object.keys(store.profiles).length,
    secret_count: Object.keys(secrets.secrets).length,
    referenced_secrets: [...references.keys()].sort(),
    missing_secrets: missing,
    current: structuredClone(state.current)
  };
  if (options.json) return process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Provider Store: ${output.store_exists ? output.store : "not initialized"}\n`);
  process.stdout.write(`Secret Store:   ${output.secrets_exists ? output.secrets : "not initialized"}\n`);
  process.stdout.write(`Platform:       ${output.platform}\n`);
  process.stdout.write(`Profiles:       ${output.builtin_count} built-in, ${output.profile_count} materialized/local\n`);
  process.stdout.write(`Secrets:        ${output.secret_count} present, ${missing.length} missing\n`);
  process.stdout.write(`Applied:        ${Object.keys(state.current).length} target(s)\n`);
  if (missing.length) process.stdout.write(`Missing refs:   ${missing.join(", ")}\n`);
}

async function migrateSchema(options) {
  const raw = await readJson(options.storePath, "provider Store");
  const fromSchema = raw?.schema;
  const legacyProfiles = raw?.profiles && typeof raw.profiles === "object"
    ? Object.values(raw.profiles).filter((profile) => profile?.schema === 1).length
    : 0;
  const missingContextProfiles = raw?.profiles && typeof raw.profiles === "object"
    ? Object.values(raw.profiles).filter((profile) => profile?.context === undefined).length
    : 0;
  const next = validateProviderStore(structuredClone(raw));
  let enrichedContextTargets = 0;
  for (const [name, profile] of Object.entries(next.profiles)) {
    const builtin = builtinProviderProfile(name);
    if (!builtin) continue;
    for (const target of PROVIDER_TARGETS) {
      const builtinResolved = resolveProviderProfile(builtin, {
        target,
        platform: normalizeRuntimePlatform()
      });
      if (raw.profiles?.[name]?.targets?.[target]?.context !== undefined) continue;
      const localResolved = resolveProviderProfile(profile, {
        target,
        platform: normalizeRuntimePlatform()
      });
      const modelContext = builtinModelContext(
        name,
        target,
        localResolved.outbound_model
      );
      if (!modelContext) continue;
      if (localResolved.protocol !== builtinResolved.protocol ||
          localResolved.endpoint !== builtinResolved.endpoint ||
          localResolved.auth.mode !== builtinResolved.auth.mode) continue;
      profile.targets[target] ||= {};
      profile.targets[target].context = modelContext;
      enrichedContextTargets += 1;
    }
  }
  validateProviderStore(next);
  const changed = fromSchema !== CURRENT_PROVIDER_SCHEMA || legacyProfiles > 0 ||
    missingContextProfiles > 0 || enrichedContextTargets > 0;
  const output = {
    ok: true,
    preview: !options.yes,
    changed,
    store: options.storePath,
    from_schema: fromSchema,
    to_schema: CURRENT_PROVIDER_SCHEMA,
    migrated_profiles: legacyProfiles,
    initialized_context_profiles: missingContextProfiles,
    enriched_context_targets: enrichedContextTargets,
    default_for_unverified_upstreams: "none/auto"
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`${options.yes ? "[apply]" : "[preview]"} migrate Provider Store schema\n`);
    process.stdout.write(`  Store:    ${options.storePath}\n`);
    process.stdout.write(`  Schema:   ${fromSchema} -> ${CURRENT_PROVIDER_SCHEMA}\n`);
    process.stdout.write(`  Profiles: ${legacyProfiles} legacy profile(s)\n`);
    process.stdout.write(`  Context:  ${missingContextProfiles} initialized profile(s), ${enrichedContextTargets} verified built-in target(s)\n`);
    process.stdout.write("  Safety:   unverified upstreams become none/auto (local compaction)\n");
    if (!options.yes && changed) process.stdout.write("Re-run with --yes to apply.\n");
  }
  if (options.yes && changed) await saveProviderStore(options.storePath, next);
  return output;
}

async function list(options) {
  if (!options.target || options.target === "all") {
    throw new ProviderClientError("provider list requires one --target");
  }
  const target = validateTarget(options.target);
  const platform = options.platform || normalizeRuntimePlatform();
  validatePlatform(platform);
  const [store, secrets, state, native] = await Promise.all([
    loadProviderStore(options.storePath, { allowMissing: true }),
    loadProviderSecrets(options.secretsPath, { allowMissing: true }),
    loadProviderState(options.statePath, { allowMissing: true }),
    nativeProviderState(target)
  ]);
  const builtins = builtinProviderCatalog();
  const builtinNames = new Set(builtins.map((entry) => entry.name));
  const candidates = [
    ...builtins.map((entry) => ({
      catalog: entry,
      profile: store.profiles[entry.name] || entry.profile,
      source: "builtin",
      materialized: Boolean(store.profiles[entry.name])
    })),
    ...Object.values(store.profiles)
      .filter((profile) => !builtinNames.has(profile.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((profile) => ({ catalog: null, profile, source: "local", materialized: true }))
  ];
  const rows = candidates.map(({ catalog, profile, source, materialized }) => {
    const resolved = resolveProviderProfile(profile, { target, platform });
    const secretPresent = resolved.auth.mode === "none" ||
      Boolean(secrets.secrets[resolved.auth.secret]);
    const plan = renderProviderPlan(resolved, { secretPresent });
    const nativeAuthProvider = catalog
      ? builtinNativeAuthProvider(profile.name, target)
      : "";
    const nativeAuth = nativeAuthProvider
      ? native.credentials.get(nativeAuthProvider) || null
      : null;
    const nativeSelected = Boolean(nativeAuth &&
      native.selected_provider === nativeAuthProvider);
    const status = !plan.enabled
      ? "disabled"
      : !plan.compatible ? "incompatible"
        : plan.auth.present ? "ready"
          : nativeSelected ? "native-current"
            : nativeAuth ? "native-auth" : "needs-key";
    return {
      name: profile.name,
      label: catalog?.label || profile.name,
      description: profile.description,
      source,
      materialized,
      target,
      platform,
      protocol: plan.protocol,
      endpoint: plan.endpoint,
      requested_model: plan.requested_model,
      outbound_model: plan.outbound_model,
      models_available: catalog ? builtinModels(profile.name, target) : [],
      enabled: plan.enabled,
      compatible: plan.compatible,
      ready: plan.ready,
      status,
      issue: plan.issue,
      auth_mode: plan.auth.mode,
      secret_reference: plan.auth.secret || "",
      secret_present: plan.auth.present,
      native_auth_present: Boolean(nativeAuth),
      native_auth_provider: nativeAuth?.provider || "",
      native_auth_type: nativeAuth?.type || "",
      native_selected: nativeSelected,
      native_selected_model: nativeSelected ? native.selected_model : "",
      compaction_upstream: plan.compaction.upstream,
      compaction_policy: plan.compaction.policy,
      compaction_mode: plan.compaction.mode,
      compaction_label: plan.compaction.label,
      context_window_tokens: plan.context.window_tokens,
      auto_compact_tokens: plan.context.auto_compact_tokens,
      context_label: plan.context.label,
      official_identity_policy: plan.official_identity?.policy || "",
      official_identity_account: plan.official_identity?.account || "",
      applied: matchesAppliedSelection(state.current[target], plan)
    };
  }).filter((row) => row.enabled);
  if (options.json) return process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  for (const row of rows) {
    const marker = row.source === "builtin" ? "B" : "L";
    const stateLabel = row.applied ? "current" : row.status;
    process.stdout.write(
      `${marker} ${row.name.padEnd(22)} ${stateLabel.padEnd(12)} ${row.protocol.padEnd(20)} ${row.outbound_model}\n`
    );
  }
}

async function show(name, options) {
  const profile = catalogProfileOrThrow(
    await loadProviderStore(options.storePath, { allowMissing: true }),
    name
  );
  process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
}

function parseAliases(values) {
  const aliases = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator < 1 || separator === value.length - 1) {
      throw new ProviderClientError("--alias must use requested=outbound");
    }
    const requested = value.slice(0, separator);
    const outbound = value.slice(separator + 1);
    validateModelId(requested, "alias requested model");
    validateModelId(outbound, "alias outbound model");
    if (aliases[requested] !== undefined) {
      throw new ProviderClientError(`duplicate model alias: ${requested}`);
    }
    aliases[requested] = outbound;
  }
  return aliases;
}

function parseContextTokenOption(value, label, validator) {
  if (value === undefined || value === null) return null;
  if (["auto", "none", "inherit"].includes(value)) return null;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ProviderClientError(`${label} must be a positive integer or auto`);
  }
  const tokens = Number(value);
  try {
    return validator(tokens, label);
  } catch (error) {
    if (error instanceof ProviderSchemaError) throw new ProviderClientError(error.message);
    throw error;
  }
}

function contextFromOptions(options, { defaults = true } = {}) {
  const context = {};
  if (defaults || options.contextWindowTokens !== undefined) {
    context.window_tokens = parseContextTokenOption(
      options.contextWindowTokens,
      "--context-window-tokens",
      validateContextWindowTokens
    );
  }
  if (defaults || options.autoCompactTokens !== undefined) {
    context.auto_compact_tokens = parseContextTokenOption(
      options.autoCompactTokens,
      "--auto-compact-tokens",
      validateAutoCompactTokens
    );
  }
  return context;
}

async function create(name, options) {
  validateProfileName(name);
  if (!options.protocol || !options.endpoint || !options.model) {
    throw new ProviderClientError(
      "create requires --protocol, --base-url, and --model"
    );
  }
  const mode = options.authMode || "bearer";
  validateProtocol(options.protocol);
  const endpoint = validateEndpoint(options.endpoint);
  validateModelId(options.model);
  validateAuthMode(mode);
  const compaction = {
    upstream: validateCompactionUpstream(options.compactionUpstream || "none"),
    policy: validateCompactionPolicy(options.compactionPolicy || "auto")
  };
  const context = contextFromOptions(options);
  if (mode !== "none" && !options.secret) {
    throw new ProviderClientError("create requires --secret unless --auth-mode none is used");
  }
  if (options.secret) validateReferenceName(options.secret, "Secret reference");
  const store = await loadProviderStore(options.storePath, { allowMissing: true });
  if (store.profiles[name]) throw new ProviderClientError(`provider profile already exists: ${name}`);
  const profile = {
    schema: CURRENT_PROVIDER_SCHEMA,
    name,
    description: options.description || "",
    protocol: options.protocol,
    endpoint,
    auth: mode === "none" ? { mode } : { mode, secret: options.secret },
    models: { default: options.model, aliases: parseAliases(options.aliases) },
    compaction,
    context,
    targets: {},
    platforms: {}
  };
  store.profiles[name] = profile;
  validateProviderStore(store);
  printMutation("create provider profile", {
    profile: name,
    protocol: profile.protocol,
    endpoint: profile.endpoint,
    model: profile.models.default,
    compaction: `${profile.compaction.upstream}/${profile.compaction.policy}`,
    context_window_tokens: profile.context.window_tokens ?? "auto",
    auto_compact_tokens: profile.context.auto_compact_tokens ?? "auto",
    secret: profile.auth.secret || "none"
  }, options);
  if (options.yes) await saveProviderStore(options.storePath, store);
}

function buildOverride(options) {
  const fields = [
    options.enabled !== undefined,
    options.protocol !== undefined,
    options.endpoint !== undefined,
    options.model !== undefined,
    options.authMode !== undefined,
    options.secret !== undefined,
    options.compactionUpstream !== undefined,
    options.compactionPolicy !== undefined,
    options.contextWindowTokens !== undefined,
    options.autoCompactTokens !== undefined
  ];
  if (options.inherit) {
    if (fields.some(Boolean)) {
      throw new ProviderClientError("--inherit cannot be combined with override fields");
    }
    return null;
  }
  const override = {};
  if (options.enabled !== undefined) override.enabled = options.enabled;
  if (options.protocol !== undefined) override.protocol = validateProtocol(options.protocol);
  if (options.endpoint !== undefined) override.endpoint = validateEndpoint(options.endpoint);
  if (options.model !== undefined) override.model = validateModelId(options.model);
  if (options.authMode !== undefined || options.secret !== undefined) {
    override.auth = {};
    if (options.authMode !== undefined) override.auth.mode = validateAuthMode(options.authMode);
    if (options.secret !== undefined) {
      override.auth.secret = validateReferenceName(options.secret, "Secret reference");
    }
  }
  if (options.compactionUpstream !== undefined || options.compactionPolicy !== undefined) {
    override.compaction = {};
    if (options.compactionUpstream !== undefined) {
      override.compaction.upstream = validateCompactionUpstream(options.compactionUpstream);
    }
    if (options.compactionPolicy !== undefined) {
      override.compaction.policy = validateCompactionPolicy(options.compactionPolicy);
    }
  }
  if (options.contextWindowTokens !== undefined || options.autoCompactTokens !== undefined) {
    override.context = contextFromOptions(options, { defaults: false });
  }
  if (!Object.keys(override).length) {
    throw new ProviderClientError("at least one override option or --inherit is required");
  }
  return override;
}

async function mutateTarget(name, target, platform, options) {
  validateTarget(target);
  if (platform) validatePlatform(platform);
  const store = await loadProviderStore(options.storePath);
  const profile = profileOrThrow(store, name);
  const override = buildOverride(options);
  if (platform) {
    if (override) {
      profile.platforms[platform] ||= { targets: {} };
      profile.platforms[platform].targets[target] = override;
    } else if (profile.platforms[platform]) {
      delete profile.platforms[platform].targets[target];
      if (!Object.keys(profile.platforms[platform].targets).length) {
        delete profile.platforms[platform];
      }
    }
  } else if (override) {
    profile.targets[target] = override;
  } else {
    delete profile.targets[target];
  }
  validateProviderStore(store);
  printMutation(platform ? "update platform target override" : "update target override", {
    profile: name,
    platform: platform || "all",
    target,
    result: override ? JSON.stringify(override) : "inherit"
  }, options);
  if (options.yes) await saveProviderStore(options.storePath, store);
}

async function resolveProfile(name, options) {
  if (!options.target) throw new ProviderClientError("resolve requires --target");
  const profile = catalogProfileOrThrow(
    await loadProviderStore(options.storePath, { allowMissing: true }),
    name
  );
  const resolvedProfile = resolveProviderProfile(profile, {
    target: options.target,
    platform: options.platform || normalizeRuntimePlatform()
  });
  process.stdout.write(`${JSON.stringify(resolvedProfile, null, 2)}\n`);
}

function requestedTargets(value) {
  if (!value) throw new ProviderClientError("--target is required");
  if (value === "all") return allProviderTargets();
  return [validateTarget(value)];
}

async function applicationPlans(name, options, {
  store = null,
  secrets = null
} = {}) {
  store ||= await loadProviderStore(options.storePath, { allowMissing: true });
  secrets ||= await loadProviderSecrets(options.secretsPath, { allowMissing: true });
  const profile = catalogProfileOrThrow(store, name);
  const platform = options.platform || normalizeRuntimePlatform();
  validatePlatform(platform);
  return requestedTargets(options.target).map((target) => {
    const resolved = resolveProviderProfile(profile, { target, platform });
    const secretPresent = resolved.auth.mode === "none" ||
      Boolean(secrets.secrets[resolved.auth.secret]);
    return renderProviderPlan(resolved, { secretPresent });
  });
}

function plansHaveErrors(plans) {
  return plans.some((plan) => plan.enabled && !plan.ready);
}

function emitApplicationPlans(name, plans, options, { preview = false } = {}) {
  const output = {
    schema: 1,
    profile: name,
    platform: plans[0]?.platform || options.platform || normalizeRuntimePlatform(),
    ready: !plansHaveErrors(plans),
    plans
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    for (const plan of plans) {
      process.stdout.write(`${plan.target_label} (${plan.target})\n`);
      process.stdout.write(`  State       : ${plan.enabled ? (plan.ready ? "ready" : "blocked") : "disabled"}\n`);
      process.stdout.write(`  Platform    : ${plan.platform}\n`);
      process.stdout.write(`  Protocol    : ${plan.protocol}\n`);
      process.stdout.write(`  Endpoint    : ${plan.endpoint}\n`);
      process.stdout.write(`  Model       : ${plan.requested_model} -> ${plan.outbound_model}\n`);
      process.stdout.write(`  Compaction  : ${plan.compaction.label} (${plan.compaction.upstream}; ${plan.compaction.policy})\n`);
      process.stdout.write(`  Context     : ${plan.context.label}\n`);
      process.stdout.write(`  Secret      : ${plan.auth.secret || "none"} (${plan.auth.present ? "ready" : "missing"})\n`);
      if (plan.official_identity) {
        process.stdout.write("  Identity    : preserve current ChatGPT login (not managed by this Provider)\n");
      }
      process.stdout.write(`  Config      : ${plan.config_files.join(", ")}\n`);
      if (plan.issue) process.stdout.write(`  Blocked by  : ${plan.issue}\n`);
    }
    if (preview && output.ready) {
      process.stdout.write("[preview] no client files were changed; re-run with --yes to apply.\n");
    }
  }
  return output;
}

async function planApplication(name, options) {
  const plans = await applicationPlans(name, options);
  const output = emitApplicationPlans(name, plans, options);
  if (!output.ready) process.exitCode = 1;
  return output;
}

async function snapshotManagedFiles(paths) {
  const snapshots = new Map();
  for (const path of [...new Set(paths)]) {
    const details = await pathState(path);
    if (!details) {
      snapshots.set(path, { existed: false });
      continue;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ProviderClientError(`refusing to update non-regular managed path: ${path}`);
    }
    if (details.size > MAX_STORE_BYTES) {
      throw new ProviderClientError(`managed provider file is unexpectedly large: ${path}`);
    }
    snapshots.set(path, {
      existed: true,
      bytes: await readFile(path),
      mode: details.mode & 0o777
    });
  }
  return snapshots;
}

async function restoreManagedFiles(snapshots) {
  const errors = [];
  for (const [path, snapshot] of [...snapshots.entries()].reverse()) {
    try {
      if (snapshot.existed) {
        await writeBytesAtomic(path, snapshot.bytes, snapshot.mode || 0o600);
      } else {
        const details = await pathState(path);
        if (details?.isSymbolicLink() || (details && !details.isFile())) {
          throw new Error("new managed path is no longer a regular file");
        }
        if (details) await unlink(path);
      }
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
    }
  }
  if (errors.length) {
    throw new ProviderClientError(`provider rollback was incomplete: ${errors.join("; ")}`);
  }
}

async function assertProtectedFilesUnchanged(snapshots) {
  for (const [path, snapshot] of snapshots) {
    const details = await pathState(path);
    if (!snapshot.existed) {
      if (details) {
        throw new ProviderClientError(`Provider backend modified protected Identity file: ${path}`);
      }
      continue;
    }
    if (!details || details.isSymbolicLink() || !details.isFile() ||
        (details.mode & 0o777) !== snapshot.mode ||
        !(await readFile(path)).equals(snapshot.bytes)) {
      throw new ProviderClientError(`Provider backend modified protected Identity file: ${path}`);
    }
  }
}

async function assertBackend(plan) {
  const details = await pathState(plan.backend);
  if (!details || details.isSymbolicLink() || !details.isFile()) {
    throw new ProviderClientError(`provider setup backend is missing: ${plan.backend}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o111) === 0) {
    throw new ProviderClientError(`provider setup backend is not executable: ${plan.backend}`);
  }
}

function appliedRecord(plan) {
  return {
    target: plan.target,
    profile: plan.profile,
    platform: plan.platform,
    protocol: plan.protocol,
    endpoint: plan.endpoint,
    requested_model: plan.requested_model,
    outbound_model: plan.outbound_model,
    provider_name: plan.provider_name,
    compaction_upstream: plan.compaction.upstream,
    compaction_policy: plan.compaction.policy,
    compaction_mode: plan.compaction.mode,
    context_window_tokens: plan.context.window_tokens,
    auto_compact_tokens: plan.context.auto_compact_tokens,
    ...(plan.official_identity ? {
      official_identity_policy: plan.official_identity.policy
    } : {}),
    applied_at: new Date().toISOString()
  };
}

function validationUrlForPlan(plan, profile) {
  if (!isBuiltinProvider(profile.name)) return "";
  const builtin = builtinProviderProfile(profile.name);
  const expected = resolveProviderProfile(builtin, {
    target: plan.target,
    platform: plan.platform
  });
  if (expected.protocol !== plan.protocol || expected.endpoint !== plan.endpoint ||
      expected.auth.mode !== plan.auth.mode) return "";
  return builtinValidationUrl(profile.name, plan.target);
}

async function applyApplication(name, options, prepared = {}) {
  const store = prepared.store || await loadProviderStore(options.storePath);
  const secrets = prepared.secrets ||
    await loadProviderSecrets(options.secretsPath, { allowMissing: true });
  const plans = prepared.plans || await applicationPlans(name, options, { store, secrets });
  const selectedProfile = catalogProfileOrThrow(store, name);
  const preview = prepared.suppressPlan
    ? {
      schema: 1,
      profile: name,
      platform: plans[0]?.platform || options.platform || normalizeRuntimePlatform(),
      ready: !plansHaveErrors(plans),
      plans
    }
    : options.json && options.yes && !plansHaveErrors(plans)
    ? {
      schema: 1,
      profile: name,
      platform: plans[0]?.platform || options.platform || normalizeRuntimePlatform(),
      ready: true,
      plans
    }
    : emitApplicationPlans(name, plans, options, { preview: !options.yes });
  if (!preview.ready) {
    throw new ProviderClientError("provider plan is blocked; resolve the reported issues before apply");
  }
  if (!options.yes) return preview;
  assertApplyPlatform(plans[0]?.platform || options.platform || normalizeRuntimePlatform());
  const activePlans = plans.filter((plan) => plan.enabled);
  if (!activePlans.length) throw new ProviderClientError("the selected profile disables every requested target");
  for (const plan of activePlans) await assertBackend(plan);

  const managedPaths = [options.statePath];
  for (const plan of activePlans) {
    managedPaths.push(...await managedTargetPaths(plan.target));
  }
  const protectedPaths = activePlans
    .map((plan) => plan.official_identity?.config_file || "")
    .filter(Boolean);
  const snapshots = await snapshotManagedFiles([...managedPaths, ...protectedPaths]);
  const protectedSnapshots = new Map(
    protectedPaths.map((path) => [path, snapshots.get(path)])
  );
  const state = await loadProviderState(options.statePath, { allowMissing: true });
  const secretDirectory = await mkdtemp(join(tmpdir(), "agentctl-provider-"));
  const applied = [];
  try {
    for (const plan of activePlans) {
      const secretValue = plan.auth.mode === "none"
        ? "agentctl-loopback-no-auth"
        : secrets.secrets[plan.auth.secret]?.value;
      if (!secretValue) {
        throw new ProviderClientError(`local Secret '${plan.auth.secret}' is missing`);
      }
      const keyFile = join(secretDirectory, `${plan.target}.key`);
      await writeFile(keyFile, `${secretValue}\n`, { flag: "wx", mode: 0o600 });
      await chmod(keyFile, 0o600);
      const modelsUrl = validationUrlForPlan(plan, selectedProfile);
      const args = backendArguments(plan, {
        keyFile,
        modelsUrl,
        skipValidate: options.skipValidate || !modelsUrl,
        force: options.force,
        forceContext: options.contextForce ?? options.force
      });
      const command = bashScriptCommand(plan.backend, args);
      const result = spawnSync(command.executable, command.args, {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENTCTL_SETUP_COMMAND: `agentctl provider use ${name} --target ${plan.target}`,
          AGENTCTL_UNINSTALL_COMMAND: `agentctl uninstall ${plan.target}`
        },
        stdio: options.json ? "pipe" : "inherit"
      });
      if (result.error || result.status !== 0) {
        throw new ProviderClientError(
          `${plan.target_label} provider backend failed; previous managed files will be restored`
        );
      }
      if (plan.official_identity) await assertProtectedFilesUnchanged(protectedSnapshots);
      state.current[plan.target] = appliedRecord(plan);
      applied.push(plan.target);
    }
    await saveProviderState(options.statePath, state);
  } catch (error) {
    let rollbackError;
    try {
      await restoreManagedFiles(snapshots);
    } catch (failure) {
      rollbackError = failure;
    }
    if (rollbackError) {
      throw new ProviderClientError(`${error.message}; ${rollbackError.message}`);
    }
    throw error;
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
  const output = {
    ok: true,
    profile: name,
    platform: plans[0].platform,
    applied,
    official_identity: applied.includes("codex")
      ? { policy: "preserve", account: "current" }
      : null,
    restart_required: true
  };
  if (!prepared.suppressResult) {
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`Applied '${name}' to ${applied.join(", ")}. Start new agent sessions to use it.\n`);
  }
  return output;
}

function profileForUse(profile, options) {
  const next = structuredClone(profile);
  const contextSpecified = options.contextWindowTokens !== undefined ||
    options.autoCompactTokens !== undefined;
  if (options.model !== undefined || contextSpecified) {
    if (!options.target || options.target === "all") {
      throw new ProviderClientError(
        "--model and context options require one concrete --target"
      );
    }
    const target = validateTarget(options.target);
    const before = resolveProviderProfile(next, {
      target,
      platform: options.platform || normalizeRuntimePlatform()
    });
    next.targets[target] = {
      ...(next.targets[target] || {})
    };
    if (options.model !== undefined) {
      validateModelId(options.model);
      next.targets[target].model = options.model;
      if (options.model !== before.model) {
        const afterModel = resolveProviderProfile(next, {
          target,
          platform: options.platform || normalizeRuntimePlatform()
        });
        next.targets[target].context = builtinModelContext(
          next.name,
          target,
          afterModel.outbound_model
        ) || {
          window_tokens: null,
          auto_compact_tokens: null
        };
      }
    }
    if (contextSpecified) {
      next.targets[target].context = {
        ...(next.targets[target].context || {}),
        ...contextFromOptions(options, { defaults: false })
      };
    }
  }
  validateProviderStore({
    ...newProviderStore(),
    profiles: { [next.name]: next }
  });
  return next;
}

async function useProvider(name, options) {
  requestedTargets(options.target);
  validateProfileName(name);
  const [store, secrets] = await Promise.all([
    loadProviderStore(options.storePath, { allowMissing: true }),
    loadProviderSecrets(options.secretsPath, { allowMissing: true })
  ]);
  const existing = store.profiles[name];
  const builtin = builtinProvider(name);
  if (!existing && !builtin) throw new ProviderClientError(`provider profile not found: ${name}`);
  const selected = profileForUse(existing || builtin.profile, options);
  const nextStore = structuredClone(store);
  nextStore.profiles[name] = selected;
  validateProviderStore(nextStore);
  const nextSecrets = structuredClone(secrets);
  const platform = options.platform || normalizeRuntimePlatform();
  const references = new Set(requestedTargets(options.target).map((target) => {
    const resolved = resolveProviderProfile(selected, { target, platform });
    return resolved.auth.mode === "none" ? "" : resolved.auth.secret;
  }).filter(Boolean));
  if (options.secretFile) {
    if (references.size !== 1) {
      throw new ProviderClientError(
        "--secret-file requires the selected targets to share one Secret reference"
      );
    }
    const reference = [...references][0];
    nextSecrets.secrets[reference] = {
      value: await readPrivateSecret(options.secretFile),
      updated_at: new Date().toISOString()
    };
  }
  validateProviderSecrets(nextSecrets);
  const plans = await applicationPlans(name, options, {
    store: nextStore,
    secrets: nextSecrets
  });
  if (!options.yes) {
    return applyApplication(name, options, {
      store: nextStore,
      secrets: nextSecrets,
      plans
    });
  }
  const portableSnapshots = await snapshotManagedFiles([
    options.storePath,
    options.secretsPath
  ]);
  try {
    await saveProviderStore(options.storePath, nextStore);
    await saveProviderSecrets(options.secretsPath, nextSecrets);
    return await applyApplication(name, {
      ...options,
      force: true,
      contextForce: options.force
    }, {
      store: nextStore,
      secrets: nextSecrets,
      plans
    });
  } catch (error) {
    try {
      await restoreManagedFiles(portableSnapshots);
    } catch (rollback) {
      throw new ProviderClientError(
        `${error.message}; Provider catalog rollback failed: ${rollback.message}`
      );
    }
    throw error;
  }
}

async function current(options) {
  const state = await loadProviderState(options.statePath, { allowMissing: true });
  let selected = state.current;
  if (options.target && options.target !== "all") {
    validateTarget(options.target);
    selected = state.current[options.target]
      ? { [options.target]: state.current[options.target] }
      : {};
  }
  const output = {
    schema: 1,
    state: options.statePath,
    current: selected
  };
  if (options.json) return process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!Object.keys(selected).length) return process.stdout.write("(no applied provider profiles)\n");
  for (const [target, record] of Object.entries(selected)) {
    process.stdout.write(
      `${target.padEnd(10)} ${record.profile.padEnd(24)} ${record.outbound_model} (${record.platform})\n`
    );
  }
}

async function deleteProfile(name, options) {
  const store = await loadProviderStore(options.storePath);
  profileOrThrow(store, name);
  delete store.profiles[name];
  printMutation("delete provider profile", {
    profile: name,
    note: "Secret values are preserved because they may be shared"
  }, options);
  if (options.yes) await saveProviderStore(options.storePath, store);
}

async function readPrivateSecret(path) {
  const details = await pathState(path);
  if (!details || details.isSymbolicLink() || !details.isFile()) {
    throw new ProviderClientError(`Secret input must be a regular, non-symlink file: ${path}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ProviderClientError(`Secret input must be owner-only (chmod 600): ${path}`);
  }
  if (details.size > 16385) throw new ProviderClientError("Secret input is too large");
  const text = await readFile(path, "utf8");
  if (text.includes("\r")) throw new ProviderClientError("Secret input must not contain carriage returns");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 1 || lines[0].length === 0) {
    throw new ProviderClientError("Secret input must contain exactly one non-empty line");
  }
  return lines[0];
}

function ccsSlug(value, fallback) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function safeCcsLabel(value) {
  return String(value || "CCS Provider")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 120) || "CCS Provider";
}

function tomlString(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderClientError("CCS Codex config contains an unsupported quoted value");
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

function ccsCodexToml(text) {
  if (typeof text !== "string" || text.length > MAX_STORE_BYTES) {
    throw new ProviderClientError("CCS Codex config is missing or unexpectedly large");
  }
  let section = "";
  const top = {};
  const providers = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    if (!section && ["model", "model_provider"].includes(key)) {
      top[key] = tomlString(rawValue);
      continue;
    }
    const provider = /^model_providers\.([A-Za-z0-9_-]+)$/.exec(section);
    if (provider && ["base_url", "wire_api"].includes(key)) {
      providers[provider[1]] ||= {};
      providers[provider[1]][key] = tomlString(rawValue);
    }
  }
  const selected = providers[top.model_provider] || Object.values(providers)[0] || {};
  return {
    model: top.model || "",
    provider: top.model_provider || "",
    endpoint: selected.base_url || "",
    wireApi: selected.wire_api || ""
  };
}

function importedCcsProfile(row, index) {
  if (typeof row.settings_config !== "string" || row.settings_config.length > MAX_STORE_BYTES) {
    throw new ProviderClientError(`CCS Provider '${safeCcsLabel(row.name)}' has invalid settings`);
  }
  let settings;
  try {
    settings = JSON.parse(row.settings_config);
  } catch {
    throw new ProviderClientError(`CCS Provider '${safeCcsLabel(row.name)}' has invalid JSON`);
  }
  const label = safeCcsLabel(row.name);
  if (row.app_type === "claude") {
    const environment = settings?.env && typeof settings.env === "object"
      ? settings.env
      : {};
    const endpointValue = environment.ANTHROPIC_BASE_URL;
    const token = environment.ANTHROPIC_AUTH_TOKEN || environment.ANTHROPIC_API_KEY;
    if (!endpointValue || !token || environment.CLAUDE_CODE_OAUTH_TOKEN ||
        /official/i.test(label)) {
      return { skipped: true, reason: "official Identity or no portable API endpoint", label };
    }
    const endpoint = validateEndpoint(endpointValue, `CCS Provider '${label}' endpoint`);
    const model = validateModelId(
      environment.ANTHROPIC_MODEL || environment.ANTHROPIC_DEFAULT_SONNET_MODEL ||
      environment.ANTHROPIC_DEFAULT_OPUS_MODEL || environment.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      `CCS Provider '${label}' model`
    );
    let name = ccsSlug(label, `ccs-claude-${index + 1}`);
    if (endpoint === "https://api.deepseek.com/anthropic") name = "deepseek";
    if (endpoint === "https://api.minimaxi.com/anthropic") name = "minimax-cn";
    if (endpoint === "https://api.minimax.io/anthropic") name = "minimax-global";
    let imported;
    if (isBuiltinProvider(name)) {
      imported = builtinProviderProfile(name);
      imported.targets.claude = { ...(imported.targets.claude || {}), model };
    } else {
      const reference = `${name.replaceAll("-", "_")}_claude_key`;
      imported = {
        schema: CURRENT_PROVIDER_SCHEMA,
        name,
        description: `Imported from CCS: ${label}`,
        protocol: "anthropic_messages",
        endpoint,
        auth: {
          mode: environment.ANTHROPIC_API_KEY ? "x-api-key" : "bearer",
          secret: reference
        },
        models: { default: model, aliases: {} },
        compaction: { upstream: "none", policy: "auto" },
        targets: {
          codex: { enabled: false },
          opencode: { enabled: false },
          pi: { enabled: false }
        },
        platforms: {}
      };
    }
    validateProviderStore({ ...newProviderStore(), profiles: { [name]: imported } });
    const resolved = resolveProviderProfile(imported, {
      target: "claude",
      platform: normalizeRuntimePlatform()
    });
    return {
      profile: imported,
      secret: token,
      secretReference: resolved.auth.secret,
      target: "claude",
      label,
      endpoint: resolved.endpoint,
      model: resolved.outbound_model,
      current: Boolean(row.is_current)
    };
  }
  if (row.app_type === "codex") {
    const auth = settings?.auth && typeof settings.auth === "object" ? settings.auth : {};
    const parsed = ccsCodexToml(settings?.config || "");
    const token = auth.OPENAI_API_KEY;
    if (!parsed.endpoint || !token || /official/i.test(label) ||
        auth.auth_mode === "chatgpt") {
      return { skipped: true, reason: "official Identity or no portable API endpoint", label };
    }
    if (parsed.wireApi && parsed.wireApi !== "responses") {
      return { skipped: true, reason: `unsupported Codex wire API '${parsed.wireApi}'`, label };
    }
    const endpoint = validateEndpoint(parsed.endpoint, `CCS Provider '${label}' endpoint`);
    const model = validateModelId(parsed.model, `CCS Provider '${label}' model`);
    let name = ccsSlug(label, `ccs-codex-${index + 1}`);
    if (isBuiltinProvider(name) || name === "minimax") name = `${name}-codex`;
    const reference = `${name.replaceAll("-", "_")}_codex_key`;
    const imported = {
      schema: CURRENT_PROVIDER_SCHEMA,
      name,
      description: `Imported from CCS: ${label}`,
      protocol: "openai_responses",
      endpoint,
      auth: { mode: "bearer", secret: reference },
      models: { default: model, aliases: {} },
      compaction: { upstream: "none", policy: "auto" },
      targets: {
        claude: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false }
      },
      platforms: {}
    };
    validateProviderStore({ ...newProviderStore(), profiles: { [name]: imported } });
    return {
      profile: imported,
      secret: token,
      secretReference: reference,
      target: "codex",
      label,
      endpoint,
      model,
      current: Boolean(row.is_current)
    };
  }
  return { skipped: true, reason: "unsupported CCS client", label };
}

async function migrateCcs(options) {
  const databasePath = options.database || join(homedir(), ".cc-switch", "cc-switch.db");
  const details = await pathState(databasePath);
  if (!details || details.isSymbolicLink() || !details.isFile()) {
    throw new ProviderClientError(`CCS database must be a regular, non-symlink file: ${databasePath}`);
  }
  if (details.size > 1024 * 1024 * 1024) {
    throw new ProviderClientError("CCS database is unexpectedly large");
  }
  const requested = options.target || "all";
  if (!["claude", "codex", "all"].includes(requested)) {
    throw new ProviderClientError("CCS migration --target must be claude, codex, or all");
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new ProviderClientError("CCS migration requires Node.js with node:sqlite support");
  }
  let database;
  let rows;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    rows = database.prepare(
      "SELECT app_type, name, settings_config, is_current " +
      "FROM providers WHERE app_type IN ('claude', 'codex') ORDER BY app_type, sort_index, name"
    ).all();
  } catch {
    throw new ProviderClientError("CCS database could not be read as a supported Provider catalog");
  } finally {
    database?.close();
  }
  const selectedRows = rows.filter((row) => requested === "all" || row.app_type === requested);
  const imported = [];
  const skipped = [];
  for (const [index, row] of selectedRows.entries()) {
    const item = importedCcsProfile(row, index);
    if (item.skipped) skipped.push({
      client: row.app_type,
      name: item.label,
      reason: item.reason
    });
    else imported.push(item);
  }
  const [store, secrets] = await Promise.all([
    loadProviderStore(options.storePath, { allowMissing: true }),
    loadProviderSecrets(options.secretsPath, { allowMissing: true })
  ]);
  const nextStore = structuredClone(store);
  const nextSecrets = structuredClone(secrets);
  for (const item of imported) {
    const name = item.profile.name;
    if (nextStore.profiles[name] && !options.force &&
        JSON.stringify(nextStore.profiles[name]) !== JSON.stringify(item.profile)) {
      throw new ProviderClientError(
        `CCS migration conflicts with local profile '${name}'; use --force to replace it`
      );
    }
    const previousSecret = nextSecrets.secrets[item.secretReference]?.value;
    if (previousSecret && previousSecret !== item.secret && !options.force) {
      throw new ProviderClientError(
        `CCS migration conflicts with local Secret '${item.secretReference}'; use --force to replace it`
      );
    }
    nextStore.profiles[name] = item.profile;
    nextSecrets.secrets[item.secretReference] = {
      value: item.secret,
      updated_at: new Date().toISOString()
    };
  }
  validateProviderStore(nextStore);
  validateProviderSecrets(nextSecrets);
  const output = {
    ok: true,
    preview: !options.yes,
    source: databasePath,
    imported: imported.map((item) => ({
      client: item.target,
      source_name: item.label,
      profile: item.profile.name,
      endpoint: item.endpoint,
      model: item.model,
      secret: "present (value hidden)",
      was_current_in_ccs: item.current
    })),
    skipped,
    secret_values: "hidden"
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`${options.yes ? "[apply]" : "[preview]"} migrate CCS Providers\n`);
    for (const item of output.imported) {
      process.stdout.write(
        `  ${item.client.padEnd(6)} ${item.profile.padEnd(24)} ${item.model}` +
        `${item.was_current_in_ccs ? "  (CCS current)" : ""}\n`
      );
    }
    for (const item of skipped) {
      process.stdout.write(`  skip   ${item.client}/${item.name}: ${item.reason}\n`);
    }
    process.stdout.write("  Secret values: imported into the owner-only Store and never printed\n");
    if (!options.yes) process.stdout.write("Re-run with --yes to apply.\n");
  }
  if (!options.yes) return output;
  const snapshots = await snapshotManagedFiles([options.storePath, options.secretsPath]);
  try {
    await saveProviderStore(options.storePath, nextStore);
    await saveProviderSecrets(options.secretsPath, nextSecrets);
  } catch (error) {
    try {
      await restoreManagedFiles(snapshots);
    } catch (rollback) {
      throw new ProviderClientError(`${error.message}; CCS migration rollback failed: ${rollback.message}`);
    }
    throw error;
  }
  return output;
}

async function secretCommand(positional, options) {
  const action = positional.shift();
  if (!action) throw new ProviderClientError("secret requires list, status, set, or delete");
  const store = await loadProviderStore(options.storePath, { allowMissing: true });
  const secrets = await loadProviderSecrets(options.secretsPath, { allowMissing: true });
  const references = collectSecretReferences(store);
  if (action === "list" && positional.length === 0) {
    const names = [...new Set([...references.keys(), ...Object.keys(secrets.secrets)])].sort();
    const output = names.map((name) => ({
      name,
      present: Boolean(secrets.secrets[name]),
      referenced_by: references.get(name) || []
    }));
    if (options.json) return process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (!output.length) return process.stdout.write("(no provider Secrets)\n");
    for (const item of output) {
      process.stdout.write(
        `${item.name.padEnd(28)} ${item.present ? "present" : "missing"}` +
        `${item.referenced_by.length ? `  ${item.referenced_by.join(", ")}` : "  unreferenced"}\n`
      );
    }
    return;
  }
  const name = positional.shift();
  if (!name || positional.length) throw new ProviderClientError(`secret ${action} requires one name`);
  validateReferenceName(name, "Secret name");
  if (action === "status") {
    const output = {
      name,
      present: Boolean(secrets.secrets[name]),
      referenced_by: references.get(name) || []
    };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`${name}: ${output.present ? "present" : "missing"}; references: ${output.referenced_by.join(", ") || "none"}\n`);
    return;
  }
  if (action === "set") {
    if (!options.secretFile) throw new ProviderClientError("secret set requires --secret-file");
    printMutation("set provider Secret", {
      secret: name,
      source: options.secretFile,
      destination: options.secretsPath,
      value: "redacted"
    }, options);
    if (!options.yes) return;
    const value = await readPrivateSecret(options.secretFile);
    secrets.secrets[name] = { value, updated_at: new Date().toISOString() };
    await saveProviderSecrets(options.secretsPath, secrets);
    return;
  }
  if (action === "delete") {
    if (!secrets.secrets[name]) throw new ProviderClientError(`provider Secret not found: ${name}`);
    printMutation("delete provider Secret", {
      secret: name,
      referenced_by: (references.get(name) || []).join(", ") || "none"
    }, options);
    if (options.yes) {
      delete secrets.secrets[name];
      await saveProviderSecrets(options.secretsPath, secrets);
    }
    return;
  }
  throw new ProviderClientError(`unknown secret action '${action}'`);
}

async function exportStore(options) {
  if (!options.output) throw new ProviderClientError("export requires --output");
  const store = await loadProviderStore(options.storePath);
  const existing = await pathState(options.output);
  if (existing && !options.force) {
    throw new ProviderClientError(`export destination exists (use --force): ${options.output}`);
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ProviderClientError(`export destination must be a regular file: ${options.output}`);
  }
  printMutation("export portable provider Store", {
    source: options.storePath,
    destination: options.output,
    profiles: Object.keys(store.profiles).length,
    secret_values: "excluded"
  }, options);
  if (options.yes) await writeJsonAtomic(options.output, store);
}

function importedStore(current, incoming, replace) {
  let next;
  if (replace) {
    next = structuredClone(incoming);
    next.created_at = current.created_at;
  } else {
    next = structuredClone(current);
    for (const [name, profile] of Object.entries(incoming.profiles)) {
      if (next.profiles[name] &&
          JSON.stringify(next.profiles[name]) !== JSON.stringify(profile)) {
        throw new ProviderClientError(
          `import conflicts with profile '${name}'; use --replace to replace the catalog`
        );
      }
      next.profiles[name] = structuredClone(profile);
    }
  }
  return validateProviderStore(next);
}

async function importStore(options) {
  if (!options.input) throw new ProviderClientError("import requires --input");
  const incoming = validateProviderStore(await readJson(options.input, "provider import"));
  const current = await loadProviderStore(options.storePath, { allowMissing: true });
  const next = importedStore(current, incoming, options.replace);
  printMutation(options.replace ? "replace provider Store from import" : "merge provider Store import", {
    source: options.input,
    destination: options.storePath,
    profiles: Object.keys(next.profiles).length,
    secret_values: "not present in portable imports"
  }, options);
  if (options.yes) await saveProviderStore(options.storePath, next);
}

async function restorePortable(name, options) {
  validateProfileName(name);
  if (!options.input) throw new ProviderClientError("restore requires --input");
  const incoming = validateProviderStore(await readJson(options.input, "provider restore input"));
  const currentStore = await loadProviderStore(options.storePath, { allowMissing: true });
  const nextStore = importedStore(currentStore, incoming, options.replace);
  profileOrThrow(nextStore, name);
  const secrets = await loadProviderSecrets(options.secretsPath, { allowMissing: true });
  const plans = await applicationPlans(name, options, { store: nextStore, secrets });

  if (!options.json) {
    process.stdout.write(
      `${options.yes ? "[apply]" : "[preview]"} restore portable provider Store from ${options.input}\n`
    );
    process.stdout.write("  Secret values: use the local encrypted/owner-only Secret Store\n");
  }
  const preview = options.json && options.yes && !plansHaveErrors(plans)
    ? {
      schema: 1,
      profile: name,
      platform: plans[0]?.platform || options.platform || normalizeRuntimePlatform(),
      ready: true,
      plans
    }
    : emitApplicationPlans(name, plans, options, { preview: !options.yes });
  if (!preview.ready) {
    throw new ProviderClientError("provider restore is blocked; restore the reported Secrets or fix the profile first");
  }
  if (!options.yes) return preview;
  assertApplyPlatform(plans[0]?.platform || options.platform || normalizeRuntimePlatform());
  const catalogSnapshot = await snapshotManagedFiles([options.storePath]);
  let applied;
  try {
    await saveProviderStore(options.storePath, nextStore);
    applied = await applyApplication(name, options, {
      store: nextStore,
      secrets,
      plans,
      suppressPlan: true,
      suppressResult: true
    });
  } catch (error) {
    try {
      await restoreManagedFiles(catalogSnapshot);
    } catch (rollback) {
      throw new ProviderClientError(`${error.message}; catalog rollback failed: ${rollback.message}`);
    }
    throw error;
  }
  const output = {
    ...applied,
    restored_from: options.input,
    catalog_mode: options.replace ? "replace" : "merge",
    secret_values: "local Secret Store"
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(
    `Restored and applied '${name}' to ${output.applied.join(", ")}; start new agent sessions to use it.\n`
  );
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArguments(argv);
  if (options.help || positional.length === 0) return usage();
  const action = positional.shift();
  if (action === "init" && positional.length === 0) return init(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "list" && positional.length === 0) return list(options);
  if (action === "show" && positional.length === 1) return show(positional[0], options);
  if (action === "resolve" && positional.length === 1) return resolveProfile(positional[0], options);
  if (action === "plan" && positional.length === 1) return planApplication(positional[0], options);
  if (action === "apply" && positional.length === 1) return applyApplication(positional[0], options);
  if (action === "use" && positional.length === 1) return useProvider(positional[0], options);
  if (action === "current" && positional.length === 0) return current(options);
  if (action === "migrate" && positional.length === 1 && positional[0] === "ccs") {
    return migrateCcs(options);
  }
  if (action === "migrate" && positional.length === 1 && positional[0] === "schema") {
    return migrateSchema(options);
  }
  if (action === "create" && positional.length === 1) return create(positional[0], options);
  if (action === "target" && positional.length === 2) {
    return mutateTarget(positional[0], positional[1], "", options);
  }
  if (action === "platform" && positional.length === 3) {
    return mutateTarget(positional[0], positional[2], positional[1], options);
  }
  if (action === "delete" && positional.length === 1) return deleteProfile(positional[0], options);
  if (action === "secret") return secretCommand(positional, options);
  if (action === "export" && positional.length === 0) return exportStore(options);
  if (action === "import" && positional.length === 0) return importStore(options);
  if (action === "restore" && positional.length === 1) return restorePortable(positional[0], options);
  throw new ProviderClientError("invalid provider command; use agentctl provider --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof ProviderClientError ||
      error instanceof ProviderSchemaError || error instanceof ProviderRendererError
      ? error.message
      : "unexpected provider Store failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}
