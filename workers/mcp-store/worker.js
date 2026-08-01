// toolbox-store — opaque, versioned storage for encrypted controller snapshots.
//
// The client creates every store identifier, authentication capability, and
// encryption key. This Worker receives an authentication capability over TLS,
// stores only its SHA-256 digest, and never receives a decryption key.

const API_SCHEMA = 1;
const DEFAULT_MAX_BLOB_BYTES = 5 * 1024 * 1024;
const MAX_CONFIGURED_BLOB_BYTES = 25 * 1024 * 1024;
const STORE_ID_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_ID_PATTERN = /^[0-9]{13}-[a-f0-9-]{36}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LEGACY_MCP_SNAPSHOT_CONTENT_TYPE = "application/vnd.mcpctl.snapshot+json";
const TOOLBOX_SNAPSHOT_CONTENT_TYPE = "application/vnd.script-toolbox.snapshot+json";
const SKILLS_SNAPSHOT_CONTENT_TYPE = "application/vnd.skillsctl.snapshot+json";
const PROMPT_SNAPSHOT_CONTENT_TYPE = "application/vnd.promptctl.snapshot+json";
const WORKSPACE_SNAPSHOT_CONTENT_TYPE = "application/vnd.agentctl.workspace+json";
const SNAPSHOT_CONTENT_TYPES = new Set([
  LEGACY_MCP_SNAPSHOT_CONTENT_TYPE,
  TOOLBOX_SNAPSHOT_CONTENT_TYPE,
  SKILLS_SNAPSHOT_CONTENT_TYPE,
  PROMPT_SNAPSHOT_CONTENT_TYPE,
  WORKSPACE_SNAPSHOT_CONTENT_TYPE
]);
const MAX_VERSION_TIME = 9_999_999_999_999;
const MIN_CREATE_TOKEN_LENGTH = 32;
const MAX_CREATE_TOKEN_LENGTH = 512;

class ApiError extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    let response;

    try {
      response = await route(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        response = errorResponse(error.status, error.code, error.message, error.headers);
      } else {
        console.error(JSON.stringify({
          event: "toolbox_store_request_failed",
          request_id: requestId,
          method: request.method,
          path_class: classifyPath(new URL(request.url).pathname),
          error_name: error instanceof Error ? error.name : "UnknownError"
        }));
        response = errorResponse(500, "internal_error", "The request could not be completed.");
      }
    }

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Request-Id", requestId);
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; " +
      "img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; " +
      "style-src-attr 'unsafe-inline'; " +
      "script-src 'self'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'"
    );

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = parsePath(url.pathname);

  if (parts.length === 1 && parts[0] === "health") {
    assertEnvironment(env);
    requireMethod(request, ["GET"]);
    return jsonResponse({
      schema: API_SCHEMA,
      service: "toolbox-store",
      compatibility: [
        "mcp-store-v1",
        "skills-store-v1",
        "prompt-store-v1",
        "toolbox-workspace-v1"
      ],
      status: "ok"
    });
  }

  if (parts.length === 0 && env?.ASSETS &&
      typeof env.ASSETS.fetch === "function") {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/index.html";
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }

  if (parts.length < 3 || parts[0] !== "v1" || parts[1] !== "stores") {
    if (env?.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    throw new ApiError(404, "not_found", "Route not found.");
  }

  assertEnvironment(env);
  const storeId = parts[2];
  validateStoreId(storeId);

  if (parts.length === 3) {
    if (request.method === "PUT") {
      return createStore(request, env, storeId);
    }
    if (request.method === "GET") {
      await authenticateForAccess(request, env, storeId);
      return getStoreStatus(env, storeId);
    }
    throw methodNotAllowed(["GET", "PUT"]);
  }

  if (parts.length === 4 && parts[3] === "latest") {
    requireMethod(request, ["GET"]);
    await authenticateForAccess(request, env, storeId);
    return downloadLatest(env, storeId);
  }

  if (parts.length === 4 && parts[3] === "versions") {
    await authenticateForAccess(request, env, storeId);
    if (request.method === "PUT") {
      return uploadVersion(request, env, storeId);
    }
    if (request.method === "GET") {
      return listVersions(url, env, storeId);
    }
    throw methodNotAllowed(["GET", "PUT"]);
  }

  if (parts.length === 5 && parts[3] === "versions") {
    requireMethod(request, ["GET"]);
    await authenticateForAccess(request, env, storeId);
    const versionId = parts[4];
    validateVersionId(versionId);
    return downloadVersion(env, storeId, versionId);
  }

  if (parts.length === 5 && parts[3] === "settings" && parts[4] === "web-ui") {
    await authenticate(request, env, storeId);
    if (request.method === "GET") return getWebUiSetting(env, storeId);
    if (request.method === "PUT") return updateWebUiSetting(request, env, storeId);
    throw methodNotAllowed(["GET", "PUT"]);
  }

  throw new ApiError(404, "not_found", "Route not found.");
}

