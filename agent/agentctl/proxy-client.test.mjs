import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  constants as zlibConstants,
  createDeflateRaw,
  deflateRawSync,
  gzipSync
} from "node:zlib";

import {
  allowedPassthroughWebSocketRoute,
  allowedRoute,
  circuitPersister,
  jsonlLogger,
  joinUpstream,
  pruneLogs,
  projectPassthroughUrl,
  responseHeaders,
  rotateLog,
  upstreamHeaders,
  validateConfig,
  websocketObserver
} from "../proxy/agentproxyd.mjs";
import { RequestAdmission } from "../proxy/admission.mjs";
import { proxyDefaults as controllerProxyDefaults } from "./proxy-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER_CLIENT = join(HERE, "provider-client.mjs");
const FAILOVER_CLIENT = join(HERE, "failover-client.mjs");
const PRICING_CLIENT = join(HERE, "pricing-client.mjs");
const PROXY_CLIENT = join(HERE, "proxy-client.mjs");
const DAEMON = resolve(HERE, "..", "proxy", "agentproxyd.mjs");

function providerArgs(root) {
  return [
    "--store", join(root, "config", "providers.json"),
    "--secrets", join(root, "config", "provider-secrets.json"),
    "--state", join(root, "provider-state.json")
  ];
}

function proxyArgs(root, port) {
  return [
    "--store", join(root, "config", "providers.json"),
    "--secrets", join(root, "config", "provider-secrets.json"),
    "--proxy-config", join(root, "proxy", "config.json"),
    "--proxy-state", join(root, "proxy", "state.json"),
    "--proxy-lock", join(root, "proxy", "runtime.lock"),
    "--proxy-capability", join(root, "config", "proxy-capability.json"),
    "--proxy-log", join(root, "proxy", "requests.jsonl"),
    "--proxy-usage-log", join(root, "proxy", "usage.jsonl"),
    "--circuit-state", join(root, "proxy", "circuits.json"),
    "--proxy-runtime-log", join(root, "proxy", "daemon.log"),
    "--proxy-attach-state", join(root, "proxy", "attachment.json"),
    "--proxy-attach-backup", join(root, "proxy", "codex-config.backup.toml"),
    "--proxy-connect-state", join(root, "proxy", "connection.json"),
    "--proxy-connect-backup", join(root, "proxy", "connection-backups"),
    "--codex-config", join(root, "codex", "config.toml"),
    "--failover-store", join(root, "config", "failover.json"),
    "--pricing", join(root, "config", "pricing.json"),
    "--port", String(port)
  ];
}

function namedProxyArgs(root, port, instance) {
  const runtime = join(root, "proxy", "instances", instance);
  return [
    ...proxyArgs(root, port),
    "--instance", instance,
    "--proxy-config", join(runtime, "config.json"),
    "--proxy-state", join(runtime, "state.json"),
    "--proxy-lock", join(runtime, "runtime.lock"),
    "--proxy-capability", join(root, "config", "proxy-capabilities", `${instance}.json`),
    "--proxy-log", join(runtime, "requests.jsonl"),
    "--proxy-usage-log", join(runtime, "usage.jsonl"),
    "--circuit-state", join(runtime, "circuits.json"),
    "--proxy-runtime-log", join(runtime, "daemon.log"),
    "--proxy-attach-state", join(runtime, "attachment.json"),
    "--proxy-attach-backup", join(runtime, "codex-config.backup.toml"),
    "--proxy-connect-state", join(runtime, "connection.json"),
    "--proxy-connect-backup", join(runtime, "connection-backups")
  ];
}

