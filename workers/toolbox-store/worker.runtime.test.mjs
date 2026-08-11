import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const TOKEN = "R".repeat(43);
const CREATE_TOKEN = "runtime-create-token".padEnd(48, "C");
const STORE_ID = "89abcdef0123456789abcdef01234567";
const SNAPSHOT_TYPE = "application/vnd.mcpctl.snapshot+json";

const harness = createTestHarness({
  root: TEST_ROOT,
  workers: [
    {
      configPath: "./wrangler.jsonc",
      secrets: {
        CREATE_TOKEN
      }
    }
  ]
});

let runtimeWorker;

before(async () => {
  await harness.listen();
  runtimeWorker = harness.getWorker();
}, { timeout: 15_000 });

after(async () => {
  await harness.close();
}, { timeout: 15_000 });

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...extra
  };
}

test("production runtime creates, authenticates, conditionally updates, and reads R2", async () => {
  const created = await runtimeWorker.fetch(`/v1/stores/${STORE_ID}`, {
    method: "PUT",
    headers: headers({
      "X-Toolbox-Store-Create-Token": CREATE_TOKEN
    })
  });
  assert.equal(created.status, 201);

  const wrongAuth = await runtimeWorker.fetch(`/v1/stores/${STORE_ID}`, {
    headers: {
      Authorization: `Bearer ${"W".repeat(43)}`
    }
  });
  assert.equal(wrongAuth.status, 401);

  const encryptedEnvelope = JSON.stringify({
    schema: 1,
    kind: "mcpctl-snapshot",
    ciphertext: createHash("sha256").update("opaque-runtime-test").digest("hex")
  });
  const uploaded = await runtimeWorker.fetch(
    `/v1/stores/${STORE_ID}/versions`,
    {
      method: "PUT",
      headers: headers({
        "Content-Type": SNAPSHOT_TYPE,
        "X-Toolbox-Base-Version": "none"
      }),
      body: encryptedEnvelope
    }
  );
  assert.equal(uploaded.status, 201);
  const metadata = await uploaded.json();

  const stale = await runtimeWorker.fetch(
    `/v1/stores/${STORE_ID}/versions`,
    {
      method: "PUT",
      headers: headers({
        "Content-Type": SNAPSHOT_TYPE,
        "X-Toolbox-Base-Version": "none"
      }),
      body: encryptedEnvelope
    }
  );
  assert.equal(stale.status, 409);

  const latest = await runtimeWorker.fetch(`/v1/stores/${STORE_ID}/latest`, {
    headers: headers()
  });
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("X-Toolbox-Store-Version"), metadata.version);
  assert.equal(await latest.text(), encryptedEnvelope);
});
