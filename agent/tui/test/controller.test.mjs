import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createController as createControllerForPlatform,
  createProcessRunner,
  normalizeMcpServerCatalog,
  normalizeSkillsCatalog,
  normalizeSnippetMetadata,
  mcpApplyNeedsForce,
  parseJsonOutput,
  readPromptPreviewFile,
  sanitizeOutput,
  skillsCatalogDriftName
} from "../src/controller.mjs";

// Unit runners assert controller argv rather than spawning Git Bash. Keep
// those assertions platform-neutral; process-integration.test.mjs exercises
// the real win32 Bash argv boundary with actual controller processes.
const createController = (options) => createControllerForPlatform({
  ...options,
  platform: "linux"
});

// node:path uses the host separator even when the mocked controller command is
// pinned to Unix execution semantics. Normalize only for executable identity
// checks so these unit runners behave the same on Linux, macOS, and Windows.
const controllerExecutableIs = (executable, name) =>
  String(executable).replaceAll("\\", "/").endsWith(`/${name}`);

test("MCP force adoption detection accepts only the explicit ownership conflict", () => {
  assert.equal(mcpApplyNeedsForce(
    "same-name MCP entries are not owned by mcpctl; re-run with --force to replace only those names"
  ), true);
  assert.equal(mcpApplyNeedsForce("missing required MCP secret"), false);
  assert.equal(mcpApplyNeedsForce("request timed out"), false);
});

test("Skills checksum drift detection accepts only the explicit skillsctl diagnostic", () => {
  assert.equal(skillsCatalogDriftName(
    "skill 'cloudflare' changed outside skillsctl; re-add it to update the catalog checksum"
  ), "cloudflare");
  assert.equal(skillsCatalogDriftName("skill 'Cloudflare' changed outside skillsctl"), "");
  assert.equal(skillsCatalogDriftName("unknown skill: cloudflare"), "");
});

