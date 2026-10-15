import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../rar-attachment-extractor.user.js", import.meta.url),
  "utf8",
);

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

function loadIntegrity(globals = {}) {
  const context = vm.createContext({ TextEncoder, console, ...globals });
  vm.runInContext(
    section("/** ================= 完整性校验", "/** ================= libunrar 加载"),
    context,
  );
  return context;
}

const nodeSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("fallback SHA-256 matches node:crypto across padding boundaries", () => {
  const { sha256HexFallback } = loadIntegrity();
  for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const bytes = new Uint8Array(randomBytes(size));
    assert.equal(sha256HexFallback(bytes), nodeSha256(bytes), `size ${size}`);
  }
  const large = new Uint8Array(randomBytes(300_000));
  assert.equal(sha256HexFallback(large), nodeSha256(large));
});

test("uses the fallback when crypto.subtle is unavailable on HTTP pages", async () => {
  const { sha256Hex } = loadIntegrity();
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("uses crypto.subtle when available", async () => {
  const { sha256Hex } = loadIntegrity({ crypto: globalThis.crypto });
  const bytes = new Uint8Array(randomBytes(4096));
  assert.equal(await sha256Hex(bytes.buffer), nodeSha256(bytes));
});

test("refuses content whose digest does not match", async () => {
  const { assertSha256 } = loadIntegrity({ console: { error() {} } });
  await assert.rejects(
    assertSha256("tampered", "0".repeat(64), "libunrar.js"),
    /完整性校验失败/u,
  );
  await assertSha256(
    "abc",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "libunrar.js",
  );
});

test("pins libunrar to an exact commit with SHA-256 digests", () => {
  const sources = vm.runInNewContext(
    `${section("const LIB_SOURCES", "];")}]; LIB_SOURCES`,
  );
  assert.equal(sources.length, 1);
  for (const [url, digest] of [
    [sources[0].js, sources[0].jsSha256],
    [sources[0].mem, sources[0].memSha256],
  ]) {
    assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//u);
    assert.match(digest, /^[0-9a-f]{64}$/u);
  }
});
