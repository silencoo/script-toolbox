// mcp-store — opaque, versioned storage for encrypted mcpctl snapshots.
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
const SNAPSHOT_CONTENT_TYPE = "application/vnd.mcpctl.snapshot+json";
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
          event: "mcp_store_request_failed",
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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

async function route(request, env) {
  assertEnvironment(env);

  const url = new URL(request.url);
  const parts = parsePath(url.pathname);

  if (parts.length === 1 && parts[0] === "health") {
    requireMethod(request, ["GET"]);
    return jsonResponse({
      schema: API_SCHEMA,
      service: "mcp-store",
      status: "ok"
    });
  }

  if (parts.length < 3 || parts[0] !== "v1" || parts[1] !== "stores") {
    throw new ApiError(404, "not_found", "Route not found.");
  }

  const storeId = parts[2];
  validateStoreId(storeId);

  if (parts.length === 3) {
    if (request.method === "PUT") {
      return createStore(request, env, storeId);
    }
    if (request.method === "GET") {
      await authenticate(request, env, storeId);
      return getStoreStatus(env, storeId);
    }
    throw methodNotAllowed(["GET", "PUT"]);
  }

  if (parts.length === 4 && parts[3] === "latest") {
    requireMethod(request, ["GET"]);
    await authenticate(request, env, storeId);
    return downloadLatest(env, storeId);
  }

  if (parts.length === 4 && parts[3] === "versions") {
    await authenticate(request, env, storeId);
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
    await authenticate(request, env, storeId);
    const versionId = parts[4];
    validateVersionId(versionId);
    return downloadVersion(env, storeId, versionId);
  }

  throw new ApiError(404, "not_found", "Route not found.");
}

function assertEnvironment(env) {
  if (!env || !env.MCP_STORE ||
      typeof env.MCP_STORE.get !== "function" ||
      typeof env.MCP_STORE.put !== "function") {
    throw new Error("MCP_STORE R2 binding is missing");
  }
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

  const result = await env.MCP_STORE.put(
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

  const supplied = request.headers.get("X-MCP-Store-Create-Token") || "";
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
  const object = await env.MCP_STORE.get(metaKey(storeId));

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
      { "WWW-Authenticate": 'Bearer realm="mcp-store"' }
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
      { "WWW-Authenticate": 'Bearer realm="mcp-store"' }
    );
  }
  return match[1];
}

async function getStoreStatus(env, storeId) {
  const head = await readHead(env, storeId);
  return jsonResponse({
    schema: API_SCHEMA,
    store_id: storeId,
    latest: head
  });
}

async function readHead(env, storeId) {
  const object = await env.MCP_STORE.get(headKey(storeId));
  if (object === null) return null;

  const head = await readTrustedJson(object, "store head");
  validateHead(head);
  return {
    version: head.version,
    created_at: head.created_at,
    size: head.size,
    sha256: head.sha256
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
      !/^[a-f0-9]{64}$/.test(head.sha256)) {
    throw new Error("invalid store head");
  }
}

async function uploadVersion(request, env, storeId) {
  const contentType = (request.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== SNAPSHOT_CONTENT_TYPE) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      `Content-Type must be ${SNAPSHOT_CONTENT_TYPE}.`
    );
  }

  const oldHeadObject = await env.MCP_STORE.get(headKey(storeId));
  let oldHead = null;
  if (oldHeadObject !== null) {
    oldHead = await readTrustedJson(oldHeadObject, "store head");
    validateHead(oldHead);
  }

  const baseVersion = request.headers.get("X-MCPCTL-Base-Version");
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

  const now = Date.now();
  const versionId =
    `${String(MAX_VERSION_TIME - now).padStart(13, "0")}-${crypto.randomUUID()}`;
  const createdAt = new Date(now).toISOString();
  const digest = await sha256Hex(bytes);
  const objectKey = versionKey(storeId, versionId);

  const versionObject = await env.MCP_STORE.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: SNAPSHOT_CONTENT_TYPE },
    customMetadata: {
      version: versionId,
      createdAt,
      sha256: digest
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
    sha256: digest
  };
  const headCondition = oldHeadObject === null
    ? { etagDoesNotMatch: "*" }
    : { etagMatches: oldHeadObject.etag };

  let headObject;
  try {
    headObject = await env.MCP_STORE.put(
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
    await env.MCP_STORE.delete(objectKey);
  } catch (error) {
    console.error(JSON.stringify({
      event: "mcp_store_orphan_cleanup_failed",
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

  const listed = await env.MCP_STORE.list(options);
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
      sha256: typeof metadata.sha256 === "string" ? metadata.sha256 : null
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
  const object = await env.MCP_STORE.get(versionKey(storeId, versionId));
  if (object === null) {
    throw new ApiError(404, "version_not_found", "Backup version not found.");
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", SNAPSHOT_CONTENT_TYPE);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("X-MCPCTL-Version", versionId);
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
