export const SECTIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "accounts", label: "Accounts" },
  { id: "providers", label: "Providers" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
  { id: "snippets", label: "Snippets" },
  { id: "presets", label: "Presets" },
  { id: "cloud", label: "Cloud" }
]);

export const TARGETS = Object.freeze(["codex", "claude"]);
export const PROVIDER_TARGETS = Object.freeze(["claude", "codex", "opencode", "pi"]);
export const SKILL_TARGETS = Object.freeze(["codex", "claude", "opencode", "pi"]);

export function targetLabel(target) {
  if (target === "claude") return "Claude Code";
  if (target === "codex") return "Codex";
  if (target === "opencode") return "OpenCode";
  if (target === "pi") return "Pi";
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
  return cycleTarget(target, 1, TARGETS);
}

export function cycleTarget(target, delta = 1, targets = TARGETS) {
  const values = Array.isArray(targets) && targets.length ? targets : TARGETS;
  const index = Math.max(0, values.indexOf(target));
  return values[(index + delta + values.length) % values.length];
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
    baseSelection: typeof data.base_profile === "string" ? data.base_profile : "",
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

function providerDisplayText(value, maximum = 2048) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, maximum)
    : "";
}

function providerTokenCount(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000)
    ? value
    : null;
}

function providerEntry(value, fallbackSource) {
  if (!value || typeof value.name !== "string") return null;
  const name = providerDisplayText(value.name, 64);
  if (!name) return null;
  const source = ["builtin", "local", "cloud"].includes(value.source)
    ? value.source
    : fallbackSource;
  return {
    key: `${source}:${name}`,
    name,
    label: providerDisplayText(value.label, 80),
    source,
    materialized: value.materialized === true,
    description: providerDisplayText(value.description, 500),
    protocol: providerDisplayText(value.protocol, 40),
    endpoint: providerDisplayText(value.endpoint, 2048),
    requestedModel: providerDisplayText(value.requested_model, 240),
    outboundModel: providerDisplayText(value.outbound_model, 240),
    modelsAvailable: Array.isArray(value.models_available)
      ? value.models_available.map((model) => providerDisplayText(model, 240)).filter(Boolean)
      : [],
    enabled: value.enabled !== false,
    compatible: value.compatible !== false,
    ready: value.ready === true,
    status: providerDisplayText(value.status, 32),
    issue: providerDisplayText(value.issue, 500),
    authMode: providerDisplayText(value.auth_mode, 32),
    secretReference: providerDisplayText(value.secret_reference, 96),
    secretPresent: value.secret_present === true,
    nativeAuthPresent: value.native_auth_present === true,
    nativeAuthProvider: providerDisplayText(value.native_auth_provider, 96),
    nativeAuthType: providerDisplayText(value.native_auth_type, 32),
    nativeSelected: value.native_selected === true,
    nativeSelectedModel: providerDisplayText(value.native_selected_model, 240),
    compactionUpstream: providerDisplayText(value.compaction_upstream, 40),
    compactionPolicy: providerDisplayText(value.compaction_policy, 20),
    compactionMode: providerDisplayText(value.compaction_mode, 40),
    compactionLabel: providerDisplayText(value.compaction_label, 100),
    contextWindowTokens: providerTokenCount(value.context_window_tokens),
    autoCompactTokens: providerTokenCount(value.auto_compact_tokens),
    contextLabel: providerDisplayText(value.context_label, 120),
    officialIdentityPolicy: providerDisplayText(value.official_identity_policy, 32),
    officialIdentityAccount: providerDisplayText(value.official_identity_account, 64),
    applied: value.applied === true,
    target: providerDisplayText(value.target, 32),
    platform: providerDisplayText(value.platform, 32)
  };
}

const PROVIDER_SYNC_FIELDS = Object.freeze([
  ["description", "Description"],
  ["protocol", "Protocol"],
  ["endpoint", "Endpoint"],
  ["requestedModel", "Requested model"],
  ["outboundModel", "Outbound model"],
  ["enabled", "Target availability"],
  ["compatible", "Target compatibility"],
  ["authMode", "Authentication"],
  ["secretReference", "Secret reference"],
  ["secretPresent", "Secret availability"],
  ["compactionUpstream", "Compaction capability"],
  ["compactionPolicy", "Compaction policy"],
  ["compactionMode", "Effective compaction"],
  ["contextWindowTokens", "Context window"],
  ["autoCompactTokens", "Auto-compact trigger"],
  ["officialIdentityPolicy", "Official identity policy"],
  ["officialIdentityAccount", "Official identity account"]
]);

