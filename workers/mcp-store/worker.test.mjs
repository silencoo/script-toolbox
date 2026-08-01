import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker from "./worker.js";
import { MemoryR2Bucket } from "./test-memory-r2.mjs";

const STORE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "A".repeat(43);
const CREATE_TOKEN = "create-token-".padEnd(48, "C");
const SNAPSHOT_TYPE = "application/vnd.mcpctl.snapshot+json";
const SKILLS_SNAPSHOT_TYPE = "application/vnd.skillsctl.snapshot+json";
const PROMPT_SNAPSHOT_TYPE = "application/vnd.promptctl.snapshot+json";
const WORKSPACE_SNAPSHOT_TYPE = "application/vnd.agentctl.workspace+json";

function environment(overrides = {}) {
  return {
    MCP_STORE: new MemoryR2Bucket(),
    MAX_BLOB_BYTES: "5242880",
    CREATE_TOKEN,
    ...overrides
  };
}

function request(path, options = {}) {
  return new Request(`https://store.example${path}`, options);
}

function authenticatedHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...extra
  };
}

async function createStore(env) {
  return worker.fetch(request(`/v1/stores/${STORE_ID}`, {
    method: "PUT",
    headers: authenticatedHeaders({
      "X-MCP-Store-Create-Token": CREATE_TOKEN
    })
  }), env);
}

async function backup(env, body, baseVersion = "none") {
  return worker.fetch(request(`/v1/stores/${STORE_ID}/versions`, {
    method: "PUT",
    headers: authenticatedHeaders({
      "Content-Type": SNAPSHOT_TYPE,
      "X-MCPCTL-Base-Version": baseVersion
    }),
    body
  }), env);
}

test("health check is public and security headers are attached", async () => {
  const response = await worker.fetch(request("/health"), environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("x-request-id"));
  assert.deepEqual(await response.json(), {
    schema: 1,
    service: "toolbox-store",
    compatibility: [
      "mcp-store-v1",
      "skills-store-v1",
      "prompt-store-v1",
      "toolbox-workspace-v1"
    ],
    status: "ok"
  });
});

test("non-API routes are delegated to the same-origin asset binding", async () => {
  const env = environment({
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          headers: { "Content-Type": "text/plain" }
        });
      }
    }
  });
  const response = await worker.fetch(request("/"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset:/index.html");
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /style-src-elem 'self' 'unsafe-inline'/);
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
});

test("accepts every Toolbox snapshot type with product-neutral headers", async () => {
  for (const [contentType, kind] of [
    [SKILLS_SNAPSHOT_TYPE, "skillsctl-snapshot"],
    [PROMPT_SNAPSHOT_TYPE, "promptctl-snapshot"],
    [WORKSPACE_SNAPSHOT_TYPE, "agentctl-workspace-snapshot"]
  ]) {
    const env = environment();
    const created = await worker.fetch(request(`/v1/stores/${STORE_ID}`, {
      method: "PUT",
      headers: authenticatedHeaders({
        "X-Toolbox-Store-Create-Token": CREATE_TOKEN
      })
    }), env);
    assert.equal(created.status, 201);

    const body = JSON.stringify({ schema: 1, kind, ciphertext: `opaque-${kind}` });
    const uploaded = await worker.fetch(request(`/v1/stores/${STORE_ID}/versions`, {
      method: "PUT",
      headers: authenticatedHeaders({
        "Content-Type": contentType,
        "X-Toolbox-Base-Version": "none"
      }),
      body
    }), env);
    assert.equal(uploaded.status, 201);
    const metadata = await uploaded.json();

    const latest = await worker.fetch(
      request(`/v1/stores/${STORE_ID}/latest`, {
        headers: authenticatedHeaders()
      }),
      env
    );
    assert.equal(latest.status, 200);
    assert.equal(latest.headers.get("content-type"), contentType);
    assert.equal(latest.headers.get("x-toolbox-store-version"), metadata.version);
    assert.equal(await latest.text(), body);
  }
});

test("Web UI access is disabled by default and controlled per authenticated store", async () => {
  const env = environment();
  await createStore(env);

  const cliStatus = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`, { headers: authenticatedHeaders() }),
    env
  );
  assert.equal(cliStatus.status, 200);
  assert.equal((await cliStatus.json()).web_ui_enabled, false);

  const blocked = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`, {
      headers: authenticatedHeaders({ "X-Toolbox-Client": "web" })
    }),
    env
  );
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, "web_ui_disabled");

  const enabled = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/settings/web-ui`, {
      method: "PUT",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: true })
    }),
    env
  );
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).web_ui_enabled, true);

  const allowed = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`, {
      headers: authenticatedHeaders({ "X-Toolbox-Client": "web" })
    }),
    env
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).web_ui_enabled, true);

  const disabled = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/settings/web-ui`, {
      method: "PUT",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: false })
    }),
    env
  );
  assert.equal(disabled.status, 200);

  const setting = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/settings/web-ui`, {
      headers: authenticatedHeaders()
    }),
    env
  );
  assert.equal(setting.status, 200);
  assert.equal((await setting.json()).web_ui_enabled, false);
});

