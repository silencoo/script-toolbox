#!/usr/bin/env bash
# agent/opencode/setup.sh — install OpenCode and choose a mainstream or custom provider.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
COMMON_LIB="${SCRIPT_DIR}/../setup-lib.sh"
if [ -r "$COMMON_LIB" ]; then
  # shellcheck source=../setup-lib.sh
  . "$COMMON_LIB"
else
  command -v curl >/dev/null 2>&1 || { printf '%s\n' "curl is required" >&2; exit 1; }
  COMMON_LIB="$(mktemp)"
  curl -fsSL https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/setup-lib.sh > "$COMMON_LIB"
  # shellcheck source=../setup-lib.sh
  . "$COMMON_LIB"
  rm -f "$COMMON_LIB"
fi

on_error() {
  local exit_code=$?
  err "failed at line $1 (exit $exit_code)"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

PROVIDER=""
MODEL=""
KEY=""
KEY_ENV_OVERRIDE=""
BASE_URL_OVERRIDE=""
MODELS_URL_OVERRIDE=""
CUSTOM_NAME=""
PROTOCOL=""
REGION=""
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
LIST_PROVIDERS=0
INTERACTIVE=0

SETTINGS_DIR="${HOME}/.config/opencode"
SETTINGS_FILE="${SETTINGS_DIR}/opencode.json"
LEGACY_SETTINGS_FILE="${SETTINGS_DIR}/config.json"
STATE_FILE="${SETTINGS_DIR}/.script-toolbox-provider"
KEY_DIR="${SETTINGS_DIR}/provider-keys"
MANAGED_BY="agent/opencode/setup.sh"

usage() {
  cat <<EOF
${C_BOLD}agent/opencode/setup.sh${C_RESET} - interactive OpenCode provider setup

${C_BOLD}Usage:${C_RESET}
  setup.sh [options]

${C_BOLD}Options:${C_RESET}
  --provider <id>            anthropic, openai, google, deepseek, openrouter,
                             minimax-cn, minimax-global, or custom.
  --model <model-id>         Omit for an interactive model menu.
  --key <api-key>            Falls back to the provider's standard env var.
  --base-url <url>           Override the preset URL; required for custom.
  --models-url <url>         Override the key/model validation endpoint.
  --key-env <name>           Custom provider environment variable.
  --provider-name <name>     Display name for a custom provider.
  --protocol <type>          custom only: chat, responses, or anthropic.
  --region <china|global>    Backward-compatible alias for MiniMax selection.
  --list-providers           Print presets and current model IDs.
  --skip-validate            Skip the models endpoint probe.
  --force                    Replace a previous script-toolbox provider entry.
  --uninstall                Remove this script's provider and credential only.
  -h | --help                Show this help.

${C_BOLD}Examples:${C_RESET}
  ./setup.sh
  OPENAI_API_KEY=sk-... ./setup.sh --provider openai
  GEMINI_API_KEY=... ./setup.sh --provider google --model gemini-3.6-flash
  ./setup.sh --provider custom --protocol chat \\
    --base-url https://gateway.example.com/v1 --model my-model --key-env MY_API_KEY
EOF
}

list_providers() {
  cat <<'EOF'
anthropic       claude-sonnet-4-6 (default), claude-opus-4-8, claude-fable-5
openai          gpt-5.6 (default), gpt-5.6-terra, gpt-5.6-luna
google          gemini-3.6-flash (default), gemini-3.1-pro-preview, gemini-3.5-flash-lite
deepseek        deepseek-v4-pro (default), deepseek-v4-flash
openrouter      openai/gpt-5.6 (default), anthropic/claude-sonnet-4.6, openrouter/auto
minimax-cn      MiniMax-M2.7 (default), MiniMax-M2.7-highspeed, MiniMax-M2.5
minimax-global  MiniMax-M2.7 (default), MiniMax-M2.7-highspeed, MiniMax-M2.5
custom          OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages
EOF
}

migrate_legacy_file() {
  if [ ! -f "$SETTINGS_FILE" ] && [ -f "$LEGACY_SETTINGS_FILE" ]; then
    cp "$LEGACY_SETTINGS_FILE" "$SETTINGS_FILE"
    chmod 600 "$SETTINGS_FILE"
    warn "copied legacy config.json to the current global path: $SETTINGS_FILE"
  fi
}

remove_previous_provider() {
  local file="$1" output="$2" old_id=""
  if [ -f "$STATE_FILE" ]; then
    old_id="$(sed -n '1p' "$STATE_FILE")"
    case "$old_id" in
      script-toolbox-*)
        jq --arg id "$old_id" '
          del(.provider[$id])
          | if (.provider // {}) == {} then del(.provider) else . end
          | if (.model // "") | startswith($id + "/") then del(.model) else . end
          | if (.small_model // "") | startswith($id + "/") then del(.small_model) else . end
        ' "$file" > "$output"
        ;;
      *) die "unexpected provider ID in $STATE_FILE; refusing to remove it" ;;
    esac
  else
    # Migration for the old MiniMax-only setup, which put a private marker in
    # the built-in Anthropic provider object.
    jq --arg mgr "$MANAGED_BY" '
      if .provider.anthropic._managed_by == $mgr then
        del(.provider.anthropic.options.baseURL, .provider.anthropic._managed_by)
        | if (.provider.anthropic.options // {}) == {} then del(.provider.anthropic.options) else . end
        | if (.provider.anthropic // {}) == {} then del(.provider.anthropic) else . end
        | if (.provider // {}) == {} then del(.provider) else . end
      else . end
    ' "$file" > "$output"
  fi
}

previous_key_file() {
  local path=""
  [ -f "$STATE_FILE" ] || return 0
  path="$(sed -n '2p' "$STATE_FILE")"
  case "$path" in
    "$KEY_DIR"/*.key) printf '%s' "$path" ;;
    "") ;;
    *) die "unexpected key path in $STATE_FILE; refusing to continue" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --provider)       PROVIDER="${2:?}"; shift 2 ;;
    --model)          MODEL="${2:?}"; shift 2 ;;
    --key)            KEY="${2:?}"; shift 2 ;;
    --base-url)       BASE_URL_OVERRIDE="${2:?}"; shift 2 ;;
    --models-url)     MODELS_URL_OVERRIDE="${2:?}"; shift 2 ;;
    --key-env)        KEY_ENV_OVERRIDE="${2:?}"; shift 2 ;;
    --provider-name)  CUSTOM_NAME="${2:?}"; shift 2 ;;
    --protocol)       PROTOCOL="${2:?}"; shift 2 ;;
    --region)         REGION="${2:?}"; shift 2 ;;
    --list-providers) LIST_PROVIDERS=1; shift ;;
    --skip-validate)  SKIP_VALIDATE=1; shift ;;
    --force)          FORCE=1; shift ;;
    --uninstall)      UNINSTALL=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown argument: $1 (use --help)" ;;
  esac
done

if [ "$LIST_PROVIDERS" = 1 ]; then
  list_providers
  exit 0
fi

mkdir -p "$SETTINGS_DIR"
migrate_legacy_file

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no opencode.json at $SETTINGS_FILE"
  ensure_jq
  require_json_object "$SETTINGS_FILE"
  [ -f "$STATE_FILE" ] || {
    legacy="$(jq -r '.provider.anthropic._managed_by // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
    [ "$legacy" = "$MANAGED_BY" ] || die "no $MANAGED_BY state marker; refusing to touch opencode.json"
  }
  OLD_KEY_FILE="$(previous_key_file)"
  TMP="$(make_temp_near "$SETTINGS_FILE")"
  if ! remove_previous_provider "$SETTINGS_FILE" "$TMP"; then
    rm -f "$TMP"
    die "failed to update $SETTINGS_FILE; the original file was left unchanged"
  fi
  replace_file "$TMP" "$SETTINGS_FILE"
  [ -z "$OLD_KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
  rm -f "$STATE_FILE"
  ok "removed $MANAGED_BY provider and credential"
  exit 0
fi

ensure_jq

if [ -n "$REGION" ] && [ -z "$PROVIDER" ]; then
  case "$REGION" in
    china)  PROVIDER="minimax-cn" ;;
    global) PROVIDER="minimax-global" ;;
    *)      die "--region must be china or global" ;;
  esac
fi

if [ -z "$PROVIDER" ]; then
  INTERACTIVE=1
  choose_menu "Choose the OpenCode provider:" 1 \
    "anthropic|Anthropic" \
    "openai|OpenAI" \
    "google|Google Gemini" \
    "deepseek|DeepSeek" \
    "openrouter|OpenRouter" \
    "minimax-cn|MiniMax (mainland China)" \
    "minimax-global|MiniMax (international)" \
    "custom|Custom provider"
  PROVIDER="$MENU_VALUE"
fi

case "$PROVIDER" in
  anthropic)
    DISPLAY_NAME="Anthropic"
    NPM_PACKAGE="@ai-sdk/anthropic"
    BASE_URL="https://api.anthropic.com/v1"
    MODELS_URL="https://api.anthropic.com/v1/models"
    VALIDATION_AUTH="x-api-key"
    KEY_ENV="ANTHROPIC_API_KEY"
    KEY_DOC_URL="https://console.anthropic.com/settings/keys"
    DEFAULT_MODEL="claude-sonnet-4-6"
    MODEL_CHOICES="anthropic"
    ;;
  openai)
    DISPLAY_NAME="OpenAI"
    NPM_PACKAGE="@ai-sdk/openai"
    BASE_URL="https://api.openai.com/v1"
    MODELS_URL="https://api.openai.com/v1/models"
    VALIDATION_AUTH="bearer"
    KEY_ENV="OPENAI_API_KEY"
    KEY_DOC_URL="https://platform.openai.com/api-keys"
    DEFAULT_MODEL="gpt-5.6"
    MODEL_CHOICES="openai"
    ;;
  google)
    DISPLAY_NAME="Google Gemini"
    NPM_PACKAGE="@ai-sdk/google"
    BASE_URL="https://generativelanguage.googleapis.com/v1beta"
    MODELS_URL="https://generativelanguage.googleapis.com/v1beta/models"
    VALIDATION_AUTH="x-goog-api-key"
    KEY_ENV="GEMINI_API_KEY"
    KEY_DOC_URL="https://aistudio.google.com/app/apikey"
    DEFAULT_MODEL="gemini-3.6-flash"
    MODEL_CHOICES="google"
    ;;
  deepseek)
    DISPLAY_NAME="DeepSeek"
    NPM_PACKAGE="@ai-sdk/openai-compatible"
    BASE_URL="https://api.deepseek.com"
    MODELS_URL="https://api.deepseek.com/models"
    VALIDATION_AUTH="bearer"
    KEY_ENV="DEEPSEEK_API_KEY"
    KEY_DOC_URL="https://platform.deepseek.com/api_keys"
    DEFAULT_MODEL="deepseek-v4-pro"
    MODEL_CHOICES="deepseek"
    ;;
  openrouter)
    DISPLAY_NAME="OpenRouter"
    NPM_PACKAGE="@ai-sdk/openai-compatible"
    BASE_URL="https://openrouter.ai/api/v1"
    MODELS_URL="https://openrouter.ai/api/v1/models"
    VALIDATION_AUTH="bearer"
    KEY_ENV="OPENROUTER_API_KEY"
    KEY_DOC_URL="https://openrouter.ai/settings/keys"
    DEFAULT_MODEL="openai/gpt-5.6"
    MODEL_CHOICES="openrouter"
    ;;
  minimax-cn|minimax-global)
    DISPLAY_NAME="MiniMax"
    NPM_PACKAGE="@ai-sdk/anthropic"
    VALIDATION_AUTH="x-api-key"
    KEY_ENV="MINIMAX_API_KEY"
    DEFAULT_MODEL="MiniMax-M2.7"
    MODEL_CHOICES="minimax"
    if [ "$PROVIDER" = "minimax-cn" ]; then
      BASE_URL="https://api.minimaxi.com/anthropic/v1"
      MODELS_URL="https://api.minimaxi.com/anthropic/v1/models"
      KEY_DOC_URL="https://platform.minimaxi.com/user-center/basic-information/interface-key"
    else
      BASE_URL="https://api.minimax.io/anthropic/v1"
      MODELS_URL="https://api.minimax.io/anthropic/v1/models"
      KEY_DOC_URL="https://platform.minimax.io/user-center/basic-information/interface-key"
    fi
    ;;
  custom)
    DISPLAY_NAME="${CUSTOM_NAME:-Custom provider}"
    KEY_ENV="${KEY_ENV_OVERRIDE:-CUSTOM_API_KEY}"
    KEY_DOC_URL="your provider console"
    DEFAULT_MODEL=""
    MODEL_CHOICES="custom"
    if [ -z "$PROTOCOL" ] && [ "$INTERACTIVE" = 1 ]; then
      choose_menu "Choose the API protocol:" 1 \
        "chat|OpenAI Chat Completions (/chat/completions)" \
        "responses|OpenAI Responses (/responses)" \
        "anthropic|Anthropic Messages (/messages)"
      PROTOCOL="$MENU_VALUE"
    fi
    PROTOCOL="${PROTOCOL:-chat}"
    case "$PROTOCOL" in
      chat)       NPM_PACKAGE="@ai-sdk/openai-compatible"; VALIDATION_AUTH="bearer" ;;
      responses)  NPM_PACKAGE="@ai-sdk/openai"; VALIDATION_AUTH="bearer" ;;
      anthropic)  NPM_PACKAGE="@ai-sdk/anthropic"; VALIDATION_AUTH="x-api-key" ;;
      *) die "--protocol must be chat, responses, or anthropic" ;;
    esac
    BASE_URL="${BASE_URL_OVERRIDE:-}"
    [ -n "$BASE_URL" ] || {
      prompt_value "Provider base URL" ""
      BASE_URL="$PROMPT_REPLY"
    }
    MODELS_URL="$(derive_models_url "$BASE_URL")"
    ;;
  *) die "unknown provider '$PROVIDER' (use --list-providers)" ;;
esac

[ -n "$KEY_ENV_OVERRIDE" ] && KEY_ENV="$KEY_ENV_OVERRIDE"
[ -n "$BASE_URL_OVERRIDE" ] && BASE_URL="$BASE_URL_OVERRIDE"
[ -n "$MODELS_URL_OVERRIDE" ] && MODELS_URL="$MODELS_URL_OVERRIDE"

if [ -z "$MODEL" ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    case "$MODEL_CHOICES" in
      anthropic)
        choose_menu "Choose a model:" 1 \
          "claude-sonnet-4-6|Claude Sonnet 4.6" \
          "claude-opus-4-8|Claude Opus 4.8" \
          "claude-fable-5|Claude Fable 5" \
          "__custom__|Enter another model ID"
        ;;
      openai)
        choose_menu "Choose a model:" 1 \
          "gpt-5.6|GPT-5.6" \
          "gpt-5.6-terra|GPT-5.6 Terra" \
          "gpt-5.6-luna|GPT-5.6 Luna" \
          "__custom__|Enter another model ID"
        ;;
      google)
        choose_menu "Choose a model:" 1 \
          "gemini-3.6-flash|Gemini 3.6 Flash" \
          "gemini-3.1-pro-preview|Gemini 3.1 Pro Preview" \
          "gemini-3.5-flash-lite|Gemini 3.5 Flash-Lite" \
          "__custom__|Enter another model ID"
        ;;
      deepseek)
        choose_menu "Choose a model:" 1 \
          "deepseek-v4-pro|DeepSeek V4 Pro" \
          "deepseek-v4-flash|DeepSeek V4 Flash" \
          "__custom__|Enter another model ID"
        ;;
      openrouter)
        choose_menu "Choose a model:" 1 \
          "openai/gpt-5.6|OpenAI GPT-5.6" \
          "anthropic/claude-sonnet-4.6|Anthropic Claude Sonnet 4.6" \
          "openrouter/auto|OpenRouter Auto" \
          "__custom__|Enter another model ID"
        ;;
      minimax)
        choose_menu "Choose a model:" 1 \
          "MiniMax-M2.7|MiniMax M2.7" \
          "MiniMax-M2.7-highspeed|MiniMax M2.7 Highspeed" \
          "MiniMax-M2.5|MiniMax M2.5" \
          "__custom__|Enter another model ID"
        ;;
      custom) MENU_VALUE="__custom__" ;;
    esac
    MODEL="$MENU_VALUE"
    if [ "$MODEL" = "__custom__" ]; then
      prompt_value "Model ID" "$DEFAULT_MODEL"
      MODEL="$PROMPT_REPLY"
    fi
  else
    MODEL="$DEFAULT_MODEL"
  fi
fi
[ -n "$MODEL" ] || die "model ID is required (use --model)"

if [ -z "$KEY" ]; then
  KEY="$(read_env "$KEY_ENV")"
fi
if [ -z "$KEY" ]; then
  prompt_secret "${DISPLAY_NAME} API key (see ${KEY_DOC_URL})"
  KEY="$PROMPT_REPLY"
fi
[ -n "$KEY" ] || die "no API key supplied"

printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  OpenCode provider setup                                      |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
info "Provider : $DISPLAY_NAME ($PROVIDER)"
info "Protocol : $NPM_PACKAGE"
info "Base URL : $BASE_URL"
info "Model    : $MODEL"
echo

command -v curl >/dev/null 2>&1 || die "curl is required"
if [ "$SKIP_VALIDATE" = 1 ]; then
  warn "--skip-validate set; skipping provider probe"
else
  info "Validating the API key..."
  validate_model_api "$MODELS_URL" "$VALIDATION_AUTH" "$KEY" "$MODEL"
fi

ensure_npm_cli opencode opencode-ai "OpenCode"

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{}\n' > "$SETTINGS_FILE"
fi
require_json_object "$SETTINGS_FILE"

PROVIDER_SUFFIX="$(safe_id "$PROVIDER")"
[ -n "$PROVIDER_SUFFIX" ] || die "provider ID did not contain usable characters"
PROVIDER_ID="script-toolbox-${PROVIDER_SUFFIX}"
KEY_FILE="${KEY_DIR}/${PROVIDER_ID}.key"
KEY_REFERENCE="{file:${KEY_FILE}}"

OLD_KEY_FILE="$(previous_key_file)"
TMP_CLEAN="$(make_temp_near "$SETTINGS_FILE")"
if ! remove_previous_provider "$SETTINGS_FILE" "$TMP_CLEAN"; then
  rm -f "$TMP_CLEAN"
  die "failed to prepare $SETTINGS_FILE; the original file was left unchanged"
fi

TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
if ! jq \
  --arg id "$PROVIDER_ID" \
  --arg npm "$NPM_PACKAGE" \
  --arg name "$DISPLAY_NAME (script-toolbox)" \
  --arg base "$BASE_URL" \
  --arg keyref "$KEY_REFERENCE" \
  --arg model "$MODEL" '
  .["$schema"] = (.["$schema"] // "https://opencode.ai/config.json")
  | .provider = (.provider // {})
  | .provider[$id] = {
      npm: $npm,
      name: $name,
      options: {
        baseURL: $base,
        apiKey: $keyref
      },
      models: {
        ($model): {
          name: $model
        }
      }
    }
  | .model = ($id + "/" + $model)
' "$TMP_CLEAN" > "$TMP_OUT"; then
  rm -f "$TMP_CLEAN" "$TMP_OUT"
  die "failed to update $SETTINGS_FILE with jq; the original file was left unchanged"
fi
rm -f "$TMP_CLEAN"
write_secret_file "$KEY_FILE" "$KEY"
replace_file "$TMP_OUT" "$SETTINGS_FILE"
[ -z "$OLD_KEY_FILE" ] || [ "$OLD_KEY_FILE" = "$KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
write_secret_file "$STATE_FILE" "$(printf '%s\n%s' "$PROVIDER_ID" "$KEY_FILE")"
ok "wrote $SETTINGS_FILE and a separate chmod-600 credential"

echo
printf '%s%s%s\n' "${C_BOLD}" "Ready" "${C_RESET}"
printf '  %s\n' "Run: opencode"
printf '  %s\n' "Default model: $PROVIDER_ID/$MODEL"
printf '  %s\n' "Use /models to switch; uninstall this provider config with: $0 --uninstall"
ok "done"
