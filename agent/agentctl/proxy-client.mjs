#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../module-entry.mjs";
import {
  ProviderSchemaError,
  effectiveProviderCompaction,
  normalizeRuntimePlatform,
  resolveProviderProfile,
  validateEndpoint,
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
  assertApplyPlatform,
  backendArguments,
  managedTargetPaths,
  proxyCompatibilityIssue,
  renderProviderPlan,
  targetPaths
} from "./provider-renderer.mjs";
import { bashScriptCommand } from "../platform-command.mjs";
import {
  PricingClientError,
  loadPricingCatalog,
  pricingDefaults
} from "./pricing-client.mjs";
import { PricingError } from "../pricing/pricing.mjs";
import {
  FailoverClientError,
  failoverDefaults,
  loadFailoverStore
} from "./failover-client.mjs";
import {
  FailoverSchemaError,
  resolveFailoverRoute
} from "./failover-schema.mjs";
import {
  OPENAI_SUBSCRIPTION_ENDPOINT as DEFAULT_OPENAI_SUBSCRIPTION_ENDPOINT,
  OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH,
  PASSTHROUGH_MODE,
  PROVIDER_MODE,
  PROXY_CAPABILITY_KIND as CAPABILITY_KIND,
  PROXY_CONFIG_KIND as CONFIG_KIND,
  PROXY_CONFIG_SCHEMA,
  PROXY_LOCK_KIND as LOCK_KIND,
  PROXY_STATE_KIND as STATE_KIND,
  ProxySchemaError,
  validateProxyCapability,
  validateProxyConfig,
  validateProxyInstance,
  validateProxyState
} from "../proxy/schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DAEMON = resolve(HERE, "..", "proxy", "agentproxyd.mjs");
const ATTACHMENT_KIND = "agentctl-proxy-attachment";
const PASSTHROUGH_PROFILE = "passthrough";
const CONNECTION_KIND = "agentctl-proxy-connection";
const ATTACH_START = "# >>> agentctl proxy attach >>>";
const ATTACH_END = "# <<< agentctl proxy attach <<<";
const MAX_USAGE_LOG_FILES = 20;
const MAX_USAGE_READ_BYTES = 128 * 1024 * 1024;
const USAGE_MONEY_SCALE_DIGITS = 12;
const USAGE_MONEY_SCALE = 10n ** BigInt(USAGE_MONEY_SCALE_DIGITS);

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
  agentctl proxy usage [--last <count>] [--json]
  agentctl proxy usage --summary [--last <count>] [--json]
  agentctl proxy connect <target> [--force] [--yes]
  agentctl proxy disconnect <target> [--yes]
  agentctl proxy stop [--yes]
  agentctl proxy attach [--yes]
  agentctl proxy detach [--yes]
  agentctl proxy token <status|rotate> [--yes] [--json]

Options:
  --instance <name>                  Independent proxy instance (default: default).
  --platform <platform>             Overlay to inspect (apply requires current OS).
  --port <1024-65535>               Loopback port (default: 17321).
  --first-byte-timeout-ms <ms>      Upstream response-header timeout.
  --stream-idle-timeout-ms <ms>     Maximum gap between streaming chunks.
  --request-timeout-ms <ms>         Total non-streaming request timeout.
  --request-body-timeout-ms <ms>    Maximum time to receive one request body.
  --request-bytes <bytes>           Maximum request body (default: 16 MiB).
  --max-concurrent-requests <count> Admission limit (default: 64).
  --max-inflight-request-bytes <bytes>
                                      Global buffered-request limit (default: 64 MiB).
  --log-bytes <bytes>               Metadata log rotation threshold.
  --usage-log-bytes <bytes>         Usage log rotation threshold.
  --usage-capture-bytes <bytes>     Bounded response metadata collector size.
  --pricing <file>                  Optional versioned pricing catalog.
  --pricing-source <request|response>
                                      Model identity used for pricing.
  --route <name>                     Optional ordered failover route.
  --failover-store <file>            Portable failover route Store.
  --circuit-state <file>             Device-local circuit counters/state.
  --retention-files <1-20>           Active + rotated files per JSONL log.
  --retention-days <1-365>           Maximum rotated-log age.
  --last <1-1000>                    Recent usage rows to show/summarize.
  --summary                          Aggregate retained usage by model/tier.
  --store <file>                    Portable Provider Store.
  --secrets <file>                  Local provider Secret Store.
  --proxy-config <file>             Generated device-local daemon config.
  --proxy-state <file>              Device-local runtime state.
  --proxy-lock <file>               Device-local runtime ownership lock.
  --proxy-capability <file>         Owner-only local client capability.
  --proxy-log <file>                Request metadata JSONL (never bodies/headers).
  --proxy-usage-log <file>          Model/token/cost JSONL (never content).
  --proxy-runtime-log <file>        Daemon lifecycle diagnostics.
  --upstream-base-url <url>         Passthrough upstream (advanced/testing).
  --codex-config <file>             Codex config.toml managed by attach/detach.
  --proxy-attach-state <file>       Exact-restore attachment metadata.
  --proxy-attach-backup <file>      Owner-only pre-attach Codex backup.
  --proxy-connect-state <file>      Provider-mode client connection metadata.
  --proxy-connect-backup <dir>      Exact pre-connect target backups.
  --force                           Replace an external target provider config.
  --yes, -y                         Apply start/stop/token mutation.

