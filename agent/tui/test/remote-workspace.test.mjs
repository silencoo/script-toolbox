import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { decryptValue } from "../../remote-store.mjs";
import {
  createRemoteWorkspace,
  materializedSkillDigest,
  mcpSelection,
  skillSelection,
  validateWorkspaceSnapshot
} from "../src/remote-workspace.mjs";

test("Windows materialized Skill digests normalize shebang files to executable mode", () => {
  const files = {
    "SKILL.md": {
      encoding: "base64",
      content: Buffer.from("---\nname: portable\ndescription: Portable\n---\n").toString("base64"),
      mode: 0o600
    },
    "scripts/check.py": {
      encoding: "base64",
      content: Buffer.from("#!/usr/bin/env python3\n").toString("base64"),
      mode: 0o600
    }
  };
  assert.notEqual(
    materializedSkillDigest(files, "win32"),
    materializedSkillDigest(files, "darwin")
  );
  const executableFiles = structuredClone(files);
  executableFiles["scripts/check.py"].mode = 0o700;
  assert.equal(
    materializedSkillDigest(files, "win32"),
    materializedSkillDigest(executableFiles, "darwin")
  );
});

const secretValue = "never-render-this-secret";
const childConfigs = Object.fromEntries(["mcp", "skills", "prompts"].map((type, index) => [
  type,
  {
    schema: 1,
    endpoint: "https://workspace.example.test",
    store_id: String(index + 1).repeat(32),
    root_key: randomBytes(32).toString("base64url")
  }
]));
const masterConfig = {
  schema: 1,
  endpoint: "https://workspace.example.test",
  store_id: "a".repeat(32),
  root_key: randomBytes(32).toString("base64url")
};

const skillContent = "---\nname: cloud-skill\ndescription: Cloud skill\n---\n# Cloud Skill\n";
const snippetContent = "Review the selected files and list concrete risks.\n";
const skillFiles = {
  "references/api/api.md": { encoding: "base64", content: Buffer.from("API\n").toString("base64"), mode: 0o600 },
  "references/api-shield/api.md": { encoding: "base64", content: Buffer.from("Shield\n").toString("base64"), mode: 0o600 },
  "SKILL.md": { encoding: "base64", content: Buffer.from(skillContent).toString("base64"), mode: 0o600 }
};
const skillHasher = createHash("sha256");
for (const [path, file] of Object.entries(skillFiles)) {
  skillHasher.update(path);
  skillHasher.update("\0");
  skillHasher.update(String(file.mode));
  skillHasher.update("\0");
  skillHasher.update(Buffer.from(file.content, "base64"));
  skillHasher.update("\0");
}
const skillHash = skillHasher.digest("hex");
const snapshots = {
  mcp: {
    schema: 1,
    created_at: new Date().toISOString(),
    catalog: {
      schema: 1,
      servers: {
        github: { command: "npx", args: ["github-mcp"], env: { GITHUB_TOKEN: { secret: "github-token" } } },
        browser: { command: "npx", args: ["browser-mcp"] }
      }
    },
    profiles: {
      base: { schema: 1, name: "base", description: "Base", extends: [], enable: ["github"], disable: [], target_overrides: {} },
      frontend: { schema: 1, name: "frontend", description: "Frontend", extends: ["base"], enable: ["browser"], disable: [], target_overrides: { claude: { disable: ["github"] } } }
    },
    secrets: { "github-token": secretValue, unused: "do-not-cache" }
  },
  skills: {
    schema: 1,
    kind: "skillsctl-store",
    created_at: new Date().toISOString(),
    catalog: {
      schema: 1,
      skills: {
        "cloud-skill": { description: "Cloud skill", sha256: skillHash }
      }
    },
    skills: {
      "cloud-skill": {
        metadata: { description: "Cloud skill", sha256: skillHash },
        files: skillFiles
      }
    },
    packs: {
      base: { schema: 1, name: "base", description: "Base", extends: [], enable: ["cloud-skill"], disable: [], target_overrides: {} },
      frontend: { schema: 1, name: "frontend", description: "Frontend", extends: ["base"], enable: [], disable: [], target_overrides: { claude: { disable: ["cloud-skill"] } } }
    }
  },
  prompts: {
    schema: 1,
    kind: "promptctl-store",
    created_at: new Date().toISOString(),
    profiles: {
      personal: {
        schema: 1,
        name: "personal",
        description: "Personal defaults",
        documents: {
          codex: {
            schema: 1,
            client: "codex",
            content: "Use concise answers.\n",
            sha256: createHash("sha256").update("Use concise answers.\n").digest("hex")
          }
        }
      }
    },
    snippets: {
      "review-code": {
        schema: 1,
        name: "review-code",
        content: snippetContent,
        sha256: createHash("sha256").update(snippetContent).digest("hex")
      }
    }
  }
};

