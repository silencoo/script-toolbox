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

import { isMainModule } from "../module-entry.mjs";

import {
  FailoverSchemaError,
  newFailoverStore,
  resolveFailoverRoute,
  validateFailoverProviders,
  validateFailoverRoute,
  validateFailoverStore,
  validateRouteName
} from "./failover-schema.mjs";
import {
  ProviderSchemaError,
  normalizeRuntimePlatform,
  validatePlatform,
  validateTarget
} from "./provider-schema.mjs";
import {
  loadProviderStore,
  providerDefaults
} from "./provider-client.mjs";

const MAX_STORE_BYTES = 5 * 1024 * 1024;

export class FailoverClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "FailoverClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl failover — portable ordered provider routes

Usage:
  agentctl failover init [--yes]
  agentctl failover status [--json]
  agentctl failover list [--json]
  agentctl failover show <route> [--json]
  agentctl failover resolve <route> --target <target> [--platform <platform>] [--json]
  agentctl failover create <route> --profile <name> --profile <name> [options] [--yes]
  agentctl failover delete <route> [--yes]
  agentctl failover export --output <file> [--force] [--yes]
  agentctl failover import --input <file> [--replace] [--yes]

Route options:
  --description <text>
  --profile <name>                 Ordered provider profile; repeat 2-8 times.
  --same-request-retry             Explicitly allow one POST to try another backend.
  --next-request-only              Never replay the current POST (default).
  --max-attempts <1-8>             Same-request attempt cap (default: 2).
  --retry-statuses <csv>           Failure/retry HTTP statuses.
  --network-errors | --no-network-errors
  --failure-threshold <1-20>       Failures before opening a circuit (default: 3).
  --recovery-timeout-ms <ms>       Open-to-half-open delay (default: 30000).
  --half-open-max <1-5>            Concurrent probe cap (default: 1).
  --state-retention-days <1-365>   Device-state retention (default: 30).
  --replace                        Replace an existing route/import catalog.

Storage options:
  --failover <file>                Portable route Store.
  --store <file>                   Portable Provider Store used for validation.
  --yes, -y                        Apply a mutation; otherwise preview it.

Routes contain profile references and policy only. Circuit counters, probe
leases, health, PIDs, logs, and generated proxy configuration are device-local.
The default next_request mode avoids silently replaying a model POST that may
already have consumed tokens. same_request must be chosen explicitly.
`);
}

export function failoverDefaults({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  const providers = providerDefaults({ platform, environment, home });
  return {
    storePath: providers.storePath,
    failoverPath: environment.AGENTCTL_FAILOVER_STORE ||
      join(dirname(providers.storePath), "failover.json")
  };
}

function takeValue(argv, option) {
  if (!argv.length || argv[0].startsWith("--")) {
    throw new FailoverClientError(`${option} requires a value`);
  }
  return argv.shift();
}

function integerOption(argv, option, minimum, maximum) {
  const raw = takeValue(argv, option);
  if (!/^[0-9]+$/.test(raw)) throw new FailoverClientError(`${option} requires an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FailoverClientError(`${option} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function parseStatuses(raw) {
  const values = raw.split(",").map((value) => value.trim());
  if (!values.length || values.some((value) => !/^[0-9]{3}$/.test(value))) {
    throw new FailoverClientError("--retry-statuses requires comma-separated HTTP status codes");
  }
  return values.map(Number);
}

export function parseFailoverArguments(argv, defaults = failoverDefaults()) {
  const options = {
    ...defaults,
    profiles: [],
    yes: false,
    json: false,
    replace: false,
    force: false,
    retryMode: "next_request",
    retryStatuses: [408, 425, 429, 500, 502, 503, 504],
    networkErrors: true,
    failureThreshold: 3,
    recoveryTimeoutMs: 30000,
    halfOpenMax: 1,
    stateRetentionDays: 30
  };
  const positional = [];
  argv = [...argv];
  while (argv.length) {
    const argument = argv.shift();
    switch (argument) {
      case "--failover": options.failoverPath = takeValue(argv, argument); break;
      case "--store": options.storePath = takeValue(argv, argument); break;
      case "--profile": options.profiles.push(takeValue(argv, argument)); break;
      case "--description": options.description = takeValue(argv, argument); break;
      case "--target": options.target = takeValue(argv, argument); break;
      case "--platform": options.platform = takeValue(argv, argument); break;
      case "--input": options.input = takeValue(argv, argument); break;
      case "--output": options.output = takeValue(argv, argument); break;
      case "--retry-statuses": options.retryStatuses = parseStatuses(takeValue(argv, argument)); break;
      case "--max-attempts": options.maxAttempts = integerOption(argv, argument, 1, 8); break;
      case "--failure-threshold": options.failureThreshold = integerOption(argv, argument, 1, 20); break;
      case "--recovery-timeout-ms":
        options.recoveryTimeoutMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--half-open-max": options.halfOpenMax = integerOption(argv, argument, 1, 5); break;
      case "--state-retention-days":
        options.stateRetentionDays = integerOption(argv, argument, 1, 365); break;
      case "--same-request-retry": options.retryMode = "same_request"; break;
      case "--next-request-only": options.retryMode = "next_request"; break;
      case "--network-errors": options.networkErrors = true; break;
      case "--no-network-errors": options.networkErrors = false; break;
      case "--replace": options.replace = true; break;
      case "--force": options.force = true; break;
      case "--yes":
      case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        if (argument.startsWith("-")) throw new FailoverClientError(`unknown option '${argument}'`);
        positional.push(argument);
    }
  }
  for (const path of ["failoverPath", "storePath", "input", "output"]) {
    if (options[path]) options[path] = resolve(options[path]);
  }
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

async function readJson(path, label) {
  const details = await pathState(path);
  if (!details) throw new FailoverClientError(`${label} not found: ${path}`);
  if (details.isSymbolicLink() || !details.isFile() || details.size > MAX_STORE_BYTES) {
    throw new FailoverClientError(`${label} must be a small regular non-symlink file`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new FailoverClientError(`${label} is not valid JSON`);
    throw error;
  }
}

export async function loadFailoverStore(path, { allowMissing = false } = {}) {
  if (allowMissing && !(await pathState(path))) return null;
  return validateFailoverStore(await readJson(path, "failover Store"));
}

async function writeBytesAtomic(path, bytes, { force = true } = {}) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new FailoverClientError(`refusing to replace non-regular path: ${path}`);
  }
  if (existing && !force) throw new FailoverClientError(`output already exists: ${path}`);
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeStore(path, store) {
  validateFailoverStore(store);
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(store, null, 2)}\n`));
}

