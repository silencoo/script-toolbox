#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CURRENT_PROVIDER_SCHEMA,
  PROVIDER_AUTH_MODES,
  PROVIDER_PLATFORMS,
  PROVIDER_PROTOCOLS,
  PROVIDER_TARGETS,
  ProviderSchemaError,
  newProviderSecrets,
  newProviderStore,
  normalizeRuntimePlatform,
  resolveProviderProfile,
  validateAuthMode,
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

const MAX_STORE_BYTES = 5 * 1024 * 1024;

export class ProviderClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl provider — portable provider profiles and local Secrets

Usage:
  agentctl provider init [--yes]
  agentctl provider status [--json]
  agentctl provider list [--json]
  agentctl provider show <profile> [--json]
  agentctl provider resolve <profile> --target <target> [--platform <platform>] [--json]
  agentctl provider create <profile> --protocol <protocol> --base-url <url>
      --model <id> [--auth-mode <mode>] [--secret <reference>]
      [--description <text>] [--alias <requested=outbound>]... [--yes]
  agentctl provider target <profile> <target> [override options] [--yes]
  agentctl provider platform <profile> <platform> <target> [override options] [--yes]
  agentctl provider delete <profile> [--yes]
  agentctl provider secret <list|status> [name] [--json]
  agentctl provider secret set <name> --secret-file <private-file> [--yes]
  agentctl provider secret delete <name> [--yes]
  agentctl provider export --output <file> [--force] [--yes]
  agentctl provider import --input <file> [--replace] [--yes]

Protocols:
  ${PROVIDER_PROTOCOLS.join(", ")}

Authentication modes:
  ${PROVIDER_AUTH_MODES.join(", ")}

Targets:   ${PROVIDER_TARGETS.join(", ")}
Platforms: ${PROVIDER_PLATFORMS.join(", ")}

Override options:
  --enable | --disable       Override target availability.
  --protocol <protocol>      Override the provider protocol.
  --base-url <url>           Override the provider endpoint.
  --model <id>               Override the requested/default model.
  --auth-mode <mode>         Override the authentication mode.
  --secret <reference>       Override the local Secret reference.
  --inherit                  Remove the entire target/platform override.

Storage options:
  --store <file>             Portable catalog (default: platform config dir).
  --secrets <file>           Local chmod-600 Secret Store.
  --yes, -y                  Apply the displayed mutation; otherwise preview.

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
  let configHome;
  if (platform === "win32") {
    configHome = environment.APPDATA || join(home, "AppData", "Roaming");
  } else {
    configHome = environment.XDG_CONFIG_HOME || join(home, ".config");
  }
  const root = join(configHome, "agentctl");
  return {
    storePath: environment.AGENTCTL_PROVIDER_STORE || join(root, "providers.json"),
    secretsPath: environment.AGENTCTL_PROVIDER_SECRETS ||
      join(root, "provider-secrets.json")
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
    platform: undefined
  };
  const positional = [];
  argv = [...argv];
  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--store": options.storePath = takeValue(argv, argument); break;
      case "--secrets": options.secretsPath = takeValue(argv, argument); break;
      case "--description": options.description = takeValue(argv, argument); break;
      case "--protocol": options.protocol = takeValue(argv, argument); break;
      case "--base-url":
      case "--endpoint": options.endpoint = takeValue(argv, argument); break;
      case "--model": options.model = takeValue(argv, argument); break;
      case "--auth-mode": options.authMode = takeValue(argv, argument); break;
      case "--secret": options.secret = takeValue(argv, argument); break;
      case "--secret-file": options.secretFile = takeValue(argv, argument); break;
      case "--platform": options.platform = takeValue(argv, argument); break;
      case "--target": options.target = takeValue(argv, argument); break;
      case "--alias": options.aliases.push(takeValue(argv, argument)); break;
      case "--output": options.output = takeValue(argv, argument); break;
      case "--input": options.input = takeValue(argv, argument); break;
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
  if (options.output) options.output = resolve(options.output);
  if (options.input) options.input = resolve(options.input);
  if (options.secretFile) options.secretFile = resolve(options.secretFile);
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

async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ProviderClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await chmod(temporary, 0o600);
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
  const store = storeDetails ? await loadProviderStore(options.storePath) : newProviderStore();
  const secrets = secretsDetails
    ? await loadProviderSecrets(options.secretsPath)
    : newProviderSecrets();
  const references = collectSecretReferences(store);
  const missing = [...references.keys()].filter((name) => !secrets.secrets[name]).sort();
  const output = {
    schema: CURRENT_PROVIDER_SCHEMA,
    platform: normalizeRuntimePlatform(),
    store: options.storePath,
    store_exists: Boolean(storeDetails),
    secrets: options.secretsPath,
    secrets_exists: Boolean(secretsDetails),
    profile_count: Object.keys(store.profiles).length,
    secret_count: Object.keys(secrets.secrets).length,
    referenced_secrets: [...references.keys()].sort(),
    missing_secrets: missing
  };
  if (options.json) return process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Provider Store: ${output.store_exists ? output.store : "not initialized"}\n`);
  process.stdout.write(`Secret Store:   ${output.secrets_exists ? output.secrets : "not initialized"}\n`);
  process.stdout.write(`Platform:       ${output.platform}\n`);
  process.stdout.write(`Profiles:       ${output.profile_count}\n`);
  process.stdout.write(`Secrets:        ${output.secret_count} present, ${missing.length} missing\n`);
  if (missing.length) process.stdout.write(`Missing refs:   ${missing.join(", ")}\n`);
}

async function list(options) {
  const store = await loadProviderStore(options.storePath);
  const rows = Object.values(store.profiles).sort((a, b) => a.name.localeCompare(b.name));
  if (options.json) return process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  if (!rows.length) return process.stdout.write("(no provider profiles)\n");
  for (const profile of rows) {
    process.stdout.write(
      `${profile.name.padEnd(24)} ${profile.protocol.padEnd(20)} ${profile.models.default}\n`
    );
  }
}

async function show(name, options) {
  const profile = profileOrThrow(await loadProviderStore(options.storePath), name);
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
    options.secret !== undefined
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
  const profile = profileOrThrow(await loadProviderStore(options.storePath), name);
  const resolvedProfile = resolveProviderProfile(profile, {
    target: options.target,
    platform: options.platform || normalizeRuntimePlatform()
  });
  process.stdout.write(`${JSON.stringify(resolvedProfile, null, 2)}\n`);
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

async function importStore(options) {
  if (!options.input) throw new ProviderClientError("import requires --input");
  const incoming = validateProviderStore(await readJson(options.input, "provider import"));
  const current = await loadProviderStore(options.storePath, { allowMissing: true });
  let next;
  if (options.replace) {
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
  validateProviderStore(next);
  printMutation(options.replace ? "replace provider Store from import" : "merge provider Store import", {
    source: options.input,
    destination: options.storePath,
    profiles: Object.keys(next.profiles).length,
    secret_values: "not present in portable imports"
  }, options);
  if (options.yes) await saveProviderStore(options.storePath, next);
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
  throw new ProviderClientError("invalid provider command; use agentctl provider --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof ProviderClientError || error instanceof ProviderSchemaError
      ? error.message
      : "unexpected provider Store failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}
