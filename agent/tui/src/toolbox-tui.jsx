import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { createController } from "./controller.mjs";
import {
  SECTIONS,
  PROVIDER_PANELS,
  PROVIDER_TARGETS,
  SKILL_TARGETS,
  TARGETS,
  actionForKey,
  actionLabel,
  actionNeedsConfirmation,
  accountEntries,
  clampSelection,
  componentSummary,
  componentTargetState,
  cycleProviderPanel,
  cycleTarget,
  filterMcpServerEntries,
  filterSkillEntries,
  mcpTargetComparison,
  mcpServerEntries,
  moveSection,
  normalizeSection,
  otherTarget,
  presetEntries,
  providerEntries,
  proxyPresentation,
  promptTargetState,
  safePromptPreviewText,
  sectionDelta,
  selectionDelta,
  selectionDiff,
  selectionWindow,
  skillEntries,
  skillTargetState,
  snippetEntries,
  targetLabel,
  targetReport,
  workspaceConfigured,
  workspacePresentation
} from "./model.mjs";

const COLORS = Object.freeze({
  good: "green",
  warn: "yellow",
  bad: "red",
  muted: "gray",
  value: "white",
  accent: "cyan",
  selected: "magenta",
  codex: "cyan",
  claude: "yellow",
  opencode: "green",
  pi: "magenta",
  builtin: "yellow",
  local: "green",
  cloud: "blue"
});

const SECTION_COLORS = Object.freeze({
  overview: "white",
  agents: "blue",
  accounts: "yellow",
  providers: "magenta",
  mcp: "cyan",
  skills: "green",
  prompts: "yellow",
  snippets: "blue",
  presets: "magenta",
  cloud: "cyan"
});

const COMPONENT_LABELS = Object.freeze({ mcp: "MCP", skills: "Skills", prompts: "Prompts" });

function usage() {
  process.stdout.write(`script-toolbox agent TUI

Usage:
  toolbox-tui [--section <overview|agents|accounts|providers|mcp|skills|prompts|snippets|presets|cloud>]
  toolbox-tui --help

Keys:
  [ / ] / Tab / Shift+Tab / Left / Right
                                    Switch section
  t                                 Switch target (four clients in Providers / Skills)
  r                                 Refresh live status
  Up / Down                         Select previous / next list item
  p / a                             Plan / apply selected configuration
  Prompts: v local · V Workspace    View Prompt content on demand
  u                                 Roll back a preset
  Agents: c / p / Enter unified Providers · x uninstall owned config
  Accounts: a/Enter switch · x delete saved account
  Providers: v views · p plan · a apply · u upload · d download/merge · i incompatible
  Providers (Codex): S observer start/stop · A attach/detach
  MCP: l/w panes · / search · e/x filters · m batch · Space toggle
  Skills: l/w panes · / search · e enabled · m batch · Space toggle
  ?                                 Toggle help
  q                                 Quit
`);
}

function parseArgs(argv) {
  let section = "overview";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") return { help: true, section };
    if (argument === "--section") {
      if (!argv[index + 1]) throw new Error("--section requires a value");
      section = normalizeSection(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return { help: false, section };
}

function Badge({ kind = "muted", children }) {
  return <Text color={COLORS[kind] || COLORS.muted} bold>{children}</Text>;
}

function TargetBadge({ target, selected = false }) {
  const label = targetLabel(target).toUpperCase().padEnd(11);
  return (
    <Text color={COLORS[target] || COLORS.accent} bold inverse={selected}>
      {` ${label} `}
    </Text>
  );
}

function providerStorageMark(entry) {
  if (entry?.syncStatus === "conflict") return "L≠W";
  if (entry?.syncStatus === "backed-up") return "L+W";
  if (entry?.syncStatus === "workspace-only") return "W";
  if (entry?.syncStatus === "local-only") return "L";
  return "B";
}

function providerStorageKind(entry) {
  if (entry?.syncStatus === "conflict") return "bad";
  if (entry?.syncStatus === "backed-up") return "good";
  if (entry?.syncStatus === "workspace-only") return "cloud";
  if (entry?.syncStatus === "local-only") return "local";
  return "builtin";
}

function providerStorageLabel(entry) {
  if (entry?.syncStatus === "conflict") return "LOCAL ≠ WORKSPACE";
  if (entry?.syncStatus === "backed-up") return "LOCAL + WORKSPACE";
  if (entry?.syncStatus === "workspace-only") return "WORKSPACE ONLY";
  if (entry?.syncStatus === "local-only") return "LOCAL ONLY";
  return "BUILT-IN TEMPLATE";
}

function providerSyncDetail(entry) {
  if (entry?.syncStatus === "conflict") {
    return `Choose a winner: u Local → Workspace · d Workspace → Local · differs in ${(entry.syncConflicts || []).join(", ") || "configuration metadata"}`;
  }
  if (entry?.syncStatus === "backed-up") return "Local profile is backed up in Workspace";
  if (entry?.syncStatus === "workspace-only") return "Workspace only · apply directly or press d to install this profile locally";
  if (entry?.syncStatus === "local-only") return "Local only · press u to upload this profile";
  return "Built-in template · applying materializes it locally";
}

function ProviderSourceBadge({ entry, selected = false }) {
  const kind = providerStorageKind(entry);
  const label = providerStorageLabel(entry);
  return (
    <Text color={COLORS[kind] || COLORS.muted} bold inverse={selected}>
      {` ${label} `}
    </Text>
  );
}

function Panel({ title, children, grow = 1, accent = "cyan" }) {
  return (
    <Box borderStyle="round" borderColor={accent} paddingX={1} flexGrow={grow} flexDirection="column">
      <Text bold color={accent}>{title}</Text>
      {children}
    </Box>
  );
}

function Row({ label, value, kind = "value" }) {
  return (
    <Box gap={1}>
      <Text color="gray">{String(label).padEnd(18)}</Text>
      <Text color={COLORS[kind] || COLORS.value}>{value}</Text>
    </Box>
  );
}

function SummaryRow({ name, summary }) {
  return (
    <Box>
      <Box width={12} flexShrink={0}><Text bold color="white">{name}</Text></Box>
      <Box width={14} flexShrink={0}><Badge kind={summary.kind}>{summary.label}</Badge></Box>
      <Box flexGrow={1}><Text color="white">{summary.detail}</Text></Box>
    </Box>
  );
}

function TargetStatusRow({ state, selected }) {
  const count = state.items.length;
  const selection = state.selection === "custom" && state.baseSelection
    ? `custom · base ${state.baseSelection}`
    : state.selection;
  return (
    <Box gap={1}>
      <TargetBadge target={state.target} selected={selected} />
      <Badge kind={state.summary.kind}>{state.summary.label.padEnd(11)}</Badge>
      <Text color="white" bold>{selection}</Text>
      <Text color="gray">· {count} {count === 1 ? "server" : "servers"}</Text>
    </Box>
  );
}

function ItemGroup({ label, items, kind = "value" }) {
  return (
    <Row
      label={`${label} (${items.length})`}
      value={items.length > 0 ? items.join(", ") : "none"}
      kind={items.length > 0 ? kind : "muted"}
    />
  );
}

function displayPath(value) {
  const path = String(value || "");
  const home = process.env.HOME || "";
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path || "not available";
}

function PromptStatusRow({ state, selected }) {
  return (
    <Box gap={1}>
      <TargetBadge target={state.target} selected={selected} />
      <Badge kind={state.summary.kind}>{state.summary.label.padEnd(11)}</Badge>
      <Text color="white" bold>{state.selection}</Text>
      <Text color={state.managed ? "green" : "yellow"}>
        · {state.managed ? "managed" : "not managed"}
      </Text>
    </Box>
  );
}

function ErrorText({ value }) {
  if (!value) return null;
  return <Text color="red" wrap="truncate-end">{String(value).split("\n")[0]}</Text>;
}

function accountSummary(snapshot) {
  const accounts = snapshot?.accounts || {};
  const active = accounts.active || {};
  const state = active.saved_as
    ? active.saved_as
    : active.official_login ? "current login is unsaved" : "not logged in";
  return {
    value: `${accounts.account_count || 0} saved · ${state}`,
    kind: active.saved_as ? "good" : active.official_login ? "warn" : "muted"
  };
}

function WorkspaceCatalogFallback({ snapshot }) {
  return snapshot.workspaceLoading
    ? <Text color="yellow">Workspace is connecting in the background; local state is already available.</Text>
    : <Text color="gray">Connect a Workspace to browse remote selections.</Text>;
}

function LoadingView() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Loading local state…</Text>
      <Text color="white">Reading local agent, account, Provider, MCP, Skills, Prompt, and Preset metadata.</Text>
      <Text color="gray">No local or remote configuration is being changed.</Text>
    </Box>
  );
}