Use the reserved profile 'passthrough' with --target codex to observe an
official ChatGPT-subscription session without replacing its OpenAI bearer token,
account header, model, or body. start never edits client configuration; attach
and detach handle subscription observation, while connect and disconnect handle
Provider mode. All client mutations are preview-first, exact-restore operations.
`);
}

function instancePort(instance) {
  if (instance === "default") return 17321;
  let hash = 2166136261;
  for (const character of instance) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return 20000 + (hash % 20000);
}

export function proxyDefaults({
  platform = process.platform,
  environment = process.env,
  home = homedir(),
  instance = environment.AGENTCTL_PROXY_INSTANCE || "default"
} = {}) {
  validateProxyInstance(instance);
  const providers = providerDefaults({ platform, environment, home });
  const pricing = pricingDefaults({ platform, environment, home });
  const failover = failoverDefaults({ platform, environment, home });
  const legacyStateRoot = join(dirname(providers.statePath), "proxy");
  const stateRoot = instance === "default"
    ? legacyStateRoot
    : join(legacyStateRoot, "instances", instance);
  const configRoot = dirname(providers.storePath);
  const codexRoot = environment.CODEX_HOME || join(home, ".codex");
  const envPort = Number(environment.AGENTCTL_PROXY_PORT || instancePort(instance));
  return {
    ...providers,
    instance,
    daemonPath: environment.AGENTCTL_PROXY_DAEMON || DEFAULT_DAEMON,
    proxyConfig: environment.AGENTCTL_PROXY_CONFIG || join(stateRoot, "config.json"),
    proxyState: environment.AGENTCTL_PROXY_STATE || join(stateRoot, "state.json"),
    proxyLock: environment.AGENTCTL_PROXY_LOCK || join(stateRoot, "runtime.lock"),
    proxyCapability: environment.AGENTCTL_PROXY_CAPABILITY || (instance === "default"
      ? join(configRoot, "proxy-capability.json")
      : join(configRoot, "proxy-capabilities", `${instance}.json`)),
    proxyLog: environment.AGENTCTL_PROXY_LOG || join(stateRoot, "requests.jsonl"),
    proxyUsageLog: environment.AGENTCTL_PROXY_USAGE_LOG ||
      join(stateRoot, "usage.jsonl"),
    proxyRuntimeLog: environment.AGENTCTL_PROXY_RUNTIME_LOG ||
      join(stateRoot, "daemon.log"),
    proxyCircuitState: environment.AGENTCTL_PROXY_CIRCUIT_STATE ||
      join(stateRoot, "circuits.json"),
    proxyAttachState: environment.AGENTCTL_PROXY_ATTACH_STATE ||
      join(stateRoot, "attachment.json"),
    proxyAttachBackup: environment.AGENTCTL_PROXY_ATTACH_BACKUP ||
      join(stateRoot, "codex-config.before-attach.toml"),
    proxyConnectState: environment.AGENTCTL_PROXY_CONNECT_STATE ||
      join(stateRoot, "connection.json"),
    proxyConnectBackup: environment.AGENTCTL_PROXY_CONNECT_BACKUP ||
      join(stateRoot, "connection-backups"),
    codexConfig: environment.AGENTCTL_CODEX_CONFIG || join(codexRoot, "config.toml"),
    upstreamBaseUrl: environment.AGENTCTL_PROXY_UPSTREAM_BASE_URL ||
      DEFAULT_OPENAI_SUBSCRIPTION_ENDPOINT,
    port: Number.isInteger(envPort) ? envPort : instancePort(instance),
    firstByteMs: 30000,
    streamIdleMs: 120000,
    requestMs: 300000,
    requestBodyMs: 30000,
    requestBytes: 16 * 1024 * 1024,
    maxConcurrentRequests: 64,
    maxInflightRequestBytes: 64 * 1024 * 1024,
    logBytes: 5 * 1024 * 1024,
    usageLogBytes: 5 * 1024 * 1024,
    usageCaptureBytes: 2 * 1024 * 1024,
    pricingPath: pricing.pricingPath,
    pricingSource: "response",
    failoverPath: failover.failoverPath,
    retentionFiles: 5,
    retentionDays: 30
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

export function parseProxyArguments(argv, defaults) {
  argv = [...argv];
  const instanceOptions = argv.flatMap((value, index) =>
    value === "--instance" && index + 1 < argv.length ? [argv[index + 1]] : []
  );
  if (new Set(instanceOptions).size > 1) {
    throw new ProxyClientError("--instance must name one consistent proxy instance");
  }
  if (defaults === undefined) {
    defaults = proxyDefaults(instanceOptions.length ? { instance: instanceOptions[0] } : {});
  } else if (instanceOptions.length && defaults.instance !== instanceOptions[0]) {
    throw new ProxyClientError(
      "explicit proxy defaults must be created for the requested --instance"
    );
  }
  const options = {
    ...defaults,
    yes: false,
    force: false,
    json: false,
    summary: false,
    platform: undefined
  };
  const positional = [];
  while (argv.length) {
    const argument = argv.shift();
    switch (argument) {
      case "--store": options.storePath = takeValue(argv, argument); break;
      case "--instance": options.instance = takeValue(argv, argument); break;
      case "--secrets": options.secretsPath = takeValue(argv, argument); break;
      case "--proxy-config": options.proxyConfig = takeValue(argv, argument); break;
      case "--proxy-state": options.proxyState = takeValue(argv, argument); break;
      case "--proxy-lock": options.proxyLock = takeValue(argv, argument); break;
      case "--proxy-capability": options.proxyCapability = takeValue(argv, argument); break;
      case "--proxy-log": options.proxyLog = takeValue(argv, argument); break;
      case "--proxy-usage-log": options.proxyUsageLog = takeValue(argv, argument); break;
      case "--proxy-runtime-log": options.proxyRuntimeLog = takeValue(argv, argument); break;
      case "--proxy-attach-state": options.proxyAttachState = takeValue(argv, argument); break;
      case "--proxy-attach-backup": options.proxyAttachBackup = takeValue(argv, argument); break;
      case "--proxy-connect-state": options.proxyConnectState = takeValue(argv, argument); break;
      case "--proxy-connect-backup": options.proxyConnectBackup = takeValue(argv, argument); break;
      case "--codex-config": options.codexConfig = takeValue(argv, argument); break;
      case "--upstream-base-url": options.upstreamBaseUrl = takeValue(argv, argument); break;
      case "--pricing": options.pricingPath = takeValue(argv, argument); break;
      case "--pricing-source": options.pricingSource = takeValue(argv, argument); break;
      case "--route": options.route = takeValue(argv, argument); break;
      case "--failover-store": options.failoverPath = takeValue(argv, argument); break;
      case "--circuit-state": options.proxyCircuitState = takeValue(argv, argument); break;
      case "--platform": options.platform = takeValue(argv, argument); break;
      case "--target": options.target = takeValue(argv, argument); break;
      case "--port": options.port = integerOption(argv, argument, 1024, 65535); break;
      case "--first-byte-timeout-ms":
        options.firstByteMs = integerOption(argv, argument, 100, 600000); break;
      case "--stream-idle-timeout-ms":
        options.streamIdleMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--request-timeout-ms":
        options.requestMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--request-body-timeout-ms":
        options.requestBodyMs = integerOption(argv, argument, 1000, 3600000); break;
      case "--request-bytes":
        options.requestBytes = integerOption(argv, argument, 1024, 64 * 1024 * 1024); break;
      case "--log-bytes":
        options.logBytes = integerOption(argv, argument, 65536, 100 * 1024 * 1024); break;
      case "--usage-log-bytes":
        options.usageLogBytes = integerOption(argv, argument, 65536, 100 * 1024 * 1024); break;
      case "--usage-capture-bytes":
        options.usageCaptureBytes = integerOption(argv, argument, 1024, 16 * 1024 * 1024); break;
      case "--max-concurrent-requests":
        options.maxConcurrentRequests = integerOption(argv, argument, 1, 1024); break;
      case "--max-inflight-request-bytes":
        options.maxInflightRequestBytes = integerOption(
          argv, argument, 1024, 1024 * 1024 * 1024
        ); break;
      case "--retention-files":
        options.retentionFiles = integerOption(argv, argument, 1, 20); break;
      case "--retention-days":
        options.retentionDays = integerOption(argv, argument, 1, 365); break;
      case "--last": options.last = integerOption(argv, argument, 1, 1000); break;
      case "--summary": options.summary = true; break;
      case "--yes":
      case "-y": options.yes = true; break;
      case "--force": options.force = true; break;
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
    "proxyLock", "proxyCapability", "proxyLog", "proxyUsageLog",
    "proxyRuntimeLog", "proxyCircuitState", "pricingPath", "failoverPath",
    "proxyAttachState", "proxyAttachBackup", "proxyConnectState",
    "proxyConnectBackup", "codexConfig"
  ]) options[key] = resolve(options[key]);
  validateProxyInstance(options.instance);
  options.upstreamBaseUrl = validateEndpoint(
    options.upstreamBaseUrl,
    "--upstream-base-url"
  );
  if (new Set([
    options.codexConfig,
    options.proxyAttachState,
    options.proxyAttachBackup
  ]).size !== 3) {
    throw new ProxyClientError(
      "Codex config, attachment state, and attachment backup paths must be distinct"
    );
  }
  const deviceLocalPaths = [
    options.proxyConfig,
    options.proxyState,
    options.proxyLock,
    options.proxyCapability,
    options.proxyLog,
    options.proxyUsageLog,
    options.proxyRuntimeLog,
    options.proxyCircuitState,
    options.proxyAttachState,
    options.proxyAttachBackup,
    options.proxyConnectState,
    options.proxyConnectBackup
  ];
  if (new Set(deviceLocalPaths).size !== deviceLocalPaths.length) {
    throw new ProxyClientError("proxy device-local config, state, backup, and log paths must be distinct");
  }
  if (!["request", "response"].includes(options.pricingSource)) {
    throw new ProxyClientError("--pricing-source must be request or response");
  }
  if (options.maxInflightRequestBytes < options.requestBytes) {
    throw new ProxyClientError(
      "--max-inflight-request-bytes must be at least --request-bytes"
    );
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

async function writeBytesAtomic(path, bytes, mode = 0o600) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const existing = await pathState(path);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new ProxyClientError(`refusing to replace non-regular path: ${path}`);
  }
  const temporary = join(parent, `.${path.split(/[\\/]/).pop()}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCodexConfig(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProxyClientError("Codex config must be valid UTF-8 TOML");
  }
}

function codexConfigNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function codexManagedBlock(localBaseUrl, newline) {
  return [
    ATTACH_START,
    "# Pure observation: Codex keeps official ChatGPT authentication; only the base URL changes.",
    'model_provider = "openai"',
    `openai_base_url = ${JSON.stringify(localBaseUrl)}`,
    ATTACH_END
  ].join(newline);
}

function disabledCodexManagedBlock(localBaseUrl, newline, separator = "") {
  const assignment = `openai_base_url = ${JSON.stringify(localBaseUrl)}`;
  return codexManagedBlock(localBaseUrl, newline).replace(
    assignment,
    `#${separator}${assignment}`
  );
}

function topLevelManagedAssignments(text) {
  const assignments = [];
  let inTable = false;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*\[/.test(line)) inTable = true;
    if (!inTable && /^\s*(?:model_provider|openai_base_url)\s*=/.test(line)) {
      assignments.push({ index, line });
    }
  }
  return assignments;
}

function inspectCodexManagedBlock(bytes, localBaseUrl) {
  const text = decodeCodexConfig(bytes);
  const newline = codexConfigNewline(text);
  const candidates = [
    { block: codexManagedBlock(localBaseUrl, newline), intact: true, disabled: false },
    { block: disabledCodexManagedBlock(localBaseUrl, newline), intact: false, disabled: true },
    { block: disabledCodexManagedBlock(localBaseUrl, newline, " "), intact: false, disabled: true }
  ];
  const candidate = candidates.find(({ block }) => text.startsWith(`${block}${newline}`));
  if (!candidate) {
    return { intact: false, reason: "managed_block_changed" };
  }
  const prefix = `${candidate.block}${newline}`;
  const retained = text.slice(prefix.length);
  if (retained.includes(ATTACH_START) || retained.includes(ATTACH_END) ||
      topLevelManagedAssignments(retained).length) {
    return { intact: false, reason: "managed_settings_duplicated" };
  }
  return {
    intact: candidate.intact,
    disabled: candidate.disabled,
    recoverable: true,
    newline,
    retained
  };
}

function restoreOriginalManagedAssignments(originalText, retainedText, newline) {
  const originalLines = originalText.split(/\r?\n/);
  const managed = topLevelManagedAssignments(originalText);
  if (!managed.length) return retainedText;

  const managedIndexes = new Set(managed.map(({ index }) => index));
  const firstManaged = managed[0].index;
  const lastManaged = managed.at(-1).index;
  const retainedLines = retainedText.split(/\r?\n/);
  let insertion = -1;

  // Prefer the next unchanged line from the original top-level document. This
  // keeps comments immediately preceding the managed assignments in place.
  for (let index = lastManaged + 1; index < originalLines.length; index += 1) {
    const line = originalLines[index];
    if (managedIndexes.has(index) || !line.trim()) continue;
    insertion = retainedLines.indexOf(line);
    if (insertion !== -1) break;
  }
  if (insertion === -1) {
    for (let index = firstManaged - 1; index >= 0; index -= 1) {
      const line = originalLines[index];
      if (managedIndexes.has(index) || !line.trim()) continue;
      const found = retainedLines.lastIndexOf(line);
      if (found !== -1) {
        insertion = found + 1;
        break;
      }
    }
  }
  if (insertion === -1) insertion = 0;
  retainedLines.splice(insertion, 0, ...managed.map(({ line }) => line));
  return retainedLines.join(newline);
}

function mergeCodexDetach(originalBytes, attachedBytes, currentBytes, localBaseUrl) {
  const managed = inspectCodexManagedBlock(currentBytes, localBaseUrl);
  if (!managed.intact && !managed.disabled) {
    throw new ProxyClientError(
      "Codex proxy-managed settings changed after attach; refusing to detach"
    );
  }

  // Codex App normally appends project trust records. Preserve that common
  // case byte-for-byte while restoring the entire original prefix exactly.
  if (currentBytes.length >= attachedBytes.length &&
      currentBytes.subarray(0, attachedBytes.length).equals(attachedBytes)) {
    return Buffer.concat([
      originalBytes,
      currentBytes.subarray(attachedBytes.length)
    ]);
  }

  const originalText = decodeCodexConfig(originalBytes);
  return Buffer.from(restoreOriginalManagedAssignments(
    originalText,
    managed.retained,
    managed.newline
  ), "utf8");
}

async function readConfigSnapshot(path, { allowMissing = false } = {}) {
  const details = await pathState(path);
  if (!details) {
    if (allowMissing) return null;
    throw new ProxyClientError(`Codex config not found: ${path}`);
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > 1024 * 1024) {
    throw new ProxyClientError("Codex config must be a small regular non-symlink file");
  }
  return {
    bytes: await readFile(path),
    mode: details.mode & 0o777
  };
}

