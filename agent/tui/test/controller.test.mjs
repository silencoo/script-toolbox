import assert from "node:assert/strict";
import test from "node:test";
import { createController, parseJsonOutput, sanitizeOutput } from "../src/controller.mjs";

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

test("controller composes snapshot and confirmed preset action commands", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push(args.slice(1));
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
    componentPlan: async (type, name, target) => ({
      type, name, target, items: ["one"], unit: type === "mcp" ? "servers" : "skills"
    }),
    materializeComponent: async (type, name, target) => {
      writes.push(`materialize:${type}:${name}:${target}`);
      return { type, name, target };
    },
    runtimeEnvironment: async () => ({ MCPCTL_STORE: "/runtime/mcp" }),
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

  const presetPlan = await controller.action("plan", { preset: "web", source: "cloud", target: "codex" });
  assert.match(presetPlan.detail, /Prompt personal: create/);
  assert.equal(writes.includes("preset:web"), false);

  const presetApply = await controller.action("apply", { preset: "web", source: "cloud", target: "codex" });
  assert.equal(presetApply.ok, true);
  assert.deepEqual(writes.slice(-2), ["preset:web", "prompt"]);
  assert.deepEqual(calls.at(-1).args.slice(1), ["preset", "apply", "web", "--target", "codex", "--yes", "--json"]);
});
