import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  newFailoverStore,
  resolveFailoverRoute,
  validateFailoverRoute,
  validateFailoverStore
} from "./failover-schema.mjs";
import {
  newProviderStore,
  validateProviderStore
} from "./provider-schema.mjs";
import {
  CircuitRegistry,
  newCircuitState,
  validateCircuitState
} from "../proxy/circuit-breaker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDER_CLIENT = join(HERE, "provider-client.mjs");
const FAILOVER_CLIENT = join(HERE, "failover-client.mjs");

function provider(name, protocol = "openai_responses") {
  return {
    schema: 1,
    name,
    description: "",
    protocol,
    endpoint: `https://${name}.example.com/v1`,
    auth: { mode: "none" },
    models: { default: `${name}-friendly`, aliases: { [`${name}-friendly`]: `${name}-vendor` } },
    targets: {},
    platforms: {}
  };
}

function route(overrides = {}) {
  return {
    schema: 1,
    name: "work-route",
    description: "ordered test route",
    profiles: ["primary", "backup"],
    retry: {
      mode: "next_request",
      max_attempts: 2,
      status_codes: [429, 500, 502, 503, 504],
      network_errors: true
    },
    circuit: {
      failure_threshold: 2,
      recovery_timeout_ms: 1000,
      half_open_max_requests: 1,
      state_retention_days: 30
    },
    ...overrides
  };
}

