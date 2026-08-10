import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_TARGETS,
  actionForKey,
  actionNeedsConfirmation,
  clampSelection,
  componentSummary,
  componentTargetState,
  cycleTarget,
  mcpTargetComparison,
  moveSection,
  normalizeSection,
  otherTarget,
  promptTargetState,
  providerEntries,
  safePromptPreviewText,
  selectionDelta,
  selectionWindow,
  snippetEntries,
  targetLabel,
  workspacePresentation
} from "../src/model.mjs";

test("section navigation wraps and invalid sections fall back", () => {
  assert.equal(normalizeSection("mcp"), "mcp");
  assert.equal(normalizeSection("providers"), "providers");
  assert.equal(normalizeSection("unknown"), "overview");
  assert.equal(moveSection("overview", -1), "cloud");
  assert.equal(moveSection("cloud", 1), "overview");
});

test("target and preset selection are deterministic", () => {
  assert.equal(otherTarget("codex"), "claude");
  assert.equal(otherTarget("claude"), "codex");
  assert.equal(targetLabel("codex"), "Codex");
  assert.equal(targetLabel("claude"), "Claude Code");
  assert.equal(targetLabel("opencode"), "OpenCode");
  assert.equal(targetLabel("pi"), "Pi");
  assert.equal(cycleTarget("codex", 1, PROVIDER_TARGETS), "opencode");
  assert.equal(cycleTarget("claude", -1, PROVIDER_TARGETS), "pi");
  assert.equal(clampSelection(4, 2), 1);
  assert.equal(clampSelection(-1, 2), 0);
  assert.equal(clampSelection(3, 0), 0);
  assert.equal(selectionDelta("]"), 1);
  assert.equal(selectionDelta("["), -1);
  assert.equal(selectionDelta("", { downArrow: true }), 1);
  assert.equal(selectionDelta("", { upArrow: true }), -1);
  assert.equal(selectionDelta("j"), 0);
  assert.equal(selectionDelta("k"), 0);
});

test("MCP comparison makes shared and per-client assignments explicit", () => {
  const snapshot = {
    doctor: {
      targets: [
        {
          target: "codex",
          mcp: {
            ok: true,
            data: {
              healthy: true,
              selection_mode: "profile",
              profile: "work",
              servers: ["shared", "codex-only"],
              suppressed_servers: ["computer-use"]
            }
          }
        },
        {
          target: "claude",
          mcp: {
            ok: true,
            data: {
              healthy: true,
              selection_mode: "profile",
              profile: "work",
              servers: ["claude-only", "shared"]
            }
          }
        }
      ]
    }
  };
  const comparison = mcpTargetComparison(snapshot);
  assert.deepEqual(comparison.shared, ["shared"]);
  assert.deepEqual(comparison.only.codex, ["codex-only"]);
  assert.deepEqual(comparison.only.claude, ["claude-only"]);
  assert.deepEqual(comparison.targets.codex.suppressed, ["computer-use"]);
  assert.equal(componentTargetState(snapshot, "mcp", "claude").selection, "work");
});

test("catalog windows keep the selected item visible without rendering the full store", () => {
  const entries = Array.from({ length: 14 }, (_, index) => `profile-${index}`);
  const visible = selectionWindow(entries, 12, 5);
  assert.equal(visible.start, 9);
  assert.equal(visible.end, 14);
  assert.equal(visible.total, 14);
  assert.deepEqual(visible.items.map(({ item }) => item), entries.slice(9));
});

test("Prompt presentation exposes local binding metadata but drops content fields", () => {
  const snapshot = {
    doctor: {
      targets: [{
        target: "codex",
        prompt: {
          ok: true,
          data: {
            client: "codex",
            profile: "personal",
            managed: true,
            healthy: true,
            link_file: "/home/user/.codex/config.toml",
            instruction_file: "/home/user/.codex/instructions/personal.md",
            instructions: "regular",
            content: "do-not-render",
            prompt_text: "also-do-not-render"
          }
        }
      }]
    }
  };
  const state = promptTargetState(snapshot, "codex");
  assert.equal(state.selection, "personal");
  assert.equal(state.managed, true);
  assert.equal(state.fileState, "regular");
  assert.equal(JSON.stringify(state).includes("do-not-render"), false);
  assert.equal(Object.hasOwn(state, "content"), false);
  assert.equal(Object.hasOwn(state, "prompt_text"), false);
});

test("Snippet presentation merges local and cloud metadata without content", () => {
  const entries = snippetEntries(
    [{
      name: "review-code",
      path: "/home/user/.local/share/script-toolbox/snippets/review-code.md",
      state: "regular",
      content: "do-not-render"
    }],
    [{
      name: "review-code",
      count: 1,
      unit: "snippet",
      source: "cloud",
      content: "also-do-not-render"
    }, {
      name: "plan-first",
      source: "cloud",
      prompt_text: "never-render"
    }]
  );
  assert.deepEqual(entries.map(({ name }) => name), ["plan-first", "review-code"]);
  assert.equal(entries[0].local, null);
  assert.equal(entries[0].remote.source, "cloud");
  assert.equal(entries[1].local.state, "regular");
  assert.equal(JSON.stringify(entries).includes("do-not-render"), false);
  assert.equal(JSON.stringify(entries).includes("never-render"), false);
});

