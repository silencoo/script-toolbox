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
import { ensurePromptSnippets } from "@/lib/prompt-model.js"
export { resolvePack } from "@/lib/skill-model.js"

export const SECTION_ORDER = ["mcp", "skills", "prompts"]
export const WORKSPACE_VIEW_ORDER = ["providers", ...SECTION_ORDER, "presets"]

export const SECTION_META = Object.freeze({
  mcp: {
    label: "MCP",
    protocol: PROTOCOLS.mcp,
  },
  skills: {
    label: "Skills",
    protocol: PROTOCOLS.skills,
  },
  prompts: {
    label: "Prompts",
    protocol: PROTOCOLS.prompts,
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
  snapshot = normalizeWorkspaceSnapshot(snapshot)
  exactKeys(snapshot, [
    "schema", "kind", "name", "created_at", "updated_at", "stores", "presets", "agent",
  ], "Workspace")
  if (!snapshot || snapshot.schema !== 3 || snapshot.kind !== "agentctl-workspace" ||
      typeof snapshot.name !== "string" || snapshot.name.length < 1 ||
      snapshot.name.length > 200 || !isObject(snapshot.stores) ||
      !validTimestamp(snapshot.created_at) || !validTimestamp(snapshot.updated_at) ||
      !isObject(snapshot.presets) || !isObject(snapshot.agent)) {
    throw new Error("Encrypted Workspace manifest is invalid.")
  }
  for (const [type, attachment] of Object.entries(snapshot.stores)) {
    if (!SECTION_ORDER.includes(type) || attachment?.schema !== 2 ||
        attachment.type !== type ||
        attachment.protocol !== SECTION_META[type].protocol.id ||
        !validTimestamp(attachment.attached_at)) {
      throw new Error("Workspace contains an invalid " + type + " attachment.")
    }
    attachment.config = validateRemoteConfig(attachment.config)
    if (attachment.config.endpoint !== masterConfig.endpoint) {
      throw new Error("Workspace child Stores must share the Workspace endpoint.")
    }
  }
  for (const [name, preset] of Object.entries(snapshot.presets)) {
    if (!validName(name) || preset?.schema !== 2 || preset.name !== name ||
        typeof preset.description !== "string" || preset.description.length > 500 ||
        !safePresetReference(preset.mcp) || !validName(preset.skills) ||
        !safePresetReference(preset.prompt)) {
      throw new Error("Workspace development preset '" + name + "' is invalid.")
    }
  }
  validateAgentBundle(snapshot.agent)
  return snapshot
}

function emptyAgentBundle() {
  return {
    schema: 1,
    synced_at: null,
    providers: null,
    secrets: null,
    failover: null,
    pricing: null,
  }
}

export function normalizeWorkspaceSnapshot(snapshot) {
  const legacyWorkspace = snapshot && [1, 2].includes(snapshot.schema) &&
    snapshot.kind === "agentctl-workspace" && isObject(snapshot.stores) &&
    (snapshot.presets === undefined || isObject(snapshot.presets))
  const providerStore = snapshot?.schema === 3 && snapshot.kind === "agentctl-workspace"
    ? snapshot.agent?.providers
    : null
  const legacyProvider = providerStore?.schema === 1 ||
    Object.values(providerStore?.profiles || {}).some((profile) =>
      profile?.schema === 1 || profile?.context === undefined
    )
  if (!legacyWorkspace && !legacyProvider) return snapshot
  const upgraded = structuredClone(snapshot)
  if (legacyWorkspace) {
    upgraded.schema = 3
    upgraded.presets ||= {}
    for (const attachment of Object.values(upgraded.stores)) {
      if (attachment?.schema === 1) attachment.schema = 2
    }
    upgraded.agent = emptyAgentBundle()
  }
  return upgraded
}

function validateAgentBundle(bundle) {
  exactKeys(bundle, [
    "schema", "synced_at", "providers", "secrets", "failover", "pricing",
  ], "Workspace agent bundle")
  if (bundle.schema !== 1) throw new Error("Workspace agent bundle schema is invalid.")
  const empty = [bundle.providers, bundle.secrets, bundle.failover, bundle.pricing]
    .every((value) => value === null)
  if (empty) {
    if (bundle.synced_at !== null) throw new Error("Empty agent bundle has an invalid timestamp.")
    return bundle
  }
  if (!validTimestamp(bundle.synced_at) || !bundle.providers || !bundle.secrets) {
    throw new Error("Workspace Provider and Secret Stores must be synchronized together.")
  }
  validateProviderStore(bundle.providers)
  validateProviderSecrets(bundle.secrets)
  if (bundle.failover !== null) validateFailoverStore(bundle.failover, bundle.providers)
  if (bundle.pricing !== null) validatePricingCatalog(bundle.pricing)
  return bundle
}

function validateProviderStore(store) {
  if (store?.schema === 1 && store.kind === "agentctl-provider-store") store.schema = 2
  exactKeys(store, ["schema", "kind", "created_at", "updated_at", "profiles"], "Provider Store")
  if (store.schema !== 2 || store.kind !== "agentctl-provider-store" ||
      !validTimestamp(store.created_at) || !validTimestamp(store.updated_at) ||
      !isObject(store.profiles) || Object.keys(store.profiles).length > 128) {
    throw new Error("Workspace Provider Store is invalid.")
  }
  for (const [name, profile] of Object.entries(store.profiles)) {
    if (!validName(name)) throw new Error(`Provider profile '${name}' has an invalid name.`)
    validateProviderProfile(profile, name)
  }
}

function validateProviderProfile(profile, name) {
  if (profile?.schema === 1) {
    exactKeys(profile, [
      "schema", "name", "description", "protocol", "endpoint", "auth", "models",
      "targets", "platforms",
    ], `Provider profile '${name}' schema 1`)
    profile.schema = 2
    profile.compaction = legacyProviderCompaction(profile)
    profile.context = { window_tokens: null, auto_compact_tokens: null }
  }
  if (profile.context === undefined) {
    profile.context = { window_tokens: null, auto_compact_tokens: null }
  }
  exactKeys(profile, [
    "schema", "name", "description", "protocol", "endpoint", "auth", "models",
    "compaction", "context", "targets", "platforms",
  ], `Provider profile '${name}'`)
  if (profile.schema !== 2 || profile.name !== name ||
      !plainText(profile.description, 0, 500) || !validProviderProtocol(profile.protocol)) {
    throw new Error(`Provider profile '${name}' is invalid.`)
  }
  validateProviderEndpoint(profile.endpoint, `Provider profile '${name}' endpoint`)
  validateProviderAuth(profile.auth, false, `Provider profile '${name}' auth`)
  validateProviderModels(profile.models, name)
  validateProviderCompaction(profile.compaction, false, profile.protocol,
    `Provider profile '${name}' compaction`)
  validateProviderContext(profile.context, false, `Provider profile '${name}' context`)
  if (!isObject(profile.targets) || !isObject(profile.platforms)) {
    throw new Error(`Provider profile '${name}' overlays are invalid.`)
  }
  for (const [target, override] of Object.entries(profile.targets)) {
    if (!validProviderTarget(target)) throw new Error(`Provider target '${target}' is invalid.`)
    validateProviderOverride(override, `Provider target '${target}'`)
  }
  for (const [platform, overlay] of Object.entries(profile.platforms)) {
    if (!["darwin", "linux", "windows"].includes(platform) || !isObject(overlay)) {
      throw new Error(`Provider platform '${platform}' is invalid.`)
    }
    exactKeys(overlay, ["targets"], `Provider platform '${platform}'`)
    if (!isObject(overlay.targets) || Object.keys(overlay.targets).length === 0) {
      throw new Error(`Provider platform '${platform}' targets are invalid.`)
    }
    for (const [target, override] of Object.entries(overlay.targets)) {
      if (!validProviderTarget(target)) throw new Error(`Provider target '${target}' is invalid.`)
      validateProviderOverride(override, `Provider platform '${platform}/${target}'`)
    }
  }
  validateProviderOverlayPolicies(profile, name)
}

function validateProviderOverlayPolicies(profile, name) {
  const targets = ["claude", "codex", "opencode", "pi"]
  const platforms = ["darwin", "linux", "windows"]
  for (const target of targets) {
    const targetOverride = profile.targets[target] || {}
    const targetResolved = {
      protocol: targetOverride.protocol || profile.protocol,
      compaction: { ...profile.compaction, ...(targetOverride.compaction || {}) },
      context: { ...profile.context, ...(targetOverride.context || {}) },
    }
    validateProviderCompaction(targetResolved.compaction, false, targetResolved.protocol,
      `Provider profile '${name}' target '${target}' resolved compaction`)
    validateProviderContext(targetResolved.context, false,
      `Provider profile '${name}' target '${target}' resolved context`)
    for (const platform of platforms) {
      const override = profile.platforms[platform]?.targets?.[target] || {}
      const resolved = {
        protocol: override.protocol || targetResolved.protocol,
        compaction: { ...targetResolved.compaction, ...(override.compaction || {}) },
        context: { ...targetResolved.context, ...(override.context || {}) },
      }
      validateProviderCompaction(resolved.compaction, false, resolved.protocol,
        `Provider profile '${name}' platform '${platform}/${target}' resolved compaction`)
      validateProviderContext(resolved.context, false,
        `Provider profile '${name}' platform '${platform}/${target}' resolved context`)
    }
  }
}

function validateProviderOverride(override, label) {
  exactKeys(override, [
    "enabled", "endpoint", "protocol", "auth", "model", "compaction", "context",
  ], label)
  if (Object.keys(override).length === 0 ||
      (override.enabled !== undefined && typeof override.enabled !== "boolean") ||
      (override.protocol !== undefined && !validProviderProtocol(override.protocol)) ||
      (override.model !== undefined && !providerText(override.model, 240))) {
    throw new Error(`${label} is invalid.`)
  }
  if (override.endpoint !== undefined) validateProviderEndpoint(override.endpoint, `${label} endpoint`)
  if (override.auth !== undefined) validateProviderAuth(override.auth, true, `${label} auth`)
  if (override.compaction !== undefined) {
    validateProviderCompaction(override.compaction, true, override.protocol || "",
      `${label} compaction`)
  }
  if (override.context !== undefined) {
    validateProviderContext(override.context, true, `${label} context`)
  }
}

function legacyProviderCompaction(profile) {
  let endpoint = ""
  try { endpoint = new URL(profile.endpoint).toString().replace(/\/$/, "") } catch {}
  if (profile.name === "openai-api" && profile.protocol === "openai_responses" &&
      endpoint === "https://api.openai.com/v1") {
    return { upstream: "responses_v2", policy: "auto" }
  }
  if (profile.name === "anthropic-api" && profile.protocol === "anthropic_messages" &&
      endpoint === "https://api.anthropic.com") {
    return { upstream: "anthropic_messages_beta", policy: "auto" }
  }
  return { upstream: "none", policy: "auto" }
}

function validateProviderCompaction(compaction, partial, protocol, label) {
  exactKeys(compaction, ["upstream", "policy"], label)
  const upstreams = ["responses_v2", "responses_v1", "anthropic_messages_beta", "none"]
  const policies = ["auto", "remote", "local"]
  if ((!partial || compaction.upstream !== undefined) &&
      !upstreams.includes(compaction.upstream)) throw new Error(`${label} upstream is invalid.`)
  if ((!partial || compaction.policy !== undefined) &&
      !policies.includes(compaction.policy)) throw new Error(`${label} policy is invalid.`)
  if (partial && Object.keys(compaction).length === 0) throw new Error(`${label} cannot be empty.`)
  if (compaction.policy === "remote" && compaction.upstream === "none") {
    throw new Error(`${label} cannot force an unavailable remote capability.`)
  }
  const required = ["responses_v2", "responses_v1"].includes(compaction.upstream)
    ? "openai_responses"
    : compaction.upstream === "anthropic_messages_beta" ? "anthropic_messages" : ""
  if (protocol && required && protocol !== required) {
    throw new Error(`${label} does not match the Provider protocol.`)
  }
}

function validateProviderContext(context, partial, label) {
  exactKeys(context, ["window_tokens", "auto_compact_tokens"], label)
  const validTokens = (value) => value === null || boundedInteger(value, 1, 10000000)
  if ((!partial || context.window_tokens !== undefined) &&
      !validTokens(context.window_tokens)) throw new Error(`${label} window is invalid.`)
  if ((!partial || context.auto_compact_tokens !== undefined) &&
      !validTokens(context.auto_compact_tokens)) throw new Error(`${label} auto-compact is invalid.`)
  if (partial && Object.keys(context).length === 0) throw new Error(`${label} cannot be empty.`)
  if (context.window_tokens !== undefined && context.window_tokens !== null &&
      context.auto_compact_tokens !== undefined && context.auto_compact_tokens !== null &&
      context.auto_compact_tokens > context.window_tokens) {
    throw new Error(`${label} auto-compact cannot exceed its window.`)
  }
}

function validateProviderAuth(auth, partial, label) {
  exactKeys(auth, ["mode", "secret"], label)
  const modes = ["bearer", "x-api-key", "x-goog-api-key", "none"]
  if ((!partial || auth.mode !== undefined) && !modes.includes(auth.mode)) {
    throw new Error(`${label} mode is invalid.`)
  }
  if (auth.secret !== undefined && !validSecretReference(auth.secret)) {
    throw new Error(`${label} Secret reference is invalid.`)
  }
  if (!partial && auth.mode !== "none" && auth.secret === undefined) {
    throw new Error(`${label} requires a Secret reference.`)
  }
  if (auth.mode === "none" && auth.secret !== undefined) {
    throw new Error(`${label} cannot reference a Secret in none mode.`)
  }
  if (partial && Object.keys(auth).length === 0) throw new Error(`${label} cannot be empty.`)
}

function validateProviderModels(models, profile) {
  exactKeys(models, ["default", "aliases"], `Provider profile '${profile}' models`)
  if (!providerText(models.default, 240) || !isObject(models.aliases) ||
      Object.keys(models.aliases).length > 256) {
    throw new Error(`Provider profile '${profile}' models are invalid.`)
  }
  for (const [requested, outbound] of Object.entries(models.aliases)) {
    if (!providerText(requested, 240) || !providerText(outbound, 240)) {
      throw new Error(`Provider profile '${profile}' model alias is invalid.`)
    }
  }
  for (const start of [models.default, ...Object.keys(models.aliases)]) {
    const seen = new Set()
    let current = start
    while (Object.hasOwn(models.aliases, current)) {
      if (seen.has(current)) throw new Error(`Provider profile '${profile}' has a model alias cycle.`)
      seen.add(current)
      current = models.aliases[current]
    }
  }
}

function validateProviderEndpoint(value, label) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048) {
    throw new Error(`${label} is invalid.`)
  }
  let endpoint
  try { endpoint = new URL(value) } catch { throw new Error(`${label} is invalid.`) }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname)
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username ||
      endpoint.password || endpoint.hash || (endpoint.protocol !== "https:" && !loopback)) {
    throw new Error(`${label} must use HTTPS unless it is loopback-only.`)
  }
  for (const key of endpoint.searchParams.keys()) {
    if (/^(?:api[-_]?key|access[-_]?token|token|secret|auth|authorization|signature|sig|credential)$/i.test(key)) {
      throw new Error(`${label} must not contain credentials.`)
    }
  }
}

