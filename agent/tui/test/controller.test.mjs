import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createController,
  normalizeSnippetMetadata,
  parseJsonOutput,
  readPromptPreviewFile,
  sanitizeOutput
} from "../src/controller.mjs";

test("JSON remains usable when doctor reports unhealthy exit status", () => {
  const result = parseJsonOutput({ code: 1, stdout: '{"healthy":false}', stderr: "" }, "doctor");
  assert.equal(result.ok, false);
  assert.deepEqual(result.data, { healthy: false });
});

test("diagnostics remove control codes and common credential forms", () => {
  const value = sanitizeOutput(`\u001b[31mAuthorization: Bearer abc.def\u001b[0m api_key=secret-value "auth_token": "also-secret"`);
  assert.equal(value.includes("abc.def"), false);
  assert.equal(value.includes("secret-value"), false);
  assert.equal(value.includes("also-secret"), false);
  assert.match(value, /\[redacted\]/);
});

test("Snippet controller metadata drops content before entering the TUI snapshot", () => {
  const metadata = normalizeSnippetMetadata([{
    name: "review-code",
    path: "/snippets/review-code.md",
    state: "regular",
    content: "do-not-render",
    prompt_text: "also-do-not-render"
  }]);
  assert.deepEqual(metadata, [{
    name: "review-code",
    path: "/snippets/review-code.md",
    state: "regular"
  }]);
  assert.equal(JSON.stringify(metadata).includes("do-not-render"), false);
});

test("Prompt content is loaded only through an explicit local or Workspace preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-prompt-preview-"));
  const path = join(root, "personal.md");
  await writeFile(path, "Local preview body.\n", { mode: 0o600 });
  const runner = async (executable, args) => {
    if (executable.endsWith("/promptctl") && args[0] === "path") {
      return { code: 0, stdout: JSON.stringify({ codex: path }), stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const remoteWorkspace = {
    promptDocument: async (name, target) => ({
      name,
      target,
      content: "Workspace preview body.\n"
    })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });

  const local = await controller.promptPreview({ source: "local", selection: "personal", target: "codex" });
  assert.equal(local.content, "Local preview body.\n");
  assert.equal(local.path, path);
  const cloud = await controller.promptPreview({ source: "cloud", selection: "work", target: "codex" });
  assert.equal(cloud.content, "Workspace preview body.\n");
  assert.equal(cloud.path, "");
  await assert.rejects(readPromptPreviewFile("relative.md"), /path is invalid/);
});

test("controller composes snapshot and confirmed preset action commands", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push(args.slice(1));
    if (executable.endsWith("/promptctl") && args[0] === "snippet") {
      return {
        code: 0,
        stdout: '[{"name":"review-code","path":"/snippets/review-code.md","state":"regular"}]',
        stderr: ""
      };
    }
    if (executable.endsWith("/agentctl") && args.includes("status")) {
      return { code: 0, stdout: '[{"client":"codex","provider_status":"configured"}]', stderr: "" };
    }
    if (args.includes("doctor")) return { code: 1, stdout: '{"healthy":false,"targets":[]}', stderr: "" };
    if (args.includes("list")) return { code: 0, stdout: '{"work":{"mcp":"base","skills":"base","prompt":"personal"}}', stderr: "" };
    if (args.includes("status")) return { code: 0, stdout: '{"mode":"workspace","presets":[]}', stderr: "" };
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const remoteWorkspace = {
    index: async () => ({
      mode: "workspace",
      store_id: "a".repeat(32),
      latest: { version: "v1" },
      presets: { cloud: { schema: 2, name: "cloud", mcp: "remote", skills: "remote", prompt: "remote" } }
    })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const snapshot = await controller.snapshot();
  assert.equal(snapshot.doctor.healthy, false);
  assert.equal(snapshot.agents[0].client, "codex");
  assert.equal(snapshot.presets.cloud.mcp, "remote");
  assert.deepEqual(snapshot.snippets.map(({ name }) => name), ["review-code"]);
  assert.equal(snapshot.presetSource, "cloud");
  const result = await controller.action("apply", { preset: "work", source: "local", target: "codex" });
  assert.equal(result.ok, true);
  assert.match(result.detail, /configuration applied/);
  assert.deepEqual(calls.at(-1), ["preset", "apply", "work", "--target", "codex", "--yes", "--json"]);
});

