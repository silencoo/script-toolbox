#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace, saveWorkspace } from "./workspace-client.mjs";

const SCHEMA = 2;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9._-]+$/;
const TARGETS = ["claude", "codex"];
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(scriptDirectory, "..");
const tools = {
  mcp: process.env.AGENTCTL_MCPCTL || join(agentRoot, "mcpctl", "mcpctl"),
  skills: process.env.AGENTCTL_SKILLSCTL || join(agentRoot, "skillsctl", "skillsctl"),
  prompt: process.env.AGENTCTL_PROMPTCTL || join(agentRoot, "promptctl", "promptctl"),
  agent: process.env.AGENTCTL_SELF || join(scriptDirectory, "agentctl")
};

class OrchestratorError extends Error {}

function usage() {
  process.stdout.write(`agentctl presets and unified diagnostics

Usage:
  agentctl preset list [--json]
  agentctl preset show <name> [--json]
  agentctl preset create <name> --mcp <profile> --skills <pack>
                         --prompt <profile> [--description <text>] --yes
  agentctl preset delete <name> --yes
  agentctl preset plan <name> --target <claude|codex> [--json]
  agentctl preset apply <name> --target <claude|codex> --yes [--json]
  agentctl preset current --target <claude|codex> [--json]
  agentctl preset rollback --target <claude|codex> --yes [--json]
  agentctl preset push --yes [--workspace-config <path>] [--json]
  agentctl preset pull --yes [--workspace-config <path>] [--json]
  agentctl doctor [claude|codex|all] [--target <target>] [--json]

Environment:
  AGENTCTL_PRESETS_FILE       Preset catalog path.
  AGENTCTL_PRESET_STATE_FILE Applied preset transaction history.
  AGENTCTL_MCPCTL             mcpctl executable override.
  AGENTCTL_SKILLSCTL          skillsctl executable override.
  AGENTCTL_PROMPTCTL          promptctl executable override.
  AGENTCTL_WORKSPACE_CONFIG   Workspace capability used by preset push/pull.
`);
}

function parseArguments(argv) {
  const positional = [];
  const options = {
    target: "",
    mcp: "",
    skills: "",
    prompt: "",
    description: "",
    yes: false,
    json: false,
    catalog: resolve(process.env.AGENTCTL_PRESETS_FILE ||
      join(homedir(), ".config", "agentctl", "presets.json")),
    state: resolve(process.env.AGENTCTL_PRESET_STATE_FILE ||
      join(homedir(), ".local", "state", "agentctl", "presets.json")),
    workspaceConfig: resolve(process.env.AGENTCTL_WORKSPACE_CONFIG ||
      join(homedir(), ".config", "agentctl", "workspace-remote.json"))
  };
  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--target": options.target = takeValue(argv, argument); break;
      case "--mcp": options.mcp = takeValue(argv, argument); break;
      case "--skills": options.skills = takeValue(argv, argument); break;
      case "--prompt": options.prompt = takeValue(argv, argument); break;
      case "--description": options.description = takeValue(argv, argument); break;
      case "--yes": case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--workspace-config": options.workspaceConfig = resolve(takeValue(argv, argument)); break;
      case "--help": case "-h": options.help = true; break;
      default:
        if (argument.startsWith("--")) throw new OrchestratorError(`unknown option: ${argument}`);
        positional.push(argument);
    }
  }
  return { positional, options };
}

function takeValue(argv, option) {
  if (argv.length === 0) throw new OrchestratorError(`${option} requires a value`);
  return argv.shift();
}

function validateName(value, label) {
  if (!NAME_PATTERN.test(value || "") || value.length > 64) {
    throw new OrchestratorError(
      `${label} must use lowercase letters, digits, and single hyphen separators`
    );
  }
  return value;
}

function validateReference(value, label) {
  if (!REFERENCE_PATTERN.test(value || "") || value.length > 64) {
    throw new OrchestratorError(
      `${label} must use letters, digits, dots, underscores, or hyphens`
    );
  }
  return value;
}

