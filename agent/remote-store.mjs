#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SCHEMA = 1;
const STORE_ID_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_ID_PATTERN = /^[0-9]{13}-[a-f0-9-]{36}$/;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MIN_CREATE_TOKEN_LENGTH = 32;
const MAX_CREATE_TOKEN_LENGTH = 512;

const MCP_REMOTE_PROTOCOL = Object.freeze({
  id: "mcpctl",
  recoveryPrefix: "mcpstore1_",
  authInfo: "mcpctl/store-authentication/v1",
  snapshotInfo: "mcpctl/snapshot-encryption/v1",
  snapshotKind: "mcpctl-snapshot",
  contentType: "application/vnd.mcpctl.snapshot+json",
  createTokenHeader: "X-MCP-Store-Create-Token",
  baseVersionHeader: "X-MCPCTL-Base-Version"
});

const SKILLS_REMOTE_PROTOCOL = Object.freeze({
  id: "skillsctl",
  recoveryPrefix: "skillstore1_",
  authInfo: "skillsctl/store-authentication/v1",
  snapshotInfo: "skillsctl/snapshot-encryption/v1",
  snapshotKind: "skillsctl-snapshot",
  contentType: "application/vnd.skillsctl.snapshot+json",
  createTokenHeader: "X-Toolbox-Store-Create-Token",
  baseVersionHeader: "X-Toolbox-Base-Version"
});

const PROMPT_REMOTE_PROTOCOL = Object.freeze({
  id: "promptctl",
  recoveryPrefix: "promptstore1_",
  authInfo: "promptctl/store-authentication/v1",
  snapshotInfo: "promptctl/snapshot-encryption/v1",
  snapshotKind: "promptctl-snapshot",
  contentType: "application/vnd.promptctl.snapshot+json",
  createTokenHeader: "X-Toolbox-Store-Create-Token",
  baseVersionHeader: "X-Toolbox-Base-Version"
});

const WORKSPACE_REMOTE_PROTOCOL = Object.freeze({
  id: "agentctl-workspace",
  recoveryPrefix: "toolbox1_",
  authInfo: "agentctl/workspace-authentication/v1",
  snapshotInfo: "agentctl/workspace-encryption/v1",
  snapshotKind: "agentctl-workspace-snapshot",
  contentType: "application/vnd.agentctl.workspace+json",
  createTokenHeader: "X-Toolbox-Store-Create-Token",
  baseVersionHeader: "X-Toolbox-Base-Version"
});

class RemoteStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteStoreError";
  }
}

function validateProtocol(protocol) {
  if (!protocol ||
      typeof protocol.id !== "string" ||
      typeof protocol.recoveryPrefix !== "string" ||
      typeof protocol.authInfo !== "string" ||
      typeof protocol.snapshotInfo !== "string" ||
      typeof protocol.snapshotKind !== "string" ||
      typeof protocol.contentType !== "string" ||
      typeof protocol.createTokenHeader !== "string" ||
      typeof protocol.baseVersionHeader !== "string") {
    throw new RemoteStoreError("remote store protocol is invalid");
  }
  return protocol;
}

async function initializeRemoteStore(options) {
  const protocol = validateProtocol(options.protocol);
  const endpoint = normalizeEndpoint(options.endpoint);
  const remoteConfigPath = resolve(options.remoteConfig);
  const createToken = validateCreateToken(options.createToken);

  if (await pathExists(remoteConfigPath)) {
    await assertRegularPrivateFile(remoteConfigPath, "remote configuration");
    if (!options.force) {
      throw new RemoteStoreError(
        `remote configuration already exists: ${remoteConfigPath} (use --force to replace it)`
      );
    }
  }

  const config = {
    schema: SCHEMA,
    endpoint,
    store_id: randomBytes(16).toString("hex"),
    root_key: randomBytes(32).toString("base64url")
  };
  const token = deriveAuthenticationToken(config, protocol);
  const response = await request(config, protocol, storeApiPath(config), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      [protocol.createTokenHeader]: createToken
    },
    authenticated: false
  });
  await readApiJson(response, [201]);
  await writeJsonAtomic(remoteConfigPath, config);
  return config;
}

async function getRemoteStatus(configOrPath, protocol) {
  const config = await resolveConfig(configOrPath);
  const response = await authenticatedRequest(
    config,
    validateProtocol(protocol),
    storeApiPath(config)
  );
  const status = await readApiJson(response, [200]);
  if (status.latest !== null) validateVersionMetadata(status.latest);
  return status;
}

