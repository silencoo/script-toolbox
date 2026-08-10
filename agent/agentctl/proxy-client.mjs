#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ProviderSchemaError,
  normalizeRuntimePlatform,
  resolveProviderProfile,
  validatePlatform,
  validateProfileName,
  validateTarget
} from "./provider-schema.mjs";
import {
  loadProviderSecrets,
  loadProviderStore,
  providerDefaults
} from "./provider-client.mjs";
import {
  ProviderRendererError,
  renderProviderPlan
} from "./provider-renderer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DAEMON = resolve(HERE, "..", "proxy", "agentproxyd.mjs");
const CONFIG_KIND = "agentctl-proxy-config";
const CAPABILITY_KIND = "agentctl-proxy-capability";
const STATE_KIND = "agentctl-proxy-state";
const LOCK_KIND = "agentctl-proxy-lock";

export class ProxyClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProxyClientError";
  }
}

function usage() {
  process.stdout.write(`agentctl proxy — explicit loopback-only provider proxy

Usage:
  agentctl proxy plan <profile> --target <target> [options]
  agentctl proxy start <profile> --target <target> [options] [--yes]
  agentctl proxy status [--json]
  agentctl proxy stop [--yes]
  agentctl proxy token <status|rotate> [--yes] [--json]

Options:
  --platform <platform>             Overlay to inspect (apply requires current OS).
  --port <1024-65535>               Loopback port (default: 17321).
  --first-byte-timeout-ms <ms>      Upstream response-header timeout.
  --stream-idle-timeout-ms <ms>     Maximum gap between streaming chunks.
  --request-timeout-ms <ms>         Total non-streaming request timeout.
  --request-bytes <bytes>           Maximum request body (default: 16 MiB).
  --log-bytes <bytes>               Metadata log rotation threshold.
  --store <file>                    Portable Provider Store.
  --secrets <file>                  Local provider Secret Store.
  --proxy-config <file>             Generated device-local daemon config.
  --proxy-state <file>              Device-local runtime state.
  --proxy-capability <file>         Owner-only local client capability.
  --proxy-log <file>                Request metadata JSONL (never bodies/headers).
  --proxy-runtime-log <file>        Daemon lifecycle diagnostics.
  --yes, -y                         Apply start/stop/token mutation.

The proxy never changes Claude/Codex/OpenCode/Pi configuration automatically.
It accepts only the selected profile's native protocol in this phase. Every
request requires the local capability through x-agentctl-proxy-token, Bearer,
x-api-key, or x-goog-api-key; the daemon replaces it with the real upstream
credential in memory.
`);
}

export function proxyDefaults({
  platform = process.platform,
  environment = process.env,
  home = homedir()
} = {}) {
  const providers = providerDefaults({ platform, environment, home });
  const stateRoot = join(dirname(providers.statePath), "proxy");
  const configRoot = dirname(providers.storePath);
  const envPort = Number(environment.AGENTCTL_PROXY_PORT || 17321);
  return {
    ...providers,
    daemonPath: environment.AGENTCTL_PROXY_DAEMON || DEFAULT_DAEMON,
    proxyConfig: environment.AGENTCTL_PROXY_CONFIG || join(stateRoot, "config.json"),
    proxyState: environment.AGENTCTL_PROXY_STATE || join(stateRoot, "state.json"),
    proxyLock: environment.AGENTCTL_PROXY_LOCK || join(stateRoot, "runtime.lock"),
    proxyCapability: environment.AGENTCTL_PROXY_CAPABILITY ||
      join(configRoot, "proxy-capability.json"),
    proxyLog: environment.AGENTCTL_PROXY_LOG || join(stateRoot, "requests.jsonl"),
    proxyRuntimeLog: environment.AGENTCTL_PROXY_RUNTIME_LOG ||
      join(stateRoot, "daemon.log"),
    port: Number.isInteger(envPort) ? envPort : 17321,
    firstByteMs: 30000,
    streamIdleMs: 120000,
    requestMs: 300000,
    requestBytes: 16 * 1024 * 1024,
    logBytes: 5 * 1024 * 1024
  };
}

