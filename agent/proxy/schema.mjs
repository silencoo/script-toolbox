import { isAbsolute, resolve } from "node:path";

import {
  validateAuthMode,
  validateEndpoint,
  validateModelId,
  validatePlatform,
  validateProfileName,
  validateProtocol,
  validateReferenceName,
  validateTarget
} from "../agentctl/provider-schema.mjs";
import { resolveExactModel } from "./model-mapper.mjs";

export const PROXY_CONFIG_SCHEMA = 6;
export const PROXY_CONFIG_KIND = "agentctl-proxy-config";
export const PROXY_CAPABILITY_KIND = "agentctl-proxy-capability";
export const PROXY_STATE_KIND = "agentctl-proxy-state";
export const PROXY_LOCK_KIND = "agentctl-proxy-lock";
export const PROVIDER_MODE = "provider";
export const PASSTHROUGH_MODE = "openai_subscription_passthrough";
export const OPENAI_SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex";
export const OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH = "/backend-api/codex/realtime";

export class ProxySchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxySchemaError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new ProxySchemaError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProxySchemaError(`${label} contains unsupported field '${key}'`);
    }
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProxySchemaError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function validateProxyInstance(value, label = "proxy instance") {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new ProxySchemaError(
      `${label} must use lowercase letters, numbers, and single hyphens`
    );
  }
  return value;
}

export function validateProxyPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 ||
      value.includes("\0")) {
    throw new ProxySchemaError(`${label} must be a normalized absolute path`);
  }
  return resolve(value);
}

export function validateProxyCapability(value) {
  exactKeys(value, ["schema", "kind", "created_at", "token"], "proxy capability");
  if (value.schema !== 1 || value.kind !== PROXY_CAPABILITY_KIND ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new ProxySchemaError("proxy capability is invalid");
  }
  return value;
}

function validateCompaction(value, protocol, label = "proxy compaction") {
  exactKeys(value, ["mode", "label", "responses_compact"], label);
  if (!["client_local", "remote_native", "messages_native"].includes(value.mode) ||
      typeof value.label !== "string" || value.label.length < 1 || value.label.length > 100 ||
      typeof value.responses_compact !== "boolean" ||
      (value.responses_compact &&
       (protocol !== "openai_responses" || value.mode !== "remote_native"))) {
    throw new ProxySchemaError(`${label} configuration is invalid`);
  }
  return value;
}

function validateSourcePath(value, label) {
  if (value === null) return null;
  return validateProxyPath(value, label);
}

