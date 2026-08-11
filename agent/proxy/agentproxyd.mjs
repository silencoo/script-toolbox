#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ProviderSchemaError,
  validateAuthMode,
  validateEndpoint,
  validateModelId,
  validatePlatform,
  validateProfileName,
  validateProtocol,
  validateProviderSecrets,
  validateReferenceName,
  validateTarget
} from "../agentctl/provider-schema.mjs";
import {
  createPricingEngine,
  validatePricingCatalog
} from "../pricing/pricing.mjs";
import {
  mapNativeModelRequest,
  resolveExactModel
} from "./model-mapper.mjs";
import { UsageCollector } from "./usage.mjs";
import {
  CircuitRegistry,
  newCircuitState,
  validateCircuitState
} from "./circuit-breaker.mjs";

const CONFIG_KIND = "agentctl-proxy-config";
const CAPABILITY_KIND = "agentctl-proxy-capability";
const STATE_KIND = "agentctl-proxy-state";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PRICING_BYTES = 5 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);
const CLIENT_AUTH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-agentctl-proxy-token"
]);

class ProxyDaemonError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxyDaemonError";
  }
}

function usage() {
  process.stdout.write("Usage: agentproxyd --config <private-config.json>\n");
}

function parseArguments(argv) {
  let config = "";
  while (argv.length) {
    const argument = argv.shift();
    if (argument === "--config") {
      if (!argv.length) throw new ProxyDaemonError("--config requires a path");
      config = resolve(argv.shift());
    } else if (["--help", "-h"].includes(argument)) {
      usage();
      process.exit(0);
    } else {
      throw new ProxyDaemonError(`unknown argument '${argument}'`);
    }
  }
  if (!config) throw new ProxyDaemonError("--config is required");
  return config;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new ProxyDaemonError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ProxyDaemonError(`${label} contains unsupported field '${key}'`);
  }
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProxyDaemonError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validatePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 ||
      value.includes("\0")) {
    throw new ProxyDaemonError(`${label} must be a normalized absolute path`);
  }
  return resolve(value);
}

