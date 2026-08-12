import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createController,
  createProcessRunner,
  defaultAgentRoot
} from "../src/controller.mjs";

test("real controller entrypoints stay inside an isolated cross-platform home", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolbox-tui-process-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const state = join(root, "state");
  const data = join(root, "data");
  try {
    await Promise.all([home, config, state, data].map((path) => mkdir(path, { recursive: true })));
    const environment = {
      ...process.env,
      HOME: process.platform === "win32" ? home.replaceAll("\\", "/") : home,
      ...(process.platform === "win32"
        ? {
            USERPROFILE: home,
            APPDATA: config,
            LOCALAPPDATA: data
          }
        : {
            XDG_CONFIG_HOME: config,
            XDG_STATE_HOME: state,
            XDG_DATA_HOME: data
          }),
      AGENTCTL_WORKSPACE_CONFIG: join(config, "agentctl", "workspace-remote.json"),
      NO_COLOR: "1"
    };
    const runner = createProcessRunner({ cwd: defaultAgentRoot, environment });
    const controller = createController({
      agentRoot: defaultAgentRoot,
      runner,
      remoteWorkspace: {
        connection: async () => ({ configured: false })
      }
    });
    const snapshot = await controller.localSnapshot();
    assert.equal(snapshot.phase, "local");
    assert.equal(snapshot.workspaceLoading, false);
    assert.equal(snapshot.workspaceConnection.configured, false);
    assert.equal(Array.isArray(snapshot.agents), true);
    assert.equal(snapshot.agentsError, "");
    assert.equal(typeof snapshot.doctor, "object");
    assert.equal(typeof snapshot.accounts, "object");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
