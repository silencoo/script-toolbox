export const SECTIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
  { id: "snippets", label: "Snippets" },
  { id: "presets", label: "Presets" },
  { id: "cloud", label: "Cloud" }
]);

export const TARGETS = Object.freeze(["codex", "claude"]);

export function targetLabel(target) {
  if (target === "claude") return "Claude Code";
  if (target === "codex") return "Codex";
  return String(target || "Unknown");
}

export function normalizeSection(value) {
  return SECTIONS.some((section) => section.id === value) ? value : "overview";
}

export function moveSection(current, delta) {
  const index = Math.max(0, SECTIONS.findIndex((section) => section.id === current));
  return SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length].id;
}

export function otherTarget(target) {
  return target === "claude" ? "codex" : "claude";
}

export function targetReport(snapshot, target) {
  return snapshot?.doctor?.targets?.find((report) => report.target === target) || null;
}

function componentData(check) {
  return Array.isArray(check?.data) ? check.data[0] || {} : check?.data || {};
}

export function componentTargetState(snapshot, component, target) {
  const reportKey = component === "prompts" ? "prompt" : component;
  const check = targetReport(snapshot, target)?.[reportKey] || null;
  const data = componentData(check);
  const selection = component === "mcp"
    ? (data.selection_mode === "manual" ? "custom" : data.profile || "none")
    : component === "skills"
      ? (data.selection_mode === "manual" ? "custom" : data.pack || "none")
      : data.profile || "none";
  const items = component === "mcp"
    ? data.servers || []
    : component === "skills"
      ? data.skills || []
      : [];
  return {
    target,
    label: targetLabel(target),
    check,
    data,
    selection,
    items: [...items],
    suppressed: component === "mcp" ? [...(data.suppressed_servers || [])] : [],
    drift: Array.isArray(data.drift) ? [...data.drift] : data.drift === true ? ["configuration"] : [],
    summary: componentSummary(component, check)
  };
}

export function promptTargetState(snapshot, target) {
  const state = componentTargetState(snapshot, "prompts", target);
  const data = state.data;
  return {
    target: state.target,
    label: state.label,
    selection: state.selection,
    summary: state.summary,
    managed: data.managed === true,
    linkFile: typeof data.link_file === "string" ? data.link_file : "",
    instructionFile: typeof data.instruction_file === "string" ? data.instruction_file : "",
    fileState: typeof data.instructions === "string" ? data.instructions : "",
    healthy: data.healthy !== false,
    ok: state.check?.ok === true,
    error: state.check?.ok
      ? ""
      : state.check?.summary || state.check?.error || "status unavailable"
  };
}

