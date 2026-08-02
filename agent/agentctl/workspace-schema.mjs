export const CURRENT_WORKSPACE_SCHEMA = 2;
export const WORKSPACE_KIND = "agentctl-workspace";

export function normalizeWorkspaceSchema(snapshot) {
  if (!snapshot || snapshot.schema !== 1 || snapshot.kind !== WORKSPACE_KIND ||
      !snapshot.stores || typeof snapshot.stores !== "object" || Array.isArray(snapshot.stores) ||
      (snapshot.presets !== undefined &&
       (!snapshot.presets || typeof snapshot.presets !== "object" || Array.isArray(snapshot.presets)))) {
    return snapshot;
  }
  const upgraded = structuredClone(snapshot);
  upgraded.schema = CURRENT_WORKSPACE_SCHEMA;
  upgraded.presets ||= {};
  for (const attachment of Object.values(upgraded.stores)) {
    if (attachment?.schema === 1) attachment.schema = CURRENT_WORKSPACE_SCHEMA;
  }
  return upgraded;
}