function renderCodexAttachment(original, localBaseUrl) {
  const text = decodeCodexConfig(original);
  if (text.includes(ATTACH_START) || text.includes(ATTACH_END)) {
    throw new ProxyClientError(
      "Codex config already contains an agentctl attachment marker; detach or repair it first"
    );
  }
  const newline = codexConfigNewline(text);
  let inTable = false;
  const retained = text.split(/\r?\n/).filter((line) => {
    if (/^\s*\[/.test(line)) inTable = true;
    return inTable || !/^\s*(?:model_provider|openai_base_url)\s*=/.test(line);
  }).join(newline).replace(/^\s+/, "");
  const managed = codexManagedBlock(localBaseUrl, newline);
  return Buffer.from(`${managed}${newline}${retained}`, "utf8");
}

function validateAttachment(value) {
  const keys = [
    "schema", "kind", "created_at", "mode", "target", "proxy_instance_id",
    "local_base_url", "config_file", "backup_file", "config_existed",
    "original_mode", "original_sha256", "attached_sha256"
  ];
  const hash = (candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  if (!value || value.schema !== 1 || value.kind !== ATTACHMENT_KIND ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
      value.mode !== PASSTHROUGH_MODE || value.target !== "codex" ||
      typeof value.proxy_instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.proxy_instance_id) ||
      typeof value.local_base_url !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+(?:\/backend-api\/codex\/realtime)?$/.test(value.local_base_url) ||
      typeof value.config_file !== "string" || !isAbsolute(value.config_file) ||
      typeof value.backup_file !== "string" || !isAbsolute(value.backup_file) ||
      typeof value.config_existed !== "boolean" ||
      !Number.isInteger(value.original_mode) || value.original_mode < 0 ||
      value.original_mode > 0o777 || !hash(value.original_sha256) ||
      !hash(value.attached_sha256) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ProxyClientError("proxy attachment state is invalid");
  }
  return value;
}

async function loadAttachment(options, { allowMissing = false } = {}) {
  if (!(await pathState(options.proxyAttachState))) {
    if (allowMissing) return null;
    throw new ProxyClientError("Codex is not attached to the proxy");
  }
  const attachment = validateAttachment(
    await readPrivateJson(options.proxyAttachState, "proxy attachment state")
  );
  if (attachment.config_file !== options.codexConfig ||
      attachment.backup_file !== options.proxyAttachBackup) {
    throw new ProxyClientError(
      "attachment paths differ from the requested paths; use the same attach options"
    );
  }
  return attachment;
}

async function inspectAttachment(options) {
  const attachment = await loadAttachment(options, { allowMissing: true });
  if (!attachment) return { status: "detached", attached: false };
  let currentHash = null;
  let status = "modified";
  let configModified = null;
  let managedFieldsIntact = false;
  let managedFieldsRecoverable = false;
  try {
    const snapshot = await readConfigSnapshot(attachment.config_file);
    currentHash = sha256(snapshot.bytes);
    configModified = currentHash !== attachment.attached_sha256;
    const managed = inspectCodexManagedBlock(snapshot.bytes, attachment.local_base_url);
    managedFieldsIntact = currentHash === attachment.attached_sha256 || managed.intact;
    managedFieldsRecoverable = managedFieldsIntact || managed.recoverable === true;
    if (managedFieldsIntact) status = "attached";
    else if (managed.disabled) status = "disabled";
    snapshot.bytes.fill(0);
  } catch {}
  return {
    status,
    attached: true,
    config_file: attachment.config_file,
    backup_file: attachment.backup_file,
    local_base_url: attachment.local_base_url,
    attached_at: attachment.created_at,
    config_modified: configModified,
    managed_fields_intact: managedFieldsIntact,
    managed_fields_recoverable: managedFieldsRecoverable,
    current_sha256: currentHash,
    expected_sha256: attachment.attached_sha256
  };
}

function connectionAuthMode(target, protocol) {
  if (protocol === "anthropic_messages") return "x-api-key";
  if (protocol === "google_generative") return "x-goog-api-key";
  if (["openai_responses", "openai_chat"].includes(protocol)) return "bearer";
  throw new ProxyClientError(`${target} cannot authenticate to proxy protocol '${protocol}'`);
}

function connectionCompaction(current, target) {
  if (target === "codex" && current.compaction?.mode === "remote_native") {
    return { upstream: "responses_v2", policy: "remote" };
  }
  if (target === "claude" && current.compaction?.mode === "messages_native") {
    return { upstream: "anthropic_messages_beta", policy: "remote" };
  }
  return { upstream: "none", policy: "local" };
}

function connectionPlan(current, target) {
  const issue = proxyCompatibilityIssue(target, current.protocol);
  if (issue) throw new ProxyClientError(issue);
  const resolved = {
    profile: "agentctl-proxy",
    target,
    platform: normalizeRuntimePlatform(),
    enabled: true,
    endpoint: current.local_base_url,
    protocol: current.protocol,
    auth: {
      mode: connectionAuthMode(target, current.protocol),
      secret: "proxy_capability"
    },
    compaction: connectionCompaction(current, target),
    context: { window_tokens: null, auto_compact_tokens: null },
    model: current.client_model,
    requested_model: current.client_model,
    outbound_model: current.client_model,
    models: { default: current.client_model, aliases: {} }
  };
  return renderProviderPlan(resolved, { secretPresent: true });
}

async function targetFileSnapshot(path, { allowMissing = true } = {}) {
  const details = await pathState(path);
  if (!details) {
    if (allowMissing) return { existed: false, bytes: null, mode: 0o600, sha256: null };
    throw new ProxyClientError(`connected target file is missing: ${path}`);
  }
  if (details.isSymbolicLink() || !details.isFile() || details.size > 5 * 1024 * 1024) {
    throw new ProxyClientError(`connected target path must be a small regular file: ${path}`);
  }
  const bytes = await readFile(path);
  return {
    existed: true,
    bytes,
    mode: details.mode & 0o777,
    sha256: sha256(bytes)
  };
}

function pathWithin(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function validateConnection(value, options) {
  const keys = [
    "schema", "kind", "instance", "created_at", "target", "proxy_instance_id",
    "local_base_url", "backup_dir", "files"
  ];
  if (!value || value.schema !== 1 || value.kind !== CONNECTION_KIND ||
      value.instance !== options.instance ||
      typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at)) ||
      typeof value.proxy_instance_id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.proxy_instance_id) ||
      typeof value.local_base_url !== "string" ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]+(?:\/v1|\/v1beta)?$/.test(
        value.local_base_url
      ) ||
      value.backup_dir !== options.proxyConnectBackup ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16 ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ProxyClientError("proxy connection state is invalid");
  }
  validateTarget(value.target);
  const paths = new Set();
  for (const [index, file] of value.files.entries()) {
    const fileKeys = [
      "path", "backup", "original_existed", "original_mode", "original_sha256",
      "connected_existed", "connected_mode", "connected_sha256"
    ];
    const validHash = (candidate) =>
      typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        typeof file.path !== "string" || !isAbsolute(file.path) || paths.has(file.path) ||
        file.backup !== (file.original_existed ? `${index}.bak` : null) ||
        typeof file.original_existed !== "boolean" ||
        !Number.isInteger(file.original_mode) || file.original_mode < 0 ||
        file.original_mode > 0o777 ||
        (file.original_existed
          ? !validHash(file.original_sha256)
          : file.original_sha256 !== null) ||
        typeof file.connected_existed !== "boolean" ||
        !Number.isInteger(file.connected_mode) || file.connected_mode < 0 ||
        file.connected_mode > 0o777 ||
        (file.connected_existed
          ? !validHash(file.connected_sha256)
          : file.connected_sha256 !== null) ||
        Object.keys(file).some((key) => !fileKeys.includes(key))) {
      throw new ProxyClientError("proxy connection file state is invalid");
    }
    paths.add(file.path);
  }
  return value;
}

async function loadConnection(options, { allowMissing = false } = {}) {
  if (!(await pathState(options.proxyConnectState))) {
    if (allowMissing) return null;
    throw new ProxyClientError("the target is not connected to this proxy instance");
  }
  return validateConnection(
    await readPrivateJson(options.proxyConnectState, "proxy connection state"),
    options
  );
}

async function inspectConnection(options) {
  const connection = await loadConnection(options, { allowMissing: true });
  if (!connection) return { status: "disconnected", connected: false };
  let intact = true;
  try {
    for (const file of connection.files) {
      const current = await targetFileSnapshot(file.path);
      const matches = current.existed === file.connected_existed &&
        current.sha256 === file.connected_sha256 &&
        (!current.existed || current.mode === file.connected_mode);
      current.bytes?.fill(0);
      if (!matches) intact = false;
    }
  } catch {
    intact = false;
  }
  return {
    status: intact ? "connected" : "modified",
    connected: true,
    target: connection.target,
    local_base_url: connection.local_base_url,
    connected_at: connection.created_at,
    managed_files_intact: intact
  };
}

async function connectionOriginalSnapshots(connection) {
  const snapshots = [];
  try {
    for (const file of [...connection.files].reverse()) {
      if (!file.original_existed) {
        snapshots.push({ path: file.path, existed: false, bytes: null, mode: file.original_mode });
        continue;
      }
      const backupPath = join(connection.backup_dir, file.backup);
      const backup = await targetFileSnapshot(backupPath, { allowMissing: false });
      if (backup.sha256 !== file.original_sha256 ||
          (process.platform !== "win32" && (backup.mode & 0o077) !== 0)) {
        backup.bytes?.fill(0);
        throw new ProxyClientError(`connection backup failed integrity checks: ${backupPath}`);
      }
      snapshots.push({ path: file.path, ...backup, mode: file.original_mode });
    }
    return snapshots;
  } catch (error) {
    clearTargetSnapshots(snapshots);
    throw error;
  }
}

async function applyTargetSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      await writeBytesAtomic(snapshot.path, snapshot.bytes, snapshot.mode);
      continue;
    }
    const details = await pathState(snapshot.path);
    if (details?.isSymbolicLink() || (details && !details.isFile())) {
      throw new ProxyClientError(`refusing to remove changed target path: ${snapshot.path}`);
    }
    if (details) await unlink(snapshot.path);
  }
}