function providerSyncConflicts(local, cloud) {
  if (!local || !cloud) return [];
  return PROVIDER_SYNC_FIELDS
    .filter(([field]) => local[field] !== cloud[field])
    .map(([, label]) => label);
}

function providerCandidate(group) {
  const ordered = [group.local, group.cloud, group.builtin].filter(Boolean);
  return ordered.find((entry) => entry.enabled && entry.compatible) || ordered[0] || null;
}

function mergedProviderEntry(name, group) {
  const selected = providerCandidate(group);
  if (!selected) return null;
  const native = [group.local, group.builtin]
    .find((entry) => entry?.nativeAuthPresent) || null;
  const source = group.cloud === selected
    ? "cloud"
    : group.local === selected ? "local" : "builtin";
  const sources = [];
  if (group.builtin) sources.push("builtin");
  if (group.local) sources.push("local");
  if (group.cloud) sources.push("cloud");
  const syncConflicts = providerSyncConflicts(group.local, group.cloud);
  const syncStatus = group.local && group.cloud
    ? syncConflicts.length > 0 ? "conflict" : "backed-up"
    : group.local ? "local-only"
      : group.cloud ? "workspace-only" : "builtin-only";
  return {
    ...selected,
    key: name,
    source,
    sources,
    syncStatus,
    syncConflicts,
    nativeAuthPresent: native?.nativeAuthPresent || selected.nativeAuthPresent,
    nativeAuthProvider: native?.nativeAuthProvider || selected.nativeAuthProvider,
    nativeAuthType: native?.nativeAuthType || selected.nativeAuthType,
    nativeSelected: native?.nativeSelected || selected.nativeSelected,
    nativeSelectedModel: native?.nativeSelectedModel || selected.nativeSelectedModel
  };
}