function run(module, args, { status = 0, environment = {} } = {}) {
  const result = spawnSync(process.execPath, [module, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTCTL_PROXY_DAEMON: DAEMON,
      NO_COLOR: "1",
      ...environment
    }
  });
  assert.equal(
    result.status,
    status,
    `command status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function rawHttp(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", rejectRequest);
    });
    request.on("error", rejectRequest);
    if (body) request.end(body);
    else request.end();
  });
}

function rawWebSocketRoundTrip(url, { headers = {}, frame, responseBytes }) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const request = httpRequest(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("agentctl-test-key").toString("base64"),
        ...headers
      }
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish(new Error("WebSocket round trip timed out"));
    }, 3000);
    request.on("response", (response) => {
      response.resume();
      finish(new Error(`expected WebSocket upgrade, received ${response.statusCode}`));
    });
    request.on("upgrade", (response, socket, head) => {
      const chunks = [];
      let bytes = 0;
      const accept = (chunk) => {
        if (!chunk?.length || settled) return;
        chunks.push(Buffer.from(chunk));
        bytes += chunk.length;
        if (bytes >= responseBytes) {
          const body = Buffer.concat(chunks, bytes);
          socket.end();
          finish(null, { response, body });
        }
      };
      socket.on("data", accept);
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        if (bytes < responseBytes) finish(new Error("WebSocket closed before response frame"));
      });
      accept(head);
      socket.write(frame);
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

function rejectedWebSocketAndReset(url, { headers = {} } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const request = httpRequest(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("agentctl-reset-test-key").toString("base64"),
        ...headers
      }
    });
    request.on("response", (response) => {
      settled = true;
      const status = response.statusCode;
      response.destroy();
      response.socket?.destroy();
      resolveRequest(status);
    });
    request.on("error", (error) => {
      if (!settled) rejectRequest(error);
    });
    request.end();
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error("condition did not become true");
}

function websocketDataFrame(payload, {
  masked = false,
  fin = true,
  opcode = 0x1,
  rsv1 = false
} = {}) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  assert.ok(payload.length <= 0xffff);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const extendedBytes = payload.length < 126 ? 0 : 2;
  const frame = Buffer.alloc(2 + extendedBytes + (masked ? 4 : 0) + payload.length);
  frame[0] = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  frame[1] = (payload.length < 126 ? payload.length : 126) | (masked ? 0x80 : 0);
  let offset = 2;
  if (extendedBytes) {
    frame.writeUInt16BE(payload.length, offset);
    offset += extendedBytes;
  }
  if (masked) {
    mask.copy(frame, offset);
    offset += 4;
  }
  for (let index = 0; index < payload.length; index += 1) {
    frame[offset + index] = masked ? payload[index] ^ mask[index % 4] : payload[index];
  }
  return frame;
}

function websocketFrame(value, options = {}) {
  return websocketDataFrame(Buffer.from(JSON.stringify(value)), options);
}

function perMessageDeflatePayload(value) {
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(value)), {
    flush: zlibConstants.Z_SYNC_FLUSH,
    finishFlush: zlibConstants.Z_SYNC_FLUSH
  });
  assert.deepEqual(compressed.subarray(-4), Buffer.from([0x00, 0x00, 0xff, 0xff]));
  return Buffer.from(compressed.subarray(0, -4));
}

async function perMessageDeflatePayloads(values) {
  const deflater = createDeflateRaw();
  let chunks = [];
  deflater.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const payloads = [];
  try {
    for (const value of values) {
      await new Promise((resolveFlush, rejectFlush) => {
        const reject = (error) => rejectFlush(error);
        deflater.once("error", reject);
        deflater.write(Buffer.from(JSON.stringify(value)));
        deflater.flush(zlibConstants.Z_SYNC_FLUSH, () => {
          deflater.off("error", reject);
          const compressed = Buffer.concat(chunks);
          chunks = [];
          try {
            assert.deepEqual(
              compressed.subarray(-4),
              Buffer.from([0x00, 0x00, 0xff, 0xff])
            );
            payloads.push(Buffer.from(compressed.subarray(0, -4)));
            resolveFlush();
          } catch (error) {
            rejectFlush(error);
          }
        });
      });
    }
  } finally {
    deflater.destroy();
  }
  return payloads;
}

test("WebSocket observer reads split masked requests and unmasked usage without retaining frames", () => {
  const payloads = [];
  const observe = websocketObserver(4096, (payload) => payloads.push(payload));
  const request = websocketFrame({
    type: "response.create",
    response: { model: "gpt-ws", input: "private" }
  }, { masked: true });
  observe(request.subarray(0, 3));
  observe(request.subarray(3));
  observe(websocketFrame({
    type: "response.completed",
    response: {
      model: "gpt-ws",
      usage: { input_tokens: 11, output_tokens: 2 }
    }
  }));
  assert.deepEqual(payloads, [{
    type: "response.create",
    response: { model: "gpt-ws", input: "private" }
  }, {
    type: "response.completed",
    response: {
      model: "gpt-ws",
      usage: { input_tokens: 11, output_tokens: 2 }
    }
  }]);
});

test("WebSocket observer side-decompresses fragmented permessage-deflate with context takeover", async () => {
  const values = [{
    type: "response.create",
    response: { model: "gpt-ws-compressed", input: "repeated-context-".repeat(20) }
  }, {
    type: "response.completed",
    response: {
      model: "gpt-ws-compressed",
      output: "repeated-context-".repeat(20),
      usage: { input_tokens: 41, output_tokens: 7 }
    }
  }];
  const compressed = await perMessageDeflatePayloads(values);
  const payloads = [];
  const observe = websocketObserver(8192, (payload) => payloads.push(payload), {
    perMessageDeflate: { no_context_takeover: false, window_bits: 15 }
  });
  const split = Math.floor(compressed[0].length / 2);
  const first = websocketDataFrame(compressed[0].subarray(0, split), {
    fin: false,
    masked: true,
    opcode: 0x1,
    rsv1: true
  });
  const continuation = websocketDataFrame(compressed[0].subarray(split), {
    masked: true,
    opcode: 0x0
  });
  observe(first.subarray(0, 5));
  observe(first.subarray(5));
  observe(continuation);
  observe(websocketDataFrame(compressed[1], { opcode: 0x1, rsv1: true }));
  await observe.close();
  assert.deepEqual(payloads, values);
  assert.deepEqual(observe.summary(), { status: "complete", reasons: [] });
});

test("WebSocket usage waits for compressed request metadata before pairing responses", async () => {
  const turns = [];
  const usage = [];
  const client = websocketObserver(4096, (payload) => turns.push(payload.response), {
    perMessageDeflate: { no_context_takeover: true, window_bits: 15 }
  });
  const server = websocketObserver(4096, (payload) => {
    usage.push({ request: turns.shift() || null, response: payload.response });
  }, { beforeJson: () => client.flush() });
  const requests = [
    { model: "first-model", service_tier: "fast" },
    { model: "second-model", service_tier: "default" }
  ];
  const responses = requests.map((_, index) => ({
    id: `response-${index}`,
    usage: { input_tokens: index + 10, output_tokens: 2 }
  }));
  const frames = requests.map((response) => websocketDataFrame(
    perMessageDeflatePayload({ type: "response.create", response }),
    { masked: true, rsv1: true }
  ));
  const originals = frames.map((frame) => Buffer.from(frame));
  try {
    // Plain response frames parse synchronously while request inflation is still
    // queued. Close immediately as well, without relying on network timing.
    for (const [index, frame] of frames.entries()) {
      client(frame);
      server(websocketFrame({ type: "response.completed", response: responses[index] }));
    }
    assert.equal(turns.length, 0);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
  assert.deepEqual(usage, requests.map((request, index) => ({
    request,
    response: responses[index]
  })));
  assert.equal(turns.length, 0);
  assert.deepEqual(frames, originals);
  assert.deepEqual(client.summary(), { status: "complete", reasons: [] });
  assert.deepEqual(server.summary(), { status: "complete", reasons: [] });
});

test("WebSocket observer reports degradation without interrupting frame handling", async () => {
  const payloads = [];
  const observe = websocketObserver(4096, (payload) => payloads.push(payload), {
    perMessageDeflate: { no_context_takeover: false, window_bits: 15 }
  });
  observe(websocketDataFrame(Buffer.from([0xff, 0xff, 0xff, 0xff]), {
    opcode: 0x1,
    rsv1: true
  }));
  await observe.close();
  assert.deepEqual(payloads, []);
  assert.deepEqual(observe.summary(), {
    status: "degraded",
    reasons: ["inflate_error"]
  });
});

test("proxy route and URL projection is protocol-bounded", () => {
  assert.equal(allowedRoute("anthropic_messages", "POST", "/v1/messages"), true);
  assert.equal(allowedRoute("openai_responses", "POST", "/v1/responses"), true);
  assert.equal(allowedRoute("openai_responses", "POST", "/v1/responses/compact"), false);
  assert.equal(allowedRoute("openai_responses", "POST", "/v1/responses/compact", {
    responsesCompact: true
  }), true);
  assert.equal(allowedRoute("openai_chat", "POST", "/v1/chat/completions"), true);
  assert.equal(
    allowedRoute("google_generative", "POST", "/v1beta/models/gemini:test"),
    false
  );
  assert.equal(
    allowedRoute(
      "google_generative",
      "POST",
      "/v1beta/models/gemini:streamGenerateContent"
    ),
    true
  );
  assert.equal(allowedRoute("openai_responses", "POST", "/v1/../admin"), false);
  const passthrough = { mode: "openai_subscription_passthrough" };
  assert.equal(allowedRoute("openai_responses", "POST", "/realtime/calls", passthrough), true);
  assert.equal(allowedRoute("openai_responses", "POST", "/alpha/search", passthrough), true);
  assert.equal(allowedRoute("openai_responses", "POST", "/live", passthrough), false);
  assert.equal(allowedPassthroughWebSocketRoute("/responses"), true);
  assert.equal(allowedPassthroughWebSocketRoute("/realtime"), true);
  assert.equal(allowedPassthroughWebSocketRoute("/live/rtc_voice-1"), true);
  assert.equal(allowedPassthroughWebSocketRoute("/live/not-a-call"), false);

  const projectedResponse = projectPassthroughUrl(new URL(
    "http://127.0.0.1:17321/backend-api/codex/realtime/responses?stream=true"
  ));
  assert.equal(projectedResponse.pathname, "/responses");
  assert.equal(projectedResponse.search, "?stream=true");
  const projectedCall = projectPassthroughUrl(new URL(
    "http://127.0.0.1:17321/backend-api/codex/realtime/realtime/calls?intent=quicksilver"
  ));
  assert.equal(projectedCall.pathname, "/realtime/calls");
  const projectedWebSocket = projectPassthroughUrl(new URL(
    "ws://127.0.0.1:17321/backend-api/codex/realtime"
  ));
  assert.equal(projectedWebSocket.pathname, "/realtime");
  const projectedLive = projectPassthroughUrl(new URL(
    "ws://127.0.0.1:17321/backend-api/codex/live/rtc_voice-1"
  ));
  assert.equal(projectedLive.pathname, "/live/rtc_voice-1");

  const responses = joinUpstream(
    "https://api.example.com/v1?api-version=2026-01-01",
    new URL("http://127.0.0.1/v1/responses?stream=true")
  );
  assert.equal(responses.pathname, "/v1/responses");
  assert.equal(responses.searchParams.get("api-version"), "2026-01-01");
  assert.equal(responses.searchParams.get("stream"), "true");
  const anthropic = joinUpstream(
    "https://api.example.com/anthropic",
    new URL("http://127.0.0.1/v1/messages")
  );
  assert.equal(anthropic.pathname, "/anthropic/v1/messages");
  const subscription = joinUpstream(
    "https://chatgpt.com/backend-api/codex",
    new URL("http://127.0.0.1/v1/responses"),
    { stripVersionPrefix: true }
  );
  assert.equal(subscription.pathname, "/backend-api/codex/responses");
});

test("proxy header projection removes every local credential before upstream auth", () => {
  const headers = upstreamHeaders({
    headers: {
      authorization: "Bearer LOCAL-CAPABILITY",
      "x-agentctl-proxy-token": "LOCAL-CAPABILITY",
      "x-api-key": "LOCAL-CAPABILITY",
      "content-type": "application/json",
      "content-length": "999",
      digest: "sha-256=STALE-BODY-DIGEST",
      connection: "keep-alive, x-private-hop",
      "x-private-hop": "must-not-cross-proxy",
      "proxy-connection": "keep-alive"
    }
  }, "openai_responses", {
    auth: { mode: "bearer" }
  }, "REAL-UPSTREAM-SECRET", 17);
  assert.equal(headers.authorization, "Bearer REAL-UPSTREAM-SECRET");
  assert.equal(headers["x-agentctl-proxy-token"], undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers["proxy-connection"], undefined);
  assert.equal(headers["x-private-hop"], undefined);
  assert.equal(headers.digest, undefined);
  assert.equal(headers["content-length"], "17");
  assert.equal(headers["accept-encoding"], "identity");

  const passthrough = upstreamHeaders({
    headers: {
      authorization: "Bearer OFFICIAL-OPENAI-OAUTH",
      "chatgpt-account-id": "account-123",
      "x-agentctl-proxy-token": "must-not-leak",
      "user-agent": "codex-cli/test",
      "accept-encoding": "gzip, br",
      "content-type": "application/json"
    }
  }, "openai_responses", {
    auth: { mode: "openai_passthrough" }
  }, "", 11, { mode: "openai_subscription_passthrough" });
  assert.equal(passthrough.authorization, "Bearer OFFICIAL-OPENAI-OAUTH");
  assert.equal(passthrough["chatgpt-account-id"], "account-123");
  assert.equal(passthrough["user-agent"], "codex-cli/test");
  assert.equal(passthrough["accept-encoding"], "gzip, br");
  assert.equal(passthrough["x-agentctl-proxy-token"], undefined);

  const projectedResponse = responseHeaders({
    connection: "keep-alive, x-upstream-hop",
    "keep-alive": "timeout=5",
    "x-upstream-hop": "must-not-reach-client",
    "content-type": "application/json"
  });
  assert.equal(projectedResponse.connection, undefined);
  assert.equal(projectedResponse["keep-alive"], undefined);
  assert.equal(projectedResponse["x-upstream-hop"], undefined);
  assert.equal(projectedResponse["content-type"], "application/json");

  const reframedResponse = responseHeaders({
    "content-length": "17",
    "content-type": "application/json"
  }, { reframeBody: true });
  assert.equal(reframedResponse["content-length"], undefined);
  assert.equal(reframedResponse["content-type"], "application/json");
});

test("request admission bounds concurrent work and buffered bytes", () => {
  const admission = new RequestAdmission({ maxRequests: 2, maxBytes: 10 });
  const first = admission.acquire(6);
  assert.ok(first);
  const second = admission.acquire(0);
  assert.ok(second);
  assert.equal(second.add(4), true);
  assert.equal(second.add(1), false);
  assert.equal(admission.acquire(0), null);
  assert.deepEqual(admission.status(), {
    active_requests: 2,
    max_requests: 2,
    inflight_request_bytes: 10,
    max_inflight_request_bytes: 10,
    rejected_requests: 1
  });
  assert.equal(second.releaseBytes(4), true);
  first.release();
  second.release();
  assert.equal(admission.status().active_requests, 0);
  assert.equal(admission.status().inflight_request_bytes, 0);
});

test("named proxy defaults isolate every device-local runtime path", () => {
  const base = controllerProxyDefaults({
    platform: "linux",
    environment: {},
    home: "/tmp/agentctl-instance-home",
    instance: "default"
  });
  const work = controllerProxyDefaults({
    platform: "linux",
    environment: {},
    home: "/tmp/agentctl-instance-home",
    instance: "work-one"
  });
  for (const key of [
    "proxyConfig", "proxyState", "proxyLock", "proxyCapability", "proxyLog",
    "proxyUsageLog", "proxyRuntimeLog", "proxyCircuitState", "proxyAttachState",
    "proxyAttachBackup", "proxyConnectState", "proxyConnectBackup"
  ]) {
    assert.notEqual(work[key], base[key], `${key} should be instance-local`);
  }
  assert.notEqual(work.port, base.port);
  assert.match(
    work.proxyState.replaceAll("\\", "/"),
    /\/proxy\/instances\/work-one\/state\.json$/
  );
  assert.throws(() => controllerProxyDefaults({ instance: "Not Valid" }), /lowercase/);
});

test("daemon config rejects a non-loopback listener", () => {
  const root = "/tmp/agentctl-proxy-test";
  const config = {
    schema: 6,
    kind: "agentctl-proxy-config",
    instance: "default",
    instance_id: "11111111-1111-4111-8111-111111111111",
    created_at: new Date().toISOString(),
    mode: "provider",
    profile: "test",
    target: "codex",
    platform: "linux",
    protocol: "openai_responses",
    compaction: {
      mode: "client_local",
      label: "Local · upstream unverified",
      responses_compact: false
    },
    route: null,
    backends: [{
      profile: "test",
      endpoint: "https://api.example.com/v1",
      auth: { mode: "bearer", secret: "test_key" },
      models: { default: "test-model", aliases: {} }
    }],
    retry: {
      mode: "next_request",
      max_attempts: 1,
      status_codes: [],
      network_errors: false
    },
    circuit: {
      enabled: false,
      failure_threshold: 3,
      recovery_timeout_ms: 30000,
      half_open_max_requests: 1,
      state_retention_days: 30
    },
    retention: { files: 5, max_age_days: 30 },
    pricing: { catalog: join(root, "pricing"), model_source: "response" },
    listen: { host: "0.0.0.0", port: 17321 },
    timeouts: {
      first_byte_ms: 1000,
      stream_idle_ms: 1000,
      request_ms: 1000,
      request_body_ms: 1000
    },
    limits: {
      request_bytes: 1024,
      log_bytes: 65536,
      usage_log_bytes: 65536,
      usage_capture_bytes: 1024,
      max_concurrent_requests: 1,
      max_inflight_request_bytes: 1024
    },
    paths: {
      state: join(root, "state"),
      lock: join(root, "lock"),
      capability: join(root, "capability"),
      secrets: join(root, "secrets"),
      log: join(root, "log"),
      usage_log: join(root, "usage-log"),
      circuit_state: join(root, "circuit-state"),
      runtime_log: join(root, "runtime-log")
    },
    sources: {
      provider_store: join(root, "providers"),
      provider_secrets: join(root, "secrets"),
      failover_store: null,
      pricing_catalog: join(root, "pricing")
    }
  };
  assert.throws(() => validateConfig(config), /loopback/);
});

test("metadata and usage log retention is count- and age-bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-retention-"));
  const path = join(root, "requests.jsonl");
  const retention = { files: 3, max_age_days: 2 };
  try {
    await writeFile(path, "active\n", { mode: 0o600 });
    await writeFile(`${path}.1`, "previous\n", { mode: 0o600 });
    await writeFile(`${path}.2`, "oldest\n", { mode: 0o600 });
    await writeFile(`${path}.3`, "stale-extra\n", { mode: 0o600 });
    await rotateLog(path, retention, "test log");
    assert.equal(await readFile(`${path}.1`, "utf8"), "active\n");
    assert.equal(await readFile(`${path}.2`, "utf8"), "previous\n");
    await writeFile(path, "new-active\n", { mode: 0o600 });
    const old = new Date(Date.now() - 3 * 86400000);
    await utimes(`${path}.2`, old, old);
    await pruneLogs(path, retention, "test log");
    await assert.rejects(() => lstat(`${path}.2`), { code: "ENOENT" });
    await assert.rejects(() => lstat(`${path}.3`), { code: "ENOENT" });
    assert.equal(await readFile(path, "utf8"), "new-active\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentctl proxy usage safely lists and exactly summarizes retained tier metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-usage-cli-"));
  const port = 17321;
  const common = proxyArgs(root, port);
  const usagePath = join(root, "proxy", "usage.jsonl");
  const record = (overrides = {}) => ({
    schema: 1,
    timestamp: "2026-08-14T00:00:00.000Z",
    request_id: "request-1",
    profile: "passthrough",
    status: 200,
    duration_ms: 100,
    requested_model: "gpt-5.6-sol",
    response_model: "gpt-5.6-sol",
    pricing_model: "gpt-5.6-sol",
    requested_service_tier: null,
    response_service_tier: "default",
    pricing_service_tier: "standard",
    pricing_service_tier_source: "response",
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 0
    },
    cost: {
      currency: "USD",
      total: "0.1",
      input: "0.05",
      output: "0.03",
      cache_read: "0.02",
      cache_write: "0",
      rate_id: "standard-rate",
      service_tier: "standard",
      context_tokens: 12,
      estimated: true
    },
    pricing_unavailable: null,
    ...overrides
  });
  try {
    await mkdir(dirname(usagePath), { recursive: true });
    await writeFile(`${usagePath}.1`, `${JSON.stringify(record())}\n`, { mode: 0o600 });
    await writeFile(usagePath, [
      JSON.stringify(record({
        timestamp: "2026-08-14T00:01:00.000Z",
        request_id: "request-2",
        requested_service_tier: "priority",
        response_service_tier: "priority",
        pricing_service_tier: "fast",
        usage: {
          input_tokens: 20,
          output_tokens: 2,
          cache_read_tokens: 3,
          cache_write_tokens: 0
        },
        cost: {
          currency: "USD",
          total: "0.2",
          input: "0.1",
          output: "0.06",
          cache_read: "0.04",
          cache_write: "0",
          rate_id: "fast-rate",
          service_tier: "fast",
          context_tokens: 23,
          estimated: true
        },
        private_body: "MUST-NOT-BE-EMITTED"
      })),
      JSON.stringify(record({
        timestamp: "2026-08-14T00:02:00.000Z",
        request_id: "request-3",
        response_model: "gpt-5.6-luna",
        pricing_model: "gpt-5.6-luna",
        requested_service_tier: "priority",
        response_service_tier: "default",
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0
        },
        cost: null,
        pricing_unavailable: "rate_not_found"
      })),
      JSON.stringify(record({
        timestamp: "2026-08-14T00:03:00.000Z",
        request_id: "request-4",
        requested_service_tier: "priority",
        response_service_tier: null,
        pricing_service_tier: "fast",
        pricing_service_tier_source: "request_fallback",
        usage: null,
        cost: null,
        pricing_unavailable: "usage_missing"
      }))
    ].join("\n") + "\n", { mode: 0o600 });

    const listed = run(PROXY_CLIENT, [
      "usage", "--last", "3", ...common, "--json"
    ]);
    assert.equal(listed.stdout.includes("MUST-NOT-BE-EMITTED"), false);
    const listValue = JSON.parse(listed.stdout);
    assert.equal(listValue.total_records, 4);
    assert.equal(listValue.returned_records, 3);
    assert.deepEqual(
      listValue.records.map((item) => item.request_id),
      ["request-2", "request-3", "request-4"]
    );
    assert.equal(listValue.records[0].pricing_service_tier, "fast");
    assert.equal(listValue.records[1].pricing_unavailable, "rate_not_found");
    assert.equal(listValue.records[2].pricing_service_tier_source, "request_fallback");

    const summary = JSON.parse(run(PROXY_CLIENT, [
      "usage", "--summary", ...common, "--json"
    ]).stdout);
    assert.equal(summary.requests, 4);
    assert.equal(summary.priced_requests, 2);
    assert.equal(summary.unpriced_requests, 2);
    assert.deepEqual(summary.tokens, {
      input: 35,
      output: 3,
      cache_read: 5,
      cache_write: 0
    });
    assert.deepEqual(summary.costs, { USD: "0.3" });
    assert.equal(summary.by_service_tier.standard.requests, 2);
    assert.equal(summary.by_service_tier.fast.requests, 2);
    assert.deepEqual(summary.service_tiers, {
      fast_requested: 3,
      fast_effective: 1,
      fast_downgraded: 1,
      transitions: {
        "fast->fast": 1,
        "fast->standard": 1,
        "fast->unspecified": 1,
        "unspecified->standard": 1
      }
    });
    assert.equal(summary.by_model["gpt-5.6-sol"].requests, 3);
    assert.equal(summary.by_model["gpt-5.6-luna"].requests, 1);

    const textSummary = run(PROXY_CLIENT, [
      "usage", "--summary", "--last", "2", ...common
    ]).stdout;
    assert.match(textSummary, /2 request\(s\) · 0 priced · 2 unpriced/);
    assert.match(textSummary, /Cost:\s+unavailable/);
    assert.match(textSummary, /2 requested · 0 effective · 1 downgraded/);

    if (process.platform !== "win32") {
      await chmod(usagePath, 0o644);
      const refused = run(PROXY_CLIENT, [
        "usage", ...common, "--json"
      ], { status: 1 });
      assert.match(refused.stderr, /owner-only/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hot-path persistence coalesces circuit writes and bounds log backlog", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-persistence-"));
  try {
    let revision = 0;
    const writes = [];
    const persist = circuitPersister(join(root, "circuits.json"), {
      snapshot: () => ({ revision, entries: [{ revision }] })
    }, {
      delayMs: 5,
      write: async (_path, snapshot) => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2));
        writes.push(snapshot);
      }
    });
    for (revision = 1; revision <= 100; revision += 1) persist();
    revision = 100;
    await persist.flush();
    assert.ok(writes.length <= 2);
    assert.equal(writes.at(-1).revision, 100);
    assert.equal(persist.status().pending, false);

    const logPath = join(root, "bounded.jsonl");
    const logger = jsonlLogger(
      logPath,
      65536,
      { files: 3, max_age_days: 2 },
      "bounded test log",
      { maxQueue: 2 }
    );
    for (let index = 0; index < 20; index += 1) logger({ index });
    await logger.flush();
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(logger.status().pending, 0);
    assert.equal(logger.status().dropped, 18);
    assert.equal(logger.status().healthy, false);
    assert.equal(logger.status().last_error, "queue_full");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic, OpenAI Chat, and Google native protocols preserve route and auth semantics", async () => {
  const cases = [
    {
      name: "anthropic-native",
      protocol: "anthropic_messages",
      authMode: "x-api-key",
      target: "claude",
      endpointPrefix: "",
      localPath: "/v1/messages",
      upstreamPath: "/v1/messages",
      upstreamHeader: "x-api-key"
    },
    {
      name: "chat-native",
      protocol: "openai_chat",
      authMode: "bearer",
      target: "opencode",
      endpointPrefix: "/v1",
      localPath: "/v1/chat/completions",
      upstreamPath: "/v1/chat/completions",
      upstreamHeader: "authorization"
    },
    {
      name: "google-native",
      protocol: "google_generative",
      authMode: "x-goog-api-key",
      target: "pi",
      endpointPrefix: "/v1beta",
      localPath: "/v1beta/models/gemini:generateContent",
      upstreamPath: "/v1beta/models/gemini:generateContent",
      upstreamHeader: "x-goog-api-key"
    }
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `agent-proxy-${item.name}-`));
    let observed = null;
    const upstream = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        observed = {
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8")
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    const upstreamPort = await listen(upstream);
    const proxyPort = await freePort();
    const commonProxy = proxyArgs(root, proxyPort);
    let pid = 0;
    try {
      run(PROVIDER_CLIENT, ["init", ...providerArgs(root), "--yes"]);
      run(PROVIDER_CLIENT, [
        "create", item.name,
        "--protocol", item.protocol,
        "--base-url", `http://127.0.0.1:${upstreamPort}${item.endpointPrefix}`,
        "--model", "test-model",
        "--auth-mode", item.authMode,
        "--secret", "upstream_key",
        ...providerArgs(root), "--yes"
      ]);
      const keyFile = join(root, "upstream-key");
      await writeFile(keyFile, "UPSTREAM-NATIVE-KEY\n", { mode: 0o600 });
      await chmod(keyFile, 0o600);
      run(PROVIDER_CLIENT, [
        "secret", "set", "upstream_key", "--secret-file", keyFile,
        ...providerArgs(root), "--yes"
      ]);
      const started = JSON.parse(run(PROXY_CLIENT, [
        "start", item.name, "--target", item.target,
        ...commonProxy, "--yes", "--json"
      ]).stdout);
      pid = started.pid;
      const capability = JSON.parse(await readFile(
        join(root, "config", "proxy-capability.json"), "utf8"
      ));
      const response = await fetch(`http://127.0.0.1:${proxyPort}${item.localPath}`, {
        method: "POST",
        headers: {
          "x-agentctl-proxy-token": capability.token,
          "content-type": "application/json",
          ...(item.protocol === "anthropic_messages"
            ? { "anthropic-beta": "compact-2026-01-12" }
            : {})
        },
        body: JSON.stringify({
          model: "test-model",
          ...(item.protocol === "anthropic_messages"
            ? { context_management: { edits: [{ type: "compact_20260112" }] } }
            : {})
        })
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(observed.path, item.upstreamPath);
      const expected = item.upstreamHeader === "authorization"
        ? "Bearer UPSTREAM-NATIVE-KEY"
        : "UPSTREAM-NATIVE-KEY";
      assert.equal(observed.headers[item.upstreamHeader], expected);
      assert.equal(observed.headers["x-agentctl-proxy-token"], undefined);
      if (item.protocol === "anthropic_messages") {
        assert.equal(observed.headers["anthropic-beta"], "compact-2026-01-12");
        assert.equal(JSON.parse(observed.body).context_management.edits[0].type,
          "compact_20260112");
      }
      run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"]);
      pid = 0;
    } finally {
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      await closeServer(upstream);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("proxy lifecycle forwards native Responses securely and keeps metadata body-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-integration-"));
  const requests = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        localToken: request.headers["x-agentctl-proxy-token"],
        xApiKey: request.headers["x-api-key"],
        body
      });
      if (body.includes("SLOW-FIRST-BYTE")) {
        setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"late":true}');
          }
        }, 350);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        model: "response-priced",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 40 }
        }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const commonProxy = [
    ...proxyArgs(root, proxyPort),
    "--first-byte-timeout-ms", "150",
    "--stream-idle-timeout-ms", "1000",
    "--request-timeout-ms", "2000",
    "--request-bytes", "1024",
    "--log-bytes", "65536"
  ];
  let proxyPid = 0;
  try {
    run(PROVIDER_CLIENT, ["init", ...providerArgs(root), "--yes"]);
    run(PROVIDER_CLIENT, [
      "create", "local-responses",
      "--protocol", "openai_responses",
      "--base-url", `http://127.0.0.1:${upstreamPort}/v1`,
      "--model", "model-a",
      "--alias", "model-a=vendor-model-a",
      "--auth-mode", "bearer",
      "--secret", "upstream_key",
      "--compaction-upstream", "responses_v2",
      ...providerArgs(root), "--yes"
    ]);
    const keyFile = join(root, "upstream-key");
    await writeFile(keyFile, "REAL-UPSTREAM-SECRET\n", { mode: 0o600 });
    await chmod(keyFile, 0o600);
    run(PROVIDER_CLIENT, [
      "secret", "set", "upstream_key", "--secret-file", keyFile,
      ...providerArgs(root), "--yes"
    ]);
    const pricingPath = join(root, "config", "pricing.json");
    run(PRICING_CLIENT, [
      "init", "--version", "2026.08-test",
      "--pricing", pricingPath, "--yes", "--json"
    ]);
    run(PRICING_CLIENT, [
      "set", "response-priced",
      "--profile", "local-responses",
      "--model", "response-priced",
      "--input", "2",
      "--output", "10",
      "--cache-read", "0.2",
      "--cache-write", "0",
      "--effective-at", "2020-01-01T00:00:00.000Z",
      "--source", "isolated integration fixture",
      "--pricing", pricingPath, "--yes", "--json"
    ]);

    const preview = JSON.parse(run(PROXY_CLIENT, [
      "plan", "local-responses", "--target", "codex", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(preview.ready, true);
    assert.equal(preview.auto_attach, false);
    assert.equal(preview.local_base_url, `http://127.0.0.1:${proxyPort}/v1`);
    assert.equal(preview.auth.secret, "upstream_key");
    assert.equal(preview.models.requested_default, "model-a");
    assert.equal(preview.models.outbound_default, "vendor-model-a");
    assert.equal(preview.compaction.mode, "remote_native");
    assert.equal(preview.compaction.responses_compact, true);
    assert.equal(preview.pricing.version, "2026.08-test");
    assert.equal(JSON.stringify(preview).includes("REAL-UPSTREAM-SECRET"), false);

    run(PROXY_CLIENT, [
      "start", "local-responses", "--target", "codex", ...commonProxy, "--json"
    ]);
    await assert.rejects(() => lstat(join(root, "proxy", "state.json")), { code: "ENOENT" });

    const started = JSON.parse(run(PROXY_CLIENT, [
      "start", "local-responses", "--target", "codex",
      ...commonProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = started.pid;
    assert.equal(started.auto_attach, false);
    assert.equal(JSON.stringify(started).includes("REAL-UPSTREAM-SECRET"), false);

    const running = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(running.status, "running");
    assert.equal(running.pid, proxyPid);
    assert.equal(running.pricing_catalog_version, "2026.08-test");
    assert.equal(running.observability.metadata_log.healthy, true);
    assert.equal(running.observability.usage_log.healthy, true);
    assert.equal(running.observability.circuit_state.last_error, null);
    assert.equal(running.pricing_model_source, "response");
    assert.equal(running.compaction.mode, "remote_native");
    assert.deepEqual(running.configuration, { restart_required: false, changed: [] });
    assert.equal(running.admission.max_requests, 64);
    assert.equal(running.admission.active_requests, 0);
    assert.equal(Object.hasOwn(running, "token"), false);

    const providerStorePath = join(root, "config", "providers.json");
    await writeFile(
      providerStorePath,
      `${await readFile(providerStorePath, "utf8")}\n`,
      { mode: 0o600 }
    );
    const drifted = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(drifted.status, "running");
    assert.equal(drifted.configuration.restart_required, true);
    assert.ok(drifted.configuration.changed.includes("provider_store"));

    const capabilityPath = join(root, "config", "proxy-capability.json");
    const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    const localUrl = `http://127.0.0.1:${proxyPort}/v1/responses`;
    const unauthorized = await fetch(localUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"model":"model-a"}'
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(requests.length, 0);

    const bodyMarker = "BODY-MUST-NOT-ENTER-METADATA";
    const forwarded = await fetch(localUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "model-a", input: bodyMarker })
    });
    assert.equal(forwarded.status, 200);
    assert.deepEqual(await forwarded.json(), {
      ok: true,
      model: "response-priced",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 40 }
      }
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/responses");
    assert.equal(requests[0].authorization, "Bearer REAL-UPSTREAM-SECRET");
    assert.equal(requests[0].localToken, undefined);
    assert.equal(requests[0].xApiKey, undefined);
    assert.match(requests[0].body, /BODY-MUST-NOT-ENTER-METADATA/);
    assert.equal(JSON.parse(requests[0].body).model, "vendor-model-a");

    const compacted = await fetch(`${localUrl}/compact`, {
      method: "POST",
      headers: {
        "x-agentctl-proxy-token": capability.token,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "model-a", input: "COMPACT-MARKER" })
    });
    assert.equal(compacted.status, 200);
    await compacted.arrayBuffer();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].path, "/v1/responses/compact");
    assert.equal(JSON.parse(requests[1].body).model, "vendor-model-a");

    const wrongRoute = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-agentctl-proxy-token": capability.token }
    });
    assert.equal(wrongRoute.status, 404);
    assert.equal(requests.length, 2);

    const tooLarge = await fetch(localUrl, {
      method: "POST",
      headers: { "x-agentctl-proxy-token": capability.token },
      body: "x".repeat(2048)
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(requests.length, 2);

    const timedOut = await fetch(localUrl, {
      method: "POST",
      headers: {
        "x-agentctl-proxy-token": capability.token,
        "content-type": "application/json"
      },
      body: '{"input":"SLOW-FIRST-BYTE"}'
    });
    assert.equal(timedOut.status, 504);
    assert.deepEqual(await timedOut.json(), { error: "first_byte_timeout" });

    const metadataPath = join(root, "proxy", "requests.jsonl");
    const metadataText = await waitFor(async () => {
      try {
        const text = await readFile(metadataPath, "utf8");
        return text.split("\n").filter(Boolean).length >= 6 ? text : "";
      } catch {
        return "";
      }
    });
    assert.equal(metadataText.includes(bodyMarker), false);
    assert.equal(metadataText.includes("REAL-UPSTREAM-SECRET"), false);
    assert.equal(metadataText.includes(capability.token), false);
    for (const line of metadataText.split("\n").filter(Boolean)) {
      const record = JSON.parse(line);
      assert.equal(Object.hasOwn(record, "headers"), false);
      assert.equal(Object.hasOwn(record, "body"), false);
    }

    const usagePath = join(root, "proxy", "usage.jsonl");
    const usageText = await waitFor(async () => {
      try {
        const text = await readFile(usagePath, "utf8");
        return text.includes('"response_model":"response-priced"') ? text : "";
      } catch {
        return "";
      }
    });
    assert.equal(usageText.includes(bodyMarker), false);
    assert.equal(usageText.includes("REAL-UPSTREAM-SECRET"), false);
    assert.equal(usageText.includes(capability.token), false);
    const usageRecord = usageText.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((record) => record.response_model === "response-priced");
    assert.equal(usageRecord.requested_model, "model-a");
    assert.equal(usageRecord.outbound_model, "vendor-model-a");
    assert.equal(usageRecord.pricing_model, "response-priced");
    assert.equal(usageRecord.pricing_model_source, "response");
    assert.deepEqual(usageRecord.usage, {
      input_tokens: 60,
      output_tokens: 20,
      cache_read_tokens: 40,
      cache_write_tokens: 0
    });
    assert.equal(usageRecord.cost.total, "0.000328");
    assert.equal(usageRecord.cost.catalog_version, "2026.08-test");
    assert.equal(Object.hasOwn(usageRecord, "body"), false);

    const stopPreview = JSON.parse(run(PROXY_CLIENT, [
      "stop", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(stopPreview.preview, true);
    assert.equal(JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout).status, "running");

    const stopped = JSON.parse(run(PROXY_CLIENT, [
      "stop", ...commonProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = 0;
    assert.equal(stopped.status, "stopped");
    assert.equal(JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout).status, "stopped");

    const beforeRotate = capability.token;
    const rotatePreview = JSON.parse(run(PROXY_CLIENT, [
      "token", "rotate", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(rotatePreview.preview, true);
    run(PROXY_CLIENT, ["token", "rotate", ...commonProxy, "--yes", "--json"]);
    const afterRotate = JSON.parse(await readFile(capabilityPath, "utf8")).token;
    assert.notEqual(afterRotate, beforeRotate);

    for (const path of [
      capabilityPath,
      join(root, "proxy", "config.json"),
      join(root, "proxy", "requests.jsonl"),
      join(root, "proxy", "usage.jsonl"),
      join(root, "proxy", "daemon.log")
    ]) {
      if (process.platform === "win32") assert.equal((await lstat(path)).isFile(), true);
      else assert.equal((await lstat(path)).mode & 0o077, 0);
    }
    const runtimeLog = await readFile(join(root, "proxy", "daemon.log"), "utf8");
    assert.equal(runtimeLog.includes("REAL-UPSTREAM-SECRET"), false);
    assert.equal(runtimeLog.includes(beforeRotate), false);
  } finally {
    if (proxyPid) {
      try { process.kill(proxyPid, "SIGTERM"); } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("named proxy instances run and stop independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-multi-instance-"));
  let requests = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  const alphaPort = await freePort();
  let betaPort = await freePort();
  while (betaPort === alphaPort) betaPort = await freePort();
  const alpha = namedProxyArgs(root, alphaPort, "alpha");
  const beta = namedProxyArgs(root, betaPort, "beta");
  let alphaPid = 0;
  let betaPid = 0;
  try {
    run(PROVIDER_CLIENT, ["init", ...providerArgs(root), "--yes"]);
    run(PROVIDER_CLIENT, [
      "create", "multi-instance",
      "--protocol", "openai_responses",
      "--base-url", `http://127.0.0.1:${upstreamPort}/v1`,
      "--model", "model-shared",
      "--auth-mode", "bearer",
      "--secret", "shared_key",
      ...providerArgs(root), "--yes"
    ]);
    const keyFile = join(root, "shared-key");
    await writeFile(keyFile, "SHARED-UPSTREAM-KEY\n", { mode: 0o600 });
    run(PROVIDER_CLIENT, [
      "secret", "set", "shared_key", "--secret-file", keyFile,
      ...providerArgs(root), "--yes"
    ]);

    const alphaStarted = JSON.parse(run(PROXY_CLIENT, [
      "start", "multi-instance", "--target", "codex", ...alpha, "--yes", "--json"
    ]).stdout);
    alphaPid = alphaStarted.pid;
    const betaStarted = JSON.parse(run(PROXY_CLIENT, [
      "start", "multi-instance", "--target", "codex", ...beta, "--yes", "--json"
    ]).stdout);
    betaPid = betaStarted.pid;
    assert.equal(alphaStarted.instance, "alpha");
    assert.equal(betaStarted.instance, "beta");
    assert.notEqual(alphaPid, betaPid);

    for (const [args, port, instance] of [
      [alpha, alphaPort, "alpha"],
      [beta, betaPort, "beta"]
    ]) {
      const state = JSON.parse(run(PROXY_CLIENT, ["status", ...args, "--json"]).stdout);
      assert.equal(state.status, "running");
      assert.equal(state.instance, instance);
      const capability = JSON.parse(await readFile(state.capability_file, "utf8"));
      const forwarded = await rawHttp(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          "x-agentctl-proxy-token": capability.token,
          "content-type": "application/json"
        },
        body: Buffer.from('{"model":"model-shared","input":"instance-test"}')
      });
      assert.equal(forwarded.status, 200);
    }
    assert.equal(requests, 2);

    run(PROXY_CLIENT, ["stop", ...alpha, "--yes", "--json"]);
    alphaPid = 0;
    assert.equal(
      JSON.parse(run(PROXY_CLIENT, ["status", ...beta, "--json"]).stdout).status,
      "running"
    );
    run(PROXY_CLIENT, ["stop", ...beta, "--yes", "--json"]);
    betaPid = 0;
  } finally {
    for (const pid of [alphaPid, betaPid]) {
      if (!pid) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider connect/disconnect is preview-first, guarded, and exact-restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-connect-"));
  const home = join(root, "home");
  const agentRoot = join(root, "fake-agent");
  const codexRoot = join(home, ".codex");
  const codexConfig = join(codexRoot, "config.toml");
  const codexAuth = join(codexRoot, "auth.json");
  const originalConfig = Buffer.from(
    'model_provider = "external"\napproval_policy = "on-request"\n'
  );
  const originalAuth = Buffer.from('{"account":"official-identity"}\n');
  const setup = join(agentRoot, "codex", "setup.sh");
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const commonProxy = proxyArgs(root, proxyPort);
  const environment = {
    HOME: home,
    USERPROFILE: home,
    AGENTCTL_AGENT_ROOT: agentRoot
  };
  let proxyPid = 0;
  try {
    await mkdir(dirname(setup), { recursive: true });
    await writeFile(setup, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "base_url=''",
      "model=''",
      "key_file=''",
      "force=0",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    --base-url) base_url=$2; shift 2 ;;",
      "    --model) model=$2; shift 2 ;;",
      "    --key-file) key_file=$2; shift 2 ;;",
      "    --force) force=1; shift ;;",
      "    --skip-validate) shift ;;",
      "    *) if [ \"$#\" -gt 1 ] && [[ $2 != --* ]]; then shift 2; else shift; fi ;;",
      "  esac",
      "done",
      "root=$HOME/.codex",
      "if [ -e \"$root/config.toml\" ] && [ \"$force\" -ne 1 ]; then exit 42; fi",
      "mkdir -p \"$root/provider-keys\"",
      "key=$root/provider-keys/script_toolbox_custom.key",
      "cp \"$key_file\" \"$key\"",
      "chmod 600 \"$key\"",
      "printf 'model_provider = \"agentctl-proxy\"\\nmodel = \"%s\"\\nbase_url = \"%s\"\\n' \"$model\" \"$base_url\" > \"$root/config.toml\"",
      "printf '%s\\n' \"$key\" > \"$root/.script-toolbox-provider-key\"",
      "printf 'managed-by-fake-backend\\n' > \"$root/.script-toolbox-defaults-backup.toml\"",
      ""
    ].join("\n"), { mode: 0o700 });
    await chmod(setup, 0o700);
    await mkdir(codexRoot, { recursive: true });
    await writeFile(codexConfig, originalConfig, { mode: 0o640 });
    await writeFile(codexAuth, originalAuth, { mode: 0o600 });

    run(PROVIDER_CLIENT, ["init", ...providerArgs(root), "--yes"]);
    run(PROVIDER_CLIENT, [
      "create", "connectable",
      "--protocol", "openai_responses",
      "--base-url", `http://127.0.0.1:${upstreamPort}/v1`,
      "--model", "model-connect",
      "--auth-mode", "bearer",
      "--secret", "connect_upstream",
      "--compaction-upstream", "responses_v2",
      ...providerArgs(root), "--yes"
    ]);
    const upstreamKey = join(root, "upstream-connect.key");
    await writeFile(upstreamKey, "CONNECT-UPSTREAM-KEY\n", { mode: 0o600 });
    run(PROVIDER_CLIENT, [
      "secret", "set", "connect_upstream", "--secret-file", upstreamKey,
      ...providerArgs(root), "--yes"
    ]);
    proxyPid = JSON.parse(run(PROXY_CLIENT, [
      "start", "connectable", "--target", "codex",
      ...commonProxy, "--yes", "--json"
    ], { environment }).stdout).pid;

    const preview = JSON.parse(run(PROXY_CLIENT, [
      "connect", "codex", ...commonProxy, "--json"
    ], { environment }).stdout);
    assert.equal(preview.preview, true);
    assert.deepEqual(await readFile(codexConfig), originalConfig);

    const refused = run(PROXY_CLIENT, [
      "connect", "codex", ...commonProxy, "--yes", "--json"
    ], { status: 1, environment });
    assert.match(refused.stderr, /previous files will be restored/);
    assert.deepEqual(await readFile(codexConfig), originalConfig);

    const connected = JSON.parse(run(PROXY_CLIENT, [
      "connect", "codex", ...commonProxy, "--force", "--yes", "--json"
    ], { environment }).stdout);
    assert.equal(connected.status, "connected");
    const connectedConfig = await readFile(codexConfig);
    const connectedMode = (await lstat(codexConfig)).mode & 0o777;
    assert.match(connectedConfig.toString("utf8"), new RegExp(
      `base_url = "http:\\/\\/127\\.0\\.0\\.1:${proxyPort}\\/v1"`
    ));
    assert.deepEqual(await readFile(codexAuth), originalAuth);
    const connectionStatus = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ], { environment }).stdout);
    assert.equal(connectionStatus.connection.status, "connected");
    assert.equal(connectionStatus.connection.target, "codex");

    const guardedStop = run(PROXY_CLIENT, [
      "stop", ...commonProxy, "--yes", "--json"
    ], { status: 1, environment });
    assert.match(guardedStop.stderr, /disconnect codex before stopping/);

    await writeFile(codexConfig, "tampered\n", { mode: connectedMode });
    const guardedDisconnect = run(PROXY_CLIENT, [
      "disconnect", "codex", ...commonProxy, "--yes", "--json"
    ], { status: 1, environment });
    assert.match(guardedDisconnect.stderr, /changed after proxy connect/);
    await writeFile(codexConfig, connectedConfig, { mode: connectedMode });
    await chmod(codexConfig, connectedMode);

    const disconnectPreview = JSON.parse(run(PROXY_CLIENT, [
      "disconnect", "codex", ...commonProxy, "--json"
    ], { environment }).stdout);
    assert.equal(disconnectPreview.preview, true);
    const disconnected = JSON.parse(run(PROXY_CLIENT, [
      "disconnect", "codex", ...commonProxy, "--yes", "--json"
    ], { environment }).stdout);
    assert.equal(disconnected.status, "disconnected");
    assert.deepEqual(await readFile(codexConfig), originalConfig);
    if (process.platform !== "win32") {
      assert.equal((await lstat(codexConfig)).mode & 0o777, 0o640);
    }
    assert.deepEqual(await readFile(codexAuth), originalAuth);
    for (const path of [
      join(codexRoot, ".script-toolbox-provider-key"),
      join(codexRoot, ".script-toolbox-defaults-backup.toml"),
      join(codexRoot, "provider-keys", "script_toolbox_custom.key"),
      join(root, "proxy", "connection.json"),
      join(root, "proxy", "connection-backups")
    ]) {
      await assert.rejects(() => lstat(path), { code: "ENOENT" });
    }
    run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"], { environment });
    proxyPid = 0;
  } finally {
    if (proxyPid) {
      try { process.kill(proxyPid, "SIGTERM"); } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAI subscription passthrough is byte-preserving and detach preserves Codex App edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-passthrough-"));
  const observed = [];
  const observedWebSockets = [];
  let resolveStreamProbe;
  const streamProbeSeen = new Promise((resolveProbe) => {
    resolveStreamProbe = resolveProbe;
  });
  const websocketRequestPayload = {
    type: "response.create",
    response: {
      model: "gpt-ws-compressed",
      service_tier: "fast",
      input: "PASSTHROUGH-WEBSOCKET-BODY-MARKER"
    }
  };
  const websocketResponsePayload = {
    type: "response.completed",
    response: {
      id: "resp_ws_passthrough",
      model: "gpt-5.6-sol",
      service_tier: "default",
      usage: { input_tokens: 29, output_tokens: 8 }
    }
  };
  const websocketRequestFrame = websocketDataFrame(
    perMessageDeflatePayload(websocketRequestPayload),
    { masked: true, rsv1: true }
  );
  const websocketResponseFrame = websocketDataFrame(
    perMessageDeflatePayload(websocketResponsePayload),
    { rsv1: true }
  );
  const upstreamResponseBody = Buffer.from(
    'data: {"type":"response.completed","response":{' +
    '"id":"resp_passthrough","model":"gpt-5.6-sol","service_tier":"default",' +
    '"usage":{"input_tokens":17,"output_tokens":5}}}\n\n'
  );
  const compressedUpstreamResponse = gzipSync(upstreamResponseBody);
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
      if (request.url.includes("stream_probe=1")) resolveStreamProbe();
    });
    request.on("end", () => {
      observed.push({
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks)
      });
      if (request.url.startsWith("/backend-api/codex/realtime/calls")) {
        response.writeHead(200, {
          "content-type": "application/sdp",
          location: "/v1/realtime/calls/rtc_passthrough_test"
        });
        response.end("v=0\r\n");
        return;
      }
      if (request.url === "/backend-api/codex/alpha/search") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"output":"search result","results":[]}');
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": compressedUpstreamResponse.length
      });
      const split = Math.floor(compressedUpstreamResponse.length / 2);
      response.write(compressedUpstreamResponse.subarray(0, split));
      setImmediate(() => response.end(compressedUpstreamResponse.subarray(split)));
    });
  });
  upstream.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    if (request.url.includes("reject_reset=1")) {
      const body = Buffer.alloc(2 * 1024 * 1024, 0x78);
      socket.write([
        "HTTP/1.1 401 Unauthorized",
        "Content-Type: application/json",
        `Content-Length: ${body.length}`,
        "Connection: close",
        "",
        ""
      ].join("\r\n"));
      socket.end(body);
      return;
    }
    const record = {
      path: request.url,
      headers: request.headers,
      chunks: [],
      bytes: 0,
      body: null
    };
    observedWebSockets.push(record);
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover",
      "",
      ""
    ].join("\r\n"));
    const readFrame = (chunk) => {
      if (!chunk?.length || record.body) return;
      record.chunks.push(Buffer.from(chunk));
      record.bytes += chunk.length;
      if (record.bytes >= websocketRequestFrame.length) {
        record.body = Buffer.concat(record.chunks, record.bytes);
        socket.write(websocketResponseFrame);
        setTimeout(() => socket.end(), 20);
      }
    };
    socket.on("data", readFrame);
    readFrame(head);
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const commonProxy = [
    ...proxyArgs(root, proxyPort),
    "--max-concurrent-requests", "1",
    "--request-body-timeout-ms", "1200",
    "--upstream-base-url", `http://127.0.0.1:${upstreamPort}/backend-api/codex`
  ];
  const codexConfig = join(root, "codex", "config.toml");
  const original = Buffer.from([
    '# user config must return byte-for-byte',
    'model_provider = "previous-provider"',
    'openai_base_url = "https://previous.invalid"',
    'approval_policy = "on-request"',
    '',
    '[model_providers.previous-provider]',
    'name = "Previous"',
    'base_url = "https://previous.invalid/v1"',
    ''
  ].join("\n"));
  let proxyPid = 0;
  try {
    await mkdir(dirname(codexConfig), { recursive: true });
    await writeFile(codexConfig, original, { mode: 0o640 });
    run(PRICING_CLIENT, [
      "init", "--preset", "openai-gpt-5.6",
      "--pricing", join(root, "config", "pricing.json"),
      "--yes", "--json"
    ]);

    const plan = JSON.parse(run(PROXY_CLIENT, [
      "plan", "passthrough", "--target", "codex", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(plan.mode, "openai_subscription_passthrough");
    assert.equal(
      plan.local_base_url,
      `http://127.0.0.1:${proxyPort}/backend-api/codex/realtime`
    );
    assert.equal(plan.auth.mode, "openai_passthrough");
    assert.equal(plan.models.requested_default, "unchanged");
    assert.equal(plan.retry.max_attempts, 1);
    assert.deepEqual(plan.retry.status_codes, []);
    assert.equal(plan.auto_attach, false);
    const unsafePlan = run(PROXY_CLIENT, [
      "plan", "passthrough", "--target", "codex", ...commonProxy,
      "--upstream-base-url", "https://example.com/backend-api/codex", "--json"
    ], { status: 1 });
    assert.match(unsafePlan.stderr, /official ChatGPT Codex endpoint or loopback/);

    const started = JSON.parse(run(PROXY_CLIENT, [
      "start", "passthrough", "--target", "codex",
      ...commonProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = started.pid;
    assert.equal(started.mode, "openai_subscription_passthrough");

    const requestBody = Buffer.from(
      '{"model":"gpt-requested-exactly","service_tier":"fast","input":"PASSTHROUGH-BODY-MARKER","stream":true}'
    );
    const response = await rawHttp(`${plan.local_base_url}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
        "chatgpt-account-id": "official-account-id",
        "user-agent": "codex-cli/integration-test",
        "accept-encoding": "gzip",
        "content-type": "application/json",
        connection: "close"
      },
      body: requestBody
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.equal(response.headers["content-length"], undefined);
    assert.deepEqual(response.body, compressedUpstreamResponse);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].path, "/backend-api/codex/responses");
    assert.equal(observed[0].headers.authorization, "Bearer OFFICIAL-CHATGPT-OAUTH");
    assert.equal(observed[0].headers["chatgpt-account-id"], "official-account-id");
    assert.equal(observed[0].headers["user-agent"], "codex-cli/integration-test");
    assert.equal(observed[0].headers["x-agentctl-proxy-token"], undefined);
    assert.equal(observed[0].headers["accept-encoding"], "gzip");
    assert.deepEqual(observed[0].body, requestBody);

    const realtimeBody = Buffer.from(JSON.stringify({
      sdp: "v=offer\r\n",
      session: { type: "realtime", model: "gpt-realtime" }
    }));
    const realtime = await rawHttp(
      `${plan.local_base_url}/realtime/calls?intent=quicksilver&architecture=avas`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
          "content-type": "application/json",
          connection: "close"
        },
        body: realtimeBody
      }
    );
    assert.equal(realtime.status, 200);
    assert.equal(realtime.headers.location, "/v1/realtime/calls/rtc_passthrough_test");
    assert.deepEqual(realtime.body, Buffer.from("v=0\r\n"));

    const searchBody = Buffer.from(
      '{"id":"search-test","model":"gpt-search","commands":{"search_query":[{"q":"test"}]}}'
    );
    const search = await rawHttp(`${plan.local_base_url}/alpha/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
        "content-type": "application/json",
        connection: "close"
      },
      body: searchBody
    });
    assert.equal(search.status, 200);
    assert.deepEqual(search.body, Buffer.from('{"output":"search result","results":[]}'));
    assert.equal(observed.length, 3);
    assert.equal(
      observed[1].path,
      "/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
    );
    assert.deepEqual(observed[1].body, realtimeBody);
    assert.equal(observed[2].path, "/backend-api/codex/alpha/search");
    assert.deepEqual(observed[2].body, searchBody);

    const streamedBody = Buffer.from(
      '{"model":"gpt-streamed","input":"request is forwarded before upload completes"}'
    );
    const splitAt = 28;
    let streamedRequest;
    const streamedResponse = new Promise((resolveResponse, rejectResponse) => {
      streamedRequest = httpRequest(`${plan.local_base_url}/responses?stream_probe=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
          "content-type": "application/json"
        }
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolveResponse({
          status: incoming.statusCode,
          body: Buffer.concat(chunks)
        }));
        incoming.on("error", rejectResponse);
      });
      streamedRequest.on("error", rejectResponse);
    });
    streamedRequest.write(streamedBody.subarray(0, splitAt));
    await Promise.race([
      streamProbeSeen,
      new Promise((_, rejectWait) => setTimeout(
        () => rejectWait(new Error("passthrough request was buffered instead of streamed")),
        1000
      ))
    ]);
    const capacityRejected = await rawHttp(`${plan.local_base_url}/alpha/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
        "content-type": "application/json"
      },
      body: searchBody
    });
    assert.equal(capacityRejected.status, 503);
    assert.deepEqual(JSON.parse(capacityRejected.body), { error: "proxy_capacity_exceeded" });
    streamedRequest.end(streamedBody.subarray(splitAt));
    const streamed = await streamedResponse;
    assert.equal(streamed.status, 200);
    assert.deepEqual(streamed.body, compressedUpstreamResponse);
    assert.equal(observed.length, 4);
    assert.equal(
      observed[3].path,
      "/backend-api/codex/responses?stream_probe=1"
    );
    assert.deepEqual(observed[3].body, streamedBody);

    let stalledRequest;
    const stalledResponse = new Promise((resolveResponse, rejectResponse) => {
      stalledRequest = httpRequest(`${plan.local_base_url}/responses?body_timeout=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
          "content-type": "application/json"
        }
      }, (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => resolveResponse({
          status: incoming.statusCode,
          body: Buffer.concat(chunks)
        }));
        incoming.on("error", rejectResponse);
      });
      stalledRequest.on("error", rejectResponse);
    });
    stalledRequest.write('{"model":"never-finishes"');
    const bodyTimedOut = await stalledResponse;
    stalledRequest.destroy();
    assert.equal(bodyTimedOut.status, 408);
    assert.deepEqual(JSON.parse(bodyTimedOut.body), { error: "request_body_timeout" });

    const rejectedStatus = await rejectedWebSocketAndReset(
      `${plan.local_base_url}/responses?reject_reset=1`,
      { headers: { authorization: "Bearer OFFICIAL-CHATGPT-OAUTH" } }
    );
    assert.equal(rejectedStatus, 401);
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.doesNotThrow(() => process.kill(proxyPid, 0));

    const websocket = await rawWebSocketRoundTrip(
      `${plan.local_base_url}/responses?session=compressed-observation`,
      {
        headers: {
          authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
          "chatgpt-account-id": "official-account-id",
          "sec-websocket-extensions": "permessage-deflate; client_max_window_bits"
        },
        frame: websocketRequestFrame,
        responseBytes: websocketResponseFrame.length
      }
    );
    assert.equal(websocket.response.statusCode, 101);
    assert.equal(
      websocket.response.headers["sec-websocket-extensions"],
      "permessage-deflate; client_no_context_takeover; server_no_context_takeover"
    );
    assert.deepEqual(websocket.body, websocketResponseFrame);
    assert.equal(observedWebSockets.length, 1);
    assert.equal(
      observedWebSockets[0].path,
      "/backend-api/codex/responses?session=compressed-observation"
    );
    assert.equal(
      observedWebSockets[0].headers["sec-websocket-extensions"],
      "permessage-deflate; client_max_window_bits"
    );
    assert.equal(
      observedWebSockets[0].headers.authorization,
      "Bearer OFFICIAL-CHATGPT-OAUTH"
    );
    assert.deepEqual(observedWebSockets[0].body, websocketRequestFrame);
    await waitFor(async () => {
      try {
        return (await readFile(join(root, "proxy", "usage.jsonl"), "utf8"))
          .includes('"requested_model":"gpt-ws-compressed"');
      } catch {
        return false;
      }
    });

    const attachPreview = JSON.parse(run(PROXY_CLIENT, [
      "attach", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(attachPreview.preview, true);
    assert.deepEqual(await readFile(codexConfig), original);

    const attached = JSON.parse(run(PROXY_CLIENT, [
      "attach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(attached.status, "attached");
    const attachedText = await readFile(codexConfig, "utf8");
    assert.match(attachedText, /# >>> agentctl proxy attach >>>/);
    assert.match(attachedText, /model_provider = "openai"/);
    assert.match(attachedText, new RegExp(
      `openai_base_url = "http:\\/\\/127\\.0\\.0\\.1:${proxyPort}` +
      `\\/backend-api\\/codex\\/realtime"`
    ));
    assert.equal(attachedText.includes('model_provider = "previous-provider"'), false);
    assert.equal(attachedText.includes('openai_base_url = "https://previous.invalid"'), false);
    assert.equal(attachedText.includes('[model_providers.previous-provider]'), true);
    assert.deepEqual(
      await readFile(join(root, "proxy", "codex-config.backup.toml")),
      original
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(root, "proxy", "codex-config.backup.toml"))).mode & 0o077, 0);
    }
    const status = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(status.attachment.status, "attached");
    assert.equal(status.attachment.config_modified, false);
    assert.equal(status.attachment.managed_fields_intact, true);

    const appTrustEdit = [
      '',
      '[projects."/tmp/codex-app-opened-project"]',
      'trust_level = "trusted"',
      ''
    ].join("\n");
    await writeFile(codexConfig, `${attachedText}${appTrustEdit}`);
    const statusAfterAppEdit = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(statusAfterAppEdit.attachment.status, "attached");
    assert.equal(statusAfterAppEdit.attachment.config_modified, true);
    assert.equal(statusAfterAppEdit.attachment.managed_fields_intact, true);

    const idempotentAttach = JSON.parse(run(PROXY_CLIENT, [
      "attach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(idempotentAttach.changed, false);
    assert.equal(idempotentAttach.status, "attached");

    const refusedStop = run(PROXY_CLIENT, [
      "stop", ...commonProxy, "--yes", "--json"
    ], { status: 1 });
    assert.match(refusedStop.stderr, /detach Codex before stopping/);

    const detachPreview = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(detachPreview.preview, true);
    assert.equal(detachPreview.exact_restore, false);
    assert.equal(detachPreview.preserved_external_changes, true);
    assert.notDeepEqual(await readFile(codexConfig), original);
    const detached = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(detached.status, "detached");
    assert.equal(detached.exact_restore, false);
    assert.equal(detached.preserved_external_changes, true);
    const originalWithAppEdit = Buffer.from(`${original.toString("utf8")}${appTrustEdit}`);
    assert.deepEqual(await readFile(codexConfig), originalWithAppEdit);
    if (process.platform !== "win32") {
      assert.equal((await lstat(codexConfig)).mode & 0o777, 0o640);
    }
    await assert.rejects(
      () => lstat(join(root, "proxy", "attachment.json")),
      { code: "ENOENT" }
    );
    await assert.rejects(
      () => lstat(join(root, "proxy", "codex-config.backup.toml")),
      { code: "ENOENT" }
    );

    run(PROXY_CLIENT, ["attach", ...commonProxy, "--yes", "--json"]);
    let reattachedText = await readFile(codexConfig, "utf8");
    await writeFile(
      codexConfig,
      reattachedText.replace(
        `openai_base_url = "http://127.0.0.1:${proxyPort}/backend-api/codex/realtime"`,
        `#openai_base_url = "http://127.0.0.1:${proxyPort}/backend-api/codex/realtime"`
      )
    );
    const statusAfterEmergencyDisable = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(statusAfterEmergencyDisable.attachment.status, "disabled");
    assert.equal(statusAfterEmergencyDisable.attachment.managed_fields_intact, false);
    assert.equal(statusAfterEmergencyDisable.attachment.managed_fields_recoverable, true);
    const recoveredDetach = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(recoveredDetach.exact_restore, false);
    assert.equal(recoveredDetach.preserved_external_changes, true);
    assert.deepEqual(await readFile(codexConfig), originalWithAppEdit);

    run(PROXY_CLIENT, ["attach", ...commonProxy, "--yes", "--json"]);
    reattachedText = await readFile(codexConfig, "utf8");
    await writeFile(
      codexConfig,
      reattachedText.replace('model_provider = "openai"', 'model_provider = "tampered"')
    );
    const statusAfterManagedEdit = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(statusAfterManagedEdit.attachment.status, "modified");
    assert.equal(statusAfterManagedEdit.attachment.config_modified, true);
    assert.equal(statusAfterManagedEdit.attachment.managed_fields_intact, false);
    const refusedDetach = run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ], { status: 1 });
    assert.match(refusedDetach.stderr, /proxy-managed settings changed/);
    await writeFile(codexConfig, reattachedText);
    const exactDetach = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(exactDetach.exact_restore, true);
    assert.equal(exactDetach.preserved_external_changes, false);
    assert.deepEqual(await readFile(codexConfig), originalWithAppEdit);

    run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"]);
    proxyPid = 0;
    const metadata = await readFile(join(root, "proxy", "requests.jsonl"), "utf8");
    const usage = await readFile(join(root, "proxy", "usage.jsonl"), "utf8");
    for (const hidden of [
      "OFFICIAL-CHATGPT-OAUTH", "official-account-id", "PASSTHROUGH-BODY-MARKER",
      "PASSTHROUGH-WEBSOCKET-BODY-MARKER"
    ]) {
      assert.equal(metadata.includes(hidden), false);
      assert.equal(usage.includes(hidden), false);
    }
    assert.equal(usage.includes('"requested_model":"gpt-requested-exactly"'), true);
    assert.equal(usage.includes('"requested_service_tier":"fast"'), true);
    assert.equal(usage.includes('"response_service_tier":"default"'), true);
    assert.equal(usage.includes('"pricing_service_tier":"standard"'), true);
    assert.equal(usage.includes('"input_tokens":17'), true);
    assert.equal(usage.includes('"requested_model":"gpt-ws-compressed"'), true);
    assert.equal(usage.includes('"input_tokens":29'), true);
    const usageRows = usage.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const priced = usageRows.find((row) => row.requested_model === "gpt-requested-exactly");
    assert.equal(priced.pricing_service_tier_source, "response");
    assert.equal(priced.cost.rate_id, "openai-gpt-5-6-sol-standard-short");
    assert.equal(priced.cost.total, "0.000235");
    const websocketUsage = usageRows.find((row) => row.requested_model === "gpt-ws-compressed");
    assert.equal(websocketUsage.response_model, "gpt-5.6-sol");
    assert.equal(websocketUsage.usage.input_tokens, 29);
    assert.equal(websocketUsage.usage.output_tokens, 8);
    const metadataRows = metadata.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(metadataRows.some((row) =>
      row.event === "proxy_websocket_closed" &&
      row.websocket_compression === "permessage-deflate" &&
      row.websocket_observation === "complete" &&
      row.websocket_observation_issues.length === 0 &&
      row.incomplete_turns === 0 &&
      row.completed_turns === 1
    ), true);
  } finally {
    if (proxyPid) {
      try { process.kill(proxyPid, "SIGTERM"); } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    await closeServer(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("failover never replays by default, persists circuits, and replays only when explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-failover-"));
  const primaryBodies = [];
  const backupBodies = [];
  const primary = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      primaryBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"primary unavailable"}');
    });
  });
  const backup = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      backupBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"model":"backup-vendor"}');
    });
  });
  const primaryPort = await listen(primary);
  const backupPort = await listen(backup);
  const proxyPort = await freePort();
  const commonProxy = proxyArgs(root, proxyPort);
  const failoverPath = join(root, "config", "failover.json");
  const failoverArgs = [
    "--failover", failoverPath,
    "--store", join(root, "config", "providers.json")
  ];
  let proxyPid = 0;
  const post = async () => {
    const capability = JSON.parse(await readFile(
      join(root, "config", "proxy-capability.json"), "utf8"
    ));
    return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
      method: "POST",
      headers: {
        "x-agentctl-proxy-token": capability.token,
        "content-type": "application/json"
      },
      body: '{"model":"friendly","input":"FAILOVER-CONTENT-MARKER"}'
    });
  };
  try {
    run(PROVIDER_CLIENT, ["init", ...providerArgs(root), "--yes"]);
    for (const [name, port, outbound] of [
      ["primary", primaryPort, "primary-vendor"],
      ["backup", backupPort, "backup-vendor"]
    ]) {
      run(PROVIDER_CLIENT, [
        "create", name,
        "--protocol", "openai_responses",
        "--base-url", `http://127.0.0.1:${port}/v1`,
        "--model", "friendly",
        "--alias", `friendly=${outbound}`,
        "--auth-mode", "none",
        ...providerArgs(root), "--yes"
      ]);
    }
    run(FAILOVER_CLIENT, ["init", ...failoverArgs, "--yes", "--json"]);
    const createRoute = [
      "create", "resilient",
      "--profile", "primary",
      "--profile", "backup",
      "--failure-threshold", "1",
      "--recovery-timeout-ms", "3600000",
      ...failoverArgs,
      "--yes", "--json"
    ];
    const route = JSON.parse(run(FAILOVER_CLIENT, createRoute).stdout).route;
    assert.equal(route.retry.mode, "next_request");

    const started = JSON.parse(run(PROXY_CLIENT, [
      "start", "primary", "--target", "codex", "--route", "resilient",
      ...commonProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = started.pid;
    assert.deepEqual(started.backends, ["primary", "backup"]);

    const first = await post();
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: "primary unavailable" });
    assert.equal(primaryBodies.length, 1);
    assert.equal(backupBodies.length, 0, "default policy must not replay the current POST");
    const circuitPath = join(root, "proxy", "circuits.json");
    await waitFor(async () => {
      try {
        const state = JSON.parse(await readFile(circuitPath, "utf8"));
        return state.entries.find((entry) => entry.profile === "primary")?.state === "open";
      } catch {
        return false;
      }
    });

    const second = await post();
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, model: "backup-vendor" });
    assert.equal(primaryBodies.length, 1);
    assert.equal(backupBodies.length, 1);
    assert.equal(JSON.parse(backupBodies[0]).model, "backup-vendor");

    const running = JSON.parse(run(PROXY_CLIENT, [
      "status", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(running.route, "resilient");
    assert.deepEqual(running.backends, ["primary", "backup"]);
    assert.equal(running.circuits.find((entry) => entry.profile === "primary").state, "open");
    run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"]);
    proxyPid = 0;

    const restarted = JSON.parse(run(PROXY_CLIENT, [
      "start", "primary", "--target", "codex", "--route", "resilient",
      ...commonProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = restarted.pid;
    const afterRestart = await post();
    assert.equal(afterRestart.status, 200);
    await afterRestart.arrayBuffer();
    assert.equal(primaryBodies.length, 1, "persisted open circuit must survive restart");
    assert.equal(backupBodies.length, 2);
    run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"]);
    proxyPid = 0;

    run(FAILOVER_CLIENT, [
      ...createRoute,
      "--replace",
      "--same-request-retry"
    ]);
    const replayCircuit = join(root, "proxy", "replay-circuits.json");
    const replayProxy = [...commonProxy, "--circuit-state", replayCircuit];
    const replayed = JSON.parse(run(PROXY_CLIENT, [
      "start", "primary", "--target", "codex", "--route", "resilient",
      ...replayProxy, "--yes", "--json"
    ]).stdout);
    proxyPid = replayed.pid;
    const replayResponse = await post();
    assert.equal(replayResponse.status, 200);
    await replayResponse.arrayBuffer();
    assert.equal(primaryBodies.length, 2);
    assert.equal(backupBodies.length, 3);
    run(PROXY_CLIENT, ["stop", ...replayProxy, "--yes", "--json"]);
    proxyPid = 0;

    const metadata = (await readFile(join(root, "proxy", "requests.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const requests = metadata.filter((record) => record.request_id);
    assert.equal(requests.some((record) => record.attempts.length === 2 &&
      record.attempts[0].outcome === "retry_status"), true);
    assert.equal(requests.some((record) => record.attempts[0]?.outcome === "circuit_open"), true);
    const metadataText = JSON.stringify(metadata);
    assert.equal(metadataText.includes("FAILOVER-CONTENT-MARKER"), false);
    assert.equal(metadataText.includes(`127.0.0.1:${primaryPort}`), false);
    if (process.platform === "win32") {
      assert.equal((await lstat(circuitPath)).isFile(), true);
      assert.equal((await lstat(replayCircuit)).isFile(), true);
    } else {
      assert.equal((await lstat(circuitPath)).mode & 0o077, 0);
      assert.equal((await lstat(replayCircuit)).mode & 0o077, 0);
    }
  } finally {
    if (proxyPid) {
      try { process.kill(proxyPid, "SIGTERM"); } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    await closeServer(primary);
    await closeServer(backup);
    await rm(root, { recursive: true, force: true });
  }
});
