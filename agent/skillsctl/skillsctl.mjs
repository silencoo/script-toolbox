#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { platformConfigHome } from "../platform-paths.mjs";
import {
  RemoteStoreError,
  SKILLS_REMOTE_PROTOCOL,
  downloadRemoteSnapshot,
  getRemoteStatus,
  getRemoteWebUiSetting,
  initializeRemoteStore,
  listRemoteVersions,
  makeRecoveryCode,
  parseRecoveryCode,
  readRemoteConfig,
  setRemoteWebUiEnabled,
  uploadRemoteSnapshot,
  writeJsonAtomic
} from "../remote-store.mjs";

const VERSION = "0.4.2";
const SCHEMA = 1;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TARGETS = ["codex", "claude", "opencode", "pi"];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_BASENAMES = new Set([
  ".env",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secrets.json"
]);
const FORBIDDEN_EXTENSIONS = new Set([".key", ".p12", ".pfx"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__"]);

class SkillsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillsError";
  }
}

function usage() {
  process.stdout.write(`skillsctl — manage portable skills, packs, and recovery

Usage:
  skillsctl tui
  skillsctl update [--check|--yes]
  skillsctl init [--store <dir>] [--yes]
  skillsctl list [--store <dir>] [--json]
  skillsctl status [--store <dir>]
  skillsctl current --target <target> [--store <dir>] [--json]
  skillsctl doctor [--store <dir>]

  skillsctl skill add <directory> [--name <name>] [--store <dir>] --yes
  skillsctl skill remove <name> [--store <dir>] [--force] --yes
  skillsctl skill enable|disable <name> --target <target> [--store <dir>] [--yes]
  skillsctl skill set --target <target> [--enable <name>] [--disable <name>]
                      [--store <dir>] [--json] [--yes]

  skillsctl pack list [--store <dir>]
  skillsctl pack show <name> [--target <target>] [--store <dir>]
  skillsctl pack create <name> [--description <text>] [--extends <pack>]... --yes
  skillsctl pack save <name> --target <target> [--force] --yes
  skillsctl pack add <pack> <skill> [--store <dir>] --yes
  skillsctl pack disable <pack> <skill> [--store <dir>] --yes
  skillsctl pack remove <pack> <skill> [--store <dir>] --yes
  skillsctl pack delete <name> [--store <dir>] --yes

  skillsctl import --target <target> [--pack <name>] [--store <dir>] [--write] [--force]
  skillsctl plan --target <target|all> --pack <name> [--store <dir>]
  skillsctl apply --target <target|all> --pack <name> [--store <dir>] --yes

  skillsctl export --output <file> [--store <dir>]
  skillsctl restore-file --input <file> [--store <dir>] [--force] --yes

  skillsctl remote init --endpoint <url> [--create-token-file <file>]
                         [--remote-config <file>] [--force]
  skillsctl remote status [--remote-config <file>]
  skillsctl remote ui <status|enable|disable> [--remote-config <file>]
  skillsctl backup [--store <dir>] [--remote-config <file>]
  skillsctl restore [--store <dir>] [--remote-config <file>]
                    [--recovery-file <file>] [--version <id>] [--force] --yes
  skillsctl versions [--remote-config <file>]
  skillsctl recovery [--remote-config <file>]

Targets: codex, claude, opencode, pi, or all where documented.
Writes require --yes or --write. Project-scoped skills remain outside this store.
`);
}

function parseArguments(argv) {
  const positional = [];
  const configHome = platformConfigHome();
  const options = {
    store: process.env.SKILLSCTL_STORE || join(configHome, "skillsctl", "store"),
    remoteConfig: process.env.SKILLSCTL_REMOTE_CONFIG ||
      join(configHome, "skillsctl", "remote.json"),
    target: "",
    pack: "",
    name: "",
    description: "",
    endpoint: "",
    createTokenFile: "",
    recoveryFile: "",
    version: "",
    input: "",
    output: "",
    yes: false,
    write: false,
    force: false,
    json: false,
    extends: [],
    enable: [],
    disable: []
  };

  while (argv.length > 0) {
    const argument = argv.shift();
    switch (argument) {
      case "--store":
        options.store = takeValue(argv, argument);
        break;
      case "--remote-config":
        options.remoteConfig = takeValue(argv, argument);
        break;
      case "--target":
        options.target = takeValue(argv, argument);
        break;
      case "--pack":
        options.pack = takeValue(argv, argument);
        break;
      case "--name":
        options.name = takeValue(argv, argument);
        break;
      case "--description":
        options.description = takeValue(argv, argument);
        break;
      case "--extends":
        options.extends.push(takeValue(argv, argument));
        break;
      case "--enable":
        options.enable.push(takeValue(argv, argument));
        break;
      case "--disable":
        options.disable.push(takeValue(argv, argument));
        break;
      case "--endpoint":
        options.endpoint = takeValue(argv, argument);
        break;
      case "--create-token-file":
        options.createTokenFile = takeValue(argv, argument);
        break;
      case "--recovery-file":
        options.recoveryFile = takeValue(argv, argument);
        break;
      case "--version":
        options.version = takeValue(argv, argument);
        break;
      case "--input":
        options.input = takeValue(argv, argument);
        break;
      case "--output":
        options.output = takeValue(argv, argument);
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--write":
        options.write = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "-V":
        options.versionFlag = true;
        break;
      default:
        if (argument.startsWith("--")) {
          throw new SkillsError(`unknown option: ${argument}`);
        }
        positional.push(argument);
    }
  }
  options.store = resolve(options.store);
  options.remoteConfig = resolve(options.remoteConfig);
  return { positional, options };
}

function takeValue(argv, option) {
  if (argv.length === 0) throw new SkillsError(`${option} requires a value`);
  return argv.shift();
}

async function main(argv) {
  const { positional, options } = parseArguments(argv);
  if (options.versionFlag) {
    process.stdout.write(`skillsctl ${VERSION}\n`);
    return;
  }
  if (options.help || positional.length === 0) {
    usage();
    return;
  }

  const command = positional.shift();
  switch (command) {
    case "init":
      await initializeStore(options);
      return;
    case "list":
      await listSkills(options);
      return;
    case "status":
      await showStatus(options);
      return;
    case "current":
      await showCurrent(options);
      return;
    case "doctor":
      await doctor(options);
      return;
    case "skill":
      await runSkillCommand(positional, options);
      return;
    case "pack":
      await runPackCommand(positional, options);
      return;
    case "import":
      await importTarget(options);
      return;
    case "plan":
      await planOrApply(options, false);
      return;
    case "apply":
      await planOrApply(options, true);
      return;
    case "export":
      await exportStore(options);
      return;
    case "restore-file":
      await restoreFile(options);
      return;
    case "remote":
      await runRemoteCommand(positional, options);
      return;
    case "backup":
      await backup(options);
      return;
    case "restore":
      await restoreRemote(options);
      return;
    case "versions":
      await showVersions(options);
      return;
    case "recovery":
      await showRecovery(options);
      return;
    default:
      throw new SkillsError(`unknown command: ${command} (use --help)`);
  }
}

