import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  uploadRemoteSnapshot,
  writeJsonAtomic
} from "../remote-store.mjs";
import {
  attach,
  agentPull,
  agentPush,
  agentStatus,
  init,
  loadWorkspace,
  migrate,
  readHiddenRecoveryCode,
  restore,
  saveWorkspace,
  ui,
  validateWorkspace
} from "./workspace-client.mjs";
import {
  newProviderSecrets,
  newProviderStore,
  validateProviderSecrets,
  validateProviderStore
} from "./provider-schema.mjs";
import { newFailoverStore, validateFailoverStore } from "./failover-schema.mjs";
import { newPricingCatalog, validatePricingCatalog } from "../pricing/pricing.mjs";
import worker from "../../workers/toolbox-store/worker.js";
import { MemoryR2Bucket } from "../../workers/toolbox-store/test-memory-r2.mjs";

function providerProfile(name, secret) {
  return {
    schema: 1,
    name,
    description: `${name} test provider`,
    protocol: "openai_responses",
    endpoint: `https://${name}.example.com/v1`,
    auth: { mode: "bearer", secret },
    models: { default: "daily", aliases: { daily: `${name}-vendor` } },
    targets: {},
    platforms: {}
  };
}

function workspaceAgentOptions(root, workspaceConfig, prefix = "local") {
  return {
    workspaceConfig,
    providerStore: join(root, prefix, "providers.json"),
    providerSecrets: join(root, prefix, "provider-secrets.json"),
    failoverStore: join(root, prefix, "failover.json"),
    pricing: join(root, prefix, "pricing.json"),
    replace: false,
    yes: false,
    json: true,
    quiet: true
  };
}

