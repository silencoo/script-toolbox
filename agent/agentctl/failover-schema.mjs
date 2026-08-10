import {
  normalizeRuntimePlatform,
  resolveProviderProfile,
  validatePlatform,
  validateProfileName,
  validateProviderStore,
  validateTarget
} from "./provider-schema.mjs";

export const FAILOVER_SCHEMA = 1;
export const FAILOVER_KIND = "agentctl-failover-store";
export const RETRY_MODES = Object.freeze(["next_request", "same_request"]);
const ROUTE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class FailoverSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "FailoverSchemaError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new FailoverSchemaError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new FailoverSchemaError(`${label} contains unsupported field '${key}'`);
    }
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new FailoverSchemaError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FailoverSchemaError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function validateRouteName(value, label = "failover route name") {
  if (typeof value !== "string" || value.length > 64 || !ROUTE_NAME.test(value)) {
    throw new FailoverSchemaError(`${label} must use lowercase letters, numbers, and single hyphens`);
  }
  return value;
}

export function validateFailoverRoute(value, expectedName = "") {
  exactKeys(value, [
    "schema", "name", "description", "profiles", "retry", "circuit"
  ], "failover route");
  if (value.schema !== FAILOVER_SCHEMA) {
    throw new FailoverSchemaError(`failover route schema must be ${FAILOVER_SCHEMA}`);
  }
  validateRouteName(value.name);
  if (expectedName && value.name !== expectedName) {
    throw new FailoverSchemaError(`failover route '${expectedName}' has a mismatched name`);
  }
  if (typeof value.description !== "string" || value.description.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(value.description)) {
    throw new FailoverSchemaError("failover route description is invalid");
  }
  if (!Array.isArray(value.profiles) || value.profiles.length < 2 ||
      value.profiles.length > 8 || new Set(value.profiles).size !== value.profiles.length) {
    throw new FailoverSchemaError("failover route requires 2-8 unique provider profiles");
  }
  for (const profile of value.profiles) validateProfileName(profile, "failover profile");

  exactKeys(value.retry, [
    "mode", "max_attempts", "status_codes", "network_errors"
  ], "failover retry policy");
  if (!RETRY_MODES.includes(value.retry.mode)) {
    throw new FailoverSchemaError(`retry mode must be one of: ${RETRY_MODES.join(", ")}`);
  }
  boundedInteger(value.retry.max_attempts, "retry max_attempts", 1, value.profiles.length);
  if (!Array.isArray(value.retry.status_codes) || value.retry.status_codes.length > 32 ||
      new Set(value.retry.status_codes).size !== value.retry.status_codes.length) {
    throw new FailoverSchemaError("retry status_codes must be a unique array of at most 32 entries");
  }
  for (const status of value.retry.status_codes) {
    boundedInteger(status, "retry status code", 400, 599);
  }
  value.retry.status_codes.sort((left, right) => left - right);
  if (typeof value.retry.network_errors !== "boolean") {
    throw new FailoverSchemaError("retry network_errors must be boolean");
  }

  exactKeys(value.circuit, [
    "failure_threshold", "recovery_timeout_ms", "half_open_max_requests",
    "state_retention_days"
  ], "failover circuit policy");
  boundedInteger(value.circuit.failure_threshold, "circuit failure_threshold", 1, 20);
  boundedInteger(value.circuit.recovery_timeout_ms, "circuit recovery_timeout_ms", 1000, 3600000);
  boundedInteger(value.circuit.half_open_max_requests, "circuit half_open_max_requests", 1, 5);
  boundedInteger(value.circuit.state_retention_days, "circuit state_retention_days", 1, 365);
  return value;
}

export function newFailoverStore(now = new Date().toISOString()) {
  return {
    schema: FAILOVER_SCHEMA,
    kind: FAILOVER_KIND,
    created_at: now,
    updated_at: now,
    routes: {}
  };
}

export function validateFailoverStore(value) {
  exactKeys(value, [
    "schema", "kind", "created_at", "updated_at", "routes"
  ], "failover Store");
  if (value.schema !== FAILOVER_SCHEMA || value.kind !== FAILOVER_KIND) {
    throw new FailoverSchemaError(
      `failover Store must use ${FAILOVER_KIND} schema ${FAILOVER_SCHEMA}`
    );
  }
  timestamp(value.created_at, "failover Store created_at");
  timestamp(value.updated_at, "failover Store updated_at");
  if (!plainObject(value.routes) || Object.keys(value.routes).length > 128) {
    throw new FailoverSchemaError("failover Store routes must be an object with at most 128 entries");
  }
  for (const [name, route] of Object.entries(value.routes)) {
    validateRouteName(name);
    validateFailoverRoute(route, name);
  }
  return value;
}

export function validateFailoverProviders(route, providerStore) {
  validateFailoverRoute(structuredClone(route), route.name);
  validateProviderStore(structuredClone(providerStore));
  for (const profile of route.profiles) {
    if (!Object.hasOwn(providerStore.profiles, profile)) {
      throw new FailoverSchemaError(
        `failover route '${route.name}' references missing provider profile '${profile}'`
      );
    }
  }
  return route;
}

export function resolveFailoverRoute(route, providerStore, {
  target,
  platform = normalizeRuntimePlatform()
}) {
  validateTarget(target);
  validatePlatform(platform);
  validateFailoverProviders(route, providerStore);
  const backends = route.profiles.map((name) => {
    const resolved = resolveProviderProfile(providerStore.profiles[name], { target, platform });
    if (!resolved.enabled) {
      throw new FailoverSchemaError(
        `provider profile '${name}' is disabled for ${target} on ${platform}`
      );
    }
    return resolved;
  });
  const protocols = new Set(backends.map((backend) => backend.protocol));
  if (protocols.size !== 1) {
    throw new FailoverSchemaError(
      `failover route '${route.name}' resolves to different protocols for ${target} on ${platform}`
    );
  }
  return {
    schema: FAILOVER_SCHEMA,
    name: route.name,
    description: route.description,
    target,
    platform,
    protocol: backends[0].protocol,
    retry: structuredClone(route.retry),
    circuit: structuredClone(route.circuit),
    backends
  };
}
