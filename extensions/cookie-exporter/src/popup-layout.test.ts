import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const popup = readFileSync(
  fileURLToPath(new URL("../popup.html", import.meta.url)),
  "utf8"
);

describe("extension popup layout", () => {
  it("uses intrinsic dimensions instead of viewport-relative sizing", () => {
    expect(styles).toMatch(/width:\s*420px/);
    expect(styles).toMatch(/height:\s*600px/);
    expect(styles).not.toContain("max-height: 100vh");
    expect(styles).not.toContain("width: 100vw");
  });

  it("has exactly one vertical auto-scroll container", () => {
    expect(styles.match(/overflow-y:\s*auto/g)).toHaveLength(1);
    expect(styles).toMatch(/main\s*\{[^}]*overflow-y:\s*auto/s);
    expect(styles).not.toMatch(/\.cookie-list\s*\{[^}]*overflow-y/s);
  });

  it("offers URL and whole-site scopes with URL selected by default", () => {
    expect(popup).toMatch(/name="scope" value="url" checked/);
    expect(popup).toMatch(/name="scope" value="site"/);
    expect(popup).toContain("整个站点域");
    expect(popup.match(/name="scope"/g)).toHaveLength(2);
  });

  it("places the copy action immediately before file export", () => {
    const copyButtonIndex = popup.indexOf('id="copy-cookies"');
    const exportButtonIndex = popup.indexOf('id="export-cookies"');

    expect(copyButtonIndex).toBeGreaterThan(-1);
    expect(exportButtonIndex).toBeGreaterThan(copyButtonIndex);
    expect(popup.slice(copyButtonIndex, exportButtonIndex)).not.toContain("</div>");
  });

  it("includes field-specific search and an inline snapshot editor", () => {
    expect(popup).toContain('id="cookie-search-field"');
    expect(popup).toContain('id="cookie-search"');
    expect(popup).toContain('<option value="value">Value</option>');
    expect(popup).toContain('id="cookie-edit-form"');
    expect(popup).toContain("修改只用于本次复制或导出，不会写回浏览器。");
  });
});
