import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_TARGETS,
  effectiveProviderCompaction,
  normalizeRuntimePlatform,
  validatePlatform,
  validateProtocol,
  validateTarget
} from "./provider-schema.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENT_ROOT = resolve(MODULE_DIR, "..");

export class ProviderRendererError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderRendererError";
  }
}

const TARGET_LABELS = Object.freeze({
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi"
});

const TARGET_BACKENDS = Object.freeze({
  claude: ["claude-code", "setup.sh"],
  codex: ["codex", "setup.sh"],
  opencode: ["opencode", "setup.sh"],
  pi: ["pi", "setup.sh"]
});

function protocolArgument(protocol) {
  return ({
    anthropic_messages: "anthropic",
    openai_responses: "responses",
    openai_chat: "chat",
    google_generative: "google"
  })[protocol];
}

function authArgument(mode) {
  return ({
    bearer: "bearer",
    "x-api-key": "api-key",
    "x-goog-api-key": "google-key"
  })[mode];
}

function loopbackEndpoint(value) {
  const host = new URL(value).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function officialOpenAiEndpoint(value) {
  const endpoint = new URL(value);
  return endpoint.protocol === "https:" && endpoint.hostname === "api.openai.com" &&
    endpoint.port === "" && endpoint.pathname.replace(/\/$/, "") === "/v1" &&
    endpoint.search === "";
}

function compatibilityIssue(resolved) {
  const { target, protocol, auth } = resolved;
  const context = resolved.context || {
    window_tokens: null,
    auto_compact_tokens: null
  };
  if (target !== "claude" &&
      (context.window_tokens !== null || context.auto_compact_tokens !== null)) {
    return `${TARGET_LABELS[target]} does not yet support managed context policy`;
  }
  if (target === "claude") {
    if (protocol !== "anthropic_messages") {
      return "Claude Code direct mode requires anthropic_messages";
    }
    if (!["bearer", "x-api-key"].includes(auth.mode)) {
      return "Claude Code direct mode requires bearer or x-api-key authentication";
    }
  }
  if (target === "codex") {
    if (protocol !== "openai_responses") {
      return "Codex direct mode requires openai_responses";
    }
    if (auth.mode !== "bearer") {
      return "Codex direct mode requires bearer authentication";
    }
  }
  if (target === "opencode") {
    if (!["anthropic_messages", "openai_responses", "openai_chat", "google_generative"].includes(protocol)) {
      return "OpenCode custom providers support Anthropic Messages, OpenAI Responses, OpenAI Chat, or Google Generative AI";
    }
    if (protocol === "anthropic_messages" && auth.mode !== "x-api-key") {
      return "OpenCode Anthropic direct mode requires x-api-key authentication";
    }
    if (["openai_responses", "openai_chat"].includes(protocol) && auth.mode !== "bearer") {
      return "OpenCode OpenAI direct mode requires bearer authentication";
    }
    if (protocol === "google_generative" && auth.mode !== "x-goog-api-key") {
      return "OpenCode Google direct mode requires x-goog-api-key authentication";
    }
  }
  if (target === "pi") {
    if (auth.mode === "none" && !loopbackEndpoint(resolved.endpoint)) {
      return "unauthenticated Pi profiles are restricted to loopback endpoints";
    }
    if (!["bearer", "x-api-key", "x-goog-api-key", "none"].includes(auth.mode)) {
      return "Pi authentication mode is unsupported";
    }
  }
  return "";
}

export function proxyCompatibilityIssue(target, protocol) {
  validateTarget(target);
  validateProtocol(protocol);
  if (target === "claude" && protocol !== "anthropic_messages") {
    return "Claude Code can connect to an Anthropic Messages proxy only";
  }
  if (target === "codex" && protocol !== "openai_responses") {
    return "Codex can connect to an OpenAI Responses proxy only";
  }
  if (target === "opencode" &&
      !["anthropic_messages", "openai_responses", "openai_chat"].includes(protocol)) {
    return "OpenCode can connect to Anthropic Messages, OpenAI Responses, or OpenAI Chat proxies";
  }
  return "";
}

function targetPathApi(platform) {
  return platform === "windows" || platform === "win32" ? win32 : posix;
}

export function targetPaths(target, {
  home = homedir(),
  platform = normalizeRuntimePlatform()
} = {}) {
  validateTarget(target);
  const targetPath = targetPathApi(platform);
  if (target === "claude") {
    const root = targetPath.join(home, ".claude");
    return {
      root,
      config_files: [targetPath.join(root, "settings.json")],
      state_files: [
        targetPath.join(root, ".script-toolbox-provider"),
        targetPath.join(root, ".script-toolbox-provider-context.json")
      ],
      key_dir: "",
      key_file: ""
    };
  }
  if (target === "codex") {
    const root = targetPath.join(home, ".codex");
    const keyDir = targetPath.join(root, "provider-keys");
    return {
      root,
      config_files: [targetPath.join(root, "config.toml")],
      state_files: [
        targetPath.join(root, ".script-toolbox-provider-key"),
        targetPath.join(root, ".script-toolbox-defaults-backup.toml")
      ],
      key_dir: keyDir,
      key_file: targetPath.join(keyDir, "script_toolbox_custom.key")
    };
  }
  if (target === "opencode") {
    const root = targetPath.join(home, ".config", "opencode");
    const keyDir = targetPath.join(root, "provider-keys");
    return {
      root,
      config_files: [targetPath.join(root, "opencode.json")],
      state_files: [targetPath.join(root, ".script-toolbox-provider")],
      key_dir: keyDir,
      key_file: targetPath.join(keyDir, "script-toolbox-custom.key")
    };
  }
  const root = targetPath.join(home, ".pi", "agent");
  const keyDir = targetPath.join(root, "provider-keys");
  return {
    root,
    config_files: [targetPath.join(root, "models.json"), targetPath.join(root, "settings.json")],
    state_files: [targetPath.join(root, ".script-toolbox-provider")],
    key_dir: keyDir,
    key_file: targetPath.join(keyDir, "script-toolbox-custom.key")
  };
}

function backendPath(target, agentRoot) {
  const [directory, file] = TARGET_BACKENDS[target];
  return join(agentRoot, directory, file);
}

function tokenLabel(value) {
  return value === null ? "auto" : new Intl.NumberFormat("en-US").format(value);
}

function renderContextPolicy(resolved) {
  const context = structuredClone(resolved.context || {
    window_tokens: null,
    auto_compact_tokens: null
  });
  let label = "Client default";
  if (context.window_tokens !== null && context.auto_compact_tokens !== null) {
    label = `${tokenLabel(context.window_tokens)} max · compact at ${tokenLabel(context.auto_compact_tokens)}`;
  } else if (context.window_tokens !== null) {
    label = `${tokenLabel(context.window_tokens)} max · client auto-compact`;
  } else if (context.auto_compact_tokens !== null) {
    label = `Model default · compact at ${tokenLabel(context.auto_compact_tokens)}`;
  }
  return {
    ...context,
    label,
    managed: resolved.target === "claude" &&
      (context.window_tokens !== null || context.auto_compact_tokens !== null)
  };
}

export function renderProviderPlan(resolved, {
  secretPresent = false,
  home = homedir(),
  agentRoot = process.env.AGENTCTL_AGENT_ROOT || DEFAULT_AGENT_ROOT
} = {}) {
  validateTarget(resolved.target);
  validatePlatform(resolved.platform);
  const paths = targetPaths(resolved.target, { home, platform: resolved.platform });
  const directIssue = resolved.enabled ? compatibilityIssue(resolved) : "";
  const compaction = effectiveProviderCompaction(resolved);
  const context = renderContextPolicy(resolved);
  const issue = resolved.enabled ? directIssue || compaction.issue : "";
  const needsSecret = resolved.auth.mode !== "none";
  const secretReady = !needsSecret || secretPresent;
  const compatible = !issue;
  const providerName = resolved.target === "codex" &&
      compaction.mode === "remote_native" && officialOpenAiEndpoint(resolved.endpoint)
    ? "OpenAI"
    : resolved.profile;
  return {
    schema: 1,
    profile: resolved.profile,
    target: resolved.target,
    target_label: TARGET_LABELS[resolved.target],
    platform: resolved.platform,
    mode: "direct",
    enabled: resolved.enabled,
    compatible,
    ready: !resolved.enabled || (compatible && secretReady),
    issue: issue || (!secretReady
      ? `local Secret '${resolved.auth.secret}' is missing`
      : ""),
    protocol: resolved.protocol,
    endpoint: resolved.endpoint,
    provider_name: providerName,
    requested_model: resolved.requested_model,
    outbound_model: resolved.outbound_model,
    compaction,
    context,
    auth: {
      mode: resolved.auth.mode,
      secret: resolved.auth.secret || null,
      present: secretReady,
      synthetic: resolved.auth.mode === "none"
    },
    official_identity: resolved.target === "codex"
      ? {
          policy: "preserve",
          account: "current",
          config_file: targetPathApi(resolved.platform).join(paths.root, "auth.json"),
          managed: false
        }
      : null,
    backend: backendPath(resolved.target, agentRoot),
    config_files: paths.config_files,
    ownership_files: paths.state_files,
    credential_file: paths.key_file || paths.config_files[0],
    restart_required: true
  };
}

export function backendArguments(plan, {
  keyFile,
  modelsUrl = "",
  skipValidate = false,
  force = false,
  forceContext = false
} = {}) {
  if (!plan.enabled) throw new ProviderRendererError(`${plan.target} is disabled by the profile`);
  if (!plan.compatible) throw new ProviderRendererError(plan.issue);
  if (!keyFile) throw new ProviderRendererError("a private temporary key file is required");
  const args = [
    "--provider", "custom",
    "--base-url", plan.endpoint,
    "--model", plan.outbound_model,
    "--key-file", keyFile
  ];
  if (plan.target !== "claude") {
    args.push("--provider-name", plan.provider_name);
  }
  if (["opencode", "pi"].includes(plan.target)) {
    args.push("--protocol", protocolArgument(plan.protocol));
  }
  if (plan.target === "claude") {
    args.push("--auth-mode", plan.auth.mode === "x-api-key" ? "api-key" : "auth-token");
    args.push(
      "--context-window-tokens",
      plan.context.window_tokens === null ? "auto" : String(plan.context.window_tokens),
      "--auto-compact-tokens",
      plan.context.auto_compact_tokens === null ? "auto" : String(plan.context.auto_compact_tokens)
    );
    args.push("--no-statusline");
  }
  if (plan.target === "pi") {
    const mode = plan.auth.mode === "none" ? "bearer" : authArgument(plan.auth.mode);
    args.push("--auth-mode", mode);
  }
  if (modelsUrl) args.push("--models-url", modelsUrl);
  if (skipValidate) args.push("--skip-validate");
  if (force) args.push("--force");
  if (plan.target === "claude" && forceContext) args.push("--force-context");
  return args;
}

function safeOwnedKeyPath(candidate, keyDir) {
  if (!candidate || !keyDir) return "";
  const absolute = resolve(candidate);
  const root = `${resolve(keyDir)}${sep}`;
  return absolute.startsWith(root) && absolute.endsWith(".key") ? absolute : "";
}

async function previousKeyPath(target, paths) {
  const state = paths.state_files[0];
  if (!paths.key_dir) return "";
  let text;
  try {
    text = await readFile(state, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
  const lines = text.split(/\r?\n/);
  const candidate = target === "codex" ? lines[0] : lines[1];
  return safeOwnedKeyPath(candidate, paths.key_dir);
}

export async function managedTargetPaths(target, options = {}) {
  const paths = targetPaths(target, options);
  const oldKey = await previousKeyPath(target, paths);
  return [...new Set([
    ...paths.config_files,
    ...paths.state_files,
    paths.key_file,
    oldKey
  ].filter(Boolean))];
}

export function allProviderTargets() {
  return [...PROVIDER_TARGETS];
}

export function assertApplyPlatform(platform) {
  const runtime = normalizeRuntimePlatform();
  if (platform !== runtime) {
    throw new ProviderRendererError(
      `cannot apply the ${platform} overlay on ${runtime}; run the same portable Store on that platform`
    );
  }
}