function validateConfig(value) {
  exactKeys(value, [
    "schema", "kind", "instance_id", "created_at", "profile", "target",
    "platform", "protocol", "route", "backends", "retry", "circuit",
    "compaction", "retention", "listen", "timeouts", "limits", "pricing", "paths"
  ], "proxy config");
  if (value.schema !== 4 || value.kind !== CONFIG_KIND ||
      typeof value.instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.instance_id) ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new ProxyDaemonError("proxy config identity is invalid");
  }
  validateProfileName(value.profile);
  validateTarget(value.target);
  validatePlatform(value.platform);
  validateProtocol(value.protocol);
  exactKeys(value.compaction, ["mode", "label", "responses_compact"], "proxy compaction");
  if (!["client_local", "remote_native", "messages_native"].includes(value.compaction.mode) ||
      typeof value.compaction.label !== "string" || value.compaction.label.length < 1 ||
      value.compaction.label.length > 100 ||
      typeof value.compaction.responses_compact !== "boolean" ||
      (value.compaction.responses_compact &&
       (value.protocol !== "openai_responses" || value.compaction.mode !== "remote_native"))) {
    throw new ProxyDaemonError("proxy compaction configuration is invalid");
  }
  if (value.route !== null &&
      (typeof value.route !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.route) ||
       value.route.length > 64)) {
    throw new ProxyDaemonError("proxy route must be null or a valid route name");
  }
  if (!Array.isArray(value.backends) || value.backends.length < 1 ||
      value.backends.length > 8) {
    throw new ProxyDaemonError("proxy backends must contain 1-8 entries");
  }
  const backendNames = new Set();
  for (const backend of value.backends) {
    exactKeys(backend, ["profile", "endpoint", "auth", "models"], "proxy backend");
    validateProfileName(backend.profile, "proxy backend profile");
    if (backendNames.has(backend.profile)) throw new ProxyDaemonError("proxy backend profiles must be unique");
    backendNames.add(backend.profile);
    backend.endpoint = validateEndpoint(backend.endpoint, "proxy backend endpoint");
    exactKeys(backend.auth, ["mode", "secret"], "proxy backend auth");
    validateAuthMode(backend.auth.mode);
    if (backend.auth.mode === "none") {
      if (backend.auth.secret !== null) {
        throw new ProxyDaemonError("unauthenticated proxy backend must not name a Secret");
      }
    } else {
      validateReferenceName(backend.auth.secret, "proxy backend Secret reference");
    }
    exactKeys(backend.models, ["default", "aliases"], "proxy backend models");
    validateModelId(backend.models.default, "proxy backend default model");
    if (!plainObject(backend.models.aliases) || Object.keys(backend.models.aliases).length > 256) {
      throw new ProxyDaemonError("proxy backend model aliases must have at most 256 entries");
    }
    for (const [requested, outbound] of Object.entries(backend.models.aliases)) {
      validateModelId(requested, "proxy requested model alias");
      validateModelId(outbound, `proxy outbound model alias '${requested}'`);
      resolveExactModel(backend.models, requested);
    }
    resolveExactModel(backend.models);
  }
  if (value.profile !== value.backends[0].profile) {
    throw new ProxyDaemonError("proxy primary profile must match the first backend");
  }
  if (value.route === null && value.backends.length !== 1) {
    throw new ProxyDaemonError("a proxy without a route must have exactly one backend");
  }
  exactKeys(value.retry, ["mode", "max_attempts", "status_codes", "network_errors"], "proxy retry policy");
  if (!["next_request", "same_request"].includes(value.retry.mode)) {
    throw new ProxyDaemonError("proxy retry mode must be next_request or same_request");
  }
  boundedInteger(value.retry.max_attempts, "proxy max attempts", 1, value.backends.length);
  if (!Array.isArray(value.retry.status_codes) || value.retry.status_codes.length > 32 ||
      new Set(value.retry.status_codes).size !== value.retry.status_codes.length) {
    throw new ProxyDaemonError("proxy retry status codes must be a unique array");
  }
  for (const status of value.retry.status_codes) {
    boundedInteger(status, "proxy retry status", 400, 599);
  }
  if (typeof value.retry.network_errors !== "boolean") {
    throw new ProxyDaemonError("proxy retry network_errors must be boolean");
  }
  exactKeys(value.circuit, [
    "enabled", "failure_threshold", "recovery_timeout_ms",
    "half_open_max_requests", "state_retention_days"
  ], "proxy circuit policy");
  if (typeof value.circuit.enabled !== "boolean") {
    throw new ProxyDaemonError("proxy circuit enabled must be boolean");
  }
  boundedInteger(value.circuit.failure_threshold, "circuit failure threshold", 1, 20);
  boundedInteger(value.circuit.recovery_timeout_ms, "circuit recovery timeout", 1000, 3600000);
  boundedInteger(value.circuit.half_open_max_requests, "circuit half-open max", 1, 5);
  boundedInteger(value.circuit.state_retention_days, "circuit state retention", 1, 365);
  if (value.route === null && value.circuit.enabled) {
    throw new ProxyDaemonError("single-backend proxy circuit must be disabled");
  }
  exactKeys(value.retention, ["files", "max_age_days"], "proxy log retention");
  boundedInteger(value.retention.files, "proxy retention files", 1, 20);
  boundedInteger(value.retention.max_age_days, "proxy retention days", 1, 365);
  exactKeys(value.listen, ["host", "port"], "proxy config listen");
  if (value.listen.host !== "127.0.0.1" && value.listen.host !== "::1") {
    throw new ProxyDaemonError("proxy listener must use an explicit loopback address");
  }
  boundedInteger(value.listen.port, "proxy port", 1024, 65535);
  exactKeys(value.timeouts, ["first_byte_ms", "stream_idle_ms", "request_ms"], "proxy timeouts");
  boundedInteger(value.timeouts.first_byte_ms, "first-byte timeout", 100, 600000);
  boundedInteger(value.timeouts.stream_idle_ms, "stream idle timeout", 1000, 3600000);
  boundedInteger(value.timeouts.request_ms, "request timeout", 1000, 3600000);
  exactKeys(value.limits, [
    "request_bytes", "log_bytes", "usage_log_bytes", "usage_capture_bytes"
  ], "proxy limits");
  boundedInteger(value.limits.request_bytes, "request byte limit", 1024, 64 * 1024 * 1024);
  boundedInteger(value.limits.log_bytes, "log byte limit", 65536, 100 * 1024 * 1024);
  boundedInteger(value.limits.usage_log_bytes, "usage log byte limit", 65536, 100 * 1024 * 1024);
  boundedInteger(value.limits.usage_capture_bytes, "usage capture byte limit", 1024, 16 * 1024 * 1024);
  exactKeys(value.pricing, ["catalog", "model_source"], "proxy pricing");
  value.pricing.catalog = validatePath(value.pricing.catalog, "proxy pricing catalog path");
  if (!["request", "response"].includes(value.pricing.model_source)) {
    throw new ProxyDaemonError("proxy pricing model_source must be request or response");
  }
  exactKeys(value.paths, [
    "state", "lock", "capability", "secrets", "log", "usage_log",
    "circuit_state", "runtime_log"
  ], "proxy paths");
  for (const [name, path] of Object.entries(value.paths)) {
    value.paths[name] = validatePath(path, `proxy ${name} path`);
  }
  return value;
}

