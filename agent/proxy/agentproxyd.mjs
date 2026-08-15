#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
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
import * as zlib from "node:zlib";

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
  normalizePricingServiceTier,
  validatePricingCatalog
} from "../pricing/pricing.mjs";
import {
  mapNativeModelRequest,
  resolveExactModel
} from "./model-mapper.mjs";
import { UsageCollector, extractUsage } from "./usage.mjs";
import {
  CircuitRegistry,
  newCircuitState,
  validateCircuitState
} from "./circuit-breaker.mjs";

const CONFIG_KIND = "agentctl-proxy-config";
const CAPABILITY_KIND = "agentctl-proxy-capability";
const STATE_KIND = "agentctl-proxy-state";
const PASSTHROUGH_MODE = "openai_subscription_passthrough";
const PROVIDER_MODE = "provider";
const OPENAI_SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex";
const OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH = "/backend-api/codex/realtime";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PRICING_BYTES = 5 * 1024 * 1024;
const LOG_MAINTENANCE_MS = 60_000;
const LOG_MAX_QUEUE = 2048;
const CIRCUIT_PERSIST_DELAY_MS = 50;
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
    "schema", "kind", "instance_id", "created_at", "mode", "profile", "target",
    "platform", "protocol", "route", "backends", "retry", "circuit",
    "compaction", "retention", "listen", "timeouts", "limits", "pricing", "paths"
  ], "proxy config");
  if (value.schema !== 5 || value.kind !== CONFIG_KIND ||
      typeof value.instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.instance_id) ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new ProxyDaemonError("proxy config identity is invalid");
  }
  if (![PROVIDER_MODE, PASSTHROUGH_MODE].includes(value.mode)) {
    throw new ProxyDaemonError("proxy mode is invalid");
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
    if (backend.auth.mode === "openai_passthrough") {
      if (value.mode !== PASSTHROUGH_MODE || backend.auth.secret !== null) {
        throw new ProxyDaemonError("OpenAI passthrough authentication is limited to passthrough mode");
      }
    } else {
      validateAuthMode(backend.auth.mode);
    }
    if (["none", "openai_passthrough"].includes(backend.auth.mode)) {
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
  if (value.mode === PASSTHROUGH_MODE) {
    const backend = value.backends[0];
    const endpoint = new URL(backend.endpoint);
    const loopbackEndpoint = ["127.0.0.1", "[::1]"].includes(
      endpoint.hostname
    );
    if (value.target !== "codex" || value.protocol !== "openai_responses" ||
        value.route !== null || value.backends.length !== 1 ||
        backend.auth.mode !== "openai_passthrough" ||
        Object.keys(backend.models.aliases).length !== 0 ||
        (backend.endpoint !== OPENAI_SUBSCRIPTION_ENDPOINT && !loopbackEndpoint) ||
        value.compaction.mode !== "remote_native" ||
        !value.compaction.responses_compact) {
      throw new ProxyDaemonError(
        "OpenAI subscription passthrough requires one safe, unmapped Codex Responses backend"
      );
    }
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
  if (value.mode === PASSTHROUGH_MODE &&
      (value.retry.mode !== "next_request" || value.retry.max_attempts !== 1 ||
       value.retry.status_codes.length !== 0 || value.retry.network_errors)) {
    throw new ProxyDaemonError("OpenAI subscription passthrough cannot retry or replay requests");
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

function safePersistenceStatus(error) {
  return error ? "write_failed" : null;
}

function persistenceErrorReporter(label) {
  let lastReportedAt = 0;
  return () => {
    const now = Date.now();
    if (now - lastReportedAt < 60_000) return;
    lastReportedAt = now;
    process.stderr.write(`[warn] ${label} persistence failed; health reports degraded observability\n`);
  };
}

function circuitPersister(path, registry, {
  delayMs = CIRCUIT_PERSIST_DELAY_MS,
  write = writeJsonAtomic,
  onError = () => {}
} = {}) {
  let queue = Promise.resolve();
  let timer = null;
  let dirty = false;
  let writes = 0;
  let failures = 0;
  let lastError = null;
  let lastSignature = JSON.stringify(registry.snapshot().entries);

  const writeLatest = () => {
    if (!dirty) return queue;
    dirty = false;
    const snapshot = registry.snapshot();
    const signature = JSON.stringify(snapshot.entries);
    if (signature === lastSignature) return queue;
    queue = queue.then(() => write(path, snapshot)).then(() => {
      writes += 1;
      lastError = null;
      lastSignature = signature;
    }).catch((error) => {
      failures += 1;
      lastError = error;
      onError(error);
    });
    return queue;
  };

  const persist = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void writeLatest();
    }, delayMs);
    timer.unref?.();
  };
  persist.flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    do {
      await writeLatest();
      await queue;
    } while (dirty);
  };
  persist.status = () => ({
    enabled: true,
    pending: dirty || Boolean(timer),
    writes,
    failures,
    last_error: safePersistenceStatus(lastError)
  });
  return persist;
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

function allowedRoute(protocol, method, pathname, {
  responsesCompact = false,
  mode = PROVIDER_MODE
} = {}) {
  if (mode === PASSTHROUGH_MODE) {
    if (method === "GET" && ["/models", "/v1/models"].includes(pathname)) return true;
    return method === "POST" && [
      "/responses", "/responses/compact", "/v1/responses", "/v1/responses/compact",
      "/realtime/calls", "/v1/realtime/calls",
      "/alpha/search", "/v1/alpha/search"
    ].includes(pathname);
  }
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

function projectPassthroughUrl(localUrl) {
  const projected = new URL(localUrl);
  const pathname = projected.pathname;
  if (pathname === OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH) {
    projected.pathname = "/realtime";
    return projected;
  }
  if (pathname.startsWith(`${OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH}/`)) {
    projected.pathname = pathname.slice(OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH.length);
    return projected;
  }
  const livePath = OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH.replace(/\/realtime$/, "/live");
  if (pathname === livePath || pathname.startsWith(`${livePath}/`)) {
    projected.pathname = pathname.slice(livePath.length - "/live".length);
  }
  return projected;
}

function passthroughLocalBaseUrl(config) {
  const host = config.listen.host === "::1" ? `[${config.listen.host}]` : config.listen.host;
  return `http://${host}:${config.listen.port}${OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH}`;
}

function allowedPassthroughWebSocketRoute(pathname) {
  if ([
    "/responses", "/v1/responses",
    "/realtime", "/v1/realtime",
    "/live", "/v1/live"
  ].includes(pathname)) return true;
  return /^\/(?:v1\/)?live\/(?:rtc_[A-Za-z0-9_-]{1,128}|[A-Fa-f0-9]{8}-(?:[A-Fa-f0-9]{4}-){3}[A-Fa-f0-9]{12})$/.test(pathname);
}

function joinUpstream(endpoint, localUrl, { stripVersionPrefix = false } = {}) {
  const upstream = new URL(endpoint);
  const incomingPath = localUrl.pathname;
  let suffix = incomingPath;
  for (const prefix of ["/v1beta", "/v1"]) {
    if ((stripVersionPrefix || upstream.pathname.replace(/\/$/, "").endsWith(prefix)) &&
        (incomingPath === prefix || incomingPath.startsWith(`${prefix}/`))) {
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

function upstreamHeaders(request, protocol, backend, secret, bodyLength = undefined, {
  mode = PROVIDER_MODE
} = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    const localCredential = mode === PASSTHROUGH_MODE
      ? lower === "x-agentctl-proxy-token"
      : CLIENT_AUTH_HEADERS.has(lower);
    const invalidatedByBodyRewrite = mode === PASSTHROUGH_MODE
      ? lower === "content-length"
      : [
          "accept-encoding", "content-length", "content-encoding",
          "content-md5", "digest"
        ].includes(lower);
    if (HOP_BY_HOP_HEADERS.has(lower) || localCredential ||
        invalidatedByBodyRewrite) continue;
    if (value !== undefined) headers[lower] = value;
  }
  if (mode !== PASSTHROUGH_MODE) headers["accept-encoding"] = "identity";
  if (mode !== PASSTHROUGH_MODE) headers["user-agent"] = "agentproxyd/5";
  if (Number.isSafeInteger(bodyLength)) headers["content-length"] = String(bodyLength);
  if (backend.auth.mode === "bearer") headers.authorization = `Bearer ${secret}`;
  if (backend.auth.mode === "x-api-key") headers["x-api-key"] = secret;
  if (backend.auth.mode === "x-goog-api-key") headers["x-goog-api-key"] = secret;
  if (protocol === "anthropic_messages" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function validOpenAiAuthorization(request) {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.length <= 16_384 &&
    /^Bearer\s+\S+$/i.test(authorization);
}

function inspectPassthroughRequest(body, contentEncoding = "", maxBytes = 2 * 1024 * 1024) {
  let requestedModel = null;
  let requestedServiceTier = null;
  let inspected = body;
  let decoded = null;
  try {
    const encoding = String(contentEncoding).trim().toLowerCase();
    const options = { maxOutputLength: maxBytes };
    if (encoding === "gzip" && typeof zlib.gunzipSync === "function") {
      decoded = zlib.gunzipSync(body, options);
    } else if (encoding === "deflate" && typeof zlib.inflateSync === "function") {
      decoded = zlib.inflateSync(body, options);
    } else if (encoding === "br" && typeof zlib.brotliDecompressSync === "function") {
      decoded = zlib.brotliDecompressSync(body, options);
    } else if (encoding === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      decoded = zlib.zstdDecompressSync(body, options);
    }
    if (decoded) inspected = decoded;
    const payload = JSON.parse(inspected.toString("utf8"));
    if (plainObject(payload) && typeof payload.model === "string" &&
        payload.model.length > 0 && payload.model.length <= 240) {
      requestedModel = payload.model;
    }
    if (plainObject(payload) && typeof payload.service_tier === "string" &&
        payload.service_tier.length > 0 && payload.service_tier.length <= 40) {
      requestedServiceTier = payload.service_tier;
    }
  } catch {
  } finally {
    decoded?.fill(0);
  }
  return {
    requested_model: requestedModel,
    requested_service_tier: requestedServiceTier,
    outbound_model: requestedModel,
    mapped: false,
    body
  };
}

function writeRawHttp(socket, status, reason, body = "") {
  const bytes = Buffer.from(body);
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: application/json; charset=utf-8\r\n" +
    `Content-Length: ${bytes.length}\r\n\r\n${body}`
  );
}

function rawUpgradeResponse(socket, response) {
  let head = `HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || "Switching Protocols"}\r\n`;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    head += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
  }
  socket.write(`${head}\r\n`);
}

function websocketHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "x-agentctl-proxy-token" || value === undefined) continue;
    headers[lower] = value;
  }
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  return headers;
}

function perMessageDeflateNegotiation(headers) {
  const raw = headers?.["sec-websocket-extensions"];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw.join(",") : String(raw);
  for (const extension of value.split(",")) {
    const parts = extension.split(";").map((part) => part.trim()).filter(Boolean);
    if (parts.shift()?.toLowerCase() !== "permessage-deflate") continue;
    const parameters = new Map();
    for (const part of parts) {
      const separator = part.indexOf("=");
      const name = (separator === -1 ? part : part.slice(0, separator)).trim().toLowerCase();
      let parameter = separator === -1 ? "" : part.slice(separator + 1).trim();
      if (parameter.startsWith('"') && parameter.endsWith('"') && parameter.length >= 2) {
        parameter = parameter.slice(1, -1);
      }
      parameters.set(name, parameter);
    }
    const windowBits = (name) => {
      const parsed = Number(parameters.get(name));
      return Number.isInteger(parsed) && parsed >= 8 && parsed <= 15 ? parsed : 15;
    };
    return {
      client: {
        no_context_takeover: parameters.has("client_no_context_takeover"),
        window_bits: windowBits("client_max_window_bits")
      },
      server: {
        no_context_takeover: parameters.has("server_no_context_takeover"),
        window_bits: windowBits("server_max_window_bits")
      }
    };
  }
  return null;
}

function websocketDeflateDecoder(maxMessageBytes, onJson, options, onIssue) {
  const trailer = Buffer.from([0x00, 0x00, 0xff, 0xff]);
  let inflater = null;
  let active = null;
  let queue = Promise.resolve();
  let queuedBytes = 0;
  let accepting = true;
  let disabled = false;

  const clearActive = (parse) => {
    const state = active;
    active = null;
    if (!state) return;
    if (parse && state.text && !state.overflow) {
      const message = Buffer.concat(state.chunks, state.bytes);
      try {
        const payload = JSON.parse(message.toString("utf8"));
        try {
          onJson(payload);
        } catch {
          onIssue("observer_callback_error");
        }
      } catch {
        onIssue("invalid_json");
      }
      message.fill(0);
    }
    for (const chunk of state.chunks) chunk.fill(0);
    state.payload.fill(0);
    state.resolve();
  };
  const disable = (reason = "inflate_error") => {
    if (disabled) return;
    disabled = true;
    onIssue(reason);
    inflater?.destroy();
    inflater = null;
    clearActive(false);
  };
  const ensureInflater = () => {
    if (inflater) return true;
    try {
      inflater = zlib.createInflateRaw({ windowBits: options.window_bits });
      inflater.on("data", (chunk) => {
        if (!active || active.overflow) return;
        active.bytes += chunk.length;
        if (active.bytes > maxMessageBytes) {
          active.overflow = true;
          onIssue("message_too_large");
          for (const buffered of active.chunks) buffered.fill(0);
          active.chunks = [];
          return;
        }
        active.chunks.push(Buffer.from(chunk));
      });
      inflater.on("error", () => disable("inflate_error"));
      return true;
    } catch {
      disable("inflate_error");
      return false;
    }
  };
  const decode = (payload, text) => {
    if (disabled || !ensureInflater()) {
      payload.fill(0);
      return Promise.resolve();
    }
    return new Promise((resolveDecode) => {
      active = {
        payload,
        text,
        chunks: [],
        bytes: 0,
        overflow: false,
        resolve: resolveDecode
      };
      try {
        inflater.write(payload);
        inflater.write(trailer);
        inflater.flush(zlib.constants.Z_SYNC_FLUSH, () => {
          if (disabled || active?.resolve !== resolveDecode) return;
          if (options.no_context_takeover) {
            try {
              inflater.reset();
            } catch {
              disable("inflate_error");
              return;
            }
          }
          clearActive(true);
        });
      } catch {
        disable("inflate_error");
      }
    });
  };

  return {
    accept(payload, text) {
      if (!accepting || disabled) {
        payload.fill(0);
        return;
      }
      if (queuedBytes + payload.length > maxMessageBytes) {
        payload.fill(0);
        disable("queue_limit");
        return;
      }
      queuedBytes += payload.length;
      queue = queue
        .then(() => decode(payload, text))
        .finally(() => {
          queuedBytes -= payload.length;
        });
    },
    disable,
    async close() {
      accepting = false;
      await queue;
      inflater?.destroy();
      inflater = null;
    }
  };
}

function websocketObserver(maxMessageBytes, onJson, {
  perMessageDeflate = null
} = {}) {
  let pending = Buffer.alloc(0);
  let skip = 0;
  let fragments = [];
  let fragmentBytes = 0;
  let fragmentOpcode = null;
  let fragmentCompressed = false;
  let closed = false;
  const issues = new Set();
  const reportIssue = (reason) => issues.add(reason);
  const deflate = perMessageDeflate
    ? websocketDeflateDecoder(maxMessageBytes, onJson, perMessageDeflate, reportIssue)
    : null;

  const resetFragments = () => {
    for (const fragment of fragments) fragment.fill(0);
    fragments = [];
    fragmentBytes = 0;
    fragmentOpcode = null;
    fragmentCompressed = false;
  };
  const acceptText = (payload) => {
    try {
      const value = JSON.parse(payload.toString("utf8"));
      try {
        onJson(value);
      } catch {
        reportIssue("observer_callback_error");
      }
    } catch {
      reportIssue("invalid_json");
    }
    payload.fill(0);
  };
  const acceptMessage = (opcode, compressed, payload) => {
    if (compressed) {
      if (deflate) deflate.accept(payload, opcode === 0x1);
      else payload.fill(0);
    } else if (opcode === 0x1) {
      acceptText(payload);
    } else {
      payload.fill(0);
    }
  };
  const loseMessage = (reason) => {
    reportIssue(reason);
    if (fragmentCompressed) deflate?.disable(reason);
    resetFragments();
  };
  const acceptFrame = (fin, rsv1, rsvInvalid, opcode, payload) => {
    if (opcode >= 0x8) {
      if (rsv1 || rsvInvalid || !fin) reportIssue("invalid_frame_sequence");
      payload.fill(0);
      return;
    }
    if (rsvInvalid || (rsv1 && !deflate)) {
      const reason = rsv1 && !deflate ? "unexpected_compression" : "invalid_frame_sequence";
      reportIssue(reason);
      if (rsv1 || fragmentCompressed) deflate?.disable(reason);
      resetFragments();
      payload.fill(0);
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (fragments.length) loseMessage("invalid_frame_sequence");
      resetFragments();
      if (fin) acceptMessage(opcode, rsv1, payload);
      else {
        fragments = [payload];
        fragmentBytes = payload.length;
        fragmentOpcode = opcode;
        fragmentCompressed = rsv1;
      }
      return;
    }
    if (opcode !== 0x0 || !fragments.length || rsv1) {
      reportIssue("invalid_frame_sequence");
      if (rsv1 || fragmentCompressed) deflate?.disable("invalid_frame_sequence");
      resetFragments();
      payload.fill(0);
      return;
    }
    if (fragmentBytes + payload.length > maxMessageBytes) {
      loseMessage("message_too_large");
      payload.fill(0);
      return;
    }
    fragments.push(payload);
    fragmentBytes += payload.length;
    if (fin) {
      const message = Buffer.concat(fragments, fragmentBytes);
      const opcodeForMessage = fragmentOpcode;
      const compressed = fragmentCompressed;
      resetFragments();
      acceptMessage(opcodeForMessage, compressed, message);
    }
  };

  const observe = (chunk) => {
    if (closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let incoming = chunk;
    if (skip) {
      const consumed = Math.min(skip, incoming.length);
      skip -= consumed;
      incoming = incoming.subarray(consumed);
      if (!incoming.length) return;
    }
    pending = pending.length ? Buffer.concat([pending, incoming]) : Buffer.from(incoming);
    while (pending.length >= 2) {
      const first = pending[0];
      const second = pending[1];
      const fin = Boolean(first & 0x80);
      const rsv1 = Boolean(first & 0x40);
      const rsvInvalid = Boolean(first & 0x30);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let headerBytes = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        headerBytes = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        const extended = pending.readBigUInt64BE(2);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          reportIssue("message_too_large");
          if (rsv1 || fragmentCompressed) deflate?.disable("message_too_large");
          resetFragments();
          pending.fill(0);
          pending = Buffer.alloc(0);
          skip = Number.MAX_SAFE_INTEGER;
          return;
        }
        length = Number(extended);
        headerBytes = 10;
      }
      if (masked) headerBytes += 4;
      if (length > maxMessageBytes) {
        if (pending.length < headerBytes) return;
        pending = pending.subarray(headerBytes);
        const consumed = Math.min(length, pending.length);
        pending = pending.subarray(consumed);
        skip = length - consumed;
        reportIssue("message_too_large");
        if (rsv1 || fragmentCompressed) deflate?.disable("message_too_large");
        resetFragments();
        continue;
      }
      if (pending.length < headerBytes + length) return;
      const frame = Buffer.from(pending.subarray(headerBytes, headerBytes + length));
      if (masked) {
        const maskOffset = headerBytes - 4;
        for (let index = 0; index < frame.length; index += 1) {
          frame[index] ^= pending[maskOffset + (index % 4)];
        }
      }
      pending = pending.subarray(headerBytes + length);
      acceptFrame(fin, rsv1, rsvInvalid, opcode, frame);
    }
  };
  observe.close = async () => {
    if (closed) return;
    closed = true;
    if (pending.length || skip || fragments.length) {
      reportIssue("connection_closed_mid_message");
    }
    pending.fill(0);
    pending = Buffer.alloc(0);
    resetFragments();
    await deflate?.close();
  };
  observe.summary = () => ({
    status: issues.size ? "degraded" : "complete",
    reasons: [...issues].sort()
  });
  return observe;
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

function responseContentCodings(headers) {
  const value = headers["content-encoding"];
  if (value === undefined) return [];
  const joined = Array.isArray(value) ? value.join(",") : String(value);
  return joined.split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity");
}

function responseDecompressor(coding) {
  if (coding === "gzip" || coding === "x-gzip") return zlib.createGunzip();
  if (coding === "deflate") return zlib.createInflate();
  if (coding === "br" && typeof zlib.createBrotliDecompress === "function") {
    return zlib.createBrotliDecompress();
  }
  if (["zstd", "zst"].includes(coding) &&
      typeof zlib.createZstdDecompress === "function") {
    return zlib.createZstdDecompress();
  }
  return null;
}

function responseUsageObserver(protocol, headers, {
  maxJsonBytes,
  maxSseEventBytes
} = {}) {
  const collector = new UsageCollector(protocol, {
    contentType: headers["content-type"] || "",
    maxJsonBytes,
    maxSseEventBytes
  });
  const codings = responseContentCodings(headers);
  if (!codings.length) {
    return {
      feed(chunk) {
        collector.feed(chunk);
        return true;
      },
      async finish() {
        try { return collector.finish(); } catch { return null; }
      },
      abort() {},
      onDrain() {}
    };
  }

  const decoders = [];
  for (const coding of [...codings].reverse()) {
    const decoder = responseDecompressor(coding);
    if (!decoder) {
      for (const existing of decoders) existing.destroy();
      return {
        feed() { return true; },
        async finish() { return null; },
        abort() {},
        onDrain() {}
      };
    }
    decoders.push(decoder);
  }

  let failed = false;
  let ending = false;
  let settled = false;
  let drainListener = () => {};
  let resolveDone;
  const done = new Promise((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  const settle = () => {
    if (settled) return;
    settled = true;
    resolveDone();
  };
  const abandon = () => {
    if (failed) return;
    failed = true;
    for (const decoder of decoders) decoder.destroy();
    drainListener();
    settle();
  };

  for (let index = 0; index + 1 < decoders.length; index += 1) {
    decoders[index].pipe(decoders[index + 1]);
  }
  for (const decoder of decoders) decoder.on("error", abandon);
  const first = decoders[0];
  const last = decoders[decoders.length - 1];
  first.on("drain", () => drainListener());
  last.on("data", (chunk) => {
    if (failed) return;
    try {
      collector.feed(chunk);
    } catch {
      abandon();
    }
  });
  last.on("end", settle);
  last.on("close", () => {
    if (!settled) abandon();
  });

  return {
    feed(chunk) {
      if (failed || ending) return true;
      try {
        return first.write(chunk);
      } catch {
        abandon();
        return true;
      }
    },
    async finish() {
      if (!ending && !failed) {
        ending = true;
        try {
          first.end();
        } catch {
          abandon();
        }
      }
      await done;
      if (failed) return null;
      try { return collector.finish(); } catch { return null; }
    },
    abort() {
      if (!settled) abandon();
    },
    onDrain(listener) {
      drainListener = typeof listener === "function" ? listener : () => {};
    }
  };
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
    "mode", "profile", "target", "protocol", "config", "route", "backend_profiles", "compaction",
    "local_base_url"
  ], "proxy state");
  if (value.schema !== 1 || value.kind !== STATE_KIND ||
      (instanceId && value.instance_id !== instanceId) ||
      !Number.isInteger(value.pid) || value.pid < 1 ||
      (value.local_base_url !== undefined &&
       (value.mode !== PASSTHROUGH_MODE || typeof value.local_base_url !== "string" ||
        !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+\/backend-api\/codex\/realtime$/.test(value.local_base_url))) ||
      (value.route !== undefined && value.route !== null && typeof value.route !== "string") ||
      (value.backend_profiles !== undefined &&
       (!Array.isArray(value.backend_profiles) ||
        value.backend_profiles.some((profile) => typeof profile !== "string"))) ||
      ![PROVIDER_MODE, PASSTHROUGH_MODE].includes(value.mode) ||
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

function jsonlLogger(path, maxBytes, retention, label, {
  maxQueue = LOG_MAX_QUEUE,
  maintenanceMs = LOG_MAINTENANCE_MS,
  onError = () => {}
} = {}) {
  let queue = Promise.resolve();
  let initialized = false;
  let handle = null;
  let currentSize = 0;
  let activeMtime = 0;
  let activeExists = false;
  let lastMaintenanceAt = 0;
  let pending = 0;
  let dropped = 0;
  let failures = 0;
  let lastError = null;

  const closeHandle = async ({ sync = false } = {}) => {
    const current = handle;
    handle = null;
    if (!current) return;
    let failure = null;
    if (sync) {
      try { await current.sync(); } catch (error) { failure = error; }
    }
    try { await current.close(); } catch (error) { failure ||= error; }
    if (failure) throw failure;
  };

  const openActive = async (expected = null) => {
    const current = await open(path, "a", 0o600);
    try {
      const descriptorDetails = await current.stat();
      const pathDetails = await lstat(path);
      if (pathDetails.isSymbolicLink() || !pathDetails.isFile() ||
          pathDetails.dev !== descriptorDetails.dev ||
          pathDetails.ino !== descriptorDetails.ino) {
        throw new ProxyDaemonError(`${label} changed while it was being opened`);
      }
      if (expected && (expected.dev !== descriptorDetails.dev ||
          expected.ino !== descriptorDetails.ino)) {
        throw new ProxyDaemonError(`${label} changed while it was being opened`);
      }
      await current.chmod(0o600);
      handle = current;
      activeExists = true;
      currentSize = descriptorDetails.size;
      activeMtime = descriptorDetails.mtimeMs || Date.now();
    } catch (error) {
      await current.close().catch(() => {});
      throw error;
    }
  };

  const initialize = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await pruneLogs(path, retention, label);
    const details = await logDetails(path, label);
    await openActive(details);
    lastMaintenanceAt = Date.now();
    initialized = true;
  };

  const maintain = async () => {
    const now = Date.now();
    if (!initialized) {
      await initialize();
      return;
    }
    if (now - lastMaintenanceAt < maintenanceMs) return;
    await closeHandle();
    await pruneLogs(path, retention, label);
    const details = await logDetails(path, label);
    await openActive(details);
    lastMaintenanceAt = now;
  };

  const append = (record) => {
    if (pending >= maxQueue) {
      dropped += 1;
      return false;
    }
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      failures += 1;
      lastError = error;
      onError(error);
      return false;
    }
    const lineBytes = Buffer.byteLength(line);
    pending += 1;
    queue = queue.then(async () => {
      await maintain();
      const expired = activeExists &&
        activeMtime < Date.now() - retention.max_age_days * 86400000;
      if (activeExists && currentSize > 0 &&
          (currentSize + lineBytes > maxBytes || expired)) {
        await closeHandle();
        await rotateLog(path, retention, label);
        await pruneLogs(path, retention, label);
        activeExists = false;
        currentSize = 0;
        await openActive(null);
      }
      await handle.appendFile(line);
      currentSize += lineBytes;
      activeMtime = Date.now();
      lastError = null;
    }).catch((error) => {
      failures += 1;
      lastError = error;
      initialized = false;
      onError(error);
    }).finally(() => {
      pending -= 1;
    });
    return true;
  };
  append.flush = async () => {
    await queue;
    try {
      await closeHandle({ sync: true });
    } catch (error) {
      failures += 1;
      lastError = error;
      onError(error);
    } finally {
      initialized = false;
      activeExists = false;
    }
  };
  append.status = () => ({
    healthy: lastError === null && dropped === 0,
    pending,
    dropped,
    failures,
    last_error: safePersistenceStatus(lastError) || (dropped > 0 ? "queue_full" : null)
  });
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
  const responseServiceTier = extracted?.response_service_tier || null;
  const requestedServiceTier = mapping?.requested_service_tier || null;
  let pricingServiceTier = "standard";
  let pricingServiceTierSource = "assumed_standard";
  try {
    if (responseServiceTier) {
      pricingServiceTier = normalizePricingServiceTier(
        responseServiceTier,
        "response service tier"
      );
      pricingServiceTierSource = "response";
    } else if (requestedServiceTier) {
      pricingServiceTier = normalizePricingServiceTier(
        requestedServiceTier,
        "request service tier"
      );
      pricingServiceTierSource = "request_fallback";
    }
  } catch {
    pricingServiceTier = "standard";
    pricingServiceTierSource = "unknown_assumed_standard";
  }
  const tierDetails = {
    pricing_service_tier: pricingServiceTier,
    pricing_service_tier_source: pricingServiceTierSource
  };
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
      ...tierDetails,
      pricing_model: primary?.model || null,
      pricing_model_source: primary?.source || config.pricing.model_source,
      pricing_fallback_reason: primary?.fallback || null,
      cost: null,
      pricing_unavailable: "usage_missing"
    };
  }
  if (!pricing) {
    return {
      ...tierDetails,
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
        serviceTier: pricingServiceTier,
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
    if (pricingServiceTierSource !== "response") {
      cost.estimate_reason = `${cost.estimate_reason}_${pricingServiceTierSource}`;
    }
    return {
      ...tierDetails,
      pricing_model: candidate.model,
      pricing_model_source: candidate.source,
      pricing_fallback_reason: candidate.fallback,
      cost,
      pricing_unavailable: null
    };
  }
  return {
    ...tierDetails,
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
    mode: config.mode,
    profile: backend.profile,
    route: config.route,
    target: config.target,
    protocol: config.protocol,
    status,
    duration_ms: Date.now() - started,
    requested_model: mapping?.requested_model || null,
    requested_service_tier: mapping?.requested_service_tier || null,
    outbound_model: mapping?.outbound_model || null,
    response_model: extracted?.response_model || null,
    response_service_tier: extracted?.response_service_tier || null,
    pricing_model: priced.pricing_model,
    pricing_model_source: priced.pricing_model_source,
    pricing_fallback_reason: priced.pricing_fallback_reason,
    pricing_service_tier: priced.pricing_service_tier,
    pricing_service_tier_source: priced.pricing_service_tier_source,
    usage_source: extracted?.source || null,
    usage: extracted?.usage || null,
    cost: priced.cost,
    pricing_unavailable: priced.pricing_unavailable
  };
}

