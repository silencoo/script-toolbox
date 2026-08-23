import { PASSTHROUGH_MODE } from "./schema.mjs";

const FIXED_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

const CLIENT_AUTH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-agentctl-proxy-token"
]);

export function hopByHopHeaders(headers = {}) {
  const blocked = new Set(FIXED_HOP_BY_HOP_HEADERS);
  const raw = headers.connection;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const value of values) {
    for (const token of String(value).split(",")) {
      const name = token.trim().toLowerCase();
      if (name) blocked.add(name);
    }
  }
  return blocked;
}

export function upstreamHeaders(request, protocol, backend, secret, bodyLength = undefined, {
  mode = "provider",
  preserveBodyLength = false
} = {}) {
  const headers = {};
  const hopByHop = hopByHopHeaders(request.headers);
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    const localCredential = mode === PASSTHROUGH_MODE
      ? lower === "x-agentctl-proxy-token"
      : CLIENT_AUTH_HEADERS.has(lower);
    const invalidatedByBodyRewrite = mode === PASSTHROUGH_MODE
      ? lower === "content-length" && !preserveBodyLength
      : [
          "accept-encoding", "content-length", "content-encoding", "content-md5", "digest"
        ].includes(lower);
    if (hopByHop.has(lower) || localCredential || invalidatedByBodyRewrite) continue;
    if (value !== undefined) headers[lower] = value;
  }
  if (mode !== PASSTHROUGH_MODE) headers["accept-encoding"] = "identity";
  if (mode !== PASSTHROUGH_MODE) headers["user-agent"] = "agentproxyd/6";
  if (Number.isSafeInteger(bodyLength)) headers["content-length"] = String(bodyLength);
  if (backend.auth.mode === "bearer") headers.authorization = `Bearer ${secret}`;
  if (backend.auth.mode === "x-api-key") headers["x-api-key"] = secret;
  if (backend.auth.mode === "x-goog-api-key") headers["x-goog-api-key"] = secret;
  if (protocol === "anthropic_messages" && !headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

export function responseHeaders(headers, { reframeBody = false } = {}) {
  const result = {};
  const hopByHop = hopByHopHeaders(headers);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (reframeBody && lower === "content-length") continue;
    if (!hopByHop.has(lower) && value !== undefined) result[name] = value;
  }
  return result;
}