test("local snapshot publishes account and agent state before Workspace hydration finishes", async () => {
  let resolveWorkspace;
  let indexStarted = false;
  const remoteIndex = new Promise((resolve) => { resolveWorkspace = resolve; });
  const runner = async (executable, args) => {
    const command = args.join(" ");
    if (executable.endsWith("/promptctl") && command === "snippet list --json") {
      return { code: 0, stdout: '[{"name":"review-code","path":"/snippets/review-code.md","state":"regular"}]', stderr: "" };
    }
    if (executable.endsWith("/agentctl") && command === "status all --json") {
      return {
        code: 0,
        stdout: JSON.stringify([{
          client: "codex",
          identity: { status: "configured", account: "current" },
          inference: { status: "configured", provider: "openai-official" }
        }]),
        stderr: ""
      };
    }
    if (executable.endsWith("/agentctl") && command === "account status --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          kind: "agentctl-codex-account-store",
          active: { status: "saved", official_login: true, saved_as: "primary" },
          account_count: 2,
          accounts: [{ name: "primary", current: true, credential_private: true }]
        }),
        stderr: ""
      };
    }
    if (command.includes("doctor all --local --json")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          healthy: true,
          targets: [{
            target: "codex",
            provider: { data: { identity: { account: "current" } } }
          }],
          remote: { mcp: { skipped: true }, skills: { skipped: true }, prompt: { skipped: true } }
        }),
        stderr: ""
      };
    }
    if (command.includes("doctor all --json")) {
      return { code: 0, stdout: '{"healthy":true,"targets":[]}', stderr: "" };
    }
    if (command.includes("preset list --json")) {
      return { code: 0, stdout: '{"local":{"mcp":"base","skills":"base","prompt":"personal"}}', stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
  };
  const remoteWorkspace = {
    connection: async () => ({
      endpoint: "https://workspace.example.test",
      store_id: "a".repeat(32),
      configured: true
    }),
    index: async () => {
      indexStarted = true;
      return remoteIndex;
    }
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });

  const local = await controller.localSnapshot();
  assert.equal(indexStarted, false);
  assert.equal(local.phase, "local");
  assert.equal(local.workspace, null);
  assert.equal(local.workspaceLoading, true);
  assert.equal(local.agents[0].identity.account, "primary");
  assert.equal(local.doctor.targets[0].provider.data.identity.account, "primary");
  assert.equal(local.accounts.account_count, 2);
  assert.equal(local.snippets[0].name, "review-code");

  const hydration = controller.hydrateSnapshot(local);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(indexStarted, true);
  let hydrationFinished = false;
  void hydration.then(() => { hydrationFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hydrationFinished, false);
  resolveWorkspace({
    mode: "workspace",
    store_id: "a".repeat(32),
    latest: { version: "v2" },
    presets: {}
  });
  const hydrated = await hydration;
  assert.equal(hydrated.phase, "workspace");
  assert.equal(hydrated.workspace.latest.version, "v2");
  assert.equal(hydrated.workspaceConnection.configured, true);
  assert.equal(hydrated.workspaceConnection.endpoint, "https://workspace.example.test");
  assert.equal(hydrated.workspaceLoading, false);
  assert.equal(hydrated.accounts.active.saved_as, "primary");
});

