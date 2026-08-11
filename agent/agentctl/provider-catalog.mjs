import {
  CURRENT_PROVIDER_SCHEMA,
  validateProviderProfile,
  validateTarget
} from "./provider-schema.mjs";

function profile({
  name,
  description,
  protocol,
  endpoint,
  auth,
  model,
  compaction = { upstream: "none", policy: "auto" },
  context = { window_tokens: null, auto_compact_tokens: null },
  targets = {}
}) {
  return validateProviderProfile({
    schema: CURRENT_PROVIDER_SCHEMA,
    name,
    description,
    protocol,
    endpoint,
    auth,
    models: { default: model, aliases: {} },
    compaction,
    context,
    targets,
    platforms: {}
  });
}

const MINIMAX_MODELS = Object.freeze([
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5"
]);

const DEEPSEEK_MODEL_CONTEXTS = Object.freeze({
  "deepseek-v4-pro": Object.freeze({
    window_tokens: 1_000_000,
    auto_compact_tokens: null
  }),
  "deepseek-v4-flash": Object.freeze({
    window_tokens: 1_000_000,
    auto_compact_tokens: null
  })
});

const MINIMAX_MODEL_CONTEXTS = Object.freeze({
  "MiniMax-M3": Object.freeze({
    window_tokens: 1_000_000,
    auto_compact_tokens: 500_000
  }),
  "MiniMax-M2.7": Object.freeze({
    window_tokens: 204_800,
    auto_compact_tokens: null
  }),
  "MiniMax-M2.7-highspeed": Object.freeze({
    window_tokens: 204_800,
    auto_compact_tokens: null
  }),
  "MiniMax-M2.5": Object.freeze({
    window_tokens: 204_800,
    auto_compact_tokens: null
  })
});

// Keep these definitions available for explicit CLI use and existing profile
// restores, but omit endpoints we do not normally use from the default catalog
// shown by `provider list` and the TUI. Remove a name here to show it again.
const HIDDEN_BUILTIN_PROVIDERS = new Set([
  "anthropic-api",
  "openai-api",
  "openrouter",
  "minimax-global"
]);

