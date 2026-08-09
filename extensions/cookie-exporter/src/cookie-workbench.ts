import type { CookiePartitionKeyRecord, CookieRecord } from "./model";

export type CookieSearchField =
  | "all"
  | "name"
  | "value"
  | "domain"
  | "path"
  | "sameSite"
  | "attributes"
  | "expirationDate"
  | "storeId"
  | "partitionKey";

export interface CookieEditDraft {
  domain: string;
  expirationDate: string;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  partitionHasCrossSiteAncestor: "unset" | "true" | "false";
  partitionTopLevelSite: string;
  path: string;
  sameSite: string;
  secure: boolean;
  session: boolean;
  storeId: string;
  value: string;
}

export interface CookieIndexPage {
  endOrdinal: number;
  indices: number[];
  page: number;
  pageCount: number;
  startOrdinal: number;
}

export class CookieEditValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieEditValidationError";
  }
}

export function findMatchingCookieIndices(
  cookies: readonly CookieRecord[],
  query: string,
  field: CookieSearchField
): number[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return cookies.map((_, index) => index);
  }

  const matches: number[] = [];

  cookies.forEach((cookie, index) => {
    const values = getSearchValues(cookie, field);

    if (values.some((value) => value.toLocaleLowerCase().includes(normalizedQuery))) {
      matches.push(index);
    }
  });

  return matches;
}

export function paginateCookieIndices(
  indices: readonly number[],
  requestedPage: number,
  pageSize: number
): CookieIndexPage {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }

  const pageCount = Math.max(1, Math.ceil(indices.length / pageSize));
  const safeRequestedPage = Number.isFinite(requestedPage)
    ? Math.trunc(requestedPage)
    : 1;
  const page = Math.min(Math.max(safeRequestedPage, 1), pageCount);
  const startIndex = (page - 1) * pageSize;
  const pageIndices = indices.slice(startIndex, startIndex + pageSize);

  return {
    endOrdinal: startIndex + pageIndices.length,
    indices: pageIndices,
    page,
    pageCount,
    startOrdinal: pageIndices.length > 0 ? startIndex + 1 : 0
  };
}

export function cookieToEditDraft(cookie: CookieRecord): CookieEditDraft {
  return {
    domain: cookie.domain,
    expirationDate:
      cookie.expirationDate === undefined ? "" : String(cookie.expirationDate),
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    partitionHasCrossSiteAncestor:
      cookie.partitionKey?.hasCrossSiteAncestor === undefined
        ? "unset"
        : String(cookie.partitionKey.hasCrossSiteAncestor) as "true" | "false",
    partitionTopLevelSite: cookie.partitionKey?.topLevelSite ?? "",
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    session: cookie.session,
    storeId: cookie.storeId,
    value: cookie.value
  };
}

export function applyCookieEditDraft(draft: CookieEditDraft): CookieRecord {
  const domain = draft.domain.trim();
  const path = draft.path;
  const storeId = draft.storeId.trim();

  if (!domain) {
    throw new CookieEditValidationError("Domain 不能为空。");
  }

  if (!path.startsWith("/")) {
    throw new CookieEditValidationError("Path 必须以 / 开头。");
  }

  if (!storeId) {
    throw new CookieEditValidationError("Store ID 不能为空。");
  }

  const cookie: CookieRecord = {
    domain,
    hostOnly: draft.hostOnly,
    httpOnly: draft.httpOnly,
    name: draft.name,
    path,
    sameSite: draft.sameSite,
    secure: draft.secure,
    session: draft.session,
    storeId,
    value: draft.value
  };

  if (!draft.session) {
    const expirationText = draft.expirationDate.trim();

    if (!expirationText) {
      throw new CookieEditValidationError("非 Session Cookie 必须填写过期时间。");
    }

    const expirationDate = Number(expirationText);

    if (!Number.isFinite(expirationDate) || expirationDate < 0) {
      throw new CookieEditValidationError("过期时间必须是有效的非负 Unix 秒数。");
    }

    cookie.expirationDate = expirationDate;
  }

  const topLevelSite = draft.partitionTopLevelSite.trim();

  if (topLevelSite || draft.partitionHasCrossSiteAncestor !== "unset") {
    const partitionKey: CookiePartitionKeyRecord = {};

    if (topLevelSite) {
      partitionKey.topLevelSite = topLevelSite;
    }

    if (draft.partitionHasCrossSiteAncestor !== "unset") {
      partitionKey.hasCrossSiteAncestor =
        draft.partitionHasCrossSiteAncestor === "true";
    }

    cookie.partitionKey = partitionKey;
  }

  return cookie;
}

export function cloneCookieRecord(cookie: CookieRecord): CookieRecord {
  return {
    ...cookie,
    ...(cookie.partitionKey ? { partitionKey: { ...cookie.partitionKey } } : {})
  };
}

export function cookieRecordsEqual(left: CookieRecord, right: CookieRecord): boolean {
  return (
    left.domain === right.domain &&
    left.expirationDate === right.expirationDate &&
    left.hostOnly === right.hostOnly &&
    left.httpOnly === right.httpOnly &&
    left.name === right.name &&
    left.path === right.path &&
    left.sameSite === right.sameSite &&
    left.secure === right.secure &&
    left.session === right.session &&
    left.storeId === right.storeId &&
    left.value === right.value &&
    left.partitionKey?.topLevelSite === right.partitionKey?.topLevelSite &&
    left.partitionKey?.hasCrossSiteAncestor ===
      right.partitionKey?.hasCrossSiteAncestor
  );
}

function getSearchValues(cookie: CookieRecord, field: CookieSearchField): string[] {
  const values: Record<Exclude<CookieSearchField, "all">, string> = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    sameSite: cookie.sameSite,
    attributes: [
      cookie.secure ? "secure" : "",
      cookie.httpOnly ? "httponly" : "",
      cookie.session ? "session" : "persistent",
      cookie.hostOnly ? "hostonly" : "domain"
    ].join(" "),
    expirationDate:
      cookie.expirationDate === undefined ? "" : String(cookie.expirationDate),
    storeId: cookie.storeId,
    partitionKey: [
      cookie.partitionKey?.topLevelSite ?? "",
      cookie.partitionKey?.hasCrossSiteAncestor === undefined
        ? ""
        : String(cookie.partitionKey.hasCrossSiteAncestor)
    ].join(" ")
  };

  return field === "all" ? Object.values(values) : [values[field]];
}
