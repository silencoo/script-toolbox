import {
  validateProviderSecrets,
  validateProviderStore
} from "./provider-schema.mjs";
import {
  validateFailoverProviders,
  validateFailoverStore
} from "./failover-schema.mjs";
import { validatePricingCatalog } from "../pricing/pricing.mjs";

export const CURRENT_WORKSPACE_SCHEMA = 3;
export const WORKSPACE_KIND = "agentctl-workspace";
export const WORKSPACE_ATTACHMENT_SCHEMA = 2;
export const WORKSPACE_PRESET_SCHEMA = 2;
export const WORKSPACE_AGENT_SCHEMA = 1;

export class WorkspaceSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceSchemaError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new WorkspaceSchemaError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new WorkspaceSchemaError(`${label} contains unsupported field '${key}'`);
    }
  }
}

export function newWorkspaceAgentBundle() {
  return {
    schema: WORKSPACE_AGENT_SCHEMA,
    synced_at: null,
    providers: null,
    secrets: null,
    failover: null,
    pricing: null
  };
}

export function validateWorkspaceAgentBundle(bundle) {
  exactKeys(bundle, [
    "schema", "synced_at", "providers", "secrets", "failover", "pricing"
  ], "Workspace agent bundle");
  if (bundle.schema !== WORKSPACE_AGENT_SCHEMA) {
    throw new WorkspaceSchemaError(
      `Workspace agent bundle schema must be ${WORKSPACE_AGENT_SCHEMA}`
    );
  }
  const empty = [bundle.providers, bundle.secrets, bundle.failover, bundle.pricing]
    .every((value) => value === null);
  if (empty) {
    if (bundle.synced_at !== null) {
      throw new WorkspaceSchemaError("empty Workspace agent bundle must not have synced_at");
    }
    return bundle;
  }
  if (typeof bundle.synced_at !== "string" || Number.isNaN(Date.parse(bundle.synced_at))) {
    throw new WorkspaceSchemaError("Workspace agent synced_at is invalid");
  }
  if (bundle.providers === null || bundle.secrets === null) {
    throw new WorkspaceSchemaError(
      "Workspace agent bundle requires Provider and Secret Stores together"
    );
  }
  validateProviderStore(bundle.providers);
  validateProviderSecrets(bundle.secrets);
  if (bundle.failover !== null) {
    validateFailoverStore(bundle.failover);
    for (const route of Object.values(bundle.failover.routes)) {
      validateFailoverProviders(route, bundle.providers);
    }
  }
  if (bundle.pricing !== null) validatePricingCatalog(bundle.pricing);
  return bundle;
}

export function normalizeWorkspaceSchema(snapshot) {
  if (!snapshot || ![1, 2].includes(snapshot.schema) || snapshot.kind !== WORKSPACE_KIND ||
      !snapshot.stores || typeof snapshot.stores !== "object" || Array.isArray(snapshot.stores) ||
      (snapshot.presets !== undefined &&
       (!snapshot.presets || typeof snapshot.presets !== "object" || Array.isArray(snapshot.presets)))) {
    return snapshot;
  }
  const upgraded = structuredClone(snapshot);
  upgraded.schema = CURRENT_WORKSPACE_SCHEMA;
  upgraded.presets ||= {};
  for (const attachment of Object.values(upgraded.stores)) {
    if (attachment?.schema === 1) attachment.schema = WORKSPACE_ATTACHMENT_SCHEMA;
  }
  upgraded.agent = newWorkspaceAgentBundle();
  return upgraded;
}