function emit(value, options, lines) {
  if (options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${lines.join("\n")}\n`);
}

async function init(options) {
  const current = await loadFailoverStore(options.failoverPath, { allowMissing: true });
  if (current) {
    const result = { ok: true, changed: false, preview: !options.yes, store: options.failoverPath };
    emit(result, options, [`Failover Store already exists: ${options.failoverPath}`]);
    return result;
  }
  const store = newFailoverStore();
  if (options.yes) await writeStore(options.failoverPath, store);
  const result = { ok: true, changed: options.yes, preview: !options.yes, store: options.failoverPath };
  emit(result, options, [
    `${options.yes ? "Created" : "[preview] create"} Failover Store: ${options.failoverPath}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function status(options) {
  const store = await loadFailoverStore(options.failoverPath, { allowMissing: true });
  const result = store ? {
    schema: 1,
    status: "available",
    store: options.failoverPath,
    routes: Object.keys(store.routes).length,
    updated_at: store.updated_at
  } : {
    schema: 1,
    status: "unavailable",
    store: options.failoverPath,
    routes: 0
  };
  emit(result, options, [store
    ? `Failover: ${result.routes} route(s) · ${options.failoverPath}`
    : `Failover: unavailable · ${options.failoverPath}`]);
  return result;
}

async function list(options) {
  const store = await loadFailoverStore(options.failoverPath);
  const routes = Object.values(store.routes).sort((left, right) => left.name.localeCompare(right.name));
  emit(routes, options, routes.length ? routes.map((route) =>
    `${route.name}\t${route.profiles.join(" -> ")}\t${route.retry.mode}`
  ) : ["No failover routes configured."]);
  return routes;
}

async function show(name, options) {
  validateRouteName(name);
  const store = await loadFailoverStore(options.failoverPath);
  const route = Object.hasOwn(store.routes, name) ? store.routes[name] : null;
  if (!route) throw new FailoverClientError(`failover route not found: ${name}`);
  emit(route, options, [JSON.stringify(route, null, 2)]);
  return route;
}

function routeFromOptions(name, options) {
  const profiles = [...options.profiles];
  const route = {
    schema: 1,
    name,
    description: options.description || "",
    profiles,
    retry: {
      mode: options.retryMode,
      max_attempts: options.maxAttempts ?? Math.min(2, profiles.length),
      status_codes: [...options.retryStatuses],
      network_errors: options.networkErrors
    },
    circuit: {
      failure_threshold: options.failureThreshold,
      recovery_timeout_ms: options.recoveryTimeoutMs,
      half_open_max_requests: options.halfOpenMax,
      state_retention_days: options.stateRetentionDays
    }
  };
  return validateFailoverRoute(route, name);
}

async function create(name, options) {
  validateRouteName(name);
  const [store, providers] = await Promise.all([
    loadFailoverStore(options.failoverPath),
    loadProviderStore(options.storePath)
  ]);
  if (Object.hasOwn(store.routes, name) && !options.replace) {
    throw new FailoverClientError(`failover route '${name}' exists; use --replace to replace it`);
  }
  const route = routeFromOptions(name, options);
  validateFailoverProviders(route, providers);
  const next = structuredClone(store);
  next.routes[name] = route;
  next.updated_at = new Date().toISOString();
  validateFailoverStore(next);
  if (options.yes) await writeStore(options.failoverPath, next);
  const result = { ok: true, changed: options.yes, preview: !options.yes, route };
  emit(result, options, [
    `${options.yes ? "Saved" : "[preview] save"} failover route ${name}: ${route.profiles.join(" -> ")}`,
    `Retry mode: ${route.retry.mode}`,
    ...(route.retry.mode === "same_request"
      ? ["Warning: a model POST may be replayed and billed more than once."]
      : ["Current model POST will not be replayed; open circuits affect later requests."]),
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function resolveRoute(name, options) {
  if (!options.target) throw new FailoverClientError("failover resolve requires --target");
  validateTarget(options.target);
  const platform = options.platform || normalizeRuntimePlatform();
  validatePlatform(platform);
  const [store, providers] = await Promise.all([
    loadFailoverStore(options.failoverPath),
    loadProviderStore(options.storePath)
  ]);
  const route = Object.hasOwn(store.routes, name) ? store.routes[name] : null;
  if (!route) throw new FailoverClientError(`failover route not found: ${name}`);
  const resolved = resolveFailoverRoute(route, providers, { target: options.target, platform });
  emit(resolved, options, [
    `${name} · ${resolved.target}/${resolved.platform} · ${resolved.protocol}`,
    ...resolved.backends.map((backend, index) =>
      `${index + 1}. ${backend.profile}: ${backend.endpoint} · ${backend.requested_model} -> ${backend.outbound_model}`
    )
  ]);
  return resolved;
}

async function deleteRoute(name, options) {
  validateRouteName(name);
  const store = await loadFailoverStore(options.failoverPath);
  if (!Object.hasOwn(store.routes, name)) {
    throw new FailoverClientError(`failover route not found: ${name}`);
  }
  const next = structuredClone(store);
  delete next.routes[name];
  next.updated_at = new Date().toISOString();
  if (options.yes) await writeStore(options.failoverPath, next);
  const result = { ok: true, changed: options.yes, preview: !options.yes, route: name };
  emit(result, options, [
    `${options.yes ? "Deleted" : "[preview] delete"} failover route: ${name}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function exportStore(options) {
  if (!options.output) throw new FailoverClientError("failover export requires --output");
  const store = await loadFailoverStore(options.failoverPath);
  const outputExists = Boolean(await pathState(options.output));
  if (outputExists && !options.force) throw new FailoverClientError("output exists; use --force to replace it");
  const result = {
    ok: true,
    changed: options.yes,
    preview: !options.yes,
    output: options.output,
    routes: Object.keys(store.routes).length
  };
  if (options.yes) {
    await writeBytesAtomic(
      options.output,
      Buffer.from(`${JSON.stringify(store, null, 2)}\n`),
      { force: options.force }
    );
  }
  emit(result, options, [
    `${options.yes ? "Exported" : "[preview] export"} ${result.routes} route(s) to ${options.output}`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

async function importStore(options) {
  if (!options.input) throw new FailoverClientError("failover import requires --input");
  const imported = validateFailoverStore(await readJson(options.input, "failover import"));
  const [current, providers] = await Promise.all([
    loadFailoverStore(options.failoverPath, { allowMissing: true }),
    loadProviderStore(options.storePath)
  ]);
  for (const route of Object.values(imported.routes)) validateFailoverProviders(route, providers);
  let next;
  if (!current || options.replace) {
    next = structuredClone(imported);
  } else {
    next = structuredClone(current);
    for (const [name, route] of Object.entries(imported.routes)) {
      if (Object.hasOwn(next.routes, name) &&
          JSON.stringify(next.routes[name]) !== JSON.stringify(route)) {
        throw new FailoverClientError(
          `failover route '${name}' conflicts; use --replace to replace the catalog`
        );
      }
      next.routes[name] = route;
    }
  }
  next.updated_at = new Date().toISOString();
  validateFailoverStore(next);
  if (options.yes) await writeStore(options.failoverPath, next);
  const result = {
    ok: true,
    changed: options.yes,
    preview: !options.yes,
    replace: options.replace,
    routes: Object.keys(next.routes).length
  };
  emit(result, options, [
    `${options.yes ? "Imported" : "[preview] import"} ${result.routes} route(s)`,
    ...(options.yes ? [] : ["Re-run with --yes to apply."])
  ]);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseFailoverArguments(argv);
  if (options.help || !positional.length) return usage();
  const action = positional.shift();
  if (action === "init" && positional.length === 0) return init(options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "list" && positional.length === 0) return list(options);
  if (action === "show" && positional.length === 1) return show(positional[0], options);
  if (action === "resolve" && positional.length === 1) return resolveRoute(positional[0], options);
  if (action === "create" && positional.length === 1) return create(positional[0], options);
  if (action === "delete" && positional.length === 1) return deleteRoute(positional[0], options);
  if (action === "export" && positional.length === 0) return exportStore(options);
  if (action === "import" && positional.length === 0) return importStore(options);
  throw new FailoverClientError("invalid failover command; use agentctl failover --help");
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const safe = error instanceof FailoverClientError || error instanceof FailoverSchemaError ||
      error instanceof ProviderSchemaError
      ? error.message
      : "unexpected failover controller failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}
