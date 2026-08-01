import {
  PROTOCOLS,
  decryptEnvelope,
  deriveAuthenticationToken,
  encryptEnvelope,
  validateRemoteConfig,
} from "@/lib/store-crypto.js"
import {
  findMcpVariantConflicts,
  resolveMcpProfile,
} from "@/lib/mcp-model.js"

export const SECTION_ORDER = ["mcp", "skills", "prompts"]

export const SECTION_META = Object.freeze({
  mcp: {
    label: "MCP",
    protocol: PROTOCOLS.mcp,
    title: "MCP profiles",
    summary: "Choose exactly which servers each agent workflow should use.",
  },
  skills: {
    label: "Skills",
    protocol: PROTOCOLS.skills,
    title: "Skill packs",
    summary: "Compose focused capabilities for frontend, backend, or any workflow.",
  },
  prompts: {
    label: "Prompts",
    protocol: PROTOCOLS.prompts,
    title: "Persistent prompts",
    summary: "Edit the durable instructions shared with Claude Code and Codex.",
  },
})

export function protocolType(protocol) {
  return SECTION_ORDER.find((type) => SECTION_META[type].protocol === protocol) || ""
}

export async function apiFor(config, protocol, suffix, options = {}) {
  const response = await fetch(
    config.endpoint + "/v1/stores/" + config.store_id + suffix,
    {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + await deriveAuthenticationToken(config, protocol),
        "X-Toolbox-Client": "web",
        ...(options.headers || {}),
      },
      body: options.body,
    },
  )

  if (!(options.expected || [200]).includes(response.status)) {
    let message = "Store returned HTTP " + response.status + "."
    try {
      const body = await response.json()
      if (body?.error?.message) message = body.error.message
    } catch {
      // The status code remains the actionable fallback for non-JSON errors.
    }
    throw new Error(message)
  }

  return options.raw ? response : response.json()
}

export async function downloadFor(config, protocol, version = "") {
  const suffix = version
    ? "/versions/" + encodeURIComponent(version)
    : "/latest"
  const response = await apiFor(config, protocol, suffix, { raw: true })
  const contentType = (response.headers.get("Content-Type") || "").split(";")[0]
  if (contentType !== protocol.contentType) {
    throw new Error("Backup type does not match this recovery capability.")
  }
  return decryptEnvelope(config, protocol, await response.json())
}

export async function loadSection(type, config, protocol) {
  const status = await apiFor(config, protocol, "")
  if (!status.latest) {
    throw new Error("This Store has no backups yet. Run the matching ctl backup first.")
  }
  const snapshot = await downloadFor(config, protocol)
  validateSnapshot(protocol, snapshot)
  return {
    type,
    config,
    protocol,
    snapshot,
    version: status.latest.version,
    dirty: false,
    selectedCollection: collectionNamesFor(protocol, snapshot)[0] || "",
    selectedItem: "",
  }
}

export function validateWorkspaceSnapshot(snapshot, masterConfig) {
  if (!snapshot || snapshot.schema !== 1 || snapshot.kind !== "agentctl-workspace" ||
      typeof snapshot.name !== "string" || !isObject(snapshot.stores)) {
    throw new Error("Encrypted Workspace manifest is invalid.")
  }
  for (const [type, attachment] of Object.entries(snapshot.stores)) {
    if (!SECTION_ORDER.includes(type) || attachment?.schema !== 1 ||
        attachment.type !== type ||
        attachment.protocol !== SECTION_META[type].protocol.id) {
      throw new Error("Workspace contains an invalid " + type + " attachment.")
    }
    attachment.config = validateRemoteConfig(attachment.config)
    if (attachment.config.endpoint !== masterConfig.endpoint) {
      throw new Error("Workspace child Stores must share the Workspace endpoint.")
    }
  }
  return snapshot
}

export function validateSnapshot(protocol, snapshot) {
  if (!snapshot || snapshot.schema !== 1) {
    throw new Error("Snapshot schema is invalid.")
  }

  if (protocol === PROTOCOLS.skills) {
    validateSkillsSnapshot(snapshot)
    return snapshot
  }
  if (protocol === PROTOCOLS.prompts) {
    validatePromptSnapshot(snapshot)
    return snapshot
  }
  validateMcpSnapshot(snapshot)
  return snapshot
}

function validateSkillsSnapshot(snapshot) {
  if (snapshot.kind !== "skillsctl-store" || !isObject(snapshot.catalog?.skills) ||
      !isObject(snapshot.skills) || !isObject(snapshot.packs)) {
    throw new Error("This is not a valid skillsctl snapshot.")
  }
  const catalogNames = Object.keys(snapshot.catalog.skills).sort()
  const payloadNames = Object.keys(snapshot.skills).sort()
  if (catalogNames.join("\n") !== payloadNames.join("\n")) {
    throw new Error("Skills catalog and payloads do not match.")
  }
  for (const name of catalogNames) {
    const metadata = snapshot.catalog.skills[name]
    const skill = snapshot.skills[name]
    if (!validName(name) || !isObject(metadata) ||
        typeof metadata.description !== "string" ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256 || "") ||
        !isObject(skill?.files) || !skill.files["SKILL.md"]) {
      throw new Error("Skill '" + name + "' is invalid.")
    }
  }
  for (const [name, pack] of Object.entries(snapshot.packs)) {
    if (!validName(name) || pack?.schema !== 1 || pack.name !== name ||
        !Array.isArray(pack.extends) || !Array.isArray(pack.enable) ||
        !Array.isArray(pack.disable) || !isObject(pack.target_overrides)) {
      throw new Error("Pack '" + name + "' is invalid.")
    }
  }
}

