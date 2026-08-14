#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateModelId, validateProfileName } from "./provider-schema.mjs";
import {
  PricingError,
  calculateUsageCost,
  newPricingCatalog,
  normalizeDecimal,
  selectPricingRate,
  usageContextTokens,
  validatePricingCatalog,
  validatePricingRate
} from "../pricing/pricing.mjs";

const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const BUNDLED_PRESETS = Object.freeze({
  "openai-gpt-5.6": fileURLToPath(new URL(
    "../pricing/openai-gpt-5.6-2026-08-14.json",
    import.meta.url
  ))
});

export class PricingClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl pricing — versioned fixed-decimal model pricing

Usage:
  agentctl pricing init (--version <version> | --preset openai-gpt-5.6) [--yes]
  agentctl pricing status [--json]
  agentctl pricing list [--json]
  agentctl pricing show <rate-id> [--json]
  agentctl pricing set <rate-id> --model <exact-id> [options] [--yes]
  agentctl pricing delete <rate-id> [--yes]
  agentctl pricing calculate <profile> <exact-model> [usage options] [--json]

Rate options:
  --profile <name|*>                Provider profile scope (default: *).
  --service-tier <standard|fast>    Processing tier (default: standard).
  --context-min-tokens <integer>    Inclusive prompt/context lower bound.
  --context-max-tokens <integer|unbounded>
                                      Inclusive upper bound (default: unbounded).
  --input <decimal>                 Input price per million tokens.
  --output <decimal>                Output price per million tokens.
  --cache-read <decimal>            Cache-read price per million tokens.
  --cache-write <decimal>           Cache-write price per million tokens.
  --multiplier <decimal>            Provider multiplier (default: 1).
  --effective-at <ISO timestamp>    First instant at which the rate applies.
  --expires-at <ISO timestamp>      Exclusive expiry instant.
  --source <text>                   Human-readable price provenance.
  --version <version>               Set the resulting catalog version.

Usage options:
  --input-tokens <integer>
  --output-tokens <integer>
  --cache-read-tokens <integer>
  --cache-write-tokens <integer>
  --service-tier <standard|fast>    Tier used for this request.
  --at <ISO timestamp>              Pricing instant (default: now).

Bundled preset:
  openai-gpt-5.6                    Versioned 2026-08-14 official snapshot for
                                      GPT-5.6 Sol/Terra/Luna, Standard/Fast,
                                      and short/long context. Never auto-updates.

Storage options:
  --pricing <file>                  Pricing catalog path.
  --yes, -y                         Apply a mutation; otherwise preview it.

All monetary inputs are decimal strings. Scientific notation and JavaScript
floating-point arithmetic are deliberately rejected. Model matching is exact.
`);
}

export function pricingDefaults({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  const configHome = platform === "win32"
    ? (environment.APPDATA || join(home, "AppData", "Roaming"))
    : (environment.XDG_CONFIG_HOME || join(home, ".config"));
  return {
    pricingPath: environment.AGENTCTL_PRICING_CATALOG ||
      join(configHome, "agentctl", "pricing.json")
  };
}

function takeValue(argv, option) {
  if (!argv.length || argv[0].startsWith("--")) {
    throw new PricingClientError(`${option} requires a value`);
  }
  return argv.shift();
}

function tokenOption(argv, option) {
  const raw = takeValue(argv, option);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new PricingClientError(`${option} requires a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new PricingClientError(`${option} exceeds the safe integer range`);
  }
  return value;
}

function contextMaximumOption(argv, option) {
  const raw = takeValue(argv, option);
  if (raw === "unbounded") return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new PricingClientError(`${option} requires a non-negative integer or 'unbounded'`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new PricingClientError(`${option} exceeds the safe integer range`);
  }
  return value;
}

