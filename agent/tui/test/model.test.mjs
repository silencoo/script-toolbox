import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVIDER_TARGETS,
  PROVIDER_PANELS,
  SKILL_TARGETS,
  accountEntries,
  actionForKey,
  actionLabel,
  actionNeedsConfirmation,
  clampSelection,
  componentSummary,
  componentTargetState,
  cycleTarget,
  cycleProviderPanel,
  filterMcpServerEntries,
  filterSkillEntries,
  mcpServerEntries,
  mcpTargetComparison,
  moveSection,
  normalizeSection,
  otherTarget,
  promptTargetState,
  providerEntries,
  proxyPresentation,
  safePromptPreviewText,
  sectionDelta,
  selectionDelta,
  selectionDiff,
  selectionWindow,
  skillContentDiff,
  skillEntries,
  skillTargetState,
  snippetEntries,
  targetLabel,
  workspaceConfigured,
  workspacePresentation
} from "../src/model.mjs";

test("section navigation wraps and invalid sections fall back", () => {
  assert.equal(normalizeSection("mcp"), "mcp");
  assert.equal(normalizeSection("accounts"), "accounts");
  assert.equal(normalizeSection("providers"), "providers");
  assert.equal(normalizeSection("unknown"), "overview");
  assert.equal(moveSection("overview", -1), "cloud");
  assert.equal(moveSection("cloud", 1), "overview");
});

test("Workspace configuration survives local-first snapshot hydration", () => {
  assert.equal(workspaceConfigured({
    workspaceConnection: { configured: true }
  }), true);
  assert.equal(workspaceConfigured({
    workspace: {
      mode: "workspace",
      endpoint: "https://workspace.example.test",
      store_id: "a".repeat(32)
    }
  }), true);
  assert.equal(workspaceConfigured({ workspace: null, workspaceConnection: null }), false);
});

test("official account presentation exposes labels only and marks the active snapshot", () => {
  const entries = accountEntries({
    accounts: {
      accounts: [{
        name: "secondary",
        current: false,
        saved_at: "2026-08-11T00:00:00.000Z",
        credential_private: true,
        access_token: "never-render"
      }, {
        name: "primary",
        current: true,
        saved_at: "2026-08-10T00:00:00.000Z",
        credential_private: true,
        account_id: "never-render-either"
      }, {
        name: "Unsafe Label",
        current: false
      }]
    }
  });
  assert.deepEqual(entries.map(({ name }) => name), ["primary", "secondary"]);
  assert.equal(entries[0].current, true);
  assert.equal(entries[0].credentialPrivate, true);
  assert.equal(JSON.stringify(entries).includes("never-render"), false);
  assert.equal(Object.hasOwn(entries[0], "account_id"), false);
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
  assert.deepEqual(PROVIDER_PANELS, ["summary", "config", "runtime", "usage"]);
  assert.equal(cycleProviderPanel("summary"), "config");
  assert.equal(cycleProviderPanel("usage"), "summary");
  assert.equal(clampSelection(4, 2), 1);
  assert.equal(clampSelection(-1, 2), 0);
  assert.equal(clampSelection(3, 0), 0);
  assert.equal(selectionDelta("]"), 0);
  assert.equal(selectionDelta("["), 0);
  assert.equal(selectionDelta("", { downArrow: true }), 1);
  assert.equal(selectionDelta("", { upArrow: true }), -1);
  assert.equal(selectionDelta("j"), 0);
  assert.equal(selectionDelta("k"), 0);
  assert.equal(sectionDelta("]"), 1);
  assert.equal(sectionDelta("["), -1);
  assert.equal(sectionDelta("", { rightArrow: true }), 1);
  assert.equal(sectionDelta("", { leftArrow: true }), -1);
  assert.equal(sectionDelta("", { tab: true }), 1);
  assert.equal(sectionDelta("", { tab: true, shift: true }), -1);
  assert.equal(sectionDelta("", { downArrow: true }), 0);
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

  const servers = mcpServerEntries([
    { name: "inactive", category: "other" },
    { name: "claude-only", category: "local" },
    { name: "shared", category: "search" },
    { name: "computer-use", category: "browser" }
  ], snapshot, "codex");
  assert.deepEqual(servers.map(({ name }) => name), [
    "shared", "claude-only", "computer-use", "inactive"
  ]);
  assert.equal(servers[0].enabled, true);
  assert.equal(servers[1].otherEnabled, true);
  assert.equal(servers[2].suppressed, true);

  const searchable = servers.map((entry) => ({
    ...entry,
    ready: entry.name === "computer-use" ? false : true
  }));
  assert.deepEqual(
    filterMcpServerEntries(searchable, { query: "browser" })
      .map(({ name }) => name),
    ["computer-use"]
  );
  assert.deepEqual(
    filterMcpServerEntries(searchable, { filter: "enabled" })
      .map(({ name }) => name),
    ["shared"]
  );
  assert.deepEqual(
    filterMcpServerEntries(searchable, { filter: "problems" })
      .map(({ name }) => name),
    ["computer-use"]
  );
});

