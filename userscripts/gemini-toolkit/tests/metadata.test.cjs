const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const header = readFileSync(path.join(root, "gemini-toolkit.user.js"), "utf8")
  .split("// ==/UserScript==")[0];

test("pins the vendored watermark core to a commit and its SHA-256", () => {
  const requires = [...header.matchAll(/^\/\/ @require\s+(\S+)$/gmu)].map((match) => match[1]);
  assert.equal(requires.length, 1);
  const match = /^https:\/\/raw\.githubusercontent\.com\/silencoo\/script-toolbox\/([0-9a-f]{40})\/(userscripts\/gemini-toolkit\/vendor\/gargantua-core\.js)#sha256=([0-9a-f]{64})$/u.exec(
    requires[0],
  );
  assert.ok(match, `unpinned @require: ${requires[0]}`);

  // A changed vendor file needs a new commit pin and digest in the header.
  const vendored = readFileSync(path.join(root, "vendor", "gargantua-core.js"));
  assert.equal(createHash("sha256").update(vendored).digest("hex"), match[3]);
});
