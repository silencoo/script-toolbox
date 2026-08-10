import { validateProfileName, validateTarget } from "../agentctl/provider-schema.mjs";

export const CIRCUIT_STATE_SCHEMA = 1;
export const CIRCUIT_STATE_KIND = "agentctl-circuit-state";
const STATES = new Set(["closed", "open", "half_open"]);

export class CircuitBreakerError extends Error {
  constructor(message) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CircuitBreakerError(`${label} must be an ISO timestamp${nullable ? " or null" : ""}`);
  }
  return value;
}

function key(profile, target) {
  return `${target}\u0000${profile}`;
}

function validateEntry(value) {
  const allowed = [
    "profile", "target", "state", "failures", "half_open_in_flight",
    "opened_at", "retry_at", "last_failure_at", "last_success_at", "updated_at"
  ];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((name) => !allowed.includes(name))) {
    throw new CircuitBreakerError("circuit entry is invalid");
  }
  validateProfileName(value.profile, "circuit profile");
  validateTarget(value.target, "circuit target");
  if (!STATES.has(value.state) || !Number.isInteger(value.failures) || value.failures < 0 ||
      value.failures > 1000000 || !Number.isInteger(value.half_open_in_flight) ||
      value.half_open_in_flight < 0 || value.half_open_in_flight > 1000) {
    throw new CircuitBreakerError("circuit entry counters or state are invalid");
  }
  for (const field of ["opened_at", "retry_at", "last_failure_at", "last_success_at"]) {
    timestamp(value[field], `circuit ${field}`, { nullable: true });
  }
  timestamp(value.updated_at, "circuit updated_at");
  if (value.state === "closed" &&
      (value.opened_at !== null || value.retry_at !== null || value.half_open_in_flight !== 0)) {
    throw new CircuitBreakerError("closed circuit state contains open-state fields");
  }
  if (value.state === "open" &&
      (value.opened_at === null || value.retry_at === null || value.half_open_in_flight !== 0)) {
    throw new CircuitBreakerError("open circuit state is missing open-state fields");
  }
  if (value.state === "half_open" &&
      (value.opened_at === null || value.retry_at === null)) {
    throw new CircuitBreakerError("half-open circuit state is missing recovery fields");
  }
  return value;
}

export function newCircuitState(now = new Date().toISOString()) {
  return {
    schema: CIRCUIT_STATE_SCHEMA,
    kind: CIRCUIT_STATE_KIND,
    updated_at: now,
    entries: []
  };
}

export function validateCircuitState(value) {
  const allowed = ["schema", "kind", "updated_at", "entries"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((name) => !allowed.includes(name)) ||
      value.schema !== CIRCUIT_STATE_SCHEMA || value.kind !== CIRCUIT_STATE_KIND ||
      !Array.isArray(value.entries) || value.entries.length > 1024) {
    throw new CircuitBreakerError("circuit state is invalid");
  }
  timestamp(value.updated_at, "circuit state updated_at");
  const unique = new Set();
  for (const entry of value.entries) {
    validateEntry(entry);
    const id = key(entry.profile, entry.target);
    if (unique.has(id)) throw new CircuitBreakerError("circuit state contains duplicate entries");
    unique.add(id);
  }
  return value;
}

function freshEntry(profile, target, now) {
  return {
    profile,
    target,
    state: "closed",
    failures: 0,
    half_open_in_flight: 0,
    opened_at: null,
    retry_at: null,
    last_failure_at: null,
    last_success_at: null,
    updated_at: now
  };
}

export class CircuitRegistry {
  constructor(policy, state = newCircuitState(), {
    now = () => Date.now()
  } = {}) {
    if (!policy || !Number.isInteger(policy.failure_threshold) ||
        policy.failure_threshold < 1 || policy.failure_threshold > 20 ||
        !Number.isInteger(policy.recovery_timeout_ms) ||
        policy.recovery_timeout_ms < 1000 || policy.recovery_timeout_ms > 3600000 ||
        !Number.isInteger(policy.half_open_max_requests) ||
        policy.half_open_max_requests < 1 || policy.half_open_max_requests > 5 ||
        !Number.isInteger(policy.state_retention_days) ||
        policy.state_retention_days < 1 || policy.state_retention_days > 365) {
      throw new CircuitBreakerError("circuit policy is invalid");
    }
    this.policy = structuredClone(policy);
    this.now = now;
    validateCircuitState(state);
    this.entries = new Map();
    const cutoff = this.now() - policy.state_retention_days * 86400000;
    for (const source of state.entries) {
      if (Date.parse(source.updated_at) < cutoff) continue;
      const entry = structuredClone(source);
      entry.half_open_in_flight = 0;
      this.entries.set(key(entry.profile, entry.target), entry);
    }
  }

  #entry(profile, target) {
    validateProfileName(profile, "circuit profile");
    validateTarget(target, "circuit target");
    const id = key(profile, target);
    if (!this.entries.has(id)) {
      this.entries.set(id, freshEntry(profile, target, new Date(this.now()).toISOString()));
    }
    return this.entries.get(id);
  }

  inspect(profile, target) {
    const entry = this.#entry(profile, target);
    if (entry.state === "open" && entry.retry_at !== null &&
        this.now() >= Date.parse(entry.retry_at)) {
      entry.state = "half_open";
      entry.half_open_in_flight = 0;
      entry.updated_at = new Date(this.now()).toISOString();
    }
    return structuredClone(entry);
  }

  reserve(profile, target) {
    const entry = this.#entry(profile, target);
    const current = this.inspect(profile, target);
    if (current.state === "open") return { allowed: false, state: current };
    if (current.state === "half_open") {
      const live = this.#entry(profile, target);
      if (live.half_open_in_flight >= this.policy.half_open_max_requests) {
        return { allowed: false, state: structuredClone(live) };
      }
      live.half_open_in_flight += 1;
      live.updated_at = new Date(this.now()).toISOString();
      return { allowed: true, state: structuredClone(live) };
    }
    return { allowed: true, state: current };
  }

  success(profile, target) {
    const entry = this.#entry(profile, target);
    const now = new Date(this.now()).toISOString();
    Object.assign(entry, {
      state: "closed",
      failures: 0,
      half_open_in_flight: 0,
      opened_at: null,
      retry_at: null,
      last_success_at: now,
      updated_at: now
    });
    return structuredClone(entry);
  }

  failure(profile, target) {
    const entry = this.#entry(profile, target);
    const instant = this.now();
    const now = new Date(instant).toISOString();
    entry.half_open_in_flight = 0;
    entry.failures += 1;
    entry.last_failure_at = now;
    entry.updated_at = now;
    if (entry.state === "half_open" || entry.failures >= this.policy.failure_threshold) {
      entry.state = "open";
      entry.opened_at = now;
      entry.retry_at = new Date(instant + this.policy.recovery_timeout_ms).toISOString();
    }
    return structuredClone(entry);
  }

  release(profile, target) {
    const entry = this.#entry(profile, target);
    if (entry.state === "half_open" && entry.half_open_in_flight > 0) {
      entry.half_open_in_flight -= 1;
      entry.updated_at = new Date(this.now()).toISOString();
    }
    return structuredClone(entry);
  }

  snapshot() {
    const now = new Date(this.now()).toISOString();
    return validateCircuitState({
      schema: CIRCUIT_STATE_SCHEMA,
      kind: CIRCUIT_STATE_KIND,
      updated_at: now,
      entries: [...this.entries.values()]
        .map((entry) => structuredClone(entry))
        .sort((left, right) => left.target.localeCompare(right.target) ||
          left.profile.localeCompare(right.profile))
    });
  }
}
