import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteWorkspace } from "./remote-workspace.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultAgentRoot = resolve(
  process.env.SCRIPT_TOOLBOX_AGENT_ROOT || join(moduleDirectory, "..", "..")
);
const MAX_OUTPUT = 512 * 1024;

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

  async function runJson(script, args, label, env = {}) {
    return parseJsonOutput(await run(process.execPath, [script, ...args], { env }), label);
  }

  async function runExecutableJson(executable, args, label, env = {}) {
    return parseJsonOutput(await run(executable, args, { env }), label);
  }

  async function snapshot() {
    const remoteResult = remoteWorkspace.index({ refresh: true })
      .then((data) => ({ data, error: "" }))
      .catch((error) => ({ data: null, error: sanitizeOutput(error?.message || error) }));
    let [doctorResult, agentsResult, presetsResult, remote] = await Promise.all([
      runJson(orchestrator, ["doctor", "all", "--json"], "agentctl doctor"),
      runExecutableJson(agentctl, ["status", "all", "--json"], "agentctl status"),
      runJson(orchestrator, ["preset", "list", "--json"], "preset list"),
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
      workspace: remote.data,
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
    return `${plan.name} for ${plan.target}: ${plan.items.length} ${plan.unit}\n${plan.items.join(", ") || "none"}\nNo remote catalog was written locally.`;
  }

  async function remoteComponentAction(actionName, type, name, target) {
    if (actionName.endsWith("-plan")) {
      const plan = await remoteWorkspace.componentPlan(type, name, target);
      return { ok: true, data: plan, detail: planDetail(plan) };
    }
    const selection = await remoteWorkspace.materializeComponent(type, name, target);
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
    preset = "",
    selection = "",
    source = "local",
    target = "codex"
  } = {}) {
    const component = /^(mcp|skills|prompts)-(plan|apply)$/.exec(actionName);
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

  return { snapshot, action, remoteCatalog };
}
