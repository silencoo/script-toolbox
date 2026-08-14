import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
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
  allowedRoute,
  circuitPersister,
  jsonlLogger,
  joinUpstream,
  pruneLogs,
  rotateLog,
  upstreamHeaders,
  validateConfig,
  websocketObserver
} from "../proxy/agentproxyd.mjs";

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
    "--codex-config", join(root, "codex", "config.toml"),
    "--failover-store", join(root, "config", "failover.json"),
    "--pricing", join(root, "config", "pricing.json"),
    "--port", String(port)
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

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  throw new Error("condition did not become true");
}

function websocketFrame(value, { masked = false } = {}) {
  const payload = Buffer.from(JSON.stringify(value));
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const frame = Buffer.alloc(2 + (masked ? 4 : 0) + payload.length);
  frame[0] = 0x81;
  frame[1] = payload.length | (masked ? 0x80 : 0);
  let offset = 2;
  if (masked) {
    mask.copy(frame, offset);
    offset += 4;
  }
  for (let index = 0; index < payload.length; index += 1) {
    frame[offset + index] = masked ? payload[index] ^ mask[index % 4] : payload[index];
  }
  return frame;
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
      connection: "keep-alive"
    }
  }, "openai_responses", {
    auth: { mode: "bearer" }
  }, "REAL-UPSTREAM-SECRET", 17);
  assert.equal(headers.authorization, "Bearer REAL-UPSTREAM-SECRET");
  assert.equal(headers["x-agentctl-proxy-token"], undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers.digest, undefined);
  assert.equal(headers["content-length"], "17");
  assert.equal(headers["accept-encoding"], "identity");

  const passthrough = upstreamHeaders({
    headers: {
      authorization: "Bearer OFFICIAL-OPENAI-OAUTH",
      "chatgpt-account-id": "account-123",
      "x-agentctl-proxy-token": "must-not-leak",
      "user-agent": "codex-cli/test",
      "content-type": "application/json"
    }
  }, "openai_responses", {
    auth: { mode: "openai_passthrough" }
  }, "", 11, { mode: "openai_subscription_passthrough" });
  assert.equal(passthrough.authorization, "Bearer OFFICIAL-OPENAI-OAUTH");
  assert.equal(passthrough["chatgpt-account-id"], "account-123");
  assert.equal(passthrough["user-agent"], "codex-cli/test");
  assert.equal(passthrough["x-agentctl-proxy-token"], undefined);
});

test("daemon config rejects a non-loopback listener", () => {
  const root = "/tmp/agentctl-proxy-test";
  const config = {
    schema: 5,
    kind: "agentctl-proxy-config",
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
    timeouts: { first_byte_ms: 1000, stream_idle_ms: 1000, request_ms: 1000 },
    limits: {
      request_bytes: 1024,
      log_bytes: 65536,
      usage_log_bytes: 65536,
      usage_capture_bytes: 1024
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
      }))
    ].join("\n") + "\n", { mode: 0o600 });

    const listed = run(PROXY_CLIENT, [
      "usage", "--last", "2", ...common, "--json"
    ]);
    assert.equal(listed.stdout.includes("MUST-NOT-BE-EMITTED"), false);
    const listValue = JSON.parse(listed.stdout);
    assert.equal(listValue.total_records, 3);
    assert.equal(listValue.returned_records, 2);
    assert.deepEqual(
      listValue.records.map((item) => item.request_id),
      ["request-2", "request-3"]
    );
    assert.equal(listValue.records[0].pricing_service_tier, "fast");
    assert.equal(listValue.records[1].pricing_unavailable, "rate_not_found");

    const summary = JSON.parse(run(PROXY_CLIENT, [
      "usage", "--summary", ...common, "--json"
    ]).stdout);
    assert.equal(summary.requests, 3);
    assert.equal(summary.priced_requests, 2);
    assert.equal(summary.unpriced_requests, 1);
    assert.deepEqual(summary.tokens, {
      input: 35,
      output: 3,
      cache_read: 5,
      cache_write: 0
    });
    assert.deepEqual(summary.costs, { USD: "0.3" });
    assert.equal(summary.by_service_tier.standard.requests, 2);
    assert.equal(summary.by_service_tier.fast.requests, 1);
    assert.deepEqual(summary.service_tiers, {
      fast_requested: 2,
      fast_effective: 1,
      fast_downgraded: 1,
      transitions: {
        "fast->fast": 1,
        "fast->standard": 1,
        "unspecified->standard": 1
      }
    });
    assert.equal(summary.by_model["gpt-5.6-sol"].requests, 2);
    assert.equal(summary.by_model["gpt-5.6-luna"].requests, 1);

    const textSummary = run(PROXY_CLIENT, [
      "usage", "--summary", "--last", "2", ...common
    ]).stdout;
    assert.match(textSummary, /2 request\(s\) · 1 priced · 1 unpriced/);
    assert.match(textSummary, /0\.2 USD/);
    assert.match(textSummary, /2 requested · 1 effective · 1 downgraded/);

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
    assert.equal(Object.hasOwn(running, "token"), false);

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