async function initializeStore(options) {
  if (await pathExists(join(options.store, "catalog.json"))) {
    process.stdout.write(`Store already initialized: ${options.store}\n`);
    return;
  }
  requireApply(options, "--yes");
  if (await pathExists(options.store)) {
    const details = await lstat(options.store);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new SkillsError(`store path must be a real directory: ${options.store}`);
    }
    const entries = await readdir(options.store);
    if (entries.length > 0) {
      throw new SkillsError(`refusing to initialize non-empty directory: ${options.store}`);
    }
  }
  await mkdirStoreLayout(options.store);
  await writeJsonAtomic(join(options.store, "catalog.json"), {
    schema: SCHEMA,
    skills: {}
  });
  const starterPacks = [
    packDocument("base", "Common skills enabled for every development task"),
    packDocument("frontend", "Frontend development and browser-focused skills", ["base"]),
    packDocument("backend", "Backend, database, and infrastructure skills", ["base"]),
    packDocument("fullstack", "Combined frontend and backend development skills", [
      "frontend",
      "backend"
    ]),
    packDocument("off", "Disable every skillsctl-managed skill")
  ];
  for (const pack of starterPacks) {
    await writeJsonAtomic(packPath(options.store, pack.name), pack);
  }
  process.stdout.write(`Initialized skills store: ${options.store}\n`);
}

function packDocument(name, description, extends_ = []) {
  return {
    schema: SCHEMA,
    name,
    description,
    extends: extends_,
    enable: [],
    disable: [],
    target_overrides: {}
  };
}

