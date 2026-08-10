import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ProviderSchemaError,
  newProviderStore,
  resolveProviderProfile,
  validateProviderStore
} from "./provider-schema.mjs";
import { providerDefaults } from "./provider-client.mjs";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "provider-client.mjs");

function run(args, expectedStatus = 0, environment = {}) {
  const result = spawnSync(process.execPath, [CLIENT, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...environment }
  });
  assert.equal(
    result.status,
    expectedStatus,
    `command status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

function paths(root) {
  return {
    store: join(root, "config", "providers.json"),
    secrets: join(root, "config", "provider-secrets.json"),
    state: join(root, "state", "providers.json")
  };
}

function common(root) {
  const value = paths(root);
  return [
    "--store", value.store,
    "--secrets", value.secrets,
    "--state", value.state
  ];
}

test("provider schema is strict and rejects machine state or insecure endpoints", () => {
  const now = new Date().toISOString();
  const base = {
    schema: 1,
    kind: "agentctl-provider-store",
    created_at: now,
    updated_at: now,
    profiles: {
      lab: {
        schema: 1,
        name: "lab",
        description: "",
        protocol: "openai_responses",
        endpoint: "https://api.example.com/v1",
        auth: { mode: "bearer", secret: "lab_api_key" },
        models: { default: "model-a", aliases: {} },
        targets: {},
        platforms: {}
      }
    }
  };
  assert.doesNotThrow(() => validateProviderStore(structuredClone(base)));

  const withRuntimeState = structuredClone(base);
  withRuntimeState.profiles.lab.platforms.windows = {
    targets: { codex: { model: "model-a", config_path: "C:\\Users\\x" } }
  };
  assert.throws(
    () => validateProviderStore(withRuntimeState),
    /unsupported field 'config_path'/
  );

  const insecure = structuredClone(base);
  insecure.profiles.lab.endpoint = "http://api.example.com/v1";
  assert.throws(() => validateProviderStore(insecure), /must use HTTPS/);

  const credentials = structuredClone(base);
  credentials.profiles.lab.endpoint = "https://token@example.com/v1";
  assert.throws(() => validateProviderStore(credentials), /embedded credentials/);

  const querySecret = structuredClone(base);
  querySecret.profiles.lab.endpoint = "https://api.example.com/v1?api_key=secret";
  assert.throws(() => validateProviderStore(querySecret), /auth\.secret/);
});

test("target and platform overlays resolve deterministically before aliases", () => {
  const profile = {
    schema: 1,
    name: "multi",
    description: "cross-platform profile",
    protocol: "openai_responses",
    endpoint: "https://api.example.com/v1",
    auth: { mode: "bearer", secret: "shared_key" },
    models: {
      default: "daily",
      aliases: { daily: "model-base", "win-daily": "model-windows" }
    },
    targets: {
      codex: { model: "daily" }
    },
    platforms: {
      windows: {
        targets: {
          codex: {
            endpoint: "https://windows.example.com/v1",
            model: "win-daily",
            auth: { secret: "windows_key" }
          }
        }
      }
    }
  };
  const windows = resolveProviderProfile(profile, {
    target: "codex",
    platform: "windows"
  });
  assert.equal(windows.endpoint, "https://windows.example.com/v1");
  assert.equal(windows.auth.mode, "bearer");
  assert.equal(windows.auth.secret, "windows_key");
  assert.equal(windows.requested_model, "win-daily");
  assert.equal(windows.outbound_model, "model-windows");

  const darwin = resolveProviderProfile(profile, {
    target: "codex",
    platform: "darwin"
  });
  assert.equal(darwin.endpoint, "https://api.example.com/v1");
  assert.equal(darwin.outbound_model, "model-base");
});

test("model alias cycles fail closed", () => {
  const profile = {
    schema: 1,
    name: "cycle",
    description: "",
    protocol: "openai_chat",
    endpoint: "https://api.example.com/v1",
    auth: { mode: "none" },
    models: { default: "a", aliases: { a: "b", b: "a" } },
    targets: {},
    platforms: {}
  };
  assert.throws(
    () => resolveProviderProfile(profile, { target: "opencode", platform: "linux" }),
    (error) => error instanceof ProviderSchemaError && /alias cycle/.test(error.message)
  );
});

test("provider CLI previews mutations, stores Secrets separately, and exports no values", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-client-test-"));
  const p = paths(root);
  try {
    const preview = run(["init", ...common(root)]);
    assert.match(preview.stdout, /\[preview\]/);
    await assert.rejects(() => lstat(p.store), { code: "ENOENT" });

    run(["init", ...common(root), "--yes"]);
    run([
      "create", "gateway",
      "--protocol", "openai_responses",
      "--base-url", "https://gateway.example.com/v1",
      "--model", "daily",
      "--alias", "daily=model-2026",
      "--secret", "gateway_key",
      ...common(root), "--yes"
    ]);
    run([
      "target", "gateway", "claude",
      "--disable", ...common(root), "--yes"
    ]);
    run([
      "platform", "gateway", "windows", "codex",
      "--model", "daily", ...common(root), "--yes"
    ]);

    const resolved = JSON.parse(run([
      "resolve", "gateway", "--target", "codex", "--platform", "windows",
      ...common(root), "--json"
    ]).stdout);
    assert.equal(resolved.requested_model, "daily");
    assert.equal(resolved.outbound_model, "model-2026");

    const secretInput = join(root, "gateway-key");
    await writeFile(secretInput, "TOP-SECRET-VALUE\n", { mode: 0o600 });
    await chmod(secretInput, 0o600);
    run([
      "secret", "set", "gateway_key", "--secret-file", secretInput,
      ...common(root), "--yes"
    ]);
    const secretStatus = JSON.parse(run([
      "secret", "status", "gateway_key", ...common(root), "--json"
    ]).stdout);
    assert.equal(secretStatus.present, true);
    assert.deepEqual(secretStatus.referenced_by, ["gateway"]);

    const exported = join(root, "portable.json");
    run(["export", "--output", exported, ...common(root), "--yes"]);
    const exportText = await readFile(exported, "utf8");
    assert.equal(exportText.includes("TOP-SECRET-VALUE"), false);
    assert.equal(exportText.includes("gateway_key"), true);
    assert.equal((await lstat(p.secrets)).mode & 0o077, 0);
    assert.equal((await lstat(exported)).mode & 0o077, 0);

    const status = JSON.parse(run(["status", ...common(root), "--json"]).stdout);
    assert.equal(status.profile_count, 1);
    assert.equal(status.secret_count, 1);
    assert.deepEqual(status.missing_secrets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider Secret input rejects loose permissions and symlinks", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "provider-secret-safety-"));
  try {
    run(["init", ...common(root), "--yes"]);
    const loose = join(root, "loose-key");
    await writeFile(loose, "secret\n", { mode: 0o644 });
    await chmod(loose, 0o644);
    assert.match(run([
      "secret", "set", "unsafe_key", "--secret-file", loose,
      ...common(root), "--yes"
    ], 1).stderr, /owner-only/);

    const privateFile = join(root, "private-key");
    const linked = join(root, "linked-key");
    await writeFile(privateFile, "secret\n", { mode: 0o600 });
    await symlink(privateFile, linked);
    assert.match(run([
      "secret", "set", "linked_key", "--secret-file", linked,
      ...common(root), "--yes"
    ], 1).stderr, /non-symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable imports merge safely and require explicit replacement on conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-import-test-"));
  try {
    run(["init", ...common(root), "--yes"]);
    run([
      "create", "one", "--protocol", "anthropic_messages",
      "--base-url", "https://api.example.com/anthropic", "--model", "model-a",
      "--auth-mode", "none", ...common(root), "--yes"
    ]);
    const incoming = newProviderStore();
    incoming.profiles.one = {
      schema: 1,
      name: "one",
      description: "different",
      protocol: "anthropic_messages",
      endpoint: "https://api.example.com/anthropic",
      auth: { mode: "none" },
      models: { default: "model-a", aliases: {} },
      targets: {},
      platforms: {}
    };
    const input = join(root, "incoming.json");
    await writeFile(input, `${JSON.stringify(incoming)}\n`, { mode: 0o600 });
    assert.match(run([
      "import", "--input", input, ...common(root), "--yes"
    ], 1).stderr, /conflicts with profile 'one'/);
    run(["import", "--input", input, "--replace", ...common(root), "--yes"]);
    const shown = JSON.parse(run(["show", "one", ...common(root)]).stdout);
    assert.equal(shown.description, "different");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows defaults use APPDATA and never inherit a macOS config path", () => {
  const defaults = providerDefaults({
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\Test\\AppData\\Roaming" },
    home: "C:\\Users\\Test"
  });
  assert.match(defaults.storePath, /AppData[\\/]Roaming[\\/]agentctl/);
  assert.equal(defaults.storePath.includes("/.config/"), false);
});
