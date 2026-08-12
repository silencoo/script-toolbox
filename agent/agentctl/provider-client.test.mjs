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
import {
  builtinModelContext,
  builtinProvider,
  builtinProviderCatalog
} from "./provider-catalog.mjs";
import { providerDefaults } from "./provider-client.mjs";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "provider-client.mjs");

function run(args, expectedStatus = 0, environment = {}) {
  const requestedHome = environment.HOME;
  const result = spawnSync(process.execPath, [CLIENT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...environment,
      ...(process.platform === "win32" && requestedHome
        ? { HOME: requestedHome.replaceAll("\\", "/"), USERPROFILE: requestedHome }
        : {})
    }
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

test("built-in context metadata is exact-model scoped", () => {
  assert.deepEqual(builtinModelContext("deepseek", "claude", "deepseek-v4-pro"), {
    window_tokens: 1_000_000,
    auto_compact_tokens: null
  });
  assert.deepEqual(builtinModelContext("deepseek", "claude", "deepseek-v4-flash"), {
    window_tokens: 1_000_000,
    auto_compact_tokens: null
  });
  assert.deepEqual(builtinModelContext("minimax-global", "claude", "MiniMax-M3"), {
    window_tokens: 1_000_000,
    auto_compact_tokens: 500_000
  });
  assert.deepEqual(builtinModelContext("minimax-global", "claude", "MiniMax-M2.7"), {
    window_tokens: 204_800,
    auto_compact_tokens: null
  });
  assert.equal(
    builtinModelContext("openrouter", "claude", "~anthropic/claude-sonnet-latest"),
    null
  );
});

test("unwanted built-ins stay available explicitly but are hidden from the default catalog", () => {
  const visible = new Set(builtinProviderCatalog().map((entry) => entry.name));
  for (const name of ["anthropic-api", "openai-api", "openrouter", "minimax-global"]) {
    assert.equal(visible.has(name), false);
    assert.equal(builtinProvider(name)?.name, name);
  }
  assert.equal(visible.has("deepseek"), true);
  assert.equal(visible.has("minimax-cn"), true);
});

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

  const invalidContext = validateProviderStore(structuredClone(base));
  invalidContext.profiles.lab.context = null;
  assert.throws(() => validateProviderStore(invalidContext), /context must be an object/);

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

test("schema 1 migration grants native compaction only to exact official built-ins", () => {
  const now = new Date().toISOString();
  const legacy = {
    schema: 1,
    kind: "agentctl-provider-store",
    created_at: now,
    updated_at: now,
    profiles: {}
  };
  for (const [name, protocol, endpoint] of [
    ["openai-api", "openai_responses", "https://api.openai.com/v1"],
    ["anthropic-api", "anthropic_messages", "https://api.anthropic.com"],
    ["gateway", "openai_responses", "https://gateway.example.com/v1"]
  ]) {
    legacy.profiles[name] = {
      schema: 1,
      name,
      description: "",
      protocol,
      endpoint,
      auth: { mode: "none" },
      models: { default: "model-a", aliases: {} },
      targets: {},
      platforms: {}
    };
  }
  const migrated = validateProviderStore(legacy);
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.profiles["openai-api"].compaction.upstream, "responses_v2");
  assert.equal(
    migrated.profiles["anthropic-api"].compaction.upstream,
    "anthropic_messages_beta"
  );
  assert.deepEqual(migrated.profiles.gateway.compaction, {
    upstream: "none",
    policy: "auto"
  });
  assert.deepEqual(migrated.profiles.gateway.context, {
    window_tokens: null,
    auto_compact_tokens: null
  });

  const incompatible = structuredClone(migrated);
  incompatible.profiles.gateway.compaction.upstream = "anthropic_messages_beta";
  assert.throws(() => validateProviderStore(incompatible), /requires protocol anthropic_messages/);
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
      codex: {
        model: "daily",
        context: { window_tokens: 1_000_000, auto_compact_tokens: 500_000 }
      }
    },
    platforms: {
      windows: {
        targets: {
          codex: {
            endpoint: "https://windows.example.com/v1",
            model: "win-daily",
            auth: { secret: "windows_key" },
            context: { auto_compact_tokens: 400_000 }
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
  assert.deepEqual(windows.context, {
    window_tokens: 1_000_000,
    auto_compact_tokens: 400_000
  });

  const darwin = resolveProviderProfile(profile, {
    target: "codex",
    platform: "darwin"
  });
  assert.equal(darwin.endpoint, "https://api.example.com/v1");
  assert.equal(darwin.outbound_model, "model-base");
  assert.equal(darwin.context.auto_compact_tokens, 500_000);

  const invalidContext = structuredClone(profile);
  invalidContext.targets.codex.context.auto_compact_tokens = 1_000_001;
  assert.throws(
    () => resolveProviderProfile(invalidContext, { target: "codex", platform: "darwin" }),
    /cannot exceed window_tokens/
  );
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
      "--context-window-tokens", "1000000",
      "--auto-compact-tokens", "500000",
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
    assert.deepEqual(resolved.context, {
      window_tokens: 1_000_000,
      auto_compact_tokens: 500_000
    });

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
    if (process.platform === "win32") {
      assert.equal((await lstat(p.secrets)).isFile(), true);
      assert.equal((await lstat(exported)).isFile(), true);
    } else {
      assert.equal((await lstat(p.secrets)).mode & 0o077, 0);
      assert.equal((await lstat(exported)).mode & 0o077, 0);
    }

    const status = JSON.parse(run(["status", ...common(root), "--json"]).stdout);
    assert.equal(status.profile_count, 1);
    assert.equal(status.secret_count, 1);
    assert.deepEqual(status.missing_secrets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider migrate schema rewrites the portable Store once without touching Secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-schema-migrate-"));
  const p = paths(root);
  const now = new Date().toISOString();
  try {
    await mkdir(dirname(p.store), { recursive: true });
    await writeFile(p.store, `${JSON.stringify({
      schema: 1,
      kind: "agentctl-provider-store",
      created_at: now,
      updated_at: now,
      profiles: {
        gateway: {
          schema: 1,
          name: "gateway",
          description: "",
          protocol: "openai_responses",
          endpoint: "https://gateway.example.com/v1",
          auth: { mode: "none" },
          models: { default: "model-a", aliases: {} },
          targets: {},
          platforms: {}
        },
        "minimax-cn": {
          schema: 1,
          name: "minimax-cn",
          description: "MiniMax (China) direct Anthropic-compatible API.",
          protocol: "anthropic_messages",
          endpoint: "https://api.minimaxi.com/anthropic",
          auth: { mode: "bearer", secret: "minimax_api_key" },
          models: { default: "MiniMax-M3", aliases: {} },
          targets: {
            codex: { enabled: false },
            opencode: {
              endpoint: "https://api.minimaxi.com/anthropic/v1",
              auth: { mode: "x-api-key" }
            }
          },
          platforms: {}
        }
      }
    })}\n`, { mode: 0o600 });
    const preview = JSON.parse(run([
      "migrate", "schema", ...common(root), "--json"
    ]).stdout);
    assert.equal(preview.changed, true);
    assert.equal(JSON.parse(await readFile(p.store, "utf8")).schema, 1);
    const applied = JSON.parse(run([
      "migrate", "schema", ...common(root), "--yes", "--json"
    ]).stdout);
    assert.equal(applied.to_schema, 2);
    assert.equal(applied.enriched_context_targets, 1);
    const stored = JSON.parse(await readFile(p.store, "utf8"));
    assert.equal(stored.schema, 2);
    assert.deepEqual(stored.profiles.gateway.compaction, {
      upstream: "none",
      policy: "auto"
    });
    assert.deepEqual(stored.profiles.gateway.context, {
      window_tokens: null,
      auto_compact_tokens: null
    });
    assert.deepEqual(stored.profiles["minimax-cn"].targets.claude.context, {
      window_tokens: 1_000_000,
      auto_compact_tokens: 500_000
    });
    const repeated = JSON.parse(run([
      "migrate", "schema", ...common(root), "--json"
    ]).stdout);
    assert.equal(repeated.changed, false);
    await assert.rejects(() => lstat(p.secrets), { code: "ENOENT" });
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

test("unified list exposes built-ins before initialization and use materializes one transactionally", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-builtin-test-"));
  const agentRoot = join(root, "agents");
  const backend = join(agentRoot, "claude-code", "setup.sh");
  const log = join(root, "backend.log");
  const environment = {
    HOME: root,
    AGENTCTL_AGENT_ROOT: agentRoot,
    AGENTCTL_BACKEND_LOG: log
  };
  try {
    const initial = JSON.parse(run([
      "list", "--target", "claude", ...common(root), "--json"
    ], 0, environment).stdout);
    const deepseek = initial.find((entry) => entry.name === "deepseek");
    assert.equal(deepseek.source, "builtin");
    assert.equal(deepseek.materialized, false);
    assert.equal(deepseek.status, "needs-key");
    assert.deepEqual(deepseek.models_available, ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(deepseek.context_window_tokens, 1_000_000);
    assert.equal(deepseek.auto_compact_tokens, null);
    assert.match(deepseek.context_label, /1,000,000 max/);
    const minimax = initial.find((entry) => entry.name === "minimax-cn");
    assert.equal(minimax.context_window_tokens, 1_000_000);
    assert.equal(minimax.auto_compact_tokens, 500_000);
    assert.match(minimax.context_label, /1,000,000 max/);
    const codexCatalog = JSON.parse(run([
      "list", "--target", "codex", ...common(root), "--json"
    ], 0, environment).stdout);
    assert.equal(codexCatalog.some((entry) => entry.name === "openai-api"), false);
    assert.equal(codexCatalog.some((entry) => entry.name === "openrouter"), false);

    const nativeAuth = join(root, ".local", "share", "opencode", "auth.json");
    await mkdir(dirname(nativeAuth), { recursive: true });
    await writeFile(nativeAuth, JSON.stringify({
      google: { type: "api", key: "NATIVE-GOOGLE-SECRET-MUST-NOT-APPEAR" }
    }), { mode: 0o600 });
    const opencodeOutput = run([
      "list", "--target", "opencode", ...common(root), "--json"
    ], 0, environment).stdout;
    assert.equal(opencodeOutput.includes("NATIVE-GOOGLE-SECRET-MUST-NOT-APPEAR"), false);
    const google = JSON.parse(opencodeOutput)
      .find((entry) => entry.name === "google-gemini");
    assert.equal(google.status, "native-auth");
    assert.equal(google.secret_present, false);
    assert.equal(google.native_auth_present, true);
    assert.equal(google.native_auth_provider, "google");
    assert.equal(google.native_auth_type, "api");
    assert.equal(google.native_selected, false);
    const opencodeConfig = join(root, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodeConfig), { recursive: true });
    await writeFile(opencodeConfig, JSON.stringify({
      model: "google/gemini-3.6-flash"
    }), { mode: 0o600 });
    const selectedGoogle = JSON.parse(run([
      "list", "--target", "opencode", ...common(root), "--json"
    ], 0, environment).stdout).find((entry) => entry.name === "google-gemini");
    assert.equal(selectedGoogle.status, "native-current");
    assert.equal(selectedGoogle.native_selected, true);
    assert.equal(selectedGoogle.native_selected_model, "gemini-3.6-flash");

    await mkdir(dirname(backend), { recursive: true });
    await writeFile(backend, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$AGENTCTL_BACKEND_LOG\"",
      "exit 0",
      ""
    ].join("\n"), { mode: 0o700 });
    await chmod(backend, 0o700);
    const key = join(root, "deepseek.key");
    await writeFile(key, "DEEPSEEK-TEST-SECRET\n", { mode: 0o600 });
    await chmod(key, 0o600);
    const applied = JSON.parse(run([
      "use", "deepseek", "--target", "claude", "--secret-file", key,
      ...common(root), "--yes", "--json"
    ], 0, environment).stdout);
    assert.deepEqual(applied.applied, ["claude"]);
    const backendArgs = await readFile(log, "utf8");
    assert.match(backendArgs, /--models-url/);
    assert.match(backendArgs, /https:\/\/api\.deepseek\.com\/models/);
    assert.equal(backendArgs.includes("DEEPSEEK-TEST-SECRET"), false);

    const after = JSON.parse(run([
      "list", "--target", "claude", ...common(root), "--json"
    ]).stdout);
    const materialized = after.find((entry) => entry.name === "deepseek");
    assert.equal(materialized.source, "builtin");
    assert.equal(materialized.materialized, true);
    assert.equal(materialized.applied, true);
    assert.equal(materialized.secret_present, true);

    const flash = JSON.parse(run([
      "use", "deepseek", "--target", "claude", "--model", "deepseek-v4-flash",
      ...common(root), "--skip-validate", "--yes", "--json"
    ], 0, environment).stdout);
    assert.deepEqual(flash.applied, ["claude"]);
    const flashProfile = JSON.parse(run([
      "resolve", "deepseek", "--target", "claude", ...common(root), "--json"
    ]).stdout);
    assert.equal(flashProfile.outbound_model, "deepseek-v4-flash");
    assert.deepEqual(flashProfile.context, {
      window_tokens: 1_000_000,
      auto_compact_tokens: null
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CCS migration imports third-party Providers and Secrets while skipping official identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-ccs-test-"));
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const databasePath = join(root, "cc-switch.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE providers (
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        sort_index INTEGER
      )
    `);
    const insert = database.prepare(
      "INSERT INTO providers (app_type, name, settings_config, is_current, sort_index) VALUES (?, ?, ?, ?, ?)"
    );
    insert.run("claude", "DeepSeek", JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "CCS-DEEPSEEK-SECRET",
        ANTHROPIC_MODEL: "deepseek-v4-pro"
      }
    }), 1, 1);
    insert.run("codex", "OpenAI Official", JSON.stringify({
      auth: { auth_mode: "chatgpt", OPENAI_API_KEY: "OFFICIAL-MUST-NOT-MIGRATE" },
      config: "model = 'gpt-5.6'\n"
    }), 1, 2);
    database.close();

    const preview = run([
      "migrate", "ccs", "--database", databasePath,
      ...common(root), "--json"
    ]);
    assert.equal(preview.stdout.includes("CCS-DEEPSEEK-SECRET"), false);
    assert.equal(preview.stdout.includes("OFFICIAL-MUST-NOT-MIGRATE"), false);
    const report = JSON.parse(preview.stdout);
    assert.deepEqual(report.imported.map((entry) => entry.profile), ["deepseek"]);
    assert.deepEqual(report.skipped.map((entry) => entry.name), ["OpenAI Official"]);

    const applied = run([
      "migrate", "ccs", "--database", databasePath,
      ...common(root), "--yes", "--json"
    ]);
    assert.equal(applied.stdout.includes("CCS-DEEPSEEK-SECRET"), false);
    const store = JSON.parse(await readFile(paths(root).store, "utf8"));
    const secrets = JSON.parse(await readFile(paths(root).secrets, "utf8"));
    assert.equal(store.profiles.deepseek.name, "deepseek");
    assert.equal(secrets.secrets.deepseek_api_key.value, "CCS-DEEPSEEK-SECRET");
    assert.equal(Object.values(secrets.secrets).some((entry) =>
      entry.value === "OFFICIAL-MUST-NOT-MIGRATE"), false);
    if (process.platform === "win32") {
      assert.equal((await lstat(paths(root).secrets)).isFile(), true);
    } else {
      assert.equal((await lstat(paths(root).secrets)).mode & 0o077, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
