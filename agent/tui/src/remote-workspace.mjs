import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platformConfigHome, platformDataHome } from "../../platform-paths.mjs";
import {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
  downloadRemoteSnapshot,
  encryptValue,
  getRemoteStatus,
  getRemoteWebUiSetting,
  readRemoteConfig,
  validateRemoteConfig,
  writeJsonAtomic
} from "../../remote-store.mjs";
import {
  CURRENT_WORKSPACE_SCHEMA,
  normalizeWorkspaceSchema,
  validateWorkspaceAgentBundle
} from "../../agentctl/workspace-schema.mjs";
import {
  normalizeRuntimePlatform,
  resolveProviderProfile
} from "../../agentctl/provider-schema.mjs";
import { renderProviderPlan } from "../../agentctl/provider-renderer.mjs";

const MCP_NAME = /^[A-Za-z0-9._-]+$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_SECRETS_INFO = "mcpctl/local-secrets-encryption/v1";
const PROTOCOLS = Object.freeze({
  mcp: MCP_REMOTE_PROTOCOL,
  skills: SKILLS_REMOTE_PROTOCOL,
  prompts: PROMPT_REMOTE_PROTOCOL
});

function snippetsDirectory(home) {
  return join(home, ".local", "share", "script-toolbox", "snippets");
}

function validateWorkspaceSnapshot(snapshot) {
  snapshot = normalizeWorkspaceSchema(snapshot);
  assertObject(snapshot, "Workspace snapshot");
  if (snapshot.schema !== CURRENT_WORKSPACE_SCHEMA || snapshot.kind !== "agentctl-workspace" ||
      typeof snapshot.name !== "string" || !snapshot.name ||
      !snapshot.stores || typeof snapshot.stores !== "object" || Array.isArray(snapshot.stores) ||
      !snapshot.presets || typeof snapshot.presets !== "object" || Array.isArray(snapshot.presets) ||
      !snapshot.agent || typeof snapshot.agent !== "object" || Array.isArray(snapshot.agent)) {
    throw new RemoteWorkspaceError("remote snapshot is not a valid agentctl Workspace");
  }
  for (const field of ["created_at", "updated_at"]) {
    if (typeof snapshot[field] !== "string" || Number.isNaN(Date.parse(snapshot[field]))) {
      throw new RemoteWorkspaceError(`Workspace ${field} is invalid`);
    }
  }
  for (const [type, attachment] of Object.entries(snapshot.stores)) {
    if (!PROTOCOLS[type] || attachment?.schema !== 2 || attachment.type !== type ||
        attachment.protocol !== PROTOCOLS[type].id ||
        typeof attachment.attached_at !== "string" || Number.isNaN(Date.parse(attachment.attached_at))) {
      throw new RemoteWorkspaceError(`Workspace ${type} attachment is invalid`);
    }
    attachment.config = validateRemoteConfig(attachment.config);
  }
  for (const [name, preset] of Object.entries(snapshot.presets)) {
    assertName(name, SKILL_NAME, "Workspace preset name");
    if (name.length > 64 || preset?.schema !== 2 || preset.name !== name ||
        typeof preset.description !== "string" || preset.description.length > 500 ||
        typeof preset.mcp !== "string" || preset.mcp.length > 64 ||
        preset.mcp.includes("..") || !MCP_NAME.test(preset.mcp) ||
        typeof preset.skills !== "string" || !SKILL_NAME.test(preset.skills) ||
        preset.skills.length > 64 || typeof preset.prompt !== "string" ||
        preset.prompt.length > 64 || preset.prompt.includes("..") || !MCP_NAME.test(preset.prompt)) {
      throw new RemoteWorkspaceError(`Workspace development preset '${name}' is invalid`);
    }
  }
  try {
    validateWorkspaceAgentBundle(snapshot.agent);
  } catch (error) {
    throw new RemoteWorkspaceError(`Workspace agent bundle is invalid: ${error.message}`);
  }
  return snapshot;
}

async function loadRemoteWorkspace(_path, config) {
  const snapshot = await downloadRemoteSnapshot(config, WORKSPACE_REMOTE_PROTOCOL);
  const sourceSchema = snapshot?.schema;
  const workspace = validateWorkspaceSnapshot(snapshot);
  Object.defineProperty(workspace, "source_schema", {
    value: sourceSchema,
    enumerable: false
  });
  return workspace;
}

async function loadRemoteStatus(config) {
  const [status, setting] = await Promise.all([
    getRemoteStatus(config, WORKSPACE_REMOTE_PROTOCOL),
    getRemoteWebUiSetting(config, WORKSPACE_REMOTE_PROTOCOL)
  ]);
  return { ...status, web_ui_enabled: setting.web_ui_enabled };
}

export class RemoteWorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteWorkspaceError";
  }
}

function defaultConfigPath() {
  const configHome = platformConfigHome();
  return resolve(process.env.AGENTCTL_WORKSPACE_CONFIG ||
    join(configHome, "agentctl", "workspace-remote.json"));
}

function defaultRuntimeRoot() {
  if (process.env.AGENTCTL_WORKSPACE_RUNTIME) {
    return resolve(process.env.AGENTCTL_WORKSPACE_RUNTIME);
  }
  return process.platform === "win32"
    ? resolve(platformDataHome(), "script-toolbox", "workspaces")
    : resolve(platformDataHome(), "agentctl", "workspaces");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteWorkspaceError(`${label} is invalid`);
  }
  return value;
}

