const test = require("node:test");
const assert = require("node:assert/strict");

const {
  modelLabelMatches,
  modeLabelHasExtended,
  normalizeModeLabel,
} = require("../gemini-session-batch-delete.user.js");

test("normalizes Gemini mode labels", () => {
  assert.equal(normalizeModeLabel("  3.1   Pro\nExtended  "), "3.1 Pro Extended");
});

test("matches model families without pinning a version", () => {
  assert.equal(modelLabelMatches("3.1 Pro Extended", "pro"), true);
  assert.equal(modelLabelMatches("4.0 Pro", "pro"), true);
  assert.equal(modelLabelMatches("3.6 Flash", "flash"), true);
  assert.equal(modelLabelMatches("3.5 Flash-Lite", "flash-lite"), true);
});

test("does not confuse Flash with Flash-Lite", () => {
  assert.equal(modelLabelMatches("3.5 Flash-Lite", "flash"), false);
  assert.equal(modelLabelMatches("3.6 Flash", "flash-lite"), false);
});

test("detects Extended thinking from the mode button label", () => {
  assert.equal(modeLabelHasExtended("Pro Extended"), true);
  assert.equal(modeLabelHasExtended("3.1 Pro"), false);
});