test("Local Skills actions offer named checksum acceptance and retry the original change", async () => {
  const calls = [];
  let accepted = false;
  const drift = "skill 'cloudflare' changed outside skillsctl; re-add it to update the catalog checksum";
  const runner = async (_executable, args) => {
    calls.push(args);
    if (args.join(" ") === "skill accept cloudflare --yes") {
      accepted = true;
      return { code: 0, stdout: "Accepted current files and refreshed checksum\n", stderr: "" };
    }
    if (args[0] === "skill" && args[1] === "set") {
      return accepted
        ? {
            code: 0,
            stdout: JSON.stringify({
              target: "codex",
              selection_mode: "manual",
              skills: [],
              healthy: true
            }),
            stderr: ""
          }
        : { code: 1, stdout: "", stderr: drift };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const payload = {
    selection: "cloudflare",
    target: "codex"
  };
  const blocked = await controller.action("skills-disable", payload);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data.skillDriftRepairRequired, true);
  assert.equal(blocked.data.skillDriftName, "cloudflare");
  assert.equal(blocked.data.skillDriftScope, "local");

  const retried = await controller.action("skills-disable", {
    ...payload,
    acceptSkillDrift: { name: "cloudflare", scope: "local" }
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(calls.slice(-2), [
    ["skill", "accept", "cloudflare", "--yes"],
    ["skill", "set", "--target", "codex", "--disable", "cloudflare", "--yes", "--json"]
  ]);
});

test("Workspace Preset apply identifies drift in the isolated Skills runtime", async () => {
  const calls = [];
  let accepted = false;
  const drift = "skill 'cloudflare' changed outside skillsctl; re-add it to update the catalog checksum";
  const runner = async (_executable, args, options = {}) => {
    calls.push({ args, env: options.env || {} });
    if (args.join(" ") === "skill accept cloudflare --yes") {
      accepted = true;
      return { code: 0, stdout: "Accepted current files and refreshed checksum\n", stderr: "" };
    }
    return accepted
      ? { code: 0, stdout: '{"ok":true}', stderr: "" }
      : { code: 1, stdout: "", stderr: drift };
  };
  const remoteWorkspace = {
    selectionPlan: async () => ({}),
    materializePreset: async () => ({ prompt: {} }),
    runtimeEnvironment: async () => ({ SKILLSCTL_STORE: "/runtime/skills" }),
    writePrompt: async () => {},
    restorePrompt: async () => {}
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const blocked = await controller.action("apply", {
    preset: "daily",
    source: "cloud",
    target: "codex"
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data.skillDriftName, "cloudflare");
  assert.equal(blocked.data.skillDriftScope, "workspace");

  const retried = await controller.action("apply", {
    preset: "daily",
    source: "cloud",
    target: "codex",
    acceptSkillDrift: { name: "cloudflare", scope: "workspace" }
  });
  assert.equal(retried.ok, true);
  assert.equal(calls.at(-2).env.SKILLSCTL_STORE, "/runtime/skills");
});

test("Action boundary converts an otherwise thrown checksum diagnostic into a guided retry", async () => {
  const drift = "skill 'cloudflare' changed outside skillsctl; re-add it to update the catalog checksum";
  const runner = async () => ({ code: 1, stdout: "", stderr: "skills store not found" });
  const remoteWorkspace = {
    materializePreset: async () => { throw new Error(drift); },
    runtimeEnvironment: async () => ({ SKILLSCTL_STORE: "/runtime/skills" })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const result = await controller.action("apply", {
    preset: "daily",
    source: "cloud",
    target: "codex"
  });
  assert.equal(result.ok, false);
  assert.equal(result.data.skillDriftRepairRequired, true);
  assert.equal(result.data.skillDriftName, "cloudflare");
  assert.equal(result.data.skillDriftScope, "workspace");
});

test("Workspace MCP apply reports a retryable force-adoption conflict without forcing implicitly", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    if (args.join(" ") === "profile list") {
      return { code: 0, stdout: "daily\n", stderr: "" };
    }
    return {
      code: 1,
      stdout: "",
      stderr: "same-name MCP entries are not owned by mcpctl; re-run with --force to replace only those names"
    };
  };
  const remoteWorkspace = {
    materializeComponent: async () => ({ name: "daily", target: "codex" }),
    runtimeEnvironment: async () => ({ MCPCTL_STORE: "/runtime/mcp" })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const result = await controller.action("mcp-apply", {
    selection: "daily",
    target: "codex"
  });
  assert.equal(result.ok, false);
  assert.equal(result.data.forceRequired, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("--force"), false);
});

test("Workspace MCP apply offers and performs full local Store initialization", async () => {
  const calls = [];
  let materialized = 0;
  const runner = async (_executable, args, options = {}) => {
    calls.push({ args, env: options.env || {} });
    if (args.join(" ") === "profile list") {
      return { code: 1, stdout: "", stderr: "store not initialized: missing /local/mcp/catalog.json" };
    }
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  const remoteWorkspace = {
    materializeComponent: async () => {
      materialized += 1;
      return { name: "daily", target: "codex" };
    },
    withLocalChildCapability: async (_type, callback) => callback({
      remoteConfig: "/runtime/mcp-remote.json"
    })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const prompt = await controller.action("mcp-apply", {
    selection: "daily",
    target: "codex"
  });
  assert.equal(prompt.ok, false);
  assert.equal(prompt.data.localInitializationRequired, true);
  assert.equal(materialized, 0);

  const applied = await controller.action("mcp-apply", {
    selection: "daily",
    target: "codex",
    initializeLocal: true
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.data.initializedLocal, true);
  assert.equal(materialized, 1);
  assert.deepEqual(calls.slice(-2).map(({ args }) => args), [
    ["restore", "--remote-config", "/runtime/mcp-remote.json"],
    ["apply", "--target", "codex", "--profile", "daily"]
  ]);
});

test("Workspace MCP initialization resumes locally after force confirmation without restoring twice", async () => {
  const calls = [];
  let restored = false;
  const conflict = "same-name MCP entries are not owned by mcpctl; re-run with --force to replace only those names";
  const runner = async (_executable, args) => {
    calls.push(args);
    if (args.join(" ") === "profile list") {
      return restored
        ? { code: 0, stdout: "daily\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "store not initialized: missing /local/mcp/catalog.json" };
    }
    if (args[0] === "restore") {
      restored = true;
      return { code: 0, stdout: "restored\n", stderr: "" };
    }
    if (args[0] === "apply") {
      return args.includes("--force")
        ? { code: 0, stdout: "applied\n", stderr: "" }
        : { code: 1, stdout: "", stderr: conflict };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const remoteWorkspace = {
    materializeComponent: async () => ({ name: "daily", target: "codex" }),
    withLocalChildCapability: async (_type, callback) => callback({
      remoteConfig: "/runtime/mcp-remote.json"
    })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const blocked = await controller.action("mcp-apply", {
    selection: "daily",
    target: "codex",
    initializeLocal: true
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data.forceRequired, true);
  assert.equal(blocked.data.restoredLocalStore, true);

  const applied = await controller.action("mcp-apply", {
    selection: "daily",
    target: "codex",
    initializeLocal: true,
    force: true
  });
  assert.equal(applied.ok, true);
  assert.equal(calls.filter((args) => args[0] === "restore").length, 1);
  assert.deepEqual(calls.at(-1), [
    "apply", "--target", "codex", "--profile", "daily", "--force"
  ]);
});

test("Workspace Skills initialization releases isolated links before local apply", async () => {
  const calls = [];
  const runner = async (_executable, args, options = {}) => {
    calls.push({ args, env: options.env || {} });
    if (args.join(" ") === "list --json") {
      return { code: 1, stdout: "", stderr: "skills store not found: /local/skills" };
    }
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  const remoteWorkspace = {
    materializeComponent: async () => ({
      name: "frontend",
      target: "codex",
      skills: ["creative-frontend", "frontend-dev"]
    }),
    withLocalChildCapability: async (_type, callback) => callback({
      remoteConfig: "/runtime/skills-remote.json"
    }),
    runtimeEnvironment: async () => ({ SKILLSCTL_STORE: "/runtime/skills" })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const applied = await controller.action("skills-apply", {
    selection: "frontend",
    target: "codex",
    initializeLocal: true
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(calls.slice(-3).map(({ args }) => args), [
    ["restore", "--remote-config", "/runtime/skills-remote.json", "--yes"],
    ["skill", "set", "--target", "codex", "--disable", "creative-frontend", "--disable", "frontend-dev", "--yes"],
    ["apply", "--target", "codex", "--pack", "frontend", "--yes"]
  ]);
  assert.equal(calls.at(-2).env.SKILLSCTL_STORE, "/runtime/skills");
  assert.deepEqual(calls.at(-1).env, {});
});

test("Workspace Skills initialization resumes after staging checksum acceptance", async () => {
  const calls = [];
  let restored = false;
  let accepted = false;
  const drift = "skill 'cloudflare' changed outside skillsctl; re-add it to update the catalog checksum";
  const runner = async (_executable, args, options = {}) => {
    calls.push({ args, env: options.env || {} });
    if (args.join(" ") === "list --json") {
      return restored
        ? { code: 0, stdout: "[]", stderr: "" }
        : { code: 1, stdout: "", stderr: "skills store not found: /local/skills" };
    }
    if (args[0] === "restore") {
      restored = true;
      return { code: 0, stdout: "restored\n", stderr: "" };
    }
    if (args.join(" ") === "skill accept cloudflare --yes") {
      accepted = true;
      return { code: 0, stdout: "accepted\n", stderr: "" };
    }
    if (args[0] === "skill" && args[1] === "set") {
      return accepted
        ? { code: 0, stdout: "released\n", stderr: "" }
        : { code: 1, stdout: "", stderr: drift };
    }
    if (args[0] === "apply") return { code: 0, stdout: "applied\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  const remoteWorkspace = {
    materializeComponent: async () => ({
      name: "frontend",
      target: "codex",
      skills: ["frontend-dev"]
    }),
    withLocalChildCapability: async (_type, callback) => callback({
      remoteConfig: "/runtime/skills-remote.json"
    }),
    runtimeEnvironment: async () => ({ SKILLSCTL_STORE: "/runtime/skills" })
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const blocked = await controller.action("skills-apply", {
    selection: "frontend",
    target: "codex",
    initializeLocal: true
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.data.skillDriftScope, "workspace");

  const applied = await controller.action("skills-apply", {
    selection: "frontend",
    target: "codex",
    initializeLocal: true,
    acceptSkillDrift: { name: "cloudflare", scope: "workspace" }
  });
  assert.equal(applied.ok, true);
  assert.equal(calls.filter(({ args }) => args[0] === "restore").length, 1);
  assert.deepEqual(calls.at(-1).args, [
    "apply", "--target", "codex", "--pack", "frontend", "--yes"
  ]);
  assert.deepEqual(calls.at(-1).env, {});
});

test("process runner bounds hung children and honors refresh cancellation", async () => {
  const runner = createProcessRunner({ cwd: tmpdir(), timeoutMs: 30 });
  const timedOut = await runner(process.execPath, [
    "-e", "setInterval(() => {}, 1000)"
  ]);
  assert.equal(timedOut.code, 124);
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.stderr, /timed out/);

  const abortController = new AbortController();
  const pending = runner(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { signal: abortController.signal, timeoutMs: 2_000 }
  );
  abortController.abort();
  const aborted = await pending;
  assert.equal(aborted.code, 130);
  assert.equal(aborted.aborted, true);
});

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

test("MCP controller catalog keeps display metadata only and rejects unsafe names", () => {
  const catalog = normalizeMcpServerCatalog([{
    name: "exa",
    category: "search",
    description: "Search MCP",
    setup: "Set the referenced Secret before enabling.",
    variant_group: "search",
    command: ["never-render"],
    headers: { Authorization: "never-render" }
  }, {
    name: "../unsafe",
    description: "drop"
  }]);
  assert.deepEqual(catalog, [{
    name: "exa",
    category: "search",
    description: "Search MCP",
    setup: "Set the referenced Secret before enabling.",
    variant_group: "search",
    checked: false,
    ready: null,
    issues: [],
    check_details: ""
  }]);
  assert.equal(JSON.stringify(catalog).includes("never-render"), false);
});

test("Skills controller catalog keeps display metadata only and rejects unsafe names", () => {
  assert.deepEqual(normalizeSkillsCatalog([{
    name: "frontend-dev",
    description: "Frontend development",
    sha256: "a".repeat(64),
    files: ["never-render"]
  }, {
    name: "../unsafe",
    description: "drop"
  }]), [{
    name: "frontend-dev",
    description: "Frontend development",
    sha256: "a".repeat(64)
  }]);
});

test("local MCP catalog and target switch actions stay behind mcpctl", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    if (args.join(" ") === "server list --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: "exa",
          category: "search",
          description: "Search MCP",
          command: ["must-not-reach-the-tui"]
        }]),
        stderr: ""
      };
    }
    if (args.join(" ") === "server doctor --all --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          platform: "darwin",
          servers: [{ name: "exa", ready: true, issues: [], details: "exa\n  [ok] platform darwin" }]
        }),
        stderr: ""
      };
    }
    if (args.join(" ") === "current --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify({ target: "codex", profile: "custom", servers: [] }),
        stderr: ""
      };
    }
    if (args.join(" ") === "server set --target codex --disable exa --json") {
      return {
        code: 0,
        stdout: JSON.stringify({ target: "codex", profile: "custom", servers: [] }),
        stderr: ""
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  assert.deepEqual(await controller.localMcpServers("codex"), [{
    name: "exa",
    category: "search",
    description: "Search MCP",
    setup: "",
    variant_group: "",
    checked: true,
    ready: true,
    issues: [],
    check_details: "exa\n  [ok] platform darwin"
  }]);
  await controller.localMcpServers("codex");
  assert.equal(
    calls.filter(({ args }) => args.join(" ") === "server doctor --all --json").length,
    1
  );
  const disabled = await controller.action("mcp-disable", {
    selection: "exa",
    target: "codex"
  });
  assert.equal(disabled.ok, true);
  assert.match(disabled.detail, /target-specific override/);
  assert.deepEqual(calls.at(-1).args, ["server", "set", "--target", "codex", "--disable", "exa", "--json"]);
  await assert.rejects(() => controller.localMcpServers("pi"), /unsupported MCP target/);
  await assert.rejects(
    () => controller.action("mcp-enable", { selection: "../unsafe", target: "codex" }),
    /valid MCP server/
  );
});

test("MCP preflight, atomic batch, and named Profile save use targeted commands", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    const command = args.join(" ");
    if (command === "server doctor exa --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          schema: 1,
          servers: [{ name: "exa", ready: true, issues: [], details: "ready" }]
        }),
        stderr: ""
      };
    }
    if (command === "server preflight exa --target codex --json") {
      return { code: 0, stdout: '{"ready":true}', stderr: "" };
    }
    if (command === "current --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "profile",
          profile: "daily",
          servers: ["exa"]
        }),
        stderr: ""
      };
    }
    if (command === "server set --target codex --enable exa --disable fetch --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "manual",
          profile: "custom",
          servers: ["exa"]
        }),
        stderr: ""
      };
    }
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const preflight = await controller.localMcpPreflight("exa", "codex");
  assert.equal(preflight.ready, true);
  assert.match(preflight.detail, /passed platform/);

  const batch = await controller.action("mcp-batch", {
    target: "codex",
    changes: [{ name: "exa", enabled: true }, { name: "fetch", enabled: false }]
  });
  assert.equal(batch.ok, true);
  assert.deepEqual(calls.at(-1).args, [
    "server", "set", "--target", "codex", "--enable", "exa", "--disable", "fetch", "--json"
  ]);
  assert.equal(batch.data.state.profile, "custom");

  const saved = await controller.action("mcp-profile-save", {
    selection: "daily",
    target: "codex"
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(calls.slice(-3).map(({ args }) => args), [
    ["profile", "save", "daily", "--target", "codex"],
    ["apply", "--target", "codex", "--profile", "daily"],
    ["current", "--target", "codex", "--json"]
  ]);
  const backedUp = await controller.action("mcp-profile-upload", {
    selection: "daily",
    target: "codex"
  });
  assert.equal(backedUp.ok, true);
  assert.deepEqual(calls.at(-1).args, ["backup"]);
  assert.match(backedUp.detail, /No Secret value was printed/);
});

test("Skills dashboard and local switches use atomic target-scoped skillsctl commands", async () => {
  const calls = [];
  const runner = async (executable, args) => {
    calls.push({ executable, args });
    const command = args.join(" ");
    if (command === "list --json") {
      return {
        code: 0,
        stdout: JSON.stringify([{
          name: "frontend-dev",
          description: "Frontend development",
          sha256: "a".repeat(64),
          files: ["must-not-reach-tui"]
        }]),
        stderr: ""
      };
    }
    if (command.startsWith("current --target ")) {
      const target = args[2];
      return {
        code: 0,
        stdout: JSON.stringify({
          target,
          selection_mode: "pack",
          pack: "base",
          base_skills: [],
          skills: target === "codex" ? ["frontend-dev"] : [],
          drift: [],
          healthy: true
        }),
        stderr: ""
      };
    }
    if (command === "skill set --target codex --disable frontend-dev --yes --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "manual",
          base_pack: "base",
          base_skills: [],
          skills: [],
          drift: [],
          healthy: true
        }),
        stderr: ""
      };
    }
    if (command === "skill set --target codex --enable frontend-dev --disable backend-dev --yes --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "manual",
          base_pack: "base",
          base_skills: [],
          skills: ["frontend-dev"],
          drift: [],
          healthy: true
        }),
        stderr: ""
      };
    }
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const dashboard = await controller.localSkillsDashboard();
  assert.deepEqual(dashboard.catalog, [{
    name: "frontend-dev",
    description: "Frontend development",
    sha256: "a".repeat(64)
  }]);
  assert.deepEqual(dashboard.states.codex.skills, ["frontend-dev"]);

  const disabled = await controller.action("skills-disable", {
    selection: "frontend-dev",
    target: "codex"
  });
  assert.equal(disabled.ok, true);
  assert.deepEqual(calls.at(-1).args, [
    "skill", "set", "--target", "codex", "--disable", "frontend-dev", "--yes", "--json"
  ]);

  const batch = await controller.action("skills-batch", {
    target: "codex",
    changes: [
      { name: "frontend-dev", enabled: true },
      { name: "backend-dev", enabled: false }
    ]
  });
  assert.equal(batch.ok, true);
  assert.deepEqual(calls.at(-1).args, [
    "skill", "set", "--target", "codex", "--enable", "frontend-dev",
    "--disable", "backend-dev", "--yes", "--json"
  ]);

  const saved = await controller.action("skills-pack-save", {
    selection: "daily-pack",
    target: "codex"
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(calls.slice(-3).map(({ args }) => args), [
    ["pack", "save", "daily-pack", "--target", "codex", "--yes"],
    ["apply", "--target", "codex", "--pack", "daily-pack", "--yes"],
    ["current", "--target", "codex", "--json"]
  ]);
  const updated = await controller.action("skills-pack-update", {
    selection: "daily-pack",
    target: "codex"
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(calls.at(-3).args, [
    "pack", "save", "daily-pack", "--target", "codex", "--yes", "--force"
  ]);
  const backedUp = await controller.action("skills-pack-upload", {
    selection: "daily-pack",
    target: "codex"
  });
  assert.equal(backedUp.ok, true);
  assert.deepEqual(calls.at(-1).args, ["backup"]);
});

test("Prompt content is loaded only through an explicit local or Workspace preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-prompt-preview-"));
  const path = join(root, "personal.md");
  await writeFile(path, "Local preview body.\n", { mode: 0o600 });
  const runner = async (executable, args) => {
    if (controllerExecutableIs(executable, "promptctl") && args[0] === "path") {
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
    if (controllerExecutableIs(executable, "promptctl") && args[0] === "snippet") {
      return {
        code: 0,
        stdout: '[{"name":"review-code","path":"/snippets/review-code.md","state":"regular"}]',
        stderr: ""
      };
    }
    if (controllerExecutableIs(executable, "agentctl") && args.includes("status")) {
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
  assert.equal(
    calls.filter((args) => args.join(" ") === "doctor all --json").length,
    0
  );
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
    if (controllerExecutableIs(executable, "promptctl") && command === "snippet list --json") {
      return { code: 0, stdout: '[{"name":"review-code","path":"/snippets/review-code.md","state":"regular"}]', stderr: "" };
    }
    if (controllerExecutableIs(executable, "agentctl") && command === "status all --json") {
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
    if (controllerExecutableIs(executable, "agentctl") && command === "account status --json") {
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

test("Workspace hydration preserves active local Skills instead of runtime staging state", async () => {
  let runtimeInspected = false;
  const controller = createController({
    agentRoot: "/agent",
    runner: async () => {
      throw new Error("Workspace hydration must not run staged runtime diagnostics");
    },
    remoteWorkspace: {
      index: async () => ({
        mode: "workspace",
        store_id: "a".repeat(32),
        latest: { version: "v2" },
        presets: {}
      }),
      runtimeAvailability: async () => {
        runtimeInspected = true;
        return { skills: true, presets: true };
      }
    }
  });
  const local = {
    phase: "local",
    doctor: {
      healthy: true,
      targets: [{
        target: "codex",
        provider: { ok: true, data: {} },
        skills: {
          ok: true,
          data: {
            target: "codex",
            selection_mode: "pack",
            pack: "frontend",
            skills: ["creative-frontend", "design-app-icons", "frontend-dev", "gsap-motion"],
            healthy: true
          }
        }
      }]
    },
    doctorError: "",
    accounts: { active: {} },
    presets: {},
    presetSource: "local",
    workspaceConnection: {
      endpoint: "https://workspace.example.test",
      store_id: "a".repeat(32),
      configured: true
    }
  };
  const hydrated = await controller.hydrateSnapshot(local);
  const skills = hydrated.doctor.targets[0].skills.data;
  assert.equal(runtimeInspected, false);
  assert.equal(hydrated.phase, "workspace");
  assert.equal(skills.pack, "frontend");
  assert.equal(skills.skills.length, 4);
});

test("remote actions plan without writes and apply through the selected runtime", async () => {
  const calls = [];
  const writes = [];
  const runner = async (executable, args, options = {}) => {
    calls.push({ executable, args, env: options.env || {} });
    if (args.join(" ") === "list --json") {
      return { code: 0, stdout: "[]", stderr: "" };
    }
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

  const forcedMcp = await controller.action("mcp-apply", {
    selection: "frontend",
    target: "codex",
    force: true
  });
  assert.equal(forcedMcp.ok, true);
  assert.deepEqual(calls.at(-1).args, [
    "apply", "--target", "codex", "--profile", "frontend", "--force"
  ]);

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

test("Workspace Skill apply reuses an identical local Pack without crossing store ownership", async () => {
  const calls = [];
  const runner = async (executable, args, options = {}) => {
    calls.push({ executable, args, env: options.env || {} });
    if (args.join(" ") === "list --json") {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (args.join(" ") === "pack show frontend --target codex") {
      return {
        code: 0,
        stdout: JSON.stringify({
          pack: { name: "frontend" },
          target: "codex",
          resolved: ["creative-frontend", "frontend-dev"]
        }),
        stderr: ""
      };
    }
    if (args.join(" ") === "apply --target codex --pack frontend --yes") {
      return { code: 0, stdout: "Applied codex skill links\n", stderr: "" };
    }
    if (args.join(" ") === "current --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "pack",
          pack: "frontend",
          base_skills: ["creative-frontend", "frontend-dev"],
          skills: ["creative-frontend", "frontend-dev"],
          drift: [],
          healthy: true
        }),
        stderr: ""
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
  };
  const remoteWorkspace = {
    componentPlan: async () => ({
      type: "skills",
      name: "frontend",
      target: "codex",
      items: ["frontend-dev", "creative-frontend"],
      unit: "skills"
    }),
    materializeComponent: async () => {
      throw new Error("an identical Workspace Pack must not use the isolated runtime Store");
    }
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace });
  const applied = await controller.action("skills-apply", {
    selection: "frontend",
    target: "codex"
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.data.matchedLocalPack, true);
  assert.equal(applied.data.state.pack, "frontend");
  assert.match(applied.detail, /verified active with 2 Skills/);
  assert.deepEqual(calls.map(({ args }) => args), [
    ["list", "--json"],
    ["pack", "show", "frontend", "--target", "codex"],
    ["apply", "--target", "codex", "--pack", "frontend", "--yes"],
    ["current", "--target", "codex", "--json"]
  ]);
  assert.deepEqual(calls.at(-1).env, {});
});

test("Workspace Skill apply does not report success when the verified local Pack differs", async () => {
  const runner = async (_executable, args) => {
    if (args.join(" ") === "list --json") {
      return { code: 0, stdout: "[]", stderr: "" };
    }
    if (args.join(" ") === "pack show frontend --target codex") {
      return {
        code: 0,
        stdout: JSON.stringify({ resolved: ["creative-frontend", "frontend-dev"] }),
        stderr: ""
      };
    }
    if (args.join(" ") === "apply --target codex --pack frontend --yes") {
      return { code: 0, stdout: "Applied codex skill links\n", stderr: "" };
    }
    if (args.join(" ") === "current --target codex --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          target: "codex",
          selection_mode: "pack",
          pack: "daily-dev",
          skills: [],
          drift: [],
          healthy: true
        }),
        stderr: ""
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
  };
  const controller = createController({
    agentRoot: "/agent",
    runner,
    remoteWorkspace: {
      componentPlan: async () => ({
        type: "skills",
        name: "frontend",
        target: "codex",
        items: ["frontend-dev", "creative-frontend"],
        unit: "skills"
      }),
      materializeComponent: async () => {
        throw new Error("matching local Pack should not materialize the Workspace runtime");
      }
    }
  });
  const applied = await controller.action("skills-apply", {
    selection: "frontend",
    target: "codex"
  });
  assert.equal(applied.ok, false);
  assert.equal(applied.data.state.pack, "daily-dev");
  assert.match(applied.detail, /verification returned daily-dev with 0 Skills/);
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
    if (command === "proxy usage --summary --json") {
      return {
        code: 0,
        stdout: JSON.stringify({
          requests: 3,
          priced_requests: 3,
          unpriced_requests: 0,
          tokens: { input: 18680, output: 9, cache_read: 6912, cache_write: 0 },
          costs: { USD: "0.0699628" },
          service_tiers: {
            fast_requested: 3,
            fast_effective: 0,
            fast_downgraded: 3,
            transitions: { "fast->standard": 3 }
          },
          window: {
            from: "2026-08-14T00:00:00.000Z",
            to: "2026-08-14T00:02:00.000Z"
          }
        }),
        stderr: ""
      };
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
  assert.equal(dashboard.proxyUsage.costs.USD, "0.0699628");
  assert.equal(dashboard.proxyUsage.tokens.cache_read, 6912);
  assert.equal(dashboard.proxyUsage.service_tiers.fast_downgraded, 3);
  assert.equal(JSON.stringify(dashboard).includes("secret-value"), false);
});

test("Provider TUI proxy lifecycle actions use explicit safe agentctl commands", async () => {
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ status: "ok", attachment: { attached: false } }), stderr: "" };
  };
  const controller = createController({ agentRoot: "/agent", runner, remoteWorkspace: {} });
  const cases = [
    ["proxy-start", ["proxy", "start", "passthrough", "--target", "codex", "--yes", "--json"]],
    ["proxy-attach", ["proxy", "attach", "--yes", "--json"]],
    ["proxy-detach", ["proxy", "detach", "--yes", "--json"]],
    ["proxy-stop", ["proxy", "stop", "--yes", "--json"]]
  ];
  for (const [action, expected] of cases) {
    const result = await controller.action(action);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.at(-1), expected);
  }
  assert.match((await controller.action("proxy-start")).detail, /remains direct until Attach/);
  assert.match((await controller.action("proxy-attach")).detail, /official ChatGPT authentication/);
  assert.match((await controller.action("proxy-detach")).detail, /restored exactly/);
  assert.match((await controller.action("proxy-stop")).detail, /history remains/);
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