function Overview({ snapshot, target }) {
  const report = targetReport(snapshot, target);
  const workspace = snapshot.workspace;
  const connection = workspace || snapshot.workspaceConnection;
  const cloud = workspacePresentation(workspace, snapshot.workspaceError, snapshot.workspaceLoading);
  const accounts = accountSummary(snapshot);
  if (!report) {
    return (
      <Box flexDirection="column">
        <ErrorText value={snapshot?.doctorError || "Diagnostics unavailable"} />
        <Row label="Workspace" value={cloud.status} kind={cloud.kind} />
        {connection?.endpoint && <Row label="Endpoint" value={connection.endpoint} />}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {target === "codex" && (
        <SummaryRow name="Identity" summary={componentSummary("identity", report.provider)} />
      )}
      {target === "codex" && (
        <Row label="Saved accounts" value={accounts.value} kind={accounts.kind} />
      )}
      <SummaryRow name="Inference" summary={componentSummary("inference", report.provider)} />
      <SummaryRow name="MCP" summary={componentSummary("mcp", report.mcp)} />
      <SummaryRow name="Skills" summary={componentSummary("skills", report.skills)} />
      <SummaryRow name="Prompts" summary={componentSummary("prompts", report.prompt)} />
      <Row label="Snippets" value={`${Array.isArray(snapshot.snippets) ? snapshot.snippets.length : 0} local`} />
      <Row label="Preset" value={`${report.preset?.name || "none"}${report.preset?.drift ? " (drift)" : ""}`} kind={report.preset?.drift ? "bad" : "muted"} />
      <Row label="Secrets" value={snapshot.doctor?.secrets?.ok ? "available" : "missing or incomplete"} kind={snapshot.doctor?.secrets?.ok ? "good" : "bad"} />
      <Row
        label="Remotes"
        value={snapshot.workspaceLoading
          ? "checking in background"
          : `${Object.values(snapshot.doctor?.remote || {}).filter((value) => value.ok).length}/3 available`}
        kind={snapshot.workspaceLoading ? "warn" : "value"}
      />
      <Row label="Workspace" value={workspace ? `${workspace.latest?.version || "empty"} · ${workspace.web_ui_enabled ? "web on" : "web off"}` : cloud.status} kind={cloud.kind} />
      {workspace && <Row
        label="Provider backup"
        value={workspace.agent?.synced
          ? `${workspace.agent.profiles || 0} profile(s) · ${workspace.agent.secrets || 0} hidden Secret value(s)`
          : "not backed up"}
        kind={workspace.agent?.synced ? "cloud" : "muted"}
      />}
      {connection?.endpoint && <Row label="Endpoint" value={connection.endpoint} />}
    </Box>
  );
}

function Agents({ snapshot, selected }) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (agents.length === 0) return <ErrorText value={snapshot.agentsError || snapshot.doctorError || "No agent status"} />;
  const safeIndex = clampSelection(selected, agents.length);
  const current = agents[safeIndex];
  const accounts = accountSummary(snapshot);
  return (
    <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
      <Box flexDirection="column" minWidth={24}>
        {agents.map((agent, index) => (
          <Text key={agent.client} color={index === safeIndex ? "cyan" : undefined} bold={index === safeIndex}>
            {index === safeIndex ? "> " : "  "}{agent.label || agent.client}
            {agent.cli_installed ? "" : " (not installed)"}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>{current.label || current.client}</Text>
        {current.client === "codex" && (
          <SummaryRow name="Identity" summary={componentSummary("identity", { ok: true, data: current })} />
        )}
        {current.client === "codex" && (
          <Row label="Saved accounts" value={accounts.value} kind={accounts.kind} />
        )}
        <SummaryRow name="Inference" summary={componentSummary("inference", { ok: true, data: current })} />
        <Row label="CLI" value={current.cli_installed ? current.cli_version || "installed" : "not installed"} kind={current.cli_installed ? "good" : "bad"} />
        {targetReport(snapshot, current.client) && <Row label="Preset" value={targetReport(snapshot, current.client)?.preset?.name || "none"} kind={targetReport(snapshot, current.client)?.preset?.drift ? "bad" : "muted"} />}
        <Text color="gray">
          <Text color="cyan" bold>c/p/Enter</Text> unified Providers · <Text color="red" bold>x</Text> uninstall owned config
        </Text>
      </Box>
    </Box>
  );
}

function AccountsView({ snapshot, selected }) {
  const entries = accountEntries(snapshot);
  const safeIndex = clampSelection(selected, entries.length);
  const visible = selectionWindow(entries, safeIndex, 10);
  const current = entries[safeIndex] || null;
  const active = snapshot.accounts?.active || {};
  return (
    <Box flexDirection="column">
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" minWidth={30}>
          <Text color="gray">
            Saved accounts {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total}
          </Text>
          {visible.items.map(({ item, index }) => (
            <Box key={item.name} gap={1}>
              <Text color={index === safeIndex ? "white" : "gray"} bold={index === safeIndex}>
                {index === safeIndex ? "›" : " "}
              </Text>
              <Text color={item.current ? "green" : index === safeIndex ? "yellow" : "white"} bold={index === safeIndex || item.current}>
                {item.name}
              </Text>
              {item.current && <Text color="green">● current</Text>}
            </Box>
          ))}
          {entries.length === 0 && <Text color="gray">(no saved official accounts)</Text>}
        </Box>
        <Box borderStyle="single" borderColor={current?.current ? "green" : "yellow"} paddingX={1} flexDirection="column" flexGrow={1}>
          <Text bold color="yellow">{current?.name || "Codex official accounts"}</Text>
          <Row
            label="Live login"
            value={active.saved_as || (active.official_login ? "unsaved official account" : active.status || "not logged in")}
            kind={active.official_login ? active.saved_as ? "good" : "warn" : "muted"}
          />
          {current ? (
            <>
              <Row label="State" value={current.current ? "active" : "saved"} kind={current.current ? "good" : "local"} />
              <Row label="Saved" value={current.savedAt ? new Date(current.savedAt).toLocaleString() : "unknown"} />
              <Row label="Credential" value={current.credentialPrivate ? "owner-only snapshot" : "unsafe permissions"} kind={current.credentialPrivate ? "good" : "bad"} />
              <Text color="gray">
                <Text color="yellow" bold>a/Enter</Text> switch or refresh · <Text color="red" bold>x</Text> delete non-current snapshot
              </Text>
            </>
          ) : (
            <>
              <Text color="gray">Save the current ChatGPT login with an explicit local label:</Text>
              <Text color="cyan">agentctl account save primary --yes</Text>
            </>
          )}
        </Box>
      </Box>
      <Row label="Store" value={displayPath(snapshot.accounts?.store)} kind="local" />
      <Text color="gray">Account switching changes only auth.json; the selected inference Provider and Model remain unchanged.</Text>
      <ErrorText value={snapshot.accountsError} />
    </Box>
  );
}

function metricCount(value) {
  try {
    return new Intl.NumberFormat("en-US").format(BigInt(value ?? 0));
  } catch {
    return String(value ?? 0);
  }
}

function estimatedCosts(costs) {
  const values = Object.entries(costs || {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return values.length
    ? values.map(([currency, total]) => `${total} ${currency}`).join(" · ")
    : "unavailable";
}

function ProxyUsageSummary({ value }) {
  const usage = value || {};
  const requests = Number(usage.requests || 0);
  const priced = Number(usage.priced_requests || 0);
  const unpriced = Number(usage.unpriced_requests || 0);
  const tokens = usage.tokens || {};
  const tiers = usage.service_tiers || {};
  if (requests === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold color="cyan">Observed usage</Text>
        <Row
          label="Requests"
          value="No retained proxy usage yet"
          kind="muted"
        />
        <Text color="gray">Start and attach passthrough, then run Codex to collect token and cost estimates.</Text>
      </Box>
    );
  }
  const fastRequested = Number(tiers.fast_requested || 0);
  const fastEffective = Number(tiers.fast_effective || 0);
  const fastDowngraded = Number(tiers.fast_downgraded || 0);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">Observed usage</Text>
      <Row
        label="Requests"
        value={`${metricCount(requests)} retained · ${metricCount(priced)} priced · ${metricCount(unpriced)} unpriced`}
        kind={unpriced > 0 ? "warn" : "good"}
      />
      <Row
        label="Estimated API cost"
        value={estimatedCosts(usage.costs)}
        kind={priced > 0 ? "good" : "warn"}
      />
      <Row
        label="Tokens"
        value={`in ${metricCount(tokens.input)} · cache ${metricCount(tokens.cache_read)}/${metricCount(tokens.cache_write)} · out ${metricCount(tokens.output)}`}
      />
      <Row
        label="Fast tier"
        value={`${metricCount(fastRequested)} requested · ${metricCount(fastEffective)} effective · ${metricCount(fastDowngraded)} downgraded`}
        kind={fastDowngraded > 0 ? "warn" : fastEffective > 0 ? "good" : "muted"}
      />
      {usage.window?.from && (
        <Row
          label="Usage window"
          value={`${usage.window.from} → ${usage.window.to || usage.window.from}`}
          kind="muted"
        />
      )}
      <Text color="gray">API-equivalent catalog estimate; not a ChatGPT subscription invoice.</Text>
    </Box>
  );
}

function ProviderPanelTabs({ value }) {
  const labels = {
    summary: "SUMMARY",
    config: "CONFIG",
    runtime: "RUNTIME",
    usage: "USAGE"
  };
  return (
    <Box gap={1} flexWrap="wrap">
      {PROVIDER_PANELS.map((panel) => (
        <Text
          key={panel}
          color={value === panel ? "black" : "cyan"}
          backgroundColor={value === panel ? "cyan" : undefined}
          bold={value === panel}
        >
          {` ${labels[panel]} `}
        </Text>
      ))}
    </Box>
  );
}

function ProvidersView({ snapshot, surface, selected, target, showIncompatible, panelMode }) {
  const shortTerminal = Boolean(process.stdout.rows && process.stdout.rows < 34);
  const allEntries = providerEntries(surface.local, surface.cloud, { includeIncompatible: true });
  const entries = showIncompatible
    ? allEntries
    : providerEntries(surface.local, surface.cloud);
  const safeIndex = clampSelection(selected, entries.length);
  const visible = selectionWindow(entries, safeIndex, shortTerminal ? 5 : 8);
  const current = entries[safeIndex] || null;
  const dashboard = surface.dashboard || {};
  const localStatus = dashboard.status || {};
  const failover = dashboard.failover || {};
  const pricing = dashboard.pricing || {};
  const proxy = dashboard.proxy || {};
  const proxyUsage = dashboard.proxyUsage || {};
  const remote = snapshot.workspace?.agent || {};
  const runtime = Array.isArray(snapshot.agents)
    ? snapshot.agents.find((agent) => agent.client === target) || null
    : null;
  const observerAttachmentPresent = proxy.attachment?.attached === true;
  const officialSubscription = target === "codex" && (
    runtime?.inference?.source === "official-account" ||
    (proxy.mode === "openai_subscription_passthrough" && observerAttachmentPresent)
  );
  const proxyState = proxyPresentation(proxy, { officialSubscription });
  const hiddenCount = allEntries.length - providerEntries(surface.local, surface.cloud).length;
  const backedUpCount = allEntries.filter((entry) => entry.syncStatus === "backed-up").length;
  const conflictCount = allEntries.filter((entry) => entry.syncStatus === "conflict").length;
  const stateKind = !current?.enabled
    ? "muted"
    : current?.ready
      ? "good"
      : current?.nativeAuthPresent ? "local"
        : current?.compatible ? "warn" : "bad";
  const profilesVisible = panelMode === "summary";
  const configVisible = panelMode === "config";
  const runtimeVisible = panelMode === "runtime";
  const usageVisible = panelMode === "usage";
  return (
    <Box flexDirection="column">
      {!shortTerminal && (
        <Box gap={1} marginBottom={1}>
          <Text color="gray">Render target</Text>
          {PROVIDER_TARGETS.map((entry) => (
            <TargetBadge key={entry} target={entry} selected={entry === target} />
          ))}
          <Text color="gray">t cycle</Text>
        </Box>
      )}
      <ProviderPanelTabs value={panelMode} />
      {profilesVisible && runtime && !shortTerminal && (
        <Box flexDirection="column" marginTop={1}>
          {target === "codex" && (
            <SummaryRow name="Identity" summary={componentSummary("identity", { ok: true, data: runtime })} />
          )}
          <SummaryRow name="Inference" summary={componentSummary("inference", { ok: true, data: runtime })} />
        </Box>
      )}
      {profilesVisible && officialSubscription && !shortTerminal && (
        <Text color="green" bold>
          {proxyState.attached
            ? "Official ChatGPT subscription observed · Codex → observer → OpenAI."
            : `Official ChatGPT subscription active · ${runtime?.inference?.model || "OpenAI model"}.`}
        </Text>
      )}
      {profilesVisible && (
        <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 98 ? "column" : "row"}>
          <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" minWidth={34}>
            <Text color="gray">
              Profiles {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total} · {allEntries.length} total · {backedUpCount} backed up{conflictCount > 0 ? ` · ${conflictCount} conflict` : ""}
            </Text>
            {visible.items.map(({ item, index }) => (
              <Box key={item.key} gap={1}>
                <Text color={index === safeIndex ? "white" : "gray"} bold={index === safeIndex}>
                  {index === safeIndex ? "›" : " "}
                </Text>
                <Text color={COLORS[providerStorageKind(item)]} bold>{providerStorageMark(item).padEnd(3)}</Text>
                <Text color={index === safeIndex ? "magenta" : "white"} bold={index === safeIndex}>
                  {item.name}
                </Text>
                {item.applied && <Text color="green">●</Text>}
                {!item.applied && item.nativeSelected && <Text color="cyan">◇</Text>}
                {item.nativeAuthPresent && <Text color="cyan">native auth</Text>}
                {(!item.enabled || !item.compatible) && <Text color="gray">incompatible</Text>}
              </Box>
            ))}
            {entries.length === 0 && !surface.loading && <Text color="gray">(no Provider profiles)</Text>}
            {hiddenCount > 0 && (
              <Text color="gray">
                {showIncompatible ? "i hide incompatible" : `${hiddenCount} incompatible hidden · i show`}
              </Text>
            )}
          </Box>
          {!shortTerminal && <Box borderStyle="single" borderColor={current ? COLORS[providerStorageKind(current)] : "gray"} paddingX={1} flexDirection="column" flexGrow={1}>
            <Box gap={1}>
              <Text color="gray">Selected</Text>
              {current && <ProviderSourceBadge entry={current} />}
            </Box>
            <Text bold color="magenta">{current?.name || "none"}</Text>
            {current ? (
              <>
                <Row label="State" value={current.status || (!current.enabled ? "disabled" : current.ready ? "ready" : "blocked")} kind={stateKind} />
                <Row label="Backup state" value={providerSyncDetail(current)} kind={providerStorageKind(current)} />
                <Row label="Model" value={`${current.requestedModel || "unknown"} → ${current.outboundModel || "unknown"}`} />
                <Row label="Endpoint" value={current.endpoint || "unknown"} />
                <Row
                  label="Applied"
                  value={current.applied
                    ? "current under agentctl"
                    : current.nativeSelected ? "current in OpenCode · external" : "not current under agentctl"}
                  kind={current.applied ? "good" : current.nativeSelected ? "local" : "muted"}
                />
                {current.issue && <Row label="Blocked by" value={current.issue} kind="bad" />}
              </>
            ) : (
              <Text color="gray">Initialize locally or back up a Provider bundle to Workspace.</Text>
            )}
          </Box>}
        </Box>
      )}
      {profilesVisible && shortTerminal && (
        <Row
          label="Selected"
          value={current
            ? `${current.name} · ${current.status || (!current.enabled ? "disabled" : current.ready ? "ready" : "blocked")} · ${current.requestedModel || "unknown"}`
            : "none"}
          kind={current ? stateKind : "muted"}
        />
      )}
      {!profilesVisible && (
        <Row
          label="Selected profile"
          value={current ? `${providerStorageMark(current)} ${current.name}` : "none"}
          kind={current ? providerStorageKind(current) : "muted"}
        />
      )}
      {configVisible && current && (
        <Box flexDirection="column" marginTop={1}>
          {!shortTerminal && <Row label="Target" value={`${targetLabel(target)} · ${current.platform || dashboard.platform || "unknown"}`} kind={target} />}
          <Row
            label="State"
            value={`${current.status || (!current.enabled ? "disabled" : current.ready ? "ready" : "blocked")}${shortTerminal ? ` · ${current.platform || dashboard.platform || "unknown"}` : ""}`}
            kind={stateKind}
          />
          <Row label="Protocol" value={current.protocol || "unknown"} />
          <Row label="Endpoint" value={current.endpoint || "unknown"} />
          <Row label="Model" value={`${current.requestedModel || "unknown"} → ${current.outboundModel || "unknown"}`} />
          <Row
            label="Compaction"
            value={current.compactionLabel || "Local · upstream unverified"}
            kind={current.compactionMode === "remote_native" || current.compactionMode === "messages_native"
              ? "good"
              : current.compactionPolicy === "local" ? "local" : "muted"}
          />
          <Row
            label="Context"
            value={current.contextLabel || "Client default"}
            kind={current.contextWindowTokens !== null || current.autoCompactTokens !== null ? "good" : "muted"}
          />
          {!shortTerminal && current.modelsAvailable.length > 0 && <Row label="Model choices" value={current.modelsAvailable.join(", ")} />}
          <Row
            label="Provider Secret"
            value={current.authMode === "none"
              ? "not required"
              : `${current.secretReference || "missing reference"} · ${current.secretPresent ? "present" : "missing"}`}
            kind={current.authMode === "none" || current.secretPresent ? "good" : "warn"}
          />
          {current.nativeAuthPresent && <Row label="Native client auth" value={`OpenCode · ${current.nativeAuthProvider || "provider"}${current.nativeAuthType ? ` (${current.nativeAuthType})` : ""}`} kind="local" />}
          {current.nativeSelected && <Row label="Native selection" value={current.nativeSelectedModel || "selected by OpenCode"} kind="local" />}
          {current.officialIdentityPolicy === "preserve" && <Row label="Official Identity" value="preserve ChatGPT login · auth.json untouched" kind="good" />}
          {current.issue && <Row label="Blocked by" value={current.issue} kind="bad" />}
        </Box>
      )}
      {runtimeVisible && (
        <Box flexDirection="column" marginTop={1}>
          {runtime && target === "codex" && <SummaryRow name="Identity" summary={componentSummary("identity", { ok: true, data: runtime })} />}
          {runtime && <SummaryRow name="Inference" summary={componentSummary("inference", { ok: true, data: runtime })} />}
          <Row label="Local catalog" value={localStatus.store_exists ? `${localStatus.profile_count || 0} profile(s) · ${localStatus.secret_count || 0} Secret value(s)` : "not initialized"} kind={localStatus.store_exists ? "local" : "muted"} />
          <Row label="Workspace backup" value={remote.synced ? `${remote.profiles || 0} profile(s) · ${remote.secrets || 0} hidden Secret value(s)` : "not backed up"} kind={remote.synced ? "cloud" : "muted"} />
          <Row label="Failover" value={`${failover.routes || 0} local / ${remote.failover_routes || 0} cloud route(s)`} />
          <Row label="Pricing" value={`${pricing.version || "none"} · ${pricing.rates || 0} local / ${remote.pricing_rates || 0} cloud rate(s)`} />
          <Row label="Codex observer" value={proxyState.observerLabel} kind={proxyState.observerKind} />
          <Row label="Attachment" value={proxyState.attachmentLabel} kind={proxyState.attachmentKind} />
          <Row label="Request path" value={proxyState.routeLabel} kind={proxyState.routeKind} />
        </Box>
      )}
      {usageVisible && (
        <Box flexDirection="column" marginTop={1}>
          <Row label="Codex observer" value={proxyState.observerLabel} kind={proxyState.observerKind} />
          <Row label="Attachment" value={proxyState.attachmentLabel} kind={proxyState.attachmentKind} />
          <Row label="Request path" value={proxyState.routeLabel} kind={proxyState.routeKind} />
          <ProxyUsageSummary value={proxyUsage} />
        </Box>
      )}
      {surface.loading && <Text color="gray">◌ Loading remaining local or encrypted Workspace Provider data…</Text>}
      {!snapshot.workspace && snapshot.workspaceLoading && (
        <Text color="yellow">{shortTerminal
          ? "Workspace connecting; local profiles remain usable."
          : "Workspace Providers are connecting in the background; local profiles remain usable."}</Text>
      )}
      <ErrorText value={surface.localError} />
      <ErrorText value={surface.cloudError} />
      {(dashboard.errors || []).map((error) => <ErrorText key={error} value={error} />)}
      {shortTerminal ? (
        <Text color="gray">
          ↑/↓ select · <Text color="cyan" bold>p</Text>/<Text color="magenta" bold>a</Text> plan/apply · <Text color="yellow" bold>i</Text> filter · <Text color="cyan" bold>v</Text> view · <Text color="green" bold>u</Text>/<Text color="blue" bold>d</Text> sync
        </Text>
      ) : (<>
        <Text color="gray">
          ↑/↓ profile · <Text color="cyan" bold>p</Text> plan · <Text color="magenta" bold>a</Text> apply · <Text color="yellow" bold>i</Text> incompatible · <Text color="cyan" bold>v</Text> next view
        </Text>
        <Text color="gray">
          <Text color="green" bold>u</Text> keep Local → Workspace · <Text color="blue" bold>d</Text> keep Workspace → Local
          {target === "codex" && <>
            {" · "}<Text color="cyan" bold>S</Text> observer · <Text color="green" bold>A</Text> attach
          </>}
        </Text>
      </>)}
    </Box>
  );
}

function CloudCatalog({
  catalog,
  selected,
  target,
  component,
  currentSelection = "",
  currentItems = []
}) {
  if (catalog.loading) return <Text color="gray">Decrypting this catalog in memory…</Text>;
  if (catalog.error) return <ErrorText value={catalog.error} />;
  if (!catalog.items.length) return <Text color="gray">No cloud selections in this Store.</Text>;
  const safeIndex = clampSelection(selected, catalog.items.length);
  const item = catalog.items[safeIndex];
  const visible = selectionWindow(catalog.items, safeIndex);
  const catalogLabel = component === "mcp"
    ? "MCP profiles"
    : component === "skills" ? "Skill packs" : "Prompt profiles";
  const diff = component === "skills" ? selectionDiff(currentItems, item.items) : null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        <Text bold color="cyan">Workspace {catalogLabel}</Text>
        <Text color="gray">for</Text>
        <TargetBadge target={target} selected />
      </Box>
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" minWidth={30}>
          <Text color="gray">
            {component === "skills" ? "Packs" : "Profiles"} {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total}
          </Text>
          {visible.items.map(({ item: entry, index }) => (
            <Text key={entry.name} color={index === safeIndex ? "magenta" : "white"} bold={index === safeIndex}>
              {index === safeIndex ? "› " : "  "}{entry.name}
            </Text>
          ))}
        </Box>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="gray">Selected {component === "skills" ? "pack" : "profile"}</Text>
          <Text bold color="magenta">{item.name}</Text>
          <Row label="Includes" value={`${item.count} ${item.unit}`} />
          {item.clients?.length > 0 && <Row label="Available to" value={item.clients.map(targetLabel).join(", ")} />}
          {item.description && <Row label="About" value={item.description} />}
          {diff && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan" bold>Current → Selected</Text>
              <Row
                label="Pack"
                value={`${currentSelection || "none"} → ${item.name}`}
                kind={currentSelection === item.name ? "good" : "selected"}
              />
              {item.packs?.length > 0 && <Row label="Inheritance" value={item.packs.join(" → ")} kind="muted" />}
              <ItemGroup label="Add" items={diff.added} kind="good" />
              <ItemGroup label="Remove" items={diff.removed} kind="bad" />
              <ItemGroup label="Keep" items={diff.unchanged} kind="muted" />
            </Box>
          )}
        </Box>
      </Box>
      <Text color="gray">
        ↑/↓ select · <Text color="cyan" bold>p</Text> inspect plan · <Text color="magenta" bold>a</Text> apply to {targetLabel(target)} only
      </Text>
    </Box>
  );
}

