import { describe, expect, it } from "vitest";

import {
  applyCookieEditDraft,
  cloneCookieRecord,
  cookieRecordsEqual,
  cookieToEditDraft,
  findMatchingCookieIndices,
  paginateCookieIndices
} from "./cookie-workbench";
import type { CookieRecord } from "./model";

const cookies: CookieRecord[] = [
  {
    domain: ".google.com",
    expirationDate: 1_900_000_000,
    hostOnly: false,
    httpOnly: true,
    name: "SID",
    path: "/",
    sameSite: "no_restriction",
    secure: true,
    session: false,
    storeId: "0",
    value: "account-secret"
  },
  {
    domain: "gemini.google.com",
    hostOnly: true,
    httpOnly: false,
    name: "theme",
    path: "/app",
    sameSite: "lax",
    secure: true,
    session: true,
    storeId: "0",
    value: "dark"
  }
];

describe("findMatchingCookieIndices", () => {
  it("searches all fields without changing cookie order", () => {
    expect(findMatchingCookieIndices(cookies, "google.com", "all")).toEqual([0, 1]);
    expect(findMatchingCookieIndices(cookies, "ACCOUNT", "all")).toEqual([0]);
  });

  it("restricts matching to the selected field", () => {
    expect(findMatchingCookieIndices(cookies, "dark", "value")).toEqual([1]);
    expect(findMatchingCookieIndices(cookies, "dark", "name")).toEqual([]);
    expect(findMatchingCookieIndices(cookies, "httponly", "attributes")).toEqual([0]);
  });
});

describe("paginateCookieIndices", () => {
  const indices = Array.from({ length: 14 }, (_, index) => index);

  it("makes every matching cookie reachable across pages", () => {
    const firstPage = paginateCookieIndices(indices, 1, 10);
    const secondPage = paginateCookieIndices(indices, 2, 10);

    expect(firstPage).toMatchObject({
      page: 1,
      pageCount: 2,
      startOrdinal: 1,
      endOrdinal: 10
    });
    expect(firstPage.indices).toEqual(indices.slice(0, 10));
    expect(secondPage).toMatchObject({
      page: 2,
      pageCount: 2,
      startOrdinal: 11,
      endOrdinal: 14
    });
    expect(secondPage.indices).toEqual(indices.slice(10));
  });

  it("clamps a stale page after filtering changes the result count", () => {
    expect(paginateCookieIndices([3, 7], 4, 10)).toMatchObject({
      indices: [3, 7],
      page: 1,
      pageCount: 1
    });
  });
});

describe("cookie editing", () => {
  it("round-trips every supported cookie field", () => {
    const source: CookieRecord = {
      ...cookies[0]!,
      partitionKey: {
        hasCrossSiteAncestor: false,
        topLevelSite: "https://google.com"
      }
    };

    expect(applyCookieEditDraft(cookieToEditDraft(source))).toEqual(source);
  });

  it("preserves whitespace in names, values, and paths", () => {
    const source: CookieRecord = {
      ...cookies[0]!,
      name: " spaced name ",
      path: "/account ",
      value: " value with spaces "
    };

    expect(applyCookieEditDraft(cookieToEditDraft(source))).toEqual(source);
  });

  it("omits expiration for a session cookie and applies edited values", () => {
    const draft = cookieToEditDraft(cookies[0]!);
    draft.name = "edited";
    draft.value = "new-value";
    draft.session = true;

    const edited = applyCookieEditDraft(draft);

    expect(edited.name).toBe("edited");
    expect(edited.value).toBe("new-value");
    expect(edited.expirationDate).toBeUndefined();
  });

  it("validates fields that would create an invalid cookie snapshot", () => {
    const draft = cookieToEditDraft(cookies[0]!);
    draft.path = "account";

    expect(() => applyCookieEditDraft(draft)).toThrow("Path 必须以 / 开头");
  });

  it("clones partition metadata and detects changes", () => {
    const source: CookieRecord = {
      ...cookies[0]!,
      partitionKey: { topLevelSite: "https://google.com" }
    };
    const cloned = cloneCookieRecord(source);

    expect(cookieRecordsEqual(source, cloned)).toBe(true);
    cloned.partitionKey!.topLevelSite = "https://example.com";
    expect(cookieRecordsEqual(source, cloned)).toBe(false);
    expect(source.partitionKey?.topLevelSite).toBe("https://google.com");
  });
});