function assertName(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value) || value === "." || value === "..") {
    throw new RemoteWorkspaceError(`${label} is invalid`);
  }
  return value;
}

function validateMcpSnapshot(snapshot) {
  assertObject(snapshot, "MCP snapshot");
  if (snapshot.schema !== 1) throw new RemoteWorkspaceError("MCP snapshot schema is unsupported");
  if (typeof snapshot.created_at !== "string" || Number.isNaN(Date.parse(snapshot.created_at))) {
    throw new RemoteWorkspaceError("MCP snapshot timestamp is invalid");
  }
  const catalog = assertObject(snapshot.catalog, "MCP catalog");
  if (catalog.schema !== 1) throw new RemoteWorkspaceError("MCP catalog schema is unsupported");
  assertObject(catalog.servers, "MCP servers");
  assertObject(snapshot.profiles, "MCP profiles");
  assertObject(snapshot.secrets, "MCP secrets");
  for (const name of Object.keys(catalog.servers)) assertName(name, MCP_NAME, "MCP server name");
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    assertName(name, MCP_NAME, "MCP profile name");
    assertObject(profile, `MCP profile '${name}'`);
    if ((profile.schema ?? 1) !== 1 || profile.name !== name ||
        !Array.isArray(profile.extends || []) || !Array.isArray(profile.enable || []) ||
        !Array.isArray(profile.disable || []) || !profile.target_overrides ||
        typeof profile.target_overrides !== "object" || Array.isArray(profile.target_overrides)) {
      throw new RemoteWorkspaceError(`MCP profile '${name}' is invalid`);
    }
    for (const value of [...profile.extends, ...profile.enable, ...profile.disable]) {
      assertName(value, MCP_NAME, `MCP profile '${name}' reference`);
    }
    for (const override of Object.values(profile.target_overrides)) {
      if (!override || typeof override !== "object" ||
          (override.enable !== undefined && !Array.isArray(override.enable)) ||
          (override.disable !== undefined && !Array.isArray(override.disable))) {
        throw new RemoteWorkspaceError(`MCP profile '${name}' has an invalid target override`);
      }
      for (const value of [...(override.enable || []), ...(override.disable || [])]) {
        assertName(value, MCP_NAME, `MCP profile '${name}' target reference`);
      }
    }
  }
  for (const [name, value] of Object.entries(snapshot.secrets)) {
    if (!name || typeof value !== "string") {
      throw new RemoteWorkspaceError("MCP snapshot contains invalid Secret metadata");
    }
  }
  return snapshot;
}