function assertEnvironment(env) {
  const bucket = storeBucket(env);
  if (!bucket ||
      typeof bucket.get !== "function" ||
      typeof bucket.put !== "function") {
    throw new Error("TOOLBOX_STORE/MCP_STORE R2 binding is missing");
  }
}

function storeBucket(env) {
  return env?.TOOLBOX_STORE || env?.MCP_STORE;
}

function parsePath(pathname) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new ApiError(400, "invalid_path", "The URL path is invalid.");
  }
}

function classifyPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "health") return "health";
  if (parts.length >= 2 && parts[0] === "v1" && parts[1] === "stores") {
    if (parts[3] === "versions" && parts.length === 5) return "version";
    if (parts[3] === "versions") return "versions";
    if (parts[3] === "latest") return "latest";
    if (parts[3] === "settings") return "settings";
    return "store";
  }
  return "unknown";
}

function validateStoreId(storeId) {
  if (!STORE_ID_PATTERN.test(storeId)) {
    throw new ApiError(400, "invalid_store_id", "Store identifier is invalid.");
  }
}

function validateVersionId(versionId) {
  if (!VERSION_ID_PATTERN.test(versionId)) {
    throw new ApiError(400, "invalid_version_id", "Version identifier is invalid.");
  }
}

function requireMethod(request, methods) {
  if (!methods.includes(request.method)) {
    throw methodNotAllowed(methods);
  }
}

function methodNotAllowed(methods) {
  return new ApiError(
    405,
    "method_not_allowed",
    "Method not allowed.",
    { Allow: methods.join(", ") }
  );
}

function jsonResponse(value, status = 200, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

function errorResponse(status, code, message, extraHeaders = undefined) {
  return jsonResponse({
    error: {
      code,
      message
    }
  }, status, extraHeaders);
}

function metaKey(storeId) {
  return `v1/stores/${storeId}/meta.json`;
}

function headKey(storeId) {
  return `v1/stores/${storeId}/head.json`;
}

function versionPrefix(storeId) {
  return `v1/stores/${storeId}/versions/`;
}

function versionKey(storeId, versionId) {
  return `${versionPrefix(storeId)}${versionId}.blob`;
}

function settingsKey(storeId) {
  return `v1/stores/${storeId}/settings.json`;
}

async function createStore(request, env, storeId) {
  await authorizeStoreCreation(request, env);
  const token = readBearerToken(request);
  const bodySize = request.headers.get("Content-Length");
  if (request.body !== null && bodySize !== "0") {
    const body = await readBodyLimited(request, 1);
    if (body.byteLength > 0) {
      throw new ApiError(400, "unexpected_body", "Store creation does not accept a body.");
    }
  }

  const createdAt = new Date().toISOString();
  const tokenDigest = await sha256Hex(new TextEncoder().encode(token));
  const metadata = {
    schema: API_SCHEMA,
    auth: {
      algorithm: "sha256",
      digest: tokenDigest
    },
    created_at: createdAt
  };

  const result = await storeBucket(env).put(
    metaKey(storeId),
    JSON.stringify(metadata),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" }
    }
  );

  if (result === null) {
    throw new ApiError(409, "store_exists", "A store with this identifier already exists.");
  }

  return jsonResponse({
    schema: API_SCHEMA,
    store_id: storeId,
    created_at: createdAt
  }, 201);
}