function validatePromptSnapshot(snapshot) {
  if (snapshot.kind !== "promptctl-store" || !isObject(snapshot.profiles) ||
      typeof snapshot.created_at !== "string") {
    throw new Error("This is not a valid promptctl snapshot.")
  }
  for (const [name, profile] of Object.entries(snapshot.profiles)) {
    if (!safeProfileName(name) || profile?.schema !== 1 ||
        profile.name !== name || typeof profile.description !== "string" ||
        !isObject(profile.documents)) {
      throw new Error("Prompt profile '" + name + "' is invalid.")
    }
    for (const [client, document] of Object.entries(profile.documents)) {
      if (!["claude", "codex"].includes(client) || document?.schema !== 1 ||
          document.client !== client || typeof document.content !== "string" ||
          document.content.includes("\0") ||
          new TextEncoder().encode(document.content).byteLength > 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(document.sha256 || "")) {
        throw new Error("Prompt document '" + name + "/" + client + "' is invalid.")
      }
    }
  }
}

function validateMcpSnapshot(snapshot) {
  if (!isObject(snapshot.catalog?.servers) || !isObject(snapshot.profiles) ||
      !isObject(snapshot.secrets)) {
    throw new Error("This is not a valid mcpctl snapshot.")
  }
  for (const [name, definition] of Object.entries(snapshot.catalog.servers)) {
    if (!safeServerName(name) || !isObject(definition) ||
        !["http", "stdio"].includes(definition.transport) ||
        ["provider", "auth_mode", "variant_group", "variant_label"].some(
          (field) => definition[field] !== undefined &&
            typeof definition[field] !== "string",
        )) {
      throw new Error("MCP server '" + name + "' is invalid.")
    }
  }
  for (const [name, value] of Object.entries(snapshot.secrets)) {
    if (!name || typeof value !== "string") {
      throw new Error("MCP Secret values are invalid.")
    }
  }
  const profiles = Object.entries(snapshot.profiles)
  if (profiles.length === 0 || profiles.some(([name, profile]) =>
    !safeProfileName(name) || (profile?.schema ?? 1) !== 1 ||
    profile.name !== name || !Array.isArray(profile.extends || []) ||
    !Array.isArray(profile.enable || profile.servers || []) ||
    !Array.isArray(profile.disable || []))) {
    throw new Error("MCP snapshot profiles are invalid.")
  }
  for (const [name] of profiles) {
    for (const server of resolveMcpProfile(snapshot, name)) {
      if (!snapshot.catalog.servers[server]) {
        throw new Error(
          "MCP profile '" + name + "' references unknown server '" + server + "'.",
        )
      }
    }
  }
  const conflict = findMcpVariantConflicts(snapshot)[0]
  if (conflict) {
    throw new Error(
      "MCP profile '" + conflict.profile + "' enables mutually exclusive " +
      conflict.group + " variants: " + conflict.servers.join(", ") + ".",
    )
  }
}

export function collectionNamesFor(protocol, snapshot) {
  return Object.keys(
    protocol === PROTOCOLS.skills ? snapshot.packs : snapshot.profiles,
  ).sort()
}

export function resolvePack(snapshot, name, stack = [], result = new Set()) {
  const pack = snapshot.packs[name]
  if (!pack || stack.includes(name)) return result
  for (const parent of pack.extends || []) {
    resolvePack(snapshot, parent, [...stack, name], result)
  }
  for (const skill of pack.enable || []) result.add(skill)
  for (const skill of pack.disable || []) result.delete(skill)
  return result
}

export async function prepareSnapshot(protocol, snapshot) {
  if (protocol !== PROTOCOLS.prompts) return
  for (const profile of Object.values(snapshot.profiles)) {
    for (const document of Object.values(profile.documents)) {
      document.sha256 = await sha256Hex(document.content)
    }
  }
}

export async function saveEncryptedSession(session) {
  await prepareSnapshot(session.protocol, session.snapshot)
  validateSnapshot(session.protocol, session.snapshot)
  const status = await apiFor(session.config, session.protocol, "")
  const remoteVersion = status.latest?.version || "none"
  if (session.version && remoteVersion !== session.version) {
    throw new Error("A newer remote version exists. Load it before saving your changes.")
  }
  const envelope = await encryptEnvelope(
    session.config,
    session.protocol,
    session.snapshot,
  )
  const result = await apiFor(session.config, session.protocol, "/versions", {
    method: "PUT",
    expected: [201],
    headers: {
      "Content-Type": session.protocol.contentType,
      [session.protocol.baseHeader]: remoteVersion,
    },
    body: JSON.stringify(envelope),
  })
  return result.version
}

async function sha256Hex(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validName(value) {
  return typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
}

function safeProfileName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("..") && value !== "." && value !== ".."
}

function safeServerName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) &&
    value.length <= 128
}

export function safeHttpsUrl(value) {
  if (typeof value !== "string") return ""
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" ? parsed.href : ""
  } catch {
    return ""
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  return (bytes / (1024 * 1024)).toFixed(1) + " MB"
}

export function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 300) : "Something went wrong."
}
