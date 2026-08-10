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
  validatePlatform,
  validateProfileName,
  validateProtocol,
  validateProviderSecrets,
  validateReferenceName,
  validateTarget
} from "../agentctl/provider-schema.mjs";

const CONFIG_KIND = "agentctl-proxy-config";
const CAPABILITY_KIND = "agentctl-proxy-capability";
const STATE_KIND = "agentctl-proxy-state";
const MAX_CONFIG_BYTES = 1024 * 1024;
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
    "platform", "protocol", "endpoint", "auth", "listen", "timeouts",
    "limits", "paths"
  ], "proxy config");
  if (value.schema !== 1 || value.kind !== CONFIG_KIND ||
      typeof value.instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.instance_id) ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
    throw new ProxyDaemonError("proxy config identity is invalid");
  }
  validateProfileName(value.profile);
  validateTarget(value.target);
  validatePlatform(value.platform);
  validateProtocol(value.protocol);
  value.endpoint = validateEndpoint(value.endpoint);
  exactKeys(value.auth, ["mode", "secret"], "proxy config auth");
  validateAuthMode(value.auth.mode);
  if (value.auth.mode === "none") {
    if (value.auth.secret !== null) throw new ProxyDaemonError("unauthenticated proxy config must not name a Secret");
  } else {
    validateReferenceName(value.auth.secret, "proxy Secret reference");
  }
  exactKeys(value.listen, ["host", "port"], "proxy config listen");
  if (value.listen.host !== "127.0.0.1" && value.listen.host !== "::1") {
    throw new ProxyDaemonError("proxy listener must use an explicit loopback address");
  }
  boundedInteger(value.listen.port, "proxy port", 1024, 65535);
  exactKeys(value.timeouts, ["first_byte_ms", "stream_idle_ms", "request_ms"], "proxy timeouts");
  boundedInteger(value.timeouts.first_byte_ms, "first-byte timeout", 100, 600000);
  boundedInteger(value.timeouts.stream_idle_ms, "stream idle timeout", 1000, 3600000);
  boundedInteger(value.timeouts.request_ms, "request timeout", 1000, 3600000);
  exactKeys(value.limits, ["request_bytes", "log_bytes"], "proxy limits");
  boundedInteger(value.limits.request_bytes, "request byte limit", 1024, 64 * 1024 * 1024);
  boundedInteger(value.limits.log_bytes, "log byte limit", 65536, 100 * 1024 * 1024);
  exactKeys(value.paths, [
    "state", "lock", "capability", "secrets", "log", "runtime_log"
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

function allowedRoute(protocol, method, pathname) {
  if (method === "GET" && pathname === "/v1/models") return true;
  if (protocol === "anthropic_messages") {
    return method === "POST" && [
      "/v1/messages", "/v1/messages/count_tokens"
    ].includes(pathname);
  }
  if (protocol === "openai_responses") {
    return method === "POST" && pathname === "/v1/responses";
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

function upstreamHeaders(request, config, secret) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || CLIENT_AUTH_HEADERS.has(lower) ||
        lower === "accept-encoding") continue;
    if (value !== undefined) headers[lower] = value;
  }
  headers["accept-encoding"] = "identity";
  headers["user-agent"] = "agentproxyd/1";
  if (config.auth.mode === "bearer") headers.authorization = `Bearer ${secret}`;
  if (config.auth.mode === "x-api-key") headers["x-api-key"] = secret;
  if (config.auth.mode === "x-goog-api-key") headers["x-goog-api-key"] = secret;
  if (config.protocol === "anthropic_messages" && !headers["anthropic-version"]) {
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
    "profile", "target", "protocol", "config"
  ], "proxy state");
  if (value.schema !== 1 || value.kind !== STATE_KIND ||
      (instanceId && value.instance_id !== instanceId) ||
      !Number.isInteger(value.pid) || value.pid < 1) {
    throw new ProxyDaemonError("proxy state is invalid");
  }
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

function logger(config) {
  let queue = Promise.resolve();
  const append = (record) => {
    queue = queue.then(async () => {
      await mkdir(dirname(config.paths.log), { recursive: true, mode: 0o700 });
      let details;
      try {
        details = await lstat(config.paths.log);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (details?.isSymbolicLink() || (details && !details.isFile())) {
        throw new ProxyDaemonError("proxy metadata log is not a regular file");
      }
      if (details && details.size >= config.limits.log_bytes) {
        const rotated = `${config.paths.log}.1`;
        await rm(rotated, { force: true });
        await rename(config.paths.log, rotated);
        await chmod(rotated, 0o600);
      }
      await appendFile(config.paths.log, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await chmod(config.paths.log, 0o600);
    }).catch(() => {});
  };
  return append;
}

function proxyRequest(request, response, context) {
  const { config, capability, secret, log } = context;
  const started = Date.now();
  const requestId = randomUUID();
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
    sendJson(response, 200, {
      schema: 1,
      kind: "agentctl-proxy-health",
      instance_id: config.instance_id,
      profile: config.profile,
      target: config.target,
      protocol: config.protocol
    });
    return;
  }

  const finishMetadata = (status, outcome, bytesIn = 0, bytesOut = 0) => {
    log({
      schema: 1,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      profile: config.profile,
      target: config.target,
      protocol: config.protocol,
      method: request.method || "",
      route: localUrl.pathname,
      status,
      outcome,
      duration_ms: Date.now() - started,
      bytes_in: bytesIn,
      bytes_out: bytesOut
    });
  };

  if (!safeTokenEqual(clientToken(request), capability.token)) {
    sendJson(response, 401, { error: "proxy_authentication_required" });
    finishMetadata(401, "client_auth_failed");
    request.resume();
    return;
  }
  if (!allowedRoute(config.protocol, request.method || "", localUrl.pathname)) {
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

  const destination = joinUpstream(config.endpoint, localUrl);
  const transport = destination.protocol === "https:" ? httpsRequest : httpRequest;
  let bytesIn = 0;
  let bytesOut = 0;
  let complete = false;
  let upstreamResponse = null;
  let firstByteTimer;
  let totalTimer;
  let idleTimer;
  let failureCode = "";

  const clearTimers = () => {
    clearTimeout(firstByteTimer);
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  };
  const completeOnce = (status, outcome) => {
    if (complete) return;
    complete = true;
    clearTimers();
    finishMetadata(status, outcome, bytesIn, bytesOut);
  };
  const fail = (code) => {
    if (complete) return;
    failureCode = code;
    upstream.destroy(new Error(code));
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail("stream_idle_timeout"), config.timeouts.stream_idle_ms);
    idleTimer.unref?.();
  };

  const upstream = transport({
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port || undefined,
    method: request.method,
    path: `${destination.pathname}${destination.search}`,
    headers: upstreamHeaders(request, config, secret)
  }, (incoming) => {
    upstreamResponse = incoming;
    clearTimeout(firstByteTimer);
    const streaming = String(incoming.headers["content-type"] || "")
      .toLowerCase().includes("text/event-stream");
    if (streaming) clearTimeout(totalTimer);
    response.writeHead(incoming.statusCode || 502, responseHeaders(incoming.headers));
    resetIdle();
    incoming.on("data", (chunk) => {
      bytesOut += chunk.length;
      resetIdle();
      if (!response.write(chunk)) incoming.pause();
    });
    response.on("drain", () => incoming.resume());
    incoming.on("end", () => {
      clearTimeout(idleTimer);
      response.end();
      completeOnce(incoming.statusCode || 502, "upstream_response");
    });
    incoming.on("error", () => fail("upstream_response_error"));
  });

  firstByteTimer = setTimeout(
    () => fail("first_byte_timeout"),
    config.timeouts.first_byte_ms
  );
  totalTimer = setTimeout(
    () => fail("request_timeout"),
    config.timeouts.request_ms
  );
  firstByteTimer.unref?.();
  totalTimer.unref?.();

  upstream.on("error", () => {
    if (complete) return;
    const code = failureCode || "upstream_error";
    const status = code.includes("timeout") ? 504 :
      code === "request_too_large" ? 413 : 502;
    if (!response.headersSent) sendJson(response, status, { error: code });
    else response.destroy();
    completeOnce(status, code);
  });
  request.on("data", (chunk) => {
    bytesIn += chunk.length;
    if (bytesIn > config.limits.request_bytes && !failureCode) {
      request.unpipe(upstream);
      request.resume();
      fail("request_too_large");
    }
  });
  request.on("aborted", () => {
    if (!complete) {
      failureCode = "client_aborted";
      upstream.destroy(new Error("client_aborted"));
      completeOnce(499, "client_aborted");
    }
  });
  response.on("close", () => {
    if (!response.writableEnded && !complete) {
      failureCode = "client_disconnected";
      upstreamResponse?.destroy();
      upstream.destroy(new Error("client_disconnected"));
      completeOnce(499, "client_disconnected");
    }
  });
  request.pipe(upstream);
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
  const secret = config.auth.mode === "none"
    ? ""
    : secrets.secrets[config.auth.secret]?.value;
  if (config.auth.mode !== "none" && !secret) {
    throw new ProxyDaemonError(`provider Secret '${config.auth.secret}' is unavailable`);
  }

  await acquireLock(config);
  const log = logger(config);
  const sockets = new Set();
  let shuttingDown = false;
  const server = createServer((request, response) => {
    proxyRequest(request, response, { config, capability, secret, log });
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
    target: config.target,
    protocol: config.protocol,
    host: config.listen.host,
    port: config.listen.port
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
  joinUpstream,
  upstreamHeaders,
  validateConfig
};