async function authorizeStoreCreation(request, env) {
  const expected = env.CREATE_TOKEN;
  if (typeof expected !== "string" ||
      expected.length < MIN_CREATE_TOKEN_LENGTH ||
      expected.length > MAX_CREATE_TOKEN_LENGTH) {
    throw new ApiError(
      503,
      "store_creation_disabled",
      "Store creation is disabled on this service."
    );
  }

  const supplied =
    request.headers.get("X-Toolbox-Store-Create-Token") ||
    request.headers.get("X-MCP-Store-Create-Token") ||
    "";
  if (supplied.length < MIN_CREATE_TOKEN_LENGTH ||
      supplied.length > MAX_CREATE_TOKEN_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(supplied)) {
    throw new ApiError(401, "invalid_create_token", "Store creation is not authorized.");
  }

  const [actualDigest, expectedDigest] = await Promise.all([
    sha256Hex(new TextEncoder().encode(supplied)),
    sha256Hex(new TextEncoder().encode(expected))
  ]);
  if (!timingSafeHexEqual(actualDigest, expectedDigest)) {
    throw new ApiError(401, "invalid_create_token", "Store creation is not authorized.");
  }
}

async function authenticate(request, env, storeId) {
  const token = readBearerToken(request);
  const object = await storeBucket(env).get(metaKey(storeId));

  if (object === null) {
    throw new ApiError(404, "store_not_found", "Store not found.");
  }

  const metadata = await readTrustedJson(object, "store metadata");
  const expectedDigest = metadata?.auth?.digest;
  if (metadata?.schema !== API_SCHEMA ||
      metadata?.auth?.algorithm !== "sha256" ||
      typeof expectedDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("invalid store metadata");
  }

  const actualDigest = await sha256Hex(new TextEncoder().encode(token));
  if (!timingSafeHexEqual(actualDigest, expectedDigest)) {
    throw new ApiError(
      401,
      "unauthorized",
      "Authentication failed.",
      { "WWW-Authenticate": 'Bearer realm="toolbox-store"' }
    );
  }
}

async function authenticateForAccess(request, env, storeId) {
  await authenticate(request, env, storeId);
  if ((request.headers.get("X-Toolbox-Client") || "").toLowerCase() !== "web") {
    return;
  }
  const setting = await readWebUiSetting(env, storeId);
  if (!setting.web_ui_enabled) {
    throw new ApiError(
      403,
      "web_ui_disabled",
      "Web UI access is disabled for this store. Enable it with the matching ctl."
    );
  }
}

function readBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match || !TOKEN_PATTERN.test(match[1])) {
    throw new ApiError(
      401,
      "unauthorized",
      "A valid bearer capability is required.",
      { "WWW-Authenticate": 'Bearer realm="toolbox-store"' }
    );
  }
  return match[1];
}

async function getStoreStatus(env, storeId) {
  const [head, setting] = await Promise.all([
    readHead(env, storeId),
    readWebUiSetting(env, storeId)
  ]);
  return jsonResponse({
    schema: API_SCHEMA,
    store_id: storeId,
    latest: head,
    web_ui_enabled: setting.web_ui_enabled
  });
}

async function getWebUiSetting(env, storeId) {
  const setting = await readWebUiSetting(env, storeId);
  return jsonResponse({
    schema: API_SCHEMA,
    store_id: storeId,
    web_ui_enabled: setting.web_ui_enabled,
    updated_at: setting.updated_at
  });
}

async function updateWebUiSetting(request, env, storeId) {
  const contentType = (request.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const bytes = await readBodyLimited(request, 1024);
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json", "Web UI setting must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.enabled !== "boolean" ||
      Object.keys(body).some((key) => key !== "enabled")) {
    throw new ApiError(
      400,
      "invalid_setting",
      "Web UI setting must contain only a boolean enabled field."
    );
  }
  const setting = {
    schema: API_SCHEMA,
    web_ui_enabled: body.enabled,
    updated_at: new Date().toISOString()
  };
  await storeBucket(env).put(settingsKey(storeId), JSON.stringify(setting), {
    httpMetadata: { contentType: "application/json" }
  });
  return jsonResponse({
    schema: API_SCHEMA,
    store_id: storeId,
    web_ui_enabled: setting.web_ui_enabled,
    updated_at: setting.updated_at
  });
}

