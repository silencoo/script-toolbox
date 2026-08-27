import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  SYSTEM_PROFILE_ID,
  buildDynamicRules,
  buildNavigatorScript,
  normalizeHostname,
  normalizeSettings,
  resolveProfileId,
  type ExtensionSettings
} from "./core";

function settingsWith(overrides: Partial<ExtensionSettings>): ExtensionSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), ...overrides };
}

describe("hostname and imported settings validation", () => {
  it("normalizes domain rules without accepting paths or IPv6", () => {
    expect(normalizeHostname(" *.Example.COM ")).toBe("example.com");
    expect(normalizeHostname("sub.example.com")).toBe("sub.example.com");
    expect(normalizeHostname("example.com/path")).toBeNull();
    expect(normalizeHostname("[::1]")).toBeNull();
  });

  it("drops invalid and duplicate imported rules", () => {
    const normalized = normalizeSettings({
      schemaVersion: 1,
      customProfiles: [],
      siteRules: [
        { id: "one", hostname: "Example.com", profileId: "chrome-windows", enabled: true },
        { id: "two", hostname: "example.com", profileId: "edge-windows", enabled: true },
        { id: "three", hostname: "bad host", profileId: "chrome-windows", enabled: true },
        { id: "four", hostname: "valid.test", profileId: "missing", enabled: true }
      ]
    });
    expect(normalized.siteRules).toEqual([
      { id: "one", hostname: "example.com", profileId: "chrome-windows", enabled: true }
    ]);
  });
});

describe("profile resolution", () => {
  it("uses the longest matching site rule before the global profile", () => {
    const settings = settingsWith({
      globalProfileId: "chrome-windows",
      siteRules: [
        { id: "base", hostname: "example.com", profileId: "firefox-windows", enabled: true },
        { id: "app", hostname: "app.example.com", profileId: "safari-macos", enabled: true }
      ]
    });
    expect(resolveProfileId(settings, "www.example.com")).toBe("firefox-windows");
    expect(resolveProfileId(settings, "app.example.com")).toBe("safari-macos");
    expect(resolveProfileId(settings, "unrelated.test")).toBe("chrome-windows");
  });

  it("supports a site-level browser-default bypass", () => {
    const settings = settingsWith({
      globalProfileId: "chrome-windows",
      siteRules: [
        { id: "bypass", hostname: "example.com", profileId: SYSTEM_PROFILE_ID, enabled: true }
      ]
    });
    expect(resolveProfileId(settings, "example.com")).toBeNull();
  });
});

describe("declarativeNetRequest rules", () => {
  it("sets User-Agent and only replaces Chromium hints when they already exist", () => {
    const rules = buildDynamicRules(settingsWith({ globalProfileId: "chrome-windows" }));
    const userAgentRule = rules.find((rule) =>
      rule.action.requestHeaders?.some((header) => header.header === "user-agent")
    );
    const clientHintRule = rules.find((rule) =>
      rule.action.requestHeaders?.some((header) => header.header === "sec-ch-ua")
    );
    expect(userAgentRule?.action.type).toBe("modifyHeaders");
    const condition = clientHintRule?.condition as
      | (chrome.declarativeNetRequest.RuleCondition & { requestHeaders?: Array<{ header: string }> })
      | undefined;
    expect(condition?.requestHeaders).toEqual([{ header: "sec-ch-ua" }]);
  });

  it("removes Chromium Client Hints for a non-Chromium identity", () => {
    const rules = buildDynamicRules(settingsWith({ globalProfileId: "safari-macos" }));
    const headerOperations = rules[0]?.action.requestHeaders ?? [];
    expect(headerOperations).toContainEqual({ header: "sec-ch-ua", operation: "remove" });
    expect(headerOperations).toContainEqual({ header: "sec-ch-ua-platform", operation: "remove" });
  });

  it("gives site rules higher priority and emits an allow rule for bypasses", () => {
    const rules = buildDynamicRules(
      settingsWith({
        globalProfileId: "chrome-windows",
        siteRules: [
          { id: "bypass", hostname: "example.com", profileId: SYSTEM_PROFILE_ID, enabled: true }
        ]
      })
    );
    const bypass = rules.find((rule) => rule.action.type === "allow");
    expect(bypass?.priority).toBeGreaterThan(1);
    expect(bypass?.condition.requestDomains).toEqual(["example.com"]);
  });
});

describe("document-start navigator override", () => {
  it("builds a single hostname-aware MAIN-world script", () => {
    const script = buildNavigatorScript(
      settingsWith({
        globalProfileId: "chrome-windows",
        siteRules: [
          { id: "one", hostname: "example.com", profileId: "safari-macos", enabled: true }
        ]
      })
    );
    expect(script).toContain('define("userAgent"');
    expect(script).toContain('define("userAgentData"');
    expect(script).toContain("hostname.endsWith");
    expect(script).not.toContain("</script");
  });

  it("does not register a script when no identity is selected", () => {
    expect(buildNavigatorScript(structuredClone(DEFAULT_SETTINGS))).toBeNull();
  });
});

describe("popup scrolling layout", () => {
  const styles = readFileSync(resolve(import.meta.dirname, "./styles.css"), "utf8");

  it("uses an explicit popup height instead of a content-dependent viewport unit", () => {
    expect(styles).toMatch(/\.popup-page\s*{[^}]*height:\s*600px;/s);
    expect(styles).not.toMatch(/\.popup-page\s*{[^}]*\bdvh\b/s);
  });

  it("uses the remaining popup height as the single profile scroll area", () => {
    expect(styles).toMatch(/\.profile-section\s*{[^}]*display:\s*flex;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.profile-list\s*{[^}]*min-height:\s*0;[^}]*flex:\s*1;/s);
    expect(styles).toMatch(/\.profile-list\s*{[^}]*padding:[^}]*12px[^}]*overflow-y:\s*auto;/s);
    expect(styles).not.toMatch(/\.profile-list\s*{[^}]*max-height:/s);
  });
});

describe("Manifest V3 security profile", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../public/manifest.json"), "utf8")
  ) as Record<string, unknown>;

  it("uses MV3 with a module service worker and no blocking webRequest", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest.permissions).toEqual([
      "declarativeNetRequestWithHostAccess",
      "storage",
      "tabs",
      "userScripts"
    ]);
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest).not.toHaveProperty("content_scripts");
  });

  it("pins the Chrome version needed for per-extension User Scripts access", () => {
    expect(manifest.minimum_chrome_version).toBe("138");
    expect(manifest.host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });
});
