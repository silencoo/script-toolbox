import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  sourceHtml,
  builtHtml,
  app,
  workspace,
  inspector,
  modeToggle,
  themeProvider,
  sonner,
  styles,
  configText,
  button,
  dialog,
  tabs,
  toggle,
  mcpModel,
] = await Promise.all([
  read("./web/index.html"),
  read("./ui/index.html"),
  read("./web/src/App.tsx"),
  read("./web/src/components/store-workspace.tsx"),
  read("./web/src/components/store-inspector.tsx"),
  read("./web/src/components/mode-toggle.tsx"),
  read("./web/src/components/theme-provider.tsx"),
  read("./web/src/components/ui/sonner.tsx"),
  read("./web/src/index.css"),
  read("./components.json"),
  read("./web/src/components/ui/button.tsx"),
  read("./web/src/components/ui/dialog.tsx"),
  read("./web/src/components/ui/tabs.tsx"),
  read("./web/src/components/ui/switch.tsx"),
  read("./web/src/lib/mcp-model.js"),
]);

test("Workspace UI is built from real shadcn/ui source with neutral theming", () => {
  const config = JSON.parse(configText);
  assert.equal(config.$schema, "https://ui.shadcn.com/schema.json");
  assert.equal(config.style, "radix-nova");
  assert.equal(config.tailwind.baseColor, "neutral");
  assert.equal(config.tailwind.cssVariables, true);
  assert.equal(config.iconLibrary, "lucide");

  for (const component of [button, dialog, tabs, toggle]) {
    assert.match(component, /data-slot=/);
    assert.match(component, /from "radix-ui"/);
  }
  assert.match(workspace, /@\/components\/ui\/switch/);
  assert.match(workspace, /@\/components\/ui\/tabs/);
  assert.match(workspace, /@\/components\/ui\/select/);
  assert.match(workspace, /@\/components\/ui\/dialog/);
  assert.match(workspace, /group-data-horizontal\/tabs:h-12/);
  assert.match(workspace, /grid w-full items-stretch gap-1/);
  assert.match(workspace, /visible\.length === 1 \? "grid-cols-1 sm:max-w-72" : "grid-cols-3"/);
  assert.match(workspace, /className="h-full min-w-0 justify-center/);
  assert.match(app, /@\/components\/ui\/alert-dialog/);
});

test("theme, encrypted Store actions, and redacted MCP controls remain present", () => {
  assert.match(modeToggle, /value: "light"/);
  assert.match(modeToggle, /value: "dark"/);
  assert.match(modeToggle, /value: "system"/);
  assert.match(themeProvider, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(themeProvider, /localStorage\.setItem/);
  assert.doesNotMatch(themeProvider + modeToggle + sonner, /next-themes/);
  assert.doesNotMatch(themeProvider, /dangerouslySetInnerHTML/);
  assert.match(styles, /@custom-variant dark/);
  assert.match(styles, /--background: oklch\(1 0 0\)/);
  assert.match(styles, /--foreground: oklch\(0\.145 0 0\)/);

  assert.match(app, /parseRecoveryCode/);
  assert.match(app, /loadSection/);
  assert.match(workspace, /saveEncryptedSession/);
  assert.match(workspace, /redactMcpSnapshot/);
  assert.match(workspace, /mergeRedactedMcpImport/);
  assert.match(workspace, /agentctl workspace attach/);
  assert.match(inspector, /collectSecretDescriptors/);
  assert.match(inspector, /Stored inside the end-to-end encrypted MCP snapshot/);
  assert.match(inspector, /OAuth tokens stay in each MCP client/);
  assert.match(mcpModel, /variant_group/);
  assert.match(mcpModel, /secrets: "redacted"/);
});

test("Vite emits a CSP-compatible static shell without inline code", () => {
  assert.match(sourceHtml, /id="root"/);
  assert.doesNotMatch(sourceHtml, /<style\b/i);
  assert.doesNotMatch(sourceHtml, /<script(?![^>]*\bsrc=)/i);

  assert.match(builtHtml, /<script type="module" crossorigin src="\/assets\/index-[^"]+\.js"><\/script>/);
  assert.match(builtHtml, /<link rel="stylesheet" crossorigin href="\/assets\/index-[^"]+\.css">/);
  assert.doesNotMatch(builtHtml, /<style\b/i);
  assert.doesNotMatch(builtHtml, /<script(?![^>]*\bsrc=)/i);
});