function validateProviderSecrets(store) {
  exactKeys(store, ["schema", "kind", "updated_at", "secrets"], "Provider Secret Store")
  if (store.schema !== 1 || store.kind !== "agentctl-provider-secrets" ||
      !validTimestamp(store.updated_at) || !isObject(store.secrets)) {
    throw new Error("Workspace Provider Secret Store is invalid.")
  }
  for (const [name, secret] of Object.entries(store.secrets)) {
    exactKeys(secret, ["value", "updated_at"], `Provider Secret '${name}'`)
    if (!validSecretReference(name) || !plainText(secret.value, 1, 16384) ||
        !validTimestamp(secret.updated_at)) {
      throw new Error(`Provider Secret '${name}' is invalid.`)
    }
  }
}

function validateFailoverStore(store, providers) {
  exactKeys(store, ["schema", "kind", "created_at", "updated_at", "routes"], "Failover Store")
  if (store.schema !== 1 || store.kind !== "agentctl-failover-store" ||
      !validTimestamp(store.created_at) || !validTimestamp(store.updated_at) ||
      !isObject(store.routes) || Object.keys(store.routes).length > 128) {
    throw new Error("Workspace failover Store is invalid.")
  }
  for (const [name, route] of Object.entries(store.routes)) {
    exactKeys(route, ["schema", "name", "description", "profiles", "retry", "circuit"], `Failover route '${name}'`)
    if (!validName(name) || route.schema !== 1 || route.name !== name ||
        !plainText(route.description, 0, 500) || !Array.isArray(route.profiles) ||
        route.profiles.length < 2 || route.profiles.length > 8 ||
        new Set(route.profiles).size !== route.profiles.length ||
        route.profiles.some((profile) => !validName(profile) || !providers.profiles[profile])) {
      throw new Error(`Failover route '${name}' is invalid.`)
    }
    exactKeys(route.retry, ["mode", "max_attempts", "status_codes", "network_errors"], `Failover route '${name}' retry`)
    if (!["next_request", "same_request"].includes(route.retry.mode) ||
        !boundedInteger(route.retry.max_attempts, 1, route.profiles.length) ||
        !Array.isArray(route.retry.status_codes) || route.retry.status_codes.length > 32 ||
        new Set(route.retry.status_codes).size !== route.retry.status_codes.length ||
        route.retry.status_codes.some((status) => !boundedInteger(status, 400, 599)) ||
        typeof route.retry.network_errors !== "boolean") {
      throw new Error(`Failover route '${name}' retry policy is invalid.`)
    }
    exactKeys(route.circuit, [
      "failure_threshold", "recovery_timeout_ms", "half_open_max_requests", "state_retention_days",
    ], `Failover route '${name}' circuit`)
    if (!boundedInteger(route.circuit.failure_threshold, 1, 20) ||
        !boundedInteger(route.circuit.recovery_timeout_ms, 1000, 3600000) ||
        !boundedInteger(route.circuit.half_open_max_requests, 1, 5) ||
        !boundedInteger(route.circuit.state_retention_days, 1, 365)) {
      throw new Error(`Failover route '${name}' circuit policy is invalid.`)
    }
  }
}