function workspaceSnapshot() {
  const now = new Date().toISOString();
  return {
    schema: 3,
    kind: "agentctl-workspace",
    name: "Test Workspace",
    created_at: now,
    updated_at: now,
    stores: Object.fromEntries(Object.entries(childConfigs).map(([type, config]) => [type, {
      schema: 2,
      type,
      protocol: type === "mcp" ? "mcpctl" : type === "skills" ? "skillsctl" : "promptctl",
      attached_at: now,
      config
    }])),
    presets: {
      web: { schema: 2, name: "web", description: "Web work", mcp: "frontend", skills: "frontend", prompt: "personal" }
    },
    agent: {
      schema: 1,
      synced_at: now,
      providers: {
        schema: 1,
        kind: "agentctl-provider-store",
        created_at: now,
        updated_at: now,
        profiles: {
          gateway: {
            schema: 1,
            name: "gateway",
            description: "Workspace gateway",
            protocol: "openai_responses",
            endpoint: "https://gateway.example.test/v1",
            auth: { mode: "bearer", secret: "gateway_key" },
            models: { default: "daily", aliases: { daily: "vendor-model" } },
            targets: {},
            platforms: {}
          }
        }
      },
      secrets: {
        schema: 1,
        kind: "agentctl-provider-secrets",
        updated_at: now,
        secrets: {
          gateway_key: { value: secretValue, updated_at: now }
        }
      },
      failover: null,
      pricing: null
    }
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-tui-remote-"));
  const downloads = [];
  const remote = createRemoteWorkspace({
    workspaceConfig: join(root, "workspace.json"),
    runtimeRoot: join(root, "runtime"),
    localHome: join(root, "home"),
    localConfigHome: join(root, "config"),
    loadWorkspaceFn: async () => workspaceSnapshot(),
    readConfigFn: async () => masterConfig,
    statusFn: async () => ({ latest: { version: "v1" }, web_ui_enabled: true }),
    childStatusFn: async (config) => ({ latest: { version: `v-${config.store_id[0]}` } }),
    downloadFn: async (config) => {
      const type = Object.entries(childConfigs).find(([, value]) => value.store_id === config.store_id)[0];
      downloads.push(type);
      return structuredClone(snapshots[type]);
    }
  });
  return { remote, root, downloads };
}

test("successful local child restore installs only that child capability", async () => {
  const { remote, root } = await fixture();
  const result = await remote.withLocalChildCapability("skills", async ({ remoteConfig }) => {
    const staged = JSON.parse(await readFile(remoteConfig, "utf8"));
    assert.equal(staged.store_id, childConfigs.skills.store_id);
    return { code: 0 };
  });
  assert.equal(result.code, 0);
  const installed = JSON.parse(await readFile(
    join(root, "config", "skillsctl", "remote.json"),
    "utf8"
  ));
  assert.equal(installed.store_id, childConfigs.skills.store_id);
  await assert.rejects(
    readFile(join(root, "config", "mcpctl", "remote.json"), "utf8"),
    { code: "ENOENT" }
  );
});

test("remote Workspace index and catalogs never expose capabilities or Secret values", async () => {
  assert.equal(validateWorkspaceSnapshot(workspaceSnapshot()).schema, 3);
  const previous = workspaceSnapshot();
  previous.schema = 2;
  delete previous.agent;
  assert.equal(validateWorkspaceSnapshot(previous).schema, 3);
  assert.equal(previous.schema, 2);
  const legacy = workspaceSnapshot();
  legacy.schema = 1;
  delete legacy.presets;
  delete legacy.agent;
  for (const attachment of Object.values(legacy.stores)) attachment.schema = 1;
  assert.equal(validateWorkspaceSnapshot(legacy).schema, 3);
  assert.equal(legacy.schema, 1);
  const { remote, downloads } = await fixture();
  const connection = await remote.connection();
  assert.equal(connection.endpoint, masterConfig.endpoint);
  assert.equal(JSON.stringify(connection).includes(masterConfig.root_key), false);
  const index = await remote.index();
  const serialized = JSON.stringify(index);
  assert.equal(serialized.includes(masterConfig.root_key), false);
  assert.equal(serialized.includes(secretValue), false);
  assert.deepEqual(downloads, []);
  assert.equal(index.presets.web.source, "cloud");
  assert.equal(index.stores.mcp.latest.version, "v-1");
  assert.equal(index.agent.profiles, 1);
  assert.equal(index.agent.secrets, 1);
  assert.equal(index.migration_pending, false);

  const providers = await remote.catalog("providers", "codex");
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, "gateway");
  assert.equal(providers[0].outbound_model, "vendor-model");
  assert.equal(providers[0].secret_present, true);
  assert.equal(providers[0].official_identity_policy, "preserve");
  assert.equal(providers[0].official_identity_account, "current");
  assert.equal(providers[0].compaction_upstream, "none");
  assert.equal(providers[0].compaction_mode, "client_local");
  assert.equal(providers[0].context_window_tokens, null);
  assert.equal(providers[0].auto_compact_tokens, null);
  assert.equal(providers[0].context_label, "Client default");
  assert.equal(JSON.stringify(providers).includes(secretValue), false);
  const claudeProviders = await remote.catalog("providers", "claude");
  assert.equal(claudeProviders[0].compatible, false);
  assert.equal(claudeProviders[0].ready, false);
  assert.deepEqual(downloads, []);

  const catalog = await remote.catalog("mcp", "codex");
  assert.deepEqual(downloads, ["mcp"]);
  assert.deepEqual(catalog.map(({ name, count }) => ({ name, count })), [
    { name: "base", count: 1 },
    { name: "frontend", count: 2 }
  ]);
  assert.equal(JSON.stringify(catalog).includes(secretValue), false);
  const skillCatalog = await remote.catalog("skills", "codex");
  assert.deepEqual(skillCatalog.find(({ name }) => name === "frontend"), {
    name: "frontend",
    description: "Frontend",
    count: 1,
    unit: "skills",
    source: "cloud",
    packs: ["base", "frontend"],
    items: ["cloud-skill"]
  });
  assert.deepEqual(await remote.catalog("prompts", "claude"), []);
  const snippets = await remote.catalog("snippets");
  assert.deepEqual(snippets.map(({ name }) => name), ["review-code"]);
  assert.equal(JSON.stringify(snippets).includes(snippetContent), false);
});