function validateTarget(value, allowAll = false) {
  if (!TARGETS.includes(value) && !(allowAll && value === "all")) {
    throw new OrchestratorError(
      `target must be ${TARGETS.join(", ")}${allowAll ? ", or all" : ""}`
    );
  }
  return value;
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path, fallback, label) {
  if (!await exists(path)) return structuredClone(fallback);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new OrchestratorError(`${label} must be a regular file: ${path}`);
  }
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch {
    throw new OrchestratorError(`invalid ${label}: ${path}`);
  }
  return value;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await exists(path)) {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new OrchestratorError(`refusing to replace non-regular file: ${path}`);
    }
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx", mode: 0o600
  });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function validateCatalog(value) {
  if (!value || value.schema !== SCHEMA || !value.presets ||
      typeof value.presets !== "object" || Array.isArray(value.presets)) {
    throw new OrchestratorError("preset catalog must contain a schema-2 presets object");
  }
  for (const [name, preset] of Object.entries(value.presets)) {
    validateName(name, "preset name");
    if (!preset || preset.schema !== SCHEMA || preset.name !== name ||
        typeof preset.description !== "string" || preset.description.length > 500) {
      throw new OrchestratorError(`preset '${name}' has invalid metadata`);
    }
    validateReference(preset.mcp, `${name}.mcp`);
    validateName(preset.skills, `${name}.skills`);
    validateReference(preset.prompt, `${name}.prompt`);
  }
  return value;
}

function validateState(value) {
  if (!value || value.schema !== SCHEMA || !value.current ||
      typeof value.current !== "object" || Array.isArray(value.current) ||
      !Array.isArray(value.history)) {
    throw new OrchestratorError("preset state must contain schema-2 current and history values");
  }
  return value;
}

async function loadCatalog(path) {
  return validateCatalog(await readJson(path, { schema: SCHEMA, presets: {} }, "preset catalog"));
}

async function loadState(path) {
  return validateState(await readJson(path, { schema: SCHEMA, current: {}, history: [] }, "preset state"));
}

function run(executable, args, { allowFailure = false } = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024
  });
  const output = {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? String(result.error.message) : "")
  };
  if (!output.ok && !allowFailure) {
    const detail = (output.stderr || output.stdout).trim();
    throw new OrchestratorError(
      `${executable} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`
    );
  }
  return output;
}

function runJson(executable, args) {
  const result = run(executable, args);
  try { return JSON.parse(result.stdout); } catch {
    throw new OrchestratorError(`${executable} returned invalid JSON for ${args.join(" ")}`);
  }
}

function currentSelection(target) {
  return {
    mcp: runJson(tools.mcp, ["current", "--target", target, "--json"]),
    skills: runJson(tools.skills, ["current", "--target", target, "--json"]),
    prompt: runJson(tools.prompt, ["current", "--target", target, "--json"])
  };
}

function planPreset(preset, target) {
  const commands = [
    { component: "mcp", executable: tools.mcp,
      args: ["plan", "--target", target, "--profile", preset.mcp] },
    { component: "skills", executable: tools.skills,
      args: ["plan", "--target", target, "--pack", preset.skills] },
    { component: "prompt", executable: tools.prompt,
      args: ["plan", "--target", target, "--profile", preset.prompt] }
  ];
  const results = commands.map((command) => ({
    component: command.component,
    ...run(command.executable, command.args, { allowFailure: true })
  }));
  return { ok: results.every((result) => result.ok), target, results };
}

function applyComponent(component, value, target) {
  if (component === "mcp") {
    return run(tools.mcp, ["apply", "--target", target, "--profile", value]);
  }
  if (component === "skills") {
    return run(tools.skills, ["apply", "--target", target, "--pack", value, "--yes"]);
  }
  return run(tools.prompt, ["apply", "--target", target, "--profile", value, "--yes"]);
}

function restoreMcp(before, target) {
  const base = before.selection_mode === "profile" && before.profile
    ? before.profile : before.base_profile || "off";
  applyComponent("mcp", base, target);
  if (before.selection_mode !== "manual") return;
  const current = runJson(tools.mcp, ["current", "--target", target, "--json"]);
  reconcile(
    new Set(current.servers), new Set(before.servers),
    (name) => run(tools.mcp, ["server", "enable", name, "--target", target]),
    (name) => run(tools.mcp, ["server", "disable", name, "--target", target])
  );
}

function restoreSkills(before, target) {
  const base = before.selection_mode === "pack" && before.pack
    ? before.pack : before.base_pack || "off";
  applyComponent("skills", base, target);
  if (before.selection_mode !== "manual") return;
  const current = runJson(tools.skills, ["current", "--target", target, "--json"]);
  reconcile(
    new Set(current.skills), new Set(before.skills),
    (name) => run(tools.skills, ["skill", "enable", name, "--target", target, "--yes"]),
    (name) => run(tools.skills, ["skill", "disable", name, "--target", target, "--yes"])
  );
}

function restorePrompt(before, target) {
  if (before.profile) {
    applyComponent("prompt", before.profile, target);
    return;
  }
  const current = runJson(tools.prompt, ["current", "--target", target, "--json"]);
  if (current.profile) {
    run(tools.prompt, ["uninstall", target, "--name", current.profile, "--yes"]);
  }
}

