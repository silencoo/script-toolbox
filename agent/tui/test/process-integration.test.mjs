import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bashScriptCommand } from "../../platform-command.mjs";

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
    assert.equal(snapshot.bootstrap.ok, true, snapshot.bootstrap.detail);
    await Promise.all([
      access(join(config, "agentctl", "providers.json")),
      access(join(config, "agentctl", "provider-secrets.json")),
      access(join(config, "agentctl", "failover.json")),
      access(join(config, "agentctl", "pricing.json")),
      access(join(config, "mcpctl", "store", "catalog.json")),
      access(join(config, "skillsctl", "store", "catalog.json"))
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Git Bash-style controller turns Skills checksum drift into an accept-and-retry action", async () => {
  const root = await mkdtemp(join(tmpdir(), "toolbox-tui-drift-"));
  const home = join(root, "home");
  const config = join(root, "config");
  const data = join(root, "data");
  const store = join(config, "skillsctl", "store");
  const source = join(root, "source", "cloudflare");
  const skillFile = join(source, "SKILL.md");
  const skillsScript = join(defaultAgentRoot, "skillsctl", "skillsctl");
  try {
    await Promise.all([home, config, data, source].map((path) =>
      mkdir(path, { recursive: true })
    ));
    await writeFile(
      skillFile,
      "---\nname: cloudflare\ndescription: Cloudflare test Skill\n---\n\n# Cloudflare\n"
    );
    const environment = {
      ...process.env,
      HOME: process.platform === "win32" ? home.replaceAll("\\", "/") : home,
      ...(process.platform === "win32"
        ? { USERPROFILE: home, APPDATA: config, LOCALAPPDATA: data }
        : { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }),
      SKILLSCTL_STORE: store,
      SKILLSCTL_CODEX_DIR: join(root, "targets", "codex"),
      NO_COLOR: "1"
    };
    const runner = createProcessRunner({ cwd: defaultAgentRoot, environment });
    const runSkill = async (args) => {
      const command = bashScriptCommand(skillsScript, args, { platform: "win32" });
      return runner(command.executable, command.args);
    };
    assert.equal((await runSkill(["init", "--yes"])).code, 0);
    assert.equal((await runSkill(["skill", "add", source, "--yes"])).code, 0);
    await writeFile(
      join(store, "skills", "cloudflare", "SKILL.md"),
      "---\nname: cloudflare\ndescription: Updated Cloudflare test Skill\n---\n\n# Updated\n"
    );

    const controller = createController({
      agentRoot: defaultAgentRoot,
      runner,
      platform: "win32",
      remoteWorkspace: { connection: async () => ({ configured: false }) }
    });
    const blocked = await controller.action("skills-disable", {
      selection: "cloudflare",
      target: "codex"
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data.skillDriftRepairRequired, true);
    assert.equal(blocked.data.skillDriftName, "cloudflare");
    assert.equal(blocked.data.skillDriftScope, "local");

    const retried = await controller.action("skills-disable", {
      selection: "cloudflare",
      target: "codex",
      acceptSkillDrift: { name: "cloudflare", scope: "local" }
    });
    assert.equal(retried.ok, true, retried.detail);
    assert.equal((await runSkill(["status"])).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