async function mkdirStoreLayout(store) {
  await mkdir(store, { recursive: true, mode: 0o700 });
  for (const child of ["skills", "packs", "state", "backups"]) {
    await mkdir(join(store, child), { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") await chmod(store, 0o700);
}

async function loadStore(store, { allowedSkillDrift = new Set() } = {}) {
  const catalogPath = join(store, "catalog.json");
  await assertRealDirectory(store, "skills store");
  await assertRegularFile(catalogPath, "skills catalog");
  const catalog = parseJson(
    await readFile(catalogPath, "utf8"),
    `invalid skills catalog: ${catalogPath}`
  );
  validateCatalog(catalog);
  const packs = await loadPacks(store);
  await validateStoreSkillDirectories(store, catalog, allowedSkillDrift);
  return { store, catalog, packs };
}

function validateCatalog(catalog) {
  if (!catalog || catalog.schema !== SCHEMA ||
      !catalog.skills || typeof catalog.skills !== "object" ||
      Array.isArray(catalog.skills)) {
    throw new SkillsError("catalog must contain a schema-1 skills object");
  }
  for (const [name, metadata] of Object.entries(catalog.skills)) {
    validateName(name, "skill");
    if (!metadata || typeof metadata !== "object" ||
        typeof metadata.description !== "string" ||
        typeof metadata.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
      throw new SkillsError(`catalog metadata is invalid for skill '${name}'`);
    }
  }
}

async function loadPacks(store) {
  const directory = join(store, "packs");
  await assertRealDirectory(directory, "packs directory");
  const entries = await readdir(directory, { withFileTypes: true });
  const packs = new Map();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new SkillsError(`pack must be a regular file: ${join(directory, entry.name)}`);
    }
    const name = entry.name.slice(0, -5);
    validateName(name, "pack");
    const pack = parseJson(
      await readFile(join(directory, entry.name), "utf8"),
      `invalid pack JSON: ${entry.name}`
    );
    validatePack(name, pack);
    packs.set(name, pack);
  }
  return packs;
}

function validatePack(name, pack) {
  if (!pack || pack.schema !== SCHEMA || pack.name !== name ||
      typeof pack.description !== "string" ||
      !Array.isArray(pack.extends) ||
      !Array.isArray(pack.enable) ||
      !Array.isArray(pack.disable) ||
      !pack.target_overrides ||
      typeof pack.target_overrides !== "object" ||
      Array.isArray(pack.target_overrides)) {
    throw new SkillsError(`pack '${name}' has an invalid schema`);
  }
  for (const parent of pack.extends) validateName(parent, "parent pack");
  for (const skill of [...pack.enable, ...pack.disable]) validateName(skill, "skill");
  for (const [target, override] of Object.entries(pack.target_overrides)) {
    validateTarget(target, false);
    if (!override || typeof override !== "object" ||
        (override.enable !== undefined && !Array.isArray(override.enable)) ||
        (override.disable !== undefined && !Array.isArray(override.disable))) {
      throw new SkillsError(`pack '${name}' has an invalid ${target} override`);
    }
    for (const skill of [...(override.enable || []), ...(override.disable || [])]) {
      validateName(skill, "skill");
    }
  }
}

async function validateStoreSkillDirectories(store, catalog, allowedSkillDrift = new Set()) {
  for (const [name, metadata] of Object.entries(catalog.skills)) {
    const directory = skillPath(store, name);
    await assertRealDirectory(directory, `skill '${name}'`);
    await assertRegularFile(join(directory, "SKILL.md"), `skill '${name}' entrypoint`);
    const inspected = await inspectSkillDirectory(directory, name);
    if (inspected.sha256 !== metadata.sha256 && !allowedSkillDrift.has(name)) {
      throw new SkillsError(
        `skill '${name}' changed outside skillsctl; re-add it to update the catalog checksum`
      );
    }
  }
}

async function listSkills(options) {
  const { catalog } = await loadStore(options.store);
  const names = Object.keys(catalog.skills).sort();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(names.map((name) => ({
      name,
      description: catalog.skills[name].description || ""
    })), null, 2)}\n`);
    return;
  }
  if (names.length === 0) {
    process.stdout.write("(no skills)\n");
    return;
  }
  for (const name of names) {
    process.stdout.write(`${name}\t${catalog.skills[name].description}\n`);
  }
}

async function showStatus(options) {
  const { catalog, packs } = await loadStore(options.store);
  process.stdout.write(`Store:  ${options.store}\n`);
  process.stdout.write(`Skills: ${Object.keys(catalog.skills).length}\n`);
  process.stdout.write(`Packs:  ${packs.size}\n`);
  for (const target of TARGETS) {
    const state = await readTargetState(options.store, target);
    const selection = state.selection_mode === "manual"
      ? `custom${state.base_pack ? ` based on ${state.base_pack}` : ""}`
      : state.pack || "unknown selection";
    process.stdout.write(
      `${target}: ${Object.keys(state.links).length} managed links (${selection})\n`
    );
  }
}

async function currentPayload(store, target) {
  const state = await readTargetState(store.store, target);
  const drift = new Set();
  for (const [name, record] of Object.entries(state.links)) {
    if (!await managedLinkMatches(record.link, record.target)) drift.add(name);
  }
  if (state.selection_mode === "pack" && state.pack) {
    const expected = resolvePack(store, state.pack, target);
    const actual = new Set(Object.keys(state.links));
    for (const name of new Set([...expected, ...actual])) {
      if (expected.has(name) !== actual.has(name)) drift.add(name);
    }
  }
  let baseSkills = [];
  const basePack = state.selection_mode === "manual" ? state.base_pack || "" : state.pack || "";
  if (basePack && store.packs.has(basePack)) {
    baseSkills = [...resolvePack(store, basePack, target)].sort();
  }
  return {
    schema: SCHEMA,
    target,
    selection_mode: state.selection_mode || "unknown",
    pack: state.pack || null,
    base_pack: state.base_pack || null,
    base_skills: baseSkills,
    skills: Object.keys(state.links).sort(),
    drift: [...drift].sort(),
    healthy: drift.size === 0
  };
}

async function showCurrent(options) {
  validateTarget(options.target, false);
  const store = await loadStore(options.store);
  const payload = await currentPayload(store, options.target);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const selection = payload.selection_mode === "manual"
    ? `custom${payload.base_pack ? ` (based on ${payload.base_pack})` : ""}`
    : payload.pack || "unknown";
  process.stdout.write(`Target: ${payload.target}\n`);
  process.stdout.write(`Pack: ${selection}\n`);
  process.stdout.write(`Managed skills: ${payload.skills.length}\n`);
  process.stdout.write(`Drift: ${payload.drift.length === 0 ? "none" : payload.drift.join(", ")}\n`);
}

async function doctor(options) {
  const store = await loadStore(options.store);
  for (const name of store.packs.keys()) {
    resolvePack(store, name, "codex");
  }
  let warnings = 0;
  for (const target of TARGETS) {
    const state = await readTargetState(options.store, target);
    for (const [name, record] of Object.entries(state.links)) {
      if (!await pathExists(record.link, true)) {
        process.stdout.write(`WARN ${target}/${name}: managed link is missing\n`);
        warnings += 1;
        continue;
      }
      const details = await lstat(record.link);
      if (!details.isSymbolicLink() ||
          resolve(dirname(record.link), await readlink(record.link)) !== record.target) {
        process.stdout.write(`WARN ${target}/${name}: managed path changed ownership\n`);
        warnings += 1;
      }
    }
  }
  if (warnings === 0) process.stdout.write("OK store, packs, checksums, and managed links\n");
  else process.stdout.write(`${warnings} warning(s)\n`);
}

async function runSkillCommand(positional, options) {
  const action = positional.shift();
  if (action === "add") {
    const source = positional.shift();
    if (!source || positional.length > 0) {
      throw new SkillsError("usage: skillsctl skill add <directory> [--name <name>] --yes");
    }
    await addSkill(source, options);
    return;
  }
  if (action === "remove") {
    const name = positional.shift();
    if (!name || positional.length > 0) {
      throw new SkillsError("usage: skillsctl skill remove <name> --yes");
    }
    await removeSkill(name, options);
    return;
  }
  if (action === "enable" || action === "disable") {
    const name = positional.shift();
    if (!name || positional.length > 0 || !options.target) {
      throw new SkillsError(
        `usage: skillsctl skill ${action} <name> --target <target> [--yes]`
      );
    }
    await setTargetSkills(options, [{ name, enabled: action === "enable" }], {
      singleAction: action
    });
    return;
  }
  if (action === "set") {
    if (positional.length > 0 || !options.target ||
        (options.enable.length === 0 && options.disable.length === 0)) {
      throw new SkillsError(
        "usage: skillsctl skill set --target <target> [--enable <name>] [--disable <name>] [--yes]"
      );
    }
    const changes = [
      ...options.enable.map((name) => ({ name, enabled: true })),
      ...options.disable.map((name) => ({ name, enabled: false }))
    ];
    await setTargetSkills(options, changes);
    return;
  }
  throw new SkillsError("skill command must be add, remove, enable, disable, or set");
}

async function addSkill(source, options) {
  const sourcePath = resolve(source);
  const inferredName = options.name || basename(sourcePath);
  validateName(inferredName, "skill");
  const inspected = await inspectSkillDirectory(sourcePath, inferredName);
  // A managed target is a link to the canonical Store, so an intentional edit
  // through that link changes the stored directory before its checksum can be
  // refreshed. Permit drift only for the explicitly re-added Skill; unrelated
  // Store drift must continue to fail closed.
  const store = await loadStore(options.store, {
    allowedSkillDrift: new Set([inferredName])
  });
  const existing = store.catalog.skills[inferredName];
  if (existing && existing.sha256 === inspected.sha256) {
    process.stdout.write(`Skill already matches: ${inferredName}\n`);
    return;
  }
  if (existing && !options.force) {
    throw new SkillsError(`skill '${inferredName}' already exists (use --force to replace it)`);
  }
  requireApply(options, "--yes");

  const destination = skillPath(options.store, inferredName);
  const temporary = join(options.store, "skills", `.${inferredName}.tmp-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  try {
    await copySkillFiles(sourcePath, temporary, inspected.files);
    if (await pathExists(destination)) {
      const backup = join(
        options.store,
        "backups",
        `skill-${inferredName}-${Date.now()}`
      );
      await rename(destination, backup);
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  store.catalog.skills[inferredName] = {
    description: inspected.description,
    sha256: inspected.sha256,
    source: {
      type: "local",
      location: sourcePath,
      imported_at: new Date().toISOString()
    }
  };
  await writeJsonAtomic(join(options.store, "catalog.json"), store.catalog);
  process.stdout.write(`Added skill '${inferredName}' (${inspected.files.length} files)\n`);
}

async function removeSkill(name, options) {
  validateName(name, "skill");
  const store = await loadStore(options.store);
  if (!store.catalog.skills[name]) throw new SkillsError(`unknown skill: ${name}`);
  const references = [];
  for (const [packName, pack] of store.packs) {
    if (pack.enable.includes(name) || pack.disable.includes(name) ||
        Object.values(pack.target_overrides).some((override) =>
          (override.enable || []).includes(name) || (override.disable || []).includes(name))) {
      references.push(packName);
    }
  }
  if (references.length > 0 && !options.force) {
    throw new SkillsError(
      `skill '${name}' is referenced by packs: ${references.join(", ")} (use --force)`
    );
  }
  requireApply(options, "--yes");
  if (options.force) {
    for (const packName of references) {
      const pack = store.packs.get(packName);
      pack.enable = pack.enable.filter((entry) => entry !== name);
      pack.disable = pack.disable.filter((entry) => entry !== name);
      for (const override of Object.values(pack.target_overrides)) {
        if (override.enable) override.enable = override.enable.filter((entry) => entry !== name);
        if (override.disable) override.disable = override.disable.filter((entry) => entry !== name);
      }
      await writeJsonAtomic(packPath(options.store, packName), pack);
    }
  }
  const backup = join(options.store, "backups", `skill-${name}-${Date.now()}`);
  await rename(skillPath(options.store, name), backup);
  delete store.catalog.skills[name];
  await writeJsonAtomic(join(options.store, "catalog.json"), store.catalog);
  process.stdout.write(`Removed skill '${name}' (recoverable at ${backup})\n`);
}

async function setTargetSkills(options, changes, { singleAction = "" } = {}) {
  validateTarget(options.target, false);
  const store = await loadStore(options.store);
  for (const change of changes) {
    validateName(change.name, "skill");
    if (!store.catalog.skills[change.name]) {
      throw new SkillsError(`unknown skill: ${change.name}`);
    }
  }

  const state = await readTargetState(options.store, options.target);
  const desired = new Set(Object.keys(state.links));
  for (const change of changes) {
    if (change.enabled) {
      desired.add(change.name);
    } else if (!desired.delete(change.name)) {
      const unmanagedPath = join(targetRoot(options.target), change.name);
      if (await pathExists(unmanagedPath, true)) {
        throw new SkillsError(
          `skill '${change.name}' exists for ${options.target} but is not managed by skillsctl; ` +
          `run 'skillsctl import --target ${options.target} --write' first`
        );
      }
    }
  }

  const plan = await buildTargetPlan(options.store, options.target, desired);
  if (!options.json) printTargetPlan(options.target, plan);
  if (plan.conflicts > 0) {
    throw new SkillsError(`${options.target} has ${plan.conflicts} unowned conflict(s)`);
  }
  const changed = plan.items.some((item) => item.action !== "keep");
  if (!changed) {
    const payload = await currentPayload(store, options.target);
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else if (singleAction) {
      process.stdout.write(
        `Skill '${changes[0].name}' is already ${changes[0].enabled ? "enabled" : "disabled"} for ${options.target}\n`
      );
    } else {
      process.stdout.write(`Skill selection is already current for ${options.target}\n`);
    }
    return;
  }
  if (!options.yes) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        schema: SCHEMA,
        target: options.target,
        apply: false,
        changes,
        plan: plan.items.map(({ action, name }) => ({ action, name }))
      }, null, 2)}\n`);
    } else {
      process.stdout.write("\n[preview] re-run with --yes to change managed links\n");
    }
    return;
  }

  const basePack = state.selection_mode === "manual"
    ? state.base_pack || ""
    : state.pack || "";
  await applyTargetPlan(options.store, options.target, plan, {
    selection_mode: "manual",
    ...(basePack ? { base_pack: basePack } : {})
  }, { quiet: options.json });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(
      await currentPayload(await loadStore(options.store), options.target), null, 2
    )}\n`);
  } else if (singleAction) {
    process.stdout.write(
      `${changes[0].enabled ? "Enabled" : "Disabled"} skill '${changes[0].name}' for ${options.target}\n`
    );
  } else {
    process.stdout.write(`Applied ${changes.length} Skill selection change(s) for ${options.target}\n`);
  }
}