function takeValue(argv, option) {
  if (!argv.length || argv[0].startsWith("--")) {
    throw new ProxyClientError(`${option} requires a value`);
  }
  return argv.shift();
}

function integerOption(argv, option, minimum, maximum) {
  const raw = takeValue(argv, option);
  if (!/^[0-9]+$/.test(raw)) throw new ProxyClientError(`${option} requires an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProxyClientError(`${option} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

export function parseProxyArguments(argv, defaults = proxyDefaults()) {
  const options = { ...defaults, yes: false, json: false, platform: undefined };
  const positional = [];
  argv = [...argv];
  while (argv.length) {
    const argument = argv.shift();
    switch (argument) {
      case "--store": options.storePath = takeValue(argv, argument); break;
      case "--secrets": options.secretsPath = takeValue(argv, argument); break;
      case "--proxy-config": options.proxyConfig = takeValue(argv, argument); break;
      case "--proxy-state": options.proxyState = takeValue(argv, argument); break;
      case "--proxy-capability": options.proxyCapability = takeValue(argv, argument); break;
      case "--proxy-log": options.proxyLog = takeValue(argv, argument); break;
      case "--proxy-runtime-log": options.proxyRuntimeLog = takeValue(argv, argument); break;
      case "--platform": options.platform = takeValue(argv, argument); break;
      case "--target": options.target = takeValue(argv, argument); break;
      case "--port": options.port = integerOption(argv, argument, 1024, 65535); break;
      case "--first-byte-timeout-ms":
        options.firstByteMs = integerOption(argv, argument, 100, 600000); break;
      case "--stream-idle-timeout-ms":
        options.streamIdleMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--request-timeout-ms":
        options.requestMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--request-bytes":
        options.requestBytes = integerOption(argv, argument, 1024, 64 * 1024 * 1024); break;
      case "--log-bytes":
        options.logBytes = integerOption(argv, argument, 65536, 100 * 1024 * 1024); break;
      case "--yes":
      case "-y": options.yes = true; break;
      case "--json": options.json = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default:
        if (argument.startsWith("-")) throw new ProxyClientError(`unknown option '${argument}'`);
        positional.push(argument);
    }
  }
  for (const key of [
    "storePath", "secretsPath", "daemonPath", "proxyConfig", "proxyState",
    "proxyLock", "proxyCapability", "proxyLog", "proxyRuntimeLog"
  ]) options[key] = resolve(options[key]);
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

async function readPrivateJson(path, label) {
  const details = await pathState(path);
  if (!details) throw new ProxyClientError(`${label} not found: ${path}`);
  if (details.isSymbolicLink() || !details.isFile() || details.size > 1024 * 1024) {
    throw new ProxyClientError(`${label} must be a small regular non-symlink file`);
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ProxyClientError(`${label} must be owner-only (chmod 600)`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProxyClientError(`${label} is not valid JSON`);
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ProxyClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
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

function validateCapability(value) {
  if (!value || value.schema !== 1 || value.kind !== CAPABILITY_KIND ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
      Object.keys(value).some((key) => !["schema", "kind", "created_at", "token"].includes(key))) {
    throw new ProxyClientError("proxy capability is invalid");
  }
  return value;
}

function validateState(value) {
  const keys = [
    "schema", "kind", "instance_id", "pid", "started_at", "host", "port",
    "profile", "target", "protocol", "config"
  ];
  if (!value || value.schema !== 1 || value.kind !== STATE_KIND ||
      typeof value.instance_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.instance_id) ||
      !Number.isInteger(value.pid) || value.pid < 1 ||
      typeof value.started_at !== "string" || Number.isNaN(Date.parse(value.started_at)) ||
      !["127.0.0.1", "::1"].includes(value.host) ||
      !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      typeof value.config !== "string" || !isAbsolute(value.config) || value.config.length > 4096 ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ProxyClientError("proxy runtime state is invalid");
  }
  validateProfileName(value.profile);
  validateTarget(value.target);
  if (!["anthropic_messages", "openai_responses", "openai_chat", "google_generative"].includes(value.protocol)) {
    throw new ProxyClientError("proxy runtime state protocol is invalid");
  }
  return value;
}

async function loadCapability(path, { allowMissing = false } = {}) {
  if (!(await pathState(path)) && allowMissing) return null;
  return validateCapability(await readPrivateJson(path, "proxy capability"));
}

async function ensureCapability(options) {
  const current = await loadCapability(options.proxyCapability, { allowMissing: true });
  if (current) return current;
  const capability = {
    schema: 1,
    kind: CAPABILITY_KIND,
    created_at: new Date().toISOString(),
    token: randomBytes(32).toString("base64url")
  };
  await writeJsonAtomic(options.proxyCapability, capability);
  return capability;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function healthUrl(state) {
  const host = state.host === "::1" ? "[::1]" : state.host;
  return `http://${host}:${state.port}/__agentctl/health`;
}

async function healthCheck(state, capability, timeoutMs = 1200) {
  if (!capability) return { healthy: false, reason: "capability_missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(healthUrl(state), {
      headers: { "x-agentctl-proxy-token": capability.token },
      signal: controller.signal
    });
    if (!response.ok) return { healthy: false, reason: `http_${response.status}` };
    const body = await response.json();
    if (body?.kind !== "agentctl-proxy-health" || body.instance_id !== state.instance_id) {
      return { healthy: false, reason: "instance_mismatch" };
    }
    return { healthy: true, body };
  } catch {
    return { healthy: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectStatus(options) {
  const capability = await loadCapability(options.proxyCapability, { allowMissing: true });
  const stateDetails = await pathState(options.proxyState);
  if (!stateDetails) {
    const lock = await readLock(options);
    if (lock) {
      const alive = processAlive(lock.pid);
      return {
        schema: 1,
        status: alive ? "starting" : "stale",
        running: false,
        process_alive: alive,
        health: alive ? "state_pending" : "process_not_running",
        capability_present: Boolean(capability),
        capability_file: options.proxyCapability,
        state_file: options.proxyState,
        metadata_log: options.proxyLog,
        runtime_log: options.proxyRuntimeLog,
        instance_id: lock.instance_id,
        pid: lock.pid
      };
    }
    return {
      schema: 1,
      status: "stopped",
      running: false,
      capability_present: Boolean(capability),
      capability_file: options.proxyCapability,
      state_file: options.proxyState,
      metadata_log: options.proxyLog,
      runtime_log: options.proxyRuntimeLog
    };
  }
  const state = validateState(await readPrivateJson(options.proxyState, "proxy runtime state"));
  const alive = processAlive(state.pid);
  const health = alive
    ? await healthCheck(state, capability)
    : { healthy: false, reason: "process_not_running" };
  return {
    schema: 1,
    status: health.healthy ? "running" : "stale",
    running: health.healthy,
    process_alive: alive,
    health: health.healthy ? "healthy" : health.reason,
    capability_present: Boolean(capability),
    capability_file: options.proxyCapability,
    state_file: options.proxyState,
    metadata_log: options.proxyLog,
    runtime_log: options.proxyRuntimeLog,
    instance_id: state.instance_id,
    pid: state.pid,
    started_at: state.started_at,
    host: state.host,
    port: state.port,
    profile: state.profile,
    target: state.target,
    protocol: state.protocol,
    local_base_url: localBaseUrl(state.host, state.port, state.protocol)
  };
}

function emitStatus(status, options) {
  if (options.json) return process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.stdout.write(`Proxy:      ${status.status}\n`);
  if (status.profile) process.stdout.write(`Profile:    ${status.profile} (${status.target})\n`);
  if (status.local_base_url) process.stdout.write(`Local URL:  ${status.local_base_url}\n`);
  if (status.pid) process.stdout.write(`PID:        ${status.pid}\n`);
  process.stdout.write(`Capability: ${status.capability_present ? "present" : "missing"} (${status.capability_file})\n`);
  process.stdout.write(`Metadata:   ${status.metadata_log}\n`);
}

async function status(options) {
  const current = await inspectStatus(options);
  emitStatus(current, options);
  if (current.status === "stale") process.exitCode = 1;
  return current;
}

function localBaseUrl(host, port, protocol) {
  const address = host === "::1" ? `[${host}]` : host;
  const root = `http://${address}:${port}`;
  if (["openai_responses", "openai_chat"].includes(protocol)) return `${root}/v1`;
  if (protocol === "google_generative") return `${root}/v1beta`;
  return root;
}

async function buildPlan(profileName, options) {
  validateProfileName(profileName);
  if (!options.target) throw new ProxyClientError("proxy plan/start requires --target");
  validateTarget(options.target);
  const platform = options.platform || normalizeRuntimePlatform();
  validatePlatform(platform);
  const [store, secrets] = await Promise.all([
    loadProviderStore(options.storePath),
    loadProviderSecrets(options.secretsPath, { allowMissing: true })
  ]);
  const profile = store.profiles[profileName];
  if (!profile) throw new ProxyClientError(`provider profile not found: ${profileName}`);
  const resolved = resolveProviderProfile(profile, { target: options.target, platform });
  const secretPresent = resolved.auth.mode === "none" ||
    Boolean(secrets.secrets[resolved.auth.secret]);
  const direct = renderProviderPlan(resolved, { secretPresent });
  return {
    schema: 1,
    action: "start",
    ready: direct.enabled && direct.ready,
    issue: !direct.enabled ? `${options.target} is disabled by the profile` : direct.issue,
    profile: profileName,
    target: options.target,
    platform,
    protocol: resolved.protocol,
    endpoint: resolved.endpoint,
    auth: {
      mode: resolved.auth.mode,
      secret: resolved.auth.secret || null,
      present: secretPresent
    },
    listen: { host: "127.0.0.1", port: options.port },
    local_base_url: localBaseUrl("127.0.0.1", options.port, resolved.protocol),
    timeouts: {
      first_byte_ms: options.firstByteMs,
      stream_idle_ms: options.streamIdleMs,
      request_ms: options.requestMs
    },
    limits: {
      request_bytes: options.requestBytes,
      log_bytes: options.logBytes
    },
    auto_attach: false,
    capability_file: options.proxyCapability,
    metadata_log: options.proxyLog
  };
}

function emitPlan(plan, options, apply) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, preview: !apply }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${apply ? "[apply]" : "[preview]"} loopback provider proxy\n`);
  process.stdout.write(`  Profile      : ${plan.profile} (${plan.target}; ${plan.platform})\n`);
  process.stdout.write(`  Protocol     : ${plan.protocol}\n`);
  process.stdout.write(`  Upstream     : ${plan.endpoint}\n`);
  process.stdout.write(`  Local URL    : ${plan.local_base_url}\n`);
  process.stdout.write(`  Capability   : ${plan.capability_file} (value hidden)\n`);
  process.stdout.write(`  Request log  : metadata only; ${plan.metadata_log}\n`);
  process.stdout.write("  Client config: unchanged (explicit attach comes later)\n");
  if (plan.issue) process.stdout.write(`  Blocked by   : ${plan.issue}\n`);
  if (!apply && plan.ready) process.stdout.write("Re-run with --yes to start.\n");
}

async function readLock(options) {
  if (!(await pathState(options.proxyLock))) return null;
  const lock = await readPrivateJson(options.proxyLock, "proxy runtime lock");
  const keys = ["schema", "kind", "instance_id", "pid", "created_at"];
  if (!lock || lock.schema !== 1 || lock.kind !== LOCK_KIND ||
      typeof lock.instance_id !== "string" || !/^[a-f0-9-]{36}$/.test(lock.instance_id) ||
      !Number.isInteger(lock.pid) || lock.pid < 1 ||
      typeof lock.created_at !== "string" || Number.isNaN(Date.parse(lock.created_at)) ||
      Object.keys(lock).some((key) => !keys.includes(key))) {
    throw new ProxyClientError("proxy runtime lock is invalid");
  }
  return lock;
}

async function clearDeadRuntime(options) {
  const current = await inspectStatus(options);
  if (current.running) throw new ProxyClientError("proxy is already running");
  if (current.process_alive) {
    throw new ProxyClientError(
      "proxy state belongs to a live but unhealthy process; refusing to replace or signal it"
    );
  }
  const lock = await readLock(options);
  if (lock && processAlive(lock.pid)) {
    throw new ProxyClientError("proxy runtime lock belongs to a live process");
  }
  for (const path of [options.proxyState, options.proxyLock]) {
    const details = await pathState(path);
    if (details?.isSymbolicLink() || (details && !details.isFile())) {
      throw new ProxyClientError(`refusing to remove non-regular stale runtime path: ${path}`);
    }
    if (details) await unlink(path);
  }
}

function daemonConfig(plan, options) {
  return {
    schema: 1,
    kind: CONFIG_KIND,
    instance_id: randomUUID(),
    created_at: new Date().toISOString(),
    profile: plan.profile,
    target: plan.target,
    platform: plan.platform,
    protocol: plan.protocol,
    endpoint: plan.endpoint,
    auth: { mode: plan.auth.mode, secret: plan.auth.secret },
    listen: plan.listen,
    timeouts: plan.timeouts,
    limits: plan.limits,
    paths: {
      state: options.proxyState,
      lock: options.proxyLock,
      capability: options.proxyCapability,
      secrets: options.secretsPath,
      log: options.proxyLog,
      runtime_log: options.proxyRuntimeLog
    }
  };
}

async function waitForStart(config, capability, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = validateState(await readPrivateJson(config.paths.state, "proxy runtime state"));
      if (state.instance_id === config.instance_id) {
        const health = await healthCheck(state, capability, 500);
        if (health.healthy) return state;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new ProxyClientError(
    `proxy did not become healthy; inspect lifecycle diagnostics at ${config.paths.runtime_log}`
  );
}

async function start(profileName, options) {
  const plan = await buildPlan(profileName, options);
  if (!(options.json && options.yes)) emitPlan(plan, options, options.yes);
  if (!plan.ready) throw new ProxyClientError(plan.issue || "proxy plan is blocked");
  if (!options.yes) return plan;
  if (options.platform && options.platform !== normalizeRuntimePlatform()) {
    throw new ProxyClientError(
      `cannot start the ${options.platform} proxy overlay on ${normalizeRuntimePlatform()}`
    );
  }
  await clearDeadRuntime(options);
  const daemonDetails = await pathState(options.daemonPath);
  if (!daemonDetails || daemonDetails.isSymbolicLink() || !daemonDetails.isFile()) {
    throw new ProxyClientError(`proxy daemon is missing: ${options.daemonPath}`);
  }
  const capability = await ensureCapability(options);
  const config = daemonConfig(plan, options);
  await writeJsonAtomic(options.proxyConfig, config);
  await mkdir(dirname(options.proxyRuntimeLog), { recursive: true, mode: 0o700 });
  const runtimeLogDetails = await pathState(options.proxyRuntimeLog);
  if (runtimeLogDetails?.isSymbolicLink() ||
      (runtimeLogDetails && !runtimeLogDetails.isFile())) {
    throw new ProxyClientError(
      `proxy runtime log must be a regular non-symlink file: ${options.proxyRuntimeLog}`
    );
  }
  const descriptor = openSync(options.proxyRuntimeLog, "a", 0o600);
  await chmod(options.proxyRuntimeLog, 0o600);
  let child;
  try {
    child = spawn(process.execPath, [options.daemonPath, "--config", options.proxyConfig], {
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: { ...process.env }
    });
    child.unref();
  } finally {
    closeSync(descriptor);
  }
  let state;
  try {
    state = await waitForStart(config, capability);
  } catch (error) {
    if (child?.pid && processAlive(child.pid)) {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    throw error;
  }
  const output = {
    ok: true,
    status: "running",
    profile: plan.profile,
    target: plan.target,
    protocol: plan.protocol,
    local_base_url: plan.local_base_url,
    pid: state.pid,
    capability_file: options.proxyCapability,
    auto_attach: false
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(
    `Proxy is healthy at ${plan.local_base_url}; client configuration was not changed.\n`
  );
  return output;
}

async function waitForStop(pid, statePath, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid) && !(await pathState(statePath))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new ProxyClientError("proxy did not stop cleanly; no stronger signal was sent");
}

async function stop(options) {
  const current = await inspectStatus(options);
  if (current.status === "stopped") {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, changed: false, status: "stopped" }, null, 2)}\n`);
    else process.stdout.write("Proxy is already stopped.\n");
    return;
  }
  if (current.status === "starting") {
    throw new ProxyClientError(
      "proxy process is still starting and has no verified health identity; wait and retry"
    );
  }
  if (current.status === "stale") {
    if (current.process_alive) {
      throw new ProxyClientError(
        "proxy health identity could not be verified; refusing to signal the live process"
      );
    }
    if (!options.yes) {
      if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, preview: true, action: "clean_stale_state" }, null, 2)}\n`);
      else process.stdout.write("[preview] remove dead proxy state/lock; re-run with --yes.\n");
      return;
    }
    await clearDeadRuntime(options);
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, changed: true, status: "stopped" }, null, 2)}\n`);
    else process.stdout.write("Removed stale proxy runtime state.\n");
    return;
  }
  if (!options.yes) {
    if (options.json) process.stdout.write(`${JSON.stringify({
      ok: true,
      preview: true,
      action: "stop",
      instance_id: current.instance_id,
      pid: current.pid
    }, null, 2)}\n`);
    else process.stdout.write(`[preview] stop verified proxy PID ${current.pid}; re-run with --yes.\n`);
    return;
  }
  process.kill(current.pid, "SIGTERM");
  await waitForStop(current.pid, options.proxyState);
  const output = { ok: true, changed: true, status: "stopped" };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write("Proxy stopped cleanly.\n");
}

