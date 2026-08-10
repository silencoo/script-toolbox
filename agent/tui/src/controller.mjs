import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteWorkspace } from "./remote-workspace.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultAgentRoot = resolve(
  process.env.SCRIPT_TOOLBOX_AGENT_ROOT || join(moduleDirectory, "..", "..")
);
const MAX_OUTPUT = 512 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const AGENT_CLIENTS = new Set(["claude", "codex", "opencode", "pi"]);
const PROMPT_CLIENTS = new Set(["claude", "codex"]);

export function sanitizeOutput(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/(["']?\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .trim();
}

export function parseJsonOutput(result, label) {
  const output = String(result.stdout || "").trim();
  if (output) {
    try {
      return { ok: result.code === 0, data: JSON.parse(output), error: result.code === 0 ? "" : sanitizeOutput(result.stderr) };
    } catch {
      // Fall through to the bounded, sanitized diagnostic below.
    }
  }
  const detail = sanitizeOutput(result.stderr || result.stdout) || `${label} exited with code ${result.code}`;
  return { ok: false, data: null, error: detail.split("\n").slice(0, 8).join("\n") };
}

export function normalizeSnippetMetadata(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry.name === "string").map((entry) => ({
    name: entry.name,
    path: typeof entry.path === "string" ? entry.path : "",
    state: typeof entry.state === "string" ? entry.state : ""
  }));
}

export async function readPromptPreviewFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("Prompt preview path is invalid.");
  }
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Prompt file does not exist: ${path}`);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Prompt preview requires a regular file: ${path}`);
  }
  if (details.size > MAX_PROMPT_BYTES) {
    throw new Error("Prompt file exceeds the 2 MB preview limit.");
  }
  const bytes = await readFile(path);
  if (bytes.length > MAX_PROMPT_BYTES) {
    throw new Error("Prompt file exceeds the 2 MB preview limit.");
  }
  if (bytes.includes(0)) throw new Error("Prompt file contains unsupported NUL bytes.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Prompt file is not valid UTF-8.");
  }
}

