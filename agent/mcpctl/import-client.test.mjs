import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  mergeCatalog,
  parseClaudeConfig,
  parseCodexList
} from "./import-client.mjs";
import { readEncryptedLocalSecrets } from "./remote-client.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const IMPORT_CLIENT = join(TEST_DIR, "import-client.mjs");

async function run(arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [IMPORT_CLIENT, ...arguments_], {
      cwd: TEST_DIR,
      env: {
        ...process.env,
        ...options.env
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test("Claude import extracts environment and Header values into Secret references", () => {
  const imported = parseClaudeConfig({
    mcpServers: {
      local: {
        command: "npx",
        args: ["-y", "private-mcp"],
        env: {
          API_TOKEN: "claude-static-token",
          FROM_ENV: "${EXISTING_TOKEN}"
        }
      },
      remote: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: {
          Authorization: "Bearer claude-header-token"
        }
      }
    }
  });

  assert.equal(imported.servers.length, 2);
  assert.deepEqual(imported.servers[0].definition.command, [
    "npx",
    "-y",
    "private-mcp"
  ]);
  assert.equal(
    imported.servers[0].definition.environment.API_TOKEN.env,
    "API_TOKEN"
  );
  assert.equal(
    imported.servers[0].definition.environment.FROM_ENV.env,
    "EXISTING_TOKEN"
  );
  assert.equal(
    imported.servers[1].definition.headers.Authorization.prefix,
    "Bearer "
  );
  assert.equal(Object.values(imported.secrets).includes("claude-static-token"), true);
  assert.equal(Object.values(imported.secrets).includes("claude-header-token"), true);
  assert.equal(
    JSON.stringify(imported.servers).includes("claude-static-token"),
    false
  );
  assert.equal(
    JSON.stringify(imported.servers).includes("claude-header-token"),
    false
  );
});

test("Codex import preserves structured transport options and disabled selection", () => {
  const imported = parseCodexList([
    {
      name: "local",
      enabled: true,
      startup_timeout_sec: 20,
      tool_timeout_sec: 45,
      transport: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "/work",
        env: { API_TOKEN: "codex-static-token" },
        env_vars: ["PASSTHROUGH", { name: "REMOTE_TOKEN", source: "remote" }]
      }
    },
    {
      name: "remote",
      enabled: false,
      transport: {
        type: "streamable_http",
        url: "https://mcp.example.test/mcp",
        bearer_token_env_var: "REMOTE_BEARER",
        http_headers: { "X-Static": "codex-header-token" },
        env_http_headers: { "X-Dynamic": "DYNAMIC_HEADER" }
      }
    }
  ]);

  const local = imported.servers.find((server) => server.name === "local");
  const remote = imported.servers.find((server) => server.name === "remote");
  assert.deepEqual(local.definition.command, ["node", "server.mjs"]);
  assert.equal(local.definition.cwd, "/work");
  assert.equal(local.definition.startup_timeout_sec, 20);
  assert.equal(local.definition.tool_timeout_sec, 45);
  assert.deepEqual(local.definition.env_vars, [
    "PASSTHROUGH",
    { name: "REMOTE_TOKEN", source: "remote" }
  ]);
  assert.equal(remote.enabled, false);
  assert.equal(remote.definition.suppress_when_disabled, true);
  assert.equal(remote.definition.headers.Authorization.env, "REMOTE_BEARER");
  assert.equal(remote.definition.headers.Authorization.prefix, "Bearer ");
  assert.equal(remote.definition.headers["X-Dynamic"].env, "DYNAMIC_HEADER");
  assert.equal(Object.values(imported.secrets).includes("codex-static-token"), true);
  assert.equal(Object.values(imported.secrets).includes("codex-header-token"), true);
});

test("import refuses URL credentials and extracts credential command arguments", () => {
  assert.throws(
    () => parseClaudeConfig({
      mcpServers: {
        unsafe: {
          type: "http",
          url: "https://mcp.example.test/mcp?api_key=plaintext"
        }
      }
    }),
    /move it to a Header/
  );
  const imported = parseClaudeConfig({
    mcpServers: {
      safe: {
        command: "tool",
        args: ["--token", "command-token", "--api-key=inline-token"]
      }
    }
  });
  assert.equal(imported.servers[0].definition.command[1], "--token");
  assert.equal(
    imported.servers[0].definition.command[2].prefix ?? "",
    ""
  );
  assert.equal(
    imported.servers[0].definition.command[3].prefix,
    "--api-key="
  );
  assert.deepEqual(
    Object.values(imported.secrets).sort(),
    ["command-token", "inline-token"]
  );
  assert.equal(
    JSON.stringify(imported.servers).includes("command-token"),
    false
  );
});

test("catalog conflicts require force and become target-specific overrides", () => {
  const catalog = {
    schema: 1,
    servers: {
      context7: {
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        supported_targets: ["claude", "codex"]
      }
    }
  };
  const imported = parseClaudeConfig({
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"]
      }
    }
  });

  const planned = mergeCatalog(catalog, imported, { force: false });
  assert.equal(planned.conflicts.length, 1);
  assert.equal(planned.changes[0].action, "conflict");

  const adopted = mergeCatalog(catalog, imported, { force: true });
  assert.equal(adopted.conflicts.length, 0);
  assert.equal(adopted.changes[0].action, "replace");
  assert.equal(
    adopted.value.servers.context7.target_overrides.claude.transport,
    "stdio"
  );
  assert.deepEqual(
    adopted.value.servers.context7.target_overrides.claude.command,
    ["npx", "-y", "@upstash/context7-mcp"]
  );
  assert.equal(
    adopted.value.servers.context7.target_overrides.claude.url,
    null
  );
  const repeated = mergeCatalog(adopted.value, imported, { force: false });
  assert.deepEqual(repeated.conflicts, []);
  assert.equal(repeated.changes[0].action, "keep");
});

