import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { createController } from "./controller.mjs";
import {
  SECTIONS,
  PROVIDER_TARGETS,
  TARGETS,
  actionForKey,
  actionLabel,
  actionNeedsConfirmation,
  accountEntries,
  clampSelection,
  componentSummary,
  componentTargetState,
  cycleTarget,
  mcpTargetComparison,
  moveSection,
  normalizeSection,
  otherTarget,
  presetEntries,
  providerEntries,
  promptTargetState,
  safePromptPreviewText,
  sectionDelta,
  selectionDelta,
  selectionWindow,
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
  t                                 Switch target (four clients in Providers)
  r                                 Refresh live status
  Up / Down                         Select previous / next list item
  p / a                             Plan / apply selected configuration
  Prompts: v local · V Workspace    View Prompt content on demand
  u                                 Roll back a preset
  Agents: c / p / Enter unified Providers · x uninstall owned config
  Accounts: a/Enter switch · x delete saved account
  Providers: p plan · a apply · u upload · d download/merge · i incompatible
  MCP: f                            Repair current local profile drift
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
    <Box gap={1}>
      <Text bold color="white">{name.padEnd(10)}</Text>
      <Badge kind={summary.kind}>{summary.label.padEnd(12)}</Badge>
      <Text color="white">{summary.detail}</Text>
    </Box>
  );
}

