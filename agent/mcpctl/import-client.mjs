#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  encryptValue,
  LOCAL_SECRETS_INFO,
  readEncryptedLocalSecrets,
  validateRemoteConfig
} from "./remote-client.mjs";

const SCHEMA = 1;
const MANAGED_BY = "agent/mcpctl/import";
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RUNTIME_FIELDS = [
  "transport",
  "url",
  "command",
  "auth",
  "environment",
  "headers",
  "client_type",
  "cwd",
  "env_vars",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "required",
  "enabled_tools",
  "disabled_tools",
  "default_tools_approval_mode",
  "suppress_when_disabled"
];

class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportError";
  }
}

function usage() {
  process.stdout.write(`mcpctl local MCP importer

Usage:
  import-client.mjs <plan|apply> --target <claude|codex>
    --store <directory> --profile <name> [options]

Options:
  --source <file>         Claude config JSON, or saved "codex mcp list --json".
  --scope <user>          Import scope. Only user/global scope is currently supported.
  --remote-config <file>  Capability file used to encrypt imported static values.
  --codex-bin <path>      Codex executable (default: codex).
  --force                 Replace conflicting target definitions and Secret values.
`);
}

function takeValue(argv, option) {
  if (argv.length === 0) throw new ImportError(`${option} requires a value`);
  return argv.shift();
}

function parseArguments(argv) {
  const action = argv.shift();
  if (!action || action === "help" || action === "--help" || action === "-h") {
    return { action: "help" };
  }
  if (!["plan", "apply"].includes(action)) {
    throw new ImportError("the importer action must be plan or apply");
  }

  const options = {
    action,
    target: "",
    store: "",
    profile: "imported",
    source: "",
    scope: "user",
    remoteConfig: "",
    codexBin: process.env.MCPCTL_CODEX_BIN || "codex",
    force: false
  };

  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--target":
        options.target = takeValue(argv, argument);
        break;
      case "--store":
        options.store = takeValue(argv, argument);
        break;
      case "--profile":
        options.profile = takeValue(argv, argument);
        break;
      case "--source":
        options.source = takeValue(argv, argument);
        break;
      case "--scope":
        options.scope = takeValue(argv, argument);
        break;
      case "--remote-config":
        options.remoteConfig = takeValue(argv, argument);
        break;
      case "--codex-bin":
        options.codexBin = takeValue(argv, argument);
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new ImportError(`unknown importer argument: ${argument}`);
    }
  }

  if (!["claude", "codex"].includes(options.target)) {
    throw new ImportError("--target must be claude or codex");
  }
  if (!options.store) throw new ImportError("--store is required");
  if (!PROFILE_NAME_PATTERN.test(options.profile)) {
    throw new ImportError("the import profile name contains unsupported characters");
  }
  if (options.scope !== "user") {
    throw new ImportError(
      "only user/global MCP configuration can be imported; project configuration remains project-owned"
    );
  }
  return options;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableValue(value[key])])
  );
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return clone(override);
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = isObject(result[key]) && isObject(value)
      ? deepMerge(result[key], value)
      : clone(value);
  }
  return result;
}

function validateServerName(name) {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new ImportError(
      `MCP server '${name}' cannot be imported safely; names must use letters, numbers, underscore, or hyphen`
    );
  }
}

function validateStringArray(value, label, { allowObjects = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ImportError(`${label} must be an array`);
  for (const entry of value) {
    if (typeof entry === "string") continue;
    if (allowObjects &&
        isObject(entry) &&
        typeof entry.name === "string" &&
        ["local", "remote"].includes(entry.source)) {
      continue;
    }
    throw new ImportError(`${label} contains an unsupported entry`);
  }
  return clone(value);
}

function validateStringMap(value, label) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new ImportError(`${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new ImportError(`${label}.${key} must be a string`);
    }
  }
  return value;
}

function assertSafeUrl(url, server) {
  if (typeof url !== "string" || url.length === 0) {
    throw new ImportError(`HTTP MCP '${server}' has no URL`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError(`HTTP MCP '${server}' has an invalid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ImportError(`HTTP MCP '${server}' uses an unsupported URL protocol`);
  }
  if (parsed.username || parsed.password) {
    throw new ImportError(
      `HTTP MCP '${server}' embeds credentials in its URL; move them to a Header before importing`
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:api.?key|token|secret|password|credential|auth)/i.test(key)) {
      throw new ImportError(
        `HTTP MCP '${server}' appears to embed a credential in its URL query; move it to a Header before importing`
      );
    }
  }
  return url;
}