export function validateProxyConfig(value) {
  exactKeys(value, [
    "schema", "kind", "instance", "instance_id", "created_at", "mode", "profile",
    "target", "platform", "protocol", "route", "backends", "retry", "circuit",
    "compaction", "retention", "listen", "timeouts", "limits", "pricing", "paths",
    "sources"
  ], "proxy config");
  if (value.schema !== PROXY_CONFIG_SCHEMA || value.kind !== PROXY_CONFIG_KIND ||
      typeof value.instance_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.instance_id) ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new ProxySchemaError("proxy config identity is invalid");
  }
  validateProxyInstance(value.instance);
  if (![PROVIDER_MODE, PASSTHROUGH_MODE].includes(value.mode)) {
    throw new ProxySchemaError("proxy mode is invalid");
  }
  validateProfileName(value.profile);
  validateTarget(value.target);
  validatePlatform(value.platform);
  validateProtocol(value.protocol);
  validateCompaction(value.compaction, value.protocol);
  if (value.route !== null &&
      (typeof value.route !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.route) ||
       value.route.length > 64)) {
    throw new ProxySchemaError("proxy route must be null or a valid route name");
  }
  if (!Array.isArray(value.backends) || value.backends.length < 1 ||
      value.backends.length > 8) {
    throw new ProxySchemaError("proxy backends must contain 1-8 entries");
  }
  const backendNames = new Set();
  for (const backend of value.backends) {
    exactKeys(backend, ["profile", "endpoint", "auth", "models"], "proxy backend");
    validateProfileName(backend.profile, "proxy backend profile");
    if (backendNames.has(backend.profile)) {
      throw new ProxySchemaError("proxy backend profiles must be unique");
    }
    backendNames.add(backend.profile);
    backend.endpoint = validateEndpoint(backend.endpoint, "proxy backend endpoint");
    exactKeys(backend.auth, ["mode", "secret"], "proxy backend auth");
    if (backend.auth.mode === "openai_passthrough") {
      if (value.mode !== PASSTHROUGH_MODE || backend.auth.secret !== null) {
        throw new ProxySchemaError(
          "OpenAI passthrough authentication is limited to passthrough mode"
        );
      }
    } else {
      validateAuthMode(backend.auth.mode);
    }
    if (["none", "openai_passthrough"].includes(backend.auth.mode)) {
      if (backend.auth.secret !== null) {
        throw new ProxySchemaError("unauthenticated proxy backend must not name a Secret");
      }
    } else {
      validateReferenceName(backend.auth.secret, "proxy backend Secret reference");
    }
    exactKeys(backend.models, ["default", "aliases"], "proxy backend models");
    validateModelId(backend.models.default, "proxy backend default model");
    if (!plainObject(backend.models.aliases) || Object.keys(backend.models.aliases).length > 256) {
      throw new ProxySchemaError("proxy backend model aliases must have at most 256 entries");
    }
    for (const [requested, outbound] of Object.entries(backend.models.aliases)) {
      validateModelId(requested, "proxy requested model alias");
      validateModelId(outbound, `proxy outbound model alias '${requested}'`);
      resolveExactModel(backend.models, requested);
    }
    resolveExactModel(backend.models);
  }
  if (value.profile !== value.backends[0].profile) {
    throw new ProxySchemaError("proxy primary profile must match the first backend");
  }
  if (value.route === null && value.backends.length !== 1) {
    throw new ProxySchemaError("a proxy without a route must have exactly one backend");
  }
  if (value.mode === PASSTHROUGH_MODE) {
    const backend = value.backends[0];
    const endpoint = new URL(backend.endpoint);
    const loopbackEndpoint = ["127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (value.target !== "codex" || value.protocol !== "openai_responses" ||
        value.route !== null || value.backends.length !== 1 ||
        backend.auth.mode !== "openai_passthrough" ||
        Object.keys(backend.models.aliases).length !== 0 ||
        (backend.endpoint !== OPENAI_SUBSCRIPTION_ENDPOINT && !loopbackEndpoint) ||
        value.compaction.mode !== "remote_native" || !value.compaction.responses_compact) {
      throw new ProxySchemaError(
        "OpenAI subscription passthrough requires one safe, unmapped Codex Responses backend"
      );
    }
  }
  exactKeys(value.retry, ["mode", "max_attempts", "status_codes", "network_errors"],
    "proxy retry policy");
  if (!["next_request", "same_request"].includes(value.retry.mode)) {
    throw new ProxySchemaError("proxy retry mode must be next_request or same_request");
  }
  boundedInteger(value.retry.max_attempts, "proxy max attempts", 1, value.backends.length);
  if (!Array.isArray(value.retry.status_codes) || value.retry.status_codes.length > 32 ||
      new Set(value.retry.status_codes).size !== value.retry.status_codes.length) {
    throw new ProxySchemaError("proxy retry status codes must be a unique array");
  }
  for (const status of value.retry.status_codes) {
    boundedInteger(status, "proxy retry status", 400, 599);
  }
  if (typeof value.retry.network_errors !== "boolean") {
    throw new ProxySchemaError("proxy retry network_errors must be boolean");
  }
  if (value.mode === PASSTHROUGH_MODE &&
      (value.retry.mode !== "next_request" || value.retry.max_attempts !== 1 ||
       value.retry.status_codes.length !== 0 || value.retry.network_errors)) {
    throw new ProxySchemaError("OpenAI subscription passthrough cannot retry or replay requests");
  }
  exactKeys(value.circuit, [
    "enabled", "failure_threshold", "recovery_timeout_ms", "half_open_max_requests",
    "state_retention_days"
  ], "proxy circuit policy");
  if (typeof value.circuit.enabled !== "boolean") {
    throw new ProxySchemaError("proxy circuit enabled must be boolean");
  }
  boundedInteger(value.circuit.failure_threshold, "circuit failure threshold", 1, 20);
  boundedInteger(value.circuit.recovery_timeout_ms, "circuit recovery timeout", 1000, 3600000);
  boundedInteger(value.circuit.half_open_max_requests, "circuit half-open max", 1, 5);
  boundedInteger(value.circuit.state_retention_days, "circuit state retention", 1, 365);
  if (value.route === null && value.circuit.enabled) {
    throw new ProxySchemaError("single-backend proxy circuit must be disabled");
  }
  exactKeys(value.retention, ["files", "max_age_days"], "proxy log retention");
  boundedInteger(value.retention.files, "proxy retention files", 1, 20);
  boundedInteger(value.retention.max_age_days, "proxy retention days", 1, 365);
  exactKeys(value.listen, ["host", "port"], "proxy config listen");
  if (!["127.0.0.1", "::1"].includes(value.listen.host)) {
    throw new ProxySchemaError("proxy listener must use an explicit loopback address");
  }
  boundedInteger(value.listen.port, "proxy port", 1024, 65535);
  exactKeys(value.timeouts, [
    "first_byte_ms", "stream_idle_ms", "request_ms", "request_body_ms"
  ], "proxy timeouts");
  boundedInteger(value.timeouts.first_byte_ms, "first-byte timeout", 100, 600000);
  boundedInteger(value.timeouts.stream_idle_ms, "stream idle timeout", 1000, 3600000);
  boundedInteger(value.timeouts.request_ms, "request timeout", 1000, 3600000);
  boundedInteger(value.timeouts.request_body_ms, "request-body timeout", 1000, 3600000);
  exactKeys(value.limits, [
    "request_bytes", "log_bytes", "usage_log_bytes", "usage_capture_bytes",
    "max_concurrent_requests", "max_inflight_request_bytes"
  ], "proxy limits");
  boundedInteger(value.limits.request_bytes, "request byte limit", 1024, 64 * 1024 * 1024);
  boundedInteger(value.limits.log_bytes, "log byte limit", 65536, 100 * 1024 * 1024);
  boundedInteger(value.limits.usage_log_bytes, "usage log byte limit", 65536,
    100 * 1024 * 1024);
  boundedInteger(value.limits.usage_capture_bytes, "usage capture byte limit", 1024,
    16 * 1024 * 1024);
  boundedInteger(value.limits.max_concurrent_requests, "maximum concurrent requests", 1, 1024);
  boundedInteger(value.limits.max_inflight_request_bytes, "maximum in-flight request bytes",
    value.limits.request_bytes, 1024 * 1024 * 1024);
  exactKeys(value.pricing, ["catalog", "model_source"], "proxy pricing");
  value.pricing.catalog = validateProxyPath(value.pricing.catalog,
    "proxy pricing catalog path");
  if (!["request", "response"].includes(value.pricing.model_source)) {
    throw new ProxySchemaError("proxy pricing model_source must be request or response");
  }
  exactKeys(value.paths, [
    "state", "lock", "capability", "secrets", "log", "usage_log", "circuit_state",
    "runtime_log"
  ], "proxy paths");
  for (const [name, path] of Object.entries(value.paths)) {
    value.paths[name] = validateProxyPath(path, `proxy ${name} path`);
  }
  exactKeys(value.sources, [
    "provider_store", "provider_secrets", "failover_store", "pricing_catalog"
  ], "proxy sources");
  for (const name of Object.keys(value.sources)) {
    value.sources[name] = validateSourcePath(value.sources[name], `proxy source ${name}`);
  }
  if (value.sources.pricing_catalog !== value.pricing.catalog ||
      value.sources.provider_secrets !==
        (value.mode === PROVIDER_MODE ? value.paths.secrets : null) ||
      (value.mode === PROVIDER_MODE && value.sources.provider_store === null) ||
      (value.route !== null && value.sources.failover_store === null) ||
      (value.route === null && value.sources.failover_store !== null)) {
    throw new ProxySchemaError("proxy source paths do not match the selected runtime mode");
  }
  const mutablePaths = Object.values(value.paths);
  if (new Set(mutablePaths).size !== mutablePaths.length) {
    throw new ProxySchemaError("proxy runtime paths must be distinct");
  }
  const sourcePaths = Object.values(value.sources).filter(Boolean);
  const writableRuntimePaths = Object.entries(value.paths)
    .filter(([name]) => name !== "secrets")
    .map(([, path]) => path);
  if (sourcePaths.some((path) => writableRuntimePaths.includes(path))) {
    throw new ProxySchemaError("proxy source and runtime paths must be distinct");
  }
  return value;
}