function reconcile(current, desired, enable, disable) {
  for (const name of [...current].filter((name) => !desired.has(name)).sort()) disable(name);
  for (const name of [...desired].filter((name) => !current.has(name)).sort()) enable(name);
}

function restoreSelection(before, target, components = ["prompt", "skills", "mcp"]) {
  const errors = [];
  for (const component of components) {
    try {
      if (component === "prompt") restorePrompt(before.prompt, target);
      else if (component === "skills") restoreSkills(before.skills, target);
      else restoreMcp(before.mcp, target);
    } catch (error) { errors.push(`${component}: ${error.message}`); }
  }
  if (errors.length > 0) throw new OrchestratorError(`rollback was incomplete: ${errors.join("; ")}`);
}

function presetMatches(preset, actual) {
  return {
    mcp: actual.mcp.selection_mode === "profile" && actual.mcp.profile === preset.mcp &&
      actual.mcp.healthy !== false,
    skills: actual.skills.selection_mode === "pack" && actual.skills.pack === preset.skills &&
      actual.skills.healthy !== false,
    prompt: actual.prompt.profile === preset.prompt && actual.prompt.managed === true &&
      actual.prompt.healthy !== false
  };
}

function printPlan(plan) {
  for (const result of plan.results) {
    process.stdout.write(`\n[${result.component}] ${result.ok ? "OK" : "ERROR"}\n`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

async function runPreset(positional, options) {
  const action = positional.shift() || "list";
  if (action === "pull") {
    if (positional.length > 0) throw new OrchestratorError("preset pull accepts no name");
    if (!options.yes) throw new OrchestratorError("preset pull requires --yes");
    const workspace = await loadWorkspace(options.workspaceConfig);
    const next = validateCatalog({ schema: SCHEMA, presets: workspace.presets });
    await writeJsonAtomic(options.catalog, next);
    const payload = { ok: true, presets: Object.keys(next.presets).sort() };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Pulled ${payload.presets.length} development preset(s) from Workspace.\n`);
    return;
  }
  const catalog = await loadCatalog(options.catalog);
  if (action === "push") {
    if (positional.length > 0) throw new OrchestratorError("preset push accepts no name");
    if (!options.yes) throw new OrchestratorError("preset push requires --yes");
    const workspace = await loadWorkspace(options.workspaceConfig);
    workspace.presets = structuredClone(catalog.presets);
    const result = await saveWorkspace(options.workspaceConfig, workspace);
    const payload = {
      ok: true,
      version: result.version,
      presets: Object.keys(catalog.presets).sort()
    };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Pushed ${payload.presets.length} development preset(s) as ${result.version}.\n`);
    return;
  }
  if (action === "list") {
    if (positional.length > 0) throw new OrchestratorError("preset list accepts no name");
    if (options.json) process.stdout.write(`${JSON.stringify(catalog.presets, null, 2)}\n`);
    else if (Object.keys(catalog.presets).length === 0) process.stdout.write("(no presets)\n");
    else for (const [name, preset] of Object.entries(catalog.presets).sort()) {
      process.stdout.write(`${name}\t${preset.mcp} / ${preset.skills} / ${preset.prompt}\n`);
    }
    return;
  }
  if (action === "create") {
    const name = validateName(positional.shift(), "preset name");
    if (positional.length > 0) throw new OrchestratorError("preset create accepts one name");
    validateReference(options.mcp, "mcp");
    validateName(options.skills, "skills");
    validateReference(options.prompt, "prompt");
    if (catalog.presets[name]) throw new OrchestratorError(`preset already exists: ${name}`);
    const preset = {
      schema: SCHEMA,
      name,
      description: options.description,
      mcp: options.mcp, skills: options.skills, prompt: options.prompt
    };
    if (!options.yes) {
      process.stdout.write(`${JSON.stringify({ name, ...preset }, null, 2)}\n`);
      process.stdout.write("[preview] re-run with --yes to create the preset\n");
      return;
    }
    catalog.presets[name] = preset;
    await writeJsonAtomic(options.catalog, catalog);
    process.stdout.write(`Created development preset '${name}'.\n`);
    return;
  }
  const name = validateName(positional.shift(), "preset name");
  if (positional.length > 0) throw new OrchestratorError(`preset ${action} accepts one name`);
  const preset = catalog.presets[name];
  if (!preset) throw new OrchestratorError(`unknown preset: ${name}`);
  if (action === "show") {
    const payload = { name, ...preset };
    process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` :
      `${name}\n  MCP: ${preset.mcp}\n  Skills: ${preset.skills}\n  Prompt: ${preset.prompt}\n`);
    return;
  }
  if (action === "delete") {
    if (!options.yes) throw new OrchestratorError("preset delete requires --yes");
    const state = await loadState(options.state);
    const active = Object.entries(state.current).filter(([, value]) => value.preset === name);
    if (active.length > 0) {
      throw new OrchestratorError(`preset is current for ${active.map(([target]) => target).join(", ")}`);
    }
    delete catalog.presets[name];
    await writeJsonAtomic(options.catalog, catalog);
    process.stdout.write(`Deleted development preset '${name}'.\n`);
    return;
  }
  if (!["plan", "apply"].includes(action)) throw new OrchestratorError(`unknown preset action: ${action}`);
  validateTarget(options.target);
  const plan = planPreset(preset, options.target);
  if (options.json && action === "plan") process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  else if (!options.json) printPlan(plan);
  if (!plan.ok) throw new OrchestratorError("preset preflight failed; no configuration was changed");
  if (action === "plan") {
    if (!options.json) process.stdout.write("\n[preview] all component plans passed\n");
    return;
  }
  if (!options.yes) throw new OrchestratorError("preset apply requires --yes");
  const before = currentSelection(options.target);
  const state = await loadState(options.state);
  const previousCurrent = state.current[options.target]
    ? structuredClone(state.current[options.target]) : null;
  const applied = [];
  try {
    for (const component of ["mcp", "skills", "prompt"]) {
      applied.push(component);
      applyComponent(component, preset[component], options.target);
    }
    const after = currentSelection(options.target);
    const transaction = {
      id: `${Date.now()}-${process.pid}`,
      target: options.target,
      preset: name,
      previous_current: previousCurrent,
      before,
      after,
      applied_at: new Date().toISOString(),
      rolled_back: false
    };
    state.current[options.target] = {
      preset: name,
      transaction_id: transaction.id,
      applied_at: transaction.applied_at
    };
    state.history.push(transaction);
    state.history = state.history.slice(-20);
    await writeJsonAtomic(options.state, state);
  } catch (error) {
    const restoreOrder = [...applied].reverse();
    try { restoreSelection(before, options.target, restoreOrder); } catch (rollbackError) {
      throw new OrchestratorError(`${error.message}; ${rollbackError.message}`);
    }
    throw new OrchestratorError(`${error.message}; previous selections were restored`);
  }
  const payload = { ok: true, target: options.target, preset: name, restart_recommended: true };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`\nApplied preset '${name}' to ${options.target}. Start a new agent session.\n`);
}

async function presetCurrentOrRollback(positional, options) {
  const action = positional[0];
  if (positional.length !== 1) throw new OrchestratorError(`preset ${action} accepts no name`);
  validateTarget(options.target);
  const catalog = await loadCatalog(options.catalog);
  const state = await loadState(options.state);
  const record = state.current[options.target] || null;
  if (action === "current") {
    const actual = currentSelection(options.target);
    const preset = record ? catalog.presets[record.preset] : null;
    const matches = preset ? presetMatches(preset, actual) : null;
    const known = record ? Boolean(preset) : true;
    const payload = {
      target: options.target,
      preset: record?.preset || null,
      known,
      applied_at: record?.applied_at || null,
      actual,
      matches,
      drift: !known || (matches ? Object.values(matches).some((value) => !value) : false)
    };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      process.stdout.write(`Target: ${options.target}\nPreset: ${payload.preset || "none"}\n`);
      process.stdout.write(`Drift: ${payload.drift ? "yes" : "no"}\n`);
    }
    return;
  }
  if (!options.yes) throw new OrchestratorError("preset rollback requires --yes");
  const transaction = [...state.history].reverse().find((item) =>
    item.target === options.target && !item.rolled_back &&
    item.id === record?.transaction_id
  );
  if (!transaction) throw new OrchestratorError(`no active preset transaction for ${options.target}`);
  restoreSelection(transaction.before, options.target);
  transaction.rolled_back = true;
  transaction.rolled_back_at = new Date().toISOString();
  if (transaction.previous_current) {
    state.current[options.target] = transaction.previous_current;
  } else {
    delete state.current[options.target];
  }
  await writeJsonAtomic(options.state, state);
  const payload = { ok: true, target: options.target, rolled_back: transaction.id, restart_recommended: true };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`Rolled back preset on ${options.target}. Start a new agent session.\n`);
}

function safeCheck(executable, args, json = false) {
  const result = run(executable, args, { allowFailure: true });
  const payload = { ok: result.ok };
  if (json && result.ok) {
    try { payload.data = JSON.parse(result.stdout); } catch { payload.ok = false; payload.error = "invalid JSON"; }
  } else {
    const summary = (result.stderr || result.stdout).trim().split("\n").slice(0, 4).join("\n");
    if (summary) payload.summary = summary;
  }
  return payload;
}

function checkHealthy(check) {
  return check.ok && check.data?.healthy !== false;
}

function providerHealthy(check) {
  return check.ok && check.data?.cli_installed !== false &&
    check.data?.provider_status !== "incomplete";
}

async function runDoctor(positional, options) {
  let requested = options.target || positional.shift() || "all";
  if (positional.length > 0) throw new OrchestratorError("doctor accepts one target");
  validateTarget(requested, true);
  const targets = requested === "all" ? TARGETS : [requested];
  const catalog = await loadCatalog(options.catalog);
  const state = await loadState(options.state);
  const reports = [];
  for (const target of targets) {
    const provider = safeCheck(tools.agent, ["status", target, "--json"], true);
    provider.healthy = providerHealthy(provider);
    const mcp = safeCheck(tools.mcp, ["current", "--target", target, "--json"], true);
    const skills = safeCheck(tools.skills, ["current", "--target", target, "--json"], true);
    const prompt = safeCheck(tools.prompt, ["current", "--target", target, "--json"], true);
    const record = state.current[target] || null;
    const preset = record ? catalog.presets[record.preset] : null;
    let matches = null;
    if (preset && mcp.data && skills.data && prompt.data) {
      matches = presetMatches(preset, { mcp: mcp.data, skills: skills.data, prompt: prompt.data });
    }
    reports.push({
      target, provider, mcp, skills, prompt,
      local_drift: {
        mcp: mcp.data?.healthy === false,
        skills: skills.data?.healthy === false,
        prompt: prompt.data?.healthy === false
      },
      preset: {
        name: record?.preset || null,
        known: record ? Boolean(preset) : true,
        matches,
        drift: matches ? Object.values(matches).some((value) => !value) : false
      },
      restart: {
        recommended: Boolean(record),
        reason: record ? "configuration profiles changed; existing sessions do not reload them" : null
      }
    });
  }
  const secretStatus = safeCheck(tools.mcp, ["secrets", "status"]);
  const remote = {
    mcp: safeCheck(tools.mcp, ["remote", "status"]),
    skills: safeCheck(tools.skills, ["remote", "status"]),
    prompt: safeCheck(tools.prompt, ["remote", "status"])
  };
  const healthy = reports.every((report) =>
    report.provider.healthy && checkHealthy(report.mcp) && checkHealthy(report.skills) &&
    checkHealthy(report.prompt) &&
    report.preset.known && !report.preset.drift
  );
  const payload = { schema: SCHEMA, healthy, targets: reports, secrets: secretStatus, remote };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    for (const report of reports) {
      process.stdout.write(`\n[${report.target}]\n`);
      for (const component of ["provider", "mcp", "skills", "prompt"]) {
        const check = report[component];
        const status = !check.ok || check.healthy === false
          ? "ERROR" : check.data?.healthy === false ? "DRIFT" : "OK";
        process.stdout.write(`${component.padEnd(9)} ${status}\n`);
      }
      process.stdout.write(`preset    ${report.preset.name || "none"}${report.preset.drift ? " (DRIFT)" : ""}\n`);
      process.stdout.write(`restart   ${report.restart.recommended ? "recommended" : "not required by agentctl"}\n`);
    }
    process.stdout.write(`\nsecrets   ${secretStatus.ok ? "OK" : "WARN"}\n`);
    for (const [name, check] of Object.entries(remote)) {
      process.stdout.write(`remote/${name.padEnd(6)} ${check.ok ? "OK" : "not configured or unreachable"}\n`);
    }
  }
  if (!healthy) process.exitCode = 1;
}

async function main(argv) {
  const { positional, options } = parseArguments(argv);
  if (options.help || positional.length === 0) { usage(); return; }
  const command = positional.shift();
  if (command === "preset") {
    if (["current", "rollback"].includes(positional[0])) {
      await presetCurrentOrRollback(positional, options);
    } else {
      await runPreset(positional, options);
    }
    return;
  }
  if (command === "doctor") { await runDoctor(positional, options); return; }
  throw new OrchestratorError(`unknown orchestrator command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof OrchestratorError ? error.message : "unexpected agentctl orchestration failure";
  process.stderr.write(`ERROR ${message}\n`);
  if (!(error instanceof OrchestratorError) && process.env.AGENTCTL_DEBUG === "1") {
    process.stderr.write(`${error.stack || error}\n`);
  }
  process.exitCode = 1;
});