test("OpenAI subscription passthrough is byte-preserving and attach/detach restores Codex exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-proxy-passthrough-"));
  const observed = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      observed.push({
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks)
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_passthrough",
        model: "gpt-5.6-sol",
        service_tier: "default",
        usage: { input_tokens: 17, output_tokens: 5 }
      }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const commonProxy = [
    ...proxyArgs(root, proxyPort),
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
    assert.equal(plan.local_base_url, `http://127.0.0.1:${proxyPort}`);
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
      '{"model":"gpt-requested-exactly","service_tier":"fast","input":"PASSTHROUGH-BODY-MARKER","stream":false}'
    );
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer OFFICIAL-CHATGPT-OAUTH",
        "chatgpt-account-id": "official-account-id",
        "user-agent": "codex-cli/integration-test",
        "content-type": "application/json"
      },
      body: requestBody
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(observed.length, 1);
    assert.equal(observed[0].path, "/backend-api/codex/responses");
    assert.equal(observed[0].headers.authorization, "Bearer OFFICIAL-CHATGPT-OAUTH");
    assert.equal(observed[0].headers["chatgpt-account-id"], "official-account-id");
    assert.equal(observed[0].headers["user-agent"], "codex-cli/integration-test");
    assert.equal(observed[0].headers["x-agentctl-proxy-token"], undefined);
    assert.equal(observed[0].headers["accept-encoding"], "identity");
    assert.deepEqual(observed[0].body, requestBody);

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
      `openai_base_url = "http:\\/\\/127\\.0\\.0\\.1:${proxyPort}"`
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

    const refusedStop = run(PROXY_CLIENT, [
      "stop", ...commonProxy, "--yes", "--json"
    ], { status: 1 });
    assert.match(refusedStop.stderr, /detach Codex before stopping/);

    await writeFile(codexConfig, `${attachedText}# concurrent user edit\n`);
    const refusedDetach = run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ], { status: 1 });
    assert.match(refusedDetach.stderr, /refusing to discard user edits/);
    assert.equal((await readFile(codexConfig, "utf8")).includes("concurrent user edit"), true);
    await writeFile(codexConfig, attachedText);

    const detachPreview = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--json"
    ]).stdout);
    assert.equal(detachPreview.preview, true);
    assert.notDeepEqual(await readFile(codexConfig), original);
    const detached = JSON.parse(run(PROXY_CLIENT, [
      "detach", ...commonProxy, "--yes", "--json"
    ]).stdout);
    assert.equal(detached.status, "detached");
    assert.deepEqual(await readFile(codexConfig), original);
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

    run(PROXY_CLIENT, ["stop", ...commonProxy, "--yes", "--json"]);
    proxyPid = 0;
    const metadata = await readFile(join(root, "proxy", "requests.jsonl"), "utf8");
    const usage = await readFile(join(root, "proxy", "usage.jsonl"), "utf8");
    for (const hidden of [
      "OFFICIAL-CHATGPT-OAUTH", "official-account-id", "PASSTHROUGH-BODY-MARKER"
    ]) {
      assert.equal(metadata.includes(hidden), false);
      assert.equal(usage.includes(hidden), false);
    }
    assert.equal(usage.includes('"requested_model":"gpt-requested-exactly"'), true);
    assert.equal(usage.includes('"requested_service_tier":"fast"'), true);
    assert.equal(usage.includes('"response_service_tier":"default"'), true);
    assert.equal(usage.includes('"pricing_service_tier":"standard"'), true);
    assert.equal(usage.includes('"input_tokens":17'), true);
    const priced = usage.split("\n").filter(Boolean).map((line) => JSON.parse(line))[0];
    assert.equal(priced.pricing_service_tier_source, "response");
    assert.equal(priced.cost.rate_id, "openai-gpt-5-6-sol-standard-short");
    assert.equal(priced.cost.total, "0.000235");
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