test("Skill entries expose four-client local state and keep enabled items first", () => {
  const states = {
    codex: {
      target: "codex",
      selection_mode: "manual",
      base_pack: "base",
      base_skills: ["shared"],
      skills: ["codex-only", "shared"],
      drift: [],
      healthy: true
    },
    claude: { target: "claude", selection_mode: "pack", pack: "base", skills: ["shared"], healthy: true },
    opencode: { target: "opencode", selection_mode: "pack", pack: "base", skills: ["other"], healthy: true },
    pi: { target: "pi", selection_mode: "pack", pack: "off", skills: [], healthy: true }
  };
  assert.deepEqual(SKILL_TARGETS, ["codex", "claude", "opencode", "pi"]);
  assert.equal(skillTargetState(states, "codex").selection, "custom");
  const entries = skillEntries([
    { name: "other", description: "Other client Skill" },
    { name: "inactive", description: "Inactive Skill" },
    { name: "shared", description: "Shared Skill" },
    { name: "codex-only", description: "Codex Skill" }
  ], states, "codex");
  assert.deepEqual(entries.map(({ name }) => name), [
    "shared", "codex-only", "other", "inactive"
  ]);
  assert.deepEqual(entries.find(({ name }) => name === "shared").enabledTargets, ["claude"]);
  assert.deepEqual(entries.find(({ name }) => name === "other").enabledTargets, ["opencode"]);
  assert.deepEqual(
    filterSkillEntries(entries, { query: "other" }).map(({ name }) => name),
    ["other"]
  );
  assert.deepEqual(
    filterSkillEntries(entries, { enabledOnly: true }).map(({ name }) => name),
    ["shared", "codex-only"]
  );
});

test("Skill Pack comparison separates added, removed, and unchanged Skills", () => {
  assert.deepEqual(
    selectionDiff(
      ["design-app-icons", "frontend-dev", "legacy"],
      ["creative-frontend", "design-app-icons", "frontend-dev", "gsap-motion"]
    ),
    {
      added: ["creative-frontend", "gsap-motion"],
      removed: ["legacy"],
      unchanged: ["design-app-icons", "frontend-dev"]
    }
  );
  assert.deepEqual(selectionDiff(null, null), { added: [], removed: [], unchanged: [] });
});