async function runPackCommand(positional, options) {
  const action = positional.shift();
  switch (action) {
    case "list":
      await listPacks(options);
      return;
    case "show":
      await showPack(positional.shift(), options);
      return;
    case "create":
      await createPack(positional.shift(), options);
      return;
    case "save":
      await saveCurrentPack(positional.shift(), options);
      return;
    case "add":
    case "enable":
      await mutatePackSkill(positional.shift(), positional.shift(), options, "enable");
      return;
    case "disable":
      await mutatePackSkill(positional.shift(), positional.shift(), options, "disable");
      return;
    case "remove":
      await mutatePackSkill(positional.shift(), positional.shift(), options, "remove");
      return;
    case "delete":
      await deletePack(positional.shift(), options);
      return;
    default:
      throw new SkillsError(
        "pack command must be list, show, create, save, add, enable, disable, remove, or delete"
      );
  }
}

async function listPacks(options) {
  const { packs } = await loadStore(options.store);
  for (const [name, pack] of packs) {
    process.stdout.write(`${name}\t${pack.description}\n`);
  }
}

async function showPack(name, options) {
  validateName(name, "pack");
  const store = await loadStore(options.store);
  const target = options.target || "codex";
  validateTarget(target, false);
  const resolved = resolvePack(store, name, target);
  process.stdout.write(`${JSON.stringify({
    pack: store.packs.get(name),
    target,
    resolved: [...resolved].sort()
  }, null, 2)}\n`);
}

async function createPack(name, options) {
  validateName(name, "pack");
  const store = await loadStore(options.store);
  if (store.packs.has(name)) throw new SkillsError(`pack already exists: ${name}`);
  options.extends.forEach((parent) => {
    validateName(parent, "parent pack");
    if (!store.packs.has(parent)) throw new SkillsError(`unknown parent pack: ${parent}`);
  });
  requireApply(options, "--yes");
  const pack = packDocument(name, options.description || `${name} skill pack`, options.extends);
  await writeJsonAtomic(packPath(options.store, name), pack);
  process.stdout.write(`Created pack '${name}'\n`);
}

async function saveCurrentPack(name, options) {
  validateName(name, "pack");
  validateTarget(options.target, false);
  const store = await loadStore(options.store);
  const existing = store.packs.get(name);
  if (existing && !options.force) {
    throw new SkillsError(`pack already exists: ${name} (use --force to update this target)`);
  }
  requireApply(options, "--yes");
  const state = await readTargetState(options.store, options.target);
  const enabled = Object.keys(state.links).sort();
  const enabledSet = new Set(enabled);
  const disabled = Object.keys(store.catalog.skills)
    .filter((skill) => !enabledSet.has(skill))
    .sort();
  let pack;
  if (existing) {
    pack = structuredClone(existing);
  } else {
    let parent = state.selection_mode === "manual"
      ? state.base_pack || "base"
      : state.pack || "base";
    if (parent === name || !store.packs.has(parent)) parent = "base";
    pack = packDocument(name, `Saved from the current ${options.target} Skill selection`, [parent]);
  }
  pack.target_overrides = pack.target_overrides || {};
  pack.target_overrides[options.target] = { enable: enabled, disable: disabled };
  validatePack(name, pack);
  await writeJsonAtomic(packPath(options.store, name), pack);
  process.stdout.write(
    `${existing ? "Updated" : "Saved"} current ${options.target} Skill selection as pack '${name}'\n`
  );
}

async function mutatePackSkill(packName, skillName, options, mode) {
  validateName(packName, "pack");
  validateName(skillName, "skill");
  const store = await loadStore(options.store);
  const pack = store.packs.get(packName);
  if (!pack) throw new SkillsError(`unknown pack: ${packName}`);
  if (!store.catalog.skills[skillName]) throw new SkillsError(`unknown skill: ${skillName}`);
  requireApply(options, "--yes");
  pack.enable = pack.enable.filter((entry) => entry !== skillName);
  pack.disable = pack.disable.filter((entry) => entry !== skillName);
  if (mode === "enable") pack.enable.push(skillName);
  if (mode === "disable") pack.disable.push(skillName);
  pack.enable.sort();
  pack.disable.sort();
  await writeJsonAtomic(packPath(options.store, packName), pack);
  const verb = mode === "enable"
    ? "Enabled"
    : mode === "disable"
      ? "Disabled"
      : "Removed rules for";
  process.stdout.write(`${verb} '${skillName}' in pack '${packName}'\n`);
}

async function deletePack(name, options) {
  validateName(name, "pack");
  const store = await loadStore(options.store);
  if (!store.packs.has(name)) throw new SkillsError(`unknown pack: ${name}`);
  const children = [...store.packs]
    .filter(([, pack]) => pack.extends.includes(name))
    .map(([child]) => child);
  if (children.length > 0) {
    throw new SkillsError(`pack '${name}' is extended by: ${children.join(", ")}`);
  }
  requireApply(options, "--yes");
  const backup = join(options.store, "backups", `pack-${name}-${Date.now()}.json`);
  await rename(packPath(options.store, name), backup);
  process.stdout.write(`Deleted pack '${name}' (recoverable at ${backup})\n`);
}

function resolvePack(store, name, target, stack = [], enabled = new Set()) {
  const pack = store.packs.get(name);
  if (!pack) throw new SkillsError(`unknown pack: ${name}`);
  if (stack.includes(name)) {
    throw new SkillsError(`pack inheritance cycle: ${[...stack, name].join(" -> ")}`);
  }
  const nextStack = [...stack, name];
  for (const parent of pack.extends) resolvePack(store, parent, target, nextStack, enabled);
  for (const skill of pack.enable) enabled.add(skill);
  for (const skill of pack.disable) enabled.delete(skill);
  const override = pack.target_overrides[target] || {};
  for (const skill of override.enable || []) enabled.add(skill);
  for (const skill of override.disable || []) enabled.delete(skill);
  for (const skill of enabled) {
    if (!store.catalog.skills[skill]) {
      throw new SkillsError(`pack '${name}' references unknown skill '${skill}'`);
    }
  }
  return enabled;
}

