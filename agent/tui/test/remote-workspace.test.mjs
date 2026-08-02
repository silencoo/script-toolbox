import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decryptValue } from "../../remote-store.mjs";
import {
  createRemoteWorkspace,
  mcpSelection,
  skillSelection,
  validateWorkspaceSnapshot
} from "../src/remote-workspace.mjs";

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
const skillHash = createHash("sha256")
  .update("SKILL.md\0")
  .update(String(0o600))
  .update("\0")
  .update(skillContent)
  .update("\0")
  .digest("hex");
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
        files: { "SKILL.md": { encoding: "base64", content: Buffer.from(skillContent).toString("base64"), mode: 0o600 } }
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
    }
  }
};

function workspaceSnapshot() {
  const now = new Date().toISOString();
  return {
    schema: 2,
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

test("remote Workspace index and catalogs never expose capabilities or Secret values", async () => {
  assert.equal(validateWorkspaceSnapshot(workspaceSnapshot()).schema, 2);
  const { remote, downloads } = await fixture();
  const index = await remote.index();
  const serialized = JSON.stringify(index);
  assert.equal(serialized.includes(masterConfig.root_key), false);
  assert.equal(serialized.includes(secretValue), false);
  assert.deepEqual(downloads, []);
  assert.equal(index.presets.web.source, "cloud");
  assert.equal(index.stores.mcp.latest.version, "v-1");

  const catalog = await remote.catalog("mcp", "codex");
  assert.deepEqual(downloads, ["mcp"]);
  assert.deepEqual(catalog.map(({ name, count }) => ({ name, count })), [
    { name: "base", count: 1 },
    { name: "frontend", count: 2 }
  ]);
  assert.equal(JSON.stringify(catalog).includes(secretValue), false);
  assert.deepEqual(await remote.catalog("prompts", "claude"), []);
});

test("profile and pack resolution honors inheritance and target overrides", () => {
  assert.deepEqual(mcpSelection(snapshots.mcp, "frontend", "codex").servers, ["browser", "github"]);
  assert.deepEqual(mcpSelection(snapshots.mcp, "frontend", "claude").servers, ["browser"]);
  assert.deepEqual(skillSelection(snapshots.skills, "frontend", "codex").skills, ["cloud-skill"]);
  assert.deepEqual(skillSelection(snapshots.skills, "frontend", "claude").skills, []);
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
});