test("remote actions plan without writes and apply through the selected runtime", async () => {
  const calls = [];
  const writes = [];
  const runner = async (executable, args, options = {}) => {
    calls.push({ executable, args, env: options.env || {} });
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };
  const remoteWorkspace = {
    componentPlan: async (type, name, target) => type === "snippets"
      ? { type, name, action: "create", path: `/snippets/${name}.md`, items: [], unit: "snippets" }
      : { type, name, target, items: ["one"], unit: type === "mcp" ? "servers" : "skills" },
    materializeComponent: async (type, name, target) => {
      writes.push(`materialize:${type}:${name}:${target}`);
      return { type, name, target };
    },
    runtimeEnvironment: async () => ({ MCPCTL_STORE: "/runtime/mcp" }),
    writeSnippet: async () => { writes.push("snippet"); },
    writePrompt: async () => { writes.push("prompt"); },
    restorePrompt: async () => { writes.push("restore"); },
    selectionPlan: async (name, target) => ({
      name,
      target,
      preset: { name },
      mcp: { name: "frontend", servers: ["github"] },
      skills: { name: "frontend", skills: ["react"] },
      prompt: { name: "personal", action: "create", path: "/prompt" }
    }),
    materializePreset: async (name) => {
      writes.push(`preset:${name}`);
      return { prompt: { action: "create", previous: null, path: "/prompt" } };
    }
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });

  const plan = await controller.action("mcp-plan", { selection: "frontend", target: "codex" });
  assert.equal(plan.ok, true);
  assert.match(plan.detail, /No remote catalog was written locally/);
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, []);

  const repaired = await controller.action("mcp-repair", {
    selection: "ccs-current",
    target: "codex"
  });
  assert.equal(repaired.ok, true);
  assert.match(repaired.detail, /same-name MCP entries/);
  assert.deepEqual(calls.at(-1).args, [
    "apply", "--target", "codex", "--profile", "ccs-current", "--force"
  ]);

  const skillsRepaired = await controller.action("skills-repair", {
    selection: "imported-claude",
    target: "claude"
  });
  assert.equal(skillsRepaired.ok, true);
  assert.match(skillsRepaired.detail, /managed skill links/);
  assert.deepEqual(calls.at(-1).args, [
    "apply", "--target", "claude", "--pack", "imported-claude", "--yes"
  ]);

  const applied = await controller.action("skills-apply", { selection: "frontend", target: "claude" });
  assert.equal(applied.ok, true);
  assert.deepEqual(writes, ["materialize:skills:frontend:claude"]);
  assert.deepEqual(calls.at(-1).args, ["apply", "--target", "claude", "--pack", "frontend", "--yes"]);
  assert.equal(calls.at(-1).env.MCPCTL_STORE, "/runtime/mcp");

  const snippetPlan = await controller.action("snippets-plan", { selection: "review-code" });
  assert.match(snippetPlan.detail, /content remains hidden/);
  const snippetApply = await controller.action("snippets-apply", { selection: "review-code" });
  assert.equal(snippetApply.ok, true);
  assert.equal(writes.includes("snippet"), true);

  const presetPlan = await controller.action("plan", { preset: "web", source: "cloud", target: "codex" });
  assert.match(presetPlan.detail, /Prompt personal: create/);
  assert.equal(writes.includes("preset:web"), false);

  const presetApply = await controller.action("apply", { preset: "web", source: "cloud", target: "codex" });
  assert.equal(presetApply.ok, true);
  assert.deepEqual(writes.slice(-2), ["preset:web", "prompt"]);
  assert.deepEqual(calls.at(-1).args.slice(1), ["preset", "apply", "web", "--target", "codex", "--yes", "--json"]);
});

test("snapshot preserves public Workspace connection metadata when remote data is incompatible", async () => {
  const runner = async (_executable, args) => {
    if (args.includes("doctor")) return { code: 0, stdout: '{"targets":[]}', stderr: "" };
    if (args.includes("list")) return { code: 0, stdout: '{}', stderr: "" };
    return { code: 0, stdout: '[]', stderr: "" };
  };
  const remoteWorkspace = {
    index: async () => { throw new Error("remote snapshot is not a valid agentctl Workspace"); },
    connection: async () => ({
      endpoint: "https://workspace.example.test",
      store_id: "a".repeat(32),
      configured: true
    })
  };
  const snapshot = await createController({ agentRoot: "/agent", runner, remoteWorkspace }).snapshot();
  assert.equal(snapshot.workspace, null);
  assert.equal(snapshot.workspaceConnection.endpoint, "https://workspace.example.test");
  assert.match(snapshot.workspaceError, /not a valid agentctl Workspace/);
});

