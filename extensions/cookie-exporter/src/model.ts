export interface CookiePartitionKeyRecord {
  topLevelSite?: string;
  hasCrossSiteAncestor?: boolean;
}

export interface CookieRecord {
  domain: string;
  expirationDate?: number;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  partitionKey?: CookiePartitionKeyRecord;
  path: string;
  sameSite: string;
  secure: boolean;
  session: boolean;
  storeId: string;
  value: string;
}

export function normalizeChromeCookie(cookie: chrome.cookies.Cookie): CookieRecord {
  const normalized: CookieRecord = {
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite: String(cookie.sameSite),
    secure: cookie.secure,
    session: cookie.session,
    storeId: cookie.storeId,
    value: cookie.value
  };

  if (cookie.expirationDate !== undefined) {
    normalized.expirationDate = cookie.expirationDate;
  }

  const sourcePartitionKey = cookie.partitionKey as
    | {
        topLevelSite?: string;
        hasCrossSiteAncestor?: boolean;
      }
    | undefined;

  if (sourcePartitionKey) {
    const partitionKey: CookiePartitionKeyRecord = {};

    if (sourcePartitionKey.topLevelSite !== undefined) {
      partitionKey.topLevelSite = sourcePartitionKey.topLevelSite;
    }

    if (sourcePartitionKey.hasCrossSiteAncestor !== undefined) {
      partitionKey.hasCrossSiteAncestor = sourcePartitionKey.hasCrossSiteAncestor;
    }

    normalized.partitionKey = partitionKey;
  }

  return normalized;
}