function proxyWebSocket(request, socket, head, context) {
  const { config, backendSecrets, pricing, log, usageLog } = context;
  const connectionStarted = Date.now();
  let localUrl;
  try {
    localUrl = new URL(request.url, `http://${config.listen.host}:${config.listen.port}`);
  } catch {
    writeRawHttp(socket, 400, "Bad Request", '{"error":"invalid_request_target"}\n');
    return;
  }
  if (config.mode !== PASSTHROUGH_MODE || !validOpenAiAuthorization(request)) {
    writeRawHttp(socket, 401, "Unauthorized", '{"error":"proxy_authentication_required"}\n');
    return;
  }
  const requestPath = localUrl.pathname;
  localUrl = projectPassthroughUrl(localUrl);
  if (!allowedPassthroughWebSocketRoute(localUrl.pathname)) {
    writeRawHttp(socket, 404, "Not Found", '{"error":"route_not_available_for_proxy_protocol"}\n');
    return;
  }

  const backend = config.backends[0];
  const destination = joinUpstream(backend.endpoint, localUrl, {
    stripVersionPrefix: true
  });
  const transport = destination.protocol === "https:" ? httpsRequest : httpRequest;
  const turns = [];
  let bytesIn = head.length;
  let bytesOut = 0;
  let completedTurns = 0;
  let closed = false;
  let websocketCompression = "identity";
  let observeClient = null;
  let observeServer = null;

  const observeClientPayload = (payload) => {
    const requestPayload = plainObject(payload?.response) ? payload.response : payload;
    if (!plainObject(requestPayload)) return;
    const requestedModel = typeof requestPayload.model === "string" &&
      requestPayload.model.length > 0 && requestPayload.model.length <= 240
      ? requestPayload.model
      : null;
    const requestedServiceTier = typeof requestPayload.service_tier === "string" &&
      requestPayload.service_tier.length > 0 && requestPayload.service_tier.length <= 40
      ? requestPayload.service_tier
      : null;
    if (!requestedModel && payload?.type !== "response.create" &&
        !Object.hasOwn(requestPayload, "input")) return;
    turns.push({
      requestId: randomUUID(),
      started: Date.now(),
      requestStartedAt: new Date().toISOString(),
      mapping: {
        requested_model: requestedModel,
        requested_service_tier: requestedServiceTier,
        outbound_model: requestedModel,
        mapped: false
      }
    });
  };
  const observeServerPayload = (payload) => {
    const extracted = extractUsage(config.protocol, payload);
    if (!extracted?.usage) return;
    const turn = turns.shift() || {
      requestId: randomUUID(),
      started: connectionStarted,
      requestStartedAt: new Date(connectionStarted).toISOString(),
      mapping: null
    };
    completedTurns += 1;
    usageLog(usageRecord({
      config,
      backend,
      pricing,
      mapping: turn.mapping,
      extracted,
      requestId: turn.requestId,
      requestStartedAt: turn.requestStartedAt,
      started: turn.started,
      status: 200
    }));
    log({
      schema: 1,
      timestamp: new Date().toISOString(),
      request_id: turn.requestId,
      mode: config.mode,
      profile: config.profile,
      failover_route: null,
      target: config.target,
      protocol: config.protocol,
      method: "WS",
      route: requestPath,
      status: 200,
      outcome: "websocket_response_completed",
      duration_ms: Date.now() - turn.started,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      attempts: [{
        profile: backend.profile,
        outcome: "websocket_response_completed",
        circuit: "disabled",
        status: 200,
        duration_ms: Date.now() - turn.started
      }]
    });
  };
  const finishConnection = (outcome) => {
    if (closed) return;
    closed = true;
    Promise.allSettled([
      observeClient?.close?.(),
      observeServer?.close?.()
    ]).then(() => {
      const clientObservation = observeClient?.summary?.() || null;
      const serverObservation = observeServer?.summary?.() || null;
      const observationIssues = [
        ...(clientObservation?.reasons || []).map((reason) => ({
          direction: "client",
          reason
        })),
        ...(serverObservation?.reasons || []).map((reason) => ({
          direction: "server",
          reason
        }))
      ];
      log({
        schema: 1,
        timestamp: new Date().toISOString(),
        event: "proxy_websocket_closed",
        mode: config.mode,
        profile: config.profile,
        target: config.target,
        protocol: config.protocol,
        route: requestPath,
        outcome,
        duration_ms: Date.now() - connectionStarted,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        completed_turns: completedTurns,
        incomplete_turns: turns.length,
        websocket_compression: websocketCompression,
        websocket_observation: !clientObservation || !serverObservation
          ? "not_started"
          : observationIssues.length
            ? "degraded"
            : "complete",
        websocket_observation_issues: observationIssues
      });
    });
  };

  const upstream = transport({
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port || undefined,
    method: "GET",
    path: `${destination.pathname}${destination.search}`,
    headers: websocketHeaders(request)
  });
  const firstByteTimer = setTimeout(() => {
    upstream.destroy(new Error("websocket_first_byte_timeout"));
  }, config.timeouts.first_byte_ms);
  firstByteTimer.unref?.();

  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    clearTimeout(firstByteTimer);
    const negotiatedCompression = perMessageDeflateNegotiation(response.headers);
    if (negotiatedCompression) websocketCompression = "permessage-deflate";
    observeClient = websocketObserver(config.limits.request_bytes, observeClientPayload, {
      perMessageDeflate: negotiatedCompression?.client || null
    });
    observeServer = websocketObserver(config.limits.usage_capture_bytes, observeServerPayload, {
      perMessageDeflate: negotiatedCompression?.server || null
    });
    rawUpgradeResponse(socket, response);
    if (head.length) {
      observeClient(head);
      upstreamSocket.write(head);
    }
    if (upstreamHead.length) {
      bytesOut += upstreamHead.length;
      observeServer(upstreamHead);
      socket.write(upstreamHead);
    }
    socket.on("data", (chunk) => {
      bytesIn += chunk.length;
      observeClient(chunk);
    });
    upstreamSocket.on("data", (chunk) => {
      bytesOut += chunk.length;
      observeServer(chunk);
    });
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("close", () => {
      upstreamSocket.destroy();
      finishConnection("client_closed");
    });
    upstreamSocket.on("close", () => {
      socket.destroy();
      finishConnection("upstream_closed");
    });
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });
  upstream.on("response", (response) => {
    clearTimeout(firstByteTimer);
    let responseHead = `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\n`;
    for (const [name, value] of Object.entries(response.headers)) {
      if (["connection", "content-length", "transfer-encoding"].includes(name) ||
          value === undefined) continue;
      responseHead += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
    }
    socket.write(`${responseHead}Connection: close\r\n\r\n`);
    response.on("data", (chunk) => socket.write(chunk));
    response.on("end", () => {
      socket.end();
      finishConnection(`upstream_http_${response.statusCode || 502}`);
    });
  });
  upstream.on("error", () => {
    clearTimeout(firstByteTimer);
    if (!socket.destroyed) {
      writeRawHttp(socket, 502, "Bad Gateway", '{"error":"websocket_upstream_failed"}\n');
    }
    finishConnection("upstream_error");
  });
  upstream.end();
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
  const mapping = config.mode === PASSTHROUGH_MODE
    ? {
        ...inspectPassthroughRequest(
          rawBody,
          request.headers["content-encoding"],
          config.limits.usage_capture_bytes
        ),
        pathname: localUrl.pathname
      }
    : mapNativeModelRequest({
        protocol: config.protocol,
        method: request.method || "",
        pathname: localUrl.pathname,
        body: rawBody,
        models: backend.models
      });
  const mappedUrl = new URL(localUrl);
  mappedUrl.pathname = mapping.pathname;
  const destination = joinUpstream(backend.endpoint, mappedUrl, {
    stripVersionPrefix: config.mode === PASSTHROUGH_MODE
  });
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
    let usageObserver = null;
    let responseBackpressured = false;
    let observerBackpressured = false;

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
      usageObserver?.abort();
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
    const resumeUpstreamResponse = () => {
      if (!responseBackpressured && !observerBackpressured) upstreamResponse?.resume();
    };
    const onDrain = () => {
      responseBackpressured = false;
      resumeUpstreamResponse();
    };
    const onObserverDrain = () => {
      observerBackpressured = false;
      resumeUpstreamResponse();
    };
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
          request.method === "GET" ? undefined : requestBody.length,
          { mode: config.mode }
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
        usageObserver = responseUsageObserver(config.protocol, incoming.headers, {
          maxJsonBytes: config.limits.usage_capture_bytes,
          maxSseEventBytes: config.limits.usage_capture_bytes
        });
        usageObserver.onDrain(onObserverDrain);
        if (streaming) clearTimeout(totalTimer);
        response.writeHead(status, responseHeaders(incoming.headers));
        resetIdle();
        incoming.on("data", (chunk) => {
          bytesOut += chunk.length;
          if (!usageObserver.feed(chunk)) observerBackpressured = true;
          resetIdle();
          if (!response.write(chunk)) responseBackpressured = true;
          if (responseBackpressured || observerBackpressured) incoming.pause();
        });
        incoming.on("end", () => {
          clearTimeout(idleTimer);
          response.end();
          usageObserver.finish().then((extracted) => {
            finish({
              kind: "response",
              status,
              outcome: "upstream_response",
              failure: retryStatus,
              network_error: false,
              extracted
            });
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
    if (config.circuit.enabled) persistCircuits();
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
      mode: config.mode,
      local_base_url: config.mode === PASSTHROUGH_MODE
        ? passthroughLocalBaseUrl(config)
        : null,
      compaction: config.compaction,
      pricing_catalog_version: pricing?.version || null,
      pricing_model_source: config.pricing.model_source,
      observability: {
        circuit_state: persistCircuits.status(),
        metadata_log: log.status(),
        usage_log: usageLog.status()
      }
    });
    return;
  }

  const requestPath = localUrl.pathname;
  if (config.mode === PASSTHROUGH_MODE) localUrl = projectPassthroughUrl(localUrl);

  const finishMetadata = (status, outcome, bytesIn = 0, bytesOut = 0) => {
    log({
      schema: 1,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      mode: config.mode,
      profile: config.profile,
      failover_route: config.route,
      target: config.target,
      protocol: config.protocol,
      method: request.method || "",
      route: requestPath,
      status,
      outcome,
      duration_ms: Date.now() - started,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      attempts
    });
  };

  const authenticated = config.mode === PASSTHROUGH_MODE
    ? validOpenAiAuthorization(request)
    : safeTokenEqual(clientToken(request), capability.token);
  if (!authenticated) {
    sendJson(response, 401, { error: "proxy_authentication_required" });
    finishMetadata(401, "client_auth_failed");
    request.resume();
    return;
  }
  if (!allowedRoute(config.protocol, request.method || "", localUrl.pathname, {
    responsesCompact: config.compaction.responses_compact,
    mode: config.mode
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
  if (config.mode !== PASSTHROUGH_MODE &&
      contentEncoding && contentEncoding !== "identity") {
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
      if (config.circuit.enabled) persistCircuits();
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
        persistCircuits();
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
  const secrets = config.mode === PASSTHROUGH_MODE
    ? { secrets: {} }
    : await readPrivateJson(
      config.paths.secrets,
      "provider Secret Store",
      validateProviderSecrets
    );
  const backendSecrets = new Map();
  for (const backend of config.backends) {
    const secret = ["none", "openai_passthrough"].includes(backend.auth.mode)
      ? ""
      : secrets.secrets[backend.auth.secret]?.value;
    if (!["none", "openai_passthrough"].includes(backend.auth.mode) && !secret) {
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
  const circuitPersistenceError = persistenceErrorReporter("circuit state");
  const persistCircuits = config.circuit.enabled
    ? circuitPersister(config.paths.circuit_state, circuits, {
        onError: circuitPersistenceError
      })
    : Object.assign(() => {}, {
        flush: async () => {},
        status: () => ({
          enabled: false,
          pending: false,
          writes: 0,
          failures: 0,
          last_error: null
        })
      });

  await acquireLock(config);
  const log = jsonlLogger(
    config.paths.log,
    config.limits.log_bytes,
    config.retention,
    "proxy metadata log",
    { onError: persistenceErrorReporter("proxy metadata log") }
  );
  const usageLog = jsonlLogger(
    config.paths.usage_log,
    config.limits.usage_log_bytes,
    config.retention,
    "proxy usage log",
    { onError: persistenceErrorReporter("proxy usage log") }
  );
  const sockets = new Set();
  let shuttingDown = false;
  const requestContext = {
    config,
    capability,
    backendSecrets,
    pricing,
    circuits,
    persistCircuits,
    log,
    usageLog
  };
  const server = createServer((request, response) => {
    void proxyRequest(request, response, requestContext).catch(() => {
      request.resume();
      if (!response.headersSent) sendJson(response, 500, { error: "proxy_request_failed" });
      else response.destroy();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      proxyWebSocket(request, socket, head, requestContext);
    } catch {
      if (!socket.destroyed) {
        writeRawHttp(socket, 500, "Internal Server Error", '{"error":"proxy_websocket_failed"}\n');
      }
    }
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
      await Promise.all([log.flush(), usageLog.flush(), persistCircuits.flush()]);
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
    mode: config.mode,
    target: config.target,
    protocol: config.protocol,
    ...(config.mode === PASSTHROUGH_MODE
      ? { local_base_url: passthroughLocalBaseUrl(config) }
      : {}),
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
    mode: config.mode,
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
  allowedPassthroughWebSocketRoute,
  allowedRoute,
  circuitPersister,
  jsonlLogger,
  joinUpstream,
  pruneLogs,
  projectPassthroughUrl,
  rotateLog,
  upstreamHeaders,
  validateConfig,
  websocketObserver
};