test("one Workspace capability attaches and controls all isolated Stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-client-test-"));
  const environment = {
    TOOLBOX_STORE: new MemoryR2Bucket(),
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
    assert.equal(manifest.schema, 3);
    assert.deepEqual(Object.keys(manifest.stores).sort(), ["mcp", "prompts", "skills"]);
    assert.equal(manifest.stores.mcp.config.store_id, childConfigs.mcp.store_id);
    assert.equal(manifest.stores.mcp.schema, 2);
    assert.deepEqual(manifest.presets.dev, editableWorkspace.presets.dev);
    assert.equal(manifest.agent.providers, null);

    const storedBlobs = [...environment.TOOLBOX_STORE.records.values()]
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
    assert.equal(migratedSnapshot.schema, 3);
    assert.deepEqual(migratedSnapshot.presets, {});
    assert.equal(migratedSnapshot.agent.providers, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted Workspace agent sync restores catalogs and Secrets without runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-agent-sync-"));
  const environment = {
    TOOLBOX_STORE: new MemoryR2Bucket(),
    CREATE_TOKEN: "workspace-agent-create-token".padEnd(48, "A"),
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
  const source = workspaceAgentOptions(root, workspaceConfig, "source");
  const fresh = workspaceAgentOptions(root, workspaceConfig, "fresh");
  const secretMarker = "WORKSPACE-PROVIDER-SECRET-MUST-STAY-ENCRYPTED";
  await writeFile(createTokenFile, `${environment.CREATE_TOKEN}\n`, { mode: 0o600 });
  await chmod(createTokenFile, 0o600);

  try {
    await init({
      endpoint,
      workspaceConfig,
      createTokenFile,
      force: false,
      quiet: true
    });

    const now = new Date().toISOString();
    const providers = newProviderStore(now);
    providers.profiles.primary = providerProfile("primary", "primary_key");
    providers.profiles.backup = providerProfile("backup", "backup_key");
    validateProviderStore(providers);
    const secrets = newProviderSecrets(now);
    secrets.secrets.primary_key = { value: secretMarker, updated_at: now };
    secrets.secrets.backup_key = { value: "BACKUP-SECRET", updated_at: now };
    validateProviderSecrets(secrets);
    const failover = newFailoverStore(now);
    failover.routes.resilient = {
      schema: 1,
      name: "resilient",
      description: "encrypted route",
      profiles: ["primary", "backup"],
      retry: {
        mode: "next_request",
        max_attempts: 2,
        status_codes: [429, 503],
        network_errors: true
      },
      circuit: {
        failure_threshold: 3,
        recovery_timeout_ms: 30000,
        half_open_max_requests: 1,
        state_retention_days: 30
      }
    };
    validateFailoverStore(failover);
    const pricing = newPricingCatalog({
      version: "workspace-test",
      effectiveAt: now
    });
    validatePricingCatalog(pricing);
    for (const [path, value] of [
      [source.providerStore, providers],
      [source.providerSecrets, secrets],
      [source.failoverStore, failover],
      [source.pricing, pricing]
    ]) await writeJsonAtomic(path, value);

    const preview = await agentPush(source);
    assert.equal(preview.preview, true);
    assert.equal((await loadWorkspace(workspaceConfig)).agent.providers, null);
    const pushed = await agentPush({ ...source, yes: true });
    assert.equal(pushed.bundle.profiles, 2);
    assert.equal(pushed.bundle.secrets, 2);

    const remote = await loadWorkspace(workspaceConfig);
    assert.equal(remote.schema, 3);
    assert.equal(remote.agent.secrets.secrets.primary_key.value, secretMarker);
    assert.equal(remote.agent.failover.routes.resilient.retry.mode, "next_request");
    assert.equal(remote.agent.pricing.version, "workspace-test");

    const ciphertext = [...environment.TOOLBOX_STORE.records.values()]
      .map((record) => new TextDecoder().decode(record.bytes))
      .join("\n");
    assert.equal(ciphertext.includes(secretMarker), false);
    assert.equal(ciphertext.includes("BACKUP-SECRET"), false);

    const pullPreview = await agentPull(fresh);
    assert.equal(pullPreview.preview, true);
    await assert.rejects(() => lstat(fresh.providerStore), { code: "ENOENT" });
    const pulled = await agentPull({ ...fresh, yes: true });
    assert.deepEqual(pulled.writes.sort(), ["failover", "pricing", "providers", "secrets"]);
    assert.equal(
      JSON.parse(await readFile(fresh.providerSecrets, "utf8"))
        .secrets.primary_key.value,
      secretMarker
    );
    assert.equal((await lstat(fresh.providerSecrets)).mode & 0o077, 0);
    await assert.rejects(
      () => lstat(join(root, "fresh", "generated-proxy-config.json")),
      { code: "ENOENT" }
    );

    const status = await agentStatus(fresh);
    assert.equal(status.remote.secret_values, "hidden");
    assert.equal(status.local.secrets, 2);
    assert.equal(JSON.stringify(status).includes(secretMarker), false);

    const conflicting = JSON.parse(await readFile(fresh.providerSecrets, "utf8"));
    conflicting.secrets.primary_key.value = "DIFFERENT-LOCAL-SECRET";
    conflicting.secrets.primary_key.updated_at = new Date(Date.now() + 1000).toISOString();
    await writeJsonAtomic(fresh.providerSecrets, conflicting);
    await assert.rejects(() => agentPull(fresh), /Secret 'primary_key' conflicts/);
    const replacePreview = await agentPull({ ...fresh, replace: true });
    assert.equal(replacePreview.preview, true);
    assert.equal(
      JSON.parse(await readFile(fresh.providerSecrets, "utf8"))
        .secrets.primary_key.value,
      "DIFFERENT-LOCAL-SECRET"
    );
    await agentPull({ ...fresh, replace: true, yes: true });
    assert.equal(
      JSON.parse(await readFile(fresh.providerSecrets, "utf8"))
        .secrets.primary_key.value,
      secretMarker
    );

    const firstWriter = await loadWorkspace(workspaceConfig);
    const staleWriter = await loadWorkspace(workspaceConfig);
    firstWriter.name = "First concurrent writer";
    await saveWorkspace(workspaceConfig, firstWriter);
    staleWriter.name = "Stale concurrent writer";
    await assert.rejects(
      () => saveWorkspace(workspaceConfig, staleWriter),
      /version_conflict|base version/i
    );

    const withoutOptional = await loadWorkspace(workspaceConfig);
    withoutOptional.agent.failover = null;
    withoutOptional.agent.pricing = null;
    await saveWorkspace(workspaceConfig, withoutOptional);
    const deletePreview = await agentPull({ ...fresh, replace: true });
    assert.deepEqual(deletePreview.deletes.sort(), ["failover", "pricing"]);
    assert.equal(Boolean(await lstat(fresh.failoverStore)), true);
    await agentPull({ ...fresh, replace: true, yes: true });
    await assert.rejects(() => lstat(fresh.failoverStore), { code: "ENOENT" });
    await assert.rejects(() => lstat(fresh.pricing), { code: "ENOENT" });
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

test("Workspace schemas 1 and 2 upgrade in memory without mutating snapshots", () => {
  const legacy = {
    schema: 1,
    kind: "agentctl-workspace",
    name: "Old workspace",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stores: {}
  };
  const workspace = validateWorkspace(legacy);
  assert.equal(workspace.schema, 3);
  assert.deepEqual(workspace.presets, {});
  assert.equal(workspace.agent.providers, null);
  assert.equal(legacy.schema, 1);
  assert.equal(legacy.presets, undefined);

  const previous = {
    schema: 2,
    kind: "agentctl-workspace",
    name: "Previous workspace",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stores: {},
    presets: {}
  };
  const upgraded = validateWorkspace(previous);
  assert.equal(upgraded.schema, 3);
  assert.equal(upgraded.agent.schema, 1);
  assert.equal(previous.agent, undefined);
});
