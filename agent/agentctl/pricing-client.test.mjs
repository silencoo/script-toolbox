import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PricingError,
  calculateUsageCost,
  createPricingEngine,
  newPricingCatalog,
  selectPricingRate,
  validatePricingCatalog,
  validatePricingRate
} from "../pricing/pricing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "pricing-client.mjs");

function rate(id, overrides = {}) {
  return {
    schema: 1,
    id,
    profile: "*",
    model: "model-exact",
    input_per_million: "3",
    output_per_million: "15",
    cache_read_per_million: "0.3",
    cache_write_per_million: "3.75",
    multiplier: "1.25",
    effective_at: "2026-01-01T00:00:00.000Z",
    expires_at: null,
    source: "vendor price page, captured 2026-01-01",
    ...overrides
  };
}

function catalogWith(...rates) {
  const catalog = newPricingCatalog({
    version: "2026.01",
    effectiveAt: "2026-01-01T00:00:00.000Z"
  });
  for (const item of rates) catalog.rates[item.id] = item;
  return validatePricingCatalog(catalog);
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [CLIENT, ...args], {
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

test("pricing uses fixed decimal BigInt math for every usage class", () => {
  const catalog = catalogWith(rate("global-exact"));
  const selected = selectPricingRate(catalog, {
    profile: "production",
    model: "model-exact",
    at: "2026-08-01T00:00:00.000Z"
  });
  const cost = calculateUsageCost(catalog, selected, {
    input_tokens: 1_000_000,
    output_tokens: 2_000_000,
    cache_read_tokens: 500_000,
    cache_write_tokens: 100_000
  });
  assert.deepEqual({
    input: cost.input,
    output: cost.output,
    cache_read: cost.cache_read,
    cache_write: cost.cache_write,
    total: cost.total
  }, {
    input: "3.75",
    output: "37.5",
    cache_read: "0.1875",
    cache_write: "0.46875",
    total: "41.90625"
  });
  assert.equal(cost.catalog_version, "2026.01");
  assert.equal(cost.rate_source.includes("vendor"), true);
});

test("pricing remains exact at the JavaScript safe-integer boundary", () => {
  const tiny = rate("tiny-rate", {
    input_per_million: "0.000001",
    output_per_million: "0",
    cache_read_per_million: "0",
    cache_write_per_million: "0",
    multiplier: "1"
  });
  const catalog = catalogWith(tiny);
  const cost = calculateUsageCost(catalog, tiny, {
    input_tokens: Number.MAX_SAFE_INTEGER,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0
  });
  assert.equal(cost.input, "9007.199254740991");
  assert.equal(cost.total, "9007.199254740991");
});

test("compiled pricing engine reuses one validated exact-model index", () => {
  const catalog = catalogWith(rate("compiled-rate"));
  const engine = createPricingEngine(catalog);
  const quote = engine.quote({
    profile: "production",
    model: "model-exact",
    at: "2026-08-01T00:00:00.000Z"
  }, {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0
  });
  assert.equal(engine.version, "2026.01");
  assert.equal(quote.rate.id, "compiled-rate");
  assert.equal(quote.cost.total, "3.75");
  assert.equal(engine.quote({
    profile: "production",
    model: "model-exact-lookalike",
    at: "2026-08-01T00:00:00.000Z"
  }, {}), null);
});

test("rate selection is exact, profile-aware, and effective-time-aware", () => {
  const catalog = catalogWith(
    rate("wild-old", { input_per_million: "1" }),
    rate("wild-new", {
      input_per_million: "2",
      effective_at: "2026-06-01T00:00:00.000Z"
    }),
    rate("profile-new", {
      profile: "production",
      input_per_million: "7",
      effective_at: "2026-05-01T00:00:00.000Z"
    }),
    rate("lookalike", { model: "model-exact-plus" })
  );
  assert.equal(selectPricingRate(catalog, {
    profile: "production",
    model: "model-exact",
    at: "2026-07-01T00:00:00.000Z"
  }).id, "profile-new");
  assert.equal(selectPricingRate(catalog, {
    profile: "staging",
    model: "model-exact",
    at: "2026-07-01T00:00:00.000Z"
  }).id, "wild-new");
  assert.equal(selectPricingRate(catalog, {
    profile: "staging",
    model: "model-exact",
    at: "2026-03-01T00:00:00.000Z"
  }).id, "wild-old");
  assert.equal(selectPricingRate(catalog, {
    profile: "staging",
    model: "model",
    at: "2026-07-01T00:00:00.000Z"
  }), null);
});

test("pricing rejects floats, signs, exponent notation, and unsafe usage", () => {
  for (const invalid of [3, -1, "-1", "+1", "1e-6", ".5", "01"] ) {
    assert.throws(
      () => validatePricingRate(rate("invalid-rate", { input_per_million: invalid })),
      PricingError
    );
  }
  const valid = rate("valid-rate");
  const catalog = catalogWith(valid);
  assert.throws(() => calculateUsageCost(catalog, valid, {
    input_tokens: Number.MAX_SAFE_INTEGER + 1
  }), /safe integer/);
});

test("pricing CLI previews mutations and calculates without floating point", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-pricing-"));
  const path = join(root, "config", "pricing.json");
  const common = ["--pricing", path];
  try {
    const preview = JSON.parse(run([
      "init", "--version", "2026.08", ...common, "--json"
    ]).stdout);
    assert.equal(preview.preview, true);
    await assert.rejects(() => lstat(path), { code: "ENOENT" });

    run(["init", "--version", "2026.08", ...common, "--yes", "--json"]);
    assert.equal((await lstat(path)).mode & 0o077, 0);
    assert.equal(JSON.parse(run(["status", ...common, "--json"]).stdout).rates, 0);

    const setPreview = JSON.parse(run([
      "set", "production-model",
      "--profile", "production",
      "--model", "model-exact",
      "--input", "3",
      "--output", "15",
      "--cache-read", "0.3",
      "--cache-write", "3.75",
      "--multiplier", "1.25",
      "--effective-at", "2026-01-01T00:00:00.000Z",
      "--source", "test source",
      ...common, "--json"
    ]).stdout);
    assert.equal(setPreview.preview, true);
    assert.equal(JSON.parse(await readFile(path, "utf8")).rates["production-model"], undefined);

    run([
      "set", "production-model",
      "--profile", "production",
      "--model", "model-exact",
      "--input", "3",
      "--output", "15",
      "--cache-read", "0.3",
      "--cache-write", "3.75",
      "--multiplier", "1.25",
      "--effective-at", "2026-01-01T00:00:00.000Z",
      "--source", "test source",
      ...common, "--yes", "--json"
    ]);
    const result = JSON.parse(run([
      "calculate", "production", "model-exact",
      "--at", "2026-08-01T00:00:00.000Z",
      "--input-tokens", "1000000",
      "--output-tokens", "2000000",
      "--cache-read-tokens", "500000",
      "--cache-write-tokens", "100000",
      ...common, "--json"
    ]).stdout);
    assert.equal(result.cost.total, "41.90625");
    assert.equal(result.cost.estimated, true);

    run([
      "calculate", "production", "model-exact",
      "--input-tokens", "9007199254740992",
      ...common, "--json"
    ], 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