function clearTargetSnapshots(snapshots) {
  for (const snapshot of snapshots) snapshot.bytes?.fill(0);
}

async function connect(target, options) {
  validateTarget(target);
  assertApplyPlatform(normalizeRuntimePlatform());
  const current = await inspectStatus(options);
  if (!current.running || current.mode !== PROVIDER_MODE) {
    throw new ProxyClientError("start a healthy Provider-mode proxy before connecting a target");
  }
  if (current.configuration?.restart_required) {
    throw new ProxyClientError("restart the proxy to apply source changes before connecting a target");
  }
  if (current.target !== target) {
    throw new ProxyClientError(
      `running proxy target is '${current.target}', not requested target '${target}'`
    );
  }
  if (await loadAttachment(options, { allowMissing: true })) {
    throw new ProxyClientError("Codex subscription attachment cannot be mixed with Provider connect");
  }
  const existing = await inspectConnection(options);
  if (existing.connected) {
    if (existing.status !== "connected" || existing.target !== target) {
      throw new ProxyClientError("an existing proxy connection is modified or targets another agent");
    }
    const output = { ok: true, changed: false, ...existing };
    emitAttachment(output, options);
    return output;
  }
  const plan = connectionPlan(current, target);
  const output = {
    ok: true,
    preview: !options.yes,
    changed: Boolean(options.yes),
    action: "connect",
    status: options.yes ? "connected" : "disconnected",
    target,
    instance: options.instance,
    local_base_url: current.local_base_url,
    model: plan.outbound_model,
    exact_restore: true
  };
  if (!options.yes) {
    emitAttachment(output, options);
    return output;
  }
  const capability = await loadCapability(options.proxyCapability);
  const paths = await managedTargetPaths(target, { platform: normalizeRuntimePlatform() });
  const targetRoot = targetPaths(target).root;
  if (pathWithin(targetRoot, options.proxyConnectState) ||
      pathWithin(targetRoot, options.proxyConnectBackup) ||
      pathWithin(options.proxyConnectBackup, options.proxyConnectState) ||
      paths.includes(options.proxyConnectState) || paths.includes(options.proxyConnectBackup)) {
    throw new ProxyClientError("proxy connection state/backups must be outside the target config root");
  }
  const protectedPath = target === "codex"
    ? join(targetPaths(target).root, "auth.json")
    : null;
  const protectedBefore = protectedPath
    ? await targetFileSnapshot(protectedPath)
    : null;
  const backupDetails = await pathState(options.proxyConnectBackup);
  if (backupDetails) {
    protectedBefore?.bytes?.fill(0);
    throw new ProxyClientError(`orphaned connection backup exists: ${options.proxyConnectBackup}`);
  }
  await mkdir(dirname(options.proxyConnectBackup), { recursive: true, mode: 0o700 });
  await mkdir(options.proxyConnectBackup, { mode: 0o700 });
  const originals = [];
  try {
    for (const [index, path] of paths.entries()) {
      const snapshot = await targetFileSnapshot(path);
      const file = {
        path,
        backup: snapshot.existed ? `${index}.bak` : null,
        original_existed: snapshot.existed,
        original_mode: snapshot.mode,
        original_sha256: snapshot.sha256
      };
      if (snapshot.existed) {
        await writeBytesAtomic(
          join(options.proxyConnectBackup, file.backup),
          snapshot.bytes,
          0o600
        );
      }
      snapshot.bytes?.fill(0);
      originals.push(file);
    }
    const secretDirectory = await mkdtemp(join(tmpdir(), "agentctl-proxy-connect-"));
    try {
      const keyFile = join(secretDirectory, "capability.key");
      await writeFile(keyFile, `${capability.token}\n`, { flag: "wx", mode: 0o600 });
      await chmod(keyFile, 0o600);
      const args = backendArguments(plan, {
        keyFile,
        skipValidate: true,
        force: options.force
      });
      const command = bashScriptCommand(plan.backend, args);
      const result = spawnSync(command.executable, command.args, {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          AGENTCTL_SETUP_COMMAND: `agentctl proxy connect ${target}`,
          AGENTCTL_UNINSTALL_COMMAND: `agentctl proxy disconnect ${target}`
        },
        stdio: options.json ? "pipe" : "inherit"
      });
      if (result.error || result.status !== 0) {
        throw new ProxyClientError(
          `${plan.target_label} proxy connection backend failed; previous files will be restored`
        );
      }
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
    if (protectedBefore) {
      const protectedAfter = await targetFileSnapshot(protectedPath);
      const unchanged = protectedBefore.existed === protectedAfter.existed &&
        protectedBefore.sha256 === protectedAfter.sha256 &&
        (!protectedBefore.existed || protectedBefore.mode === protectedAfter.mode);
      protectedAfter.bytes?.fill(0);
      if (!unchanged) {
        try {
          await applyTargetSnapshots([{ path: protectedPath, ...protectedBefore }]);
        } catch {
          throw new ProxyClientError(
            `Provider backend modified protected Identity file and automatic restore failed: ${protectedPath}`
          );
        }
        throw new ProxyClientError("Provider backend modified protected Identity file");
      }
    }
    for (const file of originals) {
      const connected = await targetFileSnapshot(file.path);
      Object.assign(file, {
        connected_existed: connected.existed,
        connected_mode: connected.mode,
        connected_sha256: connected.sha256
      });
      connected.bytes?.fill(0);
    }
    const connection = {
      schema: 1,
      kind: CONNECTION_KIND,
      instance: options.instance,
      created_at: new Date().toISOString(),
      target,
      proxy_instance_id: current.instance_id,
      local_base_url: current.local_base_url,
      backup_dir: options.proxyConnectBackup,
      files: originals
    };
    validateConnection(connection, options);
    await writeJsonAtomic(options.proxyConnectState, connection);
  } catch (error) {
    const rollback = {
      backup_dir: options.proxyConnectBackup,
      files: originals
    };
    let rollbackError = null;
    let restore = [];
    try {
      restore = await connectionOriginalSnapshots(rollback);
      await applyTargetSnapshots(restore);
    } catch (failure) {
      rollbackError = failure;
    } finally {
      clearTargetSnapshots(restore);
    }
    await rm(options.proxyConnectBackup, { recursive: true, force: true });
    await unlink(options.proxyConnectState).catch(() => {});
    if (rollbackError) {
      throw new ProxyClientError(
        `${error.message || "proxy connect failed"}; automatic target rollback also failed`
      );
    }
    throw error;
  } finally {
    protectedBefore?.bytes?.fill(0);
  }
  emitAttachment(output, options);
  return output;
}

async function disconnect(target, options) {
  validateTarget(target);
  const connection = await loadConnection(options);
  if (connection.target !== target) {
    throw new ProxyClientError(
      `connected target is '${connection.target}', not requested target '${target}'`
    );
  }
  const inspection = await inspectConnection(options);
  if (!inspection.managed_files_intact) {
    throw new ProxyClientError(
      "target files changed after proxy connect; refusing to overwrite them"
    );
  }
  const output = {
    ok: true,
    preview: !options.yes,
    changed: Boolean(options.yes),
    action: "disconnect",
    status: options.yes ? "disconnected" : "connected",
    target,
    instance: options.instance,
    exact_restore: true
  };
  if (!options.yes) {
    emitAttachment(output, options);
    return output;
  }
  const connected = [];
  let originals = [];
  try {
    for (const file of [...connection.files].reverse()) {
      const snapshot = await targetFileSnapshot(file.path);
      if (snapshot.existed !== file.connected_existed ||
          snapshot.sha256 !== file.connected_sha256 ||
          (snapshot.existed && snapshot.mode !== file.connected_mode)) {
        snapshot.bytes?.fill(0);
        throw new ProxyClientError("target files changed while preparing disconnect; retry");
      }
      connected.push({ path: file.path, ...snapshot });
    }
    originals = await connectionOriginalSnapshots(connection);
    try {
      await applyTargetSnapshots(originals);
      await unlink(options.proxyConnectState);
    } catch (error) {
      try {
        await applyTargetSnapshots(connected);
      } catch {
        throw new ProxyClientError(
          `${error.message || "disconnect failed"}; automatic target rollback also failed`
        );
      }
      throw error;
    }
    await rm(options.proxyConnectBackup, { recursive: true, force: true });
  } finally {
    clearTargetSnapshots(connected);
    clearTargetSnapshots(originals);
  }
  emitAttachment(output, options);
  return output;
}

async function loadCapability(path, { allowMissing = false } = {}) {
  if (!(await pathState(path)) && allowMissing) return null;
  return validateProxyCapability(await readPrivateJson(path, "proxy capability"));
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
        instance: options.instance,
        status: alive ? "starting" : "stale",
        running: false,
        process_alive: alive,
        health: alive ? "state_pending" : "process_not_running",
        capability_present: Boolean(capability),
        capability_file: options.proxyCapability,
        state_file: options.proxyState,
        metadata_log: options.proxyLog,
        usage_log: options.proxyUsageLog,
        circuit_state: options.proxyCircuitState,
        runtime_log: options.proxyRuntimeLog,
        instance_id: lock.instance_id,
        pid: lock.pid
      };
    }
    return {
      schema: 1,
      instance: options.instance,
      status: "stopped",
      running: false,
      capability_present: Boolean(capability),
      capability_file: options.proxyCapability,
      state_file: options.proxyState,
      metadata_log: options.proxyLog,
      usage_log: options.proxyUsageLog,
      circuit_state: options.proxyCircuitState,
      runtime_log: options.proxyRuntimeLog
    };
  }
  const state = validateProxyState(await readPrivateJson(options.proxyState, "proxy runtime state"));
  if (state.instance !== options.instance) {
    throw new ProxyClientError("proxy runtime state belongs to another instance");
  }
  const alive = processAlive(state.pid);
  const health = alive
    ? await healthCheck(state, capability)
    : { healthy: false, reason: "process_not_running" };
  const mode = health.body?.mode ?? state.mode;
  const localBase = health.body?.local_base_url ?? state.local_base_url ??
    (mode === PASSTHROUGH_MODE
      ? listenerRootUrl(state.host, state.port)
      : localBaseUrl(state.host, state.port, state.protocol, mode));
  return {
    schema: 1,
    instance: health.body?.instance ?? state.instance,
    status: health.healthy ? "running" : "stale",
    running: health.healthy,
    process_alive: alive,
    health: health.healthy ? "healthy" : health.reason,
    capability_present: Boolean(capability),
    capability_file: options.proxyCapability,
    state_file: options.proxyState,
    metadata_log: options.proxyLog,
    usage_log: options.proxyUsageLog,
    circuit_state: options.proxyCircuitState,
    runtime_log: options.proxyRuntimeLog,
    instance_id: state.instance_id,
    pid: state.pid,
    started_at: state.started_at,
    host: state.host,
    port: state.port,
    profile: state.profile,
    mode,
    target: state.target,
    protocol: state.protocol,
    client_model: health.body?.client_model ?? state.client_model,
    route: health.body?.route ?? state.route ?? null,
    backends: health.body?.backends ?? state.backend_profiles ?? [state.profile],
    circuits: health.body?.circuits ?? [],
    observability: health.body?.observability ?? null,
    admission: health.body?.admission ?? null,
    configuration: health.body?.configuration ?? null,
    pricing_catalog_version: health.body?.pricing_catalog_version ?? null,
    pricing_model_source: health.body?.pricing_model_source ?? null,
    compaction: health.body?.compaction ?? state.compaction ?? null,
    local_base_url: localBase
  };
}