async function token(action, options) {
  const existing = await loadCapability(options.proxyCapability, { allowMissing: true });
  if (action === "status") {
    const output = {
      schema: 1,
      present: Boolean(existing),
      created_at: existing?.created_at || null,
      file: options.proxyCapability,
      value: "hidden"
    };
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stdout.write(`Proxy capability: ${output.present ? "present" : "missing"} (${output.file}; value hidden)\n`);
    return;
  }
  if (action !== "rotate") throw new ProxyClientError("proxy token requires status or rotate");
  const current = await inspectStatus(options);
  if (current.status !== "stopped") {
    throw new ProxyClientError("stop and clean the proxy before rotating its client capability");
  }
  if (!options.yes) {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, preview: true, action: "rotate_capability", file: options.proxyCapability }, null, 2)}\n`);
    else process.stdout.write(`[preview] rotate hidden proxy capability at ${options.proxyCapability}; re-run with --yes.\n`);
    return;
  }
  const next = {
    schema: 1,
    kind: CAPABILITY_KIND,
    created_at: new Date().toISOString(),
    token: randomBytes(32).toString("base64url")
  };
  await writeJsonAtomic(options.proxyCapability, next);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, changed: true, file: options.proxyCapability, value: "hidden" }, null, 2)}\n`);
  else process.stdout.write(`Rotated proxy capability at ${options.proxyCapability}; value remains hidden.\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseProxyArguments(argv);
  if (options.help || !positional.length) return usage();
  const action = positional.shift();
  if (action === "plan" && positional.length === 1) {
    const plan = await buildPlan(positional[0], options);
    emitPlan(plan, options, false);
    if (!plan.ready) process.exitCode = 1;
    return plan;
  }
  if (action === "start" && positional.length === 1) return start(positional[0], options);
  if (action === "status" && positional.length === 0) return status(options);
  if (action === "stop" && positional.length === 0) return stop(options);
  if (action === "token" && positional.length === 1) return token(positional[0], options);
  throw new ProxyClientError("invalid proxy command; use agentctl proxy --help");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safe = error instanceof ProxyClientError || error instanceof ProviderSchemaError ||
      error instanceof ProviderRendererError
      ? error.message
      : "unexpected proxy controller failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export { CAPABILITY_KIND, CONFIG_KIND, LOCK_KIND, STATE_KIND };
