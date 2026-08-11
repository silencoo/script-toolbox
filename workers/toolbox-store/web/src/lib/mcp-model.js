const REDACTED_EXPORT_KEY = "_toolbox_export";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return structuredClone(value);
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))].sort();
}

function profileServerField(profile) {
  return Array.isArray(profile.enable) ? "enable" : "servers";
}

function requireMcpProfile(snapshot, profileName) {
  const profile = snapshot?.profiles?.[profileName];
  if (!isObject(profile)) throw new Error("Select a valid MCP profile first.");
  return profile;
}

export function resolveMcpProfile(snapshot, profileName) {
  const result = new Set();
  const visiting = new Set();
  const visited = new Set();

  function visit(name) {
    if (visiting.has(name)) {
      throw new Error("MCP profile inheritance cycle detected at '" + name + "'.");
    }
    if (visited.has(name)) return;
    const profile = requireMcpProfile(snapshot, name);
    visiting.add(name);
    for (const parent of profile.extends || []) visit(parent);
    visiting.delete(name);
    visited.add(name);
    for (const server of profile.enable || profile.servers || []) result.add(server);
    for (const server of profile.disable || []) result.delete(server);
  }

  visit(profileName);
  return result;
}

export function setMcpServerEnabled(snapshot, profileName, serverName, enabled) {
  const profile = requireMcpProfile(snapshot, profileName);
  const definition = snapshot?.catalog?.servers?.[serverName];
  if (!isObject(definition)) throw new Error("Unknown MCP server '" + serverName + "'.");
  const field = profileServerField(profile);
  profile[field] = uniqueSorted(profile[field] || []);
  profile.disable = uniqueSorted(profile.disable || []);

  profile[field] = profile[field].filter((value) => value !== serverName);
  profile.disable = profile.disable.filter((value) => value !== serverName);

  if (enabled) {
    const group = definition.variant_group;
    if (typeof group === "string" && group) {
      for (const [name, candidate] of Object.entries(snapshot.catalog.servers)) {
        if (name === serverName || candidate?.variant_group !== group) continue;
        profile[field] = profile[field].filter((value) => value !== name);
        profile.disable = uniqueSorted([...profile.disable, name]);
      }
    }
    profile[field] = uniqueSorted([...profile[field], serverName]);
  } else {
    profile.disable = uniqueSorted([...profile.disable, serverName]);
  }

  profile[field] = uniqueSorted(profile[field]);
  profile.disable = uniqueSorted(profile.disable);
}

export function findMcpVariantConflicts(snapshot) {
  const conflicts = [];
  for (const profileName of Object.keys(snapshot?.profiles || {})) {
    const groups = new Map();
    for (const serverName of resolveMcpProfile(snapshot, profileName)) {
      const group = snapshot?.catalog?.servers?.[serverName]?.variant_group;
      if (typeof group !== "string" || !group) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(serverName);
    }
    for (const [group, servers] of groups) {
      if (servers.length > 1) {
        conflicts.push({ profile: profileName, group, servers: servers.sort() });
      }
    }
  }
  return conflicts;
}

export function collectSecretDescriptors(definition) {
  if (!isObject(definition)) return [];
  const candidates = [definition];
  if (isObject(definition.target_overrides)) {
    candidates.push(...Object.values(definition.target_overrides));
  }
  const descriptors = new Map();

  function add(descriptor, source, header = "") {
    if (!isObject(descriptor) || typeof descriptor.secret !== "string" ||
        descriptor.secret.length === 0) return;
    const previous = descriptors.get(descriptor.secret);
    descriptors.set(descriptor.secret, {
      secret: descriptor.secret,
      env: typeof descriptor.env === "string" ? descriptor.env : previous?.env || "",
      required: Boolean(previous?.required || descriptor.required !== false),
      source: previous?.source || source,
      header: previous?.header || header
    });
  }

  for (const candidate of candidates) {
    if (!isObject(candidate)) continue;
    add(candidate.auth, "authentication", candidate.auth?.header || "");
    for (const field of ["environment", "headers"]) {
      if (!isObject(candidate[field])) continue;
      for (const [name, descriptor] of Object.entries(candidate[field])) {
        add(descriptor, field, field === "headers" ? name : "");
      }
    }
    for (const descriptor of candidate.command || []) add(descriptor, "command");
  }

  return [...descriptors.values()].sort((left, right) =>
    left.secret.localeCompare(right.secret)
  );
}

export function authModeLabel(definition) {
  const labels = {
    "optional-api-key": "Anonymous / API key",
    "api-key": "API key",
    keyless: "Keyless",
    oauth: "OAuth"
  };
  return labels[definition?.auth_mode] ||
    (definition?.auth ? "Credential header" : "No configured credential");
}

export function redactMcpSnapshot(snapshot) {
  const redacted = cloneJson(snapshot);
  const secretNames = Object.keys(redacted.secrets || {}).sort();
  redacted.secrets = {};
  redacted[REDACTED_EXPORT_KEY] = {
    schema: 1,
    secrets: "redacted",
    secret_names: secretNames
  };
  return { snapshot: redacted, redactedCount: secretNames.length };
}

export function mergeRedactedMcpImport(importedSnapshot, currentSnapshot) {
  const imported = cloneJson(importedSnapshot);
  const metadata = imported[REDACTED_EXPORT_KEY];
  if (!isObject(metadata) || metadata.schema !== 1 ||
      metadata.secrets !== "redacted") {
    return { snapshot: imported, redacted: false, preservedCount: 0 };
  }
  if (!isObject(imported.secrets) || Object.keys(imported.secrets).length !== 0 ||
      !Array.isArray(metadata.secret_names) ||
      metadata.secret_names.some((name) => typeof name !== "string")) {
    throw new Error("Redacted MCP export metadata is invalid.");
  }
  const currentSecrets = isObject(currentSnapshot?.secrets)
    ? Object.entries(currentSnapshot.secrets)
    : [];
  imported.secrets = Object.fromEntries(currentSecrets);
  delete imported[REDACTED_EXPORT_KEY];
  return {
    snapshot: imported,
    redacted: true,
    preservedCount: currentSecrets.length
  };
}