function emitStatus(status, options) {
  if (options.json) return process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.stdout.write(`Proxy:      ${status.status}\n`);
  process.stdout.write(`Instance:   ${status.instance || options.instance}\n`);
  if (status.mode) process.stdout.write(`Mode:       ${status.mode}\n`);
  if (status.profile) process.stdout.write(`Profile:    ${status.profile} (${status.target})\n`);
  if (status.route) process.stdout.write(`Route:      ${status.route}\n`);
  if (status.backends?.length) process.stdout.write(`Backends:   ${status.backends.join(" -> ")}\n`);
  for (const circuit of status.circuits || []) {
    process.stdout.write(`Circuit:    ${circuit.profile} · ${circuit.state}\n`);
  }
  if (status.local_base_url) process.stdout.write(`Local URL:  ${status.local_base_url}\n`);
  if (status.client_model) process.stdout.write(`Client model: ${status.client_model}\n`);
  if (status.pid) process.stdout.write(`PID:        ${status.pid}\n`);
  if (status.pricing_model_source) {
    process.stdout.write(`Pricing:    ${status.pricing_catalog_version || "catalog unavailable"} (${status.pricing_model_source} model)\n`);
  }
  if (status.compaction) process.stdout.write(`Compaction: ${status.compaction.label || status.compaction.mode}\n`);
  if (status.observability) {
    const degraded = Object.entries(status.observability)
      .filter(([, value]) => value?.last_error || value?.dropped > 0)
      .map(([name]) => name);
    process.stdout.write(
      `Observability: ${degraded.length ? `degraded (${degraded.join(", ")})` : "healthy"}\n`
    );
  }
  if (status.configuration?.restart_required) {
    process.stdout.write(
      `Config:     changed (${status.configuration.changed.join(", ")}); restart required\n`
    );
  }
  process.stdout.write(`Capability: ${status.capability_present ? "present" : "missing"} (${status.capability_file})\n`);
  process.stdout.write(`Metadata:   ${status.metadata_log}\n`);
  process.stdout.write(`Usage:      ${status.usage_log}\n`);
  if (status.circuit_state) process.stdout.write(`Circuits:   ${status.circuit_state}\n`);
  if (status.attachment) {
    process.stdout.write(`Codex:      ${status.attachment.status}` +
      `${status.attachment.config_file ? ` (${status.attachment.config_file})` : ""}\n`);
  }
  if (status.connection) {
    process.stdout.write(`Target:     ${status.connection.status}` +
      `${status.connection.target ? ` (${status.connection.target})` : ""}\n`);
  }
}

async function status(options) {
  const current = {
    ...await inspectStatus(options),
    attachment: await inspectAttachment(options),
    connection: await inspectConnection(options)
  };
  emitStatus(current, options);
  if (current.status === "stale") process.exitCode = 1;
  return current;
}

function usageText(value, label, maximum, { nullable = true } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProxyClientError(`proxy usage ${label} is invalid`);
  }
  return value;
}

function usageToken(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProxyClientError(`proxy usage ${label} must be a non-negative safe integer`);
  }
  return value;
}

function usageMoney(value, label) {
  if (typeof value !== "string" ||
      !/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?$/.test(value)) {
    throw new ProxyClientError(`proxy usage ${label} is not a bounded decimal string`);
  }
  return value;
}

function usageMoneyToScaled(value, label) {
  const normalized = usageMoney(value, label);
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole) * USAGE_MONEY_SCALE +
    BigInt(fraction.padEnd(USAGE_MONEY_SCALE_DIGITS, "0") || "0");
}

function scaledUsageMoney(value) {
  const whole = value / USAGE_MONEY_SCALE;
  const fraction = (value % USAGE_MONEY_SCALE).toString()
    .padStart(USAGE_MONEY_SCALE_DIGITS, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function usageCostView(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProxyClientError("proxy usage cost is invalid");
  }
  const currency = usageText(value.currency, "cost currency", 3, { nullable: false });
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ProxyClientError("proxy usage cost currency is invalid");
  }
  return {
    currency,
    total: usageMoney(value.total, "cost total"),
    input: usageMoney(value.input ?? "0", "input cost"),
    output: usageMoney(value.output ?? "0", "output cost"),
    cache_read: usageMoney(value.cache_read ?? "0", "cache-read cost"),
    cache_write: usageMoney(value.cache_write ?? "0", "cache-write cost"),
    rate_id: usageText(value.rate_id, "rate ID", 100),
    service_tier: usageText(value.service_tier, "cost service tier", 40),
    context_tokens: usageToken(value.context_tokens, "cost context tokens", { nullable: true }),
    estimated: value.estimated === true
  };
}

function usageRecordView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1) {
    throw new ProxyClientError("proxy usage record is invalid");
  }
  const timestamp = usageText(value.timestamp, "timestamp", 100, { nullable: false });
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ProxyClientError("proxy usage timestamp is invalid");
  }
  let usage = null;
  if (value.usage !== null && value.usage !== undefined) {
    if (!value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) {
      throw new ProxyClientError("proxy usage token object is invalid");
    }
    usage = {
      input_tokens: usageToken(value.usage.input_tokens ?? 0, "input tokens"),
      output_tokens: usageToken(value.usage.output_tokens ?? 0, "output tokens"),
      cache_read_tokens: usageToken(value.usage.cache_read_tokens ?? 0, "cache-read tokens"),
      cache_write_tokens: usageToken(value.usage.cache_write_tokens ?? 0, "cache-write tokens")
    };
  }
  return {
    schema: 1,
    timestamp,
    request_id: usageText(value.request_id, "request ID", 100),
    profile: usageText(value.profile, "profile", 100),
    status: usageToken(value.status, "HTTP status", { nullable: true }),
    duration_ms: usageToken(value.duration_ms, "duration", { nullable: true }),
    requested_model: usageText(value.requested_model, "requested model", 240),
    response_model: usageText(value.response_model, "response model", 240),
    pricing_model: usageText(value.pricing_model, "pricing model", 240),
    requested_service_tier: usageText(
      value.requested_service_tier,
      "requested service tier",
      40
    ),
    response_service_tier: usageText(
      value.response_service_tier,
      "response service tier",
      40
    ),
    pricing_service_tier: usageText(
      value.pricing_service_tier,
      "pricing service tier",
      40
    ),
    pricing_service_tier_source: usageText(
      value.pricing_service_tier_source,
      "pricing service tier source",
      80
    ),
    usage,
    cost: usageCostView(value.cost),
    pricing_unavailable: usageText(
      value.pricing_unavailable,
      "pricing unavailable reason",
      100
    )
  };
}

async function readUsageRecords(options) {
  const paths = [];
  for (let index = MAX_USAGE_LOG_FILES - 1; index >= 1; index -= 1) {
    paths.push(`${options.proxyUsageLog}.${index}`);
  }
  paths.push(options.proxyUsageLog);
  const records = [];
  const files = [];
  let totalBytes = 0;
  for (const path of paths) {
    const details = await pathState(path);
    if (!details) continue;
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new ProxyClientError(`proxy usage log must be a regular non-symlink file: ${path}`);
    }
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new ProxyClientError(`proxy usage log must be owner-only (chmod 600): ${path}`);
    }
    totalBytes += details.size;
    if (totalBytes > MAX_USAGE_READ_BYTES) {
      throw new ProxyClientError(
        `retained proxy usage logs exceed ${MAX_USAGE_READ_BYTES} bytes; reduce retention before summarizing`
      );
    }
    let contents;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    files.push(path);
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        records.push(usageRecordView(JSON.parse(line)));
      } catch (error) {
        const concurrentActiveTail = path === options.proxyUsageLog &&
          index === lines.length - 1 && !contents.endsWith("\n");
        if (concurrentActiveTail && error instanceof SyntaxError) continue;
        if (error instanceof ProxyClientError) throw error;
        throw new ProxyClientError(`proxy usage log contains invalid JSON: ${path}:${index + 1}`);
      }
    }
  }
  records.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return { records, files, bytes: totalBytes };
}

