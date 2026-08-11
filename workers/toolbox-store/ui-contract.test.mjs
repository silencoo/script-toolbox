import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  sourceHtml,
  builtHtml,
  app,
  workspace,
  agentWorkspace,
  snippetWorkspace,
  presetWorkspace,
  workspaceTabs,
  inspector,
  catalogView,
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
  read("./web/src/components/agent-workspace.tsx"),
  read("./web/src/components/snippet-workspace.tsx"),
  read("./web/src/components/preset-workspace.tsx"),
  read("./web/src/components/workspace-tabs.tsx"),
  read("./web/src/components/store-inspector.tsx"),
  read("./web/src/lib/catalog-view.js"),
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
  assert.match(workspace, /Enabled \{enabled\.size\}/);
  assert.match(workspace, /All \{allItems\.length\}/);
  assert.match(workspace, /CATALOG_SCOPE_LABELS/);
  assert.match(workspace, /preferredCatalogScope/);
  assert.match(workspace, /catalog-select-scroll/);
  assert.match(workspace, /catalog-scroll/);
  assert.match(catalogView, /Number\(enabled\.has\(nameB\)\) - Number\(enabled\.has\(nameA\)\)/);
  assert.match(styles, /scrollbar-gutter: stable/);
  assert.match(workspace, /@\/components\/ui\/dialog/);
  assert.match(workspaceTabs, /grid w-full items-stretch gap-1/);
  assert.match(workspaceTabs, /visible\.length === 1 \? "grid-cols-1 sm:max-w-72" : "grid-cols-2 sm:grid-cols-5"/);
  assert.match(workspaceTabs, /className="h-10 min-w-0 justify-center/);
  assert.match(workspaceTabs, /providers: "Providers"/);
  assert.match(workspaceTabs, /presets: "Presets"/);
  assert.match(workspace, /<AgentWorkspace/);
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
  assert.match(storeClient, /snapshot\.schema !== 3/);
  assert.match(storeClient, /isObject\(snapshot\.presets\)/);
  assert.match(storeClient, /newer Workspace version exists/);
});

test("Provider Workspace keeps portable catalogs encrypted and Secret values masked", () => {
  assert.match(storeClient, /WORKSPACE_VIEW_ORDER = \["providers", \.\.\.SECTION_ORDER, "presets"\]/);
  assert.match(storeClient, /validateAgentBundle\(snapshot\.agent\)/);
  assert.match(storeClient, /\[1, 2\]\.includes\(snapshot\.schema\)/);
  assert.match(storeClient, /upgraded\.schema = 3/);
  assert.match(storeClient, /newer Workspace version exists/);
  assert.match(storeClient, /providerStore\?\.schema === 1/);
  assert.match(storeClient, /profile\.compaction = legacyProviderCompaction\(profile\)/);
  assert.match(storeClient, /profile\.context === undefined/);
  assert.match(storeClient, /validateProviderContext\(profile\.context/);
  assert.match(storeClient, /"responses_v2", "responses_v1", "anthropic_messages_beta", "none"/);
  assert.match(agentWorkspace, /schema: 2,[\s\S]*?kind: "agentctl-provider-store"/);
  assert.match(agentWorkspace, /saveEncryptedWorkspace/);
  assert.match(agentWorkspace, /state\.workspaceVersion/);
  assert.match(agentWorkspace, /type="password"/);
  assert.match(agentWorkspace, /Provider Secrets/);
  assert.match(agentWorkspace, /Generated client files and proxy runtime state are never part/);
  assert.match(agentWorkspace, /agentctl workspace agent pull --replace --yes/);
  assert.doesNotMatch(agentWorkspace, /formatted\(bundle\?\.secrets/);
});

test("Prompt Store exposes an accessible reusable snippet library", () => {
  assert.match(workspace, /@\/components\/snippet-workspace/);
  assert.match(workspace, /aria-label="Prompt Store content"/);
  assert.match(workspace, /TabsTrigger value="profiles">[\s\S]*?Profiles/);
  assert.match(workspace, /TabsTrigger value="snippets">[\s\S]*?Snippets/);
  assert.match(workspace, /profiles and snippets/);

  for (const component of [
    "@/components/ui/alert-dialog",
    "@/components/ui/card",
    "@/components/ui/dialog",
    "@/components/ui/input",
    "@/components/ui/textarea",
  ]) {
    assert.match(snippetWorkspace, new RegExp(component.replaceAll("/", "\\/")));
  }
  assert.match(snippetWorkspace, /navigator\.clipboard\?\.writeText/);
  assert.match(snippetWorkspace, /Search snippets/);
  assert.match(snippetWorkspace, /No snippets yet/);
  assert.match(snippetWorkspace, /No matching snippets/);
  assert.match(snippetWorkspace, /That snippet already exists/);
  assert.match(snippetWorkspace, /aria-invalid=/);
  assert.match(snippetWorkspace, /1 MB/);
  assert.match(snippetWorkspace, /promptctl restore/);
  assert.match(storeClient, /snapshot\.snippets/);
  assert.match(storeClient, /snippet\.sha256 = await sha256Hex\(snippet\.content\)/);
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
