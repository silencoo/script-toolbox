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
const WORKSPACE_RETRY_DELAY_MS = 250;
const AGENT_CLIENTS = new Set(["claude", "codex", "opencode", "pi"]);
const PROMPT_CLIENTS = new Set(["claude", "codex"]);

function transientWorkspaceError(error) {
  return /could not reach|request timed out|HTTP (?:408|425|429|5\d\d)\b/i
    .test(String(error?.message || error));
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

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
  let cachedWorkspace = null;
  let workspaceLastConnectedAt = "";
  let workspaceLastError = "";
  let workspaceFailureCount = 0;

  async function refreshWorkspaceIndex() {
    try {
      return await remoteWorkspace.index({ refresh: true });
    } catch (error) {
      if (!transientWorkspaceError(error)) throw error;
      await wait(WORKSPACE_RETRY_DELAY_MS);
      return remoteWorkspace.index({ refresh: true });
    }
  }

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

  async function providerDashboard(target = "codex") {
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Provider target: ${target}`);
    const [providerStatus, providerList, failover, pricing, proxy] = await Promise.all([
      runAgentctlJson(["provider", "status", "--json"], "provider status"),
      runAgentctlJson(["provider", "list", "--target", target, "--json"], "provider list"),
      runAgentctlJson(["failover", "status", "--json"], "failover status"),
      runAgentctlJson(["pricing", "status", "--json"], "pricing status"),
      runAgentctlJson(["proxy", "status", "--json"], "proxy status")
    ]);
    const status = providerStatus.data || {};
    const platform = status.platform || process.platform;
    const profiles = Array.isArray(providerList.data) ? providerList.data : [];
    const errors = [
      ["Provider status", providerStatus],
      ["Provider catalog", providerList],
      ["Failover", failover],
      ["Pricing", pricing],
      ["Proxy", proxy]
    ].filter(([, result]) => !result.ok && !result.data)
      .map(([label, result]) => `${label}: ${result.error}`);
    return {
      schema: 1,
      target,
      platform,
      profiles,
      status,
      failover: failover.data || { status: "unavailable", routes: 0 },
      pricing: pricing.data || { status: "unavailable", rates: 0 },
      proxy: proxy.data || { status: "unavailable", running: false },
      errors
    };
  }

  async function localSnapshot() {
    const connectionPromise = typeof remoteWorkspace.connection === "function"
      ? remoteWorkspace.connection()
          .then((data) => ({ data, error: "" }))
          .catch((error) => ({ data: null, error: sanitizeOutput(error?.message || error) }))
      : Promise.resolve({ data: null, error: "remote configuration not found" });
    const [doctorResult, agentsResult, presetsResult, snippetsResult, accountsResult, connectionResult] =
      await Promise.all([
        runJson(orchestrator, ["doctor", "all", "--local", "--json"], "local agentctl doctor"),
        runAgentctlJson(["status", "all", "--json"], "agentctl status"),
        runJson(orchestrator, ["preset", "list", "--json"], "preset list"),
        runExecutableJson(tools.prompts, ["snippet", "list", "--json"], "snippet list"),
        runAgentctlJson(["account", "status", "--json"], "Codex account status"),
        connectionPromise
      ]);
    const accounts = accountsResult.data?.kind === "agentctl-codex-account-store"
      ? accountsResult.data
      : {
          schema: 1,
          kind: "agentctl-codex-account-store",
          active: { status: "unavailable", official_login: false, saved_as: null },
          account_count: 0,
          accounts: []
        };
    const accountLabel = typeof accounts.active?.saved_as === "string"
      ? accounts.active.saved_as
      : "";
    const agents = Array.isArray(agentsResult.data)
      ? agentsResult.data.map((agent) => agent?.client === "codex" && agent.identity && accountLabel
        ? { ...agent, identity: { ...agent.identity, account: accountLabel } }
        : agent)
      : agentsResult.data;
    const doctor = doctorResult.data ? structuredClone(doctorResult.data) : doctorResult.data;
    const codexReport = doctor?.targets?.find((report) => report.target === "codex");
    if (codexReport?.provider?.data?.identity && accountLabel) {
      codexReport.provider.data.identity.account = accountLabel;
    }
    const workspaceConfigured = Boolean(connectionResult.data?.configured);
    if (!workspaceConfigured) {
      cachedWorkspace = null;
      workspaceLastConnectedAt = "";
      workspaceLastError = "";
      workspaceFailureCount = 0;
    }
    return {
      updatedAt: new Date().toISOString(),
      phase: "local",
      doctor,
      doctorError: doctorResult.error,
      agents,
      agentsError: agentsResult.error,
      accounts,
      accountsError: accountsResult.ok ? "" : accountsResult.error,
      presets: presetsResult.data || {},
      presetsError: presetsResult.error,
      presetSource: "local",
      snippets: normalizeSnippetMetadata(snippetsResult.data),
      snippetsError: snippetsResult.error,
      workspace: cachedWorkspace ? structuredClone(cachedWorkspace) : null,
      workspaceConnection: connectionResult.data,
      workspaceLoading: workspaceConfigured,
      workspaceError: workspaceConfigured ? workspaceLastError : connectionResult.error,
      workspaceStale: Boolean(cachedWorkspace && workspaceLastError),
      workspaceLastConnectedAt,
      workspaceFailureCount
    };
  }

  async function hydrateSnapshot(local) {
    const remoteResult = refreshWorkspaceIndex()
      .then((data) => ({ data, connection: data, error: "", fresh: true }))
      .catch((error) => ({
        data: cachedWorkspace ? structuredClone(cachedWorkspace) : null,
        connection: local.workspaceConnection,
        error: sanitizeOutput(error?.message || error),
        fresh: false
      }));
    let [remote, doctorResult] = await Promise.all([
      remoteResult,
      runJson(orchestrator, ["doctor", "all", "--json"], "agentctl doctor")
    ]);
    if (!doctorResult.data) {
      doctorResult = { data: local.doctor, error: local.doctorError };
    }
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
    const activeAccount = local.accounts?.active?.saved_as;
    const hydratedCodex = doctorResult.data?.targets?.find((report) => report.target === "codex");
    if (hydratedCodex?.provider?.data?.identity && activeAccount) {
      hydratedCodex.provider.data.identity.account = activeAccount;
    }
    if (remote.fresh) {
      cachedWorkspace = structuredClone(remote.data);
      workspaceLastConnectedAt = new Date().toISOString();
      workspaceLastError = "";
      workspaceFailureCount = 0;
    } else {
      workspaceLastError = remote.error;
      workspaceFailureCount += 1;
    }
    const cloudPresets = remote.data?.presets;
    return {
      ...local,
      updatedAt: new Date().toISOString(),
      phase: "workspace",
      doctor: doctorResult.data,
      doctorError: doctorResult.error,
      presets: cloudPresets || local.presets || {},
      presetsError: cloudPresets ? "" : local.presetsError,
      presetSource: cloudPresets ? "cloud" : "local",
      workspace: remote.data,
      workspaceConnection: remote.connection,
      workspaceLoading: false,
      workspaceError: remote.error,
      workspaceStale: Boolean(remote.data && !remote.fresh),
      workspaceLastConnectedAt,
      workspaceFailureCount
    };
  }

  async function snapshot() {
    const local = await localSnapshot();
    return hydrateSnapshot(local);
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

  function providerPlanDetail(plan, source) {
    const entries = Array.isArray(plan?.plans) ? plan.plans : [];
    const selected = entries[0] || {};
    const sourceLabel = source === "cloud" ? "Workspace" : source === "builtin" ? "Built-in" : "Local";
    return [
      `${plan?.profile || selected.profile || "Provider"} for ${selected.target_label || selected.target || "target"} · ${sourceLabel}`,
      `State: ${selected.enabled === false ? "disabled" : selected.ready ? "ready" : "blocked"}`,
      `Protocol: ${selected.protocol || "unknown"}`,
      `Endpoint: ${selected.endpoint || "unknown"}`,
      `Model: ${selected.requested_model || "unknown"} -> ${selected.outbound_model || "unknown"}`,
      `Context: ${selected.context?.label || "Client default"}`,
      `Secret: ${selected.auth?.secret || "none"} (${selected.auth?.present ? "ready" : "missing"})`,
      ...(selected.official_identity
        ? ["Official Identity: preserve current ChatGPT login; Provider does not manage auth.json"]
        : []),
      ...(selected.issue ? [`Blocked by: ${selected.issue}`] : []),
      "No client file was changed."
    ].join("\n");
  }

  async function providerAction(actionName, profile, target, source) {
    if (!profile) throw new Error("No Provider profile is selected.");
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Provider target: ${target}`);
    if (!["builtin", "local", "cloud"].includes(source)) throw new Error(`unsupported Provider source: ${source}`);
    const operation = actionName === "provider-apply"
      ? source === "cloud" ? "apply" : "use"
      : "plan";
    const execute = async (paths = null) => {
      const args = ["provider", operation, profile, "--target", target, "--json"];
      if (paths) args.push("--store", paths.storePath, "--secrets", paths.secretsPath);
      if (["apply", "use"].includes(operation)) args.push("--yes");
      return runAgentctlJson(args, `provider ${operation}`);
    };
    const result = source === "cloud"
      ? await remoteWorkspace.withProviderFiles(profile, target, execute)
      : await execute();
    const detail = result.data
      ? providerPlanDetail(result.data, source)
      : result.error || `Provider ${operation} failed.`;
    return {
      ok: result.ok,
      data: result.data,
      detail: ["apply", "use"].includes(operation) && result.ok
        ? `${profile} applied from ${source === "cloud" ? "Workspace" : source === "builtin" ? "the built-in catalog" : "the local catalog"} to ${target}; start a new agent session`
        : detail
    };
  }

  async function providerSync(actionName, profile) {
    if (!profile) throw new Error("No Provider profile is selected.");
    const direction = actionName === "provider-sync-push" ? "push" : "pull";
    const result = await runAgentctlJson(
      ["workspace", "agent", direction, "--profile", profile, "--yes", "--json"],
      `Workspace agent ${direction}`
    );
    const secretCount = result.data?.secrets_copied || 0;
    return {
      ok: result.ok,
      data: result.data,
      detail: result.ok
        ? `${direction === "push" ? "Used the local" : "Used the Workspace"} '${profile}' profile ${direction === "push" ? "in encrypted Workspace" : "in the local catalog"}; ${secretCount} referenced Secret value(s) copied without being printed. Every other profile and catalog was preserved.`
        : result.error || `Workspace agent ${direction} failed.`
    };
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
    if (actionName === "provider-plan" || actionName === "provider-apply") {
      return providerAction(actionName, selection, target, source);
    }
    if (actionName === "provider-sync-push" || actionName === "provider-sync-pull") {
      return providerSync(actionName, selection);
    }
    if (actionName === "account-use" || actionName === "account-delete") {
      if (!selection) throw new Error("No Codex account is selected.");
      const operation = actionName === "account-use" ? "use" : "delete";
      const result = await runAgentctlJson(
        ["account", operation, selection, "--yes", "--json"],
        `Codex account ${operation}`
      );
      return {
        ok: result.ok,
        data: result.data,
        detail: result.ok
          ? operation === "use"
            ? `${selection} is now the active Codex official account; inference Provider is unchanged; start a new Codex session`
            : `${selection} was removed from the saved account Store; live auth is unchanged`
          : result.error || `Codex account ${operation} failed.`
      };
    }
    if (actionName === "agent-uninstall") {
      if (!AGENT_CLIENTS.has(agent)) throw new Error(`unsupported agent client: ${agent}`);
      const args = ["uninstall", agent, "--yes"];
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

  return {
    snapshot,
    localSnapshot,
    hydrateSnapshot,
    action,
    promptPreview,
    providerDashboard,
    remoteCatalog
  };
}
