import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bashScriptCommand } from "../../platform-command.mjs";
import { createRemoteWorkspace } from "./remote-workspace.mjs";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultAgentRoot = resolve(
  process.env.SCRIPT_TOOLBOX_AGENT_ROOT || join(moduleDirectory, "..", "..")
);
const MAX_OUTPUT = 512 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 20_000;
const PROCESS_KILL_GRACE_MS = 1_000;
const WORKSPACE_RETRY_DELAY_MS = 250;
const MCP_READINESS_CACHE_MS = 5 * 60 * 1000;
const AGENT_CLIENTS = new Set(["claude", "codex", "opencode", "pi"]);
const MCP_CLIENTS = new Set(["claude", "codex", "opencode"]);
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
    .replace(/(["']?\b(?:(?:x[_-])?api[_-]?key|key|client[_-]?secret|private[_-]?key|subscription[_-]?key|auth[_-]?token|access[_-]?token|token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .trim();
}

export function mcpApplyNeedsForce(value) {
  return /same-name MCP entries are not owned by mcpctl; re-run with --force to replace only those names/i
    .test(String(value || ""));
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

export function normalizeMcpServerCatalog(value, doctorReport = null) {
  if (!Array.isArray(value)) return [];
  const checks = new Map(
    Array.isArray(doctorReport?.servers)
      ? doctorReport.servers
          .filter((entry) => entry && typeof entry.name === "string")
          .map((entry) => [entry.name, entry])
      : []
  );
  const text = (entry, field, limit) => typeof entry[field] === "string"
    ? sanitizeOutput(entry[field]).slice(0, limit)
    : "";
  return value
    .filter((entry) => entry && typeof entry.name === "string" && /^[A-Za-z0-9._-]+$/.test(entry.name))
    .map((entry) => {
      const check = checks.get(entry.name);
      return {
        name: entry.name,
        category: text(entry, "category", 80),
        description: text(entry, "description", 500),
        setup: text(entry, "setup", 1000),
        variant_group: text(entry, "variant_group", 128),
        checked: Boolean(check),
        ready: check ? check.ready === true : null,
        issues: Array.isArray(check?.issues)
          ? check.issues.map((issue) => sanitizeOutput(issue).slice(0, 240)).filter(Boolean).slice(0, 8)
          : [],
        check_details: text(check || {}, "details", 1600)
      };
    });
}

export function normalizeSkillsCatalog(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.name === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      description: typeof entry.description === "string"
        ? sanitizeOutput(entry.description).slice(0, 500)
        : ""
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

export function createProcessRunner({
  cwd = defaultAgentRoot,
  environment = process.env,
  timeoutMs: defaultTimeoutMs = PROCESS_TIMEOUT_MS
} = {}) {
  return function run(executable, args, {
    env = {},
    signal,
    timeoutMs = defaultTimeoutMs
  } = {}) {
    return new Promise((resolvePromise) => {
      if (signal?.aborted) {
        resolvePromise({ code: 130, stdout: "", stderr: "operation cancelled", aborted: true });
        return;
      }
      const child = spawn(executable, args, {
        cwd,
        env: { ...environment, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32"
      });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let killTimer;
      let timer;
      const sendSignal = (signalName) => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signalName);
            return;
          } catch {
            // The process may have exited between the state check and signal.
          }
        }
        try { child.kill(signalName); } catch {}
      };
      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        sendSignal("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) sendSignal("SIGKILL");
        }, PROCESS_KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(result);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      // The signal can flip between the pre-spawn check and listener setup.
      if (signal?.aborted) onAbort();
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs);
        timer.unref?.();
      }
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
      child.on("error", (error) => finish({ code: 127, stdout, stderr: error.message }));
      child.on("close", (code) => finish({
        code: timedOut ? 124 : aborted ? 130 : Number.isInteger(code) ? code : 1,
        stdout,
        stderr: [
          stderr,
          overflow ? "[output truncated]" : "",
          timedOut ? `process timed out after ${timeoutMs} ms` : "",
          aborted ? "operation cancelled" : ""
        ].filter(Boolean).join("\n"),
        timedOut,
        aborted
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
  let mcpReadinessCache = { checkedAt: 0, data: null, pending: null };

  async function refreshWorkspaceIndex() {
    try {
      return await remoteWorkspace.index({ refresh: true });
    } catch (error) {
      if (!transientWorkspaceError(error)) throw error;
      await wait(WORKSPACE_RETRY_DELAY_MS);
      return remoteWorkspace.index({ refresh: true });
    }
  }

  function controllerCommand(executable, args) {
    return bashScriptCommand(executable, args);
  }

  async function runJson(script, args, label, env = {}, runOptions = {}) {
    return parseJsonOutput(
      await run(process.execPath, [script, ...args], { env, ...runOptions }),
      label
    );
  }

  async function runExecutableJson(executable, args, label, env = {}, runOptions = {}) {
    return parseJsonOutput(await run(executable, args, { env, ...runOptions }), label);
  }

  async function runController(executable, args, env = {}) {
    const command = controllerCommand(executable, args);
    return run(command.executable, command.args, { env });
  }

  async function runControllerJson(executable, args, label, env = {}, runOptions = {}) {
    const command = controllerCommand(executable, args);
    return runExecutableJson(command.executable, command.args, label, env, runOptions);
  }

  async function runAgentctlJson(args, label, runOptions = {}) {
    return runControllerJson(agentctl, args, label, {}, runOptions);
  }

  async function providerDashboard(target = "codex") {
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Provider target: ${target}`);
    const [providerStatus, providerList, failover, pricing, proxy, proxyUsage] = await Promise.all([
      runAgentctlJson(["provider", "status", "--json"], "provider status"),
      runAgentctlJson(["provider", "list", "--target", target, "--json"], "provider list"),
      runAgentctlJson(["failover", "status", "--json"], "failover status"),
      runAgentctlJson(["pricing", "status", "--json"], "pricing status"),
      runAgentctlJson(["proxy", "status", "--json"], "proxy status"),
      runAgentctlJson(["proxy", "usage", "--summary", "--json"], "proxy usage")
    ]);
    const status = providerStatus.data || {};
    const platform = status.platform || process.platform;
    const profiles = Array.isArray(providerList.data) ? providerList.data : [];
    const errors = [
      ["Provider status", providerStatus],
      ["Provider catalog", providerList],
      ["Failover", failover],
      ["Pricing", pricing],
      ["Proxy", proxy],
      ["Proxy usage", proxyUsage]
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
      proxyUsage: proxyUsage.data || {
        requests: 0,
        priced_requests: 0,
        unpriced_requests: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        costs: {},
        service_tiers: {
          fast_requested: 0,
          fast_effective: 0,
          fast_downgraded: 0,
          transitions: {}
        },
        window: { from: null, to: null }
      },
      errors
    };
  }

  async function proxyAction(actionName) {
    const commands = {
      "proxy-start": ["proxy", "start", "passthrough", "--target", "codex", "--yes", "--json"],
      "proxy-stop": ["proxy", "stop", "--yes", "--json"],
      "proxy-attach": ["proxy", "attach", "--yes", "--json"],
      "proxy-detach": ["proxy", "detach", "--yes", "--json"]
    };
    const args = commands[actionName];
    if (!args) throw new Error(`unsupported proxy action: ${actionName}`);
    const result = await runAgentctlJson(args, actionName.replace("proxy-", "proxy "));
    const success = {
      "proxy-start": "Loopback observer started; Codex remains direct until Attach is confirmed.",
      "proxy-stop": "Loopback observer stopped; retained usage history remains available.",
      "proxy-attach": "Codex now uses the local observer as its first hop; official ChatGPT authentication and the OpenAI upstream are preserved. Start a new Codex session.",
      "proxy-detach": "Codex configuration was restored exactly; new requests now go directly to OpenAI. Start a new Codex session."
    };
    return {
      ok: result.ok,
      data: result.data,
      detail: result.ok ? success[actionName] : result.error || `${actionName} failed.`
    };
  }

  async function localSnapshot({ signal } = {}) {
    const connectionPromise = typeof remoteWorkspace.connection === "function"
      ? remoteWorkspace.connection()
          .then((data) => ({ data, error: "" }))
          .catch((error) => ({ data: null, error: sanitizeOutput(error?.message || error) }))
      : Promise.resolve({ data: null, error: "remote configuration not found" });
    const [doctorResult, presetsResult, snippetsResult, accountsResult, connectionResult] =
      await Promise.all([
        runJson(orchestrator, ["doctor", "all", "--local", "--json"],
          "local agentctl doctor", {}, { signal }),
        runJson(orchestrator, ["preset", "list", "--json"],
          "preset list", {}, { signal }),
        runControllerJson(tools.prompts, ["snippet", "list", "--json"],
          "snippet list", {}, { signal }),
        runAgentctlJson(["account", "status", "--json"],
          "Codex account status", { signal }),
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
    let agents = Array.isArray(doctorResult.data?.targets)
      ? doctorResult.data.targets.map((report) => report?.provider?.data
        ? { ...report.provider.data, client: report.provider.data.client || report.target }
        : null).filter(Boolean)
      : null;
    let agentsError = "";
    if (!Array.isArray(agents) || agents.length === 0 ||
        agents.length !== doctorResult.data?.targets?.length) {
      const agentsResult = await runAgentctlJson(
        ["status", "all", "--json"],
        "agentctl status",
        { signal }
      );
      agents = agentsResult.data;
      agentsError = agentsResult.error;
    }
    agents = Array.isArray(agents)
      ? agents.map((agent) => agent?.client === "codex" && agent.identity && accountLabel
        ? { ...agent, identity: { ...agent.identity, account: accountLabel } }
        : agent)
      : agents;
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
      agentsError,
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

  async function hydrateSnapshot(local, { signal } = {}) {
    const remoteResult = refreshWorkspaceIndex()
      .then((data) => ({
        data,
        connection: {
          ...(local.workspaceConnection || {}),
          endpoint: local.workspaceConnection?.endpoint || data?.endpoint || "",
          store_id: local.workspaceConnection?.store_id || data?.store_id || "",
          configured: true
        },
        error: "",
        fresh: true
      }))
      .catch((error) => ({
        data: cachedWorkspace ? structuredClone(cachedWorkspace) : null,
        connection: local.workspaceConnection,
        error: sanitizeOutput(error?.message || error),
        fresh: false
      }));
    const remote = await remoteResult;
    // Overview and all local-health surfaces must keep reporting the device's
    // active configuration after Workspace hydration. A materialized Workspace
    // runtime is only a staging area for catalog plan/apply actions; its empty
    // or target-scoped current state must never replace the local doctor result.
    const doctorResult = { data: structuredClone(local.doctor), error: local.doctorError };
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

  async function snapshot(options = {}) {
    const local = await localSnapshot(options);
    return hydrateSnapshot(local, options);
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
    const result = await runControllerJson(
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

  async function localMcpRepair(profile, target) {
    if (!profile) throw new Error("No current local MCP profile is available to repair.");
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const result = await runController(tools.mcp, [
      "apply", "--target", target, "--profile", profile, "--force"
    ]);
    return {
      ok: result.code === 0,
      data: { profile, target },
      detail: result.code === 0
        ? `${profile} was reapplied to ${target}; only same-name MCP entries were adopted, unrelated client configuration was preserved, and a new ${target} session is recommended.`
        : sanitizeOutput(result.stderr || result.stdout) ||
          `MCP repair failed with code ${result.code}`
    };
  }

  async function localMcpReadiness({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && mcpReadinessCache.data &&
        now - mcpReadinessCache.checkedAt < MCP_READINESS_CACHE_MS) {
      return mcpReadinessCache.data;
    }
    if (!refresh && mcpReadinessCache.pending) return mcpReadinessCache.pending;
    const pending = runControllerJson(
      tools.mcp,
      ["server", "doctor", "--all", "--json"],
      "Local MCP readiness"
    ).then((result) => {
      if (result.data) {
        mcpReadinessCache = { checkedAt: Date.now(), data: result.data, pending: null };
      } else {
        mcpReadinessCache = { checkedAt: 0, data: null, pending: null };
      }
      return result.data;
    }).catch((error) => {
      mcpReadinessCache = { checkedAt: 0, data: null, pending: null };
      throw error;
    });
    mcpReadinessCache = { ...mcpReadinessCache, pending };
    return pending;
  }

  async function localMcpServers(target, { refreshReadiness = false } = {}) {
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const [catalog, doctors] = await Promise.all([
      runControllerJson(
        tools.mcp,
        ["server", "list", "--target", target, "--json"],
        "Local MCP server catalog"
      ),
      localMcpReadiness({ refresh: refreshReadiness })
    ]);
    if (!catalog.ok) throw new Error(catalog.error || "Local MCP server catalog is unavailable.");
    return normalizeMcpServerCatalog(catalog.data, doctors);
  }

  async function localMcpState(target) {
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const result = await runControllerJson(
      tools.mcp,
      ["current", "--target", target, "--json"],
      "Current MCP state"
    );
    if (!result.ok || !result.data || result.data.target !== target) {
      throw new Error(result.error || "Current MCP state is unavailable.");
    }
    return result.data;
  }

  async function localMcpPreflight(server, target) {
    if (!server || !/^[A-Za-z0-9._-]+$/.test(server)) {
      throw new Error("No valid MCP server is selected.");
    }
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const [host, configuration] = await Promise.all([
      runControllerJson(
        tools.mcp,
        ["server", "doctor", server, "--json"],
        `MCP host check for ${server}`
      ),
      runControllerJson(
        tools.mcp,
        ["server", "preflight", server, "--target", target, "--json"],
        `MCP configuration check for ${server}`
      )
    ]);
    const hostCheck = Array.isArray(host.data?.servers) ? host.data.servers[0] : null;
    const issues = [
      ...(Array.isArray(hostCheck?.issues) ? hostCheck.issues : []),
      ...(!host.ok || hostCheck?.ready !== true
        ? [host.error || hostCheck?.details || "Local host requirements are not ready."]
        : []),
      ...(!configuration.ok
        ? [configuration.error || "Required Secret references or target configuration are unavailable."]
        : [])
    ].map((value) => sanitizeOutput(value)).filter(Boolean);
    return {
      server,
      target,
      ready: host.ok && hostCheck?.ready === true && configuration.ok,
      issues: [...new Set(issues)].slice(0, 8),
      detail: issues.length > 0
        ? issues.join("\n")
        : `${server} passed platform, executable/service, and Secret reference checks for ${target}.`
    };
  }

  async function localMcpToggle(actionName, server, target) {
    if (!server || !/^[A-Za-z0-9._-]+$/.test(server)) {
      throw new Error("No valid MCP server is selected.");
    }
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const operation = actionName === "mcp-enable" ? "enable" : "disable";
    const result = await runControllerJson(tools.mcp, [
      "server", "set", "--target", target, `--${operation}`, server, "--json"
    ], `MCP ${operation}`);
    const state = result.ok && result.data?.target === target ? result.data : null;
    return {
      ok: Boolean(state),
      data: { server, target, operation, state },
      detail: state
        ? `${server} was ${operation}d for ${target}; mcpctl now owns this target-specific override, unrelated MCP entries were preserved, and a new ${target} session is recommended.`
        : result.error || `MCP ${operation} did not return the updated local state.`
    };
  }

  async function localMcpBatch(changes, target) {
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new Error("No staged MCP changes are available.");
    }
    const normalized = changes.map((change) => {
      if (!change || !/^[A-Za-z0-9._-]+$/.test(change.name || "") ||
          typeof change.enabled !== "boolean") {
        throw new Error("A staged MCP change is invalid.");
      }
      return { name: change.name, enabled: change.enabled };
    });
    const args = ["server", "set", "--target", target];
    for (const change of normalized) {
      args.push(change.enabled ? "--enable" : "--disable", change.name);
    }
    args.push("--json");
    const result = await runControllerJson(tools.mcp, args, "MCP batch update");
    const state = result.ok && result.data?.target === target ? result.data : null;
    return {
      ok: Boolean(state),
      data: { target, changes: normalized, state },
      detail: state
        ? `${normalized.length} staged MCP change(s) were written for ${target} in one mcpctl transaction; unrelated entries were preserved and a new session is recommended.`
        : result.error || "MCP batch update did not return the updated local state."
    };
  }

  async function localMcpSave(profile, target, replace = false) {
    if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile)) {
      throw new Error("MCP Profile names may contain only letters, numbers, dot, underscore, and hyphen.");
    }
    if (!MCP_CLIENTS.has(target)) throw new Error(`unsupported MCP target: ${target}`);
    const saveArgs = ["profile", "save", profile, "--target", target];
    if (replace) saveArgs.push("--force");
    const saved = await runController(tools.mcp, saveArgs);
    if (saved.code !== 0) {
      return {
        ok: false,
        data: { profile, target },
        detail: sanitizeOutput(saved.stderr || saved.stdout) ||
          `MCP Profile save failed with code ${saved.code}`
      };
    }
    const applied = await runController(tools.mcp, ["apply", "--target", target, "--profile", profile]);
    const state = applied.code === 0 ? await localMcpState(target) : null;
    return {
      ok: applied.code === 0,
      data: { profile, target, state },
      detail: applied.code === 0
        ? `The current ${target} MCP selection was saved as '${profile}' and reapplied as a named Profile.`
        : sanitizeOutput(applied.stderr || applied.stdout) ||
          `Profile '${profile}' was saved, but applying it failed with code ${applied.code}`
    };
  }

  async function localMcpBackup(profile) {
    if (!profile || !/^[A-Za-z0-9._-]+$/.test(profile)) {
      throw new Error("Save the current MCP selection as a named Profile before backing it up.");
    }
    const result = await runController(tools.mcp, ["backup"]);
    return {
      ok: result.code === 0,
      data: { profile },
      detail: result.code === 0
        ? `The encrypted MCP Store was backed up with Profile '${profile}', its catalog dependencies, portable artifacts, and referenced Secret ciphertext. No Secret value was printed.`
        : sanitizeOutput(result.stderr || result.stdout) ||
          `Encrypted MCP Store backup failed with code ${result.code}`
    };
  }

  async function localSkillsRepair(pack, target) {
    if (!pack) throw new Error("No current local Skills pack is available to repair.");
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Skills target: ${target}`);
    const result = await runController(tools.skills, [
      "apply", "--target", target, "--pack", pack, "--yes"
    ]);
    return {
      ok: result.code === 0,
      data: { pack, target },
      detail: result.code === 0
        ? `${pack} was reapplied to ${target}; missing managed skill links were restored, unrelated local skills were preserved, and a new ${target} session is recommended.`
        : sanitizeOutput(result.stderr || result.stdout) ||
          `Skills repair failed with code ${result.code}`
    };
  }

  async function localSkillsState(target) {
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Skills target: ${target}`);
    const result = await runControllerJson(
      tools.skills,
      ["current", "--target", target, "--json"],
      `Current ${target} Skills state`
    );
    if (!result.ok || !result.data || result.data.target !== target) {
      throw new Error(result.error || `Current ${target} Skills state is unavailable.`);
    }
    return result.data;
  }

  async function localSkillsDashboard() {
    const catalogPromise = runControllerJson(
      tools.skills,
      ["list", "--json"],
      "Local Skills catalog"
    );
    const statePromises = [...AGENT_CLIENTS].map(async (target) => {
      try {
        return [target, await localSkillsState(target), ""];
      } catch (error) {
        return [target, null, sanitizeOutput(error?.message || error)];
      }
    });
    const [catalog, stateResults] = await Promise.all([
      catalogPromise,
      Promise.all(statePromises)
    ]);
    if (!catalog.ok) throw new Error(catalog.error || "Local Skills catalog is unavailable.");
    return {
      catalog: normalizeSkillsCatalog(catalog.data),
      states: Object.fromEntries(stateResults.filter(([, state]) => state).map(([target, state]) => [target, state])),
      errors: Object.fromEntries(stateResults.filter(([, , error]) => error).map(([target, , error]) => [target, error]))
    };
  }

  async function localSkillsBatch(changes, target) {
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Skills target: ${target}`);
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new Error("No staged Skill changes are available.");
    }
    const normalized = changes.map((change) => {
      if (!change || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change.name || "") ||
          typeof change.enabled !== "boolean") {
        throw new Error("A staged Skill change is invalid.");
      }
      return { name: change.name, enabled: change.enabled };
    });
    const args = ["skill", "set", "--target", target];
    for (const change of normalized) {
      args.push(change.enabled ? "--enable" : "--disable", change.name);
    }
    args.push("--yes", "--json");
    const result = await runControllerJson(tools.skills, args, "Skills batch update");
    const state = result.ok && result.data?.target === target ? result.data : null;
    return {
      ok: Boolean(state),
      data: { target, changes: normalized, state },
      detail: state
        ? `${normalized.length} Skill change(s) were written for ${target} in one skillsctl transaction; other clients and the canonical Store were preserved.`
        : result.error || "Skills batch update did not return the updated local state."
    };
  }

  async function localSkillsToggle(actionName, skill, target) {
    if (!skill || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill)) {
      throw new Error("No valid Skill is selected.");
    }
    const enabled = actionName === "skills-enable";
    const result = await localSkillsBatch([{ name: skill, enabled }], target);
    return {
      ...result,
      data: { ...result.data, skill, operation: enabled ? "enable" : "disable" },
      detail: result.ok
        ? `${skill} was ${enabled ? "enabled" : "disabled"} for ${target}; other clients and the canonical Skill Store were preserved.`
        : result.detail
    };
  }

  async function localSkillsSave(pack, target, replace = false) {
    if (!pack || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack)) {
      throw new Error("Skill Pack names must use lowercase letters, digits, and single hyphens.");
    }
    if (!AGENT_CLIENTS.has(target)) throw new Error(`unsupported Skills target: ${target}`);
    const saveArgs = ["pack", "save", pack, "--target", target, "--yes"];
    if (replace) saveArgs.push("--force");
    const saved = await runController(tools.skills, saveArgs);
    if (saved.code !== 0) {
      return {
        ok: false,
        data: { pack, target },
        detail: sanitizeOutput(saved.stderr || saved.stdout) ||
          `Skill Pack save failed with code ${saved.code}`
      };
    }
    const applied = await runController(tools.skills, [
      "apply", "--target", target, "--pack", pack, "--yes"
    ]);
    const state = applied.code === 0 ? await localSkillsState(target) : null;
    return {
      ok: Boolean(state),
      data: { pack, target, state },
      detail: state
        ? `The current ${target} Skill selection was saved as '${pack}' and reapplied as a named Pack.`
        : sanitizeOutput(applied.stderr || applied.stdout) ||
          `Pack '${pack}' was saved, but applying it failed with code ${applied.code}`
    };
  }

  async function localSkillsBackup(pack) {
    if (!pack || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack)) {
      throw new Error("Save the current Skill selection as a named Pack before backing it up.");
    }
    const result = await runController(tools.skills, ["backup"]);
    return {
      ok: result.code === 0,
      data: { pack },
      detail: result.code === 0
        ? `The Skills Store was backed up with Pack '${pack}' and its canonical Skill files.`
        : sanitizeOutput(result.stderr || result.stdout) ||
          `Skills Store backup failed with code ${result.code}`
    };
  }

  async function remoteComponentAction(actionName, type, name, target, { force = false } = {}) {
    if (actionName.endsWith("-plan")) {
      const plan = await remoteWorkspace.componentPlan(type, name, target);
      return { ok: true, data: plan, detail: planDetail(plan) };
    }
    if (type === "skills") {
      const remotePlan = await remoteWorkspace.componentPlan(type, name, target);
      const localPack = await runControllerJson(
        tools.skills,
        ["pack", "show", name, "--target", target],
        `Local Skill Pack ${name}`
      );
      const localItems = Array.isArray(localPack.data?.resolved)
        ? [...localPack.data.resolved].sort()
        : null;
      const remoteItems = Array.isArray(remotePlan.items)
        ? [...remotePlan.items].sort()
        : [];
      if (localItems && JSON.stringify(localItems) === JSON.stringify(remoteItems)) {
        const result = await runController(tools.skills, [
          "apply", "--target", target, "--pack", name, "--yes"
        ]);
        if (result.code !== 0) {
          return {
            ok: false,
            data: { type, name, target, matchedLocalPack: true },
            detail: sanitizeOutput(result.stderr || result.stdout) ||
              `Action failed with code ${result.code}`
          };
        }
        let state;
        try {
          state = await localSkillsState(target);
        } catch (error) {
          return {
            ok: false,
            data: { type, name, target, matchedLocalPack: true },
            detail: `${name} finished applying, but the resulting local Skills state could not be verified: ${sanitizeOutput(error?.message || error)}`
          };
        }
        const actualItems = Array.isArray(state.skills) ? [...state.skills].sort() : [];
        const verified = state.selection_mode === "pack" && state.pack === name &&
          state.healthy === true && JSON.stringify(actualItems) === JSON.stringify(remoteItems);
        return {
          ok: verified,
          data: { type, name, target, matchedLocalPack: true, state },
          detail: verified
            ? `${name} matched the local canonical Pack and is verified active with ${actualItems.length} Skills; start a new ${target} session`
            : `${name} finished applying, but verification returned ${state.pack || state.selection_mode || "an unknown selection"} with ${actualItems.length} Skills instead of the selected ${remoteItems.length}.`
        };
      }
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
      if (type === "mcp" && force) args.push("--force");
      const result = await runController(tools[type], args, env);
      if (result.code !== 0 && promptWritten) await remoteWorkspace.restorePrompt(selection);
      const detail = sanitizeOutput(result.stderr || result.stdout) ||
        `Action failed with code ${result.code}`;
      return {
        ok: result.code === 0,
        data: {
          type,
          name,
          target,
          forceRequired: type === "mcp" && !force && mcpApplyNeedsForce(detail)
        },
        detail: result.code === 0
          ? `${name} applied from Workspace; start a new ${target} session`
          : detail
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
    target = "codex",
    changes = [],
    replace = false,
    force = false
  } = {}) {
    if (["proxy-start", "proxy-stop", "proxy-attach", "proxy-detach"].includes(actionName)) {
      return proxyAction(actionName);
    }
    if (actionName === "provider-plan" || actionName === "provider-apply") {
      return providerAction(actionName, selection, target, source);
    }
    if (actionName === "provider-sync-push" || actionName === "provider-sync-pull") {
      return providerSync(actionName, selection);
    }
    if (actionName === "mcp-enable" || actionName === "mcp-disable") {
      return localMcpToggle(actionName, selection, target);
    }
    if (actionName === "mcp-batch") return localMcpBatch(changes, target);
    if (actionName === "mcp-profile-save" || actionName === "mcp-profile-update") {
      return localMcpSave(selection, target, actionName === "mcp-profile-update" || replace);
    }
    if (actionName === "mcp-profile-upload") return localMcpBackup(selection);
    if (actionName === "mcp-repair") return localMcpRepair(selection, target);
    if (actionName === "skills-enable" || actionName === "skills-disable") {
      return localSkillsToggle(actionName, selection, target);
    }
    if (actionName === "skills-batch") return localSkillsBatch(changes, target);
    if (actionName === "skills-pack-save" || actionName === "skills-pack-update") {
      return localSkillsSave(selection, target, actionName === "skills-pack-update" || replace);
    }
    if (actionName === "skills-pack-upload") return localSkillsBackup(selection);
    if (actionName === "skills-repair") return localSkillsRepair(selection, target);
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
      const command = controllerCommand(agentctl, args);
      const result = await run(command.executable, command.args);
      return {
        ok: result.code === 0,
        data: { agent },
        detail: sanitizeOutput(result.stdout || result.stderr) ||
          (result.code === 0 ? "Done" : `Action failed with code ${result.code}`)
      };
    }
    if (actionName === "snippet-copy") {
      const result = await runController(tools.prompts, ["snippet", "copy", selection]);
      return {
        ok: result.code === 0,
        data: { name: selection },
        detail: result.code === 0
          ? `${selection} copied to the clipboard; content remains hidden`
          : sanitizeOutput(result.stderr || result.stdout) || `Action failed with code ${result.code}`
      };
    }
    const component = /^(mcp|skills|prompts|snippets)-(plan|apply)$/.exec(actionName);
    if (component) {
      return remoteComponentAction(actionName, component[1], selection, target, { force });
    }
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
    localMcpServers,
    localMcpPreflight,
    localMcpState,
    localSkillsDashboard,
    localSkillsState,
    remoteCatalog
  };
}