test("Skill content comparison distinguishes same names with different canonical files", () => {
  assert.deepEqual(skillContentDiff([
    { name: "creative-frontend", sha256: "a".repeat(64) },
    { name: "frontend-dev", sha256: "b".repeat(64) },
    { name: "unchecked", sha256: "invalid" }
  ], ["unchecked", "frontend-dev", "cloud-only", "creative-frontend"], {
    "creative-frontend": "a".repeat(64),
    "frontend-dev": "c".repeat(64),
    unchecked: "d".repeat(64),
    "cloud-only": "e".repeat(64)
  }), {
    same: ["creative-frontend"],
    different: ["frontend-dev"],
    workspaceOnly: ["cloud-only"],
    unchecked: ["unchecked"]
  });
  assert.deepEqual(skillContentDiff(null, null, null), {
    same: [],
    different: [],
    workspaceOnly: [],
    unchecked: []
  });
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

test("Provider presentation merges matching local/Workspace profiles and drops Secret values", () => {
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
    compaction_upstream: "responses_v2",
    compaction_policy: "auto",
    compaction_mode: "remote_native",
    compaction_label: "Remote · native",
    context_window_tokens: 1_000_000,
    auto_compact_tokens: 500_000,
    context_label: "1,000,000 max · compact at 500,000",
    official_identity_policy: "preserve",
    official_identity_account: "current",
    applied: true,
    target: "codex",
    platform: "darwin",
    secret_value: "never-render-local"
  }], [{
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
    compaction_upstream: "responses_v2",
    compaction_policy: "auto",
    compaction_mode: "remote_native",
    compaction_label: "Remote · native",
    context_window_tokens: 1_000_000,
    auto_compact_tokens: 500_000,
    context_label: "1,000,000 max · compact at 500,000",
    official_identity_policy: "preserve",
    official_identity_account: "current",
    secret_value: "never-render-cloud"
  }]);
  assert.deepEqual(entries.map(({ key }) => key), ["gateway"]);
  assert.equal(entries[0].applied, true);
  assert.equal(entries[0].source, "local");
  assert.deepEqual(entries[0].sources, ["local", "cloud"]);
  assert.equal(entries[0].syncStatus, "backed-up");
  assert.deepEqual(entries[0].syncConflicts, []);
  assert.equal(entries[0].secretReference, "gateway_key");
  assert.equal(entries[0].officialIdentityPolicy, "preserve");
  assert.equal(entries[0].officialIdentityAccount, "current");
  assert.equal(entries[0].compactionLabel, "Remote · native");
  assert.equal(entries[0].contextWindowTokens, 1_000_000);
  assert.equal(entries[0].autoCompactTokens, 500_000);
  assert.match(entries[0].contextLabel, /compact at 500,000/);
  assert.equal(JSON.stringify(entries).includes("never-render"), false);
  assert.equal(Object.hasOwn(entries[0], "secret_value"), false);
});