function TargetStatusRow({ state, selected }) {
  const count = state.items.length;
  return (
    <Box gap={1}>
      <TargetBadge target={state.target} selected={selected} />
      <Badge kind={state.summary.kind}>{state.summary.label.padEnd(11)}</Badge>
      <Text color="white" bold>{state.selection}</Text>
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

function ProvidersView({ snapshot, surface, selected, target, showIncompatible }) {
  const allEntries = providerEntries(surface.local, surface.cloud, { includeIncompatible: true });
  const entries = showIncompatible
    ? allEntries
    : providerEntries(surface.local, surface.cloud);
  const safeIndex = clampSelection(selected, entries.length);
  const visible = selectionWindow(entries, safeIndex, 10);
  const current = entries[safeIndex] || null;
  const dashboard = surface.dashboard || {};
  const localStatus = dashboard.status || {};
  const failover = dashboard.failover || {};
  const pricing = dashboard.pricing || {};
  const proxy = dashboard.proxy || {};
  const remote = snapshot.workspace?.agent || {};
  const runtime = Array.isArray(snapshot.agents)
    ? snapshot.agents.find((agent) => agent.client === target) || null
    : null;
  const hiddenCount = allEntries.length - providerEntries(surface.local, surface.cloud).length;
  const backedUpCount = allEntries.filter((entry) => entry.syncStatus === "backed-up").length;
  const conflictCount = allEntries.filter((entry) => entry.syncStatus === "conflict").length;
  const stateKind = !current?.enabled
    ? "muted"
    : current?.ready
      ? "good"
      : current?.nativeAuthPresent ? "local"
        : current?.compatible ? "warn" : "bad";
  const proxyKind = proxy.status === "running"
    ? "good"
    : proxy.status === "stale" ? "bad" : proxy.status === "stopped" ? "muted" : "warn";
  return (
    <Box flexDirection="column">
      <Box gap={1} marginBottom={1}>
        <Text color="gray">Render target</Text>
        {PROVIDER_TARGETS.map((entry) => (
          <TargetBadge key={entry} target={entry} selected={entry === target} />
        ))}
        <Text color="gray">t cycle</Text>
      </Box>
      {runtime && (
        <Box flexDirection="column" marginBottom={1}>
          {target === "codex" && (
            <SummaryRow name="Identity" summary={componentSummary("identity", { ok: true, data: runtime })} />
          )}
          <SummaryRow name="Inference" summary={componentSummary("inference", { ok: true, data: runtime })} />
        </Box>
      )}
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 98 ? "column" : "row"}>
        <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column" minWidth={34}>
          <Text color="gray">
            Profiles {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total} visible · {allEntries.length} total · {backedUpCount} backed up{conflictCount > 0 ? ` · ${conflictCount} conflict` : ""}
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
        <Box borderStyle="single" borderColor={current ? COLORS[providerStorageKind(current)] : "gray"} paddingX={1} flexDirection="column" flexGrow={1}>
          <Box gap={1}>
            <Text color="gray">Selected</Text>
            {current && <ProviderSourceBadge entry={current} />}
          </Box>
          <Text bold color="magenta">{current?.name || "none"}</Text>
          {current ? (
            <>
              <Row label="Target" value={`${targetLabel(target)} · ${current.platform || dashboard.platform || "unknown"}`} kind={target} />
              <Row label="State" value={current.status || (!current.enabled ? "disabled" : current.ready ? "ready" : "blocked")} kind={stateKind} />
              <Row
                label="Backup state"
                value={providerSyncDetail(current)}
                kind={providerStorageKind(current)}
              />
              {current.sources.includes("builtin") && current.syncStatus !== "builtin-only" && (
                <Row label="Catalog origin" value="agentctl built-in template" kind="builtin" />
              )}
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
                kind={current.contextWindowTokens !== null || current.autoCompactTokens !== null
                  ? "good"
                  : "muted"}
              />
              {current.modelsAvailable.length > 0 && (
                <Row label="Model choices" value={current.modelsAvailable.join(", ")} />
              )}
              <Row
                label="Provider Secret"
                value={current.authMode === "none"
                  ? "not required"
                  : `${current.secretReference || "missing reference"} · ${current.secretPresent ? "present" : "missing"}`}
                kind={current.authMode === "none" || current.secretPresent ? "good" : "warn"}
              />
              {current.nativeAuthPresent && (
                <Row
                  label="Native client auth"
                  value={`OpenCode · ${current.nativeAuthProvider || "provider"}${current.nativeAuthType ? ` (${current.nativeAuthType})` : ""} · available outside agentctl`}
                  kind="local"
                />
              )}
              {current.nativeSelected && (
                <Row
                  label="Native selection"
                  value={current.nativeSelectedModel || "selected by OpenCode"}
                  kind="local"
                />
              )}
              {current.officialIdentityPolicy === "preserve" && (
                <Row
                  label="Official Identity"
                  value="preserve current ChatGPT login · auth.json untouched"
                  kind="good"
                />
              )}
              <Row
                label="Applied"
                value={current.applied
                  ? "current under agentctl"
                  : current.nativeSelected ? "current in OpenCode · external" : "not current under agentctl"}
                kind={current.applied ? "good" : current.nativeSelected ? "local" : "muted"}
              />
              {current.description && <Row label="About" value={current.description} />}
              {current.issue && <Row label="Blocked by" value={current.issue} kind="bad" />}
              {!current.secretPresent && current.secretReference && (
                <Text color="cyan">agentctl provider use {current.name} --target {target} --secret-file ./key --yes</Text>
              )}
              {current.nativeAuthPresent && !current.secretPresent && (
                <Text color="gray">Native auth is usable by OpenCode, but is not yet managed or backed up by agentctl.</Text>
              )}
            </>
          ) : (
            <Text color="gray">Initialize locally or back up a Provider bundle to Workspace.</Text>
          )}
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Row
          label="Local catalog"
          value={localStatus.store_exists ? `${localStatus.profile_count || 0} profile(s) · ${localStatus.secret_count || 0} Secret value(s)` : "not initialized"}
          kind={localStatus.store_exists ? "local" : "muted"}
        />
        <Row
          label="Workspace backup"
          value={remote.synced ? `${remote.profiles || 0} profile(s) · ${remote.secrets || 0} hidden Secret value(s)` : "not backed up"}
          kind={remote.synced ? "cloud" : "muted"}
        />
        <Row label="Failover" value={`${failover.routes || 0} local / ${remote.failover_routes || 0} cloud route(s)`} />
        <Row label="Pricing" value={`${pricing.version || "none"} · ${pricing.rates || 0} local / ${remote.pricing_rates || 0} cloud rate(s)`} />
        <Row
          label="Proxy"
          value={`${proxy.status || "unavailable"}${proxy.profile ? ` · ${proxy.profile} for ${targetLabel(proxy.target)}` : ""}`}
          kind={proxyKind}
        />
      </Box>
      {surface.loading && <Text color="gray">◌ Loading remaining local or encrypted Workspace Provider data…</Text>}
      {!snapshot.workspace && snapshot.workspaceLoading && (
        <Text color="yellow">Workspace Providers are connecting in the background; local profiles remain usable.</Text>
      )}
      <ErrorText value={surface.localError} />
      <ErrorText value={surface.cloudError} />
      {(dashboard.errors || []).map((error) => <ErrorText key={error} value={error} />)}
      <Text color="gray">
        ↑/↓ select · <Text color="cyan" bold>p</Text> plan · <Text color="magenta" bold>a</Text> apply · <Text color="yellow" bold>i</Text> incompatible
      </Text>
      <Text color="gray">
        <Text color="green" bold>u</Text> keep Local → Workspace · <Text color="blue" bold>d</Text> keep Workspace → Local
      </Text>
      <Text color="gray">B template · L local · W Workspace-only · L+W backed up · L≠W conflict</Text>
      <Text color="gray">One row per Provider. Secret values remain hidden.</Text>
    </Box>
  );
}

function CloudCatalog({ catalog, selected, target, component }) {
  if (catalog.loading) return <Text color="gray">Decrypting this catalog in memory…</Text>;
  if (catalog.error) return <ErrorText value={catalog.error} />;
  if (!catalog.items.length) return <Text color="gray">No cloud selections in this Store.</Text>;
  const safeIndex = clampSelection(selected, catalog.items.length);
  const item = catalog.items[safeIndex];
  const visible = selectionWindow(catalog.items, safeIndex);
  const catalogLabel = component === "mcp"
    ? "MCP profiles"
    : component === "skills" ? "Skill packs" : "Prompt profiles";
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
            Profiles {visible.total > 0 ? visible.start + 1 : 0}–{visible.end} of {visible.total}
          </Text>
          {visible.items.map(({ item: entry, index }) => (
            <Text key={entry.name} color={index === safeIndex ? "magenta" : "white"} bold={index === safeIndex}>
              {index === safeIndex ? "› " : "  "}{entry.name}
            </Text>
          ))}
        </Box>
        <Box borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column" flexGrow={1}>
          <Text color="gray">Selected profile</Text>
          <Text bold color="magenta">{item.name}</Text>
          <Row label="Includes" value={`${item.count} ${item.unit}`} />
          {item.clients?.length > 0 && <Row label="Available to" value={item.clients.map(targetLabel).join(", ")} />}
          {item.description && <Row label="About" value={item.description} />}
        </Box>
      </Box>
      <Text color="gray">
        ↑/↓ select · <Text color="cyan" bold>p</Text> inspect plan · <Text color="magenta" bold>a</Text> apply to {targetLabel(target)} only
      </Text>
    </Box>
  );
}