test("apply writes only redacted catalog data and an encrypted Secret cache", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "mcpctl-import-test-"));
  const store = join(testRoot, "store");
  const profiles = join(store, "profiles");
  const source = join(testRoot, "claude.json");
  const remoteConfig = join(testRoot, "remote.json");
  const profile = join(profiles, "imported.json");
  const encryptedSecrets = join(store, "secrets.remote.enc");
  const config = {
    schema: 1,
    endpoint: "https://backup.example.test",
    store_id: "0123456789abcdef0123456789abcdef",
    root_key: Buffer.alloc(32, 17).toString("base64url")
  };
  const firstToken = "first-import-token-never-print";
  const secondToken = "rotated-import-token-never-print";

  try {
    await mkdir(profiles, { recursive: true, mode: 0o700 });
    await writeFile(
      join(store, "catalog.json"),
      `${JSON.stringify({ schema: 1, servers: {} }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      join(profiles, "off.json"),
      `${JSON.stringify({
        schema: 1,
        name: "off",
        extends: [],
        enable: [],
        disable: [],
        target_overrides: {}
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(
      source,
      `${JSON.stringify({
        mcpServers: {
          private: {
            command: "node",
            args: ["server.mjs"],
            env: { API_TOKEN: firstToken }
          }
        }
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await writeFile(remoteConfig, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600
    });
    await chmod(remoteConfig, 0o600);

    const common = [
      "--target", "claude",
      "--store", store,
      "--profile", "imported",
      "--source", source,
      "--remote-config", remoteConfig
    ];
    const plan = await run(["plan", ...common]);
    assert.equal(plan.code, 0);
    assert.equal(plan.stdout.includes(firstToken), false);
    assert.equal(plan.stderr.includes(firstToken), false);
    await assert.rejects(readFile(profile), /ENOENT/);
    await assert.rejects(readFile(encryptedSecrets), /ENOENT/);

    const applied = await run(["apply", ...common]);
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.stdout.includes(firstToken), false);
    assert.equal(applied.stderr.includes(firstToken), false);
    const catalogText = await readFile(join(store, "catalog.json"), "utf8");
    assert.equal(catalogText.includes(firstToken), false);
    assert.equal((await stat(join(store, "catalog.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(profile)).mode & 0o777, 0o600);
    assert.equal((await stat(encryptedSecrets)).mode & 0o777, 0o600);

    const importedProfile = JSON.parse(await readFile(profile, "utf8"));
    assert.deepEqual(importedProfile.target_overrides.claude.enable, ["private"]);
    const decrypted = await readEncryptedLocalSecrets(encryptedSecrets, config);
    assert.deepEqual(Object.values(decrypted), [firstToken]);

    const idempotent = await run(["plan", ...common]);
    assert.equal(idempotent.code, 0);
    assert.match(idempotent.stdout, /private \(keep\)/);
    assert.match(idempotent.stdout, /Profile change: = keep/);

    const sourceDocument = JSON.parse(await readFile(source, "utf8"));
    sourceDocument.mcpServers.private.env.API_TOKEN = secondToken;
    await writeFile(source, `${JSON.stringify(sourceDocument, null, 2)}\n`, {
      mode: 0o600
    });
    const blocked = await run(["apply", ...common]);
    assert.notEqual(blocked.code, 0);
    assert.equal(blocked.stdout.includes(secondToken), false);
    assert.equal(blocked.stderr.includes(secondToken), false);
    assert.deepEqual(
      Object.values(await readEncryptedLocalSecrets(encryptedSecrets, config)),
      [firstToken]
    );

    const forced = await run(["apply", ...common, "--force"]);
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.stdout.includes(secondToken), false);
    assert.deepEqual(
      Object.values(await readEncryptedLocalSecrets(encryptedSecrets, config)),
      [secondToken]
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
