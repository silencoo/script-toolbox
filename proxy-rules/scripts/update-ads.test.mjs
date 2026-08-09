import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDomain } from "./update-ads.mjs";

test("normalizes plain domains without widening their scope", () => {
  assert.equal(normalizeDomain("Example.COM."), "example.com");
  assert.equal(normalizeDomain("*.Example.COM"), "example.com");
  assert.equal(normalizeDomain("例子.测试"), "xn--fsqu00a.xn--0zwm56d");
});

test("rejects path-scoped GOODBYEADS rules before URL host parsing", () => {
  assert.equal(normalizeDomain("amazon.com/1/aiv-web-player/1/OE"), null);
  assert.equal(normalizeDomain("amazonaws.com/beacon"), null);
});

test("rejects URL and ad-filter syntax instead of extracting its host", () => {
  for (const input of [
    "https://example.com",
    "example.com/path",
    "example.com?campaign=1",
    "example.com#advertising",
    "user@example.com",
    "example.com$script",
    "||example.com^",
  ]) {
    assert.equal(normalizeDomain(input), null, input);
  }
});

test("rejects values that are not suffix domains", () => {
  assert.equal(normalizeDomain("localhost"), null);
  assert.equal(normalizeDomain("127.0.0.1"), null);
  assert.equal(normalizeDomain("2001:db8::1"), null);
});
