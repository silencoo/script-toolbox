import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
  downloadRemoteSnapshot,
  getRemoteStatus,
  getRemoteWebUiSetting,
  initializeRemoteStore,
  makeRecoveryCode,
  readRemoteConfig,
  uploadRemoteSnapshot
} from "../remote-store.mjs";
import {
  attach,
  init,
  loadWorkspace,
  migrate,
  readHiddenRecoveryCode,
  restore,
  saveWorkspace,
  ui,
  validateWorkspace
} from "./workspace-client.mjs";
import worker from "../../workers/mcp-store/worker.js";
import { MemoryR2Bucket } from "../../workers/mcp-store/test-memory-r2.mjs";

test("one Workspace capability attaches and controls all isolated Stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-client-test-"));
  const environment = {
    MCP_STORE: new MemoryR2Bucket(),
    CREATE_TOKEN: "workspace-test-create-token".padEnd(48, "C"),
    MAX_BLOB_BYTES: "5242880"
  };
  const endpoint = "https://store.example";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const request = input instanceof Request ? input : new Request(input, options);
    return worker.fetch(request, environment);
  };
  const workspaceConfig = join(root, "workspace.json");
  const createTokenFile = join(root, "create-token");
  await writeFile(createTokenFile, `${environment.CREATE_TOKEN}\n`, { mode: 0o600 });
  await chmod(createTokenFile, 0o600);

  const snapshots = {
    mcp: {
      schema: 1,
      created_at: new Date().toISOString(),
      catalog: { schema: 1, servers: {} },
      profiles: { base: { schema: 1, name: "base", enable: [], disable: [] } },
      secrets: {}
    },
    skills: {
      schema: 1,
      kind: "skillsctl-store",
      created_at: new Date().toISOString(),
      catalog: { schema: 1, skills: {} },
      skills: {},
      packs: {}
    },
    prompts: {
      schema: 1,
      kind: "promptctl-store",
      created_at: new Date().toISOString(),
      profiles: {}
    }
  };
  const protocols = {
    mcp: MCP_REMOTE_PROTOCOL,
    skills: SKILLS_REMOTE_PROTOCOL,
    prompts: PROMPT_REMOTE_PROTOCOL
  };
  const childConfigs = {};

  try {
    for (const type of Object.keys(protocols)) {
      const path = join(root, `${type}.json`);
      childConfigs[type] = await initializeRemoteStore({
        protocol: protocols[type],
        endpoint,
        remoteConfig: path,
        createToken: environment.CREATE_TOKEN,
        force: false
      });
      await uploadRemoteSnapshot(path, protocols[type], snapshots[type]);
    }

    const workspace = await init({
      endpoint,
      workspaceConfig,
      createTokenFile,
      force: false,
      quiet: true
    });
    const recovery = makeRecoveryCode(workspace, WORKSPACE_REMOTE_PROTOCOL);
    assert.match(recovery, /^toolbox1_/);

    const restoredConfig = join(root, "restored-workspace.json");
    await restore({ workspaceConfig: restoredConfig, recoveryFile: "", force: false }, {
      readRecoveryCode: async () => recovery
    });
    assert.deepEqual(await readRemoteConfig(restoredConfig), workspace);

    for (const type of Object.keys(protocols)) {
      await attach(type, {
        workspaceConfig,
        remoteConfig: join(root, `${type}.json`),
        childConfig: {}
      });
    }

    const editableWorkspace = await loadWorkspace(workspaceConfig);
    editableWorkspace.presets.dev = {
      schema: 2,
      name: "dev",
      description: "Test development preset",
      mcp: "base",
      skills: "off",
      prompt: "work"
    };
    await saveWorkspace(workspaceConfig, editableWorkspace);

    const workspaceStatus = await getRemoteStatus(
      workspaceConfig,
      WORKSPACE_REMOTE_PROTOCOL
    );
    assert.equal(workspaceStatus.web_ui_enabled, true);

    const manifest = await downloadRemoteSnapshot(
      workspaceConfig,
      WORKSPACE_REMOTE_PROTOCOL
    );
    assert.equal(manifest.schema, 2);
    assert.deepEqual(Object.keys(manifest.stores).sort(), ["mcp", "prompts", "skills"]);
    assert.equal(manifest.stores.mcp.config.store_id, childConfigs.mcp.store_id);
    assert.equal(manifest.stores.mcp.schema, 2);
    assert.deepEqual(manifest.presets.dev, editableWorkspace.presets.dev);

    const storedBlobs = [...environment.MCP_STORE.records.values()]
      .filter((record) => record.httpMetadata?.contentType ===
        WORKSPACE_REMOTE_PROTOCOL.contentType)
      .map((record) => new TextDecoder().decode(record.bytes));
    assert.ok(storedBlobs.length > 0);
    for (const blob of storedBlobs) {
      for (const child of Object.values(childConfigs)) {
        assert.equal(blob.includes(child.root_key), false);
      }
      assert.equal(blob.includes("Test development preset"), false);
    }

    await ui("disable", { workspaceConfig });
    assert.equal(
      (await getRemoteWebUiSetting(workspaceConfig, WORKSPACE_REMOTE_PROTOCOL))
        .web_ui_enabled,
      false
    );
    for (const type of Object.keys(protocols)) {
      assert.equal(
        (await getRemoteWebUiSetting(childConfigs[type], protocols[type]))
          .web_ui_enabled,
        false
      );
    }

    await ui("enable", { workspaceConfig });
    for (const type of Object.keys(protocols)) {
      assert.deepEqual(
        await downloadRemoteSnapshot(childConfigs[type], protocols[type]),
        snapshots[type]
      );
    }

    assert.equal(
      makeRecoveryCode(
        await readRemoteConfig(workspaceConfig),
        WORKSPACE_REMOTE_PROTOCOL
      ),
      recovery
    );

    const legacy = structuredClone(await loadWorkspace(workspaceConfig));
    legacy.schema = 1;
    delete legacy.presets;
    for (const attachment of Object.values(legacy.stores)) attachment.schema = 1;
    await uploadRemoteSnapshot(workspaceConfig, WORKSPACE_REMOTE_PROTOCOL, legacy);
    const preview = await migrate({ workspaceConfig, yes: false, json: false });
    assert.equal(preview.preview, true);
    assert.equal((await downloadRemoteSnapshot(
      workspaceConfig, WORKSPACE_REMOTE_PROTOCOL
    )).schema, 1);
    const migrated = await migrate({ workspaceConfig, yes: true, json: false });
    assert.equal(migrated.changed, true);
    const migratedSnapshot = await downloadRemoteSnapshot(
      workspaceConfig, WORKSPACE_REMOTE_PROTOCOL
    );
    assert.equal(migratedSnapshot.schema, 2);
    assert.deepEqual(migratedSnapshot.presets, {});
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("interactive Workspace recovery input is hidden and restores terminal state", async () => {
  class TestInput extends EventEmitter {
    constructor() {
      super();
      this.isTTY = true;
      this.isRaw = false;
      this.readableFlowing = false;
      this.rawModes = [];
    }
    setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
    resume() { this.readableFlowing = true; }
    pause() { this.readableFlowing = false; }
  }
  const input = new TestInput();
  const writes = [];
  const output = { isTTY: true, write: (value) => { writes.push(value); } };
  const reading = readHiddenRecoveryCode({ input, output });
  input.emit("data", Buffer.from("toolbox1_secret\u007fX\r"));
  assert.equal(await reading, "toolbox1_secreX");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(writes.join("").includes("toolbox1_"), false);
  assert.match(writes.join(""), /input hidden/);

  assert.throws(
    () => readHiddenRecoveryCode({ input: { isTTY: false }, output }),
    /use --recovery-file/
  );
});

test("Workspace schema 1 is upgraded in memory without mutating its snapshot", () => {
  const legacy = {
    schema: 1,
    kind: "agentctl-workspace",
    name: "Old workspace",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stores: {}
  };
  const workspace = validateWorkspace(legacy);
  assert.equal(workspace.schema, 2);
  assert.deepEqual(workspace.presets, {});
  assert.equal(legacy.schema, 1);
  assert.equal(legacy.presets, undefined);
});
