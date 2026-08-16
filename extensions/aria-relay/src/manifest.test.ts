import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../public/manifest.json"), "utf8")
) as Record<string, unknown>;

describe("extension manifest security profile", () => {
  it("uses Manifest V3 and a module service worker", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
  });

  it("keeps required permissions minimal", () => {
    expect(manifest.permissions).toEqual(["contextMenus", "sidePanel", "storage"]);
    expect(manifest.optional_permissions).toEqual(["notifications"]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("host_permissions");
  });

  it("declares RPC hosts as runtime-only optional access", () => {
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
  });

  it("blocks remote runtime code", () => {
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'self'"
    });
  });
});