function McpView({ snapshot, target, catalog, selected }) {
  const comparison = mcpTargetComparison(snapshot);
  const active = comparison.targets[target];
  const repairable = active?.drift?.length > 0 &&
    active?.data?.selection_mode !== "manual" &&
    active?.selection && active.selection !== "none";
  return (
    <Box flexDirection="column">
      <Text color="gray">Local assignments by client; the highlighted client receives Workspace actions.</Text>
      {TARGETS.map((entry) => (
        <TargetStatusRow
          key={entry}
          state={comparison.targets[entry]}
          selected={entry === target}
        />
      ))}
      <Box flexDirection="column" marginTop={1}>
        <ItemGroup label="Shared" items={comparison.shared} />
        <ItemGroup label="Codex only" items={comparison.only.codex} kind="codex" />
        <ItemGroup label="Claude only" items={comparison.only.claude} kind="claude" />
        {TARGETS.map((entry) => comparison.targets[entry].suppressed.length > 0 && (
          <ItemGroup
            key={`${entry}-disabled`}
            label={`${targetLabel(entry)} disabled`}
            items={comparison.targets[entry].suppressed}
            kind="warn"
          />
        ))}
        {TARGETS.map((entry) => comparison.targets[entry].drift.length > 0 && (
          <ItemGroup
            key={`${entry}-drift`}
            label={`${targetLabel(entry)} drift`}
            items={comparison.targets[entry].drift}
            kind="bad"
          />
        ))}
      </Box>
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
      {snapshot.workspace
        ? <CloudCatalog catalog={catalog} selected={selected} target={target} component="mcp" />
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
      <Text>t  cycle target (Claude/Codex/OpenCode/Pi in Providers) · r refresh · q quit</Text>
      <Text>Up / Down  select previous / next item inside the current section</Text>
      <Text>
        Agents: <Text color="cyan" bold>c/p/Enter</Text> open unified Providers · <Text color="red" bold>x</Text> uninstall
      </Text>
      <Text>Accounts: ↑/↓ select · a/Enter switch or refresh · x delete non-current snapshot</Text>
      <Text>Providers: ↑/↓ select · p plan · a apply · u upload · d download/merge · i show/hide incompatible</Text>
      <Text>MCP / Skills / Prompts: p inspect plan · a apply selected</Text>
      <Text>MCP: f repair the current local profile when Drift is reported</Text>
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
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [componentSelected, setComponentSelected] = useState({ accounts: 0, providers: 0, mcp: 0, skills: 0, prompts: 0, snippets: 0 });
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

  const refresh = useCallback(async (quiet = false) => {
    const sequence = refreshSequence.current + 1;
    refreshSequence.current = sequence;
    setLoading(true);
    if (!quiet) setMessage("Refreshing diagnostics…");
    try {
      const local = typeof controller.localSnapshot === "function"
        ? await controller.localSnapshot()
        : await controller.snapshot();
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
        void controller.hydrateSnapshot(local).then((next) => {
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
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    setPromptPreview(null);
    setPromptPreviewOffset(0);
  }, [section, target]);

  const workspaceStoreId = snapshot?.workspace?.store_id || "";
  const catalogStore = section === "snippets" ? "prompts" : section;
  const workspaceCatalogVersion = ["mcp", "skills", "prompts", "snippets"].includes(section)
    ? snapshot?.workspace?.stores?.[catalogStore]?.latest?.version || snapshot?.workspace?.latest?.version || "empty"
    : "";

  useEffect(() => {
    if (!["mcp", "skills", "prompts", "snippets"].includes(section) || !workspaceStoreId) return;
    const key = `${workspaceStoreId}:${workspaceCatalogVersion}:${target}`;
    let cancelled = false;
    setCatalogs((value) => ({
      ...value,
      [section]: { ...value[section], loading: true, error: "", key }
    }));
    void controller.remoteCatalog(section, target).then((result) => {
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
  }, [controller, section, target, workspaceCatalogVersion, workspaceStoreId]);

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
  const selectedMcpState = componentTargetState(snapshot, "mcp", target);
  const selectedMcpProfile = selectedMcpState.data?.selection_mode === "manual"
    ? ""
    : selectedMcpState.selection === "none" ? "" : selectedMcpState.selection;
  const promptPreviewPageSize = Math.max(5, Math.min(18, (process.stdout.rows || 30) - 14));

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

  const executeAction = useCallback(async (action) => {
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
    const mcpRepairAction = action === "mcp-repair";
    const actionTarget = providerAction ? providerTarget : target;
    const selection = action.startsWith("agent-")
      ? selectedAgentId
      : accountAction ? selectedAccountName
      : providerAction ? selectedProviderName
      : mcpRepairAction ? selectedMcpProfile
      : action === "snippet-copy" ? selectedLocalSnippet
        : action.includes("-") ? selectedRemote : selectedPreset;
    setMessage(`${actionLabel(action, selection, actionTarget)}…`);
    setLastDetail("");
    try {
      const result = await controller.action(action, {
        agent: selectedAgentId,
        preset: selectedPreset,
        selection: accountAction
          ? selectedAccountName
          : providerAction
          ? selectedProviderName
          : mcpRepairAction
          ? selectedMcpProfile
          : action === "snippet-copy" ? selectedLocalSnippet : selectedRemote,
        source: providerAction
          ? selectedProviderSource
          : snapshot?.presetSource || "local",
        target: actionTarget
      });
      setMessage(`${result.ok ? "Done" : "Failed"}: ${actionLabel(action, selection, actionTarget)}`);
      setLastDetail(result.detail || "");
      await refresh(true);
    } catch (error) {
      setMessage(`Failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [controller, providerTarget, refresh, selectedAccountName, selectedAgentId, selectedLocalSnippet,
    selectedMcpProfile, selectedPreset, selectedProviderName, selectedProviderSource, selectedRemote,
    snapshot?.presetSource, target]);

  useInput((input, key) => {
    if (busy) return;
    if (confirm) {
      if (input === "y" || input === "Y") void executeAction(confirm.action);
      else if (input === "n" || input === "N" || key.escape) {
        setMessage("Cancelled; no changes were made.");
        setConfirm(null);
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
    if (input === "t") {
      if (section === "providers") {
        setComponentSelected((value) => ({ ...value, providers: 0 }));
        return setProviderTarget((value) => cycleTarget(value, 1, PROVIDER_TARGETS));
      }
      if (section === "accounts") return;
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
    if (["mcp", "skills", "prompts", "snippets"].includes(section) && delta !== 0) {
      const length = section === "snippets" ? mergedSnippets.length : catalogs[section].items.length;
      return setComponentSelected((value) => ({
        ...value,
        [section]: clampSelection(value[section] + delta, length)
      }));
    }
    const action = actionForKey(section, key.return ? "\r" : input);
    if (!action) return;
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
      const mcpRepairAction = action === "mcp-repair";
      const selection = action.startsWith("agent-")
        ? selectedAgentId
        : accountAction ? selectedAccountName
        : providerAction ? selectedProviderName
        : mcpRepairAction ? selectedMcpProfile
        : action === "snippet-copy" ? selectedLocalSnippet
          : action.includes("-") ? selectedRemote : selectedPreset;
      setConfirm({
        action,
        label: actionLabel(action, selection, providerAction ? providerTarget : target)
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
      />
    );
    if (section === "mcp") content = <McpView snapshot={snapshot} target={target} catalog={catalogs.mcp} selected={componentSelected.mcp} />;
    if (section === "skills") content = <ComponentView snapshot={snapshot} target={target} component="skills" catalog={catalogs.skills} selected={componentSelected.skills} />;
    if (section === "prompts") content = promptPreview
      ? <PromptPreview preview={promptPreview} offset={promptPreviewOffset} pageSize={promptPreviewPageSize} />
      : <PromptView snapshot={snapshot} target={target} catalog={catalogs.prompts} selected={componentSelected.prompts} />;
    if (section === "snippets") content = <SnippetView snapshot={snapshot} catalog={catalogs.snippets} selected={componentSelected.snippets} />;
    if (section === "presets") content = <Presets snapshot={snapshot} selected={selected} target={target} />;
    if (section === "cloud") content = <Cloud snapshot={snapshot} />;
  }

  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label || "Overview";
  const activeTarget = section === "providers" ? providerTarget : section === "accounts" ? "codex" : target;
  const panelTitle = promptPreview
    ? `Prompts · ${promptPreview.source === "cloud" ? "Workspace" : "Local"} preview`
    : ["mcp", "prompts"].includes(section)
    ? `${sectionLabel} · Claude Code vs Codex`
    : section === "providers" ? `Providers · ${targetLabel(providerTarget)}`
    : section === "accounts" ? "Accounts · Codex official Identity"
    : section === "snippets" ? "Snippets · Shared library"
      : ["overview", "skills", "prompts", "presets"].includes(section)
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
      {confirm ? (
        <Box marginTop={1}><Text color="yellow" bold>{confirm.label}? [y/N]</Text></Box>
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