export function validateProxyState(value, instanceId = "") {
  exactKeys(value, [
    "schema", "kind", "instance", "instance_id", "pid", "started_at", "host", "port",
    "mode", "profile", "target", "protocol", "config", "route", "backend_profiles",
    "compaction", "local_base_url", "client_model"
  ], "proxy state");
  if (!plainObject(value)) throw new ProxySchemaError("proxy state is invalid");
  const normalized = {
    ...value,
    instance: value.instance ?? "default",
    backend_profiles: value.backend_profiles ??
      (typeof value.profile === "string" ? [value.profile] : []),
    client_model: value.client_model ??
      (typeof value.profile === "string" ? value.profile : "unknown")
  };
  if (normalized.schema !== 1 || normalized.kind !== PROXY_STATE_KIND ||
      (instanceId && value.instance_id !== instanceId) ||
      typeof normalized.instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(normalized.instance_id) ||
      !Number.isInteger(normalized.pid) || normalized.pid < 1 ||
      typeof normalized.started_at !== "string" ||
      Number.isNaN(Date.parse(normalized.started_at)) ||
      !["127.0.0.1", "::1"].includes(normalized.host) ||
      !Number.isInteger(normalized.port) || normalized.port < 1024 || normalized.port > 65535 ||
      ![PROVIDER_MODE, PASSTHROUGH_MODE].includes(normalized.mode) ||
      typeof normalized.config !== "string" || !isAbsolute(normalized.config) ||
      normalized.config.length > 4096 ||
      (normalized.route !== null && normalized.route !== undefined &&
       typeof normalized.route !== "string") ||
      !Array.isArray(normalized.backend_profiles) || normalized.backend_profiles.length < 1 ||
      normalized.backend_profiles.some((profile) => typeof profile !== "string") ||
      typeof normalized.client_model !== "string" || normalized.client_model.length < 1 ||
      normalized.client_model.length > 240) {
    throw new ProxySchemaError("proxy state is invalid");
  }
  validateProxyInstance(normalized.instance);
  validateProfileName(normalized.profile);
  validateTarget(normalized.target);
  validateProtocol(normalized.protocol);
  for (const profile of normalized.backend_profiles) validateProfileName(profile);
  validateCompaction(normalized.compaction, normalized.protocol, "proxy state compaction");
  if (normalized.local_base_url !== undefined) {
    if (normalized.mode !== PASSTHROUGH_MODE || typeof normalized.local_base_url !== "string" ||
        !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/backend-api\/codex\/realtime$/.test(
          normalized.local_base_url
        )) {
      throw new ProxySchemaError("proxy state local base URL is invalid");
    }
  }
  return normalized;
}