const CATALOG = Object.freeze([
  {
    name: "anthropic-api",
    label: "Anthropic API",
    description: "Anthropic API-key access; separate from a Claude subscription login.",
    profile: profile({
      name: "anthropic-api",
      description: "Anthropic API-key access; separate from a Claude subscription login.",
      protocol: "anthropic_messages",
      endpoint: "https://api.anthropic.com",
      auth: { mode: "x-api-key", secret: "anthropic_api_key" },
      model: "claude-sonnet-4-6",
      compaction: { upstream: "anthropic_messages_beta", policy: "auto" },
      targets: {
        codex: { enabled: false },
        opencode: { endpoint: "https://api.anthropic.com/v1" }
      }
    }),
    models: {
      claude: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"],
      opencode: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"],
      pi: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"]
    },
    nativeAuth: { opencode: "anthropic" },
    validation: {
      claude: "https://api.anthropic.com/v1/models",
      opencode: "https://api.anthropic.com/v1/models",
      pi: "https://api.anthropic.com/v1/models"
    }
  },
  {
    name: "openai-api",
    label: "OpenAI API",
    description: "OpenAI platform API-key access; separate from a ChatGPT subscription login.",
    profile: profile({
      name: "openai-api",
      description: "OpenAI platform API-key access; separate from a ChatGPT subscription login.",
      protocol: "openai_responses",
      endpoint: "https://api.openai.com/v1",
      auth: { mode: "bearer", secret: "openai_api_key" },
      model: "gpt-5.6",
      compaction: { upstream: "responses_v2", policy: "auto" },
      targets: { claude: { enabled: false } }
    }),
    models: {
      codex: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
      opencode: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
      pi: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"]
    },
    nativeAuth: { opencode: "openai" },
    validation: {
      codex: "https://api.openai.com/v1/models",
      opencode: "https://api.openai.com/v1/models",
      pi: "https://api.openai.com/v1/models"
    }
  },
  {
    name: "google-gemini",
    label: "Google Gemini",
    description: "Google Generative Language API-key access.",
    profile: profile({
      name: "google-gemini",
      description: "Google Generative Language API-key access.",
      protocol: "google_generative",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
      auth: { mode: "x-goog-api-key", secret: "gemini_api_key" },
      model: "gemini-3.6-flash",
      targets: {
        claude: { enabled: false },
        codex: { enabled: false }
      }
    }),
    models: {
      opencode: ["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"],
      pi: ["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]
    },
    nativeAuth: { opencode: "google" },
    validation: {
      opencode: "https://generativelanguage.googleapis.com/v1beta/models",
      pi: "https://generativelanguage.googleapis.com/v1beta/models"
    }
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek direct API using its native OpenAI or Anthropic-compatible surface.",
    profile: profile({
      name: "deepseek",
      description: "DeepSeek direct API using its native OpenAI or Anthropic-compatible surface.",
      protocol: "openai_chat",
      endpoint: "https://api.deepseek.com",
      auth: { mode: "bearer", secret: "deepseek_api_key" },
      model: "deepseek-v4-pro",
      targets: {
        claude: {
          protocol: "anthropic_messages",
          endpoint: "https://api.deepseek.com/anthropic",
          context: structuredClone(DEEPSEEK_MODEL_CONTEXTS["deepseek-v4-pro"])
        },
        codex: { enabled: false }
      }
    }),
    models: {
      claude: ["deepseek-v4-pro", "deepseek-v4-flash"],
      opencode: ["deepseek-v4-pro", "deepseek-v4-flash"],
      pi: ["deepseek-v4-pro", "deepseek-v4-flash"]
    },
    modelContexts: {
      claude: DEEPSEEK_MODEL_CONTEXTS
    },
    nativeAuth: { opencode: "deepseek" },
    validation: {
      claude: "https://api.deepseek.com/models",
      opencode: "https://api.deepseek.com/models",
      pi: "https://api.deepseek.com/models"
    }
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    description: "OpenRouter routes through the native protocol supported by each client.",
    profile: profile({
      name: "openrouter",
      description: "OpenRouter routes through the native protocol supported by each client.",
      protocol: "openai_chat",
      endpoint: "https://openrouter.ai/api/v1",
      auth: { mode: "bearer", secret: "openrouter_api_key" },
      model: "openai/gpt-5.6",
      targets: {
        claude: {
          protocol: "anthropic_messages",
          endpoint: "https://openrouter.ai/api",
          model: "~anthropic/claude-sonnet-latest"
        },
        codex: { protocol: "openai_responses" }
      }
    }),
    models: {
      claude: ["~anthropic/claude-sonnet-latest", "~anthropic/claude-opus-latest", "openrouter/auto"],
      codex: ["openai/gpt-5.6", "openrouter/auto"],
      opencode: ["openai/gpt-5.6", "anthropic/claude-sonnet-4.6", "openrouter/auto"],
      pi: ["openai/gpt-5.6", "anthropic/claude-sonnet-4.6", "openrouter/auto"]
    },
    nativeAuth: { opencode: "openrouter" },
    validation: {
      claude: "https://openrouter.ai/api/v1/models",
      codex: "https://openrouter.ai/api/v1/models",
      opencode: "https://openrouter.ai/api/v1/models",
      pi: "https://openrouter.ai/api/v1/models"
    }
  },
  ...[
    ["minimax-cn", "MiniMax (China)", "https://api.minimaxi.com"],
    ["minimax-global", "MiniMax (Global)", "https://api.minimax.io"]
  ].map(([name, label, root]) => ({
    name,
    label,
    description: `${label} direct Anthropic-compatible API.`,
    profile: profile({
      name,
      description: `${label} direct Anthropic-compatible API.`,
      protocol: "anthropic_messages",
      endpoint: `${root}/anthropic`,
      auth: { mode: "bearer", secret: "minimax_api_key" },
      model: "MiniMax-M3",
      targets: {
        claude: {
          context: structuredClone(MINIMAX_MODEL_CONTEXTS["MiniMax-M3"])
        },
        codex: { enabled: false },
        opencode: {
          endpoint: `${root}/anthropic/v1`,
          auth: { mode: "x-api-key" }
        }
      }
    }),
    models: {
      claude: MINIMAX_MODELS,
      opencode: MINIMAX_MODELS,
      pi: MINIMAX_MODELS
    },
    modelContexts: {
      claude: MINIMAX_MODEL_CONTEXTS
    },
    validation: {
      claude: `${root}/anthropic/v1/models`,
      opencode: `${root}/anthropic/v1/models`,
      pi: `${root}/anthropic/v1/models`
    }
  }))
]);

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));

export function builtinProviderCatalog() {
  return CATALOG
    .filter((entry) => !HIDDEN_BUILTIN_PROVIDERS.has(entry.name))
    .map((entry) => structuredClone(entry));
}

export function builtinProvider(name) {
  const entry = BY_NAME.get(name);
  return entry ? structuredClone(entry) : null;
}

export function builtinProviderProfile(name) {
  return builtinProvider(name)?.profile || null;
}

export function builtinValidationUrl(name, target) {
  validateTarget(target);
  return BY_NAME.get(name)?.validation?.[target] || "";
}

export function builtinModels(name, target) {
  validateTarget(target);
  return [...(BY_NAME.get(name)?.models?.[target] || [])];
}

export function builtinModelContext(name, target, model) {
  validateTarget(target);
  const context = BY_NAME.get(name)?.modelContexts?.[target]?.[model];
  return context ? structuredClone(context) : null;
}

export function builtinNativeAuthProvider(name, target) {
  validateTarget(target);
  return BY_NAME.get(name)?.nativeAuth?.[target] || "";
}

export function isBuiltinProvider(name) {
  return BY_NAME.has(name);
}