function jsonSafeTokenTotal(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function newUsageBucket() {
  return {
    requests: 0,
    priced_requests: 0,
    input_tokens: 0n,
    output_tokens: 0n,
    cache_read_tokens: 0n,
    cache_write_tokens: 0n,
    costs: new Map()
  };
}

function addUsageBucket(bucket, record) {
  bucket.requests += 1;
  if (record.usage) {
    bucket.input_tokens += BigInt(record.usage.input_tokens);
    bucket.output_tokens += BigInt(record.usage.output_tokens);
    bucket.cache_read_tokens += BigInt(record.usage.cache_read_tokens);
    bucket.cache_write_tokens += BigInt(record.usage.cache_write_tokens);
  }
  if (record.cost) {
    bucket.priced_requests += 1;
    bucket.costs.set(
      record.cost.currency,
      (bucket.costs.get(record.cost.currency) || 0n) +
        usageMoneyToScaled(record.cost.total, "cost total")
    );
  }
}

function usageBucketView(bucket) {
  return {
    requests: bucket.requests,
    priced_requests: bucket.priced_requests,
    tokens: {
      input: jsonSafeTokenTotal(bucket.input_tokens),
      output: jsonSafeTokenTotal(bucket.output_tokens),
      cache_read: jsonSafeTokenTotal(bucket.cache_read_tokens),
      cache_write: jsonSafeTokenTotal(bucket.cache_write_tokens)
    },
    costs: Object.fromEntries(
      [...bucket.costs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, value]) => [currency, scaledUsageMoney(value)])
    )
  };
}

function observedTier(value) {
  if (["fast", "priority"].includes(value)) return "fast";
  if (["auto", "default", "standard"].includes(value)) return "standard";
  return value || "unspecified";
}

function usageSummary(records, source) {
  const total = newUsageBucket();
  const byModel = new Map();
  const byTier = new Map();
  const transitions = new Map();
  let fastRequested = 0;
  let fastEffective = 0;
  let fastDowngraded = 0;
  for (const record of records) {
    const model = record.pricing_model || record.response_model ||
      record.requested_model || "unknown";
    const tier = record.pricing_service_tier || "unknown";
    const modelBucket = byModel.get(model) || newUsageBucket();
    const tierBucket = byTier.get(tier) || newUsageBucket();
    const requestedTier = observedTier(record.requested_service_tier);
    const responseTier = observedTier(record.response_service_tier);
    const transition = `${requestedTier}->${responseTier}`;
    transitions.set(transition, (transitions.get(transition) || 0) + 1);
    if (requestedTier === "fast") fastRequested += 1;
    // Only the upstream response can confirm that Fast was effective. Pricing
    // may fall back to the requested tier when response metadata is missing,
    // which is useful for estimation but must not turn an unobserved response
    // into a confirmed Fast response.
    if (responseTier === "fast") fastEffective += 1;
    if (requestedTier === "fast" && tier === "standard" &&
        responseTier === "standard") fastDowngraded += 1;
    addUsageBucket(total, record);
    addUsageBucket(modelBucket, record);
    addUsageBucket(tierBucket, record);
    byModel.set(model, modelBucket);
    byTier.set(tier, tierBucket);
  }
  const mapView = (value) => Object.fromEntries(
    [...value.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, bucket]) => [key, usageBucketView(bucket)])
  );
  return {
    schema: 1,
    kind: "agentctl-proxy-usage-summary",
    log: source.log,
    retained_files: source.files.length,
    retained_bytes: source.bytes,
    window: {
      from: records[0]?.timestamp || null,
      to: records.at(-1)?.timestamp || null
    },
    ...usageBucketView(total),
    unpriced_requests: total.requests - total.priced_requests,
    service_tiers: {
      fast_requested: fastRequested,
      fast_effective: fastEffective,
      fast_downgraded: fastDowngraded,
      transitions: Object.fromEntries(
        [...transitions.entries()].sort(([left], [right]) => left.localeCompare(right))
      )
    },
    by_model: mapView(byModel),
    by_service_tier: mapView(byTier)
  };
}

function emitUsageRecords(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!result.records.length) {
    process.stdout.write(`No proxy usage records in ${result.log}\n`);
    return;
  }
  for (const record of result.records) {
    const tokens = record.usage
      ? `in ${record.usage.input_tokens} · cache ${record.usage.cache_read_tokens}/${record.usage.cache_write_tokens} · out ${record.usage.output_tokens}`
      : "tokens unavailable";
    const cost = record.cost
      ? `${record.cost.total} ${record.cost.currency}`
      : `unpriced (${record.pricing_unavailable || "unknown"})`;
    process.stdout.write(
      `${record.timestamp}\t${record.response_model || record.requested_model || "unknown"}` +
      `\t${record.pricing_service_tier || "unknown"}\t${tokens}\t${cost}\n`
    );
  }
}

function emitUsageSummary(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Usage:      ${result.requests} request(s) · ${result.priced_requests} priced · ${result.unpriced_requests} unpriced\n`);
  process.stdout.write(`Tokens:     in ${result.tokens.input} · cache ${result.tokens.cache_read}/${result.tokens.cache_write} · out ${result.tokens.output}\n`);
  const costs = Object.entries(result.costs);
  process.stdout.write(`Cost:       ${costs.length ? costs.map(([currency, total]) => `${total} ${currency}`).join(" · ") : "unavailable"}\n`);
  process.stdout.write(`Fast:       ${result.service_tiers.fast_requested} requested · ${result.service_tiers.fast_effective} effective · ${result.service_tiers.fast_downgraded} downgraded\n`);
  process.stdout.write(`Window:     ${result.window.from || "empty"}${result.window.to ? ` -> ${result.window.to}` : ""}\n`);
  for (const [tier, bucket] of Object.entries(result.by_service_tier)) {
    process.stdout.write(`Tier:       ${tier} · ${bucket.requests} request(s)\n`);
  }
  for (const [model, bucket] of Object.entries(result.by_model)) {
    process.stdout.write(`Model:      ${model} · ${bucket.requests} request(s)\n`);
  }
}

async function proxyUsage(options) {
  const source = await readUsageRecords(options);
  const limit = options.last ?? (options.summary ? null : 20);
  const records = limit === null ? source.records : source.records.slice(-limit);
  if (options.summary) {
    const result = usageSummary(records, {
      log: options.proxyUsageLog,
      files: source.files,
      bytes: source.bytes
    });
    emitUsageSummary(result, options);
    return result;
  }
  const result = {
    schema: 1,
    kind: "agentctl-proxy-usage",
    log: options.proxyUsageLog,
    retained_files: source.files.length,
    retained_bytes: source.bytes,
    total_records: source.records.length,
    returned_records: records.length,
    records
  };
  emitUsageRecords(result, options);
  return result;
}

function listenerRootUrl(host, port) {
  const address = host === "::1" ? `[${host}]` : host;
  return `http://${address}:${port}`;
}

