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
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  allowedRoute,
  joinUpstream,
  upstreamHeaders,
  validateConfig
} from "../proxy/agentproxyd.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER_CLIENT = join(HERE, "provider-client.mjs");
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
    "--proxy-capability", join(root, "config", "proxy-capability.json"),
    "--proxy-log", join(root, "proxy", "requests.jsonl"),
    "--proxy-usage-log", join(root, "proxy", "usage.jsonl"),
    "--proxy-runtime-log", join(root, "proxy", "daemon.log"),
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

test("proxy route and URL projection is protocol-bounded", () => {
  assert.equal(allowedRoute("anthropic_messages", "POST", "/v1/messages"), true);
  assert.equal(allowedRoute("openai_responses", "POST", "/v1/responses"), true);
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
  }, {
    protocol: "openai_responses",
    auth: { mode: "bearer" }
  }, "REAL-UPSTREAM-SECRET", 17);
  assert.equal(headers.authorization, "Bearer REAL-UPSTREAM-SECRET");
  assert.equal(headers["x-agentctl-proxy-token"], undefined);
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers.digest, undefined);
  assert.equal(headers["content-length"], "17");
  assert.equal(headers["accept-encoding"], "identity");
});

test("daemon config rejects a non-loopback listener", () => {
  const root = "/tmp/agentctl-proxy-test";
  const config = {
    schema: 2,
    kind: "agentctl-proxy-config",
    instance_id: "11111111-1111-4111-8111-111111111111",
    created_at: new Date().toISOString(),
    profile: "test",
    target: "codex",
    platform: "linux",
    protocol: "openai_responses",
    endpoint: "https://api.example.com/v1",
    auth: { mode: "bearer", secret: "test_key" },
    models: { default: "test-model", aliases: {} },
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
      runtime_log: join(root, "runtime-log")
    }
  };
  assert.throws(() => validateConfig(config), /loopback/);
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
      observed = { path: request.url, headers: request.headers };
      request.resume();
      request.on("end", () => {
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
          "content-type": "application/json"
        },
        body: '{"model":"test-model"}'
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(observed.path, item.upstreamPath);
      const expected = item.upstreamHeader === "authorization"
        ? "Bearer UPSTREAM-NATIVE-KEY"
        : "UPSTREAM-NATIVE-KEY";
      assert.equal(observed.headers[item.upstreamHeader], expected);
      assert.equal(observed.headers["x-agentctl-proxy-token"], undefined);
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
    assert.equal(running.pricing_model_source, "response");
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

    const wrongRoute = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-agentctl-proxy-token": capability.token }
    });
    assert.equal(wrongRoute.status, 404);
    assert.equal(requests.length, 1);

    const tooLarge = await fetch(localUrl, {
      method: "POST",
      headers: { "x-agentctl-proxy-token": capability.token },
      body: "x".repeat(2048)
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(requests.length, 1);

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
      assert.equal((await lstat(path)).mode & 0o077, 0);
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
