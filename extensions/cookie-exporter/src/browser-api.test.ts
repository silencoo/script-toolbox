import { afterEach, describe, expect, it, vi } from "vitest";

import { PermissionDeniedError, readCookiesForTarget } from "./browser-api";
import { normalizeSiteTarget } from "./target";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "chrome");
});

describe("readCookiesForTarget", () => {
  it("reads URL-matching parent-domain cookies from the active tab store", async () => {
    const request = vi.fn().mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(true);
    const getAll = vi.fn().mockResolvedValue([
      {
        domain: ".example.com",
        hostOnly: false,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "lax",
        secure: true,
        session: true,
        storeId: "1",
        value: "secret"
      }
    ]);
    installChromeMock({
      request,
      remove,
      getAll,
      getAllCookieStores: vi.fn().mockResolvedValue([{ id: "1", tabIds: [42] }])
    });

    const target = normalizeSiteTarget("https://example.com/account");
    const result = await readCookiesForTarget(target, {
      revokePermissionAfterRead: true,
      scope: "url",
      tabId: 42
    });

    const expectedOrigins = ["http://example.com/*", "https://example.com/*"];
    expect(request).toHaveBeenCalledWith({ origins: expectedOrigins });
    expect(getAll).toHaveBeenCalledWith({
      url: "https://example.com/account",
      storeId: "1"
    });
    expect(remove).toHaveBeenCalledWith({ origins: expectedOrigins });
    expect(result.permissionRemoved).toBe(true);
    expect(result.cookies[0]?.domain).toBe(".example.com");
    expect(result.cookies[0]?.httpOnly).toBe(true);
  });

  it("queries a registrable domain for the whole-site scope", async () => {
    const getAll = vi.fn().mockResolvedValue([]);
    const request = vi.fn().mockResolvedValue(true);
    installChromeMock({
      request,
      remove: vi.fn(),
      getAll,
      getAllCookieStores: vi.fn()
    });

    await readCookiesForTarget(normalizeSiteTarget("https://gemini.google.com/app"), {
      revokePermissionAfterRead: false,
      scope: "site"
    });

    expect(request).toHaveBeenCalledWith({
      origins: [
        "http://google.com/*",
        "https://google.com/*",
        "http://*.google.com/*",
        "https://*.google.com/*"
      ]
    });
    expect(getAll).toHaveBeenCalledWith({ domain: "google.com" });
  });

  it("stops before reading when the user denies the site permission", async () => {
    const getAll = vi.fn();
    installChromeMock({
      request: vi.fn().mockResolvedValue(false),
      remove: vi.fn(),
      getAll,
      getAllCookieStores: vi.fn()
    });

    await expect(
      readCookiesForTarget(normalizeSiteTarget("https://example.com"), {
        revokePermissionAfterRead: true,
        scope: "url"
      })
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("retains permission when requested", async () => {
    const remove = vi.fn();
    installChromeMock({
      request: vi.fn().mockResolvedValue(true),
      remove,
      getAll: vi.fn().mockResolvedValue([]),
      getAllCookieStores: vi.fn()
    });

    const result = await readCookiesForTarget(normalizeSiteTarget("https://example.com"), {
      revokePermissionAfterRead: false,
      scope: "url"
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.permissionRemoved).toBe(false);
  });

  it("still removes permission when the cookie query fails", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    installChromeMock({
      request: vi.fn().mockResolvedValue(true),
      remove,
      getAll: vi.fn().mockRejectedValue(new Error("cookie store unavailable")),
      getAllCookieStores: vi.fn()
    });

    await expect(
      readCookiesForTarget(normalizeSiteTarget("https://example.com"), {
        revokePermissionAfterRead: true,
        scope: "url"
      })
    ).rejects.toThrow("cookie store unavailable");
    expect(remove).toHaveBeenCalledWith({
      origins: ["http://example.com/*", "https://example.com/*"]
    });
  });
});

interface ChromeMockMethods {
  request: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  getAllCookieStores: ReturnType<typeof vi.fn>;
}

function installChromeMock(methods: ChromeMockMethods): void {
  const chromeMock = {
    tabs: {
      query: vi.fn()
    },
    permissions: {
      request: methods.request,
      remove: methods.remove
    },
    cookies: {
      getAll: methods.getAll,
      getAllCookieStores: methods.getAllCookieStores
    }
  };

  Object.assign(globalThis, {
    chrome: chromeMock as unknown as typeof chrome
  });
}