function LocalMcpCatalog({
  target,
  catalog,
  entries,
  selectedName,
  staged,
  batchMode,
  query,
  filter,
  grouped,
  searching
}) {
  if (catalog.loading && catalog.items.length === 0) {
    return <Text color="gray">Loading the local MCP catalog…</Text>;
  }
  if (catalog.error && catalog.items.length === 0) return <ErrorText value={catalog.error} />;
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No local MCP servers match the current search or filter.</Text>
        <Text color="gray">Press Esc while searching, or toggle e/x to return to all servers.</Text>
      </Box>
    );
  }
  const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.name === selectedName));
  const item = entries[selectedIndex];
  const visible = selectionWindow(entries, selectedIndex, 9);
  const activeCount = catalog.activeCount || 0;
  const other = otherTarget(target);
  const stagedMap = staged instanceof Map ? staged : new Map();
  const selectedDesired = stagedMap.has(item.name) ? stagedMap.get(item.name) : item.enabled;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1} flexWrap="wrap">
        <Text color={searching ? "black" : "cyan"} backgroundColor={searching ? "cyan" : undefined} bold>
          {` / ${query || (searching ? "type to search" : "search")} `}
        </Text>
        <Text color={filter === "enabled" ? "black" : "green"} backgroundColor={filter === "enabled" ? "green" : undefined} bold>
          {" e ENABLED "}
        </Text>
        <Text color={filter === "problems" ? "black" : "red"} backgroundColor={filter === "problems" ? "red" : undefined} bold>
          {" x PROBLEMS "}
        </Text>
        <Text color={grouped ? "black" : "yellow"} backgroundColor={grouped ? "yellow" : undefined} bold>
          {" g GROUP "}
        </Text>
        <Text color={batchMode ? "black" : "magenta"} backgroundColor={batchMode ? "magenta" : undefined} bold>
          {` m BATCH${stagedMap.size > 0 ? ` ${stagedMap.size}` : ""} `}
        </Text>
      </Box>
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 94 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" minWidth={34}>
          <Text color="gray">
            Local servers {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total} · {activeCount} active
          </Text>
          {visible.items.map(({ item: entry, index }) => {
            const stagedDesired = stagedMap.get(entry.name);
            const marker = stagedMap.has(entry.name)
              ? stagedDesired ? "+" : "−"
              : entry.suppressed ? "×" : entry.enabled ? "●" : "○";
            const markerColor = stagedMap.has(entry.name)
              ? stagedDesired ? "green" : "red"
              : entry.suppressed ? "red" : entry.enabled ? "green" : "gray";
            const readiness = entry.ready === false ? "!" : entry.ready === true ? "✓" : "?";
            return (
              <Box key={entry.name} gap={1}>
                <Text color={index === selectedIndex ? "white" : "gray"} bold={index === selectedIndex}>
                  {index === selectedIndex ? "›" : " "}
                </Text>
                <Text color={markerColor} bold>{marker}</Text>
                <Text color={index === selectedIndex ? "cyan" : "white"} bold={index === selectedIndex}>
                  {entry.name}
                </Text>
                <Text color={entry.ready === false ? "red" : entry.ready === true ? "green" : "gray"}>{readiness}</Text>
                {entry.otherEnabled && !entry.enabled && <Text color={COLORS[other]}>[{targetLabel(other)}]</Text>}
              </Box>
            );
          })}
        </Box>
        <Box borderStyle="single" borderColor={item.enabled ? "green" : "gray"} paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="gray">Selected local server</Text>
          <Text bold color="cyan">{item.name}</Text>
          <Row
            label={targetLabel(target)}
            value={stagedMap.has(item.name)
              ? `${selectedDesired ? "enable" : "disable"} staged`
              : item.suppressed ? "disabled override" : item.enabled ? "enabled" : "disabled"}
            kind={stagedMap.has(item.name) ? "selected" : item.enabled ? "good" : item.suppressed ? "bad" : "muted"}
          />
          <Row
            label={targetLabel(other)}
            value={item.otherEnabled ? "enabled" : "disabled"}
            kind={item.otherEnabled ? other : "muted"}
          />
          {item.category && <Row label="Category" value={item.category} />}
          {item.variantGroup && <Row label="Alternative group" value={item.variantGroup} kind="warn" />}
          <Row
            label="Readiness"
            value={item.ready === false ? "requirements missing" : item.ready === true ? "host ready" : "not checked"}
            kind={item.ready === false ? "bad" : item.ready === true ? "good" : "muted"}
          />
          {item.issues.slice(0, 3).map((issue, index) => (
            <Row key={`${item.name}-issue-${index}`} label={index === 0 ? "Issue" : ""} value={issue} kind="bad" />
          ))}
          {item.description && <Row label="About" value={item.description} />}
          {item.setup && <Row label="Setup" value={item.setup} kind="muted" />}
        </Box>
      </Box>
      <ErrorText value={catalog.error} />
      <Text color="gray">
        ↑/↓ · <Text color="magenta" bold>Space</Text> {batchMode ? "stage" : selectedDesired ? "disable" : "enable"} · {batchMode ? <><Text bold>a</Text> apply · <Text bold>c</Text> clear · </> : null}<Text bold>s/S/u</Text> save/update/backup · ● active · ○ inactive · × override · ! setup
      </Text>
    </Box>
  );
}

function McpView({
  snapshot,
  target,
  catalog,
  selected,
  localCatalog,
  localEntries,
  selectedServerName,
  focus,
  staged,
  batchMode,
  query,
  filter,
  grouped,
  searching
}) {
  const comparison = mcpTargetComparison(snapshot);
  const active = comparison.targets[target];
  const repairable = active?.drift?.length > 0 &&
    active?.data?.selection_mode !== "manual" &&
    active?.selection && active.selection !== "none";
  const baseServers = new Set(Array.isArray(active?.data?.base_servers) ? active.data.base_servers : []);
  const currentServers = new Set(active?.items || []);
  const customAdded = [...currentServers].filter((name) => !baseServers.has(name));
  const customDisabled = [...baseServers].filter((name) => !currentServers.has(name));
  return (
    <Box flexDirection="column">
      <Text color="gray">The highlighted client receives target-specific local and Workspace actions.</Text>
      {TARGETS.map((entry) => (
        <TargetStatusRow
          key={entry}
          state={comparison.targets[entry]}
          selected={entry === target}
        />
      ))}
      <Box gap={1} marginTop={1}>
        <Text color={focus === "local" ? "black" : "cyan"} backgroundColor={focus === "local" ? "cyan" : undefined} bold>
          {" l LOCAL SWITCHES "}
        </Text>
        <Text color={focus === "workspace" ? "black" : "blue"} backgroundColor={focus === "workspace" ? "blue" : undefined} bold>
          {" w WORKSPACE PROFILES "}
        </Text>
        <Text color="gray">{comparison.shared.length} shared · {comparison.only.codex.length} Codex only · {comparison.only.claude.length} Claude only</Text>
      </Box>
      {active?.data?.selection_mode === "manual" && (
        <Box flexDirection="column">
          <ItemGroup label="Custom added" items={customAdded} kind="good" />
          <ItemGroup label="Custom disabled" items={customDisabled} kind="bad" />
          <Text color="gray"><Text bold>s</Text> save new · <Text bold>S</Text> update base for this target · <Text bold>u</Text> encrypted Store backup after saving</Text>
        </Box>
      )}
      {TARGETS.map((entry) => (
        <ErrorText
          key={`${entry}-error`}
          value={!comparison.targets[entry].check?.ok
            ? `${targetLabel(entry)}: ${comparison.targets[entry].check?.summary || comparison.targets[entry].check?.error || snapshot.doctorError || "status unavailable"}`
            : ""}
        />
      ))}
      {repairable && (
        <Text color="yellow">
          <Text bold>f</Text> repair current local profile {active.selection} for {targetLabel(target)} · replaces same-name MCP entries only
        </Text>
      )}
      {active?.drift?.length > 0 && !repairable && (
        <Text color="yellow">Current MCP selection uses manual state; apply a named profile before automatic repair.</Text>
      )}
      {focus === "local"
        ? <LocalMcpCatalog
            target={target}
            catalog={localCatalog}
            entries={localEntries}
            selectedName={selectedServerName}
            staged={staged}
            batchMode={batchMode}
            query={query}
            filter={filter}
            grouped={grouped}
            searching={searching}
          />
        : snapshot.workspace
          ? <CloudCatalog catalog={catalog} selected={selected} target={target} component="mcp" />
          : <WorkspaceCatalogFallback snapshot={snapshot} />}
    </Box>
  );
}

function LocalSkillsCatalog({
  target,
  dashboard,
  entries,
  selectedName,
  staged,
  batchMode,
  query,
  enabledOnly,
  searching
}) {
  if (dashboard.loading && dashboard.catalog.length === 0) {
    return <Text color="gray">Loading the local Skills catalog…</Text>;
  }
  if (dashboard.error && dashboard.catalog.length === 0) return <ErrorText value={dashboard.error} />;
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No local Skills match the current search or filter.</Text>
        <Text color="gray">Press Esc while searching, or toggle e to return to all Skills.</Text>
      </Box>
    );
  }
  const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.name === selectedName));
  const item = entries[selectedIndex];
  const visible = selectionWindow(entries, selectedIndex, 9);
  const stagedMap = staged instanceof Map ? staged : new Map();
  const selectedDesired = stagedMap.has(item.name) ? stagedMap.get(item.name) : item.enabled;
  const activeCount = skillTargetState(dashboard.states, target).skills.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1} flexWrap="wrap">
        <Text color={searching ? "black" : "green"} backgroundColor={searching ? "green" : undefined} bold>
          {` / ${query || (searching ? "type to search" : "search")} `}
        </Text>
        <Text color={enabledOnly ? "black" : "green"} backgroundColor={enabledOnly ? "green" : undefined} bold>
          {" e ENABLED "}
        </Text>
        <Text color={batchMode ? "black" : "magenta"} backgroundColor={batchMode ? "magenta" : undefined} bold>
          {` m BATCH${stagedMap.size > 0 ? ` ${stagedMap.size}` : ""} `}
        </Text>
      </Box>
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 94 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="green" paddingX={1} flexDirection="column" minWidth={36}>
          <Text color="gray">
            Local Skills {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total} · {activeCount} active
          </Text>
          {visible.items.map(({ item: entry, index }) => {
            const stagedDesired = stagedMap.get(entry.name);
            const marker = stagedMap.has(entry.name)
              ? stagedDesired ? "+" : "−"
              : entry.enabled ? "●" : "○";
            const markerColor = stagedMap.has(entry.name)
              ? stagedDesired ? "green" : "red"
              : entry.enabled ? "green" : "gray";
            return (
              <Box key={entry.name} gap={1}>
                <Text color={index === selectedIndex ? "white" : "gray"} bold={index === selectedIndex}>
                  {index === selectedIndex ? "›" : " "}
                </Text>
                <Text color={markerColor} bold>{marker}</Text>
                <Text color={index === selectedIndex ? "green" : "white"} bold={index === selectedIndex}>
                  {entry.name}
                </Text>
                {!entry.enabled && entry.enabledTargets.slice(0, 2).map((client) => (
                  <Text key={`${entry.name}-${client}`} color={COLORS[client]}>[{targetLabel(client)}]</Text>
                ))}
              </Box>
            );
          })}
        </Box>
        <Box borderStyle="single" borderColor={item.enabled ? "green" : "gray"} paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="gray">Selected canonical Skill</Text>
          <Text bold color="green">{item.name}</Text>
          <Row
            label={targetLabel(target)}
            value={stagedMap.has(item.name)
              ? `${selectedDesired ? "enable" : "disable"} staged`
              : item.enabled ? "enabled" : "disabled"}
            kind={stagedMap.has(item.name) ? "selected" : item.enabled ? "good" : "muted"}
          />
          <Row
            label="Other clients"
            value={item.enabledTargets.length > 0
              ? item.enabledTargets.map(targetLabel).join(", ")
              : "disabled everywhere else"}
            kind={item.enabledTargets.length > 0 ? "accent" : "muted"}
          />
          {item.description && <Row label="About" value={item.description} />}
          <Row label="Canonical copy" value="kept in Skills Store" kind="good" />
        </Box>
      </Box>
      <ErrorText value={dashboard.error} />
      <Text color="gray">
        ↑/↓ · <Text color="magenta" bold>Space</Text> {batchMode ? "stage" : selectedDesired ? "disable" : "enable"} · {batchMode ? <><Text bold>a</Text> apply · <Text bold>c</Text> clear · </> : null}<Text bold>s/S/u</Text> save/update/backup · ● active · ○ inactive
      </Text>
    </Box>
  );
}

