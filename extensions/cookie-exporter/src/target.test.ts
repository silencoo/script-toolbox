import { describe, expect, it } from "vitest";

import {
  getCookiePermissionPatterns,
  makeExportFilename,
  normalizeSiteTarget,
  TargetValidationError
} from "./target";

describe("normalizeSiteTarget", () => {
  it("adds https when the scheme is omitted", () => {
    expect(normalizeSiteTarget("example.com/account")).toEqual({
      href: "https://example.com/account",
      hostname: "example.com",
      siteDomain: "example.com",
      hasRegistrableDomain: true
    });
  });

  it("preserves the URL path and query while dropping the fragment", () => {
    expect(normalizeSiteTarget("https://example.com/a?view=full#secret").href).toBe(
      "https://example.com/a?view=full"
    );
  });

  it("keeps a local host as its own site domain", () => {
    expect(normalizeSiteTarget("http://localhost:5173/dashboard")).toMatchObject({
      href: "http://localhost:5173/dashboard",
      hostname: "localhost",
      siteDomain: "localhost",
      hasRegistrableDomain: false
    });
  });

  it("uses the registrable domain instead of a naive last-two-label split", () => {
    expect(normalizeSiteTarget("https://accounts.example.co.uk").siteDomain).toBe(
      "example.co.uk"
    );
    expect(normalizeSiteTarget("https://project.github.io").siteDomain).toBe(
      "project.github.io"
    );
  });

  it("rejects unsupported schemes", () => {
    expect(() => normalizeSiteTarget("chrome://settings")).toThrow(TargetValidationError);
  });

  it("rejects credentials embedded in a URL", () => {
    expect(() => normalizeSiteTarget("https://user:pass@example.com")).toThrow(
      "网址不能包含用户名或密码"
    );
  });
});

describe("getCookiePermissionPatterns", () => {
  it("includes exact parent-cookie domains for URL scope", () => {
    const target = normalizeSiteTarget("https://gemini.google.com/app");

    expect(getCookiePermissionPatterns(target, "url")).toEqual([
      "http://google.com/*",
      "https://google.com/*",
      "http://gemini.google.com/*",
      "https://gemini.google.com/*"
    ]);
  });

  it("uses a wildcard only for the whole-site scope", () => {
    const target = normalizeSiteTarget("https://gemini.google.com/app");

    expect(getCookiePermissionPatterns(target, "site")).toEqual([
      "http://google.com/*",
      "https://google.com/*",
      "http://*.google.com/*",
      "https://*.google.com/*"
    ]);
  });

  it("does not broaden localhost or private-suffix sites", () => {
    expect(
      getCookiePermissionPatterns(normalizeSiteTarget("http://localhost:5173"), "site")
    ).toEqual(["http://localhost/*", "https://localhost/*"]);
    expect(
      getCookiePermissionPatterns(normalizeSiteTarget("https://project.github.io"), "site")
    ).toEqual([
      "http://project.github.io/*",
      "https://project.github.io/*",
      "http://*.project.github.io/*",
      "https://*.project.github.io/*"
    ]);
  });
});

describe("makeExportFilename", () => {
  it("creates a deterministic safe filename", () => {
    expect(
      makeExportFilename(
        "example.com",
        "netscape",
        "txt",
        new Date("2026-08-09T08:07:06.000Z")
      )
    ).toBe("example.com-cookies-netscape-20260809-080706.txt");
  });
});
