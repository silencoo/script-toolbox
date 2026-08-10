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

test("Agents actions expose providers, owned uninstall, and interactive setup", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    return { code: 0, stdout: "provider-a\nprovider-b\n", stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const providers = await controller.action("agent-providers", { agent: "codex" });
  assert.equal(providers.ok, true);
  assert.match(providers.detail, /provider-a/);
  assert.deepEqual(calls.at(-1).args, ["providers", "codex"]);

  const removed = await controller.action("agent-uninstall", { agent: "claude" });
  assert.equal(removed.ok, true);
  assert.deepEqual(calls.at(-1).args, ["uninstall", "claude", "--yes"]);
  const copied = await controller.action("snippet-copy", { selection: "review-code" });
  assert.equal(copied.ok, true);
  assert.deepEqual(calls.at(-1).args, ["snippet", "copy", "review-code"]);
  assert.deepEqual(controller.interactiveCommand("pi"), {
    executable: "/agent/agentctl/agentctl",
    args: ["setup", "pi"]
  });
  assert.throws(() => controller.interactiveCommand("unknown"), /unsupported agent/);
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
    if (command === "provider list --json") {
      return {
        code: 0,
        stdout: JSON.stringify([{
          schema: 1,
          name: "gateway",
          description: "Daily gateway",
          protocol: "openai_responses",
          endpoint: "https://gateway.example.test/v1",
          auth: { mode: "bearer", secret: "gateway_key" },
          models: { default: "daily", aliases: { daily: "vendor-model" } },
          targets: {},
          platforms: {}
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
    if (args[0] === "provider" && args[1] === "apply") {
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
  assert.equal(calls[1].includes("--yes"), true);
  assert.equal(calls[1].includes("--store"), false);

  const pushed = await controller.action("provider-sync-push");
  assert.equal(pushed.ok, true);
  assert.match(pushed.detail, /Backed up 1 profile/);
  assert.deepEqual(calls[2], ["workspace", "agent", "push", "--yes", "--json"]);
  const pulled = await controller.action("provider-sync-pull");
  assert.equal(pulled.ok, true);
  assert.match(pulled.detail, /Merged 1 profile/);
  assert.deepEqual(calls[3], ["workspace", "agent", "pull", "--yes", "--json"]);
});