test("remote Provider actions use selected owner-only temporary files and clean them up", async () => {
  const { remote } = await fixture();
  await remote.index();
  let temporary;
  await remote.withProviderFiles("gateway", "codex", async ({ storePath, secretsPath }) => {
    temporary = dirname(storePath);
    const store = JSON.parse(await readFile(storePath, "utf8"));
    const secrets = JSON.parse(await readFile(secretsPath, "utf8"));
    assert.deepEqual(Object.keys(store.profiles), ["gateway"]);
    assert.equal(store.schema, 2);
    assert.deepEqual(store.profiles.gateway.compaction, {
      upstream: "none",
      policy: "auto"
    });
    assert.deepEqual(store.profiles.gateway.context, {
      window_tokens: null,
      auto_compact_tokens: null
    });
    assert.deepEqual(Object.keys(secrets.secrets), ["gateway_key"]);
    assert.equal(secrets.secrets.gateway_key.value, secretValue);
    assert.equal((await lstat(secretsPath)).mode & 0o077, 0);
  });
  await assert.rejects(() => lstat(temporary), { code: "ENOENT" });
});

test("profile and pack resolution honors inheritance and target overrides", () => {
  assert.deepEqual(mcpSelection(snapshots.mcp, "frontend", "codex").servers, ["browser", "github"]);
  assert.deepEqual(mcpSelection(snapshots.mcp, "frontend", "claude").servers, ["browser"]);
  assert.deepEqual(skillSelection(snapshots.skills, "frontend", "codex").skills, ["cloud-skill"]);
  assert.deepEqual(skillSelection(snapshots.skills, "frontend", "claude").skills, []);
});

test("Prompt catalogs hide bodies until an explicit document preview", async () => {
  const { remote } = await fixture();
  await remote.index();
  const catalog = await remote.catalog("prompts", "codex");
  assert.equal(JSON.stringify(catalog).includes("Use concise answers."), false);
  const document = await remote.promptDocument("personal", "codex");
  assert.deepEqual(document, {
    name: "personal",
    target: "codex",
    content: "Use concise answers.\n"
  });
  await assert.rejects(remote.promptDocument("personal", "opencode"), /unsupported Prompt target/);
});

test("plans stay read-only and apply materializes only selected dependencies", async () => {
  const { remote, root } = await fixture();
  await remote.index();
  const plan = await remote.selectionPlan("web", "codex");
  assert.equal(plan.prompt.action, "create");
  await assert.rejects(readFile(join(root, "home", ".codex", "instructions", "personal.md")));

  const selected = await remote.materializePreset("web", "codex");
  const catalog = JSON.parse(await readFile(join(selected.paths.mcp, "catalog.json"), "utf8"));
  assert.deepEqual(Object.keys(catalog.servers).sort(), ["browser", "github"]);
  const envelopeText = await readFile(join(selected.paths.mcp, "secrets.remote.enc"), "utf8");
  assert.equal(envelopeText.includes(secretValue), false);
  assert.equal(envelopeText.includes("do-not-cache"), false);
  const secrets = decryptValue(
    "mcpctl-local-secrets",
    "mcpctl/local-secrets-encryption/v1",
    childConfigs.mcp,
    JSON.parse(envelopeText)
  );
  assert.deepEqual(secrets.secrets, { "github-token": secretValue });
  assert.equal(await readFile(join(selected.paths.skills, "skills", "cloud-skill", "SKILL.md"), "utf8"), skillContent);
  await assert.rejects(readFile(selected.prompt.path));

  const snippetPlan = await remote.componentPlan("snippets", "review-code", "codex");
  assert.equal(snippetPlan.action, "create");
  assert.equal(JSON.stringify(snippetPlan).includes(snippetContent), false);
  const snippet = await remote.materializeComponent("snippets", "review-code", "codex");
  await remote.writeSnippet(snippet);
  assert.equal(await readFile(snippet.path, "utf8"), snippetContent);
});
