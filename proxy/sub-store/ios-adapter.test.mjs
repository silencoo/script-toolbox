import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./ios-adapter.js", import.meta.url), "utf8");
const certificate = "0123456789abcdef".repeat(4);
function load(args = {}) {
  const context = vm.createContext({ $arguments: args, $options: {} });
  vm.runInContext(source, context);
  return context.operator;
}
function node(overrides = {}) {
  return {
    name: "[Test] HK AnyTLS", type: "anytls", server: "entry.example.test",
    port: 443, password: "test-only-password", sni: "tls.example.test",
    fingerprint: certificate, alpn: ["h2", "http/1.1"], udp: true,
    "skip-cert-verify": false, "client-fingerprint": "chrome",
    "idle-session-check-interval": 30, "idle-session-timeout": 30,
    "min-idle-session": 0, ...overrides,
  };
}

test("QX AnyTLS prepares the reported TLS fields without mutating the source", () => {
  const input = node();
  const snapshot = structuredClone(input);
  Object.freeze(input.alpn);
  Object.freeze(input);
  for (const platform of ["QX", "qx", "QuantumultX"]) {
    const [result] = load()([input], platform);
    assert.equal(result["tls-alpn"], "02683208687474702f312e31");
    assert.equal(result["tls-fingerprint"], certificate);
    assert.equal(result.tls, true);
    for (const key of Object.keys(input)) assert.deepEqual(result[key], input[key]);
    assert.notEqual(result, input);
  }
  assert.deepEqual(input, snapshot);
});

test("ALPN accepts a comma-separated list and preserves protocol order", () => {
  const [result] = load()([node({ alpn: " http/1.1, h2, " })], "QX");
  assert.equal(result["tls-alpn"], "08687474702f312e31026832");
});

test("ALPN lengths count UTF-8 bytes and encode punctuation correctly", () => {
  const protocols = ["协议", "test/1%!~*'()"];
  const [result] = load()([node({ alpn: protocols })], "QX");
  const bytes = Buffer.from(result["tls-alpn"], "hex");
  const decoded = [];
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes[offset++];
    decoded.push(bytes.subarray(offset, offset + length).toString("utf8"));
    offset += length;
  }
  assert.equal(bytes[0], 6);
  assert.deepEqual(decoded, protocols);
});

test("explicit QX ALPN wins and absent ALPN gets no invented default", () => {
  const run = load();
  assert.equal(run([node({ "tls-alpn": "02:68:32", alpn: [123] })], "QX")[0]["tls-alpn"], "02:68:32");
  for (const alpn of [undefined, null, [], "", " , "]) {
    assert.equal(run([node({ alpn })], "QX")[0]["tls-alpn"], undefined);
  }
});

test("ALPN rejects invalid types and overlong protocols without logging credentials", () => {
  const run = load();
  for (const alpn of [true, {}, [null], [123], ["x".repeat(256)], ["界".repeat(86)]]) {
    assert.throws(() => run([node({ alpn })], "QX"), (error) => {
      assert.match(error.message, /ALPN/);
      assert.ok(!error.message.includes("test-only-password"));
      return true;
    });
  }
  assert.ok(run([node({ alpn: ["界".repeat(85)] })], "QX")[0]["tls-alpn"].startsWith("ff"));
  assert.throws(() => run([node({ alpn: Array(256).fill("x".repeat(255)) })], "QX"), /extension limit/);
});

test("SNI and certificate aliases fill missing canonical fields only", () => {
  const run = load();
  const [aliased] = run([node({
    sni: undefined, servername: "alias.example.test", "tls-host": "qx.example.test",
    fingerprint: certificate.toUpperCase().match(/../g).join(":"),
  })], "QX");
  assert.equal(aliased.sni, "alias.example.test");
  assert.equal(aliased["tls-fingerprint"], certificate);
  const [qxAlias] = run([node({
    sni: undefined, "tls-host": "qx.example.test", "tls-cert-sha256": "a".repeat(64),
  })], "QX");
  assert.equal(qxAlias.sni, "qx.example.test");
  assert.equal(qxAlias["tls-fingerprint"], "a".repeat(64));
  const [canonical] = run([node({
    servername: "alias.example.test", "tls-fingerprint": "b".repeat(64),
    "tls-cert-sha256": "a".repeat(64), "tls-pubkey-sha256": "c".repeat(64),
  })], "QX");
  assert.equal(canonical.sni, "tls.example.test");
  assert.equal(canonical["tls-fingerprint"], "b".repeat(64));
  assert.equal(canonical["tls-pubkey-sha256"], "c".repeat(64));
});

test("browser fingerprints are not certificate pins; verification choices survive", () => {
  for (const verify of [undefined, false, true]) {
    const [result] = load()([node({ fingerprint: "chrome", "skip-cert-verify": verify })], "QX");
    assert.equal(result["tls-fingerprint"], undefined);
    assert.equal(result["client-fingerprint"], "chrome");
    assert.equal(result["skip-cert-verify"], verify);
    assert.equal(result["name-cert-verify"], undefined);
  }
});

test("other targets and protocols retain their node objects", () => {
  const input = node();
  for (const platform of [undefined, "JSON", "Mihomo", "Surge", "Loon", "Shadowrocket"]) {
    assert.equal(load()([input], platform)[0], input);
  }
  const trojan = node({ type: "trojan" });
  assert.equal(load()([trojan], "QX")[0], trojan);
});

test("repeated adaptation is stable and country ordering keeps account nodes last", () => {
  const run = load({ countryorder: "jp,hk" });
  const input = [node(), node({ name: "JP 01" }), node({ name: "剩余流量：1 GB" })];
  const output = run(input, "QX");
  assert.deepEqual(Array.from(output, (proxy) => proxy.name),
    ["JP 01", "[Test] HK AnyTLS", "剩余流量：10 MB", "到期时间：1999-01-01"]);
  assert.deepEqual(run(output, "QX"), output);
});