async function readPrivateJson(path, label, validator) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new ProxyDaemonError(`${label} not found: ${path}`);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_CONFIG_BYTES) {
    throw new ProxyDaemonError(`${label} must be a small regular non-symlink file`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ProxyDaemonError(`${label} must be owner-only`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProxyDaemonError(`${label} is not valid JSON`);
    throw error;
  }
  return validator(value);
}

async function readPricingCatalog(path) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_PRICING_BYTES) {
    throw new ProxyDaemonError("pricing catalog must be a small regular non-symlink file");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProxyDaemonError("pricing catalog is not valid JSON");
    throw error;
  }
  return validatePricingCatalog(value);
}

async function readCircuitState(path) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return newCircuitState();
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_CONFIG_BYTES) {
    throw new ProxyDaemonError("circuit state must be a small regular non-symlink file");
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ProxyDaemonError("circuit state must be owner-only");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProxyDaemonError("circuit state is not valid JSON");
    throw error;
  }
  return validateCircuitState(value);
}

function circuitPersister(path, registry) {
  let queue = Promise.resolve();
  return () => {
    const snapshot = registry.snapshot();
    queue = queue.catch(() => {}).then(() => writeJsonAtomic(path, snapshot));
    return queue;
  };
}

function validateCapability(value) {
  exactKeys(value, ["schema", "kind", "created_at", "token"], "proxy capability");
  if (value.schema !== 1 || value.kind !== CAPABILITY_KIND ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) {
    throw new ProxyDaemonError("proxy capability is invalid");
  }
  return value;
}

async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
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

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function clientToken(request) {
  const dedicated = request.headers["x-agentctl-proxy-token"];
  if (typeof dedicated === "string") return dedicated;
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && /^Bearer /i.test(authorization)) {
    return authorization.slice(7).trim();
  }
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = request.headers[name];
    if (typeof value === "string") return value;
  }
  return "";
}

function allowedRoute(protocol, method, pathname, { responsesCompact = false } = {}) {
  if (method === "GET" && pathname === "/v1/models") return true;
  if (protocol === "anthropic_messages") {
    return method === "POST" && [
      "/v1/messages", "/v1/messages/count_tokens"
    ].includes(pathname);
  }
  if (protocol === "openai_responses") {
    return method === "POST" && (pathname === "/v1/responses" ||
      (responsesCompact && pathname === "/v1/responses/compact"));
  }
  if (protocol === "openai_chat") {
    return method === "POST" && pathname === "/v1/chat/completions";
  }
  return (method === "POST" &&
      /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(pathname)) ||
    (method === "GET" && pathname === "/v1beta/models");
}

