import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeBlocks, assertReasonableChange, compactSuffixes, coveredBy, assertRoutingOrder } from "./ads-safety.mjs";

test("suffix compaction preserves hostname coverage and label boundaries", () => {
  const before = new Set(["ads.example.com", "nested.ads.example.com", "notads.example.com"]);
  const after = compactSuffixes(before);
  assert.deepEqual([...after], ["ads.example.com", "notads.example.com"]);
  for (const host of ["ads.example.com", "a.nested.ads.example.com", "notads.example.com", "example.com", "badads.example.com"]) {
    assert.equal(coveredBy(host, before), coveredBy(host, after));
  }
});

test("ICANN/private suffixes and subscription infrastructure fail closed", () => {
  for (const domain of ["co.uk", "github.io", "cloudfront.net", "raw.githubusercontent.com", "githubusercontent.com"]) {
    assert.throws(() => assertSafeBlocks([domain]), /Refusing/);
  }
  assert.doesNotThrow(() => assertSafeBlocks(["ads.example.co.uk", "tracker.github.io", "ad.example.com"]));
});

test("guard catches equal-size replacements, including allowlist changes", () => {
  const blocks = new Set(Array.from({length: 100}, (_, i) => `ads${i}.example.com`));
  const allows = new Set();
  assert.doesNotThrow(() => assertReasonableChange({ blocks, allows }, { blocks: new Set([...blocks, "child.ads1.example.com"]), allows }));
  const replaced = new Set(Array.from({length: 100}, (_, i) => `new${i}.example.com`));
  assert.throws(() => assertReasonableChange({blocks, allows}, {blocks: replaced, allows}), /Unusually large blocks/);
  assert.throws(() => assertReasonableChange({blocks, allows}, {blocks, allows: replaced}), /Unusually large allows/);
  assert.throws(() => assertReasonableChange({blocks, allows}, {blocks: new Set(["example.com"]), allows}), /Unusually large blocks/);
});

test("curated routes must precede conflicting blocks", () => {
  const blocks = new Set(["cloudfront.example.com"]);
  const ads = { name: "Ads.list", text: "" };
  const docker = { name: "Docker.list", text: "HOST,docker.cloudfront.example.com,Docker" };
  assert.throws(() => assertRoutingOrder(blocks, [ads, docker]), /shadowed/);
  assert.doesNotThrow(() => assertRoutingOrder(blocks, [docker, ads]));
});
