import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  sourceHtml,
  builtHtml,
  app,
  workspace,
  presetWorkspace,
  workspaceTabs,
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
  storeClient,
] = await Promise.all([
  read("./web/index.html"),
  read("./ui/index.html"),
  read("./web/src/App.tsx"),
  read("./web/src/components/store-workspace.tsx"),
  read("./web/src/components/preset-workspace.tsx"),
  read("./web/src/components/workspace-tabs.tsx"),
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
  read("./web/src/lib/store-client.js"),
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
  assert.match(workspaceTabs, /@\/components\/ui\/tabs/);
  assert.match(workspace, /@\/components\/ui\/select/);
  assert.match(workspace, /@\/components\/ui\/dialog/);
  assert.match(workspaceTabs, /grid w-full items-stretch gap-1/);
  assert.match(workspaceTabs, /visible\.length === 1 \? "grid-cols-1 sm:max-w-72" : "grid-cols-2 sm:grid-cols-4"/);
  assert.match(workspaceTabs, /className="h-10 min-w-0 justify-center/);
  assert.match(workspaceTabs, /presets: "Presets"/);
  assert.match(workspace, /aria-label={`\$\{SECTION_META\[session\.type\]\.label\} configuration`}/);
  assert.doesNotMatch(workspace, /Unified Workspace ·/);
  assert.doesNotMatch(workspace, /meta\.(title|summary)/);
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
  assert.match(app, /sessionStorage\.getItem/);
  assert.match(app, /sessionStorage\.setItem/);
  assert.match(app, /sessionStorage\.removeItem/);
  assert.match(app, /beforeunload/);
  assert.match(app, /Restoring this tab’s Store session/);
  assert.doesNotMatch(app, /localStorage/);
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

test("Workspace presets compose all three controllers and save only encrypted versions", () => {
  assert.match(presetWorkspace, /Development presets/);
  assert.match(presetWorkspace, /\["mcp", "skills", "prompt"\]/);
  assert.match(presetWorkspace, /missingReferences/);
  assert.match(presetWorkspace, /saveEncryptedWorkspace/);
  assert.match(presetWorkspace, /Save encrypted Workspace/);
  assert.match(presetWorkspace, /agentctl preset pull --yes/);
  assert.match(presetWorkspace, /Names are immutable/);
  assert.match(app, /workspaceDirty/);
  assert.match(app, /activeView/);
  assert.match(storeClient, /snapshot\.schema !== 2/);
  assert.match(storeClient, /isObject\(snapshot\.presets\)/);
  assert.match(storeClient, /newer Workspace version exists/);
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