function localBaseUrl(host, port, protocol, mode = PROVIDER_MODE) {
  const root = listenerRootUrl(host, port);
  if (mode === PASSTHROUGH_MODE) return `${root}${OPENAI_SUBSCRIPTION_LOCAL_BASE_PATH}`;
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
  if (profileName === PASSTHROUGH_PROFILE) {
    if (options.target !== "codex") {
      throw new ProxyClientError("the passthrough profile supports only --target codex");
    }
    if (options.route) {
      throw new ProxyClientError("passthrough observation cannot use a failover route");
    }
    const passthroughEndpoint = new URL(options.upstreamBaseUrl);
    const loopback = ["127.0.0.1", "[::1]"].includes(
      passthroughEndpoint.hostname
    );
    if (options.upstreamBaseUrl !== DEFAULT_OPENAI_SUBSCRIPTION_ENDPOINT && !loopback) {
      throw new ProxyClientError(
        "passthrough upstream must be the official ChatGPT Codex endpoint or loopback"
      );
    }
    const pricing = await loadPricingCatalog(options.pricingPath, { allowMissing: true });
    const models = {
      default: "passthrough",
      aliases: {},
      requested_default: "unchanged",
      outbound_default: "unchanged"
    };
    const auth = { mode: "openai_passthrough", secret: null, present: true };
    const compaction = {
      mode: "remote_native",
      label: "Remote · OpenAI subscription",
      responses_compact: true
    };
    const backend = {
      profile: PASSTHROUGH_PROFILE,
      endpoint: options.upstreamBaseUrl,
      auth,
      models,
      compaction
    };
    return {
      schema: 1,
      action: "start",
      instance: options.instance,
      mode: PASSTHROUGH_MODE,
      ready: true,
      issue: "",
      profile: PASSTHROUGH_PROFILE,
      route: null,
      target: "codex",
      platform,
      protocol: "openai_responses",
      endpoint: options.upstreamBaseUrl,
      models,
      auth,
      backends: [backend],
      compaction,
      retry: {
        mode: "next_request",
        max_attempts: 1,
        status_codes: [],
        network_errors: false
      },
      circuit: {
        enabled: false,
        failure_threshold: 3,
        recovery_timeout_ms: 30000,
        half_open_max_requests: 1,
        state_retention_days: 30
      },
      listen: { host: "127.0.0.1", port: options.port },
      local_base_url: localBaseUrl(
        "127.0.0.1",
        options.port,
        "openai_responses",
        PASSTHROUGH_MODE
      ),
      timeouts: {
        first_byte_ms: options.firstByteMs,
        stream_idle_ms: options.streamIdleMs,
        request_ms: options.requestMs,
        request_body_ms: options.requestBodyMs
      },
      limits: {
        request_bytes: options.requestBytes,
        log_bytes: options.logBytes,
        usage_log_bytes: options.usageLogBytes,
        usage_capture_bytes: options.usageCaptureBytes,
        max_concurrent_requests: options.maxConcurrentRequests,
        max_inflight_request_bytes: options.maxInflightRequestBytes
      },
      pricing: {
        catalog: options.pricingPath,
        present: Boolean(pricing),
        version: pricing?.version || null,
        currency: pricing?.currency || null,
        model_source: options.pricingSource
      },
      retention: {
        files: options.retentionFiles,
        max_age_days: options.retentionDays
      },
      auto_attach: false,
      capability_file: options.proxyCapability,
      metadata_log: options.proxyLog,
      usage_log: options.proxyUsageLog,
      circuit_state: options.proxyCircuitState
    };
  }
  const [store, secrets, pricing, failover] = await Promise.all([
    loadProviderStore(options.storePath),
    loadProviderSecrets(options.secretsPath, { allowMissing: true }),
    loadPricingCatalog(options.pricingPath, { allowMissing: true }),
    options.route
      ? loadFailoverStore(options.failoverPath)
      : Promise.resolve(null)
  ]);
  let route = null;
  let resolvedBackends;
  if (options.route) {
    route = Object.hasOwn(failover.routes, options.route)
      ? failover.routes[options.route]
      : null;
    if (!route) throw new ProxyClientError(`failover route not found: ${options.route}`);
    if (route.profiles[0] !== profileName) {
      throw new ProxyClientError(
        `proxy profile '${profileName}' must match route '${route.name}' primary '${route.profiles[0]}'`
      );
    }
    resolvedBackends = resolveFailoverRoute(route, store, {
      target: options.target,
      platform
    }).backends;
  } else {
    const profile = store.profiles[profileName];
    if (!profile) throw new ProxyClientError(`provider profile not found: ${profileName}`);
    const resolved = resolveProviderProfile(profile, { target: options.target, platform });
    if (!resolved.enabled) {
      throw new ProxyClientError(`${options.target} is disabled by provider profile '${profileName}'`);
    }
    resolvedBackends = [resolved];
  }
  const protocol = resolvedBackends[0].protocol;
  const compatibility = proxyCompatibilityIssue(options.target, protocol);
  const backends = resolvedBackends.map((resolved) => {
    const secretPresent = resolved.auth.mode === "none" ||
      Boolean(secrets.secrets[resolved.auth.secret]);
    const compaction = effectiveProviderCompaction(resolved);
    return {
      profile: resolved.profile,
      endpoint: resolved.endpoint,
      auth: {
        mode: resolved.auth.mode,
        secret: resolved.auth.secret || null,
        present: secretPresent
      },
      models: {
        default: resolved.model,
        aliases: structuredClone(resolved.models.aliases),
        requested_default: resolved.requested_model,
        outbound_default: resolved.outbound_model
      },
      compaction
    };
  });
  const missing = backends.filter((backend) => !backend.auth.present)
    .map((backend) => `${backend.profile}:${backend.auth.secret}`);
  const nativeModes = new Set(backends.map((backend) => backend.compaction.mode));
  const responsesCompact = protocol === "openai_responses" &&
    backends.every((backend) => backend.compaction.responses_compact);
  const messagesNative = protocol === "anthropic_messages" &&
    backends.every((backend) => backend.compaction.mode === "messages_native");
  const forcedRemote = backends.some((backend) => backend.compaction.policy === "remote");
  const compactionIssue = backends.find((backend) => backend.compaction.issue)?.compaction.issue ||
    (forcedRemote && !responsesCompact && !messagesNative
      ? "failover route cannot guarantee the forced remote compaction capability"
      : "");
  const compaction = responsesCompact
    ? { mode: "remote_native", label: "Remote · native", responses_compact: true }
    : messagesNative
      ? { mode: "messages_native", label: "Messages · Anthropic beta", responses_compact: false }
      : {
          mode: "client_local",
          label: nativeModes.size > 1
            ? "Local · route capability not uniform"
            : backends[0].compaction.label,
          responses_compact: false
        };
  const issue = compatibility || compactionIssue || (missing.length
    ? `local Secrets are missing for ${missing.join(", ")}`
    : "");
  const primary = backends[0];
  const retry = route ? structuredClone(route.retry) : {
    mode: "next_request",
    max_attempts: 1,
    status_codes: [],
    network_errors: false
  };
  const circuit = route ? {
    enabled: true,
    ...structuredClone(route.circuit)
  } : {
    enabled: false,
    failure_threshold: 3,
    recovery_timeout_ms: 30000,
    half_open_max_requests: 1,
    state_retention_days: 30
  };
  return {
    schema: 1,
    action: "start",
    instance: options.instance,
    mode: PROVIDER_MODE,
    ready: !issue,
    issue,
    profile: profileName,
    route: route?.name || null,
    target: options.target,
    platform,
    protocol,
    endpoint: primary.endpoint,
    models: primary.models,
    auth: primary.auth,
    backends,
    compaction,
    retry,
    circuit,
    listen: { host: "127.0.0.1", port: options.port },
    local_base_url: localBaseUrl("127.0.0.1", options.port, protocol, PROVIDER_MODE),
    timeouts: {
      first_byte_ms: options.firstByteMs,
      stream_idle_ms: options.streamIdleMs,
      request_ms: options.requestMs,
      request_body_ms: options.requestBodyMs
    },
    limits: {
      request_bytes: options.requestBytes,
      log_bytes: options.logBytes,
      usage_log_bytes: options.usageLogBytes,
      usage_capture_bytes: options.usageCaptureBytes,
      max_concurrent_requests: options.maxConcurrentRequests,
      max_inflight_request_bytes: options.maxInflightRequestBytes
    },
    pricing: {
      catalog: options.pricingPath,
      present: Boolean(pricing),
      version: pricing?.version || null,
      currency: pricing?.currency || null,
      model_source: options.pricingSource
    },
    retention: {
      files: options.retentionFiles,
      max_age_days: options.retentionDays
    },
    auto_attach: false,
    capability_file: options.proxyCapability,
    metadata_log: options.proxyLog,
    usage_log: options.proxyUsageLog,
    circuit_state: options.proxyCircuitState
  };
}

function emitPlan(plan, options, apply) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...plan, preview: !apply }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${apply ? "[apply]" : "[preview]"} loopback provider proxy\n`);
  process.stdout.write(`  Instance     : ${plan.instance}\n`);
  process.stdout.write(`  Mode         : ${plan.mode}\n`);
  process.stdout.write(`  Profile      : ${plan.profile} (${plan.target}; ${plan.platform})\n`);
  if (plan.route) process.stdout.write(`  Route        : ${plan.route} · ${plan.backends.length} backends\n`);
  process.stdout.write(`  Protocol     : ${plan.protocol}\n`);
  process.stdout.write(`  Compaction   : ${plan.compaction.label}\n`);
  process.stdout.write(`  Model        : ${plan.mode === PASSTHROUGH_MODE
    ? "unchanged from Codex request"
    : `${plan.models.requested_default} -> ${plan.models.outbound_default}`}\n`);
  process.stdout.write(`  Upstream     : ${plan.endpoint}\n`);
  process.stdout.write(`  Local URL    : ${plan.local_base_url}\n`);
  process.stdout.write(`  Authentication: ${plan.mode === PASSTHROUGH_MODE
    ? "official OpenAI bearer/account headers forwarded unchanged"
    : `local capability at ${plan.capability_file} (value hidden)`}\n`);
  process.stdout.write(`  Request log  : metadata only; ${plan.metadata_log}\n`);
  process.stdout.write(`  Usage log    : model/token/cost only; ${plan.usage_log}\n`);
  process.stdout.write(`  Pricing      : ${plan.pricing.present ? `${plan.pricing.version} (${plan.pricing.model_source} model)` : "catalog unavailable; requests still work"}\n`);
  if (plan.route) {
    process.stdout.write(`  Replay       : ${plan.retry.mode === "same_request" ? `enabled; at most ${plan.retry.max_attempts} attempts (duplicate billing possible)` : "disabled; failover affects later requests"}\n`);
    for (const [index, backend] of plan.backends.entries()) {
      process.stdout.write(`  Backend ${index + 1}    : ${backend.profile} · ${backend.models.requested_default} -> ${backend.models.outbound_default}\n`);
    }
  }
  process.stdout.write(`  Client config: unchanged; run 'agentctl proxy ${
    plan.mode === PASSTHROUGH_MODE ? "attach" : `connect ${plan.target}`
  }' separately\n`);
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
    schema: PROXY_CONFIG_SCHEMA,
    kind: CONFIG_KIND,
    instance: options.instance,
    instance_id: randomUUID(),
    created_at: new Date().toISOString(),
    mode: plan.mode,
    profile: plan.profile,
    target: plan.target,
    platform: plan.platform,
    protocol: plan.protocol,
    compaction: plan.compaction,
    route: plan.route,
    backends: plan.backends.map((backend) => ({
      profile: backend.profile,
      endpoint: backend.endpoint,
      auth: { mode: backend.auth.mode, secret: backend.auth.secret },
      models: {
        default: backend.models.default,
        aliases: backend.models.aliases
      }
    })),
    retry: plan.retry,
    circuit: plan.circuit,
    retention: plan.retention,
    pricing: {
      catalog: plan.pricing.catalog,
      model_source: plan.pricing.model_source
    },
    listen: plan.listen,
    timeouts: plan.timeouts,
    limits: plan.limits,
    paths: {
      state: options.proxyState,
      lock: options.proxyLock,
      capability: options.proxyCapability,
      secrets: options.secretsPath,
      log: options.proxyLog,
      usage_log: options.proxyUsageLog,
      circuit_state: options.proxyCircuitState,
      runtime_log: options.proxyRuntimeLog
    },
    sources: {
      provider_store: plan.mode === PROVIDER_MODE ? options.storePath : null,
      provider_secrets: plan.mode === PROVIDER_MODE ? options.secretsPath : null,
      failover_store: plan.route ? options.failoverPath : null,
      pricing_catalog: options.pricingPath
    }
  };
}

async function waitForStart(config, capability, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = validateProxyState(await readPrivateJson(config.paths.state, "proxy runtime state"));
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
  const attachment = await loadAttachment(options, { allowMissing: true });
  if (attachment && (plan.mode !== PASSTHROUGH_MODE ||
      attachment.local_base_url !== plan.local_base_url)) {
    throw new ProxyClientError(
      "Codex is attached to another proxy configuration; detach it before starting"
    );
  }
  const connection = await loadConnection(options, { allowMissing: true });
  if (connection && (plan.mode !== PROVIDER_MODE || connection.target !== plan.target ||
      connection.local_base_url !== plan.local_base_url)) {
    throw new ProxyClientError(
      "an agent is connected to another proxy configuration; disconnect it before starting"
    );
  }
  await clearDeadRuntime(options);
  const daemonDetails = await pathState(options.daemonPath);
  if (!daemonDetails || daemonDetails.isSymbolicLink() || !daemonDetails.isFile()) {
    throw new ProxyClientError(`proxy daemon is missing: ${options.daemonPath}`);
  }
  const capability = await ensureCapability(options);
  const config = validateProxyConfig(daemonConfig(plan, options));
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
    instance: options.instance,
    mode: plan.mode,
    profile: plan.profile,
    route: plan.route,
    backends: plan.backends.map((backend) => backend.profile),
    target: plan.target,
    protocol: plan.protocol,
    local_base_url: plan.local_base_url,
    pid: state.pid,
    capability_file: options.proxyCapability,
    pricing_catalog_version: plan.pricing.version,
    usage_log: options.proxyUsageLog,
    auto_attach: false
  };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(
    `Proxy is healthy at ${plan.local_base_url}; client configuration was not changed.\n`
  );
  return output;
}