async function importTarget(options) {
  validateTarget(options.target, false);
  const store = await loadStore(options.store);
  const root = targetRoot(options.target);
  if (pathsOverlap(root, options.store)) {
    throw new SkillsError("target skill directory and canonical store must not overlap");
  }
  if (!await pathExists(root)) {
    throw new SkillsError(`target skill directory does not exist: ${root}`);
  }
  await assertRealDirectory(root, `${options.target} skill directory`);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!NAME_PATTERN.test(entry.name)) continue;
    const source = join(root, entry.name);
    if (!await pathExists(join(source, "SKILL.md"))) continue;
    const inspected = await inspectSkillDirectory(source, entry.name);
    const existing = store.catalog.skills[entry.name];
    const action = !existing
      ? "add"
      : existing.sha256 === inspected.sha256
        ? "keep"
        : "conflict";
    const targetAction = await managedLinkMatches(
      source,
      skillPath(options.store, entry.name)
    ) ? "managed" : "adopt";
    candidates.push({ name: entry.name, source, inspected, action, targetAction });
  }
  for (const candidate of candidates) {
    process.stdout.write(
      `${candidate.action.padEnd(8)} ${candidate.targetAction.padEnd(8)} ${candidate.name}\n`
    );
  }
  const conflicts = candidates.filter((candidate) => candidate.action === "conflict");
  if (conflicts.length > 0 && !options.force) {
    throw new SkillsError(
      `${conflicts.length} import conflict(s); inspect the plan and use --force --write`
    );
  }
  const packName = options.pack || `imported-${options.target}`;
  validateName(packName, "pack");
  const existingPack = store.packs.get(packName);
  if (existingPack && existingPack.managed_by !== "agent/skillsctl/import" && !options.force) {
    throw new SkillsError(`refusing to replace user-owned pack '${packName}'`);
  }
  if (!options.write) {
    process.stdout.write(
      "[preview] no skills were imported or adopted; re-run with --write\n"
    );
    return;
  }
  for (const candidate of candidates) {
    if (candidate.action === "keep") continue;
    await addSkill(candidate.source, {
      ...options,
      name: candidate.name,
      yes: true,
      force: candidate.action === "conflict"
    });
  }
  const refreshed = await loadStore(options.store);
  let pack = refreshed.packs.get(packName);
  pack = pack || packDocument(packName, `Skills imported from ${options.target}`);
  pack.managed_by = "agent/skillsctl/import";
  pack.enable = candidates.map((candidate) => candidate.name).sort();
  pack.disable = [];
  await writeJsonAtomic(packPath(options.store, packName), pack);
  process.stdout.write(`Updated imported pack '${packName}'\n`);
  const backup = await adoptImportedTarget(options, candidates, packName);
  process.stdout.write(`Adopted ${candidates.length} ${options.target} skill(s)\n`);
  if (backup) process.stdout.write(`Preserved original target entries at ${backup}\n`);
}

