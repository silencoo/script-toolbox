import { DEFAULT_RPC_ENDPOINT, normalizeEndpoint } from "./security";
import type { ConnectionInfo, PublicSettings, SecretStatus } from "./types";

const SETTINGS_KEY = "ariaRelaySettings";
const PERSISTENT_SECRET_KEY = "ariaRelayPersistentSecret";
const SESSION_SECRET_KEY = "ariaRelaySessionSecret";

export const DEFAULT_SETTINGS: PublicSettings = {
  addPaused: false,
  configured: false,
  defaultDirectory: "",
  endpoint: DEFAULT_RPC_ENDPOINT,
  maxResults: 100,
  notifications: false,
  refreshInterval: 2_000,
  rememberSecret: false
};

export async function protectStorageAccess(): Promise<void> {
  await Promise.allSettled([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}

export async function getSettings(): Promise<PublicSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY]);
}

export async function getSecret(): Promise<string> {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(SESSION_SECRET_KEY),
    chrome.storage.local.get(PERSISTENT_SECRET_KEY)
  ]);

  const sessionSecret = readSecret(session[SESSION_SECRET_KEY]);
  if (sessionSecret) {
    return sessionSecret;
  }

  return readSecret(local[PERSISTENT_SECRET_KEY]);
}

export async function getConnectionInfo(): Promise<ConnectionInfo> {
  const [settings, session, local] = await Promise.all([
    getSettings(),
    chrome.storage.session.get(SESSION_SECRET_KEY),
    chrome.storage.local.get(PERSISTENT_SECRET_KEY)
  ]);

  let secretStatus: SecretStatus = "missing";
  if (readSecret(session[SESSION_SECRET_KEY])) {
    secretStatus = "session";
  } else if (readSecret(local[PERSISTENT_SECRET_KEY])) {
    secretStatus = "persistent";
  }

  return { secretStatus, settings };
}

export async function saveConnection(
  inputSettings: PublicSettings,
  incomingSecret: string | undefined,
  useStoredSecret: boolean
): Promise<ConnectionInfo> {
  const settings = sanitizeSettings(inputSettings);
  let secret = incomingSecret?.trim() ?? "";

  if (!secret && useStoredSecret) {
    secret = await getSecret();
  }

  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });

  if (settings.rememberSecret) {
    await chrome.storage.session.remove(SESSION_SECRET_KEY);
    if (secret) {
      await chrome.storage.local.set({ [PERSISTENT_SECRET_KEY]: secret });
    } else {
      await chrome.storage.local.remove(PERSISTENT_SECRET_KEY);
    }
  } else {
    await chrome.storage.local.remove(PERSISTENT_SECRET_KEY);
    if (secret) {
      await chrome.storage.session.set({ [SESSION_SECRET_KEY]: secret });
    } else {
      await chrome.storage.session.remove(SESSION_SECRET_KEY);
    }
  }

  return getConnectionInfo();
}

export async function resetConnection(): Promise<ConnectionInfo> {
  await Promise.all([
    chrome.storage.local.remove([SETTINGS_KEY, PERSISTENT_SECRET_KEY]),
    chrome.storage.session.remove(SESSION_SECRET_KEY)
  ]);
  return getConnectionInfo();
}

export function sanitizeSettings(value: unknown): PublicSettings {
  const record = isRecord(value) ? value : {};
  const rawEndpoint = typeof record.endpoint === "string" ? record.endpoint : DEFAULT_RPC_ENDPOINT;
  let endpoint = DEFAULT_RPC_ENDPOINT;

  try {
    endpoint = normalizeEndpoint(rawEndpoint).endpoint;
  } catch {
    endpoint = DEFAULT_RPC_ENDPOINT;
  }

  return {
    addPaused: asBoolean(record.addPaused, DEFAULT_SETTINGS.addPaused),
    configured: asBoolean(record.configured, DEFAULT_SETTINGS.configured),
    defaultDirectory:
      typeof record.defaultDirectory === "string"
        ? record.defaultDirectory.slice(0, 1_024)
        : DEFAULT_SETTINGS.defaultDirectory,
    endpoint,
    maxResults: clampInteger(record.maxResults, 20, 1_000, DEFAULT_SETTINGS.maxResults),
    notifications: asBoolean(record.notifications, DEFAULT_SETTINGS.notifications),
    refreshInterval: clampInteger(
      record.refreshInterval,
      1_000,
      30_000,
      DEFAULT_SETTINGS.refreshInterval
    ),
    rememberSecret: asBoolean(record.rememberSecret, DEFAULT_SETTINGS.rememberSecret)
  };
}

function readSecret(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
