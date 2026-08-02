import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForKey,
  actionNeedsConfirmation,
  clampSelection,
  componentSummary,
  moveSection,
  normalizeSection,
  otherTarget,
  workspacePresentation
} from "../src/model.mjs";

test("section navigation wraps and invalid sections fall back", () => {
  assert.equal(normalizeSection("mcp"), "mcp");
  assert.equal(normalizeSection("unknown"), "overview");
  assert.equal(moveSection("overview", -1), "cloud");
  assert.equal(moveSection("cloud", 1), "overview");
});

test("target and preset selection are deterministic", () => {
  assert.equal(otherTarget("codex"), "claude");
  assert.equal(otherTarget("claude"), "codex");
  assert.equal(clampSelection(4, 2), 1);
  assert.equal(clampSelection(-1, 2), 0);
  assert.equal(clampSelection(3, 0), 0);
});

test("actions are scoped and writes require confirmation", () => {
  assert.equal(actionForKey("presets", "p"), "plan");
  assert.equal(actionForKey("presets", "P"), null);
  assert.equal(actionForKey("mcp", "p"), "mcp-plan");
  assert.equal(actionForKey("skills", "a"), "skills-apply");
  assert.equal(actionForKey("cloud", "P"), null);
  assert.equal(actionNeedsConfirmation("plan"), false);
  assert.equal(actionNeedsConfirmation("apply"), true);
  assert.equal(actionNeedsConfirmation("prompts-apply"), true);
});

test("component summaries preserve useful state without raw secrets", () => {
  assert.deepEqual(componentSummary("mcp", {
    ok: true,
    data: { healthy: true, selection_mode: "profile", profile: "work", servers: ["github"] }
  }), { label: "Healthy", kind: "good", detail: "work · 1 server(s)" });
  assert.equal(componentSummary("provider", {
    ok: true,
    data: { provider_status: "configured", provider: "openai", model: "gpt" }
  }).detail, "openai / gpt");
});

test("Workspace empty states distinguish setup, connectivity, and incompatible data", () => {
  const missing = workspacePresentation(null, "[error] remote configuration not found: /private/path");
  assert.equal(missing.state, "unconfigured");
  assert.equal(missing.status, "Local only");
  assert.equal(missing.diagnostic, "");

  const incompatible = workspacePresentation(
    null,
    "[error] remote snapshot is not a valid agentctl Workspace"
  );
  assert.equal(incompatible.state, "incompatible");
  assert.match(incompatible.description, /current unified Workspace format/);
  assert.equal(incompatible.diagnostic, "");

  const offline = workspacePresentation(null, "[error] remote request timed out");
  assert.equal(offline.state, "offline");
  assert.match(offline.safety, /Press r/);
});