export function createProcessRunner({ cwd = defaultAgentRoot, environment = process.env } = {}) {
  return function run(executable, args, { env = {} } = {}) {
    return new Promise((resolvePromise) => {
      const child = spawn(executable, args, {
        cwd,
        env: { ...environment, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      const append = (current, chunk) => {
        if (current.length >= MAX_OUTPUT) {
          overflow = true;
          return current;
        }
        const next = current + chunk.toString("utf8");
        if (next.length > MAX_OUTPUT) overflow = true;
        return next.slice(0, MAX_OUTPUT);
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.on("error", (error) => resolvePromise({ code: 127, stdout, stderr: error.message }));
      child.on("close", (code) => resolvePromise({
        code: Number.isInteger(code) ? code : 1,
        stdout,
        stderr: overflow ? `${stderr}\n[output truncated]` : stderr
      }));
    });
  };
}

export function createController({
  agentRoot = defaultAgentRoot,
  runner,
  remoteWorkspace = createRemoteWorkspace()
} = {}) {
  const run = runner || createProcessRunner({ cwd: agentRoot });
  const orchestrator = join(agentRoot, "agentctl", "orchestrator-client.mjs");
  const agentctl = join(agentRoot, "agentctl", "agentctl");
  const tools = {
    mcp: join(agentRoot, "mcpctl", "mcpctl"),
    skills: join(agentRoot, "skillsctl", "skillsctl"),
    prompts: join(agentRoot, "promptctl", "promptctl")
  };

  function agentctlCommand(args) {
    return process.platform === "win32"
      ? { executable: "bash", args: [agentctl, ...args] }
      : { executable: agentctl, args };
  }

  async function runJson(script, args, label, env = {}) {
    return parseJsonOutput(await run(process.execPath, [script, ...args], { env }), label);
  }

  async function runExecutableJson(executable, args, label, env = {}) {
    return parseJsonOutput(await run(executable, args, { env }), label);
  }

  async function runAgentctlJson(args, label) {
    const command = agentctlCommand(args);
    return runExecutableJson(command.executable, command.args, label);
  }

  async function snapshot() {
    const remoteResult = remoteWorkspace.index({ refresh: true })
      .then((data) => ({ data, connection: data, error: "" }))
      .catch(async (error) => {
        let connection = null;
        if (typeof remoteWorkspace.connection === "function") {
          connection = await remoteWorkspace.connection().catch(() => null);
        }
        return { data: null, connection, error: sanitizeOutput(error?.message || error) };
      });
    let [doctorResult, agentsResult, presetsResult, snippetsResult, remote] = await Promise.all([
      runJson(orchestrator, ["doctor", "all", "--json"], "agentctl doctor"),
      runAgentctlJson(["status", "all", "--json"], "agentctl status"),
      runJson(orchestrator, ["preset", "list", "--json"], "preset list"),
      runExecutableJson(tools.prompts, ["snippet", "list", "--json"], "snippet list"),
      remoteResult
    ]);
    if (remote.data && typeof remoteWorkspace.runtimeAvailability === "function") {
      try {
        const availability = await remoteWorkspace.runtimeAvailability();
        const env = await remoteWorkspace.runtimeEnvironment();
        if (availability.presets) {
          const runtimeDoctor = await runJson(orchestrator, ["doctor", "all", "--json"],
            "Workspace runtime doctor", env);
          if (runtimeDoctor.data) doctorResult = runtimeDoctor;
        } else if (doctorResult.data?.targets && (availability.mcp || availability.skills)) {
          await Promise.all(doctorResult.data.targets.map(async (report) => {
            if (availability.mcp) {
              const result = await runExecutableJson(tools.mcp,
                ["current", "--target", report.target, "--json"], "Workspace MCP current", env);
              report.mcp = { ok: result.ok, data: result.data, error: result.error };
            }
            if (availability.skills) {
              const result = await runExecutableJson(tools.skills,
                ["current", "--target", report.target, "--json"], "Workspace Skills current", env);
              report.skills = { ok: result.ok, data: result.data, error: result.error };
            }
          }));
        }
      } catch {
        // Local diagnostics remain useful if no selective runtime exists yet.
      }
    }
    const cloudPresets = remote.data?.presets;
    return {
      updatedAt: new Date().toISOString(),
      doctor: doctorResult.data,
      doctorError: doctorResult.error,
      agents: agentsResult.data,
      agentsError: agentsResult.error,
      presets: cloudPresets || presetsResult.data || {},
      presetsError: cloudPresets ? "" : presetsResult.error,
      presetSource: cloudPresets ? "cloud" : "local",
      snippets: normalizeSnippetMetadata(snippetsResult.data),
      snippetsError: snippetsResult.error,
      workspace: remote.data,
      workspaceConnection: remote.connection,
      workspaceError: remote.error
    };
  }

  async function remoteCatalog(type, target, options = {}) {
    try {
      return { ok: true, items: await remoteWorkspace.catalog(type, target, options), error: "" };
    } catch (error) {
      return { ok: false, items: [], error: sanitizeOutput(error?.message || error) };
    }
  }

  async function promptPreview({ source = "local", selection = "", target = "codex" } = {}) {
    if (!PROMPT_CLIENTS.has(target)) throw new Error(`unsupported Prompt target: ${target}`);
    if (!selection) throw new Error("No Prompt profile is selected.");
    if (source === "cloud") {
      if (typeof remoteWorkspace.promptDocument !== "function") {
        throw new Error("Workspace Prompt preview is unavailable.");
      }
      const document = await remoteWorkspace.promptDocument(selection, target);
      return {
        source,
        name: document.name,
        target: document.target,
        path: "",
        content: document.content
      };
    }
    if (source !== "local") throw new Error(`unsupported Prompt preview source: ${source}`);
    const result = await runExecutableJson(
      tools.prompts,
      ["path", target, "--name", selection, "--json"],
      "Prompt path"
    );
    if (!result.ok) throw new Error(result.error || "Prompt path could not be resolved.");
    const path = result.data?.[target];
    return {
      source,
      name: selection,
      target,
      path,
      content: await readPromptPreviewFile(path)
    };
  }

  function planDetail(plan) {
    if (plan.preset) {
      return [
        `${plan.name} for ${plan.target}`,
        `MCP ${plan.mcp.name}: ${plan.mcp.servers.length} server(s)`,
        `Skills ${plan.skills.name}: ${plan.skills.skills.length} skill(s)`,
        `Prompt ${plan.prompt.name}: ${plan.prompt.action}`,
        "No remote catalog was written locally."
      ].join("\n");
    }
    if (plan.type === "prompts") {
      return `${plan.name} for ${plan.target}: ${plan.action} ${plan.path}\nNo file was changed.`;
    }
    if (plan.type === "snippets") {
      return `${plan.name}: ${plan.action} ${plan.path}\nSnippet content remains hidden; no file was changed.`;
    }
    return `${plan.name} for ${plan.target}: ${plan.items.length} ${plan.unit}\n${plan.items.join(", ") || "none"}\nNo remote catalog was written locally.`;
  }

  async function remoteComponentAction(actionName, type, name, target) {
    if (actionName.endsWith("-plan")) {
      const plan = await remoteWorkspace.componentPlan(type, name, target);
      return { ok: true, data: plan, detail: planDetail(plan) };
    }
    const selection = await remoteWorkspace.materializeComponent(type, name, target);
    if (type === "snippets") {
      await remoteWorkspace.writeSnippet(selection);
      return {
        ok: true,
        data: { type, name },
        detail: `${name} copied from Workspace to the local Snippets library; content remains hidden`
      };
    }
    const env = await remoteWorkspace.runtimeEnvironment();
    let promptWritten = false;
    try {
      if (type === "prompts") {
        await remoteWorkspace.writePrompt(selection);
        promptWritten = true;
      }
      const args = type === "mcp"
        ? ["apply", "--target", target, "--profile", name]
        : type === "skills"
          ? ["apply", "--target", target, "--pack", name, "--yes"]
          : ["apply", "--target", target, "--profile", name, "--yes"];
      const result = await run(tools[type], args, { env });
      if (result.code !== 0 && promptWritten) await remoteWorkspace.restorePrompt(selection);
      return {
        ok: result.code === 0,
        data: { type, name, target },
        detail: result.code === 0
          ? `${name} applied from Workspace; start a new ${target} session`
          : sanitizeOutput(result.stderr || result.stdout) || `Action failed with code ${result.code}`
      };
    } catch (error) {
      if (promptWritten) await remoteWorkspace.restorePrompt(selection).catch(() => {});
      throw error;
    }
  }

  async function remotePresetAction(actionName, preset, target) {
    if (actionName === "plan") {
      const plan = await remoteWorkspace.selectionPlan(preset, target);
      return { ok: true, data: plan, detail: planDetail(plan) };
    }
    const selection = await remoteWorkspace.materializePreset(preset, target);
    const env = await remoteWorkspace.runtimeEnvironment();
    let promptWritten = false;
    try {
      await remoteWorkspace.writePrompt(selection.prompt);
      promptWritten = true;
      const result = await run(process.execPath, [orchestrator, "preset", "apply", preset,
        "--target", target, "--yes", "--json"], { env });
      const parsed = parseJsonOutput(result, "remote preset apply");
      if (result.code !== 0 && promptWritten) await remoteWorkspace.restorePrompt(selection.prompt);
      return {
        ok: result.code === 0,
        data: parsed.data,
        detail: result.code === 0
          ? "configuration applied from Workspace; start a new agent session"
          : sanitizeOutput(result.stderr || result.stdout) || `Action failed with code ${result.code}`
      };
    } catch (error) {
      if (promptWritten) await remoteWorkspace.restorePrompt(selection.prompt).catch(() => {});
      throw error;
    }
  }

  async function action(actionName, {
    agent = "",
    preset = "",
    selection = "",
    source = "local",
    target = "codex"
  } = {}) {
    if (actionName === "agent-providers" || actionName === "agent-uninstall") {
      if (!AGENT_CLIENTS.has(agent)) throw new Error(`unsupported agent client: ${agent}`);
      const args = actionName === "agent-providers"
        ? ["providers", agent]
        : ["uninstall", agent, "--yes"];
      const command = agentctlCommand(args);
      const result = await run(command.executable, command.args);
      return {
        ok: result.code === 0,
        data: { agent },
        detail: sanitizeOutput(result.stdout || result.stderr) ||
          (result.code === 0 ? "Done" : `Action failed with code ${result.code}`)
      };
    }
    if (actionName === "snippet-copy") {
      const result = await run(tools.prompts, ["snippet", "copy", selection]);
      return {
        ok: result.code === 0,
        data: { name: selection },
        detail: result.code === 0
          ? `${selection} copied to the clipboard; content remains hidden`
          : sanitizeOutput(result.stderr || result.stdout) || `Action failed with code ${result.code}`
      };
    }
    const component = /^(mcp|skills|prompts|snippets)-(plan|apply)$/.exec(actionName);
    if (component) return remoteComponentAction(actionName, component[1], selection, target);
    if (source === "cloud" && (actionName === "plan" || actionName === "apply")) {
      return remotePresetAction(actionName, preset, target);
    }
    const args = ["preset"];
    if (actionName === "plan" || actionName === "apply") {
      args.push(actionName, preset, "--target", target);
      if (actionName === "apply") args.push("--yes");
    } else if (actionName === "rollback") {
      args.push("rollback", "--target", target, "--yes");
    } else if (actionName === "push" || actionName === "pull") {
      args.push(actionName, "--yes");
    } else {
      throw new Error(`unsupported TUI action: ${actionName}`);
    }
    args.push("--json");
    const env = source === "cloud" ? await remoteWorkspace.runtimeEnvironment() : {};
    const result = await run(process.execPath, [orchestrator, ...args], { env });
    const parsed = parseJsonOutput(result, `preset ${actionName}`);
    let successDetail = "Done";
    if (actionName === "plan") successDetail = "all component preflight checks passed";
    if (actionName === "apply") successDetail = "configuration applied; start a new agent session";
    if (actionName === "rollback") successDetail = "previous selection restored; start a new agent session";
    if (actionName === "push") {
      successDetail = `${parsed.data?.presets?.length || 0} preset(s) pushed${parsed.data?.version ? ` as ${parsed.data.version}` : ""}`;
    }
    if (actionName === "pull") successDetail = `${parsed.data?.presets?.length || 0} preset(s) pulled`;
    return {
      ok: result.code === 0,
      data: parsed.data,
      detail: result.code === 0 ? successDetail :
        sanitizeOutput(result.stderr || result.stdout) || `Action failed with code ${result.code}`
    };
  }

  function interactiveCommand(agent) {
    if (!AGENT_CLIENTS.has(agent)) throw new Error(`unsupported agent client: ${agent}`);
    return agentctlCommand(["setup", agent]);
  }

  return { snapshot, action, interactiveCommand, promptPreview, remoteCatalog };
}
