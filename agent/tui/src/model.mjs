export const SECTIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
  { id: "presets", label: "Presets" },
  { id: "cloud", label: "Cloud" }
]);

export const TARGETS = Object.freeze(["codex", "claude"]);

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

export function presetEntries(snapshot) {
  return Object.entries(snapshot?.presets || {})
    .sort(([left], [right]) => left.localeCompare(right));
}

export function clampSelection(index, length) {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
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
    return {
      label,
      kind: data.provider_status === "configured" ? "good" : "bad",
      detail: [data.provider, data.model].filter(Boolean).join(" / ") || "No provider selected"
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
  return {
    label: promptData.healthy === false || !promptData.managed ? "Needs setup" : "Healthy",
    kind: promptData.healthy === false || !promptData.managed ? "bad" : "good",
    detail: promptData.profile || "none"
  };
}

export function actionForKey(section, input) {
  if (["mcp", "skills", "prompts"].includes(section)) {
    if (input === "p") return `${section}-plan`;
    if (input === "a") return `${section}-apply`;
  }
  if (section === "presets") {
    if (input === "p") return "plan";
    if (input === "a") return "apply";
    if (input === "u") return "rollback";
  }
  return null;
}

export function actionNeedsConfirmation(action) {
  return action === "apply" || action === "rollback" || action.endsWith("-apply");
}

export function actionLabel(action, selection, target) {
  const component = /^(mcp|skills|prompts)-(plan|apply)$/.exec(action);
  if (component) {
    const label = component[1] === "prompts" ? "Prompt" :
      component[1][0].toUpperCase() + component[1].slice(1);
    return `${component[2] === "plan" ? "Plan" : "Apply"} ${label} ${selection || "selection"} for ${target}`;
  }
  if (action === "plan") return `Plan ${selection || "preset"} for ${target}`;
  if (action === "apply") return `Apply ${selection || "preset"} to ${target}`;
  if (action === "rollback") return `Roll back ${target}`;
  return action;
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
      description: "MCP, Skills, Prompts, and Presets continue to work locally.",
      safety: "No cloud data exists until you initialize or restore a Workspace.",
      commands: [
        "agentctl workspace init --endpoint <url>",
        "agentctl workspace restore --recovery-file <file>"
      ],
      diagnostic: ""
    };
  }
  if (/remote snapshot is not a valid agentctl Workspace/i.test(diagnostic)) {
    return {
      state: "incompatible",
      kind: "warn",
      heading: "Remote Workspace data is incompatible",
      status: "Connected · needs attention",
      description: "The encrypted store opened, but its latest snapshot is not in the current unified Workspace format.",
      safety: "Nothing was changed locally or remotely.",
      commands: [
        "Restore the correct toolbox1 recovery code:",
        "agentctl workspace restore --recovery-file <file>"
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
      commands: ["agentctl workspace restore --recovery-file <file>"],
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
      commands: ["agentctl workspace restore --recovery-file <file>"],
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
