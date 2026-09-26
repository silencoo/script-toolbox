import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";
import { build } from "esbuild";
import React from "react";
import { render } from "ink";

let App;
let buildDirectory;
before(async () => {
  // Keep external React/Ink imports in the same dependency tree as the renderer.
  buildDirectory = await mkdtemp(fileURLToPath(new URL(".render-test-", import.meta.url)));
  const output = join(buildDirectory, "app.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/toolbox-tui.jsx", import.meta.url))],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external"
  });
  ({ App } = await import(pathToFileURL(output).href));
});
after(async () => {
  if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
});

async function waitFor(predicate, describe) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out: ${describe}`);
}

function mount(t, controller, columns = 120) {
  let frame = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (text.includes("script-toolbox / agents")) frame = text;
      callback();
    }
  });
  stdout.columns = columns;
  stdout.rows = 40;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const previousColumns = process.stdout.columns;
  process.stdout.columns = columns;
  const instance = render(React.createElement(App, { initialSection: "agents", controller }), {
    stdout, stdin, stderr: stdout, debug: true, patchConsole: false
  });
  t.after(() => {
    instance.unmount();
    stdin.destroy();
    stdout.destroy();
    process.stdout.columns = previousColumns;
  });
  return {
    frame: () => frame,
    key: (value) => stdin.write(value),
    wait: (predicate, describe) => waitFor(() => predicate(frame), describe)
  };
}

function installController(client, label, outcome) {
  let installed = false;
  let refreshes = 0;
  const hydrations = [];
  return {
    hydrations,
    refreshes: () => refreshes,
    localSnapshot: async () => {
      refreshes += 1;
      return {
        phase: "local", updatedAt: new Date().toISOString(), workspaceLoading: true,
        agents: [{ client, label, cli_installed: installed, cli_version: installed ? "1.2.3" : "" }]
      };
    },
    hydrateSnapshot: (snapshot) => new Promise((resolve) => {
      hydrations.push(() => resolve({ ...snapshot, workspaceLoading: false, workspaceError: "remote configuration not found" }));
    }),
    action: async (action, payload) => {
      assert.equal(action, "agent-install");
      assert.equal(payload.agent, client);
      const result = await outcome();
      installed = result.ok;
      return result;
    }
  };
}

for (const [client, label] of [["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["pi", "Pi"]]) {
  test(`${label} completion remains visible after hydration, automatic and manual refresh`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const controller = installController(client, label, async () => ({
      ok: true,
      detail: [`Install ${label} CLI`, ...Array.from({ length: 15 }, (_, i) => `Downloading ${i}`), `OK ${label} ready: 1.2.3`, "Next: configure a Provider later."].join("\n")
    }));
    const ui = mount(t, controller, client === "pi" ? 80 : 120);
    await ui.wait((frame) => frame.includes("Not installed"), "initial status");
    ui.key("i");
    await ui.wait((frame) => frame.includes("[y/N]"), "installation confirmation");
    ui.key("y");
    const title = `Installed: ${label} CLI`;
    await ui.wait((frame) => frame.includes(title) && /CLI\s+Installed · 1.2.3/.test(frame), "verified installation status");
    assert.match(ui.frame(), /earlier log lines omitted/);
    assert.ok(ui.frame().includes(`OK ${label} ready: 1.2.3`));
    assert.ok(ui.frame().includes("Next: configure a Provider later."));

    controller.hydrations.forEach((resolve) => resolve());
    await delay(30);
    assert.equal(ui.frame().split(title).length - 1, 2, "hydration must preserve result panel and footer");
    const beforeRefresh = controller.refreshes();
    t.mock.timers.tick(30_000);
    await waitFor(() => controller.refreshes() > beforeRefresh, "automatic refresh");
    controller.hydrations.at(-1)();
    await delay(30);
    assert.equal(ui.frame().split(title).length - 1, 2, "periodic refresh must preserve result panel and footer");

    ui.key("r");
    await waitFor(() => controller.refreshes() > beforeRefresh + 1, "manual refresh");
    controller.hydrations.at(-1)();
    await ui.wait((frame) => frame.includes("Local only"), "manual refresh status");
    assert.ok(ui.frame().includes(title), "manual refresh must retain the result panel");
  });
}

test("failed installation keeps the final error visible after refresh", async (t) => {
  const controller = installController("claude", "Claude Code", async () => ({
    ok: false,
    detail: ["Starting installer", ...Array.from({ length: 12 }, (_, i) => `Downloading ${i}`), "ERROR version check failed"].join("\n")
  }));
  const ui = mount(t, controller);
  await ui.wait((frame) => frame.includes("Not installed"), "initial status");
  ui.key("i");
  await ui.wait((frame) => frame.includes("[y/N]"), "installation confirmation");
  ui.key("y");
  await ui.wait((frame) => frame.includes("Failed: Install Claude Code CLI"), "failure result");
  controller.hydrations.forEach((resolve) => resolve());
  await delay(30);
  assert.match(ui.frame(), /ERROR version check failed/);
  assert.match(ui.frame(), /CLI\s+Not installed/);
  assert.doesNotMatch(ui.frame(), /Installed: Claude Code CLI/);
});

test("thrown installer errors render an explicit failure panel", async (t) => {
  const controller = installController("pi", "Pi", async () => { throw new Error("Installer timed out"); });
  const ui = mount(t, controller);
  await ui.wait((frame) => frame.includes("Not installed"), "initial status");
  ui.key("i");
  await ui.wait((frame) => frame.includes("[y/N]"), "installation confirmation");
  ui.key("y");
  await ui.wait((frame) => frame.includes("Failed: Install Pi CLI"), "failure panel");
  assert.match(ui.frame(), /Installer timed out/);
});