function run(module, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [module, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  assert.equal(
    result.status,
    expectedStatus,
    `status mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result;
}

test("portable route resolution requires existing profiles and one native protocol", () => {
  const providers = newProviderStore("2026-01-01T00:00:00.000Z");
  providers.profiles.primary = provider("primary");
  providers.profiles.backup = provider("backup");
  validateProviderStore(providers);
  const resolved = resolveFailoverRoute(route(), providers, {
    target: "codex",
    platform: "linux"
  });
  assert.equal(resolved.protocol, "openai_responses");
  assert.deepEqual(resolved.backends.map((entry) => entry.profile), ["primary", "backup"]);
  assert.deepEqual(resolved.backends.map((entry) => entry.outbound_model), [
    "primary-vendor", "backup-vendor"
  ]);

  providers.profiles.backup = provider("backup", "openai_chat");
  assert.throws(() => resolveFailoverRoute(route(), providers, {
    target: "codex",
    platform: "linux"
  }), /different protocols/);
  delete providers.profiles.backup;
  assert.throws(() => resolveFailoverRoute(route(), providers, {
    target: "codex",
    platform: "linux"
  }), /missing provider profile/);
});

test("route schema makes same-request replay an explicit bounded policy", () => {
  assert.equal(validateFailoverRoute(route()).retry.mode, "next_request");
  assert.equal(validateFailoverRoute(route({
    retry: {
      mode: "same_request",
      max_attempts: 2,
      status_codes: [429, 503],
      network_errors: false
    }
  })).retry.mode, "same_request");
  assert.throws(() => validateFailoverRoute(route({ profiles: ["primary", "primary"] })), /unique/);
  assert.throws(() => validateFailoverRoute(route({
    retry: { mode: "same_request", max_attempts: 3, status_codes: [], network_errors: true }
  })), /max_attempts/);
  const store = newFailoverStore();
  store.routes["work-route"] = route();
  assert.equal(validateFailoverStore(store).kind, "agentctl-failover-store");
  assert.throws(() => validateFailoverRoute({
    ...route(),
    circuit_state: { primary: "open" }
  }), /unsupported field/);
});

test("circuit registry persists closed/open/half-open transitions without portable state", () => {
  let clock = Date.parse("2026-08-01T00:00:00.000Z");
  const policy = route().circuit;
  const registry = new CircuitRegistry(policy, newCircuitState(new Date(clock).toISOString()), {
    now: () => clock
  });
  assert.equal(registry.reserve("primary", "codex").allowed, true);
  assert.equal(registry.failure("primary", "codex").state, "closed");
  assert.equal(registry.failure("primary", "codex").state, "open");
  assert.equal(registry.reserve("primary", "codex").allowed, false);

  clock += 1000;
  const probe = registry.reserve("primary", "codex");
  assert.equal(probe.allowed, true);
  assert.equal(probe.state.state, "half_open");
  assert.equal(registry.reserve("primary", "codex").allowed, false);
  assert.equal(registry.release("primary", "codex").half_open_in_flight, 0);
  assert.equal(registry.reserve("primary", "codex").allowed, true);
  assert.equal(registry.failure("primary", "codex").state, "open");

  clock += 1000;
  assert.equal(registry.reserve("primary", "codex").allowed, true);
  assert.equal(registry.success("primary", "codex").state, "closed");
  const snapshot = registry.snapshot();
  assert.equal(validateCircuitState(snapshot).entries[0].failures, 0);
  const restored = new CircuitRegistry(policy, snapshot, { now: () => clock });
  assert.equal(restored.inspect("primary", "codex").state, "closed");
  assert.throws(() => new CircuitRegistry({ ...policy, failure_threshold: 0 }), /policy/);
  const invalid = structuredClone(snapshot);
  invalid.entries[0].opened_at = invalid.entries[0].updated_at;
  assert.throws(() => validateCircuitState(invalid), /closed circuit/);
});

test("failover CLI previews, validates Provider references, exports, and resolves", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-failover-"));
  const providerStore = join(root, "providers.json");
  const providerSecrets = join(root, "provider-secrets.json");
  const providerState = join(root, "provider-state.json");
  const failoverStore = join(root, "failover.json");
  const exported = join(root, "exported.json");
  const providerArgs = [
    "--store", providerStore,
    "--secrets", providerSecrets,
    "--state", providerState
  ];
  const common = ["--failover", failoverStore, "--store", providerStore];
  try {
    run(PROVIDER_CLIENT, ["init", ...providerArgs, "--yes"]);
    for (const name of ["primary", "backup"]) {
      run(PROVIDER_CLIENT, [
        "create", name,
        "--protocol", "openai_responses",
        "--base-url", `https://${name}.example.com/v1`,
        "--model", "friendly",
        "--alias", `friendly=${name}-vendor`,
        "--auth-mode", "none",
        ...providerArgs, "--yes"
      ]);
    }

    const initPreview = JSON.parse(run(FAILOVER_CLIENT, [
      "init", ...common, "--json"
    ]).stdout);
    assert.equal(initPreview.preview, true);
    await assert.rejects(() => lstat(failoverStore), { code: "ENOENT" });
    run(FAILOVER_CLIENT, ["init", ...common, "--yes", "--json"]);

    const createArgs = [
      "create", "work-route",
      "--profile", "primary",
      "--profile", "backup",
      "--failure-threshold", "2",
      "--recovery-timeout-ms", "5000",
      ...common
    ];
    const preview = JSON.parse(run(FAILOVER_CLIENT, [...createArgs, "--json"]).stdout);
    assert.equal(preview.preview, true);
    assert.equal(preview.route.retry.mode, "next_request");
    assert.equal(Object.keys(JSON.parse(await readFile(failoverStore, "utf8")).routes).length, 0);

    run(FAILOVER_CLIENT, [...createArgs, "--yes", "--json"]);
    assert.equal((await lstat(failoverStore)).mode & 0o077, 0);
    const resolved = JSON.parse(run(FAILOVER_CLIENT, [
      "resolve", "work-route", "--target", "codex", "--platform", "linux",
      ...common, "--json"
    ]).stdout);
    assert.deepEqual(resolved.backends.map((entry) => entry.outbound_model), [
      "primary-vendor", "backup-vendor"
    ]);
    assert.equal(JSON.stringify(resolved).includes("api_key"), false);

    run(FAILOVER_CLIENT, [
      "export", "--output", exported, ...common, "--yes", "--json"
    ]);
    assert.equal(JSON.parse(await readFile(exported, "utf8")).routes["work-route"].retry.mode, "next_request");

    run(FAILOVER_CLIENT, [
      "create", "bad-route", "--profile", "primary", "--profile", "missing",
      ...common, "--json"
    ], 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
