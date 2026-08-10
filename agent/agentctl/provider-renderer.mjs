import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_TARGETS,
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

function compatibilityIssue(resolved) {
  const { target, protocol, auth } = resolved;
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
    if (!["anthropic_messages", "openai_responses", "openai_chat"].includes(protocol)) {
      return "OpenCode custom providers support Anthropic Messages, OpenAI Responses, or OpenAI Chat";
    }
    if (protocol === "anthropic_messages" && auth.mode !== "x-api-key") {
      return "OpenCode Anthropic direct mode requires x-api-key authentication";
    }
    if (["openai_responses", "openai_chat"].includes(protocol) && auth.mode !== "bearer") {
      return "OpenCode OpenAI direct mode requires bearer authentication";
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

export function targetPaths(target, { home = homedir() } = {}) {
  validateTarget(target);
  if (target === "claude") {
    const root = join(home, ".claude");
    return {
      root,
      config_files: [join(root, "settings.json")],
      state_files: [join(root, ".script-toolbox-provider")],
      key_dir: "",
      key_file: ""
    };
  }
  if (target === "codex") {
    const root = join(home, ".codex");
    const keyDir = join(root, "provider-keys");
    return {
      root,
      config_files: [join(root, "config.toml")],
      state_files: [
        join(root, ".script-toolbox-provider-key"),
        join(root, ".script-toolbox-defaults-backup.toml")
      ],
      key_dir: keyDir,
      key_file: join(keyDir, "script_toolbox_custom.key")
    };
  }
  if (target === "opencode") {
    const root = join(home, ".config", "opencode");
    const keyDir = join(root, "provider-keys");
    return {
      root,
      config_files: [join(root, "opencode.json")],
      state_files: [join(root, ".script-toolbox-provider")],
      key_dir: keyDir,
      key_file: join(keyDir, "script-toolbox-custom.key")
    };
  }
  const root = join(home, ".pi", "agent");
  const keyDir = join(root, "provider-keys");
  return {
    root,
    config_files: [join(root, "models.json"), join(root, "settings.json")],
    state_files: [join(root, ".script-toolbox-provider")],
    key_dir: keyDir,
    key_file: join(keyDir, "script-toolbox-custom.key")
  };
}

function backendPath(target, agentRoot) {
  const [directory, file] = TARGET_BACKENDS[target];
  return join(agentRoot, directory, file);
}

export function renderProviderPlan(resolved, {
  secretPresent = false,
  home = homedir(),
  agentRoot = process.env.AGENTCTL_AGENT_ROOT || DEFAULT_AGENT_ROOT
} = {}) {
  validateTarget(resolved.target);
  validatePlatform(resolved.platform);
  const paths = targetPaths(resolved.target, { home });
  const issue = resolved.enabled ? compatibilityIssue(resolved) : "";
  const needsSecret = resolved.auth.mode !== "none";
  const secretReady = !needsSecret || secretPresent;
  const compatible = !issue;
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
    requested_model: resolved.requested_model,
    outbound_model: resolved.outbound_model,
    auth: {
      mode: resolved.auth.mode,
      secret: resolved.auth.secret || null,
      present: secretReady,
      synthetic: resolved.auth.mode === "none"
    },
    backend: backendPath(resolved.target, agentRoot),
    config_files: paths.config_files,
    ownership_files: paths.state_files,
    credential_file: paths.key_file || paths.config_files[0],
    restart_required: true
  };
}

export function backendArguments(plan, {
  keyFile,
  skipValidate = false,
  force = false
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
    args.push("--provider-name", plan.profile);
  }
  if (["opencode", "pi"].includes(plan.target)) {
    args.push("--protocol", protocolArgument(plan.protocol));
  }
  if (plan.target === "claude") {
    args.push("--auth-mode", plan.auth.mode === "x-api-key" ? "api-key" : "auth-token");
    args.push("--no-statusline");
  }
  if (plan.target === "pi") {
    const mode = plan.auth.mode === "none" ? "bearer" : authArgument(plan.auth.mode);
    args.push("--auth-mode", mode);
  }
  if (skipValidate) args.push("--skip-validate");
  if (force) args.push("--force");
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