function SkillsView({
  snapshot,
  target,
  catalog,
  selected,
  dashboard,
  localEntries,
  selectedSkillName,
  focus,
  staged,
  batchMode,
  query,
  enabledOnly,
  searching
}) {
  const active = skillTargetState(dashboard.states, target);
  const baseSkills = new Set(active.baseSkills);
  const currentSkills = new Set(active.skills);
  const customAdded = [...currentSkills].filter((name) => !baseSkills.has(name));
  const customDisabled = [...baseSkills].filter((name) => !currentSkills.has(name));
  const repairable = active.drift.length > 0 && active.selectionMode !== "manual" &&
    active.selection !== "none";
  return (
    <Box flexDirection="column">
      <Text color="gray">Each client receives its own local Skill links; the canonical Store remains shared.</Text>
      <Box gap={1} flexWrap="wrap">
        {SKILL_TARGETS.map((client) => {
          const state = skillTargetState(dashboard.states, client);
          return (
            <Box key={client} gap={1}>
              <TargetBadge target={client} selected={client === target} />
              <Text color={state.healthy ? "green" : state.data.target ? "red" : "gray"}>
                {state.data.target
                  ? `${state.selection} · ${state.skills.length}`
                  : dashboard.loading ? "loading…" : "unavailable"}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box gap={1} marginTop={1}>
        <Text color={focus === "local" ? "black" : "green"} backgroundColor={focus === "local" ? "green" : undefined} bold>
          {" l LOCAL SWITCHES "}
        </Text>
        <Text color={focus === "workspace" ? "black" : "blue"} backgroundColor={focus === "workspace" ? "blue" : undefined} bold>
          {" w WORKSPACE PACKS "}
        </Text>
      </Box>
      {active.selectionMode === "manual" && (
        <Box flexDirection="column">
          <ItemGroup label="Custom added" items={customAdded} kind="good" />
          <ItemGroup label="Custom disabled" items={customDisabled} kind="bad" />
          <Text color="gray"><Text bold>s</Text> save new · <Text bold>S</Text> update base for this target · <Text bold>u</Text> encrypted Store backup after saving</Text>
        </Box>
      )}
      {Object.entries(dashboard.errors || {}).map(([client, error]) => (
        <ErrorText key={`${client}-skills-error`} value={`${targetLabel(client)}: ${error}`} />
      ))}
      {repairable && (
        <Text color="yellow">
          <Text bold>f</Text> repair current local pack {active.selection} for {targetLabel(target)} · restores managed links only
        </Text>
      )}
      {active.drift.length > 0 && !repairable && (
        <Text color="yellow">Current Skills selection uses manual state; save it as a Pack before automatic repair.</Text>
      )}
      {focus === "local"
        ? <LocalSkillsCatalog
            target={target}
            dashboard={dashboard}
            entries={localEntries}
            selectedName={selectedSkillName}
            staged={staged}
            batchMode={batchMode}
            query={query}
            enabledOnly={enabledOnly}
            searching={searching}
          />
        : snapshot.workspace
          ? <CloudCatalog
              catalog={catalog}
              selected={selected}
              target={target}
              component="skills"
              currentSelection={active.selection}
              currentItems={active.skills}
            />
          : <WorkspaceCatalogFallback snapshot={snapshot} />}
    </Box>
  );
}

function PromptView({ snapshot, target, catalog, selected }) {
  const states = Object.fromEntries(TARGETS.map((entry) => [
    entry,
    promptTargetState(snapshot, entry)
  ]));
  return (
    <Box flexDirection="column">
      <Text color="gray">Local bindings by client. Prompt text loads only when you explicitly request a preview.</Text>
      {TARGETS.map((entry) => (
        <PromptStatusRow key={entry} state={states[entry]} selected={entry === target} />
      ))}
      <Box flexDirection="column" marginTop={1}>
        {TARGETS.map((entry) => {
          const state = states[entry];
          const kind = !state.managed ? "warn" : state.healthy ? "good" : "bad";
          const promptValue = state.managed
            ? `${displayPath(state.instructionFile)}${state.fileState ? ` · ${state.fileState}` : ""}`
            : "not managed by promptctl";
          return (
            <React.Fragment key={`${entry}-local-prompt`}>
              <Row label={`${state.label} binding`} value={displayPath(state.linkFile)} kind={entry} />
              <Row label={`${state.label} prompt`} value={promptValue} kind={kind} />
            </React.Fragment>
          );
        })}
      </Box>
      {TARGETS.map((entry) => (
        <ErrorText
          key={`${entry}-prompt-error`}
          value={!states[entry].ok ? `${states[entry].label}: ${states[entry].error}` : ""}
        />
      ))}
      {snapshot.workspace
        ? <CloudCatalog catalog={catalog} selected={selected} target={target} component="prompts" />
        : <WorkspaceCatalogFallback snapshot={snapshot} />}
      <Text color="gray">
        <Text color="green" bold>v</Text> view active local Prompt · <Text color="cyan" bold>V</Text> view selected Workspace Prompt
      </Text>
    </Box>
  );
}

function PromptPreview({ preview, offset, pageSize }) {
  const content = safePromptPreviewText(preview.content).replace(/\r\n?/g, "\n");
  const lines = content.split("\n");
  const totalLines = content.length === 0 ? 0 : lines.length;
  const safeOffset = Math.max(0, Math.min(offset, Math.max(0, lines.length - pageSize)));
  const visible = lines.slice(safeOffset, safeOffset + pageSize);
  const source = preview.source === "cloud" ? "Workspace" : "Local";
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold color={preview.source === "cloud" ? "cyan" : "green"}>{source} Prompt preview</Text>
        <TargetBadge target={preview.target} selected />
      </Box>
      <Row label="Profile" value={preview.name} />
      {preview.path && <Row label="File" value={displayPath(preview.path)} />}
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" marginTop={1}>
        {content.length === 0
          ? <Text color="gray">(empty Prompt)</Text>
          : visible.map((line, index) => (
            <Text key={safeOffset + index} wrap="truncate-end">{line || " "}</Text>
          ))}
      </Box>
      <Text color="gray">
        Lines {totalLines === 0 ? 0 : safeOffset + 1}–{totalLines === 0 ? 0 : Math.min(safeOffset + pageSize, totalLines)} of {totalLines}
        {totalLines > pageSize ? " · ↑/↓ scroll" : ""} · v/V/Esc close
      </Text>
      <Text color="gray">Content exists only in this TUI process and is cleared when the preview closes.</Text>
    </Box>
  );
}

function SnippetView({ snapshot, catalog, selected }) {
  const entries = snippetEntries(snapshot.snippets, catalog.items);
  const safeIndex = clampSelection(selected, entries.length);
  const visible = selectionWindow(entries, safeIndex);
  const current = entries[safeIndex] || null;
  const localCount = entries.filter((entry) => entry.local).length;
  const remoteCount = entries.filter((entry) => entry.remote).length;
  return (
    <Box flexDirection="column">
      <Text color="gray">Reusable prompts shared by every client. Content is never rendered or automatically injected.</Text>
      <Box gap={2} marginTop={1} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" minWidth={32}>
          <Text color="gray">Library · {localCount} local / {remoteCount} cloud</Text>
          {visible.items.map(({ item, index }) => (
            <Text key={item.name} color={index === safeIndex ? "magenta" : "white"} bold={index === safeIndex}>
              {index === safeIndex ? "› " : "  "}{item.name} <Text color={item.local ? "green" : "gray"}>L</Text>/<Text color={item.remote ? "cyan" : "gray"}>C</Text>
            </Text>
          ))}
          {entries.length === 0 && !catalog.loading && <Text color="gray">(no snippets)</Text>}
        </Box>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="gray">Selected snippet</Text>
          <Text bold color="magenta">{current?.name || "none"}</Text>
          <Row label="Local" value={current?.local ? displayPath(current.local.path) : "not installed"} kind={current?.local ? "good" : "muted"} />
          <Row label="Workspace" value={current?.remote ? "available" : "not backed up"} kind={current?.remote ? "accent" : "muted"} />
          <Row label="Content" value="hidden" kind="muted" />
        </Box>
      </Box>
      {catalog.loading && <Text color="gray">Decrypting the Workspace Snippets catalog in memory…</Text>}
      {!snapshot.workspace && snapshot.workspaceLoading && (
        <Text color="yellow">Workspace Snippets are connecting in the background; local Snippets are ready.</Text>
      )}
      <ErrorText value={catalog.error} />
      <ErrorText value={snapshot.snippetsError} />
      <Text color="gray">
        ↑/↓ select · <Text color="green" bold>c</Text> copy local · <Text color="cyan" bold>p</Text> inspect cloud pull · <Text color="magenta" bold>a</Text> pull selected
      </Text>
      <Text color="gray">Create: promptctl snippet create &lt;name&gt; --yes · Edit: promptctl snippet path &lt;name&gt;</Text>
    </Box>
  );
}

function ComponentView({ snapshot, target, component, catalog, selected }) {
  const state = componentTargetState(snapshot, component, target);
  const { check, data, selection, items, summary } = state;
  const skillsRepairable = component === "skills" && data?.drift?.length > 0 &&
    data?.selection_mode !== "manual" && selection && selection !== "none";
  return (
    <Box flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Text color="gray">Active client</Text>
        <TargetBadge target={target} selected />
      </Box>
      <SummaryRow name={COMPONENT_LABELS[component]} summary={summary} />
      <Row label="Selection" value={selection} />
      {component === "prompts" && <Row label="Managed" value={data.managed ? "yes" : "no"} kind={data.managed ? "good" : "bad"} />}
      {component !== "prompts" && <Row label="Items" value={items?.length ? items.join(", ") : "none"} />}
      {Array.isArray(data.drift) && data.drift.length > 0 && <Row label="Drift" value={data.drift.join(", ")} kind="bad" />}
      <ErrorText value={!check?.ok ? check?.summary || check?.error || snapshot.doctorError : ""} />
      {skillsRepairable && (
        <Text color="yellow">
          <Text bold>f</Text> repair current local pack {selection} for {targetLabel(target)} · restores managed links only
        </Text>
      )}
      {component === "skills" && data?.drift?.length > 0 && !skillsRepairable && (
        <Text color="yellow">Current Skills selection uses manual state; apply a named pack before automatic repair.</Text>
      )}
      {snapshot.workspace
        ? <CloudCatalog catalog={catalog} selected={selected} target={target} component={component} />
        : <WorkspaceCatalogFallback snapshot={snapshot} />}
    </Box>
  );
}

function Presets({ snapshot, selected, target }) {
  const entries = presetEntries(snapshot);
  if (entries.length === 0) {
    return <Text color="gray">No development presets. Create one with agentctl preset create.</Text>;
  }
  const safeIndex = clampSelection(selected, entries.length);
  const [selectedName, preset] = entries[safeIndex];
  const report = targetReport(snapshot, target);
  return (
    <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
      <Box flexDirection="column" minWidth={24}>
        {entries.map(([name], index) => (
          <Text key={name} color={index === safeIndex ? "cyan" : undefined} bold={index === safeIndex}>
            {index === safeIndex ? "> " : "  "}{name}{report?.preset?.name === name ? " *" : ""}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text bold>{selectedName}</Text>
        <Row label="Source" value={snapshot.presetSource === "cloud" ? "Workspace" : "Local"} />
        <Row label="MCP" value={preset.mcp} />
        <Row label="Skills" value={preset.skills} />
        <Row label="Prompt" value={preset.prompt} />
        {preset.description && <Row label="About" value={preset.description} />}
        <Text color="gray">p plan · a apply · u rollback</Text>
      </Box>
    </Box>
  );
}

function Cloud({ snapshot }) {
  if (!snapshot.updatedAt) {
    return (
      <Box flexDirection="column">
        <Text color="gray">Loading Workspace status…</Text>
        <Text color="gray">Local configuration remains untouched.</Text>
      </Box>
    );
  }
  const workspace = snapshot.workspace;
  const connection = snapshot.workspaceConnection;
  const presentation = workspacePresentation(workspace, snapshot.workspaceError, snapshot.workspaceLoading);
  if (!workspace) {
    return (
      <Box flexDirection="column">
        <Text bold color={COLORS[presentation.kind]}>{presentation.heading}</Text>
        <Row label="Status" value={presentation.status} kind={presentation.kind} />
        {connection?.endpoint && <Row label="Endpoint" value={connection.endpoint} />}
        {connection?.store_id && <Row label="Store ID" value={connection.store_id} />}
        <Text>{presentation.description}</Text>
        <Text color="green">{presentation.safety}</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Next step</Text>
          {presentation.commands.map((command, index) => (
            <Text key={`${command}-${index}`} color={command.startsWith("agentctl ") ? "cyan" : "gray"}>{command}</Text>
          ))}
        </Box>
        {presentation.diagnostic && <Row label="Diagnostic" value={presentation.diagnostic} kind="bad" />}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold color={COLORS[presentation.kind]}>{presentation.heading}</Text>
      <Row label="Status" value={presentation.status} kind={presentation.kind} />
      <Row label="Endpoint" value={workspace.endpoint} />
      {snapshot.workspaceLastConnectedAt && (
        <Row label="Last connected" value={new Date(snapshot.workspaceLastConnectedAt).toLocaleString()} />
      )}
      {presentation.state !== "ready" && <Text color={COLORS[presentation.kind]}>{presentation.description}</Text>}
      {presentation.diagnostic && <Row label="Diagnostic" value={presentation.diagnostic} kind="warn" />}
      <Row label="Version" value={workspace.latest?.version || "none"} />
      <Row label="Format" value={workspace.migration_pending
        ? `schema ${workspace.remote_schema} · compatible in memory`
        : `schema ${workspace.remote_schema || 3}`} kind={workspace.migration_pending ? "warn" : "good"} />
      {workspace.migration_pending && <Text color="yellow">Upgrade preview: agentctl workspace migrate</Text>}
      <Row label="Web UI" value={workspace.web_ui_enabled ? "enabled" : "disabled"} kind={workspace.web_ui_enabled ? "good" : "muted"} />
      {Object.entries(workspace.stores || {}).map(([name, store]) => (
        <Row key={name} label={name} value={store.attached
          ? `${store.available === false ? "unreachable" : "attached"} · ${store.latest?.version || "empty"}`
          : "not attached"} kind={store.attached && store.available !== false ? "good" : store.attached ? "warn" : "muted"} />
      ))}
      <Row label="Presets" value={Object.keys(workspace.presets || {}).join(", ") || "none"} />
      <Row
        label="Providers"
        value={workspace.agent?.synced
          ? `${workspace.agent.profiles || 0} profile(s) · ${workspace.agent.secrets || 0} hidden Secret value(s) · ${workspace.agent.failover_routes || 0} route(s) · ${workspace.agent.pricing_rates || 0} rate(s)`
          : "not backed up"}
        kind={workspace.agent?.synced ? "cloud" : "muted"}
      />
      <Text color="gray">Catalogs are browsed on demand and decrypted only in this process.</Text>
      <Text color="gray">Only an applied Provider, Profile, Pack, Prompt, Snippet, or Preset is materialized locally.</Text>
    </Box>
  );
}

function Help() {
  return (
    <Panel title="Keyboard help">
      <Text>[ / ] or Tab / Shift+Tab / Left / Right  switch section</Text>
      <Text>t  cycle target (Claude/Codex/OpenCode/Pi in Providers and Skills) · r refresh · q quit</Text>
      <Text>Up / Down  select previous / next item inside the current section</Text>
      <Text>
        Agents: <Text color="cyan" bold>c/p/Enter</Text> open unified Providers · <Text color="red" bold>x</Text> uninstall
      </Text>
      <Text>Accounts: ↑/↓ select · a/Enter switch or refresh · x delete non-current snapshot</Text>
      <Text>Providers: ↑/↓ select · p plan · a apply · u upload · d download/merge · i incompatible · v next view</Text>
      <Text>Providers (Codex): S start/stop subscription observer · A attach/detach · y confirms every lifecycle change</Text>
      <Text>MCP: l local · w Workspace · / search · e enabled · x problems · g group</Text>
      <Text>MCP: Space toggle · m batch · a apply staged · c clear · s save · S update · u backup</Text>
      <Text>Skills: l local · w Workspace · / search · e enabled · Space toggle · m batch</Text>
      <Text>Skills: a apply staged · c clear · s save · S update · u backup</Text>
      <Text>MCP / Skills / Prompts: p inspect plan · a apply selected Workspace item</Text>
      <Text>MCP / Skills: f repair the current named local selection when Drift is reported</Text>
      <Text>Prompts: v view active local · V view selected Workspace · ↑/↓ scroll preview</Text>
      <Text>Snippets: ↑/↓ select · c copy local · p inspect cloud pull · a pull</Text>
      <Text>Presets: p inspect plan · a apply · u rollback</Text>
      <Text>Destructive actions require y confirmation.</Text>
    </Panel>
  );
}

function App({ initialSection, controller, onLaunch }) {
  const { exit } = useApp();
  const [section, setSection] = useState(initialSection);
  const [target, setTarget] = useState("codex");
  const [providerTarget, setProviderTarget] = useState("codex");
  const [providerPanel, setProviderPanel] = useState("summary");
  const [skillsTarget, setSkillsTarget] = useState("codex");
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [componentSelected, setComponentSelected] = useState({ accounts: 0, providers: 0, mcp: 0, skills: 0, prompts: 0, snippets: 0 });
  const [mcpFocus, setMcpFocus] = useState("local");
  const [selectedMcpServerName, setSelectedMcpServerName] = useState("");
  const [mcpQuery, setMcpQuery] = useState("");
  const [mcpSearching, setMcpSearching] = useState(false);
  const [mcpFilter, setMcpFilter] = useState("all");
  const [mcpGrouped, setMcpGrouped] = useState(false);
  const [mcpBatchMode, setMcpBatchMode] = useState(false);
  const [mcpStaged, setMcpStaged] = useState(new Map());
  const [mcpProfilePrompt, setMcpProfilePrompt] = useState(null);
  const [localMcpCatalog, setLocalMcpCatalog] = useState({
    items: [], target: "codex", loading: false, error: "", key: ""
  });
  const [skillsFocus, setSkillsFocus] = useState("local");
  const [selectedSkillName, setSelectedSkillName] = useState("");
  const [skillsQuery, setSkillsQuery] = useState("");
  const [skillsSearching, setSkillsSearching] = useState(false);
  const [skillsEnabledOnly, setSkillsEnabledOnly] = useState(false);
  const [skillsBatchMode, setSkillsBatchMode] = useState(false);
  const [skillsStaged, setSkillsStaged] = useState(new Map());
  const [skillsPackPrompt, setSkillsPackPrompt] = useState(null);
  const [localSkillsDashboard, setLocalSkillsDashboard] = useState({
    catalog: [], states: {}, errors: {}, loading: true, error: "", key: ""
  });
  const [catalogs, setCatalogs] = useState({
    mcp: { items: [], loading: false, error: "", key: "" },
    skills: { items: [], loading: false, error: "", key: "" },
    prompts: { items: [], loading: false, error: "", key: "" },
    snippets: { items: [], loading: false, error: "", key: "" }
  });
  const [providerSurface, setProviderSurface] = useState({
    local: [],
    cloud: [],
    dashboard: null,
    target: "codex",
    loading: false,
    localError: "",
    cloudError: "",
    key: ""
  });
  const [message, setMessage] = useState("Loading diagnostics…");
  const [lastDetail, setLastDetail] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showIncompatibleProviders, setShowIncompatibleProviders] = useState(false);
  const [promptPreview, setPromptPreview] = useState(null);
  const [promptPreviewOffset, setPromptPreviewOffset] = useState(0);
  const refreshSequence = useRef(0);
  const refreshAbort = useRef(null);

  const refresh = useCallback(async (quiet = false) => {
    refreshAbort.current?.abort();
    const abortController = new AbortController();
    refreshAbort.current = abortController;
    const sequence = refreshSequence.current + 1;
    refreshSequence.current = sequence;
    setLoading(true);
    if (!quiet) setMessage("Refreshing diagnostics…");
    try {
      const local = typeof controller.localSnapshot === "function"
        ? await controller.localSnapshot({ signal: abortController.signal })
        : await controller.snapshot({ signal: abortController.signal });
      if (refreshSequence.current !== sequence) return;
      setSnapshot(local);
      setSelected((value) => clampSelection(value, presetEntries(local).length));
      setSelectedAgent((value) => clampSelection(value, Array.isArray(local.agents) ? local.agents.length : 0));
      setComponentSelected((value) => ({
        ...value,
        accounts: clampSelection(value.accounts, accountEntries(local).length)
      }));
      setLoading(false);
      setMessage(local.workspaceLoading
        ? `Local ready ${new Date(local.updatedAt).toLocaleTimeString()} · Workspace ${local.workspace ? "refreshing" : "connecting"}…`
        : `Local ready ${new Date(local.updatedAt).toLocaleTimeString()}`);
      if (typeof controller.hydrateSnapshot === "function" && local.phase === "local") {
        void controller.hydrateSnapshot(local, { signal: abortController.signal }).then((next) => {
          if (refreshSequence.current !== sequence) return;
          setSnapshot(next);
          setSelected((value) => clampSelection(value, presetEntries(next).length));
          const cloud = workspacePresentation(next.workspace, next.workspaceError, false);
          setMessage(`${cloud.status} · local state remains ready`);
        }).catch((error) => {
          if (refreshSequence.current !== sequence) return;
          setSnapshot((value) => value ? { ...value, workspaceLoading: false } : value);
          setMessage(`Local ready · Workspace refresh failed: ${error.message}`);
        });
      }
    } catch (error) {
      if (refreshSequence.current !== sequence) return;
      setMessage(`Refresh failed: ${error.message}`);
    } finally {
      if (refreshSequence.current === sequence) setLoading(false);
    }
  }, [controller]);

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => { void refresh(true); }, 30_000);
    return () => {
      clearInterval(timer);
      refreshSequence.current += 1;
      refreshAbort.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    setPromptPreview(null);
    setPromptPreviewOffset(0);
  }, [section, target]);

  useEffect(() => {
    setMcpStaged(new Map());
    setMcpBatchMode(false);
    setMcpProfilePrompt(null);
  }, [target]);

  useEffect(() => {
    setSkillsStaged(new Map());
    setSkillsBatchMode(false);
    setSkillsPackPrompt(null);
  }, [skillsTarget]);

  const workspaceStoreId = snapshot?.workspace?.store_id || "";
  const catalogTarget = section === "skills" ? skillsTarget : target;
  const catalogStore = section === "snippets" ? "prompts" : section;
  const workspaceCatalogVersion = ["mcp", "skills", "prompts", "snippets"].includes(section)
    ? snapshot?.workspace?.stores?.[catalogStore]?.latest?.version || snapshot?.workspace?.latest?.version || "empty"
    : "";

  useEffect(() => {
    if (!["mcp", "skills", "prompts", "snippets"].includes(section) || !workspaceStoreId) return;
    const key = `${workspaceStoreId}:${workspaceCatalogVersion}:${catalogTarget}`;
    let cancelled = false;
    setCatalogs((value) => ({
      ...value,
      [section]: { ...value[section], loading: true, error: "", key }
    }));
    void controller.remoteCatalog(section, catalogTarget).then((result) => {
      if (cancelled) return;
      setCatalogs((value) => ({
        ...value,
        [section]: { items: result.items, loading: false, error: result.error, key }
      }));
      setComponentSelected((value) => ({
        ...value,
        [section]: clampSelection(value[section], result.items.length)
      }));
    });
    return () => { cancelled = true; };
  }, [catalogTarget, controller, section, workspaceCatalogVersion, workspaceStoreId]);

  useEffect(() => {
    if (section !== "providers" || !snapshot) return;
    const key = `${snapshot.updatedAt}:${workspaceStoreId || "local"}:${snapshot.workspace?.latest?.version || "none"}:${providerTarget}`;
    let cancelled = false;
    setProviderSurface((value) => ({
      local: value.target === providerTarget ? value.local : [],
      cloud: [],
      dashboard: value.target === providerTarget ? value.dashboard : null,
      target: providerTarget,
      loading: true,
      localError: "",
      cloudError: "",
      key
    }));
    let localItems = providerSurface.target === providerTarget ? providerSurface.local : [];
    let cloudItems = [];
    let dashboard = providerSurface.target === providerTarget ? providerSurface.dashboard : null;
    let localError = "";
    let cloudError = "";
    let localDone = false;
    let cloudDone = false;
    let current = null;
    const projectCloud = (items) => items.map((profile) => ({
      ...profile,
      applied: current?.profile === profile.name &&
        current.platform === profile.platform &&
        current.protocol === profile.protocol &&
        current.endpoint === profile.endpoint &&
        current.requested_model === profile.requested_model &&
        current.outbound_model === profile.outbound_model &&
        current.compaction_upstream === profile.compaction_upstream &&
        current.compaction_policy === profile.compaction_policy &&
        current.compaction_mode === profile.compaction_mode &&
        current.context_window_tokens === profile.context_window_tokens &&
        current.auto_compact_tokens === profile.auto_compact_tokens
    }));
    const publish = () => {
      if (cancelled) return;
      setProviderSurface({
        local: localItems,
        cloud: cloudItems,
        dashboard,
        target: providerTarget,
        loading: !localDone || !cloudDone,
        localError,
        cloudError,
        key
      });
    };
    const local = Promise.resolve()
      .then(() => controller.providerDashboard(providerTarget))
      .then((data) => ({ data, error: "" }))
      .catch((error) => ({ data: null, error: String(error?.message || error) }));
    const cloud = workspaceStoreId
      ? controller.remoteCatalog("providers", providerTarget)
      : Promise.resolve({ ok: true, items: [], error: "" });
    void local.then((result) => {
      localDone = true;
      dashboard = result.data;
      localItems = result.data?.profiles || [];
      current = result.data?.status?.current?.[providerTarget] || null;
      cloudItems = projectCloud(cloudItems);
      localError = result.error;
      publish();
    });
    void cloud.then((result) => {
      cloudDone = true;
      cloudItems = projectCloud(result.items || []);
      cloudError = result.error;
      publish();
    });
    return () => { cancelled = true; };
  }, [controller, providerTarget, section, snapshot, workspaceStoreId]);

  useEffect(() => {
    if (section !== "mcp" || !snapshot || typeof controller.localMcpServers !== "function") return;
    const key = `${target}:${snapshot.updatedAt || "local"}`;
    let cancelled = false;
    setLocalMcpCatalog((value) => ({
      items: value.target === target ? value.items : [],
      target,
      loading: true,
      error: "",
      key
    }));
    void controller.localMcpServers(target).then((items) => {
      if (cancelled) return;
      setLocalMcpCatalog({ items, target, loading: false, error: "", key });
    }).catch((error) => {
      if (cancelled) return;
      setLocalMcpCatalog((value) => ({
        ...value,
        target,
        loading: false,
        error: String(error?.message || error),
        key
      }));
    });
    return () => { cancelled = true; };
  }, [controller, section, snapshot?.updatedAt, target]);

  useEffect(() => {
    if (section !== "skills" || !snapshot || typeof controller.localSkillsDashboard !== "function") return;
    const key = `${snapshot.updatedAt || "local"}`;
    let cancelled = false;
    setLocalSkillsDashboard((value) => ({ ...value, loading: true, error: "", key }));
    void controller.localSkillsDashboard().then((dashboard) => {
      if (cancelled) return;
      setLocalSkillsDashboard({ ...dashboard, loading: false, error: "", key });
    }).catch((error) => {
      if (cancelled) return;
      setLocalSkillsDashboard((value) => ({
        ...value,
        loading: false,
        error: String(error?.message || error),
        key
      }));
    });
    return () => { cancelled = true; };
  }, [controller, section, snapshot?.updatedAt]);

  const selectedPreset = useMemo(() => presetEntries(snapshot)[selected]?.[0] || "", [snapshot, selected]);
  const selectedAgentId = Array.isArray(snapshot?.agents)
    ? snapshot.agents[selectedAgent]?.client || ""
    : "";
  const mergedSnippets = snippetEntries(snapshot?.snippets, catalogs.snippets.items);
  const mergedProviders = providerEntries(providerSurface.local, providerSurface.cloud, {
    includeIncompatible: showIncompatibleProviders
  });
  useEffect(() => {
    setComponentSelected((value) => {
      const providers = clampSelection(value.providers, mergedProviders.length);
      return providers === value.providers ? value : { ...value, providers };
    });
  }, [mergedProviders.length]);
  const savedAccounts = accountEntries(snapshot);
  const selectedAccount = savedAccounts[
    clampSelection(componentSelected.accounts, savedAccounts.length)
  ] || null;
  const selectedAccountName = selectedAccount?.name || "";
  const selectedProvider = mergedProviders[
    clampSelection(componentSelected.providers, mergedProviders.length)
  ] || null;
  const selectedProviderName = selectedProvider?.name || "";
  const selectedProviderSource = selectedProvider?.source || "local";
  const selectedSnippet = mergedSnippets[clampSelection(componentSelected.snippets, mergedSnippets.length)] || null;
  const selectedRemote = section === "snippets"
    ? selectedSnippet?.remote ? selectedSnippet.name : ""
    : ["mcp", "skills", "prompts"].includes(section)
      ? catalogs[section].items[componentSelected[section]]?.name || ""
      : "";
  const selectedLocalSnippet = section === "snippets" && selectedSnippet?.local
    ? selectedSnippet.name
    : "";
  const allLocalMcpEntries = useMemo(
    () => mcpServerEntries(localMcpCatalog.items, snapshot, target),
    [localMcpCatalog.items, snapshot, target]
  );
  const localMcpEntries = useMemo(
    () => filterMcpServerEntries(allLocalMcpEntries, {
      query: mcpQuery,
      filter: mcpFilter,
      grouped: mcpGrouped
    }),
    [allLocalMcpEntries, mcpFilter, mcpGrouped, mcpQuery]
  );
  const selectedMcpServerIndex = Math.max(
    0,
    localMcpEntries.findIndex((entry) => entry.name === selectedMcpServerName)
  );
  const selectedMcpServer = localMcpEntries[selectedMcpServerIndex] || null;
  useEffect(() => {
    if (localMcpEntries.length === 0) {
      if (selectedMcpServerName) setSelectedMcpServerName("");
      return;
    }
    if (!localMcpEntries.some((entry) => entry.name === selectedMcpServerName)) {
      setSelectedMcpServerName(localMcpEntries[0].name);
    }
  }, [localMcpEntries, selectedMcpServerName]);
  const allLocalSkillEntries = useMemo(
    () => skillEntries(localSkillsDashboard.catalog, localSkillsDashboard.states, skillsTarget),
    [localSkillsDashboard.catalog, localSkillsDashboard.states, skillsTarget]
  );
  const localSkillEntries = useMemo(
    () => filterSkillEntries(allLocalSkillEntries, {
      query: skillsQuery,
      enabledOnly: skillsEnabledOnly
    }),
    [allLocalSkillEntries, skillsEnabledOnly, skillsQuery]
  );
  const selectedSkillIndex = Math.max(
    0,
    localSkillEntries.findIndex((entry) => entry.name === selectedSkillName)
  );
  const selectedSkill = localSkillEntries[selectedSkillIndex] || null;
  useEffect(() => {
    if (localSkillEntries.length === 0) {
      if (selectedSkillName) setSelectedSkillName("");
      return;
    }
    if (!localSkillEntries.some((entry) => entry.name === selectedSkillName)) {
      setSelectedSkillName(localSkillEntries[0].name);
    }
  }, [localSkillEntries, selectedSkillName]);
  const selectedMcpState = componentTargetState(snapshot, "mcp", target);
  const selectedMcpProfile = selectedMcpState.data?.selection_mode === "manual"
    ? ""
    : selectedMcpState.selection === "none" ? "" : selectedMcpState.selection;
  const selectedSkillsState = skillTargetState(localSkillsDashboard.states, skillsTarget);
  const selectedSkillsPack = selectedSkillsState.selectionMode === "manual"
    ? ""
    : selectedSkillsState.selection === "none" ? "" : selectedSkillsState.selection;
  const promptPreviewPageSize = Math.max(5, Math.min(18, (process.stdout.rows || 30) - 14));

  const patchLocalMcpState = useCallback((state) => {
    if (!state?.target) return;
    setSnapshot((current) => {
      if (!current?.doctor?.targets) return current;
      return {
        ...current,
        doctor: {
          ...current.doctor,
          targets: current.doctor.targets.map((report) => report.target === state.target
            ? {
                ...report,
                mcp: {
                  ...(report.mcp || {}),
                  ok: true,
                  code: 0,
                  error: "",
                  summary: "",
                  data: state
                }
              }
            : report)
        }
      };
    });
  }, []);

  const patchLocalSkillsState = useCallback((state) => {
    if (!state?.target) return;
    setLocalSkillsDashboard((current) => ({
      ...current,
      states: { ...current.states, [state.target]: state },
      errors: { ...current.errors, [state.target]: "" }
    }));
    setSnapshot((current) => {
      if (!current?.doctor?.targets) return current;
      return {
        ...current,
        doctor: {
          ...current.doctor,
          targets: current.doctor.targets.map((report) => report.target === state.target
            ? {
                ...report,
                skills: {
                  ...(report.skills || {}),
                  ok: true,
                  code: 0,
                  error: "",
                  summary: "",
                  data: state
                }
              }
            : report)
        }
      };
    });
  }, []);

  const stageMcpToggle = useCallback((entry) => {
    if (!entry) return;
    setMcpStaged((current) => {
      const next = new Map(current);
      const effective = next.has(entry.name) ? next.get(entry.name) : entry.enabled;
      const desired = !effective;
      if (desired === entry.enabled) next.delete(entry.name);
      else next.set(entry.name, desired);
      if (desired && entry.variantGroup) {
        for (const candidate of allLocalMcpEntries) {
          if (candidate.name === entry.name || candidate.variantGroup !== entry.variantGroup) continue;
          const candidateEffective = next.has(candidate.name)
            ? next.get(candidate.name)
            : candidate.enabled;
          if (candidateEffective) {
            if (candidate.enabled) next.set(candidate.name, false);
            else next.delete(candidate.name);
          }
        }
      }
      return next;
    });
  }, [allLocalMcpEntries]);

  const stageSkillToggle = useCallback((entry) => {
    if (!entry) return;
    setSkillsStaged((current) => {
      const next = new Map(current);
      const effective = next.has(entry.name) ? next.get(entry.name) : entry.enabled;
      const desired = !effective;
      if (desired === entry.enabled) next.delete(entry.name);
      else next.set(entry.name, desired);
      return next;
    });
  }, []);

  const prepareMcpConfirmation = useCallback(async (action, changes, selection = "") => {
    const enabling = changes.filter((change) => change.enabled).filter((change) => {
      const current = allLocalMcpEntries.find((entry) => entry.name === change.name);
      return !current?.enabled;
    });
    setBusy(true);
    setLastDetail("");
    setMessage(enabling.length > 0
      ? `Checking ${enabling.length} MCP server requirement(s)…`
      : "Preparing target-specific MCP change…");
    try {
      const results = await Promise.all(enabling.map((change) =>
        controller.localMcpPreflight(change.name, target)
      ));
      const failed = results.filter((result) => !result.ready);
      const detail = failed.length > 0
        ? [
            `Preflight warning: ${failed.length} server(s) have unmet requirements.`,
            ...failed.flatMap((result) => [
              `${result.server}:`,
              ...result.issues.map((issue) => `  ${issue}`)
            ])
          ].join("\n")
        : enabling.length > 0
          ? `Preflight passed for ${enabling.map((entry) => entry.name).join(", ")}.`
          : "No enable preflight is needed for disable-only changes.";
      const labelSelection = selection || (changes.length === 1 ? changes[0].name : "");
      setConfirm({
        action,
        changes,
        selection: labelSelection,
        detail,
        warning: failed.length > 0,
        label: actionLabel(action, labelSelection, target)
      });
      setMessage(failed.length > 0
        ? "Preflight found missing requirements; review the warning before confirming."
        : "MCP preflight complete.");
    } catch (error) {
      setMessage(`MCP preflight failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [allLocalMcpEntries, controller, target]);

  const openPromptPreview = useCallback(async (source) => {
    const local = promptTargetState(snapshot, target);
    const selection = source === "cloud" ? selectedRemote : local.selection;
    if (source === "local" && (!local.managed || !selection)) {
      setMessage(`No managed local Prompt is available for ${targetLabel(target)}.`);
      return;
    }
    if (source === "cloud" && !selection) {
      setMessage("No Workspace Prompt profile is selected.");
      return;
    }
    setBusy(true);
    setLastDetail("");
    setMessage(`Loading ${source === "cloud" ? "Workspace" : "local"} Prompt preview…`);
    try {
      const preview = await controller.promptPreview({ source, selection, target });
      setPromptPreview(preview);
      setPromptPreviewOffset(0);
      setMessage(`Viewing ${source === "cloud" ? "Workspace" : "local"} Prompt ${selection}.`);
    } catch (error) {
      setMessage(`Failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [controller, selectedRemote, snapshot, target]);

  const executeAction = useCallback(async (action, payload = {}) => {
    setConfirm(null);
    if (action === "agent-provider") {
      setProviderTarget(selectedAgentId);
      setComponentSelected((value) => ({ ...value, providers: 0 }));
      setSection("providers");
      setMessage(`Unified Providers opened for ${targetLabel(selectedAgentId)}.`);
      return;
    }
    setBusy(true);
    const providerAction = action.startsWith("provider-");
    const accountAction = action.startsWith("account-");
    const localMcpAction = [
      "mcp-enable", "mcp-disable", "mcp-batch", "mcp-profile-save", "mcp-profile-update",
      "mcp-profile-upload"
    ].includes(action);
    const localSkillsAction = [
      "skills-enable", "skills-disable", "skills-batch", "skills-pack-save",
      "skills-pack-update", "skills-pack-upload"
    ].includes(action);
    const localRepairAction = action === "mcp-repair" || action === "skills-repair";
    const localRepairSelection = action === "mcp-repair" ? selectedMcpProfile : selectedSkillsPack;
    const liveTarget = providerAction
      ? providerTarget
      : action.startsWith("skills-") ? skillsTarget : target;
    const actionTarget = payload.target || liveTarget;
    const liveSelection = action.startsWith("agent-")
      ? selectedAgentId
      : accountAction ? selectedAccountName
      : providerAction ? selectedProviderName
      : localMcpAction ? payload.selection || selectedMcpServer?.name || ""
      : localSkillsAction ? payload.selection || selectedSkill?.name || ""
      : localRepairAction ? localRepairSelection
      : action === "snippet-copy" ? selectedLocalSnippet
        : action.includes("-") ? selectedRemote : selectedPreset;
    const selection = typeof payload.selection === "string" ? payload.selection : liveSelection;
    const runningLabel = actionLabel(action, selection, actionTarget);
    setMessage(action === "mcp-disable"
      ? `${runningLabel} · removing only the changed target entry…`
      : action === "mcp-enable" || action === "mcp-batch"
        ? `${runningLabel} · updating changed target entries atomically…`
        : action === "skills-disable" || action === "skills-enable" || action === "skills-batch"
          ? `${runningLabel} · updating managed links atomically…`
        : `${runningLabel}…`);
    setLastDetail("");
    try {
      const result = await controller.action(action, {
        agent: selectedAgentId,
        preset: selectedPreset,
        selection,
        source: payload.source || (providerAction
          ? selectedProviderSource
          : snapshot?.presetSource || "local"),
        target: actionTarget,
        changes: payload.changes || [],
        replace: action === "mcp-profile-update",
        force: payload.force === true,
        initializeLocal: payload.initializeLocal === true,
        skipLocalInitialization: payload.skipLocalInitialization === true,
        acceptSkillDrift: payload.acceptSkillDrift || null
      });
      const firstDetailLine = String(result.detail || "").split("\n")[0];
      if (!result.ok && ["mcp-apply", "skills-apply"].includes(action) &&
          result.data?.localInitializationRequired &&
          payload.initializeLocal !== true && payload.skipLocalInitialization !== true) {
        const componentLabel = action === "mcp-apply" ? "MCP" : "Skills";
        setLastDetail(result.detail || "");
        setMessage(`Choose how to apply this Workspace ${componentLabel} selection.`);
        setConfirm({
          action,
          selection,
          target: actionTarget,
          initializationChoice: true,
          label: `Initialize the local ${componentLabel} Store from Workspace`,
          detail: `The local ${componentLabel} Store is not initialized.\n[y] restores the full encrypted Store, installs its recovery capability locally, and enables Local Switches.\n[s] applies only ${selection} from the isolated Workspace runtime.\n[n] cancels without further changes.`
        });
        return;
      }
      const driftRequest = result.data?.skillDriftRepairRequired
        ? {
            name: result.data.skillDriftName,
            scope: result.data.skillDriftScope
          }
        : null;
      const attemptedDrift = payload.acceptSkillDrift;
      const alreadyAttempted = driftRequest && attemptedDrift &&
        driftRequest.name === attemptedDrift.name && driftRequest.scope === attemptedDrift.scope;
      if (!result.ok && driftRequest && !alreadyAttempted) {
        const workspaceRuntime = driftRequest.scope === "workspace";
        setLastDetail(result.detail || "");
        setMessage(`Confirmation required: Skill '${driftRequest.name}' changed outside skillsctl.`);
        setConfirm({
          ...payload,
          action,
          selection,
          source: payload.source || (providerAction
            ? selectedProviderSource
            : snapshot?.presetSource || "local"),
          target: actionTarget,
          acceptSkillDrift: driftRequest,
          warning: true,
          label: `Trust current files for Skill '${driftRequest.name}' and retry`,
          detail: workspaceRuntime
            ? `The isolated Workspace runtime copy of '${driftRequest.name}' changed through a previously managed link.\n[y] updates only that staging checksum and retries the original action. The encrypted Workspace and local canonical Store are unchanged.\n[n] cancels without accepting the checksum.`
            : `The local canonical Skill '${driftRequest.name}' no longer matches its recorded checksum.\nReview its current files before continuing. [y] keeps those files, updates only this Skill's catalog checksum, and retries the original action.\n[n] cancels without accepting the checksum.`
        });
        return;
      }
      if (!result.ok && action === "mcp-apply" && result.data?.forceRequired && payload.force !== true) {
        setLastDetail(result.detail || "");
        setMessage("Confirmation required: same-name MCP entries are not yet owned by mcpctl.");
        setConfirm({
          ...payload,
          action,
          selection,
          source: payload.source || (providerAction
            ? selectedProviderSource
            : snapshot?.presetSource || "local"),
          target: actionTarget,
          force: true,
          warning: true,
          label: `Replace only same-name MCP entries with Workspace ${selection}`,
          detail: "The target already contains matching MCP names that mcpctl does not own.\nContinuing with --force replaces only those same-name entries; unrelated MCP configuration is preserved."
        });
        return;
      }
      setMessage(result.ok
        ? action === "skills-apply" && firstDetailLine
          ? `Done: ${firstDetailLine}`
          : `Done: ${actionLabel(action, selection, actionTarget)}`
        : `Failed: ${firstDetailLine || actionLabel(action, selection, actionTarget)}`);
      setLastDetail(result.detail || "");
      if (localMcpAction) {
        if (result.data?.state) patchLocalMcpState(result.data.state);
        if (result.ok && action === "mcp-batch") {
          setMcpStaged(new Map());
          setMcpBatchMode(false);
        }
      } else if (localSkillsAction) {
        if (result.data?.state) patchLocalSkillsState(result.data.state);
        if (result.ok && action === "skills-batch") {
          setSkillsStaged(new Map());
          setSkillsBatchMode(false);
        }
      } else if (action === "skills-apply" && result.data?.matchedLocalPack && result.data?.state) {
        patchLocalSkillsState(result.data.state);
        await refresh(true);
      } else {
        await refresh(true);
      }
    } catch (error) {
      setMessage(`Failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [controller, patchLocalMcpState, patchLocalSkillsState, providerTarget, refresh, selectedAccountName, selectedAgentId, selectedLocalSnippet,
    selectedMcpProfile, selectedMcpServer, selectedPreset, selectedProviderName, selectedProviderSource, selectedRemote,
    selectedSkill, selectedSkillsPack, skillsTarget,
    snapshot?.presetSource, target]);

  useInput((input, key) => {
    if (busy) return;
    if (confirm) {
      if (confirm.initializationChoice && (input === "y" || input === "Y")) {
        void executeAction(confirm.action, { ...confirm, initializeLocal: true });
      } else if (confirm.initializationChoice && (input === "s" || input === "S")) {
        void executeAction(confirm.action, { ...confirm, skipLocalInitialization: true });
      } else if (input === "y" || input === "Y") void executeAction(confirm.action, confirm);
      else if (input === "n" || input === "N" || key.escape) {
        setMessage("Cancelled; no changes were made.");
        setConfirm(null);
      }
      return;
    }
    if (mcpProfilePrompt) {
      if (key.escape) {
        setMcpProfilePrompt(null);
        setMessage("MCP Profile save cancelled.");
        return;
      }
      if (key.return) {
        const name = mcpProfilePrompt.value.trim();
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          setMcpProfilePrompt((value) => ({
            ...value,
            error: "Use only letters, numbers, dot, underscore, and hyphen."
          }));
          return;
        }
        const action = mcpProfilePrompt.mode === "update"
          ? "mcp-profile-update"
          : "mcp-profile-save";
        setMcpProfilePrompt(null);
        setConfirm({
          action,
          selection: name,
          label: actionLabel(action, name, target),
          detail: action === "mcp-profile-update"
            ? "Only this target override is replaced; other target overrides remain intact."
            : "The current target selection is saved and then reapplied as a named Profile."
        });
        return;
      }
      if (key.backspace || key.delete) {
        setMcpProfilePrompt((value) => ({ ...value, value: value.value.slice(0, -1), error: "" }));
        return;
      }
      if (input && !key.ctrl && !key.meta && /^[A-Za-z0-9._-]+$/.test(input)) {
        setMcpProfilePrompt((value) => ({ ...value, value: `${value.value}${input}`, error: "" }));
      }
      return;
    }
    if (skillsPackPrompt) {
      if (key.escape) {
        setSkillsPackPrompt(null);
        setMessage("Skill Pack save cancelled.");
        return;
      }
      if (key.return) {
        const name = skillsPackPrompt.value.trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
          setSkillsPackPrompt((value) => ({
            ...value,
            error: "Use lowercase letters, numbers, and single hyphens."
          }));
          return;
        }
        const action = skillsPackPrompt.mode === "update"
          ? "skills-pack-update"
          : "skills-pack-save";
        setSkillsPackPrompt(null);
        setConfirm({
          action,
          selection: name,
          label: actionLabel(action, name, skillsTarget),
          detail: action === "skills-pack-update"
            ? "Only this target override is replaced; other target overrides remain intact."
            : "The current target selection is saved and then reapplied as a named Pack."
        });
        return;
      }
      if (key.backspace || key.delete) {
        setSkillsPackPrompt((value) => ({ ...value, value: value.value.slice(0, -1), error: "" }));
        return;
      }
      if (input && !key.ctrl && !key.meta && /^[a-z0-9-]+$/.test(input)) {
        setSkillsPackPrompt((value) => ({ ...value, value: `${value.value}${input}`.slice(0, 64), error: "" }));
      }
      return;
    }
    if (mcpSearching) {
      if (key.escape) {
        setMcpSearching(false);
        setMcpQuery("");
        setMessage("MCP search cleared.");
        return;
      }
      if (key.return) {
        setMcpSearching(false);
        setMessage(mcpQuery ? `MCP search kept: ${mcpQuery}` : "MCP search closed.");
        return;
      }
      if (key.backspace || key.delete) {
        setMcpQuery((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(input)) {
        setMcpQuery((value) => `${value}${input}`.slice(0, 80));
      }
      return;
    }
    if (skillsSearching) {
      if (key.escape) {
        setSkillsSearching(false);
        setSkillsQuery("");
        setMessage("Skills search cleared.");
        return;
      }
      if (key.return) {
        setSkillsSearching(false);
        setMessage(skillsQuery ? `Skills search kept: ${skillsQuery}` : "Skills search closed.");
        return;
      }
      if (key.backspace || key.delete) {
        setSkillsQuery((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(input)) {
        setSkillsQuery((value) => `${value}${input}`.slice(0, 80));
      }
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    const sectionDirection = sectionDelta(input, key);
    if (sectionDirection !== 0) {
      if (promptPreview) {
        setPromptPreview(null);
        setPromptPreviewOffset(0);
        setMessage("Prompt preview closed; content cleared from the view.");
      }
      if (showHelp) setShowHelp(false);
      return setSection((value) => moveSection(value, sectionDirection));
    }
    if (promptPreview) {
      if (key.escape || input === "v" || input === "V") {
        setPromptPreview(null);
        setPromptPreviewOffset(0);
        setMessage("Prompt preview closed; content cleared from the view.");
        return;
      }
      const delta = selectionDelta(input, key);
      if (delta !== 0) {
        const lastOffset = Math.max(
          0,
          safePromptPreviewText(promptPreview.content).replace(/\r\n?/g, "\n").split("\n").length - promptPreviewPageSize
        );
        return setPromptPreviewOffset((value) => Math.max(0, Math.min(value + delta, lastOffset)));
      }
      return;
    }
    if (input === "?") return setShowHelp((value) => !value);
    if (showHelp && key.escape) return setShowHelp(false);
    if (section === "mcp" && (input === "l" || input === "w")) {
      const nextFocus = input === "l" ? "local" : "workspace";
      setMcpFocus(nextFocus);
      setMessage(nextFocus === "local"
        ? "Local MCP switches focused; Space changes only the highlighted target."
        : "Workspace MCP profiles focused; p inspects and a applies the selected profile.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && input === "/") {
      setMcpSearching(true);
      setMessage("Type to filter MCP servers; Enter keeps the query and Esc clears it.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && (input === "e" || input === "x")) {
      const requested = input === "e" ? "enabled" : "problems";
      setMcpFilter((value) => value === requested ? "all" : requested);
      setMessage(requested === "enabled"
        ? "Enabled-only MCP filter toggled."
        : "MCP readiness-problem filter toggled.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && input === "g") {
      setMcpGrouped((value) => !value);
      setMessage(mcpGrouped ? "MCP category grouping disabled." : "MCP category grouping enabled.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && input === "m") {
      setMcpBatchMode((value) => !value);
      setMessage(mcpBatchMode
        ? `Batch mode closed${mcpStaged.size > 0 ? "; staged changes remain available" : ""}.`
        : "Batch mode enabled; Space stages changes and a applies them once.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && input === "c" && mcpBatchMode) {
      setMcpStaged(new Map());
      setMessage("Staged MCP changes cleared.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && (input === "s" || input === "S")) {
      if (mcpStaged.size > 0) {
        setMessage("Apply or clear staged MCP changes before saving a Profile.");
        return;
      }
      const updateName = selectedMcpState.baseSelection ||
        (selectedMcpState.selection !== "custom" && selectedMcpState.selection !== "none"
          ? selectedMcpState.selection
          : "");
      if (input === "S" && !updateName) {
        setMessage("No named base MCP Profile is available to update.");
        return;
      }
      setMcpProfilePrompt({
        mode: input === "S" ? "update" : "save",
        value: input === "S" ? updateName : "",
        error: ""
      });
      setMessage(input === "S"
        ? "Edit or confirm the Profile name to update for this target."
        : "Enter a new MCP Profile name.");
      return;
    }
    if (section === "mcp" && mcpFocus === "local" && input === "u") {
      if (mcpStaged.size > 0) {
        setMessage("Apply or clear staged MCP changes before backing up the MCP Store.");
        return;
      }
      if (!selectedMcpProfile) {
        setMessage("Save the current custom MCP selection as a named Profile before backing it up.");
        return;
      }
      if (!workspaceConfigured(snapshot)) {
        setMessage("Connect or restore the encrypted Workspace before backing up the MCP Store.");
        return;
      }
      setConfirm({
        action: "mcp-profile-upload",
        selection: selectedMcpProfile,
        label: actionLabel("mcp-profile-upload", selectedMcpProfile, target),
        detail: "MCP Profiles depend on catalog definitions, artifacts, and Secret ciphertext, so the encrypted MCP Store is backed up as one portable unit."
      });
      return;
    }
    if (section === "skills" && (input === "l" || input === "w")) {
      const nextFocus = input === "l" ? "local" : "workspace";
      setSkillsFocus(nextFocus);
      setMessage(nextFocus === "local"
        ? "Local Skill switches focused; Space changes only the highlighted client."
        : "Workspace Skill Packs focused; p inspects and a applies the selected Pack.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && input === "/") {
      setSkillsSearching(true);
      setMessage("Type to filter Skills; Enter keeps the query and Esc clears it.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && input === "e") {
      setSkillsEnabledOnly((value) => !value);
      setMessage("Enabled-only Skills filter toggled.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && input === "m") {
      setSkillsBatchMode((value) => !value);
      setMessage(skillsBatchMode
        ? `Skills batch mode closed${skillsStaged.size > 0 ? "; staged changes remain available" : ""}.`
        : "Skills batch mode enabled; Space stages changes and a applies them once.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && input === "c" && skillsBatchMode) {
      setSkillsStaged(new Map());
      setMessage("Staged Skill changes cleared.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && (input === "s" || input === "S")) {
      if (skillsStaged.size > 0) {
        setMessage("Apply or clear staged Skill changes before saving a Pack.");
        return;
      }
      const updateName = selectedSkillsState.basePack ||
        (selectedSkillsState.selection !== "custom" && selectedSkillsState.selection !== "none"
          ? selectedSkillsState.selection
          : "");
      if (input === "S" && !updateName) {
        setMessage("No named base Skill Pack is available to update.");
        return;
      }
      setSkillsPackPrompt({
        mode: input === "S" ? "update" : "save",
        value: input === "S" ? updateName : "",
        error: ""
      });
      setMessage(input === "S"
        ? "Edit or confirm the Skill Pack name to update for this client."
        : "Enter a new lowercase Skill Pack name.");
      return;
    }
    if (section === "skills" && skillsFocus === "local" && input === "u") {
      if (skillsStaged.size > 0) {
        setMessage("Apply or clear staged Skill changes before backing up the Skills Store.");
        return;
      }
      if (!selectedSkillsPack) {
        setMessage("Save the current custom Skill selection as a named Pack before backing it up.");
        return;
      }
      if (!workspaceConfigured(snapshot)) {
        setMessage("Connect or restore the encrypted Workspace before backing up the Skills Store.");
        return;
      }
      setConfirm({
        action: "skills-pack-upload",
        selection: selectedSkillsPack,
        label: actionLabel("skills-pack-upload", selectedSkillsPack, skillsTarget),
        detail: "The Skills Store backup includes Pack definitions and canonical Skill files for portable restore."
      });
      return;
    }
    if (input === "t") {
      if (section === "providers") {
        setComponentSelected((value) => ({ ...value, providers: 0 }));
        return setProviderTarget((value) => cycleTarget(value, 1, PROVIDER_TARGETS));
      }
      if (section === "accounts") return;
      if (section === "skills") {
        setComponentSelected((value) => ({ ...value, skills: 0 }));
        return setSkillsTarget((value) => cycleTarget(value, 1, SKILL_TARGETS));
      }
      return setTarget((value) => otherTarget(value));
    }
    if (section === "providers" && (input === "i" || input === "I")) {
      setComponentSelected((value) => ({ ...value, providers: 0 }));
      setShowIncompatibleProviders(!showIncompatibleProviders);
      setMessage(showIncompatibleProviders
        ? "Incompatible Providers hidden."
        : "Showing incompatible Providers for inspection.");
      return;
    }
    if (section === "providers" && (input === "v" || input === "V")) {
      const next = cycleProviderPanel(providerPanel);
      setProviderPanel(next);
      setMessage(`Provider ${next} view selected.`);
      return;
    }
    if (input === "r") return void refresh();
    const delta = selectionDelta(input, key);
    if (section === "agents" && delta !== 0) {
      return setSelectedAgent((value) => clampSelection(
        value + delta, Array.isArray(snapshot?.agents) ? snapshot.agents.length : 0
      ));
    }
    if (section === "accounts" && delta !== 0) {
      return setComponentSelected((value) => ({
        ...value,
        accounts: clampSelection(value.accounts + delta, savedAccounts.length)
      }));
    }
    if (section === "presets" && delta !== 0) {
      return setSelected((value) => clampSelection(value + delta, presetEntries(snapshot).length));
    }
    if (section === "providers" && delta !== 0) {
      return setComponentSelected((value) => ({
        ...value,
        providers: clampSelection(value.providers + delta, mergedProviders.length)
      }));
    }
    if (section === "mcp" && delta !== 0) {
      if (mcpFocus === "local") {
        if (localMcpEntries.length === 0) return;
        const index = clampSelection(selectedMcpServerIndex + delta, localMcpEntries.length);
        setSelectedMcpServerName(localMcpEntries[index].name);
        return;
      }
      return setComponentSelected((value) => ({
        ...value,
        mcp: clampSelection(value.mcp + delta, catalogs.mcp.items.length)
      }));
    }
    if (section === "skills" && delta !== 0) {
      if (skillsFocus === "local") {
        if (localSkillEntries.length === 0) return;
        const index = clampSelection(selectedSkillIndex + delta, localSkillEntries.length);
        setSelectedSkillName(localSkillEntries[index].name);
        return;
      }
      return setComponentSelected((value) => ({
        ...value,
        skills: clampSelection(value.skills + delta, catalogs.skills.items.length)
      }));
    }
    if (["prompts", "snippets"].includes(section) && delta !== 0) {
      const length = section === "snippets" ? mergedSnippets.length : catalogs[section].items.length;
      return setComponentSelected((value) => ({
        ...value,
        [section]: clampSelection(value[section] + delta, length)
      }));
    }
    let action = actionForKey(section, key.return ? "\r" : input);
    if (!action) return;
    if (action === "proxy-toggle-running" || action === "proxy-toggle-attachment") {
      if (providerTarget !== "codex") {
        setMessage("Switch the Provider render target to Codex before controlling its subscription observer.");
        return;
      }
      const state = proxyPresentation(providerSurface.dashboard?.proxy || {});
      let resolved = action;
      if (action === "proxy-toggle-running") {
        if (state.status !== "running" && state.status !== "stopped") {
          setMessage(`Observer state is ${state.status}; inspect agentctl proxy status before changing it.`);
          return;
        }
        if (state.running && state.attachmentPresent) {
          setMessage("Detach Codex with A before stopping the observer.");
          return;
        }
        resolved = state.running ? "proxy-stop" : "proxy-start";
      } else if (state.attachmentPresent) {
        resolved = "proxy-detach";
      } else if (!state.running) {
        setMessage("Start the observer with S before attaching Codex.");
        return;
      } else {
        resolved = "proxy-attach";
      }
      const detail = {
        "proxy-start": "Starts a loopback-only passthrough observer. Codex configuration remains unchanged until Attach.",
        "proxy-stop": "Stops the detached observer. Retained token and cost history is preserved.",
        "proxy-attach": "Creates an owner-only exact backup, then routes Codex through the local observer. Official ChatGPT auth and the OpenAI upstream remain unchanged.",
        "proxy-detach": "Restores the pre-attach Codex configuration byte-for-byte. The observer keeps running until separately stopped."
      }[resolved];
      setConfirm({
        action: resolved,
        label: actionLabel(resolved, "", "codex"),
        detail
      });
      return;
    }
    if (action === "mcp-toggle") {
      if (mcpFocus !== "local") {
        setMessage("Press l to focus local MCP switches before toggling a server.");
        return;
      }
      if (!selectedMcpServer) {
        setMessage("No local MCP server is selected.");
        return;
      }
      if (mcpBatchMode) {
        stageMcpToggle(selectedMcpServer);
        setMessage(`${selectedMcpServer.name} toggle staged; press a to apply all staged changes.`);
        return;
      }
      action = selectedMcpServer.enabled ? "mcp-disable" : "mcp-enable";
      const changes = [{ name: selectedMcpServer.name, enabled: action === "mcp-enable" }];
      if (action === "mcp-enable") {
        void prepareMcpConfirmation(action, changes, selectedMcpServer.name);
        return;
      }
    }
    if (action === "mcp-apply" && mcpFocus === "local" && mcpBatchMode) {
      const changes = [...mcpStaged.entries()].map(([name, enabled]) => ({ name, enabled }));
      if (changes.length === 0) {
        setMessage("No MCP changes are staged; use Space to mark servers first.");
        return;
      }
      void prepareMcpConfirmation("mcp-batch", changes);
      return;
    }
    if ((action === "mcp-plan" || action === "mcp-apply") && mcpFocus !== "workspace") {
      setMessage("Press w to focus Workspace MCP profiles before planning or applying one.");
      return;
    }
    if (action === "skills-toggle") {
      if (skillsFocus !== "local") {
        setMessage("Press l to focus local Skill switches before toggling a Skill.");
        return;
      }
      if (!selectedSkill) {
        setMessage("No local Skill is selected.");
        return;
      }
      if (skillsBatchMode) {
        stageSkillToggle(selectedSkill);
        setMessage(`${selectedSkill.name} toggle staged; press a to apply all staged changes.`);
        return;
      }
      action = selectedSkill.enabled ? "skills-disable" : "skills-enable";
    }
    if (action === "skills-apply" && skillsFocus === "local" && skillsBatchMode) {
      const changes = [...skillsStaged.entries()].map(([name, enabled]) => ({ name, enabled }));
      if (changes.length === 0) {
        setMessage("No Skill changes are staged; use Space to mark Skills first.");
        return;
      }
      setConfirm({
        action: "skills-batch",
        changes,
        label: actionLabel("skills-batch", "", skillsTarget),
        detail: `${changes.length} managed Skill link change(s) will be applied in one target transaction.`
      });
      return;
    }
    if ((action === "skills-plan" || action === "skills-apply") && skillsFocus !== "workspace") {
      setMessage("Press w to focus Workspace Skill Packs before planning or applying one.");
      return;
    }
    if (action === "prompt-view-local" || action === "prompt-view-cloud") {
      return void openPromptPreview(action.endsWith("cloud") ? "cloud" : "local");
    }
    if (action.startsWith("agent-") && !selectedAgentId) {
      setMessage("No agent is selected.");
      return;
    }
    if (action.startsWith("account-") && !selectedAccountName) {
      setMessage("No saved Codex official account is selected.");
      return;
    }
    if (action === "account-delete" && selectedAccount?.current) {
      setMessage("The current account cannot be deleted; switch to another saved account first.");
      return;
    }
    if ((action === "provider-plan" || action === "provider-apply") && !selectedProviderName) {
      setMessage("No local or Workspace Provider profile is selected.");
      return;
    }
    if ((action === "provider-sync-push" || action === "provider-sync-pull") &&
        !workspaceConfigured(snapshot)) {
      setMessage("Connect or restore an encrypted Workspace before synchronizing Provider catalogs.");
      return;
    }
    if (action === "provider-sync-push" && !selectedProvider?.sources?.includes("local")) {
      setMessage(selectedProvider?.syncStatus === "builtin-only"
        ? "Apply the built-in Provider once to materialize it locally before uploading it."
        : "The selected Provider has no local copy to upload.");
      return;
    }
    if (action === "provider-sync-pull" && !selectedProvider?.sources?.includes("cloud")) {
      setMessage("The selected Provider has no Workspace copy to download.");
      return;
    }
    if (action === "mcp-repair" && selectedMcpState.drift.length === 0) {
      setMessage(`${targetLabel(target)} MCP configuration is already healthy.`);
      return;
    }
    if (action === "mcp-repair" && !selectedMcpProfile) {
      setMessage("Automatic MCP repair requires a current named profile; the current selection is manual or unknown.");
      return;
    }
    if (action === "skills-repair" && selectedSkillsState.drift.length === 0) {
      setMessage(`${targetLabel(skillsTarget)} Skills configuration is already healthy.`);
      return;
    }
    if (action === "skills-repair" && !selectedSkillsPack) {
      setMessage("Automatic Skills repair requires a current named pack; the current selection is manual or unknown.");
      return;
    }
    if (["plan", "apply"].includes(action) && !selectedPreset) {
      setMessage("No preset is selected.");
      return;
    }
    if (action === "snippet-copy" && !selectedLocalSnippet) {
      setMessage("The selected Snippet is not installed locally.");
      return;
    }
    if (/^(mcp|skills|prompts|snippets)-(plan|apply)$/.test(action) && !selectedRemote) {
      setMessage("No Workspace selection is available.");
      return;
    }
    if (actionNeedsConfirmation(action)) {
      const providerAction = action.startsWith("provider-");
      const accountAction = action.startsWith("account-");
      const localMcpAction = action === "mcp-enable" || action === "mcp-disable";
      const localSkillsAction = action === "skills-enable" || action === "skills-disable";
      const localRepairAction = action === "mcp-repair" || action === "skills-repair";
      const localRepairSelection = action === "mcp-repair" ? selectedMcpProfile : selectedSkillsPack;
      const selection = action.startsWith("agent-")
        ? selectedAgentId
        : accountAction ? selectedAccountName
        : providerAction ? selectedProviderName
        : localMcpAction ? selectedMcpServer?.name || ""
        : localSkillsAction ? selectedSkill?.name || ""
        : localRepairAction ? localRepairSelection
        : action === "snippet-copy" ? selectedLocalSnippet
          : action.includes("-") ? selectedRemote : selectedPreset;
      setConfirm({
        action,
        selection,
        target: providerAction ? providerTarget : action.startsWith("skills-") ? skillsTarget : target,
        label: actionLabel(
          action,
          selection,
          providerAction ? providerTarget : action.startsWith("skills-") ? skillsTarget : target
        )
      });
    } else {
      void executeAction(action);
    }
  });

  let content = <LoadingView />;
  if (snapshot) {
    content = <Overview snapshot={snapshot} target={target} />;
    if (section === "agents") content = <Agents snapshot={snapshot} selected={selectedAgent} />;
    if (section === "accounts") content = <AccountsView snapshot={snapshot} selected={componentSelected.accounts} />;
    if (section === "providers") content = (
      <ProvidersView
        snapshot={snapshot}
        surface={providerSurface}
        selected={componentSelected.providers}
        target={providerTarget}
        showIncompatible={showIncompatibleProviders}
        panelMode={providerPanel}
      />
    );
    if (section === "mcp") content = (
      <McpView
        snapshot={snapshot}
        target={target}
        catalog={catalogs.mcp}
        selected={componentSelected.mcp}
        localCatalog={{
          ...localMcpCatalog,
          activeCount: allLocalMcpEntries.filter((entry) => entry.enabled).length
        }}
        localEntries={localMcpEntries}
        selectedServerName={selectedMcpServer?.name || selectedMcpServerName}
        focus={mcpFocus}
        staged={mcpStaged}
        batchMode={mcpBatchMode}
        query={mcpQuery}
        filter={mcpFilter}
        grouped={mcpGrouped}
        searching={mcpSearching}
      />
    );
    if (section === "skills") content = (
      <SkillsView
        snapshot={snapshot}
        target={skillsTarget}
        catalog={catalogs.skills}
        selected={componentSelected.skills}
        dashboard={localSkillsDashboard}
        localEntries={localSkillEntries}
        selectedSkillName={selectedSkill?.name || selectedSkillName}
        focus={skillsFocus}
        staged={skillsStaged}
        batchMode={skillsBatchMode}
        query={skillsQuery}
        enabledOnly={skillsEnabledOnly}
        searching={skillsSearching}
      />
    );
    if (section === "prompts") content = promptPreview
      ? <PromptPreview preview={promptPreview} offset={promptPreviewOffset} pageSize={promptPreviewPageSize} />
      : <PromptView snapshot={snapshot} target={target} catalog={catalogs.prompts} selected={componentSelected.prompts} />;
    if (section === "snippets") content = <SnippetView snapshot={snapshot} catalog={catalogs.snippets} selected={componentSelected.snippets} />;
    if (section === "presets") content = <Presets snapshot={snapshot} selected={selected} target={target} />;
    if (section === "cloud") content = <Cloud snapshot={snapshot} />;
  }

  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label || "Overview";
  const activeTarget = section === "providers"
    ? providerTarget
    : section === "skills" ? skillsTarget : section === "accounts" ? "codex" : target;
  const panelTitle = promptPreview
    ? `Prompts · ${promptPreview.source === "cloud" ? "Workspace" : "Local"} preview`
    : ["mcp", "prompts"].includes(section)
    ? `${sectionLabel} · Claude Code vs Codex`
    : section === "providers" ? `Providers · ${targetLabel(providerTarget)}`
    : section === "skills" ? `Skills · ${targetLabel(skillsTarget)}`
    : section === "accounts" ? "Accounts · Codex official Identity"
    : section === "snippets" ? "Snippets · Shared library"
      : ["overview", "prompts", "presets"].includes(section)
      ? `${sectionLabel} · ${targetLabel(target)}`
      : sectionLabel;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">script-toolbox / agents</Text>
        <Box gap={1}>
          <Text color="gray">{section === "snippets" ? "shared library" : section === "accounts" ? "identity target" : "active target"}</Text>
          {section !== "snippets" && <TargetBadge target={activeTarget} selected />}
          {!(["snippets", "accounts"].includes(section)) && <Text color="gray">t switch</Text>}
        </Box>
      </Box>
      <Box gap={1} marginBottom={1} flexWrap="wrap">
        {SECTIONS.map((item) => (
          <Text
            key={item.id}
            color={section === item.id ? "black" : SECTION_COLORS[item.id]}
            backgroundColor={section === item.id ? SECTION_COLORS[item.id] : undefined}
            bold={section === item.id}
            dimColor={section !== item.id}
          >
            {` ${item.label} `}
          </Text>
        ))}
      </Box>
      {showHelp
        ? <Help />
        : <Panel title={panelTitle} accent={SECTION_COLORS[section] || "cyan"}>{content}</Panel>}
      {lastDetail && !confirm && (
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" marginTop={1}>
          {lastDetail.split("\n").slice(0, 8).map((line, index) => (
            <Text key={`${index}-${line}`} color="gray">{line}</Text>
          ))}
        </Box>
      )}
      {mcpProfilePrompt ? (
        <Box borderStyle="single" borderColor="magenta" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="magenta" bold>
            {mcpProfilePrompt.mode === "update" ? "Update MCP Profile" : "Save MCP Profile"}
          </Text>
          <Text>Name: <Text color="white" bold>{mcpProfilePrompt.value}</Text><Text inverse> </Text></Text>
          {mcpProfilePrompt.error && <Text color="red">{mcpProfilePrompt.error}</Text>}
          <Text color="gray">Enter confirm · Esc cancel · allowed: letters, numbers, . _ -</Text>
        </Box>
      ) : skillsPackPrompt ? (
        <Box borderStyle="single" borderColor="green" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="green" bold>
            {skillsPackPrompt.mode === "update" ? "Update Skill Pack" : "Save Skill Pack"}
          </Text>
          <Text>Name: <Text color="white" bold>{skillsPackPrompt.value}</Text><Text inverse> </Text></Text>
          {skillsPackPrompt.error && <Text color="red">{skillsPackPrompt.error}</Text>}
          <Text color="gray">Enter confirm · Esc cancel · lowercase letters, numbers, single hyphens</Text>
        </Box>
      ) : confirm ? (
        <Box marginTop={1} flexDirection="column">
          {confirm.detail && confirm.detail.split("\n").slice(0, 8).map((line, index) => (
            <Text key={`${index}-${line}`} color={confirm.warning ? "red" : "gray"}>{line}</Text>
          ))}
          <Text color="yellow" bold>
            {confirm.label}? {confirm.initializationChoice
              ? "[y] initialize / [s] selected only / [n] cancel"
              : "[y/N]"}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} justifyContent="space-between">
          <Text color={message.startsWith("Failed") ? "red" : "gray"} wrap="truncate-end">{loading || busy ? "◌ " : ""}{message}</Text>
          <Text color="gray">? help · [/] tabs · {(["snippets", "accounts"].includes(section)) ? "" : "t target · "}r refresh · q quit</Text>
        </Box>
      )}
    </Box>
  );
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ERROR ${error.message}\n`);
  process.exitCode = 1;
}

if (options?.help) {
  usage();
} else if (options) {
  if (process.versions.node.split(".").map(Number)[0] < 22) {
    process.stderr.write("ERROR agent TUI requires Node.js 22 or newer\n");
    process.exitCode = 1;
  } else {
    const controller = createController();
    let section = options.section;
    let keepRunning = true;
    while (keepRunning) {
      let launch = null;
      const instance = render(
        <App
          initialSection={section}
          controller={controller}
          onLaunch={(command) => { launch = command; }}
        />
      );
      await instance.waitUntilExit();
      if (!launch) {
        keepRunning = false;
        continue;
      }
      const result = spawnSync(launch.executable, launch.args, {
        stdio: "inherit",
        env: process.env,
        windowsHide: false
      });
      if (result.error) process.stderr.write(`ERROR ${result.error.message}\n`);
      section = "agents";
    }
  }
}
