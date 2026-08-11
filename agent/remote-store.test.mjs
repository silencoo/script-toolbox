import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MCP_REMOTE_PROTOCOL,
  PROMPT_REMOTE_PROTOCOL,
  SKILLS_REMOTE_PROTOCOL,
  WORKSPACE_REMOTE_PROTOCOL,
  downloadRemoteSnapshot,
  getRemoteStatus,
  getRemoteWebUiSetting,
  initializeRemoteStore,
  listRemoteVersions,
  makeRecoveryCode,
  parseRecoveryCode,
  setRemoteWebUiEnabled,
  uploadRemoteSnapshot
} from "./remote-store.mjs";
import worker from "../workers/toolbox-store/worker.js";
import { MemoryR2Bucket } from "../workers/toolbox-store/test-memory-r2.mjs";

const root = await mkdtemp(join(tmpdir(), "remote-store-test-"));
const environment = {
  TOOLBOX_STORE: new MemoryR2Bucket(),
  CREATE_TOKEN: "shared-create-token".padEnd(48, "C"),
  MAX_BLOB_BYTES: "5242880"
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const request = input instanceof Request ? input : new Request(input, options);
  return worker.fetch(request, environment);
};

try {
  for (const [name, protocol, snapshot] of [
    [
      "mcp",
      MCP_REMOTE_PROTOCOL,
      {
        schema: 1,
        created_at: new Date().toISOString(),
        catalog: { schema: 1, servers: {} },
        profiles: { base: { schema: 1, name: "base", enable: [], disable: [] } },
        secrets: {}
      }
    ],
    [
      "skills",
      SKILLS_REMOTE_PROTOCOL,
      {
        schema: 1,
        kind: "skillsctl-store",
        created_at: new Date().toISOString(),
        catalog: { schema: 1, skills: {} },
        skills: {},
        packs: {
          base: {
            schema: 1,
            name: "base",
            description: "Base",
            extends: [],
            enable: [],
            disable: [],
            target_overrides: {}
          }
        }
      }
    ],
    [
      "prompts",
      PROMPT_REMOTE_PROTOCOL,
      {
        schema: 1,
        kind: "promptctl-store",
        created_at: new Date().toISOString(),
        profiles: {}
      }
    ],
    [
      "workspace",
      WORKSPACE_REMOTE_PROTOCOL,
      {
        schema: 1,
        kind: "agentctl-workspace",
        name: "Personal agent workspace",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stores: {}
      }
    ]
  ]) {
    const remoteConfig = join(root, `${name}.json`);
    const config = await initializeRemoteStore({
      protocol,
      endpoint: "https://store.example",
      remoteConfig,
      createToken: environment.CREATE_TOKEN,
      force: false
    });
    const recovery = makeRecoveryCode(config, protocol);
    assert.ok(recovery.startsWith(protocol.recoveryPrefix));
    assert.deepEqual(parseRecoveryCode(recovery, protocol), config);
    assert.equal((await getRemoteStatus(remoteConfig, protocol)).latest, null);
    assert.equal(
      (await getRemoteWebUiSetting(remoteConfig, protocol)).web_ui_enabled,
      false
    );
    assert.equal(
      (await setRemoteWebUiEnabled(remoteConfig, protocol, true)).web_ui_enabled,
      true
    );
    assert.equal(
      (await getRemoteWebUiSetting(remoteConfig, protocol)).web_ui_enabled,
      true
    );

    const uploaded = await uploadRemoteSnapshot(remoteConfig, protocol, snapshot);
    assert.match(uploaded.version, /^[0-9]{13}-[a-f0-9-]{36}$/);
    assert.deepEqual(await downloadRemoteSnapshot(remoteConfig, protocol), snapshot);
    const versions = await listRemoteVersions(remoteConfig, protocol);
    assert.equal(versions.versions.length, 1);
    assert.equal(versions.versions[0].version, uploaded.version);
  }
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("ok  : shared encrypted remote protocol supports all Toolbox stores\n");