test("Provider presentation keeps local precedence and reports safe metadata conflicts", () => {
  const entries = providerEntries([{
    name: "gateway",
    source: "local",
    endpoint: "https://local.example.test/v1",
    protocol: "openai_responses",
    ready: true,
    secret_present: true
  }], [{
    name: "gateway",
    source: "cloud",
    endpoint: "https://workspace.example.test/v1",
    protocol: "openai_responses",
    ready: true,
    secret_present: true
  }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "local");
  assert.equal(entries[0].endpoint, "https://local.example.test/v1");
  assert.equal(entries[0].syncStatus, "conflict");
  assert.deepEqual(entries[0].syncConflicts, ["Endpoint"]);
});

test("Provider presentation keeps an unmaterialized built-in template distinct", () => {
  const entries = providerEntries([{
    name: "deepseek",
    source: "builtin",
    materialized: false,
    status: "needs-key",
    requested_model: "deepseek-v4-pro",
    outbound_model: "deepseek-v4-pro",
    models_available: ["deepseek-v4-pro", "deepseek-v4-flash"],
    secret_reference: "deepseek_api_key",
    native_auth_present: true,
    native_auth_provider: "deepseek",
    native_auth_type: "api",
    native_selected: true,
    native_selected_model: "deepseek-v4-pro"
  }], []);
  assert.equal(entries[0].key, "deepseek");
  assert.equal(entries[0].source, "builtin");
  assert.deepEqual(entries[0].sources, ["builtin"]);
  assert.equal(entries[0].syncStatus, "builtin-only");
  assert.equal(entries[0].status, "needs-key");
  assert.deepEqual(entries[0].modelsAvailable, ["deepseek-v4-pro", "deepseek-v4-flash"]);
  assert.equal(entries[0].nativeAuthPresent, true);
  assert.equal(entries[0].nativeAuthProvider, "deepseek");
  assert.equal(entries[0].nativeAuthType, "api");
  assert.equal(entries[0].nativeSelected, true);
  assert.equal(entries[0].nativeSelectedModel, "deepseek-v4-pro");
});

test("Provider presentation treats a materialized built-in as local while retaining its origin", () => {
  const entries = providerEntries([{
    name: "deepseek",
    source: "builtin",
    materialized: true,
    endpoint: "https://api.deepseek.com/anthropic",
    protocol: "anthropic_messages",
    ready: true,
    secret_present: true
  }], []);
  assert.equal(entries[0].source, "local");
  assert.deepEqual(entries[0].sources, ["builtin", "local"]);
  assert.equal(entries[0].syncStatus, "local-only");
});

test("Provider presentation prefers a Workspace profile over its unmaterialized built-in template", () => {
  const entries = providerEntries([{
    name: "deepseek",
    source: "builtin",
    materialized: false,
    endpoint: "https://api.deepseek.com/anthropic",
    protocol: "anthropic_messages",
    ready: false,
    status: "needs-key"
  }], [{
    name: "deepseek",
    source: "cloud",
    endpoint: "https://workspace-gateway.example.test",
    protocol: "anthropic_messages",
    ready: true,
    secret_present: true
  }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "cloud");
  assert.equal(entries[0].endpoint, "https://workspace-gateway.example.test");
  assert.deepEqual(entries[0].sources, ["builtin", "cloud"]);
  assert.equal(entries[0].syncStatus, "workspace-only");
});

test("Provider presentation hides incompatible targets by default and can reveal them", () => {
  const remote = [{
    name: "claude-only",
    source: "cloud",
    enabled: false,
    compatible: false,
    status: "disabled"
  }];
  assert.deepEqual(providerEntries([], remote), []);
  const entries = providerEntries([], remote, { includeIncompatible: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "claude-only");
  assert.equal(entries[0].syncStatus, "workspace-only");
});

test("actions are scoped and writes require confirmation", () => {
  assert.equal(actionForKey("presets", "p"), "plan");
  assert.equal(actionForKey("presets", "P"), null);
  assert.equal(actionForKey("mcp", "p"), "mcp-plan");
  assert.equal(actionForKey("mcp", "f"), "mcp-repair");
  assert.equal(actionForKey("mcp", " "), "mcp-toggle");
  assert.equal(actionForKey("skills", "a"), "skills-apply");
  assert.equal(actionForKey("skills", "d"), "skills-download");
  assert.equal(actionForKey("skills", "f"), "skills-repair");
  assert.equal(actionForKey("skills", " "), "skills-toggle");
  assert.equal(actionForKey("prompts", "v"), "prompt-view-local");
  assert.equal(actionForKey("prompts", "V"), "prompt-view-cloud");
  assert.equal(actionForKey("snippets", "p"), "snippets-plan");
  assert.equal(actionForKey("snippets", "a"), "snippets-apply");
  assert.equal(actionForKey("snippets", "c"), "snippet-copy");
  assert.equal(actionForKey("agents", "c"), "agent-provider");
  assert.equal(actionForKey("agents", "p"), "agent-provider");
  assert.equal(actionForKey("agents", "\r"), "agent-provider");
  assert.equal(actionForKey("agents", "x"), "agent-uninstall");
  assert.equal(actionForKey("accounts", "a"), "account-use");
  assert.equal(actionForKey("accounts", "\r"), "account-use");
  assert.equal(actionForKey("accounts", "x"), "account-delete");
  assert.equal(actionForKey("providers", "p"), "provider-plan");
  assert.equal(actionForKey("providers", "a"), "provider-apply");
  assert.equal(actionForKey("providers", "u"), "provider-sync-push");
  assert.equal(actionForKey("providers", "d"), "provider-sync-pull");
  assert.equal(actionForKey("providers", "S"), "proxy-toggle-running");
  assert.equal(actionForKey("providers", "A"), "proxy-toggle-attachment");
  assert.equal(actionForKey("cloud", "P"), null);
  assert.equal(actionNeedsConfirmation("plan"), false);
  assert.equal(actionNeedsConfirmation("apply"), true);
  assert.equal(actionNeedsConfirmation("prompts-apply"), true);
  assert.equal(actionNeedsConfirmation("snippets-apply"), true);
  assert.equal(actionNeedsConfirmation("snippet-copy"), false);
  assert.equal(actionNeedsConfirmation("agent-uninstall"), true);
  assert.equal(actionNeedsConfirmation("account-use"), true);
  assert.equal(actionNeedsConfirmation("account-delete"), true);
  assert.equal(actionNeedsConfirmation("provider-plan"), false);
  assert.equal(actionNeedsConfirmation("provider-apply"), true);
  assert.equal(actionNeedsConfirmation("provider-sync-push"), true);
  assert.equal(actionNeedsConfirmation("provider-sync-pull"), true);
  assert.equal(actionNeedsConfirmation("proxy-start"), true);
  assert.equal(actionNeedsConfirmation("proxy-stop"), true);
  assert.equal(actionNeedsConfirmation("proxy-attach"), true);
  assert.equal(actionNeedsConfirmation("proxy-detach"), true);
  assert.match(actionLabel("proxy-attach"), /Attach Codex/);
  assert.match(actionLabel("proxy-detach"), /Detach Codex/);
  assert.equal(actionNeedsConfirmation("skills-disable"), true);
  assert.equal(actionNeedsConfirmation("skills-batch"), true);
  assert.equal(actionNeedsConfirmation("mcp-repair"), true);
  assert.equal(actionNeedsConfirmation("mcp-enable"), true);
  assert.equal(actionNeedsConfirmation("mcp-disable"), true);
  assert.equal(actionNeedsConfirmation("mcp-batch"), true);
  assert.equal(actionNeedsConfirmation("mcp-profile-save"), true);
  assert.equal(actionNeedsConfirmation("mcp-profile-update"), true);
  assert.equal(actionNeedsConfirmation("mcp-profile-upload"), true);
  assert.equal(actionNeedsConfirmation("skills-repair"), true);
  assert.equal(actionNeedsConfirmation("skills-download"), true);
  assert.match(actionLabel("skills-download", "frontend"), /Workspace Pack frontend/);
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
  assert.deepEqual(componentSummary("identity", {
    ok: true,
    data: {
      identity: {
        status: "configured",
        kind: "chatgpt",
        account: "current",
        source: "official-login",
        credential_exists: true,
        credential_private: true
      }
    }
  }), {
    label: "ChatGPT",
    kind: "good",
    detail: "current account · official login"
  });
  assert.deepEqual(componentSummary("inference", {
    ok: true,
    data: {
      inference: {
        status: "configured",
        provider: "openai-official",
        model: "gpt-5.6-sol",
        source: "official-account",
        credential_exists: true,
        credential_private: true
      }
    }
  }), {
    label: "Subscription",
    kind: "good",
    detail: "openai-official / gpt-5.6-sol · ChatGPT official subscription"
  });
  assert.deepEqual(componentSummary("inference", {
    ok: true,
    data: {
      inference: {
        status: "configured",
        provider: "minimax",
        model: "MiniMax-M3",
        source: "agentctl",
        credential_exists: true,
        credential_private: true
      }
    }
  }), {
    label: "Configured",
    kind: "good",
    detail: "minimax / MiniMax-M3 · agentctl"
  });
  assert.deepEqual(componentSummary("prompts", {
    ok: true,
    data: { managed: false, profile: null }
  }), { label: "Not managed", kind: "warn", detail: "none" });
});

test("Proxy presentation distinguishes listener, attachment, and official request path", () => {
  const detached = proxyPresentation({
    status: "running",
    running: true,
    local_base_url: "http://127.0.0.1:17321",
    attachment: { status: "detached", attached: false }
  }, { officialSubscription: true });
  assert.equal(detached.running, true);
  assert.equal(detached.attached, false);
  assert.match(detached.observerLabel, /127\.0\.0\.1:17321/);
  assert.match(detached.attachmentLabel, /not recorded/);
  assert.match(detached.routeLabel, /directly/);

  const attached = proxyPresentation({
    status: "running",
    running: true,
    mode: "openai_subscription_passthrough",
    attachment: { status: "attached", attached: true }
  }, { officialSubscription: true });
  assert.equal(attached.attachmentPresent, true);
  assert.equal(attached.attached, true);
  assert.match(attached.attachmentLabel, /recording new Codex requests/);
  assert.match(attached.routeLabel, /local observer/);
  assert.match(attached.routeLabel, /official subscription/);

  const custom = proxyPresentation({
    status: "stopped",
    running: false,
    attachment: { status: "detached", attached: false }
  });
  assert.match(custom.routeLabel, /active Codex inference Provider/);
});

test("Workspace empty states distinguish setup, connectivity, and incompatible data", () => {
  const connecting = workspacePresentation(null, "", true);
  assert.equal(connecting.state, "connecting");
  assert.equal(connecting.status, "Connecting…");
  assert.match(connecting.description, /Local configuration is already available/);

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

  const cached = { store_id: "a".repeat(32) };
  const refreshing = workspacePresentation(cached, "", true);
  assert.equal(refreshing.state, "refreshing");
  assert.equal(refreshing.status, "Online · refreshing");

  const stale = workspacePresentation(cached, "[error] could not reach the remote toolbox store");
  assert.equal(stale.state, "stale");
  assert.equal(stale.status, "Cached · retrying");
  assert.match(stale.description, /last successful Workspace index/);
});