async function waitForStop(pid, options, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      if (!(await pathState(options.proxyState))) return;
      // Windows implements process.kill(..., "SIGTERM") with forced process
      // termination, so the daemon cannot run its signal cleanup handlers.
      // The PID and health identity were verified by stop() before signaling;
      // clear only those now-dead, validated runtime files.
      if (process.platform === "win32") {
        await clearDeadRuntime(options);
        return;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new ProxyClientError("proxy did not stop cleanly; no stronger signal was sent");
}

function emitAttachment(output, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (output.preview) {
    if (["connect", "disconnect"].includes(output.action)) {
      process.stdout.write(
        `[preview] ${output.action} ${output.target} to proxy instance '${options.instance}'; ` +
        "re-run with --yes.\n"
      );
      return;
    }
    process.stdout.write(
      `[preview] ${output.action} Codex ${output.config_file}; re-run with --yes.\n`
    );
    return;
  }
  if (["connect", "disconnect"].includes(output.action) || output.target) {
    process.stdout.write(output.changed
      ? `${output.target} proxy ${output.status} (${options.instance})\n`
      : `${output.target} is already ${output.status} (${options.instance})\n`);
    return;
  }
  process.stdout.write(output.changed
    ? `Codex proxy ${output.status}: ${output.config_file}\n`
    : `Codex is already ${output.status}: ${output.config_file}\n`);
}

async function attach(options) {
  if (await loadConnection(options, { allowMissing: true })) {
    throw new ProxyClientError("disconnect the Provider target before attaching Codex passthrough");
  }
  const current = await inspectStatus(options);
  if (!current.running || current.mode !== PASSTHROUGH_MODE ||
      current.target !== "codex" || current.protocol !== "openai_responses") {
    throw new ProxyClientError(
      "start a healthy 'passthrough' proxy for --target codex before attaching"
    );
  }
  const existingAttachment = await inspectAttachment(options);
  if (existingAttachment.attached) {
    if (existingAttachment.status !== "attached") {
      throw new ProxyClientError(
        "Codex config changed after attach; refusing to overwrite it (detach requires repair)"
      );
    }
    const output = {
      ok: true,
      changed: false,
      status: "attached",
      config_file: existingAttachment.config_file,
      local_base_url: existingAttachment.local_base_url
    };
    emitAttachment(output, options);
    return output;
  }
  if (await pathState(options.proxyAttachBackup)) {
    throw new ProxyClientError(
      `orphaned attachment backup exists: ${options.proxyAttachBackup}`
    );
  }
  const original = await readConfigSnapshot(options.codexConfig, { allowMissing: true });
  const originalBytes = original?.bytes || Buffer.alloc(0);
  const attachedBytes = renderCodexAttachment(originalBytes, current.local_base_url);
  const output = {
    ok: true,
    preview: !options.yes,
    changed: Boolean(options.yes),
    action: "attach",
    status: options.yes ? "attached" : "detached",
    config_file: options.codexConfig,
    backup_file: options.proxyAttachBackup,
    local_base_url: current.local_base_url,
    exact_restore: true
  };
  if (!options.yes) {
    emitAttachment(output, options);
    originalBytes.fill(0);
    attachedBytes.fill(0);
    return output;
  }
  const verifyOriginal = await readConfigSnapshot(options.codexConfig, { allowMissing: true });
  if (Boolean(verifyOriginal) !== Boolean(original) ||
      sha256(verifyOriginal?.bytes || Buffer.alloc(0)) !== sha256(originalBytes)) {
    originalBytes.fill(0);
    attachedBytes.fill(0);
    throw new ProxyClientError("Codex config changed while preparing attach; retry");
  }
  const attachment = {
    schema: 1,
    kind: ATTACHMENT_KIND,
    created_at: new Date().toISOString(),
    mode: PASSTHROUGH_MODE,
    target: "codex",
    proxy_instance_id: current.instance_id,
    local_base_url: current.local_base_url,
    config_file: options.codexConfig,
    backup_file: options.proxyAttachBackup,
    config_existed: Boolean(original),
    original_mode: original ? original.mode : 0o600,
    original_sha256: sha256(originalBytes),
    attached_sha256: sha256(attachedBytes)
  };
  let configWritten = false;
  let backupWritten = false;
  try {
    if (original) {
      await writeBytesAtomic(options.proxyAttachBackup, originalBytes, 0o600);
      backupWritten = true;
    }
    await writeBytesAtomic(options.codexConfig, attachedBytes, attachment.original_mode);
    configWritten = true;
    await writeJsonAtomic(options.proxyAttachState, attachment);
  } catch (error) {
    if (configWritten) {
      if (original) {
        await writeBytesAtomic(options.codexConfig, originalBytes, attachment.original_mode)
          .catch(() => {});
      } else {
        await unlink(options.codexConfig).catch(() => {});
      }
    }
    if (backupWritten) await unlink(options.proxyAttachBackup).catch(() => {});
    await unlink(options.proxyAttachState).catch(() => {});
    throw error;
  } finally {
    originalBytes.fill(0);
    attachedBytes.fill(0);
    verifyOriginal?.bytes.fill(0);
  }
  emitAttachment(output, options);
  return output;
}

async function detach(options) {
  const attachment = await loadAttachment(options);
  const current = await readConfigSnapshot(attachment.config_file);
  let backup = null;
  if (attachment.config_existed) {
    backup = await readConfigSnapshot(attachment.backup_file);
    if ((process.platform !== "win32" && (backup.mode & 0o077) !== 0) ||
        sha256(backup.bytes) !== attachment.original_sha256) {
      current.bytes.fill(0);
      backup.bytes.fill(0);
      throw new ProxyClientError("attachment backup failed integrity or permission checks");
    }
  }
  const originalBytes = backup?.bytes || Buffer.alloc(0);
  const attachedBytes = renderCodexAttachment(originalBytes, attachment.local_base_url);
  if (sha256(attachedBytes) !== attachment.attached_sha256) {
    current.bytes.fill(0);
    backup?.bytes.fill(0);
    attachedBytes.fill(0);
    throw new ProxyClientError("attachment backup does not reproduce the attached config");
  }
  const currentHash = sha256(current.bytes);
  const exactRestore = currentHash === attachment.attached_sha256;
  let detachedBytes;
  try {
    detachedBytes = exactRestore
      ? Buffer.from(originalBytes)
      : mergeCodexDetach(
          originalBytes,
          attachedBytes,
          current.bytes,
          attachment.local_base_url
        );
  } catch (error) {
    current.bytes.fill(0);
    backup?.bytes.fill(0);
    attachedBytes.fill(0);
    throw error;
  }
  const output = {
    ok: true,
    preview: !options.yes,
    changed: Boolean(options.yes),
    action: "detach",
    status: options.yes ? "detached" : "attached",
    config_file: attachment.config_file,
    backup_file: attachment.backup_file,
    exact_restore: exactRestore,
    preserved_external_changes: !exactRestore
  };
  if (!options.yes) {
    emitAttachment(output, options);
    current.bytes.fill(0);
    backup?.bytes.fill(0);
    attachedBytes.fill(0);
    detachedBytes.fill(0);
    return output;
  }
  const verifyCurrent = await readConfigSnapshot(attachment.config_file);
  if (sha256(verifyCurrent.bytes) !== currentHash) {
    current.bytes.fill(0);
    backup?.bytes.fill(0);
    attachedBytes.fill(0);
    detachedBytes.fill(0);
    verifyCurrent.bytes.fill(0);
    throw new ProxyClientError("Codex config changed while preparing detach; retry");
  }
  try {
    if (detachedBytes.length || attachment.config_existed) {
      await writeBytesAtomic(
        attachment.config_file,
        detachedBytes,
        exactRestore ? attachment.original_mode : current.mode
      );
    } else {
      await unlink(attachment.config_file);
    }
    await unlink(options.proxyAttachState);
    if (attachment.config_existed) await unlink(attachment.backup_file);
  } finally {
    current.bytes.fill(0);
    backup?.bytes.fill(0);
    attachedBytes.fill(0);
    detachedBytes.fill(0);
    verifyCurrent.bytes.fill(0);
  }
  emitAttachment(output, options);
  return output;
}

async function stop(options) {
  const attachment = await inspectAttachment(options);
  if (attachment.attached) {
    throw new ProxyClientError("detach Codex before stopping the proxy");
  }
  const connection = await inspectConnection(options);
  if (connection.connected) {
    throw new ProxyClientError(
      `disconnect ${connection.target || "the agent"} before stopping the proxy`
    );
  }
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
  await waitForStop(current.pid, options);
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
  const connection = await inspectConnection(options);
  if (connection.connected) {
    throw new ProxyClientError("disconnect the agent before rotating its proxy capability");
  }
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
  if (action === "usage" && positional.length === 0) return proxyUsage(options);
  if (action === "connect" && positional.length === 1) return connect(positional[0], options);
  if (action === "disconnect" && positional.length === 1) {
    return disconnect(positional[0], options);
  }
  if (action === "stop" && positional.length === 0) return stop(options);
  if (action === "attach" && positional.length === 0) return attach(options);
  if (action === "detach" && positional.length === 0) return detach(options);
  if (action === "token" && positional.length === 1) return token(positional[0], options);
  throw new ProxyClientError("invalid proxy command; use agentctl proxy --help");
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    const safe = error instanceof ProxyClientError || error instanceof ProviderSchemaError ||
      error instanceof ProviderRendererError || error instanceof ProxySchemaError ||
      error instanceof PricingClientError || error instanceof PricingError ||
      error instanceof FailoverClientError || error instanceof FailoverSchemaError
      ? error.message
      : "unexpected proxy controller failure";
    process.stderr.write(`[error] ${safe}\n`);
    process.exitCode = 1;
  });
}

export {
  ATTACHMENT_KIND,
  CAPABILITY_KIND,
  CONFIG_KIND,
  LOCK_KIND,
  PASSTHROUGH_MODE,
  PROVIDER_MODE,
  STATE_KIND
};
