import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const template = await readFile(
  new URL("../templates/quantumult-x.conf", import.meta.url),
  "utf8",
);

test("scopes the provider DoH endpoint to its Quantumult X node domain", () => {
  assert.match(
    template,
    /^doh-server=\/\*\.placudoshai\.fun\/https:\/\/jeeyio\.com\/api\/dns-query$/m,
  );
  assert.doesNotMatch(
    template,
    /^doh-server=https:\/\/jeeyio\.com\/api\/dns-query$/m,
  );
});