test("Web UI setting rejects malformed updates", async () => {
  const env = environment();
  await createStore(env);
  const invalid = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/settings/web-ui`, {
      method: "PUT",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: "yes" })
    }),
    env
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_setting");
});

test("creates a store once and persists only the token digest", async () => {
  const env = environment();
  const created = await createStore(env);
  assert.equal(created.status, 201);

  const duplicate = await createStore(env);
  assert.equal(duplicate.status, 409);

  const metadataKey = `v1/stores/${STORE_ID}/meta.json`;
  const metadata = JSON.parse(await (await env.MCP_STORE.get(metadataKey)).text());
  assert.equal(metadata.auth.algorithm, "sha256");
  assert.equal(metadata.auth.digest, createHash("sha256").update(TOKEN).digest("hex"));
  assert.equal(JSON.stringify(metadata).includes(TOKEN), false);
});

test("store creation fails closed without the deployment bootstrap secret", async () => {
  const disabled = environment({ CREATE_TOKEN: undefined });
  const unavailable = await createStore(disabled);
  assert.equal(unavailable.status, 503);

  const env = environment();
  const unauthorized = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`, {
      method: "PUT",
      headers: authenticatedHeaders({
        "X-MCP-Store-Create-Token": "wrong-token-".padEnd(48, "W")
      })
    }),
    env
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(env.MCP_STORE.records.size, 0);
});

test("requires the correct capability for every private route", async () => {
  const env = environment();
  await createStore(env);

  const missing = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`),
    env
  );
  assert.equal(missing.status, 401);

  const wrong = await worker.fetch(
    request(`/v1/stores/${STORE_ID}`, {
      headers: { Authorization: `Bearer ${"B".repeat(43)}` }
    }),
    env
  );
  assert.equal(wrong.status, 401);
});

test("uploads immutable versions and returns the exact opaque bytes", async () => {
  const env = environment();
  await createStore(env);

  const firstBody = JSON.stringify({
    schema: 1,
    algorithm: "A256GCM",
    ciphertext: "opaque-one"
  });
  const first = await backup(env, firstBody);
  assert.equal(first.status, 201);
  const firstMetadata = await first.json();

  const secondBody = JSON.stringify({
    schema: 1,
    algorithm: "A256GCM",
    ciphertext: "opaque-two"
  });
  const second = await backup(env, secondBody, firstMetadata.version);
  assert.equal(second.status, 201);
  const secondMetadata = await second.json();

  const latest = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/latest`, {
      headers: authenticatedHeaders()
    }),
    env
  );
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("x-mcpctl-version"), secondMetadata.version);
  assert.equal(await latest.text(), secondBody);

  const oldVersion = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/versions/${firstMetadata.version}`, {
      headers: authenticatedHeaders()
    }),
    env
  );
  assert.equal(oldVersion.status, 200);
  assert.equal(await oldVersion.text(), firstBody);

  const versions = await worker.fetch(
    request(`/v1/stores/${STORE_ID}/versions`, {
      headers: authenticatedHeaders()
    }),
    env
  );
  const listing = await versions.json();
  assert.equal(listing.versions.length, 2);
  assert.equal(listing.versions[0].version, secondMetadata.version);
  assert.equal(listing.versions[1].version, firstMetadata.version);
});

test("rejects a stale base version without storing a new object", async () => {
  const env = environment();
  await createStore(env);
  const first = await backup(env, "first");
  assert.equal(first.status, 201);

  const before = [...env.MCP_STORE.records.keys()]
    .filter((key) => key.includes("/versions/")).length;
  const stale = await backup(
    env,
    "stale",
    "9999999999999-00000000-0000-4000-8000-000000000000"
  );
  const after = [...env.MCP_STORE.records.keys()]
    .filter((key) => key.includes("/versions/")).length;

  assert.equal(stale.status, 409);
  assert.equal(after, before);
});

test("cleans up an immutable object when the conditional head write loses", async () => {
  const env = environment();
  await createStore(env);
  env.MCP_STORE.rejectNextHeadPut = true;

  const response = await backup(env, "will-conflict");
  assert.equal(response.status, 409);
  const versions = [...env.MCP_STORE.records.keys()]
    .filter((key) => key.includes("/versions/"));
  assert.deepEqual(versions, []);
});

test("enforces the configured body limit while reading the stream", async () => {
  const env = environment({ MAX_BLOB_BYTES: "1024" });
  await createStore(env);

  const response = await backup(env, "x".repeat(1025));
  assert.equal(response.status, 413);
});
