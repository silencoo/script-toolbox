export const CURRENT_PROVIDER_SCHEMA = 1;
export const PROVIDER_STORE_KIND = "agentctl-provider-store";
export const PROVIDER_SECRETS_KIND = "agentctl-provider-secrets";

export const PROVIDER_PROTOCOLS = Object.freeze([
  "anthropic_messages",
  "openai_responses",
  "openai_chat",
  "google_generative"
]);
export const PROVIDER_AUTH_MODES = Object.freeze([
  "bearer",
  "x-api-key",
  "x-goog-api-key",
  "none"
]);
export const PROVIDER_TARGETS = Object.freeze([
  "claude",
  "codex",
  "opencode",
  "pi"
]);
export const PROVIDER_PLATFORMS = Object.freeze([
  "darwin",
  "linux",
  "windows"
]);

const PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ProviderSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderSchemaError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireObject(value, label) {
  if (!plainObject(value)) throw new ProviderSchemaError(`${label} must be an object`);
  return value;
}

function rejectUnknown(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProviderSchemaError(`${label} contains unsupported field '${key}'`);
    }
  }
}

function requireString(value, label, { min = 1, max = 500 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max ||
      CONTROL_CHARACTERS.test(value)) {
    throw new ProviderSchemaError(`${label} must be a ${min}-${max} character string without control characters`);
  }
  return value;
}

function requireTimestamp(value, label) {
  requireString(value, label, { min: 20, max: 40 });
  if (Number.isNaN(Date.parse(value))) {
    throw new ProviderSchemaError(`${label} is not a valid timestamp`);
  }
  return value;
}

export function validateProfileName(value, label = "profile name") {
  if (typeof value !== "string" || value.length > 64 || !PROFILE_NAME.test(value)) {
    throw new ProviderSchemaError(
      `${label} must use lowercase letters, numbers, and single hyphens`
    );
  }
  return value;
}

export function validateReferenceName(value, label = "reference name") {
  if (typeof value !== "string" || value.length > 96 || !REFERENCE_NAME.test(value) ||
      value.includes("..")) {
    throw new ProviderSchemaError(
      `${label} must start with a letter and use only letters, numbers, '.', '_' or '-'`
    );
  }
  return value;
}

export function validateProtocol(value, label = "protocol") {
  if (!PROVIDER_PROTOCOLS.includes(value)) {
    throw new ProviderSchemaError(
      `${label} must be one of: ${PROVIDER_PROTOCOLS.join(", ")}`
    );
  }
  return value;
}

export function validateAuthMode(value, label = "authentication mode") {
  if (!PROVIDER_AUTH_MODES.includes(value)) {
    throw new ProviderSchemaError(
      `${label} must be one of: ${PROVIDER_AUTH_MODES.join(", ")}`
    );
  }
  return value;
}

export function validateTarget(value, label = "target") {
  if (!PROVIDER_TARGETS.includes(value)) {
    throw new ProviderSchemaError(
      `${label} must be one of: ${PROVIDER_TARGETS.join(", ")}`
    );
  }
  return value;
}

export function validatePlatform(value, label = "platform") {
  if (!PROVIDER_PLATFORMS.includes(value)) {
    throw new ProviderSchemaError(
      `${label} must be one of: ${PROVIDER_PLATFORMS.join(", ")}`
    );
  }
  return value;
}

export function normalizeRuntimePlatform(value = process.platform) {
  if (value === "win32") return "windows";
  return validatePlatform(value, "runtime platform");
}

export function validateEndpoint(value, label = "endpoint") {
  requireString(value, label, { min: 8, max: 2048 });
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProviderSchemaError(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!(["http:", "https:"].includes(endpoint.protocol)) ||
      endpoint.username || endpoint.password || endpoint.hash) {
    throw new ProviderSchemaError(
      `${label} must be an HTTP(S) URL without embedded credentials or a fragment`
    );
  }
  const loopback = endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !loopback) {
    throw new ProviderSchemaError(`${label} must use HTTPS unless it is loopback-only`);
  }
  return endpoint.toString().replace(/\/$/, "");
}