test("Workspace refresh retries transient failures and keeps the last successful index", async () => {
  const runner = async (_executable, args) => {
    if (args.includes("doctor")) return { code: 0, stdout: '{"targets":[]}', stderr: "" };
    if (args[0] === "account") {
      return {
        code: 0,
        stdout: '{"schema":1,"kind":"agentctl-codex-account-store","active":{"status":"unavailable","official_login":false,"saved_as":null},"account_count":0,"accounts":[]}',
        stderr: ""
      };
    }
    if (args.includes("list")) return { code: 0, stdout: '{}', stderr: "" };
    return { code: 0, stdout: '[]', stderr: "" };
  };
  const workspace = {
    mode: "workspace",
    store_id: "a".repeat(32),
    latest: { version: "v2" },
    presets: {}
  };
  let indexCalls = 0;
  const remoteWorkspace = {
    connection: async () => ({
      endpoint: "https://workspace.example.test",
      store_id: "a".repeat(32),
      configured: true
    }),
    index: async () => {
      indexCalls += 1;
      if (indexCalls === 1 || indexCalls >= 3) {
        throw new Error("could not reach the remote toolbox store");
      }
      return workspace;
    }
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const connected = await controller.snapshot();
  assert.equal(indexCalls, 2);
  assert.equal(connected.workspace.latest.version, "v2");
  assert.equal(connected.workspaceStale, false);

  const local = await controller.localSnapshot();
  assert.equal(local.workspace.latest.version, "v2");
  assert.equal(local.workspaceLoading, true);
  const stale = await controller.hydrateSnapshot(local);
  assert.equal(indexCalls, 4);
  assert.equal(stale.workspace.latest.version, "v2");
  assert.equal(stale.workspaceStale, true);
  assert.equal(stale.workspaceFailureCount, 1);
  assert.match(stale.workspaceError, /could not reach/);
});

test("Agents actions keep only owned uninstall; Provider navigation stays inside the TUI", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "account") return { code: 0, stdout: '{"ok":true}', stderr: "" };
    return { code: 0, stdout: "provider-a\nprovider-b\n", stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const removed = await controller.action("agent-uninstall", { agent: "claude" });
  assert.equal(removed.ok, true);
  assert.deepEqual(calls.at(-1).args, ["uninstall", "claude", "--yes"]);
  const copied = await controller.action("snippet-copy", { selection: "review-code" });
  assert.equal(copied.ok, true);
  assert.deepEqual(calls.at(-1).args, ["snippet", "copy", "review-code"]);
  const switched = await controller.action("account-use", { selection: "secondary" });
  assert.equal(switched.ok, true);
  assert.deepEqual(calls.at(-1).args, ["account", "use", "secondary", "--yes", "--json"]);
  assert.match(switched.detail, /inference Provider is unchanged/);
  await assert.rejects(
    () => controller.action("agent-provider", { agent: "pi" }),
    /unsupported TUI action/
  );
});

test("Provider dashboard resolves exact target metadata without exposing Secret values", async () => {
  const now = new Date().toISOString();
  const runner = async (_executable, args) => {
    const command = args.join(" ");
    if (command === "provider status --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          platform: "darwin",
          store_exists: true,
          secrets_exists: true,
          profile_count: 1,
          secret_count: 1,
          missing_secrets: [],
          current: {
            codex: {
              profile: "gateway",
              platform: "darwin",
              protocol: "openai_responses",
              endpoint: "https://gateway.example.test/v1",
              requested_model: "daily",
              outbound_model: "vendor-model",
              applied_at: now
            }
          }
        }),
        stderr: ""
      };
    }
    if (command === "provider list --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: "gateway",
          label: "Gateway",
          description: "Daily gateway",
          source: "local",
          materialized: true,
          target: "codex",
          platform: "darwin",
          protocol: "openai_responses",
          endpoint: "https://gateway.example.test/v1",
          requested_model: "daily",
          outbound_model: "vendor-model",
          models_available: [],
          enabled: true,
          compatible: true,
          ready: true,
          status: "ready",
          issue: "",
          auth_mode: "bearer",
          secret_reference: "gateway_key",
          secret_present: true,
          official_identity_policy: "preserve",
          official_identity_account: "current",
          applied: true
        }]),
        stderr: ""
      };
    }
    if (command === "failover status --json") {
      return { code: 0, stdout: '{"status":"available","routes":2}', stderr: "" };
    }
    if (command === "pricing status --json") {
      return { code: 0, stdout: '{"status":"available","version":"2026-08","rates":3}', stderr: "" };
    }
    if (command === "proxy status --json") {
      return { code: 0, stdout: '{"status":"running","running":true,"profile":"gateway","target":"codex"}', stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const dashboard = await createController({
    agentRoot: "/agent",
    runner,
    remoteWorkspace: {}
  }).providerDashboard("codex");
  assert.equal(dashboard.profiles.length, 1);
  assert.equal(dashboard.profiles[0].requested_model, "daily");
  assert.equal(dashboard.profiles[0].outbound_model, "vendor-model");
  assert.equal(dashboard.profiles[0].secret_reference, "gateway_key");
  assert.equal(dashboard.profiles[0].secret_present, true);
  assert.equal(dashboard.profiles[0].official_identity_policy, "preserve");
  assert.equal(dashboard.profiles[0].official_identity_account, "current");
  assert.equal(dashboard.profiles[0].applied, true);
  assert.equal(dashboard.failover.routes, 2);
  assert.equal(dashboard.pricing.version, "2026-08");
  assert.equal(dashboard.proxy.status, "running");
  assert.equal(JSON.stringify(dashboard).includes("secret-value"), false);
});