export function parsePricingArguments(argv, defaults = pricingDefaults()) {
  const options = {
    ...defaults,
    yes: false,
    json: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
  const positional = [];
  argv = [...argv];
  while (argv.length) {
    const argument = argv.shift();
    switch (argument) {
      case "--pricing": options.pricingPath = takeValue(argv, argument); break;
      case "--preset": options.preset = takeValue(argv, argument); break;
      case "--version": options.version = takeValue(argv, argument); break;
      case "--currency": options.currency = takeValue(argv, argument); break;
      case "--profile": options.profile = takeValue(argv, argument); break;
      case "--service-tier": options.serviceTier = takeValue(argv, argument); break;
      case "--context-min-tokens": options.contextMinTokens = tokenOption(argv, argument); break;
      case "--context-max-tokens": options.contextMaxTokens = contextMaximumOption(argv, argument); break;
      case "--model": options.model = takeValue(argv, argument); break;
      case "--input": options.input = takeValue(argv, argument); break;
      case "--output": options.output = takeValue(argv, argument); break;
      case "--cache-read": options.cacheRead = takeValue(argv, argument); break;
      case "--cache-write": options.cacheWrite = takeValue(argv, argument); break;
      case "--multiplier": options.multiplier = takeValue(argv, argument); break;
      case "--effective-at": options.effectiveAt = takeValue(argv, argument); break;
      case "--expires-at": options.expiresAt = takeValue(argv, argument); break;
      case "--source": options.source = takeValue(argv, argument); break;
      case "--at": options.at = takeValue(argv, argument); break;
      case "--input-tokens": options.inputTokens = tokenOption(argv, argument); break;
      case "--output-tokens": options.outputTokens = tokenOption(argv, argument); break;
      case "--cache-read-tokens": options.cacheReadTokens = tokenOption(argv, argument); break;
      case "--cache-write-tokens": options.cacheWriteTokens = tokenOption(argv, argument); break;
      case "--yes":
      case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        if (argument.startsWith("-")) {
          throw new PricingClientError(`unknown option '${argument}'`);
        }
        positional.push(argument);
    }
  }
  options.pricingPath = resolve(options.pricingPath);
  return { positional, options };
}

async function pathState(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadPricingCatalog(path, { allowMissing = false } = {}) {
  const details = await pathState(path);
  if (!details && allowMissing) return null;
  if (!details) throw new PricingClientError(`pricing catalog not found: ${path}`);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_CATALOG_BYTES) {
    throw new PricingClientError("pricing catalog must be a small regular non-symlink file");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new PricingClientError("pricing catalog is not valid JSON");
    throw error;
  }
  return validatePricingCatalog(value);
}

async function writeCatalog(path, catalog) {
  validatePricingCatalog(catalog);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new PricingClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function emit(value, options, lines = []) {
  if (options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

function validTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PricingClientError(`${label} must be an ISO timestamp`);
  }
  return value;
}

function catalogVersion(catalog, requested) {
  if (!requested) return catalog.version;
  const probe = newPricingCatalog({ version: requested });
  return probe.version;
}

async function init(options) {
  const existing = await loadPricingCatalog(options.pricingPath, { allowMissing: true });
  if (existing) {
    const result = { ok: true, changed: false, preview: !options.yes, catalog: options.pricingPath };
    emit(result, options, [`Pricing catalog already exists: ${options.pricingPath}`]);
    return result;
  }
  if (options.preset && (options.version || options.currency || options.effectiveAt)) {
    throw new PricingClientError("--preset cannot be combined with --version, --currency, or --effective-at");
  }
  let catalog;
  if (options.preset) {
    const presetPath = BUNDLED_PRESETS[options.preset];
    if (!presetPath) {
      throw new PricingClientError(
        `unknown pricing preset '${options.preset}'; available: ${Object.keys(BUNDLED_PRESETS).join(", ")}`
      );
    }
    catalog = structuredClone(await loadPricingCatalog(presetPath));
  } else {
    if (!options.version) throw new PricingClientError("pricing init requires --version or --preset");
    catalog = newPricingCatalog({
      version: options.version,
      currency: options.currency || "USD",
      effectiveAt: options.effectiveAt || new Date().toISOString()
    });
  }
  const result = { ok: true, changed: options.yes, preview: !options.yes, catalog: options.pricingPath, value: catalog };
  if (options.yes) await writeCatalog(options.pricingPath, catalog);
  emit(result, options, [
    `${options.yes ? "Created" : "[preview] create"} pricing catalog ${catalog.version} at ${options.pricingPath}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function status(options) {
  const catalog = await loadPricingCatalog(options.pricingPath, { allowMissing: true });
  const result = catalog ? {
    schema: 1,
    status: "available",
    catalog: options.pricingPath,
    version: catalog.version,
    currency: catalog.currency,
    updated_at: catalog.updated_at,
    rates: Object.keys(catalog.rates).length
  } : {
    schema: 1,
    status: "unavailable",
    catalog: options.pricingPath,
    rates: 0
  };
  emit(result, options, catalog ? [
    `Pricing: ${catalog.version} · ${catalog.currency} · ${result.rates} rate(s)`,
    `Catalog: ${options.pricingPath}`
  ] : [`Pricing: unavailable (${options.pricingPath})`]);
  return result;
}

async function list(options) {
  const catalog = await loadPricingCatalog(options.pricingPath);
  const rates = Object.values(catalog.rates).sort((left, right) =>
    left.model.localeCompare(right.model) || left.profile.localeCompare(right.profile) ||
    left.effective_at.localeCompare(right.effective_at)
  );
  const result = { version: catalog.version, currency: catalog.currency, rates };
  emit(result, options, rates.length ? rates.map((rate) =>
    `${rate.id}\t${rate.profile}\t${rate.model}\t${rate.service_tier}\t${rate.context_min_tokens}-${rate.context_max_tokens ?? "unbounded"}\t${rate.effective_at}`
  ) : ["No pricing rates configured."]);
  return result;
}

async function show(id, options) {
  const catalog = await loadPricingCatalog(options.pricingPath);
  const rate = Object.hasOwn(catalog.rates, id) ? catalog.rates[id] : null;
  if (!rate) throw new PricingClientError(`pricing rate not found: ${id}`);
  emit(rate, options, [JSON.stringify(rate, null, 2)]);
  return rate;
}

function buildRate(id, options, previous = null) {
  const effectiveAt = options.effectiveAt || previous?.effective_at || new Date().toISOString();
  const rate = {
    schema: 1,
    id,
    profile: options.profile ?? previous?.profile ?? "*",
    model: options.model ?? previous?.model,
    service_tier: options.serviceTier ?? previous?.service_tier ?? "standard",
    context_min_tokens: options.contextMinTokens ?? previous?.context_min_tokens ?? 0,
    context_max_tokens: options.contextMaxTokens === undefined
      ? (previous?.context_max_tokens ?? null)
      : options.contextMaxTokens,
    input_per_million: normalizeDecimal(options.input ?? previous?.input_per_million ?? "0", "input price"),
    output_per_million: normalizeDecimal(options.output ?? previous?.output_per_million ?? "0", "output price"),
    cache_read_per_million: normalizeDecimal(options.cacheRead ?? previous?.cache_read_per_million ?? "0", "cache-read price"),
    cache_write_per_million: normalizeDecimal(options.cacheWrite ?? previous?.cache_write_per_million ?? "0", "cache-write price"),
    multiplier: normalizeDecimal(options.multiplier ?? previous?.multiplier ?? "1", "pricing multiplier"),
    effective_at: validTimestamp(effectiveAt, "--effective-at"),
    expires_at: options.expiresAt === undefined
      ? (previous?.expires_at ?? null)
      : validTimestamp(options.expiresAt, "--expires-at"),
    source: options.source ?? previous?.source
  };
  if (!rate.model) throw new PricingClientError("pricing set requires --model for a new rate");
  if (!rate.source) throw new PricingClientError("pricing set requires --source for a new rate");
  if (rate.profile !== "*") validateProfileName(rate.profile, "pricing profile");
  validateModelId(rate.model, "pricing model");
  return validatePricingRate(rate, id);
}

async function setRate(id, options) {
  const catalog = await loadPricingCatalog(options.pricingPath);
  const next = structuredClone(catalog);
  next.version = catalogVersion(catalog, options.version);
  next.updated_at = new Date().toISOString();
  const previous = Object.hasOwn(next.rates, id) ? next.rates[id] : null;
  const rate = buildRate(id, options, previous);
  next.rates[id] = rate;
  validatePricingCatalog(next);
  const result = {
    ok: true,
    changed: options.yes,
    preview: !options.yes,
    action: Object.hasOwn(catalog.rates, id) ? "update_rate" : "add_rate",
    catalog: options.pricingPath,
    version: next.version,
    rate
  };
  if (options.yes) await writeCatalog(options.pricingPath, next);
  emit(result, options, [
    `${options.yes ? "Applied" : "[preview]"} ${result.action.replace("_", " ")}: ${id}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function deleteRate(id, options) {
  const catalog = await loadPricingCatalog(options.pricingPath);
  if (!Object.hasOwn(catalog.rates, id)) {
    throw new PricingClientError(`pricing rate not found: ${id}`);
  }
  const next = structuredClone(catalog);
  delete next.rates[id];
  next.version = catalogVersion(catalog, options.version);
  next.updated_at = new Date().toISOString();
  validatePricingCatalog(next);
  const result = { ok: true, changed: options.yes, preview: !options.yes, action: "delete_rate", rate_id: id };
  if (options.yes) await writeCatalog(options.pricingPath, next);
  emit(result, options, [
    `${options.yes ? "Deleted" : "[preview] delete"} pricing rate: ${id}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function calculate(profile, model, options) {
  validateProfileName(profile, "pricing profile");
  validateModelId(model, "pricing model");
  const catalog = await loadPricingCatalog(options.pricingPath);
  const at = options.at ? validTimestamp(options.at, "--at") : new Date().toISOString();
  const usageValue = {
    input_tokens: options.inputTokens,
    output_tokens: options.outputTokens,
    cache_read_tokens: options.cacheReadTokens,
    cache_write_tokens: options.cacheWriteTokens
  };
  const contextTokens = usageContextTokens(usageValue);
  const serviceTier = options.serviceTier || "standard";
  const rate = selectPricingRate(catalog, {
    profile,
    model,
    serviceTier,
    contextTokens,
    at
  });
  if (!rate) {
    throw new PricingClientError(
      `no active ${serviceTier} pricing rate for ${profile}/${model} at ${contextTokens} context tokens`
    );
  }
  const result = {
    profile,
    model,
    priced_at: at,
    service_tier: serviceTier,
    context_tokens: contextTokens,
    usage: usageValue,
    cost: calculateUsageCost(catalog, rate, usageValue)
  };
  emit(result, options, [
    `${result.cost.total} ${result.cost.currency} · ${profile}/${model}`,
    `Catalog ${result.cost.catalog_version}, rate ${result.cost.rate_id}`
  ]);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parsePricingArguments(argv);
  if (options.help || !positional.length) return usage();
  const action = positional.shift();
  if (action === "init" && positional.length === 0) return init(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "list" && positional.length === 0) return list(options);
  if (action === "show" && positional.length === 1) return show(positional[0], options);
  if (action === "set" && positional.length === 1) return setRate(positional[0], options);
  if (action === "delete" && positional.length === 1) return deleteRate(positional[0], options);
  if (action === "calculate" && positional.length === 2) {
    return calculate(positional[0], positional[1], options);
  }
  throw new PricingClientError("invalid pricing command; use agentctl pricing --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof PricingClientError || error instanceof PricingError
      ? error.message
      : "unexpected pricing controller failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}