function joinUpstream(endpoint, localUrl) {
  const upstream = new URL(endpoint);
  const incomingPath = localUrl.pathname;
  let suffix = incomingPath;
  for (const prefix of ["/v1beta", "/v1"]) {
    if (upstream.pathname.replace(/\/$/, "").endsWith(prefix) &&
        incomingPath.startsWith(`${prefix}/`)) {
      suffix = incomingPath.slice(prefix.length);
      break;
    }
  }
  upstream.pathname = `${upstream.pathname.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
  const query = new URLSearchParams(upstream.search);
  for (const [name, value] of localUrl.searchParams) query.append(name, value);
  upstream.search = query.toString();
  upstream.hash = "";
  return upstream;
}

function upstreamHeaders(request, protocol, backend, secret, bodyLength = undefined) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || CLIENT_AUTH_HEADERS.has(lower) ||
        [
          "accept-encoding", "content-length", "content-encoding",
          "content-md5", "digest"
        ].includes(lower)) continue;
    if (value !== undefined) headers[lower] = value;
  }
  headers["accept-encoding"] = "identity";
  headers["user-agent"] = "agentproxyd/4";
  if (Number.isSafeInteger(bodyLength)) headers["content-length"] = String(bodyLength);
  if (backend.auth.mode === "bearer") headers.authorization = `Bearer ${secret}`;
  if (backend.auth.mode === "x-api-key") headers["x-api-key"] = secret;
  if (backend.auth.mode === "x-goog-api-key") headers["x-goog-api-key"] = secret;
  if (protocol === "anthropic_messages" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function validateState(value, instanceId = "") {
  exactKeys(value, [
    "schema", "kind", "instance_id", "pid", "started_at", "host", "port",
    "profile", "target", "protocol", "config", "route", "backend_profiles", "compaction"
  ], "proxy state");
  if (value.schema !== 1 || value.kind !== STATE_KIND ||
      (instanceId && value.instance_id !== instanceId) ||
      !Number.isInteger(value.pid) || value.pid < 1 ||
      (value.route !== undefined && value.route !== null && typeof value.route !== "string") ||
      (value.backend_profiles !== undefined &&
       (!Array.isArray(value.backend_profiles) ||
        value.backend_profiles.some((profile) => typeof profile !== "string"))) ||
      !plainObject(value.compaction) ||
      typeof value.compaction.responses_compact !== "boolean" ||
      !["client_local", "remote_native", "messages_native"].includes(value.compaction.mode)) {
    throw new ProxyDaemonError("proxy state is invalid");
  }
  for (const profile of value.backend_profiles || []) validateProfileName(profile);
  return value;
}

async function removeOwnedState(config) {
  try {
    const value = JSON.parse(await readFile(config.paths.state, "utf8"));
    validateState(value, config.instance_id);
    await unlink(config.paths.state);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof ProxyDaemonError)) throw error;
  }
}

async function logDetails(path, label) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ProxyDaemonError(`${label} is not a regular file`);
    }
    return details;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function rotateLog(path, retention, label) {
  if (retention.files === 1) {
    await rm(path, { force: true });
    return;
  }
  for (let index = retention.files - 1; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    const details = await logDetails(source, label);
    await rm(destination, { force: true });
    if (details) {
      await rename(source, destination);
      await chmod(destination, 0o600);
    }
  }
}

async function pruneLogs(path, retention, label) {
  const cutoff = Date.now() - retention.max_age_days * 86400000;
  for (let index = 1; index < retention.files; index += 1) {
    const rotated = `${path}.${index}`;
    const details = await logDetails(rotated, label);
    if (details && details.mtimeMs < cutoff) await unlink(rotated);
  }
  for (let index = retention.files; index <= 20; index += 1) {
    const stale = `${path}.${index}`;
    const details = await logDetails(stale, label);
    if (details) await unlink(stale);
  }
}

function jsonlLogger(path, maxBytes, retention, label) {
  let queue = Promise.resolve();
  const append = (record) => {
    queue = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await pruneLogs(path, retention, label);
      const details = await logDetails(path, label);
      const expired = details &&
        details.mtimeMs < Date.now() - retention.max_age_days * 86400000;
      if (details && (details.size >= maxBytes || expired)) {
        await rotateLog(path, retention, label);
      }
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    }).catch(() => {});
  };
  append.flush = () => queue;
  return append;
}

function collectRequestBody(request, maxBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (code) => {
      if (settled) return;
      settled = true;
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      const error = new Error(code);
      error.code = code;
      rejectPromise(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail("request_too_large");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise({ body: Buffer.concat(chunks), bytes });
    });
    request.on("aborted", () => fail("client_aborted"));
    request.on("error", () => fail("client_request_error"));
  });
}

function priceUsage(pricing, config, backend, mapping, extracted, at) {
  const responseModel = extracted?.response_model || null;
  const candidates = [];
  if (config.pricing.model_source === "response" && responseModel) {
    candidates.push({ model: responseModel, source: "response", fallback: null });
  }
  if (mapping?.outbound_model &&
      !candidates.some((candidate) => candidate.model === mapping.outbound_model)) {
    candidates.push({
      model: mapping.outbound_model,
      source: config.pricing.model_source === "response" ? "request_fallback" : "request",
      fallback: config.pricing.model_source === "response"
        ? (responseModel ? "response_model_unpriced" : "response_model_missing")
        : null
    });
  }
  const primary = candidates[0] || null;
  if (!extracted?.usage) {
    return {
      pricing_model: primary?.model || null,
      pricing_model_source: primary?.source || config.pricing.model_source,
      pricing_fallback_reason: primary?.fallback || null,
      cost: null,
      pricing_unavailable: "usage_missing"
    };
  }
  if (!pricing) {
    return {
      pricing_model: primary?.model || null,
      pricing_model_source: primary?.source || config.pricing.model_source,
      pricing_fallback_reason: primary?.fallback || null,
      cost: null,
      pricing_unavailable: "catalog_missing"
    };
  }
  for (const candidate of candidates) {
    let quote;
    try {
      quote = pricing.quote({
        profile: backend.profile,
        model: candidate.model,
        at
      }, extracted.usage);
    } catch {
      quote = null;
    }
    if (!quote) continue;
    const cost = quote.cost;
    if (candidate.fallback) {
      cost.estimate_reason = `catalog_calculation_${candidate.fallback}`;
    }
    return {
      pricing_model: candidate.model,
      pricing_model_source: candidate.source,
      pricing_fallback_reason: candidate.fallback,
      cost,
      pricing_unavailable: null
    };
  }
  return {
    pricing_model: primary?.model || null,
    pricing_model_source: primary?.source || config.pricing.model_source,
    pricing_fallback_reason: primary?.fallback || null,
    cost: null,
    pricing_unavailable: "rate_not_found"
  };
}

function usageRecord({
  config,
  backend,
  pricing,
  mapping,
  extracted,
  requestId,
  requestStartedAt,
  started,
  status
}) {
  const priced = priceUsage(pricing, config, backend, mapping, extracted, requestStartedAt);
  return {
    schema: 1,
    timestamp: new Date().toISOString(),
    request_id: requestId,
    profile: backend.profile,
    route: config.route,
    target: config.target,
    protocol: config.protocol,
    status,
    duration_ms: Date.now() - started,
    requested_model: mapping?.requested_model || null,
    outbound_model: mapping?.outbound_model || null,
    response_model: extracted?.response_model || null,
    pricing_model: priced.pricing_model,
    pricing_model_source: priced.pricing_model_source,
    pricing_fallback_reason: priced.pricing_fallback_reason,
    usage_source: extracted?.source || null,
    usage: extracted?.usage || null,
    cost: priced.cost,
    pricing_unavailable: priced.pricing_unavailable
  };
}

function runUpstreamAttempt({
  request,
  response,
  config,
  backend,
  secret,
  localUrl,
  rawBody,
  allowRetry
}) {
  const attemptStarted = Date.now();
  const mapping = mapNativeModelRequest({
    protocol: config.protocol,
    method: request.method || "",
    pathname: localUrl.pathname,
    body: rawBody,
    models: backend.models
  });
  const mappedUrl = new URL(localUrl);
  mappedUrl.pathname = mapping.pathname;
  const destination = joinUpstream(backend.endpoint, mappedUrl);
  const transport = destination.protocol === "https:" ? httpsRequest : httpRequest;
  const requestBody = mapping.body ?? rawBody;

  return new Promise((resolveAttempt) => {
    let complete = false;
    let upstream;
    let upstreamResponse = null;
    let firstByteTimer;
    let totalTimer;
    let idleTimer;
    let failureCode = "";
    let bytesOut = 0;
    let cleared = false;

    const clearMappedBody = () => {
      if (cleared) return;
      cleared = true;
      if (requestBody !== rawBody) requestBody.fill(0);
    };
    const clearTimers = () => {
      clearTimeout(firstByteTimer);
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    };
    const cleanup = () => {
      clearTimers();
      request.off("aborted", onClientAborted);
      response.off("close", onClientClosed);
      response.off("drain", onDrain);
    };
    const finish = (result) => {
      if (complete) return;
      complete = true;
      cleanup();
      resolveAttempt({
        ...result,
        profile: backend.profile,
        mapping,
        bytes_out: bytesOut,
        duration_ms: Date.now() - attemptStarted
      });
    };
    const fail = (code) => {
      if (complete) return;
      failureCode = code;
      upstream?.destroy(new Error(code));
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail("stream_idle_timeout"), config.timeouts.stream_idle_ms);
      idleTimer.unref?.();
    };
    const onDrain = () => upstreamResponse?.resume();
    const onClientAborted = () => fail("client_aborted");
    const onClientClosed = () => {
      if (!response.writableEnded) {
        upstreamResponse?.destroy();
        fail("client_disconnected");
      }
    };

    request.on("aborted", onClientAborted);
    response.on("close", onClientClosed);
    response.on("drain", onDrain);

    try {
      upstream = transport({
        protocol: destination.protocol,
        hostname: destination.hostname,
        port: destination.port || undefined,
        method: request.method,
        path: `${destination.pathname}${destination.search}`,
        headers: upstreamHeaders(
          request,
          config.protocol,
          backend,
          secret,
          request.method === "GET" ? undefined : requestBody.length
        )
      }, (incoming) => {
        upstreamResponse = incoming;
        clearTimeout(firstByteTimer);
        const status = incoming.statusCode || 502;
        const retryStatus = config.retry.status_codes.includes(status);
        if (allowRetry && retryStatus) {
          incoming.destroy();
          finish({
            kind: "retry",
            status,
            outcome: "retry_status",
            failure: true,
            network_error: false,
            extracted: null
          });
          return;
        }
        const streaming = String(incoming.headers["content-type"] || "")
          .toLowerCase().includes("text/event-stream");
        const collector = new UsageCollector(config.protocol, {
          contentType: incoming.headers["content-type"] || "",
          maxJsonBytes: config.limits.usage_capture_bytes,
          maxSseEventBytes: config.limits.usage_capture_bytes
        });
        if (streaming) clearTimeout(totalTimer);
        response.writeHead(status, responseHeaders(incoming.headers));
        resetIdle();
        incoming.on("data", (chunk) => {
          bytesOut += chunk.length;
          collector.feed(chunk);
          resetIdle();
          if (!response.write(chunk)) incoming.pause();
        });
        incoming.on("end", () => {
          clearTimeout(idleTimer);
          let extracted = null;
          try { extracted = collector.finish(); } catch {}
          response.end();
          finish({
            kind: "response",
            status,
            outcome: "upstream_response",
            failure: retryStatus,
            network_error: false,
            extracted
          });
        });
        incoming.on("error", () => fail("upstream_response_error"));
      });
    } catch {
      clearMappedBody();
      finish({
        kind: "failure",
        status: 502,
        outcome: "upstream_request_error",
        failure: config.retry.network_errors,
        network_error: true,
        extracted: null
      });
      return;
    }

    firstByteTimer = setTimeout(() => fail("first_byte_timeout"), config.timeouts.first_byte_ms);
    totalTimer = setTimeout(() => fail("request_timeout"), config.timeouts.request_ms);
    firstByteTimer.unref?.();
    totalTimer.unref?.();

    upstream.on("error", () => {
      clearMappedBody();
      if (complete) return;
      const code = failureCode || "upstream_error";
      const status = code.includes("timeout") ? 504 :
        code.startsWith("client_") ? 499 : 502;
      const retry = allowRetry && config.retry.network_errors &&
        !code.startsWith("client_") && !response.headersSent;
      if (retry) {
        finish({
          kind: "retry",
          status,
          outcome: code,
          failure: true,
          network_error: true,
          extracted: null
        });
        return;
      }
      if (!response.headersSent && status !== 499) sendJson(response, status, { error: code });
      else if (response.headersSent && status !== 499) response.destroy();
      finish({
        kind: "failure",
        status,
        outcome: code,
        failure: config.retry.network_errors && !code.startsWith("client_"),
        network_error: !code.startsWith("client_"),
        extracted: null
      });
    });
    upstream.once("finish", clearMappedBody);
    upstream.end(requestBody);
  });
}

async function proxyRequest(request, response, context) {
  const {
    config,
    capability,
    backendSecrets,
    pricing,
    circuits,
    persistCircuits,
    log,
    usageLog
  } = context;
  const started = Date.now();
  const requestStartedAt = new Date().toISOString();
  const requestId = randomUUID();
  const attempts = [];
  let localUrl;
  try {
    localUrl = new URL(request.url, `http://${config.listen.host}:${config.listen.port}`);
  } catch {
    sendJson(response, 400, { error: "invalid_request_target" });
    return;
  }

  if (request.method === "GET" && localUrl.pathname === "/__agentctl/health") {
    if (!safeTokenEqual(clientToken(request), capability.token)) {
      sendJson(response, 401, { error: "proxy_authentication_required" });
      return;
    }
    const circuitStates = config.circuit.enabled
      ? config.backends.map((backend) => circuits.inspect(backend.profile, config.target))
      : [];
    if (config.circuit.enabled) await persistCircuits().catch(() => {});
    sendJson(response, 200, {
      schema: 1,
      kind: "agentctl-proxy-health",
      instance_id: config.instance_id,
      profile: config.profile,
      route: config.route,
      backends: config.backends.map((backend) => backend.profile),
      circuits: circuitStates,
      target: config.target,
      protocol: config.protocol,
      compaction: config.compaction,
      pricing_catalog_version: pricing?.version || null,
      pricing_model_source: config.pricing.model_source
    });
    return;
  }

  const finishMetadata = (status, outcome, bytesIn = 0, bytesOut = 0) => {
    log({
      schema: 1,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      profile: config.profile,
      failover_route: config.route,
      target: config.target,
      protocol: config.protocol,
      method: request.method || "",
      route: localUrl.pathname,
      status,
      outcome,
      duration_ms: Date.now() - started,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      attempts
    });
  };

  if (!safeTokenEqual(clientToken(request), capability.token)) {
    sendJson(response, 401, { error: "proxy_authentication_required" });
    finishMetadata(401, "client_auth_failed");
    request.resume();
    return;
  }
  if (!allowedRoute(config.protocol, request.method || "", localUrl.pathname, {
    responsesCompact: config.compaction.responses_compact
  })) {
    sendJson(response, 404, { error: "route_not_available_for_proxy_protocol" });
    finishMetadata(404, "route_rejected");
    request.resume();
    return;
  }

  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > config.limits.request_bytes) {
    sendJson(response, 413, { error: "request_body_too_large" });
    finishMetadata(413, "request_too_large");
    request.resume();
    return;
  }
  const contentEncoding = String(request.headers["content-encoding"] || "")
    .trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    sendJson(response, 415, { error: "request_content_encoding_not_supported" });
    finishMetadata(415, "request_encoding_rejected");
    request.resume();
    return;
  }

  let collected;
  try {
    collected = await collectRequestBody(request, config.limits.request_bytes);
  } catch (error) {
    const outcome = error?.code || "client_request_error";
    const status = outcome === "request_too_large" ? 413 : 400;
    sendJson(response, status, { error: outcome });
    finishMetadata(status, outcome);
    return;
  }

  const sameRequest = config.retry.mode === "same_request";
  const maxAttempts = sameRequest ? config.retry.max_attempts : 1;
  let attempted = 0;
  try {
    for (let index = 0; index < config.backends.length && attempted < maxAttempts; index += 1) {
      const backend = config.backends[index];
      const reservation = config.circuit.enabled
        ? circuits.reserve(backend.profile, config.target)
        : { allowed: true, state: { state: "disabled" } };
      if (!reservation.allowed) {
        attempts.push({
          profile: backend.profile,
          outcome: reservation.state.state === "open"
            ? "circuit_open"
            : "half_open_busy",
          circuit: reservation.state.state,
          status: null,
          duration_ms: 0
        });
        continue;
      }
      if (config.circuit.enabled) await persistCircuits().catch(() => {});
      attempted += 1;
      const laterAvailable = config.backends.slice(index + 1).some((candidate) =>
        !config.circuit.enabled || circuits.inspect(candidate.profile, config.target).state !== "open"
      );
      const allowRetry = sameRequest && attempted < maxAttempts && laterAvailable;
      let result;
      try {
        result = await runUpstreamAttempt({
          request,
          response,
          config,
          backend,
          secret: backendSecrets.get(backend.profile) || "",
          localUrl,
          rawBody: collected.body,
          allowRetry
        });
      } catch {
        collected.body.fill(0);
        sendJson(response, 400, { error: "invalid_model_request" });
        finishMetadata(400, "model_request_invalid", collected.bytes);
        return;
      }
      attempts.push({
        profile: backend.profile,
        outcome: result.outcome,
        circuit: reservation.state.state,
        status: result.status,
        duration_ms: result.duration_ms
      });
      if (config.circuit.enabled) {
        if (result.failure) circuits.failure(backend.profile, config.target);
        else if (result.kind === "response") circuits.success(backend.profile, config.target);
        else circuits.release(backend.profile, config.target);
        await persistCircuits().catch(() => {});
      }
      if (result.kind === "retry") continue;
      if (result.kind === "response" && (result.mapping.requested_model || result.extracted)) {
        usageLog(usageRecord({
          config,
          backend,
          pricing,
          mapping: result.mapping,
          extracted: result.extracted,
          requestId,
          requestStartedAt,
          started,
          status: result.status
        }));
      }
      finishMetadata(result.status, result.outcome, collected.bytes, result.bytes_out);
      return;
    }
    const outcome = attempted === 0 ? "all_backends_unavailable" : "failover_exhausted";
    sendJson(response, 503, { error: outcome });
    finishMetadata(503, outcome, collected.bytes);
  } finally {
    collected.body.fill(0);
  }
}