function validateSkillsSnapshot(snapshot) {
  assertObject(snapshot, "Skills snapshot");
  if (snapshot.schema !== 1 || snapshot.kind !== "skillsctl-store") {
    throw new RemoteWorkspaceError("Skills snapshot schema is unsupported");
  }
  const catalog = assertObject(snapshot.catalog, "Skills catalog");
  if (catalog.schema !== 1) throw new RemoteWorkspaceError("Skills catalog schema is unsupported");
  assertObject(catalog.skills, "Skills catalog entries");
  assertObject(snapshot.skills, "Skills payloads");
  assertObject(snapshot.packs, "Skill packs");
  if (typeof snapshot.created_at !== "string" || Number.isNaN(Date.parse(snapshot.created_at))) {
    throw new RemoteWorkspaceError("Skills snapshot timestamp is invalid");
  }
  if (Object.keys(catalog.skills).sort().join("\n") !== Object.keys(snapshot.skills).sort().join("\n")) {
    throw new RemoteWorkspaceError("Skills catalog and payloads do not match");
  }
  for (const [name, metadata] of Object.entries(catalog.skills)) {
    assertName(name, SKILL_NAME, "Skill name");
    if (!metadata || typeof metadata.description !== "string" ||
        typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
      throw new RemoteWorkspaceError(`Skill '${name}' metadata is invalid`);
    }
    const skill = assertObject(snapshot.skills[name], `Skill '${name}' payload`);
    if (JSON.stringify(skill.metadata) !== JSON.stringify(metadata)) {
      throw new RemoteWorkspaceError(`Skill '${name}' metadata does not match its catalog entry`);
    }
    const files = assertObject(skill.files, `Skill '${name}' files`);
    if (!files["SKILL.md"]) throw new RemoteWorkspaceError(`Skill '${name}' has no SKILL.md`);
    const hash = createHash("sha256");
    for (const [path, file] of Object.entries(files)) {
      validateRelativePath(path);
      if (![0o600, 0o700].includes(file?.mode)) {
        throw new RemoteWorkspaceError(`remote Skill file '${name}/${path}' has an unsafe mode`);
      }
      const bytes = decodeFile(file, `${name}/${path}`);
      hash.update(path);
      hash.update("\0");
      hash.update(String(file.mode));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
    if (hash.digest("hex") !== metadata.sha256) {
      throw new RemoteWorkspaceError(`Skill '${name}' digest does not match its payload`);
    }
  }
  for (const [name, pack] of Object.entries(snapshot.packs)) {
    assertName(name, SKILL_NAME, "Skill pack name");
    assertObject(pack, `Skill pack '${name}'`);
    if (pack.schema !== 1 || pack.name !== name || !Array.isArray(pack.extends) ||
        !Array.isArray(pack.enable) || !Array.isArray(pack.disable) ||
        !pack.target_overrides || typeof pack.target_overrides !== "object" ||
        Array.isArray(pack.target_overrides)) {
      throw new RemoteWorkspaceError(`Skill pack '${name}' is invalid`);
    }
    for (const value of [...pack.extends, ...pack.enable, ...pack.disable]) {
      assertName(value, SKILL_NAME, `Skill pack '${name}' reference`);
    }
    for (const override of Object.values(pack.target_overrides)) {
      if (!override || typeof override !== "object" ||
          (override.enable !== undefined && !Array.isArray(override.enable)) ||
          (override.disable !== undefined && !Array.isArray(override.disable))) {
        throw new RemoteWorkspaceError(`Skill pack '${name}' has an invalid target override`);
      }
      for (const value of [...(override.enable || []), ...(override.disable || [])]) {
        assertName(value, SKILL_NAME, `Skill pack '${name}' target reference`);
      }
    }
  }
  return snapshot;
}

function validatePromptSnapshot(snapshot) {
  assertObject(snapshot, "Prompt snapshot");
  if (snapshot.schema !== 1 || snapshot.kind !== "promptctl-store") {
    throw new RemoteWorkspaceError("Prompt snapshot schema is unsupported");
  }
  if (typeof snapshot.created_at !== "string" || Number.isNaN(Date.parse(snapshot.created_at))) {
    throw new RemoteWorkspaceError("Prompt snapshot timestamp is invalid");
  }
  assertObject(snapshot.profiles, "Prompt profiles");
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    assertName(name, MCP_NAME, "Prompt profile name");
    assertObject(profile, `Prompt profile '${name}'`);
    if (profile.schema !== 1 || profile.name !== name || typeof profile.description !== "string") {
      throw new RemoteWorkspaceError(`Prompt profile '${name}' is invalid`);
    }
    assertObject(profile.documents, `Prompt profile '${name}' documents`);
    for (const [client, document] of Object.entries(profile.documents)) {
      if (!["claude", "codex"].includes(client) || document?.schema !== 1 ||
          document.client !== client || typeof document.content !== "string" ||
          document.content.includes("\0") || Buffer.byteLength(document.content, "utf8") > 2 * 1024 * 1024 ||
          typeof document.sha256 !== "string" ||
          createHash("sha256").update(document.content, "utf8").digest("hex") !== document.sha256) {
        throw new RemoteWorkspaceError(`Prompt profile '${name}' has an invalid ${client} document`);
      }
    }
  }
  const snippets = snapshot.snippets ?? {};
  assertObject(snippets, "Prompt snippets");
  for (const [name, snippet] of Object.entries(snippets)) {
    assertName(name, MCP_NAME, "Snippet name");
    if (snippet?.schema !== 1 || snippet.name !== name ||
        typeof snippet.content !== "string" || snippet.content.includes("\0") ||
        Buffer.byteLength(snippet.content, "utf8") > 1024 * 1024 ||
        typeof snippet.sha256 !== "string" ||
        createHash("sha256").update(snippet.content, "utf8").digest("hex") !== snippet.sha256) {
      throw new RemoteWorkspaceError(`Snippet '${name}' is invalid`);
    }
  }
  return snapshot;
}

function mcpSelection(snapshot, name, target) {
  validateMcpSnapshot(snapshot);
  const profiles = [];
  const enabled = new Set();
  const visiting = new Set();
  const visited = new Set();
  const visit = (profileName) => {
    assertName(profileName, MCP_NAME, "MCP profile name");
    if (visited.has(profileName)) return;
    if (visiting.has(profileName)) {
      throw new RemoteWorkspaceError(`MCP profile inheritance cycle at '${profileName}'`);
    }
    const profile = snapshot.profiles[profileName];
    if (!profile) throw new RemoteWorkspaceError(`unknown remote MCP profile '${profileName}'`);
    visiting.add(profileName);
    for (const parent of profile.extends || []) visit(parent);
    visiting.delete(profileName);
    visited.add(profileName);
    profiles.push(profileName);
    for (const server of profile.enable || []) enabled.add(server);
    for (const server of profile.disable || []) enabled.delete(server);
    const override = profile.target_overrides?.[target] || {};
    for (const server of override.enable || []) enabled.add(server);
    for (const server of override.disable || []) enabled.delete(server);
  };
  visit(name);
  for (const server of enabled) {
    if (!snapshot.catalog.servers[server]) {
      throw new RemoteWorkspaceError(`MCP profile '${name}' references unknown server '${server}'`);
    }
  }
  return { profiles, servers: [...enabled].sort() };
}

function skillSelection(snapshot, name, target) {
  validateSkillsSnapshot(snapshot);
  const packs = [];
  const enabled = new Set();
  const visiting = new Set();
  const visited = new Set();
  const visit = (packName) => {
    assertName(packName, SKILL_NAME, "Skill pack name");
    if (visited.has(packName)) return;
    if (visiting.has(packName)) {
      throw new RemoteWorkspaceError(`Skill pack inheritance cycle at '${packName}'`);
    }
    const pack = snapshot.packs[packName];
    if (!pack) throw new RemoteWorkspaceError(`unknown remote Skill pack '${packName}'`);
    visiting.add(packName);
    for (const parent of pack.extends) visit(parent);
    visiting.delete(packName);
    visited.add(packName);
    packs.push(packName);
    for (const skill of pack.enable) enabled.add(skill);
    for (const skill of pack.disable) enabled.delete(skill);
    const override = pack.target_overrides[target] || {};
    for (const skill of override.enable || []) enabled.add(skill);
    for (const skill of override.disable || []) enabled.delete(skill);
  };
  visit(name);
  for (const skill of enabled) {
    if (!snapshot.catalog.skills[skill] || !snapshot.skills[skill]) {
      throw new RemoteWorkspaceError(`Skill pack '${name}' references unknown Skill '${skill}'`);
    }
  }
  return { packs, skills: [...enabled].sort() };
}

function secretNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => secretNames(entry, output));
  } else if (value && typeof value === "object") {
    if (typeof value.secret === "string") output.add(value.secret);
    Object.values(value).forEach((entry) => secretNames(entry, output));
  }
  return output;
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonOr(path, fallback) {
  if (!await pathExists(path)) return structuredClone(fallback);
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new RemoteWorkspaceError(`refusing non-regular runtime file: ${path}`);
  }
  try { return JSON.parse(await readFile(path, "utf8")); } catch {
    throw new RemoteWorkspaceError(`invalid Workspace runtime JSON: ${path}`);
  }
}

async function ensureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

function validateRelativePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RemoteWorkspaceError(`unsafe remote Skill path '${path}'`);
  }
}

function decodeFile(file, label) {
  if (!file || file.encoding !== "base64" || typeof file.content !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content) || !Number.isInteger(file.mode)) {
    throw new RemoteWorkspaceError(`remote Skill file '${label}' is invalid`);
  }
  const bytes = Buffer.from(file.content, "base64");
  if (bytes.toString("base64") !== file.content) {
    throw new RemoteWorkspaceError(`remote Skill file '${label}' is not canonical base64`);
  }
  return bytes;
}

export function materializedSkillDigest(files, platform = process.platform) {
  const hash = createHash("sha256");
  for (const [path, file] of Object.entries(files)
    .sort(([left], [right]) => compareSkillTraversalPaths(left, right))) {
    validateRelativePath(path);
    const bytes = decodeFile(file, path);
    const portableShebang = platform === "win32" &&
      bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
    const mode = (file.mode & 0o111) !== 0 || portableShebang ? 0o700 : 0o600;
    hash.update(path);
    hash.update("\0");
    hash.update(String(mode));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compareSkillTraversalPaths(left, right) {
  // Match skillsctl's recursively sorted filesystem walk. Sorting flattened
  // paths directly changes the order of sibling names such as `api` and
  // `api-shield`, which produces a catalog checksum that immediately appears
  // drifted after the Workspace files are materialized.
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const length = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const order = leftParts[index].localeCompare(rightParts[index]);
    if (order !== 0) return order;
  }
  return leftParts.length - rightParts.length;
}

async function writeSkill(runtime, name, skill) {
  assertName(name, SKILL_NAME, "Skill name");
  const root = join(runtime, "skills");
  await ensureDirectory(root);
  const temporary = join(root, `.${name}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  await ensureDirectory(temporary);
  try {
    for (const [path, file] of Object.entries(assertObject(skill.files, `Skill '${name}' files`))) {
      validateRelativePath(path);
      const destination = join(temporary, ...path.split("/"));
      await ensureDirectory(dirname(destination));
      await writeFile(destination, decodeFile(file, `${name}/${path}`), {
        flag: "wx",
        mode: (file.mode & 0o111) !== 0 ? 0o700 : 0o600
      });
    }
    if (!await pathExists(join(temporary, "SKILL.md"))) {
      throw new RemoteWorkspaceError(`remote Skill '${name}' has no SKILL.md`);
    }
    const destination = join(root, name);
    if (await pathExists(destination)) {
      const backupRoot = join(runtime, "backups", `remote-${Date.now()}`);
      await ensureDirectory(backupRoot);
      await rename(destination, join(backupRoot, name));
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function publicPreset(name, preset) {
  return {
    schema: 2,
    name,
    description: String(preset.description || ""),
    mcp: preset.mcp,
    skills: preset.skills,
    prompt: preset.prompt,
    source: "cloud"
  };
}

function publicProviderProfile(profile, bundle, target, {
  platform = normalizeRuntimePlatform(),
  home = homedir()
} = {}) {
  const resolved = resolveProviderProfile(profile, { target, platform });
  const secretReference = resolved.auth.secret || "";
  const secretPresent = resolved.auth.mode === "none" ||
    Boolean(secretReference && bundle.secrets?.secrets?.[secretReference]);
  const plan = renderProviderPlan(resolved, { secretPresent, home });
  return {
    name: profile.name,
    description: profile.description,
    target,
    platform,
    protocol: plan.protocol,
    endpoint: plan.endpoint,
    requested_model: plan.requested_model,
    outbound_model: plan.outbound_model,
    enabled: plan.enabled,
    compatible: plan.compatible,
    ready: plan.ready,
    issue: plan.issue,
    auth_mode: plan.auth.mode,
    secret_reference: plan.auth.secret || "",
    secret_present: plan.auth.present,
    compaction_upstream: plan.compaction.upstream,
    compaction_policy: plan.compaction.policy,
    compaction_mode: plan.compaction.mode,
    compaction_label: plan.compaction.label,
    context_window_tokens: plan.context.window_tokens,
    auto_compact_tokens: plan.context.auto_compact_tokens,
    context_label: plan.context.label,
    official_identity_policy: plan.official_identity?.policy || "",
    official_identity_account: plan.official_identity?.account || "",
    applied: false,
    source: "cloud"
  };
}

export function createRemoteWorkspace({
  workspaceConfig = defaultConfigPath(),
  runtimeRoot = defaultRuntimeRoot(),
  localHome = homedir(),
  localConfigHome = platformConfigHome({ home: localHome }),
  loadWorkspaceFn = loadRemoteWorkspace,
  readConfigFn = readRemoteConfig,
  statusFn = loadRemoteStatus,
  childStatusFn = getRemoteStatus,
  downloadFn = downloadRemoteSnapshot
} = {}) {
  let workspaceCache = null;
  let masterConfig = null;
  let publicIndex = null;
  let indexInFlight = null;
  const childCache = new Map();
  const childStoreIds = new Map();

  async function connection() {
    const config = await readConfigFn(workspaceConfig);
    return {
      schema: 1,
      endpoint: config.endpoint,
      store_id: config.store_id,
      configured: true
    };
  }

  async function index({ refresh = false } = {}) {
    if (publicIndex && !refresh) return structuredClone(publicIndex);
    if (indexInFlight) return structuredClone(await indexInFlight);
    const pending = (async () => {
      const config = await readConfigFn(workspaceConfig);
      const [workspace, status] = await Promise.all([
        loadWorkspaceFn(workspaceConfig, config).then(validateWorkspaceSnapshot),
        statusFn(config, WORKSPACE_REMOTE_PROTOCOL)
      ]);
      const childStatuses = await Promise.all(["mcp", "skills", "prompts"].map(async (type) => {
        const attachment = workspace.stores[type];
        if (!attachment) return [type, null];
        try {
          return [type, await childStatusFn(attachment.config, PROTOCOLS[type])];
        } catch (error) {
          return [type, { latest: null, error: String(error?.message || error) }];
        }
      }));
      const previousStores = publicIndex?.stores || {};
      const sourceSchema = workspace.source_schema || workspace.schema || CURRENT_WORKSPACE_SCHEMA;
      workspaceCache = workspace;
      masterConfig = config;
      publicIndex = {
        schema: 2,
        mode: "workspace",
        source: "cloud",
        remote_schema: sourceSchema,
        migration_pending: sourceSchema !== CURRENT_WORKSPACE_SCHEMA,
        endpoint: config.endpoint,
        store_id: config.store_id,
        latest: status.latest,
        web_ui_enabled: status.web_ui_enabled,
        stores: Object.fromEntries(childStatuses.map(([type, childStatus]) => {
          const attachment = workspace.stores[type];
          if (!attachment) {
            childCache.delete(type);
            childStoreIds.delete(type);
            return [type, { attached: false }];
          }
          const store = {
            attached: true,
            attached_at: attachment.attached_at,
            latest: childStatus?.latest || null,
            available: !childStatus?.error
          };
          if (previousStores[type]?.latest?.version !== store.latest?.version ||
              childStoreIds.get(type) !== attachment.config.store_id) childCache.delete(type);
          childStoreIds.set(type, attachment.config.store_id);
          return [type, store];
        })),
        presets: Object.fromEntries(Object.entries(workspace.presets)
          .map(([name, preset]) => [name, publicPreset(name, preset)])),
        agent: {
          synced: workspace.agent.providers !== null,
          synced_at: workspace.agent.synced_at,
          profiles: Object.keys(workspace.agent.providers?.profiles || {}).length,
          secrets: Object.keys(workspace.agent.secrets?.secrets || {}).length,
          failover_routes: Object.keys(workspace.agent.failover?.routes || {}).length,
          pricing_rates: Object.keys(workspace.agent.pricing?.rates || {}).length,
          pricing_version: workspace.agent.pricing?.version || null,
          secret_values: "hidden"
        }
      };
      return publicIndex;
    })();
    indexInFlight = pending;
    try {
      return structuredClone(await pending);
    } finally {
      if (indexInFlight === pending) indexInFlight = null;
    }
  }

  async function rawWorkspace() {
    if (!workspaceCache) await index();
    return workspaceCache;
  }

  async function child(type, { refresh = false } = {}) {
    if (!PROTOCOLS[type]) throw new RemoteWorkspaceError(`unknown Workspace Store '${type}'`);
    if (childCache.has(type) && !refresh) return childCache.get(type);
    const workspace = await rawWorkspace();
    const attachment = workspace.stores[type];
    if (!attachment) throw new RemoteWorkspaceError(`${type} Store is not attached to Workspace`);
    const snapshot = await downloadFn(attachment.config, PROTOCOLS[type]);
    if (type === "mcp") validateMcpSnapshot(snapshot);
    if (type === "skills") validateSkillsSnapshot(snapshot);
    if (type === "prompts") validatePromptSnapshot(snapshot);
    const value = { snapshot, config: attachment.config };
    childCache.set(type, value);
    return value;
  }

  async function catalog(type, target = "codex", options = {}) {
    if (type === "providers") {
      const workspace = await rawWorkspace();
      if (!workspace.agent.providers || !workspace.agent.secrets) return [];
      return Object.values(workspace.agent.providers.profiles)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((profile) => publicProviderProfile(profile, workspace.agent, target, {
          home: localHome
        }));
    }
    const storeType = type === "snippets" ? "prompts" : type;
    const { snapshot } = await child(storeType, options);
    if (type === "mcp") {
      return Object.entries(snapshot.profiles).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, profile]) => {
          const selected = mcpSelection(snapshot, name, target);
          return { name, description: String(profile.description || ""), count: selected.servers.length, unit: "servers", source: "cloud" };
        });
    }
    if (type === "skills") {
      return Object.entries(snapshot.packs).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, pack]) => {
          const selected = skillSelection(snapshot, name, target);
          return {
            name,
            description: String(pack.description || ""),
            count: selected.skills.length,
            unit: "skills",
            source: "cloud",
            packs: selected.packs,
            items: selected.skills,
            checksums: Object.fromEntries(selected.skills.map((skill) => [
              skill,
              snapshot.catalog.skills[skill].sha256
            ]))
          };
        });
    }
    if (type === "snippets") {
      return Object.keys(snapshot.snippets || {}).sort((a, b) => a.localeCompare(b))
        .map((name) => ({
          name,
          description: "Reusable prompt · content hidden",
          count: 1,
          unit: "snippet",
          source: "cloud"
        }));
    }
    return Object.entries(snapshot.profiles).filter(([, profile]) => Boolean(profile.documents[target]))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, profile]) => ({
        name,
        description: String(profile.description || ""),
        count: 1,
        unit: "document",
        clients: Object.keys(profile.documents).sort(),
        source: "cloud"
      }));
  }

  async function withProviderFiles(name, target, callback) {
    if (typeof callback !== "function") {
      throw new RemoteWorkspaceError("Provider action callback is invalid");
    }
    const workspace = await rawWorkspace();
    if (!workspace.agent.providers || !workspace.agent.secrets) {
      throw new RemoteWorkspaceError("Workspace has no Provider bundle");
    }
    const profile = workspace.agent.providers.profiles[name];
    if (!profile) throw new RemoteWorkspaceError(`unknown remote Provider profile '${name}'`);
    const resolved = resolveProviderProfile(profile, {
      target,
      platform: normalizeRuntimePlatform()
    });
    const providerStore = {
      ...structuredClone(workspace.agent.providers),
      profiles: { [name]: structuredClone(profile) }
    };
    const providerSecrets = {
      ...structuredClone(workspace.agent.secrets),
      secrets: {}
    };
    if (resolved.auth.mode !== "none" && resolved.auth.secret &&
        workspace.agent.secrets.secrets[resolved.auth.secret]) {
      providerSecrets.secrets[resolved.auth.secret] = structuredClone(
        workspace.agent.secrets.secrets[resolved.auth.secret]
      );
    }
    const temporary = await mkdtemp(join(tmpdir(), "agentctl-tui-provider-"));
    await chmod(temporary, 0o700);
    const storePath = join(temporary, "providers.json");
    const secretsPath = join(temporary, "provider-secrets.json");
    try {
      await Promise.all([
        writeJsonAtomic(storePath, providerStore),
        writeJsonAtomic(secretsPath, providerSecrets)
      ]);
      return await callback({ storePath, secretsPath });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function runtimePaths() {
    if (!masterConfig) await index();
    const root = join(runtimeRoot, masterConfig.store_id);
    return {
      root,
      mcp: join(root, "mcp"),
      mcpRemote: join(root, "mcp-remote.json"),
      skills: join(root, "skills"),
      skillsRemote: join(root, "skills-remote.json"),
      presets: join(root, "presets.json"),
      presetState: join(root, "preset-state.json"),
      promptBackups: join(root, "prompt-backups"),
      snippetBackups: join(root, "snippet-backups")
    };
  }

  async function runtimeEnvironment() {
    const paths = await runtimePaths();
    return {
      MCPCTL_STORE: paths.mcp,
      MCPCTL_REMOTE_CONFIG: paths.mcpRemote,
      SKILLSCTL_STORE: paths.skills,
      SKILLSCTL_REMOTE_CONFIG: paths.skillsRemote,
      AGENTCTL_PRESETS_FILE: paths.presets,
      AGENTCTL_PRESET_STATE_FILE: paths.presetState
    };
  }

  async function runtimeAvailability() {
    const paths = await runtimePaths();
    return {
      mcp: await pathExists(join(paths.mcp, "catalog.json")),
      skills: await pathExists(join(paths.skills, "catalog.json")),
      presets: await pathExists(paths.presets)
    };
  }

  async function withLocalChildCapability(type, callback) {
    if (!["mcp", "skills"].includes(type) || typeof callback !== "function") {
      throw new RemoteWorkspaceError("local child Store restore request is invalid");
    }
    const { config } = await child(type);
    const paths = await runtimePaths();
    const stagedConfig = type === "mcp" ? paths.mcpRemote : paths.skillsRemote;
    const localConfig = join(localConfigHome, `${type}ctl`, "remote.json");
    let existing = null;
    if (await pathExists(localConfig)) {
      existing = await readRemoteConfig(localConfig);
      validateRemoteConfig(existing, PROTOCOLS[type]);
      if (existing.endpoint !== config.endpoint || existing.store_id !== config.store_id ||
          existing.root_key !== config.root_key) {
        throw new RemoteWorkspaceError(
          `local ${type}ctl remote configuration belongs to a different encrypted Store`
        );
      }
    }
    await ensureDirectory(dirname(stagedConfig));
    await writeJsonAtomic(stagedConfig, config);
    const result = await callback({ remoteConfig: stagedConfig });
    const succeeded = result &&
      (result.ok === true || (Number.isInteger(result.code) && result.code === 0));
    if (succeeded && !existing) {
      await ensureDirectory(dirname(localConfig));
      await writeJsonAtomic(localConfig, config);
    }
    return result;
  }

  async function materializeMcp(name, target) {
    const { snapshot, config } = await child("mcp");
    const selection = mcpSelection(snapshot, name, target);
    const paths = await runtimePaths();
    await ensureDirectory(paths.mcp);
    await ensureDirectory(join(paths.mcp, "profiles"));
    const catalogPath = join(paths.mcp, "catalog.json");
    const catalog = await readJsonOr(catalogPath, { schema: 1, servers: {} });
    if (catalog.schema !== 1 || !catalog.servers || typeof catalog.servers !== "object") {
      throw new RemoteWorkspaceError("Workspace MCP runtime catalog is invalid");
    }
    const selectedDefinitions = {};
    for (const server of selection.servers) {
      selectedDefinitions[server] = snapshot.catalog.servers[server];
      catalog.servers[server] = snapshot.catalog.servers[server];
    }
    await writeJsonAtomic(catalogPath, catalog);
    for (const profile of selection.profiles) {
      await writeJsonAtomic(join(paths.mcp, "profiles", `${profile}.json`), snapshot.profiles[profile]);
    }
    const neededSecrets = secretNames(selectedDefinitions);
    const secrets = {};
    for (const secret of neededSecrets) {
      if (typeof snapshot.secrets[secret] === "string") secrets[secret] = snapshot.secrets[secret];
    }
    await writeJsonAtomic(join(paths.mcp, "secrets.remote.enc"), encryptValue(
      "mcpctl-local-secrets",
      LOCAL_SECRETS_INFO,
      config,
      { schema: 1, secrets }
    ));
    await writeJsonAtomic(paths.mcpRemote, config);
    return { name, ...selection, store: paths.mcp, remoteConfig: paths.mcpRemote };
  }

  async function materializeSkills(name, target) {
    const { snapshot } = await child("skills");
    const selection = skillSelection(snapshot, name, target);
    const paths = await runtimePaths();
    await ensureDirectory(paths.skills);
    for (const directory of ["skills", "packs", "state", "backups"]) {
      await ensureDirectory(join(paths.skills, directory));
    }
    const catalogPath = join(paths.skills, "catalog.json");
    const catalog = await readJsonOr(catalogPath, { schema: 1, skills: {} });
    if (catalog.schema !== 1 || !catalog.skills || typeof catalog.skills !== "object") {
      throw new RemoteWorkspaceError("Workspace Skills runtime catalog is invalid");
    }
    for (const skill of selection.skills) {
      await writeSkill(paths.skills, skill, snapshot.skills[skill]);
      catalog.skills[skill] = {
        ...snapshot.catalog.skills[skill],
        sha256: materializedSkillDigest(snapshot.skills[skill].files)
      };
    }
    await writeJsonAtomic(catalogPath, catalog);
    for (const pack of selection.packs) {
      await writeJsonAtomic(join(paths.skills, "packs", `${pack}.json`), snapshot.packs[pack]);
    }
    return { name, ...selection, store: paths.skills };
  }

  async function promptDocument(name, target) {
    const { snapshot } = await child("prompts");
    assertName(name, MCP_NAME, "Prompt profile name");
    if (!["claude", "codex"].includes(target)) {
      throw new RemoteWorkspaceError(`unsupported Prompt target '${target}'`);
    }
    const profile = snapshot.profiles[name];
    if (!profile) throw new RemoteWorkspaceError(`unknown remote Prompt profile '${name}'`);
    const document = profile.documents[target];
    if (!document) throw new RemoteWorkspaceError(`Prompt profile '${name}' has no ${target} document`);
    return { name, target, content: document.content };
  }

  async function promptSelection(name, target) {
    const document = await promptDocument(name, target);
    const directory = join(localHome, target === "claude" ? ".claude" : ".codex", "instructions");
    const path = join(directory, `${name}.md`);
    let current = null;
    if (await pathExists(path)) {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new RemoteWorkspaceError(`refusing to replace non-regular Prompt file: ${path}`);
      }
      current = await readFile(path, "utf8");
    }
    return {
      name,
      target,
      path,
      content: document.content,
      action: current === null ? "create" : current === document.content ? "keep" : "replace",
      previous: current
    };
  }

  async function writePrompt(selection) {
    if (selection.action === "keep") return { backup: "" };
    await ensureDirectory(dirname(selection.path));
    let backup = "";
    if (selection.previous !== null) {
      const paths = await runtimePaths();
      const backupDirectory = join(paths.promptBackups, `${Date.now()}-${selection.target}`);
      await ensureDirectory(backupDirectory);
      backup = join(backupDirectory, `${selection.name}.md`);
      await rename(selection.path, backup);
    }
    const temporary = `${selection.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temporary, selection.content, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, selection.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (backup && !await pathExists(selection.path)) {
        await rename(backup, selection.path).catch(() => {});
      }
      throw error;
    }
    return { backup };
  }

  async function restorePrompt(selection) {
    if (selection.action === "keep") return;
    if (selection.previous === null) {
      await rm(selection.path, { force: true });
    } else {
      const temporary = `${selection.path}.restore-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(temporary, selection.previous, { flag: "wx", mode: 0o600 });
      if (await pathExists(selection.path)) await rm(selection.path, { force: true });
      await rename(temporary, selection.path);
    }
  }

  async function snippetSelection(name) {
    const { snapshot } = await child("prompts");
    assertName(name, MCP_NAME, "Snippet name");
    const snippet = snapshot.snippets?.[name];
    if (!snippet) throw new RemoteWorkspaceError(`unknown remote Snippet '${name}'`);
    const path = join(snippetsDirectory(localHome), `${name}.md`);
    let current = null;
    if (await pathExists(path)) {
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new RemoteWorkspaceError(`refusing to replace non-regular Snippet file: ${path}`);
      }
      current = await readFile(path, "utf8");
    }
    return {
      name,
      path,
      content: snippet.content,
      action: current === null ? "create" : current === snippet.content ? "keep" : "replace",
      previous: current
    };
  }

  async function writeSnippet(selection) {
    if (selection.action === "keep") return { backup: "" };
    await ensureDirectory(dirname(selection.path));
    let backup = "";
    if (selection.previous !== null) {
      const paths = await runtimePaths();
      const backupDirectory = join(paths.snippetBackups, `${Date.now()}`);
      await ensureDirectory(backupDirectory);
      backup = join(backupDirectory, `${selection.name}.md`);
      await rename(selection.path, backup);
    }
    const temporary = `${selection.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await writeFile(temporary, selection.content, { flag: "wx", mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, selection.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (backup && !await pathExists(selection.path)) {
        await rename(backup, selection.path).catch(() => {});
      }
      throw error;
    }
    return { backup };
  }

  async function restoreSnippet(selection) {
    if (selection.action === "keep") return;
    if (selection.previous === null) {
      await rm(selection.path, { force: true });
    } else {
      const temporary = `${selection.path}.restore-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(temporary, selection.previous, { flag: "wx", mode: 0o600 });
      if (await pathExists(selection.path)) await rm(selection.path, { force: true });
      await rename(temporary, selection.path);
    }
  }

  async function selectionPlan(name, target) {
    const workspace = await rawWorkspace();
    const preset = workspace.presets[name];
    if (!preset) throw new RemoteWorkspaceError(`unknown remote development preset '${name}'`);
    const [{ snapshot: mcpSnapshot }, { snapshot: skillsSnapshot }, prompt] = await Promise.all([
      child("mcp"),
      child("skills"),
      promptSelection(preset.prompt, target)
    ]);
    const mcp = mcpSelection(mcpSnapshot, preset.mcp, target);
    const skills = skillSelection(skillsSnapshot, preset.skills, target);
    return {
      name,
      target,
      preset: publicPreset(name, preset),
      mcp: { name: preset.mcp, profiles: mcp.profiles, servers: mcp.servers },
      skills: { name: preset.skills, packs: skills.packs, skills: skills.skills },
      prompt: { name: preset.prompt, action: prompt.action, path: prompt.path }
    };
  }

  async function componentPlan(type, name, target) {
    if (type === "mcp") {
      const { snapshot } = await child("mcp");
      const selection = mcpSelection(snapshot, name, target);
      return { type, name, target, profiles: selection.profiles, items: selection.servers, unit: "servers" };
    }
    if (type === "skills") {
      const { snapshot } = await child("skills");
      const selection = skillSelection(snapshot, name, target);
      return {
        type,
        name,
        target,
        packs: selection.packs,
        items: selection.skills,
        checksums: Object.fromEntries(selection.skills.map((skill) => [
          skill,
          snapshot.catalog.skills[skill].sha256
        ])),
        unit: "skills"
      };
    }
    if (type === "prompts") {
      const selection = await promptSelection(name, target);
      return { type, name, target, action: selection.action, path: selection.path, items: [], unit: "documents" };
    }
    if (type === "snippets") {
      const selection = await snippetSelection(name);
      return { type, name, action: selection.action, path: selection.path, items: [], unit: "snippets" };
    }
    throw new RemoteWorkspaceError(`unsupported remote component '${type}'`);
  }

  async function materializePreset(name, target) {
    const workspace = await rawWorkspace();
    const preset = workspace.presets[name];
    if (!preset) throw new RemoteWorkspaceError(`unknown remote development preset '${name}'`);
    const [mcp, skills, prompt] = await Promise.all([
      materializeMcp(preset.mcp, target),
      materializeSkills(preset.skills, target),
      promptSelection(preset.prompt, target)
    ]);
    const paths = await runtimePaths();
    const catalog = await readJsonOr(paths.presets, { schema: 2, presets: {} });
    catalog.schema = 2;
    catalog.presets ||= {};
    catalog.presets[name] = publicPreset(name, preset);
    delete catalog.presets[name].source;
    await writeJsonAtomic(paths.presets, catalog);
    return { name, preset: publicPreset(name, preset), mcp, skills, prompt, paths };
  }

  async function materializeComponent(type, name, target) {
    if (type === "mcp") return materializeMcp(name, target);
    if (type === "skills") return materializeSkills(name, target);
    if (type === "prompts") return promptSelection(name, target);
    if (type === "snippets") return snippetSelection(name);
    throw new RemoteWorkspaceError(`unsupported remote component '${type}'`);
  }

  return {
    catalog,
    child,
    componentPlan,
    connection,
    index,
    materializeComponent,
    materializePreset,
    promptDocument,
    promptSelection,
    restoreSnippet,
    restorePrompt,
    runtimeAvailability,
    runtimeEnvironment,
    runtimePaths,
    selectionPlan,
    snippetSelection,
    withProviderFiles,
    withLocalChildCapability,
    writeSnippet,
    writePrompt
  };
}

export {
  mcpSelection,
  skillSelection,
  validateMcpSnapshot,
  validatePromptSnapshot,
  validateSkillsSnapshot,
  validateWorkspaceSnapshot
};
