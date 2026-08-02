import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { spawnSync } from "node:child_process";
import { createController } from "./controller.mjs";
import {
  SECTIONS,
  actionForKey,
  actionLabel,
  actionNeedsConfirmation,
  clampSelection,
  componentSummary,
  moveSection,
  normalizeSection,
  otherTarget,
  presetEntries,
  targetReport,
  workspacePresentation
} from "./model.mjs";

const COLORS = Object.freeze({ good: "green", warn: "yellow", bad: "red", muted: "gray" });

function usage() {
  process.stdout.write(`script-toolbox agent TUI

Usage:
  toolbox-tui [--section <overview|agents|mcp|skills|prompts|presets|cloud>]
  toolbox-tui --help

Keys:
  Tab / Shift+Tab / Left / Right  Switch section
  t                                 Switch Codex / Claude target
  r                                 Refresh live status
  j / k / Up / Down                 Select the current list item
  p / a                             Plan / apply selected cloud configuration
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

function Panel({ title, children, grow = 1 }) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexGrow={grow} flexDirection="column">
      <Text bold color="cyan">{title}</Text>
      {children}
    </Box>
  );
}

function Row({ label, value, kind = "muted" }) {
  return (
    <Box>
      <Text color="gray">{String(label).padEnd(12)}</Text>
      <Text color={COLORS[kind] || undefined}>{value}</Text>
    </Box>
  );
}

function SummaryRow({ name, summary }) {
  return (
    <Box gap={1}>
      <Text>{name.padEnd(10)}</Text>
      <Badge kind={summary.kind}>{summary.label.padEnd(12)}</Badge>
      <Text color="gray">{summary.detail}</Text>
    </Box>
  );
}

function ErrorText({ value }) {
  if (!value) return null;
  return <Text color="red" wrap="truncate-end">{String(value).split("\n")[0]}</Text>;
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

function CloudCatalog({ catalog, selected }) {
  if (catalog.loading) return <Text color="gray">Decrypting this catalog in memory…</Text>;
  if (catalog.error) return <ErrorText value={catalog.error} />;
  if (!catalog.items.length) return <Text color="gray">No cloud selections in this Store.</Text>;
  const safeIndex = clampSelection(selected, catalog.items.length);
  const item = catalog.items[safeIndex];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">Workspace catalog</Text>
      <Box gap={2} flexDirection={process.stdout.columns && process.stdout.columns < 88 ? "column" : "row"}>
        <Box flexDirection="column" minWidth={24}>
          {catalog.items.map((entry, index) => (
            <Text key={entry.name} color={index === safeIndex ? "cyan" : undefined} bold={index === safeIndex}>
              {index === safeIndex ? "> " : "  "}{entry.name}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text bold>{item.name}</Text>
          <Row label="Includes" value={`${item.count} ${item.unit}`} />
          {item.clients?.length > 0 && <Row label="Clients" value={item.clients.join(", ")} />}
          {item.description && <Row label="About" value={item.description} />}
          <Text color="gray">p inspect plan · a apply selected only</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ComponentView({ snapshot, target, component, catalog, selected }) {
  const report = targetReport(snapshot, target);
  const check = report?.[component];
  const summary = componentSummary(component, check);
  const data = Array.isArray(check?.data) ? check.data[0] || {} : check?.data || {};
  const selection = component === "mcp"
    ? (data.selection_mode === "manual" ? "custom" : data.profile || "none")
    : component === "skills"
      ? (data.selection_mode === "manual" ? "custom" : data.pack || "none")
      : data.profile || "none";
  const items = component === "mcp" ? data.servers : component === "skills" ? data.skills : [];
  return (
    <Box flexDirection="column">
      <SummaryRow name={component[0].toUpperCase() + component.slice(1)} summary={summary} />
      <Row label="Selection" value={selection} />
      {component === "prompts" && <Row label="Managed" value={data.managed ? "yes" : "no"} kind={data.managed ? "good" : "bad"} />}
      {component !== "prompts" && <Row label="Items" value={items?.length ? items.join(", ") : "none"} />}
      {Array.isArray(data.drift) && data.drift.length > 0 && <Row label="Drift" value={data.drift.join(", ")} kind="bad" />}
      <ErrorText value={!check?.ok ? check?.summary || check?.error || snapshot.doctorError : ""} />
      {snapshot.workspace
        ? <CloudCatalog catalog={catalog} selected={selected} />
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
      <Text color="gray">Only an applied Profile, Pack, Prompt, or Preset is materialized locally.</Text>
    </Box>
  );
}

function Help() {
  return (
    <Panel title="Keyboard help">
      <Text>Tab / Shift+Tab or arrows  switch section</Text>
      <Text>t  switch target     r  refresh     q  quit</Text>
      <Text>j/k or Up/Down  select the current list item</Text>
      <Text>
        Agents: <Text color="cyan" bold>c/Enter</Text> configure or install · <Text color="cyan" bold>p</Text> providers · <Text color="red" bold>x</Text> uninstall
      </Text>
      <Text>MCP / Skills / Prompts: p inspect plan · a apply selected</Text>
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
  const [componentSelected, setComponentSelected] = useState({ mcp: 0, skills: 0, prompts: 0 });
  const [catalogs, setCatalogs] = useState({
    mcp: { items: [], loading: false, error: "", key: "" },
    skills: { items: [], loading: false, error: "", key: "" },
    prompts: { items: [], loading: false, error: "", key: "" }
  });
  const [message, setMessage] = useState("Loading diagnostics…");
  const [lastDetail, setLastDetail] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [showHelp, setShowHelp] = useState(false);

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

  const workspaceStoreId = snapshot?.workspace?.store_id || "";
  const workspaceCatalogVersion = ["mcp", "skills", "prompts"].includes(section)
    ? snapshot?.workspace?.stores?.[section]?.latest?.version || snapshot?.workspace?.latest?.version || "empty"
    : "";

  useEffect(() => {
    if (!["mcp", "skills", "prompts"].includes(section) || !workspaceStoreId) return;
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
  const selectedRemote = ["mcp", "skills", "prompts"].includes(section)
    ? catalogs[section].items[componentSelected[section]]?.name || ""
    : "";

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
      : action.includes("-") ? selectedRemote : selectedPreset;
    setMessage(`${actionLabel(action, selection, target)}…`);
    setLastDetail("");
    try {
      const result = await controller.action(action, {
        agent: selectedAgentId,
        preset: selectedPreset,
        selection: selectedRemote,
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
  }, [controller, exit, onLaunch, refresh, selectedAgentId, selectedPreset, selectedRemote, snapshot?.presetSource, target]);

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
    if (input === "?") return setShowHelp((value) => !value);
    if (showHelp && key.escape) return setShowHelp(false);
    if (key.tab || key.rightArrow) return setSection((value) => moveSection(value, key.shift ? -1 : 1));
    if (key.leftArrow) return setSection((value) => moveSection(value, -1));
    if (input === "t") return setTarget((value) => otherTarget(value));
    if (input === "r") return void refresh();
    if (section === "agents" && (input === "j" || key.downArrow)) {
      return setSelectedAgent((value) => clampSelection(
        value + 1, Array.isArray(snapshot?.agents) ? snapshot.agents.length : 0
      ));
    }
    if (section === "agents" && (input === "k" || key.upArrow)) {
      return setSelectedAgent((value) => clampSelection(
        value - 1, Array.isArray(snapshot?.agents) ? snapshot.agents.length : 0
      ));
    }
    if (section === "presets" && (input === "j" || key.downArrow)) {
      return setSelected((value) => clampSelection(value + 1, presetEntries(snapshot).length));
    }
    if (section === "presets" && (input === "k" || key.upArrow)) {
      return setSelected((value) => clampSelection(value - 1, presetEntries(snapshot).length));
    }
    if (["mcp", "skills", "prompts"].includes(section) && (input === "j" || key.downArrow)) {
      return setComponentSelected((value) => ({
        ...value,
        [section]: clampSelection(value[section] + 1, catalogs[section].items.length)
      }));
    }
    if (["mcp", "skills", "prompts"].includes(section) && (input === "k" || key.upArrow)) {
      return setComponentSelected((value) => ({
        ...value,
        [section]: clampSelection(value[section] - 1, catalogs[section].items.length)
      }));
    }
    const action = actionForKey(section, key.return ? "\r" : input);
    if (!action) return;
    if (action.startsWith("agent-") && !selectedAgentId) {
      setMessage("No agent is selected.");
      return;
    }
    if (["plan", "apply"].includes(action) && !selectedPreset) {
      setMessage("No preset is selected.");
      return;
    }
    if (action.includes("-") && !selectedRemote) {
      setMessage("No Workspace selection is available.");
      return;
    }
    if (actionNeedsConfirmation(action)) {
      const selection = action.startsWith("agent-")
        ? selectedAgentId
        : action.includes("-") ? selectedRemote : selectedPreset;
      setConfirm({ action, label: actionLabel(action, selection, target) });
    } else {
      void executeAction(action);
    }
  });

  let content = <Overview snapshot={snapshot || {}} target={target} />;
  if (section === "agents") content = <Agents snapshot={snapshot || {}} selected={selectedAgent} />;
  if (section === "mcp") content = <ComponentView snapshot={snapshot || {}} target={target} component="mcp" catalog={catalogs.mcp} selected={componentSelected.mcp} />;
  if (section === "skills") content = <ComponentView snapshot={snapshot || {}} target={target} component="skills" catalog={catalogs.skills} selected={componentSelected.skills} />;
  if (section === "prompts") content = <ComponentView snapshot={snapshot || {}} target={target} component="prompts" catalog={catalogs.prompts} selected={componentSelected.prompts} />;
  if (section === "presets") content = <Presets snapshot={snapshot || {}} selected={selected} target={target} />;
  if (section === "cloud") content = <Cloud snapshot={snapshot || {}} />;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">script-toolbox / agents</Text>
        <Text>target: <Text bold color="magenta">{target}</Text></Text>
      </Box>
      <Box gap={1} marginBottom={1}>
        {SECTIONS.map((item) => (
          <Text key={item.id} inverse={section === item.id} bold={section === item.id}>
            {` ${item.label} `}
          </Text>
        ))}
      </Box>
      {showHelp ? <Help /> : <Panel title={SECTIONS.find((item) => item.id === section)?.label || "Overview"}>{content}</Panel>}
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
          <Text color="gray">? help · t target · r refresh · q quit</Text>
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