function importCommand(target, server, command, secrets) {
  if (!Array.isArray(command) ||
      command.length === 0 ||
      command.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ImportError(`stdio MCP '${server}' has an invalid command`);
  }
  const result = clone(command);
  for (let index = 1; index < command.length; index += 1) {
    const value = command[index];
    const inline = /^(--?(?:api[-_]?key|token|secret|password|credential|auth))=(.*)$/i.exec(
      value
    );
    let flag = "";
    let secretValue = "";
    let outerPrefix = "";
    if (inline) {
      flag = inline[1];
      secretValue = inline[2];
      outerPrefix = `${flag}=`;
    } else if (/^--?(?:api[-_]?key|token|secret|password|credential|auth)$/i.test(
      command[index - 1]
    )) {
      flag = command[index - 1];
      secretValue = value;
    }
    if (!flag) continue;

    const normalizedFlag = flag.replace(/^-+/, "");
    const template = splitTemplate(secretValue);
    const descriptor = makeSecretDescriptor({
      target,
      server,
      kind: "arg",
      key: `${index}_${normalizedFlag}`,
      env: template?.env ||
        generatedHeaderEnvironment(server, normalizedFlag),
      prefix: `${outerPrefix}${template?.prefix || ""}`,
      suffix: template?.suffix || ""
    });
    if (template) {
      if (template.fallback !== undefined) {
        addCapturedSecret(
          secrets,
          descriptor,
          template.fallback,
          `${server}.command.${index}`
        );
      }
    } else {
      addCapturedSecret(
        secrets,
        descriptor,
        secretValue,
        `${server}.command.${index}`
      );
    }
    result[index] = descriptor;
  }
  return result;
}

function secretIdentity(target, server, kind, key) {
  return `${target}:${server}:${kind}:${key}`;
}

function secretName(target, server, kind, key) {
  const identity = secretIdentity(target, server, kind, key);
  const slug = identity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  return `import_${slug}_${hash}`;
}