export function snippetEntries(localEntries, remoteEntries) {
  const merged = new Map();
  for (const value of Array.isArray(localEntries) ? localEntries : []) {
    if (!value || typeof value.name !== "string") continue;
    merged.set(value.name, {
      name: value.name,
      local: {
        path: typeof value.path === "string" ? value.path : "",
        state: typeof value.state === "string" ? value.state : ""
      },
      remote: null
    });
  }
  for (const value of Array.isArray(remoteEntries) ? remoteEntries : []) {
    if (!value || typeof value.name !== "string") continue;
    const current = merged.get(value.name) || { name: value.name, local: null, remote: null };
    current.remote = {
      count: Number.isFinite(value.count) ? value.count : 1,
      unit: typeof value.unit === "string" ? value.unit : "snippet",
      source: value.source === "cloud" ? "cloud" : ""
    };
    merged.set(value.name, current);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function mcpTargetComparison(snapshot) {
  const targets = Object.fromEntries(TARGETS.map((target) => [
    target,
    componentTargetState(snapshot, "mcp", target)
  ]));
  const codex = new Set(targets.codex.items);
  const claude = new Set(targets.claude.items);
  return {
    targets,
    shared: [...codex].filter((item) => claude.has(item)).sort(),
    only: {
      codex: [...codex].filter((item) => !claude.has(item)).sort(),
      claude: [...claude].filter((item) => !codex.has(item)).sort()
    }
  };
}

export function presetEntries(snapshot) {
  return Object.entries(snapshot?.presets || {})
    .sort(([left], [right]) => left.localeCompare(right));
}

export function clampSelection(index, length) {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function selectionDelta(input, key = {}) {
  if (input === "]" || key.downArrow) return 1;
  if (input === "[" || key.upArrow) return -1;
  return 0;
}

export function selectionWindow(items, selected, size = 9) {
  const entries = Array.isArray(items) ? items : [];
  const safeIndex = clampSelection(selected, entries.length);
  const windowSize = Math.max(1, Math.floor(size));
  const maximumStart = Math.max(0, entries.length - windowSize);
  const start = Math.min(Math.max(0, safeIndex - Math.floor(windowSize / 2)), maximumStart);
  const end = Math.min(entries.length, start + windowSize);
  return {
    start,
    end,
    total: entries.length,
    items: entries.slice(start, end).map((item, offset) => ({
      item,
      index: start + offset
    }))
  };
}

export function statusKind(value) {
  if (value === true || value === "configured" || value === "installed") return "good";
  if (value === false || value === "incomplete" || value === "error") return "bad";
  return "muted";
}

export function componentSummary(component, check) {
  if (!check?.ok) return { label: "Unavailable", kind: "bad", detail: check?.summary || check?.error || "No status" };
  const data = check.data || {};
  if (component === "provider") {
    const label = data.provider_status === "configured" ? "Configured" : data.provider_status || "Unknown";
    const source = {
      agentctl: "agentctl",
      external: "external config",
      "official-login": "official login"
    }[data.provider_source] || "";
    const configured = data.provider_status === "configured";
    const insecureCredential = configured && data.credential_exists === true && data.credential_private === false;
    const selection = [data.provider, data.model].filter(Boolean).join(" / ") || "No provider selected";
    return {
      label,
      kind: configured ? insecureCredential ? "warn" : "good" : "bad",
      detail: source ? `${selection} · ${source}` : selection
    };
  }
  if (component === "mcp") {
    const selection = data.selection_mode === "manual" ? "custom" : data.profile || "none";
    return {
      label: data.healthy === false ? "Drift" : "Healthy",
      kind: data.healthy === false ? "bad" : "good",
      detail: `${selection} · ${(data.servers || []).length} server(s)`
    };
  }
  if (component === "skills") {
    const selection = data.selection_mode === "manual" ? "custom" : data.pack || "none";
    return {
      label: data.healthy === false ? "Drift" : "Healthy",
      kind: data.healthy === false ? "bad" : "good",
      detail: `${selection} · ${(data.skills || []).length} skill(s)`
    };
  }
  const promptData = Array.isArray(data) ? data[0] || {} : data;
  if (!promptData.managed) {
    return {
      label: "Not managed",
      kind: "warn",
      detail: promptData.profile || "none"
    };
  }
  return {
    label: promptData.healthy === false ? "Drift" : "Healthy",
    kind: promptData.healthy === false ? "bad" : "good",
    detail: promptData.profile || "none"
  };
}

export function actionForKey(section, input) {
  if (section === "agents") {
    if (input === "p") return "agent-providers";
    if (input === "c" || input === "\r") return "agent-configure";
    if (input === "x") return "agent-uninstall";
  }
  if (["mcp", "skills", "prompts", "snippets"].includes(section)) {
    if (input === "p") return `${section}-plan`;
    if (input === "a") return `${section}-apply`;
  }
  if (section === "prompts" && input === "v") return "prompt-view-local";
  if (section === "prompts" && input === "V") return "prompt-view-cloud";
  if (section === "snippets" && input === "c") return "snippet-copy";
  if (section === "presets") {
    if (input === "p") return "plan";
    if (input === "a") return "apply";
    if (input === "u") return "rollback";
  }
  return null;
}

export function actionNeedsConfirmation(action) {
  return action === "apply" || action === "rollback" || action === "agent-uninstall" ||
    action.endsWith("-apply");
}

export function actionLabel(action, selection, target) {
  if (action === "agent-providers") return `Show ${selection || "agent"} providers`;
  if (action === "agent-configure") return `Configure or install ${selection || "agent"}`;
  if (action === "agent-uninstall") return `Remove owned ${selection || "agent"} configuration`;
  if (action === "snippet-copy") return `Copy Snippet ${selection || "selection"}`;
  if (action === "prompt-view-local") return `View local Prompt ${selection || "selection"} for ${target}`;
  if (action === "prompt-view-cloud") return `View Workspace Prompt ${selection || "selection"} for ${target}`;
  const component = /^(mcp|skills|prompts|snippets)-(plan|apply)$/.exec(action);
  if (component) {
    const label = component[1] === "prompts" ? "Prompt" :
      component[1] === "snippets" ? "Snippet" :
      component[1][0].toUpperCase() + component[1].slice(1);
    const targetSuffix = component[1] === "snippets" ? "" : ` for ${target}`;
    return `${component[2] === "plan" ? "Plan" : "Apply"} ${label} ${selection || "selection"}${targetSuffix}`;
  }
  if (action === "plan") return `Plan ${selection || "preset"} for ${target}`;
  if (action === "apply") return `Apply ${selection || "preset"} to ${target}`;
  if (action === "rollback") return `Roll back ${target}`;
  return action;
}

export function safePromptPreviewText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export function workspacePresentation(workspace, error = "") {
  if (workspace) {
    return {
      state: "ready",
      kind: "good",
      heading: "Workspace connected",
      status: "Online",
      description: "Encrypted Workspace sync is available.",
      safety: "",
      commands: [],
      diagnostic: ""
    };
  }

  const diagnostic = String(error || "")
    .replace(/^\s*\[error\]\s*/i, "")
    .trim();
  if (/remote configuration not found/i.test(diagnostic)) {
    return {
      state: "unconfigured",
      kind: "muted",
      heading: "Cloud sync is not set up",
      status: "Local only",
      description: "MCP, Skills, Prompts, Snippets, and Presets continue to work locally.",
      safety: "No cloud data exists until you initialize or restore a Workspace.",
      commands: [
        "agentctl workspace init --endpoint <url>",
        "agentctl workspace restore"
      ],
      diagnostic: ""
    };
  }
  if (/remote snapshot is not a valid agentctl Workspace/i.test(diagnostic)) {
    return {
      state: "incompatible",
      kind: "warn",
      heading: "Remote Workspace data is incompatible",
      status: "Endpoint reachable · incompatible data",
      description: "The encrypted store opened, but its latest snapshot is not in the current unified Workspace format.",
      safety: "Nothing was changed locally or remotely.",
      commands: [
        "Restore the correct toolbox1 recovery code:",
        "agentctl workspace restore"
      ],
      diagnostic: ""
    };
  }
  if (/could not reach|timed out|network|fetch failed/i.test(diagnostic)) {
    return {
      state: "offline",
      kind: "warn",
      heading: "Remote Workspace is temporarily unreachable",
      status: "Offline",
      description: "Local controller state is still available; cloud versions cannot be read right now.",
      safety: "Press r to retry after checking the endpoint or network.",
      commands: ["agentctl workspace status"],
      diagnostic: ""
    };
  }
  if (/HTTP (401|403)|unauthorized|forbidden|authentication|access denied/i.test(diagnostic)) {
    return {
      state: "unauthorized",
      kind: "bad",
      heading: "Workspace access was rejected",
      status: "Recovery needed",
      description: "The local capability does not authorize this remote Workspace.",
      safety: "Restore a known-good toolbox1 recovery code; no remote data was changed.",
      commands: ["agentctl workspace restore"],
      diagnostic: ""
    };
  }
  if (/remote configuration (?:has an invalid schema|must be|permissions)/i.test(diagnostic) ||
      /invalid remote configuration/i.test(diagnostic)) {
    return {
      state: "invalid-local-config",
      kind: "bad",
      heading: "Local Workspace capability needs attention",
      status: "Invalid local configuration",
      description: "The saved capability cannot be used safely in its current form.",
      safety: "Restore a known-good recovery code instead of editing key material by hand.",
      commands: ["agentctl workspace restore"],
      diagnostic: ""
    };
  }
  return {
    state: "unavailable",
    kind: "warn",
    heading: "Workspace status is unavailable",
    status: "Needs attention",
    description: "The dashboard could not determine the current cloud state.",
    safety: "No Workspace action was attempted.",
    commands: ["agentctl workspace status"],
    diagnostic: diagnostic || "Workspace status returned no details."
  };
}