async function readWebUiSetting(env, storeId) {
  const object = await storeBucket(env).get(settingsKey(storeId));
  if (object === null) {
    return {
      schema: API_SCHEMA,
      web_ui_enabled: false,
      updated_at: null
    };
  }
  const setting = await readTrustedJson(object, "store settings");
  if (!setting || setting.schema !== API_SCHEMA ||
      typeof setting.web_ui_enabled !== "boolean" ||
      typeof setting.updated_at !== "string" ||
      Number.isNaN(Date.parse(setting.updated_at))) {
    throw new Error("invalid store settings");
  }
  return setting;
}

async function readHead(env, storeId) {
  const object = await storeBucket(env).get(headKey(storeId));
  if (object === null) return null;

  const head = await readTrustedJson(object, "store head");
  validateHead(head);
  return {
    version: head.version,
    created_at: head.created_at,
    size: head.size,
    sha256: head.sha256,
    content_type: head.content_type || LEGACY_MCP_SNAPSHOT_CONTENT_TYPE
  };
}

function validateHead(head) {
  if (!head ||
      head.schema !== API_SCHEMA ||
      typeof head.version !== "string" ||
      !VERSION_ID_PATTERN.test(head.version) ||
      typeof head.created_at !== "string" ||
      typeof head.size !== "number" ||
      !Number.isSafeInteger(head.size) ||
      head.size < 1 ||
      typeof head.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(head.sha256) ||
      (head.content_type !== undefined &&
       !SNAPSHOT_CONTENT_TYPES.has(head.content_type))) {
    throw new Error("invalid store head");
  }
}

async function uploadVersion(request, env, storeId) {
  const contentType = (request.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!SNAPSHOT_CONTENT_TYPES.has(contentType)) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be a supported encrypted toolbox snapshot type."
    );
  }

  const bucket = storeBucket(env);
  const oldHeadObject = await bucket.get(headKey(storeId));
  let oldHead = null;
  if (oldHeadObject !== null) {
    oldHead = await readTrustedJson(oldHeadObject, "store head");
    validateHead(oldHead);
  }

  const baseVersion =
    request.headers.get("X-Toolbox-Base-Version") ||
    request.headers.get("X-MCPCTL-Base-Version");
  const expectedBase = oldHead === null ? "none" : oldHead.version;
  if (baseVersion !== expectedBase) {
    throw new ApiError(
      409,
      "version_conflict",
      "The store changed; fetch its status and retry the backup."
    );
  }

  const maxBytes = configuredMaxBlobBytes(env);
  const bytes = await readBodyLimited(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw new ApiError(400, "empty_snapshot", "Snapshot body must not be empty.");
  }

  // R2 lists keys lexicographically. Advance the logical millisecond when two
  // writes land in the same clock tick so inverted timestamps remain a strict
  // newest-first ordering and pagination is deterministic.
  const previousTime = oldHead === null
    ? 0
    : MAX_VERSION_TIME - Number(oldHead.version.slice(0, 13));
  const now = Math.max(Date.now(), previousTime + 1);
  const versionId =
    `${String(MAX_VERSION_TIME - now).padStart(13, "0")}-${crypto.randomUUID()}`;
  const createdAt = new Date(now).toISOString();
  const digest = await sha256Hex(bytes);
  const objectKey = versionKey(storeId, versionId);

  const versionObject = await bucket.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType },
    customMetadata: {
      version: versionId,
      createdAt,
      sha256: digest,
      contentType
    }
  });
  if (versionObject === null) {
    throw new ApiError(409, "version_collision", "Please retry the backup.");
  }

  const newHead = {
    schema: API_SCHEMA,
    version: versionId,
    created_at: createdAt,
    size: bytes.byteLength,
    sha256: digest,
    content_type: contentType
  };
  const headCondition = oldHeadObject === null
    ? { etagDoesNotMatch: "*" }
    : { etagMatches: oldHeadObject.etag };

  let headObject;
  try {
    headObject = await bucket.put(
      headKey(storeId),
      JSON.stringify(newHead),
      {
        onlyIf: headCondition,
        httpMetadata: { contentType: "application/json" }
      }
    );
  } catch (error) {
    await cleanupUnreferencedVersion(env, objectKey);
    throw error;
  }

  if (headObject === null) {
    await cleanupUnreferencedVersion(env, objectKey);
    throw new ApiError(
      409,
      "version_conflict",
      "Another backup completed first; retry this backup."
    );
  }

  return jsonResponse(newHead, 201, {
    Location: `/v1/stores/${storeId}/versions/${versionId}`
  });
}