function validatePricingCatalog(catalog) {
  exactKeys(catalog, [
    "schema", "kind", "version", "currency", "effective_at", "updated_at", "rates",
  ], "Pricing catalog")
  if (catalog.schema !== 1 || catalog.kind !== "agentctl-pricing-catalog" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(catalog.version || "") ||
      !/^[A-Z]{3}$/.test(catalog.currency || "") || !validTimestamp(catalog.effective_at) ||
      !validTimestamp(catalog.updated_at) || !isObject(catalog.rates) ||
      Object.keys(catalog.rates).length > 4096) {
    throw new Error("Workspace pricing catalog is invalid.")
  }
  const unique = new Set()
  for (const [id, rate] of Object.entries(catalog.rates)) {
    exactKeys(rate, [
      "schema", "id", "profile", "model", "input_per_million", "output_per_million",
      "cache_read_per_million", "cache_write_per_million", "multiplier", "effective_at",
      "expires_at", "source",
    ], `Pricing rate '${id}'`)
    if (!validName(id) || rate.schema !== 1 || rate.id !== id ||
        (rate.profile !== "*" && !validName(rate.profile)) || !providerText(rate.model, 240) ||
        ![rate.input_per_million, rate.output_per_million, rate.cache_read_per_million,
          rate.cache_write_per_million, rate.multiplier].every(validDecimal) ||
        /^0(?:\.0+)?$/.test(rate.multiplier) || !validTimestamp(rate.effective_at) ||
        (rate.expires_at !== null && (!validTimestamp(rate.expires_at) ||
          Date.parse(rate.expires_at) <= Date.parse(rate.effective_at))) ||
        !plainText(rate.source, 1, 500)) {
      throw new Error(`Pricing rate '${id}' is invalid.`)
    }
    const key = `${rate.profile}\0${rate.model}\0${rate.effective_at}`
    if (unique.has(key)) throw new Error(`Pricing rate '${id}' duplicates an effective interval.`)
    unique.add(key)
  }
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
    ensurePromptSnippets(snapshot)
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
  const snippets = snapshot.snippets === undefined ? {} : snapshot.snippets
  if (!isObject(snippets)) throw new Error("Prompt snippets are invalid.")
  for (const [name, snippet] of Object.entries(snippets)) {
    if (!safeProfileName(name) || snippet?.schema !== 1 ||
        snippet.name !== name || typeof snippet.content !== "string" ||
        snippet.content.includes("\0") ||
        new TextEncoder().encode(snippet.content).byteLength > 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(snippet.sha256 || "")) {
      throw new Error("Snippet '" + name + "' is invalid.")
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

export async function prepareSnapshot(protocol, snapshot) {
  if (protocol !== PROTOCOLS.prompts) return
  for (const profile of Object.values(snapshot.profiles)) {
    for (const document of Object.values(profile.documents)) {
      document.sha256 = await sha256Hex(document.content)
    }
  }
  for (const snippet of Object.values(snapshot.snippets || {})) {
    snippet.sha256 = await sha256Hex(snippet.content)
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

export async function saveEncryptedWorkspace(config, snapshot, version) {
  snapshot = validateWorkspaceSnapshot(snapshot, config)
  const status = await apiFor(config, PROTOCOLS.workspace, "")
  const remoteVersion = status.latest?.version || "none"
  if (version && remoteVersion !== version) {
    throw new Error("A newer Workspace version exists. Unlock it before saving your changes.")
  }
  const envelope = await encryptEnvelope(config, PROTOCOLS.workspace, snapshot)
  const result = await apiFor(config, PROTOCOLS.workspace, "/versions", {
    method: "PUT",
    expected: [201],
    headers: {
      "Content-Type": PROTOCOLS.workspace.contentType,
      [PROTOCOLS.workspace.baseHeader]: remoteVersion,
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

function exactKeys(value, allowed, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object.`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field '${key}'.`)
  }
}

function plainText(value, minimum, maximum) {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
}

function providerText(value, maximum) {
  return plainText(value, 1, maximum)
}

function validSecretReference(value) {
  return typeof value === "string" && value.length <= 96 &&
    /^[A-Za-z][A-Za-z0-9._-]*$/.test(value) && !value.includes("..")
}

function validProviderProtocol(value) {
  return [
    "anthropic_messages", "openai_responses", "openai_chat", "google_generative",
  ].includes(value)
}

function validProviderTarget(value) {
  return ["claude", "codex", "opencode", "pi"].includes(value)
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
}

function validDecimal(value) {
  return typeof value === "string" &&
    /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/.test(value)
}

function validName(value) {
  return typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function safeProfileName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("..") && value !== "." && value !== ".."
}

function safePresetReference(value) {
  return safeProfileName(value) && value.length <= 64
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