test("Provider presentation distinguishes local/cloud entries and drops Secret values", () => {
  const entries = providerEntries([{
    name: "gateway",
    description: "Local gateway",
    protocol: "openai_responses",
    endpoint: "https://gateway.example.test/v1",
    requested_model: "daily",
    outbound_model: "vendor-model",
    ready: true,
    auth_mode: "bearer",
    secret_reference: "gateway_key",
    secret_present: true,
    applied: true,
    target: "codex",
    platform: "darwin",
    secret_value: "never-render-local"
  }], [{
    name: "gateway",
    protocol: "openai_responses",
    ready: false,
    issue: "local Secret is missing",
    secret_value: "never-render-cloud"
  }]);
  assert.deepEqual(entries.map(({ key }) => key), ["local:gateway", "cloud:gateway"]);
  assert.equal(entries[0].applied, true);
  assert.equal(entries[0].secretReference, "gateway_key");
  assert.equal(entries[1].source, "cloud");
  assert.equal(JSON.stringify(entries).includes("never-render"), false);
  assert.equal(Object.hasOwn(entries[0], "secret_value"), false);
});

test("actions are scoped and writes require confirmation", () => {
  assert.equal(actionForKey("presets", "p"), "plan");
  assert.equal(actionForKey("presets", "P"), null);
  assert.equal(actionForKey("mcp", "p"), "mcp-plan");
  assert.equal(actionForKey("skills", "a"), "skills-apply");
  assert.equal(actionForKey("prompts", "v"), "prompt-view-local");
  assert.equal(actionForKey("prompts", "V"), "prompt-view-cloud");
  assert.equal(actionForKey("snippets", "p"), "snippets-plan");
  assert.equal(actionForKey("snippets", "a"), "snippets-apply");
  assert.equal(actionForKey("snippets", "c"), "snippet-copy");
  assert.equal(actionForKey("agents", "c"), "agent-configure");
  assert.equal(actionForKey("agents", "p"), "agent-providers");
  assert.equal(actionForKey("agents", "x"), "agent-uninstall");
  assert.equal(actionForKey("providers", "p"), "provider-plan");
  assert.equal(actionForKey("providers", "a"), "provider-apply");
  assert.equal(actionForKey("providers", "u"), "provider-sync-push");
  assert.equal(actionForKey("providers", "d"), "provider-sync-pull");
  assert.equal(actionForKey("cloud", "P"), null);
  assert.equal(actionNeedsConfirmation("plan"), false);
  assert.equal(actionNeedsConfirmation("apply"), true);
  assert.equal(actionNeedsConfirmation("prompts-apply"), true);
  assert.equal(actionNeedsConfirmation("snippets-apply"), true);
  assert.equal(actionNeedsConfirmation("snippet-copy"), false);
  assert.equal(actionNeedsConfirmation("agent-uninstall"), true);
  assert.equal(actionNeedsConfirmation("provider-plan"), false);
  assert.equal(actionNeedsConfirmation("provider-apply"), true);
  assert.equal(actionNeedsConfirmation("provider-sync-push"), true);
  assert.equal(actionNeedsConfirmation("provider-sync-pull"), true);
});

test("Prompt previews strip terminal controls without redacting user text", () => {
  const content = safePromptPreviewText("api_key=visible-to-owner\n\u001b[31mHeading\u001b[0m\u0007");
  assert.equal(content, "api_key=visible-to-owner\nHeading");
});

test("component summaries preserve useful state without raw secrets", () => {
  assert.deepEqual(componentSummary("mcp", {
    ok: true,
    data: { healthy: true, selection_mode: "profile", profile: "work", servers: ["github"] }
  }), { label: "Healthy", kind: "good", detail: "work · 1 server(s)" });
  assert.equal(componentSummary("provider", {
    ok: true,
    data: {
      provider_status: "configured",
      provider_source: "official-login",
      provider: "openai",
      model: "gpt",
      credential_exists: true,
      credential_private: true
    }
  }).detail, "openai / gpt · official login");
  assert.equal(componentSummary("provider", {
    ok: true,
    data: {
      provider_status: "configured",
      provider_source: "external",
      provider: "external-endpoint",
      credential_exists: true,
      credential_private: false
    }
  }).kind, "warn");
  assert.deepEqual(componentSummary("prompts", {
    ok: true,
    data: { managed: false, profile: null }
  }), { label: "Not managed", kind: "warn", detail: "none" });
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