test("Provider actions plan/apply one source and synchronize only after explicit action", async () => {
  const calls = [];
  const temporary = [];
  const runner = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "provider" && args[1] === "plan") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          profile: "gateway",
          ready: true,
          plans: [{
            target: "codex",
            target_label: "Codex",
            enabled: true,
            ready: true,
            protocol: "openai_responses",
            endpoint: "https://gateway.example.test/v1",
            requested_model: "daily",
            outbound_model: "vendor-model",
            auth: { secret: "gateway_key", present: true }
          }]
        }),
        stderr: ""
      };
    }
    if (args[0] === "provider" && ["apply", "use"].includes(args[1])) {
      return { code: 0, stdout: '{"ok":true,"profile":"gateway","applied":["codex"]}', stderr: "" };
    }
    if (args[0] === "workspace" && args[1] === "agent") {
      return {
        code: 0,
        stdout: '{"ok":true,"bundle":{"profiles":1,"secrets":1,"failover_routes":0,"pricing_rates":0}}',
        stderr: ""
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const remoteWorkspace = {
    withProviderFiles: async (name, target, callback) => {
      temporary.push(`${name}:${target}`);
      return callback({
        storePath: "/tmp/providers.json",
        secretsPath: "/tmp/provider-secrets.json"
      });
    }
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });

  const plan = await controller.action("provider-plan", {
    selection: "gateway",
    source: "cloud",
    target: "codex"
  });
  assert.equal(plan.ok, true);
  assert.match(plan.detail, /No client file was changed/);
  assert.deepEqual(temporary, ["gateway:codex"]);
  assert.equal(calls[0].includes("/tmp/provider-secrets.json"), true);
  assert.equal(calls[0].includes("--yes"), false);

  const applied = await controller.action("provider-apply", {
    selection: "gateway",
    source: "local",
    target: "codex"
  });
  assert.equal(applied.ok, true);
  assert.match(applied.detail, /start a new agent session/);
  assert.equal(calls[1][1], "use");
  assert.equal(calls[1].includes("--yes"), true);
  assert.equal(calls[1].includes("--store"), false);

  const pushed = await controller.action("provider-sync-push", { selection: "gateway" });
  assert.equal(pushed.ok, true);
  assert.match(pushed.detail, /local.*gateway.*encrypted Workspace/i);
  assert.deepEqual(calls[2], [
    "workspace", "agent", "push", "--profile", "gateway", "--yes", "--json"
  ]);
  const pulled = await controller.action("provider-sync-pull", { selection: "gateway" });
  assert.equal(pulled.ok, true);
  assert.match(pulled.detail, /Workspace.*gateway.*local catalog/i);
  assert.deepEqual(calls[3], [
    "workspace", "agent", "pull", "--profile", "gateway", "--yes", "--json"
  ]);
});
