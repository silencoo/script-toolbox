export const DEFAULT_RPC_ENDPOINT = "http://127.0.0.1:6800/jsonrpc";

export class EndpointValidationError extends Error {
  override name = "EndpointValidationError";
}

export interface NormalizedEndpoint {
  endpoint: string;
  isLoopback: boolean;
  permissionPattern: string;
  usesTls: boolean;
}

export function normalizeEndpoint(input: string): NormalizedEndpoint {
  const raw = input.trim();
  let url: URL;

  if (!raw) {
    throw new EndpointValidationError("请输入 aria2 RPC 地址。");
  }

  try {
    url = new URL(raw);
  } catch {
    throw new EndpointValidationError("RPC 地址格式无效，请包含 http:// 或 https://。");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointValidationError("RPC 地址只支持 HTTP 或 HTTPS。");
  }

  if (!url.hostname) {
    throw new EndpointValidationError("RPC 地址缺少主机名。");
  }

  if (url.username || url.password) {
    throw new EndpointValidationError("请勿在 RPC 地址中嵌入用户名或密码。");
  }

  if (url.search || url.hash) {
    throw new EndpointValidationError("RPC 地址不能包含查询参数或片段。");
  }

  url.pathname = normalizeRpcPath(url.pathname);
  const port = url.port ? `:${url.port}` : "";
  const permissionPattern = `${url.protocol}//${url.hostname}${port}/*`;

  return {
    endpoint: url.toString(),
    isLoopback: isLoopbackHostname(url.hostname),
    permissionPattern,
    usesTls: url.protocol === "https:"
  };
}

export function isSafeDownloadUri(input: string): boolean {
  const uri = input.trim();

  if (/^magnet:\?/i.test(uri)) {
    return true;
  }

  try {
    const url = new URL(uri);
    return ["http:", "https:", "ftp:", "sftp:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function parseUriLines(input: string, maximum = 200): string[] {
  const values = input
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueValues = [...new Set(values)];

  if (uniqueValues.length === 0) {
    throw new Error("请至少输入一个下载地址或 Magnet 链接。");
  }

  if (uniqueValues.length > maximum) {
    throw new Error(`一次最多添加 ${maximum} 个任务。`);
  }

  const invalid = uniqueValues.find((value) => !isSafeDownloadUri(value));
  if (invalid) {
    throw new Error(`不支持的下载地址：${truncateForMessage(invalid)}`);
  }

  return uniqueValues;
}

export function sanitizeHeaderLines(input: string): string[] {
  const headers = input
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const header of headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*:\s*[^\r\n]+$/u.test(header)) {
      throw new Error(`请求头格式无效：${truncateForMessage(header)}`);
    }
  }

  return headers;
}

function normalizeRpcPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, "");
  return trimmed && trimmed !== "/" ? trimmed : "/jsonrpc";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function truncateForMessage(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}