export function validateModelId(value, label = "model ID") {
  return requireString(value, label, { min: 1, max: 240 });
}

function validateAuth(value, label, { partial = false } = {}) {
  requireObject(value, label);
  rejectUnknown(value, ["mode", "secret"], label);
  if (!partial || value.mode !== undefined) validateAuthMode(value.mode, `${label}.mode`);
  if (value.secret !== undefined) validateReferenceName(value.secret, `${label}.secret`);
  if (!partial && value.mode !== "none" && value.secret === undefined) {
    throw new ProviderSchemaError(`${label}.secret is required unless mode is none`);
  }
  if (value.mode === "none" && value.secret !== undefined) {
    throw new ProviderSchemaError(`${label}.secret is not allowed when mode is none`);
  }
  if (partial && Object.keys(value).length === 0) {
    throw new ProviderSchemaError(`${label} cannot be empty`);
  }
  return value;
}

function validateModels(value, label) {
  requireObject(value, label);
  rejectUnknown(value, ["default", "aliases"], label);
  validateModelId(value.default, `${label}.default`);
  requireObject(value.aliases, `${label}.aliases`);
  if (Object.keys(value.aliases).length > 256) {
    throw new ProviderSchemaError(`${label}.aliases has too many entries`);
  }
  for (const [requested, outbound] of Object.entries(value.aliases)) {
    validateModelId(requested, `${label}.aliases key`);
    validateModelId(outbound, `${label}.aliases.${requested}`);
  }
  return value;
}

