import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(process.env.PARSER_FILE || new URL('../resource-parser.js', import.meta.url), 'utf8');
const uuid = '11111111-2222-4333-8444-555555555555';
const base = `vless=example.com:443, method=none, password=${uuid}, obfs=over-tls`;

function parse(content) {
  const results = [], notifications = [];
  const context = vm.createContext({
    $resource: { link:'https://example.invalid/sub', content, type:'server', tag:'test' },
    $environment: { version:'Quantumult X 1.6.0 build921' },
    $done: result => results.push(result),
    $notify: (...args) => notifications.push(args),
    console: { log() {} },
  });
  vm.runInContext(source, context, { timeout:5000 });
  assert.equal(context.PFailedNodeCount, 0);
  assert.equal(context.PNS, 0);
  assert.ok(results.length);
  assert.ok(!notifications.some(n => /错误|失败/.test(n[0])));
  return Buffer.from(results.at(-1).content, 'base64').toString('utf8');
}

test('empty certificate pin is omitted without overriding verification=false', () => {
  const output = parse(`${base}, tls-cert-sha256=, tls-verification=false, tag=empty-pin`);
  assert.doesNotMatch(output, /tls-cert-sha256/);
  assert.match(output, /tls-verification=false/);
});

test('both whitespace-only pin fields are omitted and verification=true survives', () => {
  const output = parse(`${base}, tls-cert-sha256=  , tls-pubkey-sha256=  , tls-verification=true, tag=empty-pins`);
  assert.doesNotMatch(output, /tls-(cert|pubkey)-sha256/);
  assert.match(output, /tls-verification=true/);
});

test('nonempty certificate and public-key pins remain and enable verification', () => {
  for (const key of ['tls-cert-sha256', 'tls-pubkey-sha256']) {
    const pin = 'ab'.repeat(32);
    const output = parse(`${base}, ${key}=${pin}, tls-verification=false, tag=pinned`);
    assert.ok(output.includes(`${key}=${pin}`));
    assert.match(output, /tls-verification=true/);
  }
});

test('malformed nonempty pins are preserved for rejection, never silently discarded', () => {
  const output = parse(`${base}, tls-cert-sha256=not-a-hash, tls-verification=false, tag=invalid-pin`);
  assert.match(output, /tls-cert-sha256=not-a-hash/);
  assert.match(output, /tls-verification=true/);
});

test('pin-like text in the node name does not enable certificate verification', () => {
  const output = parse(`${base}, tls-verification=false, tag=mentions tls-cert-sha256`);
  assert.match(output, /tls-verification=false/);
  assert.match(output, /tag=mentions tls-cert-sha256$/);
});

test('Reality fields after tag survive empty-pin cleanup and tag normalization', () => {
  const key = 'A'.repeat(43);
  const output = parse(`${base}, tls-cert-sha256=, tls-verification=true, tag=reality, reality-base64-pubkey=${key}, reality-hex-shortid=0123456789abcdef`);
  assert.doesNotMatch(output, /tls-cert-sha256/);
  assert.ok(output.includes(`reality-base64-pubkey=${key}`));
  assert.match(output, /reality-hex-shortid=0123456789abcdef/);
  assert.match(output, /tag=reality$/);
});

test('VMess chacha20-poly1305 is preserved', () => {
  const output = parse(`vmess=example.com:443, method=chacha20-poly1305, password=${uuid}, obfs=over-tls, tag=vmess-test`);
  assert.match(output, /method=chacha20-poly1305,/);
  assert.doesNotMatch(output, /chacha20-ietf-poly1305/);
});

test('Shadowsocks alias normalization only changes the method field', () => {
  const output = parse('shadowsocks=example.com:443, password=chacha20-poly1305, method=chacha20-poly1305, tag=chacha20-poly1305');
  assert.match(output, /method=chacha20-ietf-poly1305,/);
  assert.match(output, /password=chacha20-poly1305,/);
  assert.match(output, /tag=chacha20-poly1305$/);
});

test('existing Shadowsocks IETF spelling remains unchanged', () => {
  const output = parse('shadowsocks=example.com:443, method=chacha20-ietf-poly1305, password=test, tag=ss-test');
  assert.match(output, /method=chacha20-ietf-poly1305,/);
});