async function getRemoteWebUiSetting(configOrPath, protocol) {
  const config = await resolveConfig(configOrPath);
  validateProtocol(protocol);
  const response = await authenticatedRequest(
    config,
    protocol,
    `${storeApiPath(config)}/settings/web-ui`
  );
  return validateWebUiSetting(
    await readApiJson(response, [200]),
    config.store_id
  );
}

async function setRemoteWebUiEnabled(configOrPath, protocol, enabled) {
  if (typeof enabled !== "boolean") {
    throw new RemoteStoreError("Web UI setting must be a boolean");
  }
  const config = await resolveConfig(configOrPath);
  validateProtocol(protocol);
  const response = await authenticatedRequest(
    config,
    protocol,
    `${storeApiPath(config)}/settings/web-ui`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    }
  );
  return validateWebUiSetting(
    await readApiJson(response, [200]),
    config.store_id
  );
}

function validateWebUiSetting(value, storeId) {
  if (!value || value.schema !== SCHEMA || value.store_id !== storeId ||
      typeof value.web_ui_enabled !== "boolean" ||
      (value.updated_at !== null &&
       (typeof value.updated_at !== "string" ||
        Number.isNaN(Date.parse(value.updated_at))))) {
    throw new RemoteStoreError("remote service returned an invalid Web UI setting");
  }
  return value;
}

async function listRemoteVersions(configOrPath, protocol, limit = 100) {
  const config = await resolveConfig(configOrPath);
  validateProtocol(protocol);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RemoteStoreError("version limit must be an integer from 1 to 100");
  }
  const response = await authenticatedRequest(
    config,
    protocol,
    `${storeApiPath(config)}/versions?limit=${limit}`
  );
  const page = await readApiJson(response, [200]);
  if (!Array.isArray(page.versions)) {
    throw new RemoteStoreError("remote service returned an invalid version list");
  }
  page.versions.forEach(validateVersionMetadata);
  return page;
}

async function uploadRemoteSnapshot(configOrPath, protocol, snapshot) {
  const config = await resolveConfig(configOrPath);
  validateProtocol(protocol);
  const status = await getRemoteStatus(config, protocol);
  const baseVersion = status.latest === null ? "none" : status.latest.version;
  const envelope = encryptSnapshot(config, protocol, snapshot);
  const response = await authenticatedRequest(
    config,
    protocol,
    `${storeApiPath(config)}/versions`,
    {
      method: "PUT",
      headers: {
        "Content-Type": protocol.contentType,
        [protocol.baseVersionHeader]: baseVersion
      },
      body: JSON.stringify(envelope)
    }
  );
  const result = await readApiJson(response, [201]);
  validateVersionId(result.version);
  return result;
}

async function downloadRemoteSnapshot(configOrPath, protocol, version = "") {
  const config = await resolveConfig(configOrPath);
  validateProtocol(protocol);
  if (version) validateVersionId(version);
  const path = version
    ? `${storeApiPath(config)}/versions/${version}`
    : `${storeApiPath(config)}/latest`;
  const response = await authenticatedRequest(config, protocol, path);
  await requireApiSuccess(response, [200]);
  const contentType = (response.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== protocol.contentType) {
    throw new RemoteStoreError(
      `remote snapshot type '${contentType || "(missing)"}' does not match ${protocol.id}`
    );
  }
  const text = await readResponseTextLimited(
    response,
    MAX_RESPONSE_BYTES,
    "remote snapshot"
  );
  const envelope = parseJson(text, "remote snapshot envelope is not valid JSON");
  return decryptSnapshot(config, protocol, envelope);
}

function encryptSnapshot(config, protocol, snapshot) {
  validateRemoteConfig(config);
  validateProtocol(protocol);
  return encryptValue(
    protocol.snapshotKind,
    protocol.snapshotInfo,
    config,
    snapshot
  );
}

function decryptSnapshot(config, protocol, envelope) {
  validateRemoteConfig(config);
  validateProtocol(protocol);
  return decryptValue(
    protocol.snapshotKind,
    protocol.snapshotInfo,
    config,
    envelope
  );
}

function encryptValue(kind, info, config, value) {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const key = deriveKey(config, info);
  const iv = randomBytes(12);
  const aad = associatedData(kind, config.store_id);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  key.fill(0);

  return {
    schema: SCHEMA,
    kind,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "HKDF-SHA256",
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url")
    },
    ciphertext: ciphertext.toString("base64url")
  };
}