function validateTargetOverride(value, label) {
  requireObject(value, label);
  rejectUnknown(value, ["enabled", "endpoint", "protocol", "auth", "model"], label);
  if (Object.keys(value).length === 0) {
    throw new ProviderSchemaError(`${label} cannot be empty`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ProviderSchemaError(`${label}.enabled must be boolean`);
  }
  if (value.endpoint !== undefined) validateEndpoint(value.endpoint, `${label}.endpoint`);
  if (value.protocol !== undefined) validateProtocol(value.protocol, `${label}.protocol`);
  if (value.auth !== undefined) validateAuth(value.auth, `${label}.auth`, { partial: true });
  if (value.model !== undefined) validateModelId(value.model, `${label}.model`);
  return value;
}

function validateTargets(value, label) {
  requireObject(value, label);
  for (const [target, override] of Object.entries(value)) {
    validateTarget(target, `${label} key`);
    validateTargetOverride(override, `${label}.${target}`);
  }
  return value;
}

function validatePlatforms(value, label) {
  requireObject(value, label);
  for (const [platform, overlay] of Object.entries(value)) {
    validatePlatform(platform, `${label} key`);
    requireObject(overlay, `${label}.${platform}`);
    rejectUnknown(overlay, ["targets"], `${label}.${platform}`);
    if (!overlay.targets || Object.keys(overlay.targets).length === 0) {
      throw new ProviderSchemaError(`${label}.${platform}.targets cannot be empty`);
    }
    validateTargets(overlay.targets, `${label}.${platform}.targets`);
  }
  return value;
}

export function validateProviderProfile(value, expectedName = "") {
  requireObject(value, "provider profile");
  rejectUnknown(value, [
    "schema", "name", "description", "protocol", "endpoint", "auth",
    "models", "targets", "platforms"
  ], "provider profile");
  if (value.schema !== CURRENT_PROVIDER_SCHEMA) {
    throw new ProviderSchemaError(
      `provider profile schema must be ${CURRENT_PROVIDER_SCHEMA}`
    );
  }
  validateProfileName(value.name);
  if (expectedName && value.name !== expectedName) {
    throw new ProviderSchemaError(`provider profile '${expectedName}' has a mismatched name`);
  }
  requireString(value.description, "provider profile description", { min: 0, max: 500 });
  validateProtocol(value.protocol);
  value.endpoint = validateEndpoint(value.endpoint);
  validateAuth(value.auth, "provider profile auth");
  validateModels(value.models, "provider profile models");
  validateTargets(value.targets, "provider profile targets");
  validatePlatforms(value.platforms, "provider profile platforms");
  return value;
}

export function newProviderStore(now = new Date().toISOString()) {
  return {
    schema: CURRENT_PROVIDER_SCHEMA,
    kind: PROVIDER_STORE_KIND,
    created_at: now,
    updated_at: now,
    profiles: {}
  };
}

export function validateProviderStore(value) {
  requireObject(value, "provider Store");
  rejectUnknown(value, [
    "schema", "kind", "created_at", "updated_at", "profiles"
  ], "provider Store");
  if (value.schema !== CURRENT_PROVIDER_SCHEMA || value.kind !== PROVIDER_STORE_KIND) {
    throw new ProviderSchemaError(
      `provider Store must use ${PROVIDER_STORE_KIND} schema ${CURRENT_PROVIDER_SCHEMA}`
    );
  }
  requireTimestamp(value.created_at, "provider Store created_at");
  requireTimestamp(value.updated_at, "provider Store updated_at");
  requireObject(value.profiles, "provider Store profiles");
  if (Object.keys(value.profiles).length > 128) {
    throw new ProviderSchemaError("provider Store has too many profiles");
  }
  for (const [name, profile] of Object.entries(value.profiles)) {
    validateProfileName(name);
    validateProviderProfile(profile, name);
  }
  return value;
}

export function newProviderSecrets(now = new Date().toISOString()) {
  return {
    schema: CURRENT_PROVIDER_SCHEMA,
    kind: PROVIDER_SECRETS_KIND,
    updated_at: now,
    secrets: {}
  };
}

export function validateProviderSecrets(value) {
  requireObject(value, "provider Secret Store");
  rejectUnknown(value, ["schema", "kind", "updated_at", "secrets"], "provider Secret Store");
  if (value.schema !== CURRENT_PROVIDER_SCHEMA || value.kind !== PROVIDER_SECRETS_KIND) {
    throw new ProviderSchemaError(
      `provider Secret Store must use ${PROVIDER_SECRETS_KIND} schema ${CURRENT_PROVIDER_SCHEMA}`
    );
  }
  requireTimestamp(value.updated_at, "provider Secret Store updated_at");
  requireObject(value.secrets, "provider Secret Store secrets");
  for (const [name, secret] of Object.entries(value.secrets)) {
    validateReferenceName(name, "secret name");
    requireObject(secret, `secret '${name}'`);
    rejectUnknown(secret, ["value", "updated_at"], `secret '${name}'`);
    requireString(secret.value, `secret '${name}' value`, { min: 1, max: 16384 });
    requireTimestamp(secret.updated_at, `secret '${name}' updated_at`);
  }
  return value;
}

function mergeOverride(base, override = {}) {
  const result = { ...base, ...override };
  if (override.auth) {
    result.auth = override.auth.mode === "none"
      ? { mode: "none" }
      : { ...base.auth, ...override.auth };
  }
  return result;
}

export function resolveProviderProfile(profile, {
  target,
  platform = normalizeRuntimePlatform()
}) {
  validateProviderProfile(structuredClone(profile), profile.name);
  validateTarget(target);
  validatePlatform(platform);
  let resolved = {
    profile: profile.name,
    target,
    platform,
    enabled: true,
    endpoint: profile.endpoint,
    protocol: profile.protocol,
    auth: structuredClone(profile.auth),
    model: profile.models.default,
    models: structuredClone(profile.models)
  };
  resolved = mergeOverride(resolved, profile.targets[target]);
  resolved = mergeOverride(
    resolved,
    profile.platforms[platform]?.targets?.[target]
  );
  resolved.endpoint = validateEndpoint(resolved.endpoint, "resolved endpoint");
  validateProtocol(resolved.protocol, "resolved protocol");
  validateAuth(resolved.auth, "resolved auth");
  validateModelId(resolved.model, "resolved model");
  const seen = new Set();
  let outbound = resolved.model;
  while (resolved.models.aliases[outbound] !== undefined) {
    if (seen.has(outbound)) {
      throw new ProviderSchemaError(
        `model alias cycle detected in provider profile '${profile.name}'`
      );
    }
    seen.add(outbound);
    outbound = resolved.models.aliases[outbound];
  }
  resolved.requested_model = resolved.model;
  resolved.outbound_model = outbound;
  return resolved;
}
