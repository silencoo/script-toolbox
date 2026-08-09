import { getDomain } from "tldts";

export type CookieScope = "url" | "site";

export interface SiteTarget {
  href: string;
  hostname: string;
  siteDomain: string;
  hasRegistrableDomain: boolean;
}

export class TargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetValidationError";
  }
}

const ABSOLUTE_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export function normalizeSiteTarget(input: string): SiteTarget {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new TargetValidationError("请输入要读取的完整网址。");
  }

  const candidate = ABSOLUTE_SCHEME.test(trimmed) ? trimmed : "https://" + trimmed;
  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    throw new TargetValidationError("网址格式无效，请输入例如 https://example.com/account。");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetValidationError("只支持 http:// 和 https:// 网站。");
  }

  if (!url.hostname) {
    throw new TargetValidationError("网址中缺少有效的主机名。");
  }

  if (url.username || url.password) {
    throw new TargetValidationError("网址不能包含用户名或密码。");
  }

  url.hash = "";

  const registrableDomain = getDomain(url.hostname, {
    allowPrivateDomains: true
  });

  return {
    href: url.href,
    hostname: url.hostname,
    siteDomain: registrableDomain ?? url.hostname,
    hasRegistrableDomain: registrableDomain !== null
  };
}

/**
 * Returns the smallest host-permission set that lets chrome.cookies expose the
 * requested scope. Cookie permissions are checked against each cookie's Domain,
 * so URL scope needs exact permissions for legal parent-cookie domains too.
 */
export function getCookiePermissionPatterns(
  target: SiteTarget,
  scope: CookieScope
): string[] {
  const hosts =
    scope === "site" && target.hasRegistrableDomain
      ? [target.siteDomain, "*." + target.siteDomain]
      : getCookieDomainCandidates(target.hostname, target.siteDomain);

  return Array.from(
    new Set(hosts.flatMap((host) => ["http://" + host + "/*", "https://" + host + "/*"]))
  );
}

function getCookieDomainCandidates(hostname: string, siteDomain: string): string[] {
  if (hostname === siteDomain || !hostname.endsWith("." + siteDomain)) {
    return [hostname];
  }

  const prefixLabels = hostname.slice(0, -(siteDomain.length + 1)).split(".");
  const candidates = [siteDomain];

  for (let index = prefixLabels.length - 1; index >= 0; index -= 1) {
    candidates.push(prefixLabels.slice(index).join(".") + "." + siteDomain);
  }

  return candidates;
}

export function makeExportFilename(
  hostname: string,
  formatId: string,
  extension: string,
  exportedAt: Date
): string {
  const safeHostname = hostname.replace(/[^a-zA-Z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const timestamp = exportedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 15)
    .replace("T", "-");

  return safeHostname + "-cookies-" + formatId + "-" + timestamp + "." + extension;
}