async function acquireLock(config) {
  await mkdir(dirname(config.paths.lock), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(config.paths.lock, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      schema: 1,
      kind: "agentctl-proxy-lock",
      instance_id: config.instance_id,
      pid: process.pid,
      created_at: new Date().toISOString()
    })}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") throw new ProxyDaemonError("another proxy instance owns the runtime lock");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function run(configPath) {
  const config = await readPrivateJson(configPath, "proxy config", validateConfig);
  const capability = await readPrivateJson(
    config.paths.capability,
    "proxy capability",
    validateCapability
  );
  const secrets = await readPrivateJson(
    config.paths.secrets,
    "provider Secret Store",
    validateProviderSecrets
  );
  const backendSecrets = new Map();
  for (const backend of config.backends) {
    const secret = backend.auth.mode === "none"
      ? ""
      : secrets.secrets[backend.auth.secret]?.value;
    if (backend.auth.mode !== "none" && !secret) {
      throw new ProxyDaemonError(`provider Secret '${backend.auth.secret}' is unavailable`);
    }
    backendSecrets.set(backend.profile, secret);
  }
  const catalog = await readPricingCatalog(config.pricing.catalog);
  const pricing = catalog ? createPricingEngine(catalog) : null;
  const circuitState = config.circuit.enabled
    ? await readCircuitState(config.paths.circuit_state)
    : newCircuitState();
  const circuits = new CircuitRegistry(config.circuit, circuitState);
  const persistCircuits = config.circuit.enabled
    ? circuitPersister(config.paths.circuit_state, circuits)
    : async () => {};

  await acquireLock(config);
  const log = jsonlLogger(
    config.paths.log,
    config.limits.log_bytes,
    config.retention,
    "proxy metadata log"
  );
  const usageLog = jsonlLogger(
    config.paths.usage_log,
    config.limits.usage_log_bytes,
    config.retention,
    "proxy usage log"
  );
  const sockets = new Set();
  let shuttingDown = false;
  const server = createServer((request, response) => {
    void proxyRequest(request, response, {
      config,
      capability,
      backendSecrets,
      pricing,
      circuits,
      persistCircuits,
      log,
      usageLog
    }).catch(() => {
      request.resume();
      if (!response.headersSent) sendJson(response, 500, { error: "proxy_request_failed" });
      else response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const cleanup = async () => {
    await removeOwnedState(config).catch(() => {});
    try {
      const lock = JSON.parse(await readFile(config.paths.lock, "utf8"));
      if (lock.instance_id === config.instance_id) await unlink(config.paths.lock);
    } catch {}
  };
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceTimer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2000);
    forceTimer.unref?.();
    server.close(async () => {
      clearTimeout(forceTimer);
      await Promise.all([log.flush(), usageLog.flush()]);
      await cleanup();
      process.exit(exitCode);
    });
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen({
      host: config.listen.host,
      port: config.listen.port,
      exclusive: true
    }, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  }).catch(async (error) => {
    await cleanup();
    throw error;
  });

  const state = {
    schema: 1,
    kind: STATE_KIND,
    instance_id: config.instance_id,
    pid: process.pid,
    started_at: new Date().toISOString(),
    host: config.listen.host,
    port: config.listen.port,
    profile: config.profile,
    target: config.target,
    protocol: config.protocol,
    compaction: config.compaction,
    route: config.route,
    backend_profiles: config.backends.map((backend) => backend.profile),
    config: configPath
  };
  try {
    await writeJsonAtomic(config.paths.state, state);
  } catch (error) {
    await new Promise((resolveClose) => server.close(resolveClose));
    await cleanup();
    throw error;
  }
  log({
    schema: 1,
    timestamp: new Date().toISOString(),
    event: "proxy_started",
    instance_id: config.instance_id,
    profile: config.profile,
    route: config.route,
    backends: config.backends.map((backend) => backend.profile),
    target: config.target,
    protocol: config.protocol,
    host: config.listen.host,
    port: config.listen.port,
    pricing_catalog_version: catalog?.version || null
  });
  process.stdout.write("READY\n");
}

export async function main(argv = process.argv.slice(2)) {
  return run(parseArguments([...argv]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof ProxyDaemonError || error instanceof ProviderSchemaError
      ? error.message
      : "unexpected proxy daemon failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export {
  allowedRoute,
  jsonlLogger,
  joinUpstream,
  pruneLogs,
  rotateLog,
  upstreamHeaders,
  validateConfig
};