async function cleanupUnreferencedVersion(env, objectKey) {
  try {
    await storeBucket(env).delete(objectKey);
  } catch (error) {
    console.error(JSON.stringify({
      event: "toolbox_store_orphan_cleanup_failed",
      error_name: error instanceof Error ? error.name : "UnknownError"
    }));
  }
}

async function listVersions(url, env, storeId) {
  const limit = parseListLimit(url.searchParams.get("limit"));
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const options = {
    prefix: versionPrefix(storeId),
    limit,
    include: ["customMetadata"]
  };
  if (cursor !== null) options.cursor = cursor;

  const listed = await storeBucket(env).list(options);
  const versions = listed.objects.map((object) => {
    const metadata = object.customMetadata || {};
    const version = typeof metadata.version === "string"
      ? metadata.version
      : object.key.slice(versionPrefix(storeId).length, -".blob".length);

    return {
      version,
      created_at: typeof metadata.createdAt === "string"
        ? metadata.createdAt
        : object.uploaded.toISOString(),
      size: object.size,
      sha256: typeof metadata.sha256 === "string" ? metadata.sha256 : null,
      content_type: SNAPSHOT_CONTENT_TYPES.has(metadata.contentType)
        ? metadata.contentType
        : LEGACY_MCP_SNAPSHOT_CONTENT_TYPE
    };
  });

  return jsonResponse({
    schema: API_SCHEMA,
    versions,
    cursor: listed.truncated ? listed.cursor : null
  });
}

function parseListLimit(value) {
  if (value === null || value === "") return 20;
  if (!/^[0-9]+$/.test(value)) {
    throw new ApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  return limit;
}

function parseCursor(value) {
  if (value === null || value === "") return null;
  if (value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ApiError(400, "invalid_cursor", "cursor is invalid.");
  }
  return value;
}

async function downloadLatest(env, storeId) {
  const head = await readHead(env, storeId);
  if (head === null) {
    throw new ApiError(404, "snapshot_not_found", "This store has no backups.");
  }
  return downloadVersion(env, storeId, head.version);
}

async function downloadVersion(env, storeId, versionId) {
  const object = await storeBucket(env).get(versionKey(storeId, versionId));
  if (object === null) {
    throw new ApiError(404, "version_not_found", "Backup version not found.");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = SNAPSHOT_CONTENT_TYPES.has(object.customMetadata?.contentType)
    ? object.customMetadata.contentType
    : LEGACY_MCP_SNAPSHOT_CONTENT_TYPE;
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("X-MCPCTL-Version", versionId);
  headers.set("X-Toolbox-Store-Version", versionId);
  if (object.customMetadata?.sha256) {
    headers.set("X-Content-SHA256", object.customMetadata.sha256);
  }
  return new Response(object.body, { status: 200, headers });
}

function configuredMaxBlobBytes(env) {
  const raw = env.MAX_BLOB_BYTES;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_MAX_BLOB_BYTES;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw new Error("MAX_BLOB_BYTES must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) ||
      value < 1024 ||
      value > MAX_CONFIGURED_BLOB_BYTES) {
    throw new Error("MAX_BLOB_BYTES is outside the supported range");
  }
  return value;
}

async function readBodyLimited(request, maxBytes) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) {
      throw new ApiError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (Number(contentLength) > maxBytes) {
      throw new ApiError(413, "snapshot_too_large", "Snapshot exceeds the configured size limit.");
    }
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(
          413,
          "snapshot_too_large",
          "Snapshot exceeds the configured size limit."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readTrustedJson(object, label) {
  try {
    return JSON.parse(await object.text());
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeHexEqual(left, right) {
  if (left.length !== right.length || left.length % 2 !== 0) return false;
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
  }

  // Node's Web Crypto does not currently expose timingSafeEqual, so unit
  // tests and other standards-only runtimes use this fixed-length fallback.
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