export function providerEntries(localEntries, remoteEntries, { includeIncompatible = false } = {}) {
  const groups = new Map();
  const add = (value, fallbackSource) => {
    const entry = providerEntry(value, fallbackSource);
    if (!entry) return;
    const group = groups.get(entry.name) || { builtin: null, local: null, cloud: null };
    if (entry.source === "builtin") {
      group.builtin = entry;
      if (entry.materialized) group.local = entry;
    } else if (entry.source === "cloud") {
      group.cloud = entry;
    } else {
      group.local = entry;
    }
    groups.set(entry.name, group);
  };
  for (const value of Array.isArray(localEntries) ? localEntries : []) {
    add(value, "local");
  }
  for (const value of Array.isArray(remoteEntries) ? remoteEntries : []) {
    add(value, "cloud");
  }
  return [...groups.entries()]
    .map(([name, group]) => mergedProviderEntry(name, group))
    .filter((entry) => entry && (
      includeIncompatible || entry.applied || (entry.enabled && entry.compatible)
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function accountEntries(snapshot) {
  const entries = Array.isArray(snapshot?.accounts?.accounts)
    ? snapshot.accounts.accounts
    : [];
  return entries
    .filter((value) => value && typeof value.name === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name))
    .map((value) => ({
      name: value.name.slice(0, 64),
      current: value.current === true,
      savedAt: typeof value.saved_at === "string" ? value.saved_at.slice(0, 40) : "",
      credentialPrivate: value.credential_private === true
    }))
    .sort((left, right) => Number(right.current) - Number(left.current) ||
      left.name.localeCompare(right.name));
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

export function mcpServerEntries(catalogItems, snapshot, target) {
  const comparison = mcpTargetComparison(snapshot);
  const active = comparison.targets[target];
  const other = comparison.targets[otherTarget(target)];
  const enabled = new Set(active.items);
  const otherEnabled = new Set(other.items);
  const suppressed = new Set(active.suppressed);
  return (Array.isArray(catalogItems) ? catalogItems : [])
    .filter((item) => item && typeof item.name === "string" && item.name.length > 0)
    .map((item) => ({
      name: item.name,
      category: typeof item.category === "string" ? item.category : "",
      description: typeof item.description === "string" ? item.description : "",
      setup: typeof item.setup === "string" ? item.setup : "",
      variantGroup: typeof item.variant_group === "string" ? item.variant_group : "",
      checked: item.checked === true,
      ready: typeof item.ready === "boolean" ? item.ready : null,
      issues: Array.isArray(item.issues) ? item.issues.filter((issue) => typeof issue === "string") : [],
      checkDetails: typeof item.check_details === "string" ? item.check_details : "",
      enabled: enabled.has(item.name),
      otherEnabled: otherEnabled.has(item.name),
      suppressed: suppressed.has(item.name)
    }))
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) ||
      Number(right.otherEnabled) - Number(left.otherEnabled) ||
      left.name.localeCompare(right.name));
}

export function filterMcpServerEntries(entries, {
  query = "",
  filter = "all",
  grouped = false
} = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  const filtered = (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (filter === "enabled" && !entry.enabled) return false;
    if (filter === "problems" && entry.ready !== false) return false;
    if (!normalizedQuery) return true;
    return [entry.name, entry.category, entry.description]
      .some((value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
  });
  if (!grouped) return filtered;
  return [...filtered].sort((left, right) =>
    Number(right.enabled) - Number(left.enabled) ||
    String(left.category || "other").localeCompare(String(right.category || "other")) ||
    left.name.localeCompare(right.name));
}

export function skillTargetState(states, target) {
  const data = states?.[target] && typeof states[target] === "object" ? states[target] : {};
  return {
    target,
    label: targetLabel(target),
    selection: data.selection_mode === "manual" ? "custom" : data.pack || "none",
    selectionMode: data.selection_mode || "unknown",
    basePack: typeof data.base_pack === "string" ? data.base_pack : "",
    baseSkills: Array.isArray(data.base_skills) ? [...data.base_skills] : [],
    skills: Array.isArray(data.skills) ? [...data.skills] : [],
    drift: Array.isArray(data.drift) ? [...data.drift] : [],
    healthy: data.healthy === true,
    data
  };
}

export function skillEntries(catalogItems, states, target) {
  const active = new Set(skillTargetState(states, target).skills);
  const enabledByTarget = Object.fromEntries(SKILL_TARGETS.map((client) => [
    client,
    new Set(skillTargetState(states, client).skills)
  ]));
  return (Array.isArray(catalogItems) ? catalogItems : [])
    .filter((item) => item && typeof item.name === "string" && item.name.length > 0)
    .map((item) => ({
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      enabled: active.has(item.name),
      enabledTargets: SKILL_TARGETS.filter((client) =>
        client !== target && enabledByTarget[client].has(item.name))
    }))
    .sort((left, right) => Number(right.enabled) - Number(left.enabled) ||
      Number(right.enabledTargets.length > 0) - Number(left.enabledTargets.length > 0) ||
      left.name.localeCompare(right.name));
}

export function filterSkillEntries(entries, { query = "", enabledOnly = false } = {}) {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (enabledOnly && !entry.enabled) return false;
    if (!normalizedQuery) return true;
    return [entry.name, entry.description]
      .some((value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
  });
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
  if (key.downArrow) return 1;
  if (key.upArrow) return -1;
  return 0;
}

export function sectionDelta(input, key = {}) {
  if (input === "]" || key.rightArrow || (key.tab && !key.shift)) return 1;
  if (input === "[" || key.leftArrow || (key.tab && key.shift)) return -1;
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
  if (component === "identity") return identitySummary(data);
  if (component === "inference") return inferenceSummary(data);
  if (component === "provider") {
    return inferenceSummary(data);
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

export function identitySummary(data = {}) {
  let identity = data.identity;
  if (!identity || typeof identity !== "object") {
    identity = data.provider_source === "official-login"
      ? {
          status: "configured",
          kind: data.provider === "openai-chatgpt" ? "chatgpt" : null,
          account: data.provider === "openai-chatgpt" ? "current" : null,
          source: "official-login",
          credential_exists: data.credential_exists,
          credential_private: data.credential_private
        }
      : { status: "not-applicable", source: "none" };
  }
  if (identity.status === "not-applicable") {
    return { label: "N/A", kind: "muted", detail: "No separate official Identity" };
  }
  if (identity.status !== "configured") {
    return { label: "Not logged in", kind: "muted", detail: "No ChatGPT official login" };
  }
  const insecure = identity.credential_exists === true && identity.credential_private === false;
  const chatgpt = identity.kind === "chatgpt";
  const kind = chatgpt ? "ChatGPT" : identity.kind || "Official";
  const account = identity.account === "current"
    ? "current account"
    : identity.account || "current account";
  return {
    label: chatgpt ? "ChatGPT" : "Active",
    kind: insecure ? "warn" : "good",
    detail: chatgpt
      ? `${account} · official login`
      : `${kind} · ${account} · official login`
  };
}

export function inferenceSummary(data = {}) {
  const inference = data.inference && typeof data.inference === "object"
    ? data.inference
    : {
        status: data.provider_status,
        provider: data.provider,
        model: data.model,
        source: data.provider_source,
        credential_exists: data.credential_exists,
        credential_private: data.credential_private
      };
  const officialSubscription = inference.source === "official-account";
  const label = officialSubscription
    ? "Subscription"
    : inference.status === "configured" ? "Configured" : inference.status || "Unknown";
  const source = {
    agentctl: "agentctl",
    external: "external config",
    "official-login": "official login",
    "official-account": "ChatGPT official subscription"
  }[inference.source] || "";
  const configured = inference.status === "configured";
  const insecureCredential = configured && inference.credential_exists === true &&
    inference.credential_private === false;
  const selection = [inference.provider, inference.model].filter(Boolean).join(" / ") ||
    "No Provider selected";
  return {
    label,
    kind: configured ? insecureCredential ? "warn" : "good" : "bad",
    detail: source ? `${selection} · ${source}` : selection
  };
}

export function proxyPresentation(proxy = {}, { officialSubscription = false } = {}) {
  const status = typeof proxy.status === "string" ? proxy.status : "unavailable";
  const running = status === "running" && proxy.running !== false;
  const attachment = proxy.attachment && typeof proxy.attachment === "object"
    ? proxy.attachment
    : {};
  const attachmentPresent = attachment.attached === true;
  const attached = attachmentPresent && attachment.status === "attached";
  const localAddress = proxy.local_base_url ||
    (proxy.host && proxy.port ? `http://${proxy.host}:${proxy.port}` : "loopback");
  let observerLabel = "Unavailable · status could not be read";
  let observerKind = "warn";
  if (running) {
    observerLabel = `Running · ${localAddress}`;
    observerKind = "good";
  } else if (status === "stopped") {
    observerLabel = "Stopped · no local listener";
    observerKind = "muted";
  } else if (status === "stale") {
    observerLabel = "Stale · recovery required before reuse";
    observerKind = "bad";
  }
  const attachmentLabel = attached
    ? "Attached · recording new Codex requests"
    : attachmentPresent
      ? `${attachment.status || "unknown"} · detach or repair before continuing`
      : "Detached · new Codex requests are not recorded";
  const attachmentKind = attached ? "good" : attachmentPresent ? "bad" : "muted";
  const inferencePath = officialSubscription
    ? "OpenAI official subscription"
    : "active Codex inference Provider";
  const routeLabel = attached && running
    ? `Codex → local observer → ${inferencePath}`
    : `Codex → ${inferencePath} directly`;
  return {
    status,
    running,
    attachmentPresent,
    attached,
    observerLabel,
    observerKind,
    attachmentLabel,
    attachmentKind,
    routeLabel,
    routeKind: attached && running ? "good" : "muted"
  };
}

export function actionForKey(section, input) {
  if (section === "agents") {
    if (input === "p" || input === "c" || input === "\r") return "agent-provider";
    if (input === "x") return "agent-uninstall";
  }
  if (section === "accounts") {
    if (input === "a" || input === "\r") return "account-use";
    if (input === "x") return "account-delete";
  }
  if (section === "providers") {
    if (input === "p") return "provider-plan";
    if (input === "a") return "provider-apply";
    if (input === "u") return "provider-sync-push";
    if (input === "d") return "provider-sync-pull";
    if (input === "S") return "proxy-toggle-running";
    if (input === "A") return "proxy-toggle-attachment";
  }
  if (["mcp", "skills", "prompts", "snippets"].includes(section)) {
    if (input === "p") return `${section}-plan`;
    if (input === "a") return `${section}-apply`;
  }
  if (section === "mcp" && input === "f") return "mcp-repair";
  if (section === "mcp" && input === " ") return "mcp-toggle";
  if (section === "skills" && input === "f") return "skills-repair";
  if (section === "skills" && input === " ") return "skills-toggle";
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
    action === "account-use" || action === "account-delete" ||
    action === "mcp-repair" || action === "mcp-enable" || action === "mcp-disable" ||
    action === "mcp-batch" || action === "mcp-profile-save" || action === "mcp-profile-update" ||
    action === "mcp-profile-upload" ||
    action === "skills-repair" || action === "skills-enable" || action === "skills-disable" ||
    action === "skills-batch" || action === "skills-pack-save" ||
    action === "skills-pack-update" || action === "skills-pack-upload" ||
    action === "provider-sync-push" || action === "provider-sync-pull" ||
    action === "proxy-start" || action === "proxy-stop" ||
    action === "proxy-attach" || action === "proxy-detach" ||
    action.endsWith("-apply");
}

export function actionLabel(action, selection, target) {
  if (action === "agent-provider") return `Manage ${selection || "agent"} Provider`;
  if (action === "agent-uninstall") return `Remove owned ${selection || "agent"} configuration`;
  if (action === "account-use") return `Switch Codex official account to ${selection || "account"}`;
  if (action === "account-delete") return `Delete saved Codex account ${selection || "account"}`;
  if (action === "provider-plan") return `Plan Provider ${selection || "profile"} for ${targetLabel(target)}`;
  if (action === "provider-apply") return `Apply Provider ${selection || "profile"} to ${targetLabel(target)}`;
  if (action === "provider-sync-push") {
    return `Use local ${selection || "Provider"} in encrypted Workspace`;
  }
  if (action === "provider-sync-pull") {
    return `Use Workspace ${selection || "Provider"} in the local catalog`;
  }
  if (action === "proxy-start") return "Start the Codex subscription observer";
  if (action === "proxy-stop") return "Stop the Codex subscription observer";
  if (action === "proxy-attach") return "Attach Codex to the subscription observer";
  if (action === "proxy-detach") return "Detach Codex from the subscription observer";
  if (action === "mcp-repair") {
    return `Repair local MCP profile ${selection || "selection"} for ${targetLabel(target)}`;
  }
  if (action === "mcp-enable") {
    return `Enable MCP ${selection || "server"} for ${targetLabel(target)}`;
  }
  if (action === "mcp-disable") {
    return `Disable MCP ${selection || "server"} for ${targetLabel(target)}`;
  }
  if (action === "mcp-batch") {
    return `Apply staged MCP changes for ${targetLabel(target)}`;
  }
  if (action === "mcp-profile-save") {
    return `Save current MCP selection as ${selection || "a Profile"} for ${targetLabel(target)}`;
  }
  if (action === "mcp-profile-update") {
    return `Update MCP Profile ${selection || "selection"} for ${targetLabel(target)}`;
  }
  if (action === "mcp-profile-upload") {
    return `Back up MCP Store containing ${selection || "the selected Profile"}`;
  }
  if (action === "skills-repair") {
    return `Repair local Skills pack ${selection || "selection"} for ${targetLabel(target)}`;
  }
  if (action === "skills-enable") {
    return `Enable Skill ${selection || "skill"} for ${targetLabel(target)}`;
  }
  if (action === "skills-disable") {
    return `Disable Skill ${selection || "skill"} for ${targetLabel(target)}`;
  }
  if (action === "skills-batch") {
    return `Apply staged Skill changes for ${targetLabel(target)}`;
  }
  if (action === "skills-pack-save") {
    return `Save current Skill selection as ${selection || "a Pack"} for ${targetLabel(target)}`;
  }
  if (action === "skills-pack-update") {
    return `Update Skill Pack ${selection || "selection"} for ${targetLabel(target)}`;
  }
  if (action === "skills-pack-upload") {
    return `Back up Skills Store containing ${selection || "the selected Pack"}`;
  }
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

export function workspaceConfigured(snapshot) {
  if (snapshot?.workspaceConnection?.configured === true) return true;
  const workspace = snapshot?.workspace;
  return Boolean(workspace?.mode === "workspace" &&
    typeof workspace.endpoint === "string" && workspace.endpoint &&
    typeof workspace.store_id === "string" && workspace.store_id);
}

export function workspacePresentation(workspace, error = "", loading = false) {
  const diagnostic = String(error || "")
    .replace(/^\s*\[error\]\s*/i, "")
    .trim();

  if (workspace && diagnostic) {
    return {
      state: "stale",
      kind: "warn",
      heading: "Workspace reconnecting",
      status: "Cached · retrying",
      description: "The last successful Workspace index remains available while the connection is retried.",
      safety: "Local state and cached cloud metadata remain ready; writes still require a live connection.",
      commands: [],
      diagnostic
    };
  }

  if (workspace && loading) {
    return {
      state: "refreshing",
      kind: "good",
      heading: "Workspace connected",
      status: "Online · refreshing",
      description: "The last successful Workspace index remains visible while fresh metadata loads.",
      safety: "No local view is blocked by this refresh.",
      commands: [],
      diagnostic: ""
    };
  }

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

  if (loading) {
    return {
      state: "connecting",
      kind: "warn",
      heading: "Workspace connecting",
      status: "Connecting…",
      description: "Local configuration is already available while encrypted Workspace metadata loads.",
      safety: "No local view is blocked by this connection.",
      commands: [],
      diagnostic: ""
    };
  }

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