function decryptValue(kind, info, config, envelope) {
  if (!envelope || envelope.schema !== SCHEMA || envelope.kind !== kind ||
      envelope.encryption?.algorithm !== "AES-256-GCM" ||
      envelope.encryption?.kdf !== "HKDF-SHA256" ||
      typeof envelope.encryption.iv !== "string" ||
      typeof envelope.encryption.tag !== "string" ||
      typeof envelope.ciphertext !== "string") {
    throw new RemoteStoreError(`invalid ${kind} envelope`);
  }

  const iv = decodeBase64Url(envelope.encryption.iv, 12, "encryption IV");
  const tag = decodeBase64Url(envelope.encryption.tag, 16, "authentication tag");
  const ciphertext = decodeBase64Url(envelope.ciphertext, null, "encrypted payload");
  const key = deriveKey(config, info);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(associatedData(kind, config.store_id));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new RemoteStoreError(
      "snapshot authentication failed; the recovery code is wrong or the ciphertext changed"
    );
  } finally {
    key.fill(0);
  }

  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new RemoteStoreError(`decrypted ${kind} payload is invalid JSON`);
  } finally {
    plaintext.fill(0);
  }
}

function deriveAuthenticationToken(config, protocol) {
  const key = deriveKey(config, validateProtocol(protocol).authInfo);
  const token = key.toString("base64url");
  key.fill(0);
  return token;
}

function deriveKey(config, info) {
  const validated = validateRemoteConfig(config);
  const root = decodeBase64Url(validated.root_key, 32, "root key");
  const derived = Buffer.from(hkdfSync(
    "sha256",
    root,
    Buffer.from(validated.store_id, "ascii"),
    Buffer.from(info, "utf8"),
    32
  ));
  root.fill(0);
  return derived;
}

function associatedData(kind, storeId) {
  return Buffer.from(`${kind}:schema=${SCHEMA}:store=${storeId}`, "utf8");
}

function makeRecoveryCode(config, protocol) {
  const validated = validateRemoteConfig(config);
  validateProtocol(protocol);
  const payload = Buffer.from(JSON.stringify({
    schema: SCHEMA,
    endpoint: validated.endpoint,
    store_id: validated.store_id,
    root_key: validated.root_key
  }), "utf8");
  return `${protocol.recoveryPrefix}${payload.toString("base64url")}`;
}

function parseRecoveryCode(code, protocol) {
  validateProtocol(protocol);
  if (typeof code !== "string" || !code.startsWith(protocol.recoveryPrefix)) {
    throw new RemoteStoreError("recovery code has an invalid prefix");
  }
  const payload = decodeBase64Url(
    code.slice(protocol.recoveryPrefix.length),
    null,
    "recovery code"
  );
  if (payload.length > 64 * 1024) {
    throw new RemoteStoreError("recovery code is too large");
  }
  return validateRemoteConfig(
    parseJson(payload.toString("utf8"), "recovery code payload is invalid")
  );
}

async function readRemoteConfig(filePath) {
  const resolvedPath = resolve(filePath);
  await assertRegularPrivateFile(resolvedPath, "remote configuration");
  return validateRemoteConfig(
    parseJson(
      await readFile(resolvedPath, "utf8"),
      `invalid remote configuration: ${resolvedPath}`
    )
  );
}

function validateRemoteConfig(value) {
  if (!value || value.schema !== SCHEMA ||
      typeof value.endpoint !== "string" ||
      typeof value.store_id !== "string" ||
      !STORE_ID_PATTERN.test(value.store_id) ||
      typeof value.root_key !== "string") {
    throw new RemoteStoreError("remote configuration has an invalid schema");
  }
  decodeBase64Url(value.root_key, 32, "root key");
  return {
    schema: SCHEMA,
    endpoint: normalizeEndpoint(value.endpoint),
    store_id: value.store_id,
    root_key: value.root_key
  };
}

