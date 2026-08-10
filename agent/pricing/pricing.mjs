import {
  validateModelId,
  validateProfileName
} from "../agentctl/provider-schema.mjs";

export const PRICING_SCHEMA = 1;
export const PRICING_KIND = "agentctl-pricing-catalog";
const SCALE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const PER_MILLION = 1_000_000n;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/;
const RATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class PricingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingError";
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new PricingError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PricingError(`${label} contains unsupported field '${key}'`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PricingError(`${label} must be an ISO timestamp`);
  }
  return value;
}

export function normalizeDecimal(value, label = "decimal") {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new PricingError(
      `${label} must be a non-negative decimal string with at most 12 integer and 12 fractional digits`
    );
  }
  const [whole, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
}

export function decimalToScaled(value, label = "decimal") {
  const normalized = normalizeDecimal(value, label);
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(SCALE_DIGITS, "0") || "0");
}

export function scaledToDecimal(value) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new PricingError("scaled decimal must be a non-negative BigInt");
  }
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(SCALE_DIGITS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function validateRateId(value) {
  if (typeof value !== "string" || value.length > 64 || !RATE_ID_PATTERN.test(value)) {
    throw new PricingError("rate ID must use lowercase letters, numbers, and single hyphens");
  }
  return value;
}

export function validatePricingRate(value, expectedId = "") {
  exactKeys(value, [
    "schema", "id", "profile", "model", "input_per_million",
    "output_per_million", "cache_read_per_million", "cache_write_per_million",
    "multiplier", "effective_at", "expires_at", "source"
  ], "pricing rate");
  if (value.schema !== PRICING_SCHEMA) throw new PricingError("pricing rate schema must be 1");
  validateRateId(value.id);
  if (expectedId && value.id !== expectedId) throw new PricingError(`pricing rate '${expectedId}' has a mismatched ID`);
  if (value.profile !== "*") validateProfileName(value.profile, "pricing rate profile");
  validateModelId(value.model, "pricing rate model");
  for (const field of [
    "input_per_million", "output_per_million",
    "cache_read_per_million", "cache_write_per_million", "multiplier"
  ]) value[field] = normalizeDecimal(value[field], `pricing rate ${field}`);
  if (decimalToScaled(value.multiplier) === 0n) {
    throw new PricingError("pricing rate multiplier must be greater than zero");
  }
  timestamp(value.effective_at, "pricing rate effective_at");
  if (value.expires_at !== null) {
    timestamp(value.expires_at, "pricing rate expires_at");
    if (Date.parse(value.expires_at) <= Date.parse(value.effective_at)) {
      throw new PricingError("pricing rate expires_at must be after effective_at");
    }
  }
  if (typeof value.source !== "string" || value.source.length < 1 ||
      value.source.length > 500 || /[\u0000-\u001f\u007f]/.test(value.source)) {
    throw new PricingError("pricing rate source must be a 1-500 character string");
  }
  return value;
}

export function newPricingCatalog({
  version,
  currency = "USD",
  effectiveAt = new Date().toISOString()
}) {
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) {
    throw new PricingError("catalog version must use letters, numbers, '.', '_' or '-'");
  }
  if (!/^[A-Z]{3}$/.test(currency)) throw new PricingError("currency must be a three-letter uppercase code");
  timestamp(effectiveAt, "catalog effective_at");
  return {
    schema: PRICING_SCHEMA,
    kind: PRICING_KIND,
    version,
    currency,
    effective_at: effectiveAt,
    updated_at: effectiveAt,
    rates: {}
  };
}

export function validatePricingCatalog(value) {
  exactKeys(value, [
    "schema", "kind", "version", "currency", "effective_at", "updated_at", "rates"
  ], "pricing catalog");
  if (value.schema !== PRICING_SCHEMA || value.kind !== PRICING_KIND ||
      typeof value.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.version) ||
      typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
    throw new PricingError("pricing catalog identity is invalid");
  }
  timestamp(value.effective_at, "pricing catalog effective_at");
  timestamp(value.updated_at, "pricing catalog updated_at");
  if (!plainObject(value.rates)) throw new PricingError("pricing catalog rates must be an object");
  if (Object.keys(value.rates).length > 4096) {
    throw new PricingError("pricing catalog has more than 4096 rates");
  }
  const unique = new Set();
  for (const [id, rate] of Object.entries(value.rates)) {
    validateRateId(id);
    validatePricingRate(rate, id);
    const composite = `${rate.profile}\u0000${rate.model}\u0000${rate.effective_at}`;
    if (unique.has(composite)) {
      throw new PricingError(
        `duplicate profile/model/effective_at pricing rate at '${id}'`
      );
    }
    unique.add(composite);
  }
  return value;
}

function tokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingError(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function componentCost(tokens, rate, multiplier, label) {
  const count = tokenCount(tokens, `${label} tokens`);
  const price = decimalToScaled(rate, `${label} rate`);
  const factor = decimalToScaled(multiplier, "pricing multiplier");
  const denominator = PER_MILLION * SCALE;
  return (count * price * factor + denominator / 2n) / denominator;
}

function selectionArguments({ profile, model, at = new Date().toISOString() }) {
  validateProfileName(profile, "pricing profile");
  validateModelId(model, "pricing model");
  timestamp(at, "pricing timestamp");
  return { profile, model, at };
}

function selectFromRates(rates, { profile, model, at }) {
  const instant = Date.parse(at);
  const candidates = rates.filter((rate) =>
    rate.model === model && [profile, "*"].includes(rate.profile) &&
    Date.parse(rate.effective_at) <= instant &&
    (rate.expires_at === null || Date.parse(rate.expires_at) > instant)
  );
  candidates.sort((left, right) => {
    const profileOrder = Number(right.profile === profile) - Number(left.profile === profile);
    if (profileOrder) return profileOrder;
    const timeOrder = Date.parse(right.effective_at) - Date.parse(left.effective_at);
    return timeOrder || left.id.localeCompare(right.id);
  });
  return candidates[0] || null;
}

export function selectPricingRate(catalog, options) {
  validatePricingCatalog(catalog);
  return selectFromRates(Object.values(catalog.rates), selectionArguments(options));
}

function calculateValidatedUsageCost(catalog, rate, usage) {
  const fields = [
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"
  ];
  for (const field of fields) tokenCount(usage[field] ?? 0, field);
  const scaled = {
    input: componentCost(
      usage.input_tokens ?? 0,
      rate.input_per_million,
      rate.multiplier,
      "input"
    ),
    output: componentCost(
      usage.output_tokens ?? 0,
      rate.output_per_million,
      rate.multiplier,
      "output"
    ),
    cache_read: componentCost(
      usage.cache_read_tokens ?? 0,
      rate.cache_read_per_million,
      rate.multiplier,
      "cache read"
    ),
    cache_write: componentCost(
      usage.cache_write_tokens ?? 0,
      rate.cache_write_per_million,
      rate.multiplier,
      "cache write"
    )
  };
  const total = Object.values(scaled).reduce((sum, value) => sum + value, 0n);
  return {
    currency: catalog.currency,
    catalog_version: catalog.version,
    catalog_effective_at: catalog.effective_at,
    catalog_updated_at: catalog.updated_at,
    rate_id: rate.id,
    rate_source: rate.source,
    pricing_profile: rate.profile,
    multiplier: rate.multiplier,
    input: scaledToDecimal(scaled.input),
    output: scaledToDecimal(scaled.output),
    cache_read: scaledToDecimal(scaled.cache_read),
    cache_write: scaledToDecimal(scaled.cache_write),
    total: scaledToDecimal(total),
    estimated: true,
    estimate_reason: "catalog_calculation"
  };
}

export function calculateUsageCost(catalog, rate, usage) {
  validatePricingCatalog(catalog);
  validatePricingRate(rate, rate.id);
  return calculateValidatedUsageCost(catalog, rate, usage);
}

export function createPricingEngine(catalog) {
  validatePricingCatalog(catalog);
  const byModel = new Map();
  for (const rate of Object.values(catalog.rates)) {
    const rates = byModel.get(rate.model) || [];
    rates.push(rate);
    byModel.set(rate.model, rates);
  }
  return Object.freeze({
    version: catalog.version,
    currency: catalog.currency,
    quote(options, usage) {
      const selected = selectionArguments(options);
      const rate = selectFromRates(byModel.get(selected.model) || [], selected);
      if (!rate) return null;
      return {
        rate,
        cost: calculateValidatedUsageCost(catalog, rate, usage)
      };
    }
  });
}