async function adoptImportedTarget(options, candidates, packName) {
  const backupRoot = join(
    options.store,
    "backups",
    `import-${options.target}-${Date.now()}-${process.pid}`
  );
  const completed = [];
  const links = {};
  let backupCreated = false;

  try {
    for (const candidate of candidates) {
      const expectedTarget = skillPath(options.store, candidate.name);
      const current = await inspectSkillDirectory(candidate.source, candidate.name);
      if (current.sha256 !== candidate.inspected.sha256) {
        throw new SkillsError(
          `target skill '${candidate.name}' changed after the import plan; re-run import`
        );
      }
      if (await managedLinkMatches(candidate.source, expectedTarget)) {
        links[candidate.name] = { link: candidate.source, target: expectedTarget };
        continue;
      }

      if (!backupCreated) {
        await mkdir(backupRoot, { mode: 0o700 });
        backupCreated = true;
      }
      const backup = join(backupRoot, candidate.name);
      await movePath(candidate.source, backup);
      const adoption = {
        name: candidate.name,
        link: candidate.source,
        target: expectedTarget,
        backup
      };
      completed.push(adoption);
      await symlink(
        expectedTarget,
        candidate.source,
        process.platform === "win32" ? "junction" : "dir"
      );
      links[candidate.name] = { link: candidate.source, target: expectedTarget };
    }

    if (backupCreated) {
      await writeJsonAtomic(join(backupRoot, "manifest.json"), {
        schema: SCHEMA,
        kind: "skillsctl-import-backup",
        target: options.target,
        created_at: new Date().toISOString(),
        entries: completed
      });
    }
    await writeTargetState(options.store, options.target, links, {
      selection_mode: "pack",
      pack: packName
    });
  } catch (error) {
    let rollbackError = null;
    for (const item of completed.reverse()) {
      try {
        if (await managedLinkMatches(item.link, item.target)) {
          await rm(item.link);
        } else if (await pathExists(item.link, true)) {
          throw new SkillsError(`target path changed during rollback: ${item.link}`);
        }
        await movePath(item.backup, item.link);
      } catch (caught) {
        rollbackError ||= caught;
      }
    }
    if (backupCreated && !rollbackError) {
      await rm(backupRoot, { recursive: true, force: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
      throw new SkillsError(
        `${message}; rollback needs attention (${rollbackMessage}); originals remain under ${backupRoot}`
      );
    }
    throw error;
  }
  return backupCreated ? backupRoot : "";
}

async function managedLinkMatches(link, expectedTarget) {
  if (!await pathExists(link, true)) return false;
  const details = await lstat(link);
  if (!details.isSymbolicLink()) return false;
  return resolve(dirname(link), await readlink(link)) === expectedTarget;
}

async function movePath(source, destination) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true
  });
  try {
    await rm(source, { recursive: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

function pathsOverlap(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  const aToB = relative(a, b);
  const bToA = relative(b, a);
  return aToB === "" || bToA === "" ||
    (!aToB.startsWith(`..${sep}`) && aToB !== ".." && !isAbsolute(aToB)) ||
    (!bToA.startsWith(`..${sep}`) && bToA !== ".." && !isAbsolute(bToA));
}

async function planOrApply(options, apply) {
  validateTarget(options.target, true);
  validateName(options.pack, "pack");
  if (apply) requireApply(options, "--yes");
  const targets = options.target === "all" ? TARGETS : [options.target];
  const store = await loadStore(options.store);
  for (const target of targets) {
    const desired = resolvePack(store, options.pack, target);
    const plan = await buildTargetPlan(options.store, target, desired);
    printTargetPlan(target, plan);
    if (plan.conflicts > 0) {
      throw new SkillsError(`${target} has ${plan.conflicts} unowned conflict(s)`);
    }
    if (apply) {
      await applyTargetPlan(options.store, target, plan, {
        selection_mode: "pack",
        pack: options.pack
      });
    }
  }
  if (!apply) process.stdout.write("\n[preview] re-run with apply --yes to change links\n");
}

function printTargetPlan(target, plan) {
  process.stdout.write(`\n${target} (${targetRoot(target)})\n`);
  for (const item of plan.items) {
    process.stdout.write(`  ${item.action.padEnd(9)} ${item.name}\n`);
  }
}

async function buildTargetPlan(store, target, desired) {
  const root = targetRoot(target);
  const state = await readTargetState(store, target);
  const items = [];
  let conflicts = 0;
  const names = new Set([...Object.keys(state.links), ...desired]);
  for (const name of [...names].sort()) {
    const link = join(root, name);
    const expectedTarget = skillPath(store, name);
    const managed = state.links[name];
    if (desired.has(name)) {
      if (!await pathExists(link, true)) {
        items.push({ action: "create", name, link, target: expectedTarget });
      } else {
        const details = await lstat(link);
        const actual = details.isSymbolicLink()
          ? resolve(dirname(link), await readlink(link))
          : "";
        if (details.isSymbolicLink() && actual === expectedTarget) {
          items.push({ action: "keep", name, link, target: expectedTarget });
        } else {
          items.push({ action: "conflict", name, link, target: expectedTarget });
          conflicts += 1;
        }
      }
    } else if (managed) {
      if (!await pathExists(link, true)) {
        items.push({ action: "absent", name, link, target: managed.target });
      } else {
        const details = await lstat(link);
        const actual = details.isSymbolicLink()
          ? resolve(dirname(link), await readlink(link))
          : "";
        if (details.isSymbolicLink() && actual === managed.target) {
          items.push({ action: "remove", name, link, target: managed.target });
        } else {
          items.push({ action: "preserve", name, link, target: managed.target });
          conflicts += 1;
        }
      }
    }
  }
  return { root, items, conflicts };
}

async function applyTargetPlan(store, target, plan, selection = {}, { quiet = false } = {}) {
  await mkdir(plan.root, { recursive: true, mode: 0o700 });
  const nextLinks = {};
  const completed = [];
  try {
    for (const item of plan.items) {
      if (item.action === "create") {
        await symlink(item.target, item.link, process.platform === "win32" ? "junction" : "dir");
        completed.push(item);
        nextLinks[item.name] = { link: item.link, target: item.target };
      } else if (item.action === "keep") {
        nextLinks[item.name] = { link: item.link, target: item.target };
      } else if (item.action === "remove") {
        await rm(item.link);
        completed.push(item);
      }
    }
    await writeTargetState(store, target, nextLinks, selection);
  } catch (error) {
    let rollbackError = null;
    for (const item of completed.reverse()) {
      try {
        if (item.action === "create") {
          if (await managedLinkMatches(item.link, item.target)) await rm(item.link);
          else if (await pathExists(item.link, true)) {
            throw new SkillsError(`created link changed during rollback: ${item.link}`);
          }
        } else if (item.action === "remove") {
          if (await pathExists(item.link, true)) {
            throw new SkillsError(`removed link path was reused during rollback: ${item.link}`);
          }
          await symlink(item.target, item.link, process.platform === "win32" ? "junction" : "dir");
        }
      } catch (caught) {
        rollbackError ||= caught;
      }
    }
    if (rollbackError) {
      throw new SkillsError(
        `${error instanceof Error ? error.message : String(error)}; rollback needs attention (` +
        `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`
      );
    }
    throw error;
  }
  if (!quiet) process.stdout.write(`Applied ${target} skill links\n`);
}

async function writeTargetState(store, target, links, selection = {}) {
  await writeJsonAtomic(statePath(store, target), {
    schema: SCHEMA,
    target,
    links,
    ...selection,
    updated_at: new Date().toISOString()
  });
}

async function readTargetState(store, target) {
  const path = statePath(store, target);
  if (!await pathExists(path)) return { schema: SCHEMA, target, links: {} };
  await assertRegularFile(path, `${target} state`);
  const value = parseJson(await readFile(path, "utf8"), `invalid target state: ${path}`);
  if (!value || value.schema !== SCHEMA || value.target !== target ||
      !value.links || typeof value.links !== "object" || Array.isArray(value.links)) {
    throw new SkillsError(`invalid target state: ${path}`);
  }
  if (value.selection_mode !== undefined &&
      !["pack", "manual"].includes(value.selection_mode)) {
    throw new SkillsError(`invalid target selection mode: ${path}`);
  }
  if (value.pack !== undefined) validateName(value.pack, "state pack");
  if (value.base_pack !== undefined) validateName(value.base_pack, "state base pack");
  for (const [name, record] of Object.entries(value.links)) {
    validateName(name, "state skill");
    if (!record || record.link !== join(targetRoot(target), name) ||
        record.target !== skillPath(store, name)) {
      throw new SkillsError(`invalid managed link '${name}' in ${path}`);
    }
  }
  return value;
}

function targetRoot(target) {
  const overrides = {
    codex: process.env.SKILLSCTL_CODEX_DIR,
    claude: process.env.SKILLSCTL_CLAUDE_DIR,
    opencode: process.env.SKILLSCTL_OPENCODE_DIR,
    pi: process.env.SKILLSCTL_PI_DIR
  };
  if (overrides[target]) return resolve(overrides[target]);
  const roots = {
    codex: join(homedir(), ".agents", "skills"),
    claude: join(homedir(), ".claude", "skills"),
    opencode: join(homedir(), ".config", "opencode", "skills"),
    pi: join(homedir(), ".pi", "agent", "skills")
  };
  return roots[target];
}

async function exportStore(options) {
  if (!options.output) throw new SkillsError("--output is required");
  const snapshot = await collectSnapshot(options.store);
  await writeFileExclusive(resolve(options.output), `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`Exported plaintext skills snapshot: ${resolve(options.output)}\n`);
}

async function restoreFile(options) {
  if (!options.input) throw new SkillsError("--input is required");
  requireApply(options, "--yes");
  const snapshot = parseJson(
    await readFile(resolve(options.input), "utf8"),
    "skills snapshot is invalid JSON"
  );
  validateSnapshot(snapshot);
  await writeSnapshotToStore(options.store, snapshot, options.force);
  process.stdout.write(`Restored plaintext snapshot into ${options.store}\n`);
}

async function runRemoteCommand(positional, options) {
  const action = positional.shift();
  if (action === "status") {
    if (positional.length > 0) throw new SkillsError("usage: skillsctl remote status");
    const [config, status] = await Promise.all([
      readRemoteConfig(options.remoteConfig),
      getRemoteStatus(options.remoteConfig, SKILLS_REMOTE_PROTOCOL)
    ]);
    process.stdout.write(`Remote:  ${config.endpoint}/\n`);
    process.stdout.write(`Version: ${status.latest?.version || "none"}\n`);
    process.stdout.write(`Web UI:  ${status.web_ui_enabled ? "enabled" : "disabled"}\n`);
    return;
  }
  if (action === "ui") {
    const mode = positional.shift();
    if (!["status", "enable", "disable"].includes(mode) || positional.length > 0) {
      throw new SkillsError("usage: skillsctl remote ui <status|enable|disable>");
    }
    const setting = mode === "status"
      ? await getRemoteWebUiSetting(options.remoteConfig, SKILLS_REMOTE_PROTOCOL)
      : await setRemoteWebUiEnabled(
        options.remoteConfig,
        SKILLS_REMOTE_PROTOCOL,
        mode === "enable"
      );
    const config = await readRemoteConfig(options.remoteConfig);
    process.stdout.write(
      `Web UI: ${setting.web_ui_enabled ? "enabled" : "disabled"}\n` +
      `URL:    ${config.endpoint}/\n`
    );
    return;
  }
  if (action !== "init" || positional.length > 0) {
    throw new SkillsError(
      "usage: skillsctl remote init --endpoint <url> | remote status | remote ui <status|enable|disable>"
    );
  }
  if (!options.endpoint) throw new SkillsError("--endpoint is required");
  const createToken = options.createTokenFile
    ? await readPrivateSingleLine(options.createTokenFile, "store creation token")
    : (await readStandardInput(64 * 1024)).trim();
  const config = await initializeRemoteStore({
    protocol: SKILLS_REMOTE_PROTOCOL,
    endpoint: options.endpoint,
    remoteConfig: options.remoteConfig,
    createToken,
    force: options.force
  });
  process.stdout.write(
    "Recovery code (anyone with this code can decrypt and update the skills store):\n"
  );
  process.stdout.write(`${makeRecoveryCode(config, SKILLS_REMOTE_PROTOCOL)}\n`);
  if (await pathExists(join(options.store, "catalog.json"))) {
    await backup(options);
  }
}

async function backup(options) {
  const snapshot = await collectSnapshot(options.store);
  const result = await uploadRemoteSnapshot(
    options.remoteConfig,
    SKILLS_REMOTE_PROTOCOL,
    snapshot
  );
  process.stdout.write(
    `Backed up ${Object.keys(snapshot.skills).length} skills and ` +
    `${Object.keys(snapshot.packs).length} packs as ${result.version}.\n`
  );
}

async function restoreRemote(options) {
  requireApply(options, "--yes");
  let config;
  let shouldWriteConfig = false;
  if (options.recoveryFile) {
    const code = await readPrivateSingleLine(options.recoveryFile, "recovery code");
    config = parseRecoveryCode(code, SKILLS_REMOTE_PROTOCOL);
    if (!await pathExists(options.remoteConfig)) shouldWriteConfig = true;
    else {
      const existing = await readRemoteConfig(options.remoteConfig);
      if (JSON.stringify(existing) !== JSON.stringify(config) && !options.force) {
        throw new SkillsError(
          `recovery code differs from ${options.remoteConfig} (use --force)`
        );
      }
      shouldWriteConfig = JSON.stringify(existing) !== JSON.stringify(config);
    }
  } else {
    config = await readRemoteConfig(options.remoteConfig);
  }
  const snapshot = await downloadRemoteSnapshot(
    config,
    SKILLS_REMOTE_PROTOCOL,
    options.version
  );
  validateSnapshot(snapshot);
  await writeSnapshotToStore(options.store, snapshot, options.force);
  if (shouldWriteConfig) await writeJsonAtomic(options.remoteConfig, config);
  process.stdout.write(
    `Restored ${Object.keys(snapshot.skills).length} skills and ` +
    `${Object.keys(snapshot.packs).length} packs.\n`
  );
}

async function showVersions(options) {
  const page = await listRemoteVersions(
    options.remoteConfig,
    SKILLS_REMOTE_PROTOCOL,
    100
  );
  if (page.versions.length === 0) process.stdout.write("(no backups)\n");
  for (const version of page.versions) {
    process.stdout.write(
      `${version.version}\t${version.created_at}\t${version.size} bytes\n`
    );
  }
}

async function showRecovery(options) {
  const config = await readRemoteConfig(options.remoteConfig);
  process.stdout.write(
    "Anyone with this recovery code can decrypt and update the skills store:\n"
  );
  process.stdout.write(`${makeRecoveryCode(config, SKILLS_REMOTE_PROTOCOL)}\n`);
}

async function collectSnapshot(storePath) {
  const store = await loadStore(storePath);
  const skills = {};
  for (const name of Object.keys(store.catalog.skills).sort()) {
    const inspected = await inspectSkillDirectory(skillPath(storePath, name), name, true);
    skills[name] = {
      metadata: store.catalog.skills[name],
      files: Object.fromEntries(
        inspected.files.map((file) => [
          file.path,
          {
            encoding: "base64",
            mode: file.mode,
            content: file.content.toString("base64")
          }
        ])
      )
    };
  }
  const packs = {};
  for (const [name, pack] of store.packs) packs[name] = pack;
  return {
    schema: SCHEMA,
    kind: "skillsctl-store",
    created_at: new Date().toISOString(),
    catalog: store.catalog,
    skills,
    packs
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema !== SCHEMA ||
      snapshot.kind !== "skillsctl-store" ||
      !snapshot.catalog || !snapshot.skills || !snapshot.packs ||
      typeof snapshot.skills !== "object" || Array.isArray(snapshot.skills) ||
      typeof snapshot.packs !== "object" || Array.isArray(snapshot.packs)) {
    throw new SkillsError("decrypted skills snapshot has an invalid schema");
  }
  validateCatalog(snapshot.catalog);
  for (const [name, skill] of Object.entries(snapshot.skills)) {
    validateName(name, "skill");
    if (!skill || !skill.metadata || !skill.files ||
        typeof skill.files !== "object" || Array.isArray(skill.files) ||
        !skill.files["SKILL.md"]) {
      throw new SkillsError(`snapshot skill '${name}' is invalid`);
    }
    for (const [path, file] of Object.entries(skill.files)) {
      validateRelativeFilePath(path);
      if (!file || file.encoding !== "base64" ||
          typeof file.content !== "string" ||
          !Number.isInteger(file.mode)) {
        throw new SkillsError(`snapshot file '${name}/${path}' is invalid`);
      }
      decodeCanonicalBase64(file.content, `${name}/${path}`);
    }
  }
  if (Object.keys(snapshot.catalog.skills).sort().join("\n") !==
      Object.keys(snapshot.skills).sort().join("\n")) {
    throw new SkillsError("snapshot catalog and skill payloads do not match");
  }
  for (const [name, pack] of Object.entries(snapshot.packs)) validatePack(name, pack);
}

async function writeSnapshotToStore(storePath, snapshot, force) {
  validateSnapshot(snapshot);
  const resolvedStore = resolve(storePath);
  const targetExisted = await pathExists(resolvedStore);
  let targetIdentity = null;
  let existingEntries = [];
  if (targetExisted) {
    await assertRealDirectory(resolvedStore, "skills store");
    const details = await lstat(resolvedStore);
    targetIdentity = { dev: details.dev, ino: details.ino };
    existingEntries = await readdir(resolvedStore);
    if (existingEntries.length > 0 && !force) {
      throw new SkillsError(`store is not empty: ${resolvedStore} (use --force)`);
    }
  }

  await mkdir(dirname(resolvedStore), { recursive: true, mode: 0o700 });
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(6).toString("hex")}`;
  const stage = `${resolvedStore}.restore-stage-${suffix}`;
  const backup = `${resolvedStore}.restore-backup-${suffix}`;
  await mkdirStoreLayout(stage);
  try {
    const restoredCatalog = structuredClone(snapshot.catalog);
    for (const [name, skill] of Object.entries(snapshot.skills)) {
      restoredCatalog.skills[name].sha256 = materializedSnapshotSkillDigest(skill.files);
    }
    await writeJsonAtomic(join(stage, "catalog.json"), restoredCatalog);
    for (const [name, pack] of Object.entries(snapshot.packs)) {
      await writeJsonAtomic(packPath(stage, name), pack);
    }
    for (const [name, skill] of Object.entries(snapshot.skills)) {
      const destination = skillPath(stage, name);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      for (const [filePath, file] of Object.entries(skill.files)) {
        const destinationFile = join(destination, ...filePath.split("/"));
        await mkdir(dirname(destinationFile), { recursive: true, mode: 0o700 });
        const bytes = decodeCanonicalBase64(file.content, `${name}/${filePath}`);
        await writeFile(destinationFile, bytes, {
          flag: "wx",
          mode: sanitizeMode(file.mode)
        });
      }
    }
    await loadStore(stage);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }

  let backupCreated = false;
  try {
    if (targetExisted) {
      const current = await lstat(resolvedStore).catch(() => null);
      if (!current || current.isSymbolicLink() || !current.isDirectory() ||
          current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino) {
        throw new SkillsError("skills store changed while restore was being prepared");
      }
      await rename(resolvedStore, backup);
      backupCreated = true;
    } else if (await pathExists(resolvedStore)) {
      throw new SkillsError("skills store appeared while restore was being prepared");
    }
    try {
      await rename(stage, resolvedStore);
    } catch (error) {
      if (backupCreated) {
        try {
          await rename(backup, resolvedStore);
          backupCreated = false;
        } catch {
          throw new SkillsError(
            `${error?.message || "restore commit failed"}; ` +
            `the previous store remains at ${backup}`
          );
        }
      }
      throw error;
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  if (backupCreated && existingEntries.length > 0) {
    process.stdout.write(`Preserved previous store at ${backup}\n`);
  } else if (backupCreated) {
    await rm(backup, { recursive: true, force: true });
  }
}

function materializedSnapshotSkillDigest(files) {
  const hash = createHash("sha256");
  for (const [path, file] of Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const content = decodeCanonicalBase64(file.content, path);
    hash.update(path);
    hash.update("\0");
    hash.update(String(sanitizeMode(file.mode, content)));
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function inspectSkillDirectory(directory, expectedName, includeContent = false) {
  await assertDirectoryOrLink(directory, `skill '${expectedName}'`);
  const root = await realpath(directory);
  const skillFile = join(root, "SKILL.md");
  await assertRegularFile(skillFile, `skill '${expectedName}' entrypoint`);
  const markdown = await readFile(skillFile, "utf8");
  const frontmatter = parseSkillFrontmatter(markdown);
  if (frontmatter.name && frontmatter.name !== expectedName) {
    throw new SkillsError(
      `SKILL.md name '${frontmatter.name}' does not match directory '${expectedName}'`
    );
  }
  const files = [];
  let total = 0;

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const absolute = join(current, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new SkillsError(`skill contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillsError(`skill contains a non-regular file: ${relativePath}`);
      }
      validateSafeSkillFilename(entry.name, relativePath);
      const details = await stat(absolute);
      if (details.size > MAX_FILE_BYTES) {
        throw new SkillsError(`skill file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
      }
      total += details.size;
      if (total > MAX_SKILL_BYTES) {
        throw new SkillsError(`skill exceeds ${MAX_SKILL_BYTES} bytes: ${expectedName}`);
      }
      const content = await readFile(absolute);
      if (content.includes(Buffer.from("-----BEGIN PRIVATE KEY-----")) ||
          content.includes(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"))) {
        throw new SkillsError(`skill appears to contain a private key: ${relativePath}`);
      }
      files.push({
        path: relativePath,
        mode: sanitizeMode(details.mode, content),
        content: includeContent ? content : content
      });
    }
  }
  await walk(root);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new SkillsError(`skill is missing SKILL.md: ${directory}`);
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return {
    description: frontmatter.description,
    files,
    sha256: hash.digest("hex")
  };
}

function parseSkillFrontmatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    throw new SkillsError("SKILL.md must start with YAML frontmatter");
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new SkillsError("SKILL.md frontmatter is not closed");
  const values = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(name|description):\s*(.*?)\s*$/.exec(lines[index]);
    if (!field) continue;
    const style = field[2];
    if (/^[>|][+-]?$/.test(style)) {
      const block = [];
      while (index + 1 < lines.length && /^(?:[ \t]+|$)/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].replace(/^[ \t]+/, ""));
      }
      values[field[1]] = style.startsWith(">")
        ? block.join(" ").replace(/\s+/g, " ").trim()
        : block.join("\n").trim();
    } else {
      values[field[1]] = unquoteYamlScalar(style);
    }
  }
  if (!values.description) {
    throw new SkillsError("SKILL.md frontmatter requires a description");
  }
  if (values.name) validateName(values.name, "SKILL.md name");
  return values;
}

function unquoteYamlScalar(value) {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function copySkillFiles(source, destination, files) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const sourceFile = join(source, ...file.path.split("/"));
    const destinationFile = join(destination, ...file.path.split("/"));
    await mkdir(dirname(destinationFile), { recursive: true, mode: 0o700 });
    await copyFile(sourceFile, destinationFile);
    if (process.platform !== "win32") await chmod(destinationFile, file.mode);
  }
}

function validateSafeSkillFilename(name, relativePath) {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if (FORBIDDEN_BASENAMES.has(lower) || FORBIDDEN_EXTENSIONS.has(extension)) {
    throw new SkillsError(`skill contains a forbidden credential file: ${relativePath}`);
  }
}

function sanitizeMode(mode, content = Buffer.alloc(0)) {
  // Windows does not expose Unix execute bits. Preserve portable script
  // intent from a shebang so a later Linux/macOS restore remains runnable.
  const portableShebang = process.platform === "win32" &&
    content.length >= 2 && content[0] === 0x23 && content[1] === 0x21;
  return (mode & 0o111) !== 0 || portableShebang ? 0o700 : 0o600;
}

function validateRelativeFilePath(path) {
  if (typeof path !== "string" || path.length === 0 ||
      path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new SkillsError(`unsafe snapshot file path: ${path}`);
  }
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new SkillsError(`snapshot file is not valid base64: ${label}`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new SkillsError(`snapshot file is not canonical base64: ${label}`);
  }
  return bytes;
}

function validateName(value, label) {
  if (typeof value !== "string" || !NAME_PATTERN.test(value) || value.length > 64) {
    throw new SkillsError(
      `${label} must use lowercase letters, digits, and single hyphen separators`
    );
  }
  return value;
}

function validateTarget(target, allowAll) {
  if (!TARGETS.includes(target) && !(allowAll && target === "all")) {
    throw new SkillsError(`target must be ${TARGETS.join(", ")}${allowAll ? ", or all" : ""}`);
  }
}

function requireApply(options, flag) {
  if (!options.yes) throw new SkillsError(`preview complete; re-run with ${flag} to apply`);
}

function skillPath(store, name) {
  return join(store, "skills", name);
}

function packPath(store, name) {
  return join(store, "packs", `${name}.json`);
}

function statePath(store, target) {
  return join(store, "state", `${target}.json`);
}

async function assertRegularFile(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new SkillsError(`${label} not found: ${path}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new SkillsError(`${label} must be a regular file: ${path}`);
  }
}

async function assertRealDirectory(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new SkillsError(`${label} not found: ${path}`);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new SkillsError(`${label} must be a real directory: ${path}`);
  }
}

async function assertDirectoryOrLink(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch {
    throw new SkillsError(`${label} not found: ${path}`);
  }
  if (!details.isDirectory() && !details.isSymbolicLink()) {
    throw new SkillsError(`${label} must be a directory: ${path}`);
  }
  const resolved = await realpath(path);
  const resolvedDetails = await stat(resolved);
  if (!resolvedDetails.isDirectory()) {
    throw new SkillsError(`${label} link target must be a directory: ${path}`);
  }
}

async function pathExists(path, includeBrokenLink = false) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (includeBrokenLink && error?.code === "EINVAL") return true;
    throw error;
  }
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SkillsError(message);
  }
}

async function writeFileExclusive(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
}

async function readPrivateSingleLine(filePath, label) {
  const path = resolve(filePath);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new SkillsError(`${label} file must be regular: ${path}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new SkillsError(`${label} file must have mode 0600: ${path}`);
  }
  const value = await readFile(path, "utf8");
  if (!value.endsWith("\n") || value.trim().includes("\n")) {
    throw new SkillsError(`${label} file must contain exactly one line`);
  }
  return value.trim();
}

async function readStandardInput(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new SkillsError("standard input exceeded the safe limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof SkillsError || error instanceof RemoteStoreError
    ? error.message
    : "unexpected skillsctl failure";
  process.stderr.write(`✗ ${message}\n`);
  if (!(error instanceof SkillsError) && !(error instanceof RemoteStoreError) &&
      process.env.SKILLSCTL_DEBUG === "1") {
    process.stderr.write(`${error.stack || error}\n`);
  }
  process.exitCode = 1;
});