function generatedHeaderEnvironment(server, header) {
  return `MCPCTL_${server}_${header}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^([^A-Z_])/, "_$1");
}

function splitTemplate(value) {
  const claude = /^(.*)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}(.*)$/.exec(
    value
  );
  if (claude) {
    return {
      env: claude[2],
      fallback: claude[3],
      prefix: claude[1],
      suffix: claude[4]
    };
  }
  const opencode = /^(.*)\{env:([A-Za-z_][A-Za-z0-9_]*)\}(.*)$/.exec(value);
  if (opencode) {
    return {
      env: opencode[2],
      fallback: undefined,
      prefix: opencode[1],
      suffix: opencode[3]
    };
  }
  return null;
}

function makeSecretDescriptor({
  target,
  server,
  kind,
  key,
  env,
  prefix = "",
  suffix = ""
}) {
  const descriptor = {
    secret: secretName(target, server, kind, key),
    env,
    required: true
  };
  if (prefix) descriptor.prefix = prefix;
  if (suffix) descriptor.suffix = suffix;
  return descriptor;
}

function addCapturedSecret(secrets, descriptor, value, label) {
  const existing = secrets[descriptor.secret];
  if (existing !== undefined && existing !== value) {
    throw new ImportError(`two imported values map to the same Secret reference: ${label}`);
  }
  secrets[descriptor.secret] = value;
}

function secretEnvironmentMap(target, server, environment, secrets) {
  const result = {};
  for (const [name, value] of Object.entries(validateStringMap(
    environment,
    `${server}.environment`
  ))) {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new ImportError(`stdio MCP '${server}' has an invalid environment name`);
    }
    const template = splitTemplate(value);
    const descriptor = makeSecretDescriptor({
      target,
      server,
      kind: "env",
      key: name,
      env: template?.env || name,
      prefix: template?.prefix || "",
      suffix: template?.suffix || ""
    });
    if (template) {
      if (template.fallback !== undefined) {
        addCapturedSecret(
          secrets,
          descriptor,
          template.fallback,
          `${server}.environment.${name}`
        );
      }
    } else {
      addCapturedSecret(secrets, descriptor, value, `${server}.environment.${name}`);
    }
    result[name] = descriptor;
  }
  return result;
}

function secretHeaderMap(target, server, headers, secrets) {
  const result = {};
  for (const [name, rawValue] of Object.entries(validateStringMap(
    headers,
    `${server}.headers`
  ))) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new ImportError(`HTTP MCP '${server}' has an invalid Header name`);
    }
    const template = splitTemplate(rawValue);
    let prefix = template?.prefix || "";
    let suffix = template?.suffix || "";
    let value = rawValue;
    if (!template && /^authorization$/i.test(name)) {
      const bearer = /^(Bearer\s+)(.*)$/i.exec(rawValue);
      if (bearer) {
        prefix = bearer[1];
        value = bearer[2];
      }
    }
    const descriptor = makeSecretDescriptor({
      target,
      server,
      kind: "header",
      key: name.toLowerCase(),
      env: template?.env || generatedHeaderEnvironment(server, name),
      prefix,
      suffix
    });
    if (template) {
      if (template.fallback !== undefined) {
        addCapturedSecret(
          secrets,
          descriptor,
          template.fallback,
          `${server}.headers.${name}`
        );
      }
    } else {
      addCapturedSecret(secrets, descriptor, value, `${server}.headers.${name}`);
    }
    result[name] = descriptor;
  }
  return result;
}

function importedDescription(target) {
  return `Imported from the current ${target === "claude" ? "Claude Code" : "Codex"} user MCP configuration`;
}

function parseClaudeConfig(document) {
  if (!isObject(document)) {
    throw new ImportError("Claude configuration must be a JSON object");
  }
  const source = document.mcpServers ?? {};
  if (!isObject(source)) {
    throw new ImportError("Claude configuration has an invalid mcpServers object");
  }
  const secrets = {};
  const warnings = [];
  const servers = [];

  for (const [name, rawDefinition] of Object.entries(source)) {
    validateServerName(name);
    if (!isObject(rawDefinition)) {
      throw new ImportError(`Claude MCP '${name}' must be an object`);
    }
    const definition = {
      category: "imported",
      description: importedDescription("claude"),
      supported_targets: ["claude"]
    };
    const type = rawDefinition.type;

    if (typeof rawDefinition.command === "string" || Array.isArray(rawDefinition.command)) {
      const command = Array.isArray(rawDefinition.command)
        ? clone(rawDefinition.command)
        : [
            rawDefinition.command,
            ...validateStringArray(rawDefinition.args, `${name}.args`)
          ];
      definition.transport = "stdio";
      definition.command = importCommand("claude", name, command, secrets);
      const environment = secretEnvironmentMap(
        "claude",
        name,
        rawDefinition.env,
        secrets
      );
      if (Object.keys(environment).length > 0) definition.environment = environment;
    } else if (
      ["http", "sse"].includes(type) ||
      (typeof rawDefinition.url === "string" && rawDefinition.url.length > 0)
    ) {
      definition.transport = "http";
      definition.url = assertSafeUrl(rawDefinition.url, name);
      definition.client_type = type === "sse" ? "sse" : "http";
      const headers = secretHeaderMap(
        "claude",
        name,
        rawDefinition.headers,
        secrets
      );
      if (Object.keys(headers).length > 0) definition.headers = headers;
    } else {
      throw new ImportError(`Claude MCP '${name}' has no supported command or URL`);
    }

    if (Number.isFinite(rawDefinition.startup_timeout_sec) &&
        rawDefinition.startup_timeout_sec > 0) {
      definition.startup_timeout_sec = rawDefinition.startup_timeout_sec;
    }

    const known = new Set([
      "type",
      "command",
      "args",
      "env",
      "url",
      "headers",
      "startup_timeout_sec",
      "_managed_by"
    ]);
    const skipped = Object.keys(rawDefinition).filter((key) => !known.has(key));
    if (skipped.length > 0) {
      warnings.push(
        `${name}: skipped unsupported Claude fields ${skipped.sort().join(", ")}`
      );
    }
    servers.push({ name, definition, enabled: true });
  }

  return {
    target: "claude",
    servers,
    secrets,
    warnings
  };
}

function codexHeaderReferences(target, server, transport, secrets) {
  const headers = secretHeaderMap(
    target,
    server,
    transport.http_headers,
    secrets
  );
  for (const [header, environment] of Object.entries(validateStringMap(
    transport.env_http_headers,
    `${server}.env_http_headers`
  ))) {
    if (!HEADER_NAME_PATTERN.test(header) || !ENV_NAME_PATTERN.test(environment)) {
      throw new ImportError(`Codex MCP '${server}' has an invalid environment Header`);
    }
    if (headers[header]) {
      throw new ImportError(
        `Codex MCP '${server}' configures Header '${header}' twice`
      );
    }
    headers[header] = makeSecretDescriptor({
      target,
      server,
      kind: "header",
      key: header.toLowerCase(),
      env: environment
    });
  }

  const bearerEnvironment = transport.bearer_token_env_var;
  if (bearerEnvironment !== null && bearerEnvironment !== undefined) {
    if (!ENV_NAME_PATTERN.test(bearerEnvironment)) {
      throw new ImportError(`Codex MCP '${server}' has an invalid bearer Token environment`);
    }
    const authorizationName = Object.keys(headers).find(
      (header) => header.toLowerCase() === "authorization"
    );
    if (authorizationName) {
      throw new ImportError(
        `Codex MCP '${server}' configures Authorization more than once`
      );
    }
    headers.Authorization = makeSecretDescriptor({
      target,
      server,
      kind: "header",
      key: "authorization",
      env: bearerEnvironment,
      prefix: "Bearer "
    });
  }
  return headers;
}

function copyCodexOption(item, definition, name, predicate) {
  const value = item[name];
  if (value === undefined || value === null) return;
  if (!predicate(value)) {
    throw new ImportError(`Codex MCP '${item.name}' has an invalid ${name} value`);
  }
  definition[name] = clone(value);
}

function parseCodexList(document) {
  if (!Array.isArray(document)) {
    throw new ImportError('Codex source must be the JSON output of "codex mcp list --json"');
  }
  const secrets = {};
  const warnings = [];
  const servers = [];

  for (const item of document) {
    if (!isObject(item) || typeof item.name !== "string") {
      throw new ImportError("Codex MCP list contains an invalid server");
    }
    const name = item.name;
    validateServerName(name);
    const transport = item.transport;
    if (!isObject(transport) || typeof transport.type !== "string") {
      throw new ImportError(`Codex MCP '${name}' has an invalid transport`);
    }
    const definition = {
      category: "imported",
      description: importedDescription("codex"),
      supported_targets: ["codex"]
    };

    if (transport.type === "stdio") {
      const command = [
        transport.command,
        ...validateStringArray(transport.args, `${name}.args`)
      ];
      definition.transport = "stdio";
      definition.command = importCommand("codex", name, command, secrets);
      const environment = secretEnvironmentMap(
        "codex",
        name,
        transport.env,
        secrets
      );
      if (Object.keys(environment).length > 0) definition.environment = environment;
      if (typeof transport.cwd === "string" && transport.cwd.length > 0) {
        definition.cwd = transport.cwd;
      }
      const envVars = validateStringArray(
        transport.env_vars,
        `${name}.env_vars`,
        { allowObjects: true }
      );
      if (envVars.length > 0) definition.env_vars = envVars;
    } else if (transport.type === "streamable_http") {
      definition.transport = "http";
      definition.url = assertSafeUrl(transport.url, name);
      const headers = codexHeaderReferences("codex", name, transport, secrets);
      if (Object.keys(headers).length > 0) definition.headers = headers;
    } else {
      throw new ImportError(`Codex MCP '${name}' uses an unsupported transport`);
    }

    copyCodexOption(
      item,
      definition,
      "startup_timeout_sec",
      (value) => Number.isFinite(value) && value > 0
    );
    copyCodexOption(
      item,
      definition,
      "tool_timeout_sec",
      (value) => Number.isFinite(value) && value > 0
    );
    copyCodexOption(item, definition, "required", (value) => typeof value === "boolean");
    copyCodexOption(
      item,
      definition,
      "enabled_tools",
      (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string")
    );
    copyCodexOption(
      item,
      definition,
      "disabled_tools",
      (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string")
    );
    copyCodexOption(
      item,
      definition,
      "default_tools_approval_mode",
      (value) => ["auto", "prompt", "writes", "approve"].includes(value)
    );
    if (item.enabled === false) definition.suppress_when_disabled = true;

    const known = new Set([
      "name",
      "enabled",
      "transport",
      "startup_timeout_sec",
      "tool_timeout_sec",
      "required",
      "enabled_tools",
      "disabled_tools",
      "default_tools_approval_mode",
      "auth_status",
      "disabled_reason"
    ]);
    const skipped = Object.keys(item).filter((key) => !known.has(key));
    if (skipped.length > 0) {
      warnings.push(
        `${name}: skipped unsupported Codex fields ${skipped.sort().join(", ")}`
      );
    }
    servers.push({
      name,
      definition,
      enabled: item.enabled !== false
    });
  }

  return {
    target: "codex",
    servers,
    secrets,
    warnings
  };
}

function stripDefinitionMetadata(definition) {
  const result = {};
  for (const key of RUNTIME_FIELDS) {
    if (Object.hasOwn(definition, key) && definition[key] !== null) {
      result[key] = clone(definition[key]);
    }
  }
  return result;
}

function effectiveDefinition(definition, target) {
  const override = definition.target_overrides?.[target] ?? {};
  return deepMerge(definition, override);
}

function supportsTarget(definition, target) {
  const targets = definition.supported_targets;
  return !Array.isArray(targets) || targets.length === 0 || targets.includes(target);
}

function exactTargetOverride(importedDefinition, existingEffective) {
  const importedRuntime = stripDefinitionMetadata(importedDefinition);
  const existingRuntime = stripDefinitionMetadata(existingEffective);
  const keys = new Set([
    ...Object.keys(importedRuntime),
    ...Object.keys(existingRuntime)
  ]);
  const override = {};
  for (const key of keys) {
    override[key] = Object.hasOwn(importedRuntime, key)
      ? clone(importedRuntime[key])
      : null;
  }
  return override;
}

function mergeCatalog(catalog, imported, { force }) {
  if (!isObject(catalog) || catalog.schema !== SCHEMA || !isObject(catalog.servers)) {
    throw new ImportError("the MCP store catalog is invalid");
  }
  const next = clone(catalog);
  const changes = [];
  const conflicts = [];

  for (const server of imported.servers) {
    const existing = next.servers[server.name];
    if (!existing) {
      next.servers[server.name] = clone(server.definition);
      changes.push({ name: server.name, action: "add" });
      continue;
    }
    if (!isObject(existing)) {
      if (force) {
        next.servers[server.name] = clone(server.definition);
        changes.push({ name: server.name, action: "replace" });
      } else {
        conflicts.push(`catalog server '${server.name}' is not an object`);
        changes.push({ name: server.name, action: "conflict" });
      }
      continue;
    }

    const existingEffective = effectiveDefinition(existing, imported.target);
    const sameRuntime = sameValue(
      stripDefinitionMetadata(existingEffective),
      stripDefinitionMetadata(server.definition)
    );
    const alreadySupported = supportsTarget(existing, imported.target);
    if (sameRuntime) {
      if (Array.isArray(existing.supported_targets) &&
          existing.supported_targets.length > 0 &&
          !existing.supported_targets.includes(imported.target)) {
        existing.supported_targets = sortedUnique([
          ...existing.supported_targets,
          imported.target
        ]);
        changes.push({ name: server.name, action: "extend" });
      } else {
        changes.push({ name: server.name, action: "keep" });
      }
      continue;
    }

    if (alreadySupported && !force) {
      conflicts.push(
        `catalog server '${server.name}' already has a different ${imported.target} definition`
      );
      changes.push({ name: server.name, action: "conflict" });
      continue;
    }

    existing.target_overrides = isObject(existing.target_overrides)
      ? existing.target_overrides
      : {};
    existing.target_overrides[imported.target] = exactTargetOverride(
      server.definition,
      existingEffective
    );
    if (Array.isArray(existing.supported_targets) &&
        existing.supported_targets.length > 0) {
      existing.supported_targets = sortedUnique([
        ...existing.supported_targets,
        imported.target
      ]);
    }
    changes.push({
      name: server.name,
      action: alreadySupported ? "replace" : "override"
    });
  }

  return { value: next, changes, conflicts };
}

function makeImportedProfile(name) {
  return {
    schema: SCHEMA,
    name,
    description: "Imported current MCP selections, preserved separately for each target",
    managed_by: MANAGED_BY,
    extends: ["off"],
    enable: [],
    disable: [],
    target_overrides: {}
  };
}

function mergeProfile(existing, imported, profileName, { force }) {
  const conflicts = [];
  let next;
  let action;
  if (existing === null) {
    next = makeImportedProfile(profileName);
    action = "add";
  } else if (!isObject(existing) || existing.name !== profileName) {
    if (!force) {
      conflicts.push(`profile '${profileName}' is invalid`);
      return { value: existing, action: "conflict", conflicts };
    }
    next = makeImportedProfile(profileName);
    action = "replace";
  } else if (existing.managed_by !== MANAGED_BY && !force) {
    conflicts.push(
      `profile '${profileName}' already exists and is not owned by the importer`
    );
    return { value: existing, action: "conflict", conflicts };
  } else {
    next = clone(existing);
    action = "update";
  }

  next.schema = SCHEMA;
  next.name = profileName;
  next.description =
    "Imported current MCP selections, preserved separately for each target";
  next.managed_by = MANAGED_BY;
  next.extends = ["off"];
  next.enable = [];
  next.disable = [];
  next.target_overrides = isObject(next.target_overrides)
    ? next.target_overrides
    : {};
  next.target_overrides[imported.target] = {
    enable: sortedUnique(
      imported.servers.filter((server) => server.enabled).map((server) => server.name)
    ),
    disable: []
  };
  if (existing !== null && sameValue(existing, next)) action = "keep";
  return { value: next, action, conflicts };
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

async function assertRegularFile(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ImportError(`${label} not found: ${path}`);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new ImportError(`${label} must be a regular, non-symlink file: ${path}`);
  }
  return details;
}

async function assertPrivateFile(path, label) {
  const details = await assertRegularFile(path, label);
  if ((details.mode & 0o077) !== 0) {
    throw new ImportError(`${label} must not allow group or other access: ${path}`);
  }
}

async function readTextLimited(path, label) {
  const details = await assertRegularFile(path, label);
  if (details.size > MAX_SOURCE_BYTES) {
    throw new ImportError(`${label} exceeds the safe size limit`);
  }
  return readFile(path, "utf8");
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError(`${label} is not valid JSON`);
  }
}

async function runCodexList(codexBin) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(codexBin, ["mcp", "list", "--json"], {
      cwd: homedir(),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    let stdoutBytes = 0;
    let killedForSize = false;

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_SOURCE_BYTES) {
        killedForSize = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    // Drain diagnostics without retaining them: a client error must never
    // accidentally echo configuration values through this importer.
    child.stderr.resume();
    child.on("error", () => {
      rejectPromise(new ImportError("could not start the Codex CLI"));
    });
    child.on("close", (code) => {
      if (killedForSize) {
        rejectPromise(new ImportError("Codex MCP list exceeds the safe size limit"));
      } else if (code !== 0) {
        rejectPromise(new ImportError(
          'Codex CLI could not export MCP configuration with "codex mcp list --json"'
        ));
      } else {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

async function loadImportSource(options) {
  if (options.target === "claude") {
    const sourcePath = resolve(
      options.source || process.env.MCPCTL_CLAUDE_IMPORT_CONFIG ||
      join(homedir(), ".claude.json")
    );
    const document = parseJson(
      await readTextLimited(sourcePath, "Claude user configuration"),
      "Claude user configuration"
    );
    return {
      imported: parseClaudeConfig(document),
      sourceLabel: sourcePath
    };
  }

  if (options.source) {
    const sourcePath = resolve(options.source);
    const document = parseJson(
      await readTextLimited(sourcePath, "Codex MCP JSON export"),
      "Codex MCP JSON export"
    );
    return {
      imported: parseCodexList(document),
      sourceLabel: sourcePath
    };
  }
  const document = parseJson(
    await runCodexList(options.codexBin),
    "Codex MCP JSON output"
  );
  return {
    imported: parseCodexList(document),
    sourceLabel: `${options.codexBin} mcp list --json`
  };
}

async function readOptionalJson(path, label) {
  if (!(await pathExists(path))) return null;
  return parseJson(await readTextLimited(path, label), label);
}

function fingerprintText(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fileFingerprint(path) {
  if (!(await pathExists(path))) return null;
  const text = await readTextLimited(path, "import input");
  return fingerprintText(text);
}

async function readJsonSnapshot(path, label, required = false) {
  if (!(await pathExists(path))) {
    if (required) throw new ImportError(`${label} not found: ${path}`);
    return { value: null, fingerprint: null };
  }
  const text = await readTextLimited(path, label);
  return {
    value: parseJson(text, label),
    fingerprint: fingerprintText(text)
  };
}

async function assertUnchanged(path, expectedFingerprint, label) {
  const actualFingerprint = await fileFingerprint(path);
  if (actualFingerprint !== expectedFingerprint) {
    throw new ImportError(`${label} changed while the import was being prepared`);
  }
}

async function readRemoteConfiguration(path) {
  await assertPrivateFile(path, "remote configuration");
  const text = await readTextLimited(path, "remote configuration");
  return {
    config: validateRemoteConfig(parseJson(
      text,
      "remote configuration"
    )),
    fingerprint: fingerprintText(text)
  };
}

async function inspectSecrets(importedSecrets, storePath, remoteConfigPath) {
  const names = Object.keys(importedSecrets).sort();
  if (names.length === 0) {
    return {
      existing: {},
      merged: {},
      changes: [],
      conflicts: [],
      config: null,
      remoteConfigFingerprint: null,
      encryptedFingerprint: null
    };
  }
  if (!remoteConfigPath || !(await pathExists(remoteConfigPath))) {
    return {
      existing: {},
      merged: {},
      changes: names.map((name) => ({ name, action: "blocked" })),
      conflicts: [
        "imported static values require a mode-0600 remote configuration so they can be encrypted"
      ],
      config: null,
      remoteConfigFingerprint: null,
      encryptedFingerprint: null
    };
  }

  const remote = await readRemoteConfiguration(remoteConfigPath);
  const config = remote.config;
  const encryptedPath = join(storePath, "secrets.remote.enc");
  const encryptedFingerprintBefore = await fileFingerprint(encryptedPath);
  const existing = encryptedFingerprintBefore !== null
    ? await readEncryptedLocalSecrets(encryptedPath, config)
    : {};
  const encryptedFingerprint = await fileFingerprint(encryptedPath);
  if (encryptedFingerprintBefore !== encryptedFingerprint) {
    throw new ImportError(
      "encrypted Secret cache changed while the import was being prepared"
    );
  }
  const merged = { ...existing };
  const changes = [];
  const conflicts = [];
  for (const name of names) {
    if (!Object.hasOwn(existing, name)) {
      merged[name] = importedSecrets[name];
      changes.push({ name, action: "add" });
    } else if (existing[name] === importedSecrets[name]) {
      changes.push({ name, action: "keep" });
    } else {
      changes.push({ name, action: "replace" });
      merged[name] = importedSecrets[name];
      conflicts.push(`encrypted Secret '${name}' already has a different value`);
    }
  }
  return {
    existing,
    merged,
    changes,
    conflicts,
    config,
    remoteConfigFingerprint: remote.fingerprint,
    encryptedFingerprint
  };
}

async function writeJsonAtomic(path, value) {
  const targetPath = resolve(path);
  const parentPath = dirname(targetPath);
  if (await pathExists(targetPath)) {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ImportError(`refusing to replace non-regular file: ${targetPath}`);
    }
  }
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parentPath,
    `.${targetPath.slice(parentPath.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function actionMarker(action) {
  switch (action) {
    case "add": return "+";
    case "extend":
    case "override":
    case "update":
    case "replace": return "~";
    case "keep": return "=";
    case "blocked":
    case "conflict": return "!";
    default: return "?";
  }
}

function printChanges(label, changes) {
  if (changes.length === 0) return;
  process.stdout.write(`${label}:\n`);
  for (const change of changes) {
    process.stdout.write(
      `  ${actionMarker(change.action)} ${change.name} (${change.action})\n`
    );
  }
}

function printPlan({
  options,
  sourceLabel,
  imported,
  catalogResult,
  profileResult,
  secretResult,
  conflicts
}) {
  const enabledCount = imported.servers.filter((server) => server.enabled).length;
  process.stdout.write(`Import target: ${imported.target}\n`);
  process.stdout.write(`Source:        ${sourceLabel}\n`);
  process.stdout.write(`Profile:       ${options.profile}\n`);
  process.stdout.write(
    `Discovered:    ${imported.servers.length} server(s), ${enabledCount} enabled\n`
  );
  printChanges("Catalog", catalogResult.changes);
  process.stdout.write(
    `Profile change: ${actionMarker(profileResult.action)} ${profileResult.action}\n`
  );
  printChanges("Encrypted Secrets", secretResult.changes);
  if (secretResult.changes.length > 0) {
    process.stdout.write("Secret values:  [redacted]\n");
  }
  if (imported.warnings.length > 0) {
    process.stdout.write("Warnings:\n");
    for (const warning of imported.warnings) {
      process.stdout.write(`  ! ${warning}\n`);
    }
  }
  if (conflicts.length > 0) {
    process.stdout.write("Conflicts:\n");
    for (const conflict of conflicts) process.stdout.write(`  ! ${conflict}\n`);
  }
  if (options.action === "plan") {
    if (conflicts.length === 0) {
      process.stdout.write("No files changed. Re-run with --write to import locally.\n");
    } else if (!options.force) {
      process.stdout.write(
        "No files changed. Review the differences; use --force --write only to adopt these target definitions.\n"
      );
    } else {
      process.stdout.write(
        "No files changed. --force authorizes these replacements; add --write to import locally.\n"
      );
    }
  }
}

async function prepareImport(options) {
  const storePath = resolve(options.store);
  const catalogPath = join(storePath, "catalog.json");
  const profilesPath = join(storePath, "profiles");
  const profilePath = join(profilesPath, `${options.profile}.json`);
  await assertRegularFile(catalogPath, "MCP catalog");
  const profileDirectory = await lstat(profilesPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new ImportError(`profiles directory not found: ${profilesPath}`);
    }
    throw error;
  });
  if (profileDirectory.isSymbolicLink() || !profileDirectory.isDirectory()) {
    throw new ImportError(`profiles path must be a real directory: ${profilesPath}`);
  }

  const [
    { imported, sourceLabel },
    catalogSnapshot,
    profileSnapshot
  ] = await Promise.all([
    loadImportSource(options),
    readJsonSnapshot(catalogPath, "MCP catalog", true),
    readJsonSnapshot(profilePath, "import profile")
  ]);
  const catalogResult = mergeCatalog(catalogSnapshot.value, imported, options);
  const profileResult = mergeProfile(
    profileSnapshot.value,
    imported,
    options.profile,
    options
  );
  const secretResult = await inspectSecrets(
    imported.secrets,
    storePath,
    options.remoteConfig ? resolve(options.remoteConfig) : ""
  );
  const conflicts = [
    ...catalogResult.conflicts,
    ...profileResult.conflicts,
    ...secretResult.conflicts
  ];
  return {
    options,
    storePath,
    catalogPath,
    profilePath,
    catalogFingerprint: catalogSnapshot.fingerprint,
    profileFingerprint: profileSnapshot.fingerprint,
    sourceLabel,
    imported,
    catalogResult,
    profileResult,
    secretResult,
    conflicts
  };
}

async function applyImport(prepared) {
  const {
    options,
    storePath,
    catalogPath,
    profilePath,
    catalogFingerprint,
    profileFingerprint,
    imported,
    catalogResult,
    profileResult,
    secretResult,
    conflicts
  } = prepared;
  if (conflicts.length > 0 && !options.force) {
    throw new ImportError(
      "import has conflicts; nothing was changed (re-run the plan with --force before adopting them)"
    );
  }
  if (secretResult.changes.some((change) => change.action === "blocked")) {
    throw new ImportError("imported static values cannot be stored without encryption");
  }

  await assertUnchanged(catalogPath, catalogFingerprint, "MCP catalog");
  await assertUnchanged(profilePath, profileFingerprint, "import profile");
  if (Object.keys(imported.secrets).length > 0) {
    await assertUnchanged(
      options.remoteConfig,
      secretResult.remoteConfigFingerprint,
      "remote configuration"
    );
    await assertUnchanged(
      join(storePath, "secrets.remote.enc"),
      secretResult.encryptedFingerprint,
      "encrypted Secret cache"
    );
  }

  if (Object.keys(imported.secrets).length > 0) {
    const envelope = encryptValue(
      "mcpctl-local-secrets",
      LOCAL_SECRETS_INFO,
      secretResult.config,
      { schema: SCHEMA, secrets: secretResult.merged }
    );
    await writeJsonAtomic(join(storePath, "secrets.remote.enc"), envelope);
  }
  if (!sameValue(
    parseJson(await readFile(catalogPath, "utf8"), "MCP catalog"),
    catalogResult.value
  )) {
    await writeJsonAtomic(catalogPath, catalogResult.value);
  }
  const existingProfile = await readOptionalJson(profilePath, "import profile");
  if (!sameValue(existingProfile, profileResult.value)) {
    await writeJsonAtomic(profilePath, profileResult.value);
  }
}

async function main(argv) {
  const options = parseArguments([...argv]);
  if (options.action === "help") {
    usage();
    return;
  }
  const prepared = await prepareImport(options);
  printPlan(prepared);
  if (options.action === "plan") return;
  await applyImport(prepared);
  process.stdout.write(
    `Imported ${prepared.imported.servers.length} server(s) into local profile '${options.profile}'.\n`
  );
  process.stdout.write(
    "Remote R2 was not changed. Review the profile, then run mcpctl backup.\n"
  );
}

export {
  ImportError,
  applyImport,
  makeSecretDescriptor,
  mergeCatalog,
  mergeProfile,
  parseClaudeConfig,
  parseCodexList,
  prepareImport,
  secretName,
  splitTemplate,
  stableValue
};

if (process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof ImportError
      ? error.message
      : "unexpected MCP import failure";
    process.stderr.write(`✗ ${message}\n`);
    process.exitCode = 1;
  });
}