async function resolveConfig(configOrPath) {
  return typeof configOrPath === "string"
    ? readRemoteConfig(configOrPath)
    : validateRemoteConfig(configOrPath);
}

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteStoreError("remote endpoint must be a valid URL");
  }
  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new RemoteStoreError(
      "remote endpoint must use HTTPS (HTTP is allowed only for localhost)"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteStoreError(
      "remote endpoint must not contain credentials, a query, or a fragment"
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateCreateToken(value) {
  if (typeof value !== "string" ||
      value.length < MIN_CREATE_TOKEN_LENGTH ||
      value.length > MAX_CREATE_TOKEN_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteStoreError(
      `store creation token must contain ${MIN_CREATE_TOKEN_LENGTH}-${MAX_CREATE_TOKEN_LENGTH} printable characters`
    );
  }
  return value;
}

function validateVersionId(version) {
  if (typeof version !== "string" || !VERSION_ID_PATTERN.test(version)) {
    throw new RemoteStoreError("invalid remote version identifier");
  }
  return version;
}

function validateVersionMetadata(version) {
  if (!version ||
      !VERSION_ID_PATTERN.test(version.version || "") ||
      typeof version.created_at !== "string" ||
      Number.isNaN(Date.parse(version.created_at)) ||
      !Number.isSafeInteger(version.size) ||
      version.size < 1) {
    throw new RemoteStoreError("remote service returned invalid version metadata");
  }
}

function storeApiPath(config) {
  return `/v1/stores/${config.store_id}`;
}

async function authenticatedRequest(config, protocol, path, options = {}) {
  const token = deriveAuthenticationToken(config, protocol);
  return request(config, protocol, path, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`
    },
    authenticated: true
  });
}

async function request(config, _protocol, path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${config.endpoint}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new RemoteStoreError("remote request timed out");
    }
    throw new RemoteStoreError("could not reach the remote toolbox store");
  } finally {
    clearTimeout(timer);
  }
}

async function requireApiSuccess(response, expectedStatuses) {
  if (expectedStatuses.includes(response.status)) return;
  let message = `remote service returned HTTP ${response.status}`;
  try {
    const text = await readResponseTextLimited(
      response,
      MAX_ERROR_BYTES,
      "remote error response"
    );
    const body = JSON.parse(text);
    if (typeof body?.error?.code === "string" &&
        typeof body?.error?.message === "string") {
      message = `${body.error.code}: ${sanitizeRemoteMessage(body.error.message)}`;
    }
  } catch {
    // Keep the bounded generic status message.
  }
  throw new RemoteStoreError(message);
}

async function readApiJson(response, expectedStatuses) {
  await requireApiSuccess(response, expectedStatuses);
  const text = await readResponseTextLimited(
    response,
    1024 * 1024,
    "remote JSON response"
  );
  return parseJson(text, "remote service returned invalid JSON");
}

async function readResponseTextLimited(response, maxBytes, label) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null &&
      (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new RemoteStoreError(`${label} exceeds the safe size limit`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RemoteStoreError(`${label} exceeds the safe size limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function sanitizeRemoteMessage(value) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "remote request failed";
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteStoreError(message);
  }
}

function decodeBase64Url(value, expectedLength, label) {
  if (typeof value !== "string" ||
      value.length === 0 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RemoteStoreError(`${label} is not valid base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new RemoteStoreError(`${label} is not canonical base64url`);
  }
  if (expectedLength !== null && decoded.length !== expectedLength) {
    throw new RemoteStoreError(`${label} has an invalid length`);
  }
  return decoded;
}

async function assertRegularPrivateFile(filePath, label) {
  let details;
  try {
    details = await lstat(filePath);
  } catch {
    throw new RemoteStoreError(`${label} not found: ${filePath}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new RemoteStoreError(`${label} must be a regular file: ${filePath}`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new RemoteStoreError(
      `${label} permissions must not allow group or other access: ${filePath}`
    );
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const targetPath = resolve(filePath);
  const parentPath = dirname(targetPath);
  if (await pathExists(targetPath)) {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new RemoteStoreError(`refusing to replace non-regular file: ${targetPath}`);
    }
  }
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parentPath,
    `.${targetPath.slice(parentPath.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  RemoteStoreError,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
  decryptSnapshot,
  decryptValue,
  deriveAuthenticationToken,
  downloadRemoteSnapshot,
  encryptSnapshot,
  encryptValue,
  getRemoteStatus,
  getRemoteWebUiSetting,
  initializeRemoteStore,
  listRemoteVersions,
  makeRecoveryCode,
  parseRecoveryCode,
  readRemoteConfig,
  setRemoteWebUiEnabled,
  uploadRemoteSnapshot,
  validateRemoteConfig,
  writeJsonAtomic
};
