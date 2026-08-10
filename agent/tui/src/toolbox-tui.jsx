import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { createController } from "./controller.mjs";
import {
  SECTIONS,
  TARGETS,
  actionForKey,
  actionLabel,
  actionNeedsConfirmation,
  clampSelection,
  componentSummary,
  componentTargetState,
  mcpTargetComparison,
  moveSection,
  normalizeSection,
  otherTarget,
  presetEntries,
  promptTargetState,
  safePromptPreviewText,
  selectionDelta,
  selectionWindow,
  snippetEntries,
  targetLabel,
  targetReport,
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
  claude: "yellow"
});

const COMPONENT_LABELS = Object.freeze({ mcp: "MCP", skills: "Skills", prompts: "Prompts" });

function usage() {
  process.stdout.write(`script-toolbox agent TUI

Usage:
  toolbox-tui [--section <overview|agents|mcp|skills|prompts|snippets|presets|cloud>]
  toolbox-tui --help

Keys:
  Tab / Shift+Tab / Left / Right  Switch section
  t                                 Switch Codex / Claude target
  r                                 Refresh live status
  [ / ] / Up / Down                 Select previous / next list item
  p / a                             Plan / apply selected cloud configuration
  Prompts: v local · V Workspace    View Prompt content on demand
  u                                 Roll back a preset
  Agents: c configure · p providers · x uninstall owned config
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

function Panel({ title, children, grow = 1 }) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexGrow={grow} flexDirection="column">
      <Text bold color="cyan">{title}</Text>
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

function LoadingView() {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Connecting…</Text>
      <Text color="white">Loading local controller state and encrypted Workspace metadata.</Text>
      <Text color="gray">No local or remote configuration is being changed.</Text>
    </Box>
  );
}

function Overview({ snapshot, target }) {
  const report = targetReport(snapshot, target);
  const workspace = snapshot.workspace;
  const connection = workspace || snapshot.workspaceConnection;
  const cloud = workspacePresentation(workspace, snapshot.workspaceError);
  if (!report) {
    return (
      <Box flexDirection="column">
        <ErrorText value={snapshot?.doctorError || "Diagnostics unavailable"} />
        <Row label="Workspace" value={workspace ? "connected" : cloud.status} kind={cloud.kind} />
        {connection?.endpoint && <Row label="Endpoint" value={connection.endpoint} />}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <SummaryRow name="Provider" summary={componentSummary("provider", report.provider)} />
      <SummaryRow name="MCP" summary={componentSummary("mcp", report.mcp)} />
      <SummaryRow name="Skills" summary={componentSummary("skills", report.skills)} />
      <SummaryRow name="Prompts" summary={componentSummary("prompts", report.prompt)} />
      <Row label="Snippets" value={`${Array.isArray(snapshot.snippets) ? snapshot.snippets.length : 0} local`} />
      <Row label="Preset" value={`${report.preset?.name || "none"}${report.preset?.drift ? " (drift)" : ""}`} kind={report.preset?.drift ? "bad" : "muted"} />
      <Row label="Secrets" value={snapshot.doctor?.secrets?.ok ? "available" : "missing or incomplete"} kind={snapshot.doctor?.secrets?.ok ? "good" : "bad"} />
      <Row label="Remotes" value={`${Object.values(snapshot.doctor?.remote || {}).filter((value) => value.ok).length}/3 available`} />
      <Row label="Workspace" value={workspace ? `${workspace.latest?.version || "empty"} · ${workspace.web_ui_enabled ? "web on" : "web off"}` : cloud.status} kind={cloud.kind} />
      {connection?.endpoint && <Row label="Endpoint" value={connection.endpoint} />}
    </Box>
  );
}

function Agents({ snapshot, selected }) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (agents.length === 0) return <ErrorText value={snapshot.agentsError || snapshot.doctorError || "No agent status"} />;
  const safeIndex = clampSelection(selected, agents.length);
  const current = agents[safeIndex];
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
        <SummaryRow name="Provider" summary={componentSummary("provider", { ok: true, data: current })} />
        <Row label="CLI" value={current.cli_installed ? current.cli_version || "installed" : "not installed"} kind={current.cli_installed ? "good" : "bad"} />
        {targetReport(snapshot, current.client) && <Row label="Preset" value={targetReport(snapshot, current.client)?.preset?.name || "none"} kind={targetReport(snapshot, current.client)?.preset?.drift ? "bad" : "muted"} />}
        <Text color="gray">
          <Text color="cyan" bold>c/Enter</Text> configure or install · <Text color="cyan" bold>p</Text> providers · <Text color="red" bold>x</Text> uninstall owned config
        </Text>
      </Box>
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
        [/] select · <Text color="cyan" bold>p</Text> inspect plan · <Text color="magenta" bold>a</Text> apply to {targetLabel(target)} only
      </Text>
    </Box>
  );
}

function McpView({ snapshot, target, catalog, selected }) {
  const comparison = mcpTargetComparison(snapshot);
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
      {snapshot.workspace
        ? <CloudCatalog catalog={catalog} selected={selected} target={target} component="mcp" />
        : <Text color="gray">Connect a Workspace to browse remote selections.</Text>}
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
        : <Text color="gray">Connect a Workspace to browse remote selections.</Text>}
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
        {totalLines > pageSize ? " · [/] or arrows scroll" : ""} · v/V/Esc close
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
      <ErrorText value={catalog.error} />
      <ErrorText value={snapshot.snippetsError} />
      <Text color="gray">
        [/] select · <Text color="green" bold>c</Text> copy local · <Text color="cyan" bold>p</Text> inspect cloud pull · <Text color="magenta" bold>a</Text> pull selected
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
        : <Text color="gray">Connect a Workspace to browse remote selections.</Text>}
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
  const presentation = workspacePresentation(workspace, snapshot.workspaceError);
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
      <Text bold color="green">{presentation.heading}</Text>
      <Row label="Status" value={presentation.status} kind="good" />
      <Row label="Endpoint" value={workspace.endpoint} />
      <Row label="Version" value={workspace.latest?.version || "none"} />
      <Row label="Format" value={workspace.migration_pending
        ? `schema ${workspace.remote_schema} · compatible in memory`
        : `schema ${workspace.remote_schema || 2}`} kind={workspace.migration_pending ? "warn" : "good"} />
      {workspace.migration_pending && <Text color="yellow">Upgrade preview: agentctl workspace migrate</Text>}
      <Row label="Web UI" value={workspace.web_ui_enabled ? "enabled" : "disabled"} kind={workspace.web_ui_enabled ? "good" : "muted"} />
      {Object.entries(workspace.stores || {}).map(([name, store]) => (
        <Row key={name} label={name} value={store.attached
          ? `${store.available === false ? "unreachable" : "attached"} · ${store.latest?.version || "empty"}`
          : "not attached"} kind={store.attached && store.available !== false ? "good" : store.attached ? "warn" : "muted"} />
      ))}
      <Row label="Presets" value={Object.keys(workspace.presets || {}).join(", ") || "none"} />
      <Text color="gray">Catalogs are browsed on demand and decrypted only in this process.</Text>
      <Text color="gray">Only an applied Profile, Pack, Prompt, Snippet, or Preset is materialized locally.</Text>
    </Box>
  );
}

function Help() {
  return (
    <Panel title="Keyboard help">
      <Text>Tab / Shift+Tab or arrows  switch section</Text>
      <Text>t  switch target     r  refresh     q  quit</Text>
      <Text>[ / ] or Up/Down  select previous / next item</Text>
      <Text>
        Agents: <Text color="cyan" bold>c/Enter</Text> configure or install · <Text color="cyan" bold>p</Text> providers · <Text color="red" bold>x</Text> uninstall
      </Text>
      <Text>MCP / Skills / Prompts: p inspect plan · a apply selected</Text>
      <Text>Prompts: v view active local · V view selected Workspace · [/] scroll preview</Text>
      <Text>Snippets: [/] select · c copy local · p inspect cloud pull · a pull</Text>
      <Text>Presets: p inspect plan · a apply · u rollback</Text>
      <Text>Destructive actions require y confirmation.</Text>
    </Panel>
  );
}

function App({ initialSection, controller, onLaunch }) {
  const { exit } = useApp();
  const [section, setSection] = useState(initialSection);
  const [target, setTarget] = useState("codex");
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [componentSelected, setComponentSelected] = useState({ mcp: 0, skills: 0, prompts: 0, snippets: 0 });
  const [catalogs, setCatalogs] = useState({
    mcp: { items: [], loading: false, error: "", key: "" },
    skills: { items: [], loading: false, error: "", key: "" },
    prompts: { items: [], loading: false, error: "", key: "" },
    snippets: { items: [], loading: false, error: "", key: "" }
  });
  const [message, setMessage] = useState("Loading diagnostics…");
  const [lastDetail, setLastDetail] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [promptPreview, setPromptPreview] = useState(null);
  const [promptPreviewOffset, setPromptPreviewOffset] = useState(0);

  const refresh = useCallback(async (quiet = false) => {
    setLoading(true);
    if (!quiet) setMessage("Refreshing diagnostics…");
    try {
      const next = await controller.snapshot();
      setSnapshot(next);
      setSelected((value) => clampSelection(value, presetEntries(next).length));
      setSelectedAgent((value) => clampSelection(value, Array.isArray(next.agents) ? next.agents.length : 0));
      setMessage(`Updated ${new Date(next.updatedAt).toLocaleTimeString()}`);
    } catch (error) {
      setMessage(`Refresh failed: ${error.message}`);
    } finally {
      setLoading(false);
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

  const selectedPreset = useMemo(() => presetEntries(snapshot)[selected]?.[0] || "", [snapshot, selected]);
  const selectedAgentId = Array.isArray(snapshot?.agents)
    ? snapshot.agents[selectedAgent]?.client || ""
    : "";
  const mergedSnippets = snippetEntries(snapshot?.snippets, catalogs.snippets.items);
  const selectedSnippet = mergedSnippets[clampSelection(componentSelected.snippets, mergedSnippets.length)] || null;
  const selectedRemote = section === "snippets"
    ? selectedSnippet?.remote ? selectedSnippet.name : ""
    : ["mcp", "skills", "prompts"].includes(section)
      ? catalogs[section].items[componentSelected[section]]?.name || ""
      : "";
  const selectedLocalSnippet = section === "snippets" && selectedSnippet?.local
    ? selectedSnippet.name
    : "";
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
    if (action === "agent-configure") {
      try {
        onLaunch(controller.interactiveCommand(selectedAgentId));
        exit();
      } catch (error) {
        setMessage(`Failed: ${error.message}`);
      }
      return;
    }
    setBusy(true);
    const selection = action.startsWith("agent-")
      ? selectedAgentId
      : action === "snippet-copy" ? selectedLocalSnippet
        : action.includes("-") ? selectedRemote : selectedPreset;
    setMessage(`${actionLabel(action, selection, target)}…`);
    setLastDetail("");
    try {
      const result = await controller.action(action, {
        agent: selectedAgentId,
        preset: selectedPreset,
        selection: action === "snippet-copy" ? selectedLocalSnippet : selectedRemote,
        source: snapshot?.presetSource || "local",
        target
      });
      setMessage(`${result.ok ? "Done" : "Failed"}: ${actionLabel(action, selection, target)}`);
      setLastDetail(result.detail || "");
      await refresh(true);
    } catch (error) {
      setMessage(`Failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }, [controller, exit, onLaunch, refresh, selectedAgentId, selectedLocalSnippet, selectedPreset, selectedRemote, snapshot?.presetSource, target]);

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
    if (key.tab || key.rightArrow) return setSection((value) => moveSection(value, key.shift ? -1 : 1));
    if (key.leftArrow) return setSection((value) => moveSection(value, -1));
    if (input === "t") return setTarget((value) => otherTarget(value));
    if (input === "r") return void refresh();
    const delta = selectionDelta(input, key);
    if (section === "agents" && delta !== 0) {
      return setSelectedAgent((value) => clampSelection(
        value + delta, Array.isArray(snapshot?.agents) ? snapshot.agents.length : 0
      ));
    }
    if (section === "presets" && delta !== 0) {
      return setSelected((value) => clampSelection(value + delta, presetEntries(snapshot).length));
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
      const selection = action.startsWith("agent-")
        ? selectedAgentId
        : action === "snippet-copy" ? selectedLocalSnippet
          : action.includes("-") ? selectedRemote : selectedPreset;
      setConfirm({ action, label: actionLabel(action, selection, target) });
    } else {
      void executeAction(action);
    }
  });

  let content = <LoadingView />;
  if (snapshot) {
    content = <Overview snapshot={snapshot} target={target} />;
    if (section === "agents") content = <Agents snapshot={snapshot} selected={selectedAgent} />;
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
  const panelTitle = promptPreview
    ? `Prompts · ${promptPreview.source === "cloud" ? "Workspace" : "Local"} preview`
    : ["mcp", "prompts"].includes(section)
    ? `${sectionLabel} · Claude Code vs Codex`
    : section === "snippets" ? "Snippets · Shared library"
      : ["overview", "skills", "prompts", "presets"].includes(section)
      ? `${sectionLabel} · ${targetLabel(target)}`
      : sectionLabel;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">script-toolbox / agents</Text>
        <Box gap={1}>
          <Text color="gray">{section === "snippets" ? "shared library" : "active target"}</Text>
          {section !== "snippets" && <TargetBadge target={target} selected />}
          {section !== "snippets" && <Text color="gray">t switch</Text>}
        </Box>
      </Box>
      <Box gap={1} marginBottom={1}>
        {SECTIONS.map((item) => (
          <Text
            key={item.id}
            color={section === item.id ? "black" : "gray"}
            backgroundColor={section === item.id ? "cyan" : undefined}
            bold={section === item.id}
          >
            {` ${item.label} `}
          </Text>
        ))}
      </Box>
      {showHelp ? <Help /> : <Panel title={panelTitle}>{content}</Panel>}
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
          <Text color="gray">? help · {section === "snippets" ? "" : "t target · "}r refresh · q quit</Text>
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
