#!/usr/bin/env bash
# agent/pi/setup.sh — install Pi and choose a mainstream or custom provider.

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
AUTH_MODE=""
REGION=""
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
LIST_PROVIDERS=0
INTERACTIVE=0

SETTINGS_DIR="${HOME}/.pi/agent"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
MODELS_FILE="${SETTINGS_DIR}/models.json"
STATE_FILE="${SETTINGS_DIR}/.script-toolbox-provider"
KEY_DIR="${SETTINGS_DIR}/provider-keys"
MANAGED_BY="agent/pi/setup.sh"
STATE_UNSET="__SCRIPT_TOOLBOX_UNSET__"
SETUP_COMMAND="${AGENTCTL_SETUP_COMMAND:-./setup.sh}"
UNINSTALL_COMMAND="${AGENTCTL_UNINSTALL_COMMAND:-$0 --uninstall}"

usage() {
  cat <<EOF
${C_BOLD}${SETUP_COMMAND}${C_RESET} - interactive Pi provider setup

${C_BOLD}Usage:${C_RESET}
  ${SETUP_COMMAND} [options]

${C_BOLD}Options:${C_RESET}
  --provider <id>            anthropic, openai, google, deepseek, openrouter,
                             minimax-cn, minimax-global, or custom.
  --model <model-id>         Omit for an interactive model menu.
  --key <api-key>            Falls back to the provider's standard env var.
  --base-url <url>           Override the preset URL; required for custom.
  --models-url <url>         Override the key/model validation endpoint.
  --key-env <name>           Custom provider environment variable.
  --provider-name <name>     Display name for a custom provider.
  --protocol <type>          custom only: chat, responses, anthropic, or google.
  --auth-mode <mode>         custom only: bearer, api-key, or google-key.
  --region <china|global>    Backward-compatible alias for MiniMax selection.
  --list-providers           Print presets and current model IDs.
  --skip-validate            Skip the models endpoint probe.
  --force                    Replace a previous script-toolbox provider entry.
  --uninstall                Remove this script's provider and credential only.
  -h | --help                Show this help.

${C_BOLD}Examples:${C_RESET}
  ${SETUP_COMMAND}
  OPENAI_API_KEY=sk-... ${SETUP_COMMAND} --provider openai --model gpt-5.6
  ${SETUP_COMMAND} --provider custom --protocol chat --auth-mode bearer \\
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
minimax-cn      MiniMax-M3 (default), MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5
minimax-global  MiniMax-M3 (default), MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5
custom          OpenAI Chat Completions, Responses, Anthropic Messages, or Google Generative AI
EOF
}

remove_previous_provider() {
  local models_input="$1" models_output="$2" settings_input="$3" settings_output="$4"
  local old_id="" old_default_provider="" old_default_model=""

  if [ ! -f "$STATE_FILE" ]; then
    cp "$models_input" "$models_output" || return 1
    cp "$settings_input" "$settings_output" || return 1
    return 0
  fi

  old_id="$(sed -n '1p' "$STATE_FILE")"
  old_default_provider="$(sed -n '3p' "$STATE_FILE")"
  old_default_model="$(sed -n '4p' "$STATE_FILE")"
  old_default_provider="${old_default_provider:-$STATE_UNSET}"
  old_default_model="${old_default_model:-$STATE_UNSET}"
  case "$old_id" in
    script-toolbox-*)
      if ! jq --arg id "$old_id" '
        del(.providers[$id])
        | if (.providers // {}) == {} then del(.providers) else . end
      ' "$models_input" > "$models_output"; then
        return 1
      fi
      if ! jq \
        --arg id "$old_id" \
        --arg old_provider "$old_default_provider" \
        --arg old_model "$old_default_model" \
        --arg unset "$STATE_UNSET" '
        if .defaultProvider == $id
        then
          if $old_provider == $unset then del(.defaultProvider)
          else .defaultProvider = $old_provider
          end
          | if $old_model == $unset then del(.defaultModel)
            else .defaultModel = $old_model
            end
        else .
        end
      ' "$settings_input" > "$settings_output"; then
        return 1
      fi
      ;;
    *) die "unexpected provider ID in $STATE_FILE; refusing to remove it" ;;
  esac
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
    --auth-mode)      AUTH_MODE="${2:?}"; shift 2 ;;
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

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no settings.json at $SETTINGS_FILE"
  [ -f "$MODELS_FILE" ] || die "no models.json at $MODELS_FILE"
  [ -f "$STATE_FILE" ] || die "no $MANAGED_BY state marker; refusing to touch Pi configuration"
  ensure_jq
  require_json_object "$SETTINGS_FILE"
  require_json_object "$MODELS_FILE"
  OLD_KEY_FILE="$(previous_key_file)"
  TMP_MODELS="$(make_temp_near "$MODELS_FILE")"
  TMP_SETTINGS="$(make_temp_near "$SETTINGS_FILE")"
  if ! remove_previous_provider "$MODELS_FILE" "$TMP_MODELS" "$SETTINGS_FILE" "$TMP_SETTINGS"; then
    rm -f "$TMP_MODELS" "$TMP_SETTINGS"
    die "failed to update Pi configuration; the original files were left unchanged"
  fi
  if ! replace_file_pair "$TMP_MODELS" "$MODELS_FILE" "$TMP_SETTINGS" "$SETTINGS_FILE"; then
    die "failed to replace Pi configuration; both original files were restored"
  fi
  [ -z "$OLD_KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
  rm -f "$STATE_FILE"
  ok "removed $MANAGED_BY provider and credential"
  exit 0
fi

ensure_jq
mkdir -p "$SETTINGS_DIR"
[ -f "$SETTINGS_FILE" ] || printf '{}\n' > "$SETTINGS_FILE"
[ -f "$MODELS_FILE" ] || printf '{}\n' > "$MODELS_FILE"
require_json_object "$SETTINGS_FILE"
require_json_object "$MODELS_FILE"

if [ -n "$REGION" ] && [ -z "$PROVIDER" ]; then
  case "$REGION" in
    china)  PROVIDER="minimax-cn" ;;
    global) PROVIDER="minimax-global" ;;
    *)      die "--region must be china or global" ;;
  esac
fi

if [ -z "$PROVIDER" ]; then
  INTERACTIVE=1
  choose_menu "Choose the Pi provider:" 1 \
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
    API_TYPE="anthropic-messages"
    BASE_URL="https://api.anthropic.com"
    MODELS_URL="https://api.anthropic.com/v1/models"
    AUTH_HEADER=false
    VALIDATION_AUTH="x-api-key"
    KEY_ENV="ANTHROPIC_API_KEY"
    KEY_DOC_URL="https://console.anthropic.com/settings/keys"
    DEFAULT_MODEL="claude-sonnet-4-6"
    MODEL_CHOICES="anthropic"
    ;;
  openai)
    DISPLAY_NAME="OpenAI"
    API_TYPE="openai-responses"
    BASE_URL="https://api.openai.com/v1"
    MODELS_URL="https://api.openai.com/v1/models"
    AUTH_HEADER=true
    VALIDATION_AUTH="bearer"
    KEY_ENV="OPENAI_API_KEY"
    KEY_DOC_URL="https://platform.openai.com/api-keys"
    DEFAULT_MODEL="gpt-5.6"
    MODEL_CHOICES="openai"
    ;;
  google)
    DISPLAY_NAME="Google Gemini"
    API_TYPE="google-generative-ai"
    BASE_URL="https://generativelanguage.googleapis.com/v1beta"
    MODELS_URL="https://generativelanguage.googleapis.com/v1beta/models"
    AUTH_HEADER=false
    VALIDATION_AUTH="x-goog-api-key"
    KEY_ENV="GEMINI_API_KEY"
    KEY_DOC_URL="https://aistudio.google.com/app/apikey"
    DEFAULT_MODEL="gemini-3.6-flash"
    MODEL_CHOICES="google"
    ;;
  deepseek)
    DISPLAY_NAME="DeepSeek"
    API_TYPE="openai-completions"
    BASE_URL="https://api.deepseek.com"
    MODELS_URL="https://api.deepseek.com/models"
    AUTH_HEADER=true
    VALIDATION_AUTH="bearer"
    KEY_ENV="DEEPSEEK_API_KEY"
    KEY_DOC_URL="https://platform.deepseek.com/api_keys"
    DEFAULT_MODEL="deepseek-v4-pro"
    MODEL_CHOICES="deepseek"
    ;;
  openrouter)
    DISPLAY_NAME="OpenRouter"
    API_TYPE="openai-completions"
    BASE_URL="https://openrouter.ai/api/v1"
    MODELS_URL="https://openrouter.ai/api/v1/models"
    AUTH_HEADER=true
    VALIDATION_AUTH="bearer"
    KEY_ENV="OPENROUTER_API_KEY"
    KEY_DOC_URL="https://openrouter.ai/settings/keys"
    DEFAULT_MODEL="openai/gpt-5.6"
    MODEL_CHOICES="openrouter"
    ;;
  minimax-cn|minimax-global)
    DISPLAY_NAME="MiniMax"
    API_TYPE="anthropic-messages"
    AUTH_HEADER=true
    VALIDATION_AUTH="x-api-key"
    KEY_ENV="MINIMAX_API_KEY"
    DEFAULT_MODEL="MiniMax-M3"
    MODEL_CHOICES="minimax"
    if [ "$PROVIDER" = "minimax-cn" ]; then
      BASE_URL="https://api.minimaxi.com/anthropic"
      MODELS_URL="https://api.minimaxi.com/anthropic/v1/models"
      KEY_DOC_URL="https://platform.minimaxi.com/user-center/basic-information/interface-key"
    else
      BASE_URL="https://api.minimax.io/anthropic"
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
        "chat|OpenAI Chat Completions" \
        "responses|OpenAI Responses" \
        "anthropic|Anthropic Messages" \
        "google|Google Generative AI"
      PROTOCOL="$MENU_VALUE"
    fi
    PROTOCOL="${PROTOCOL:-chat}"
    case "$PROTOCOL" in
      chat)       API_TYPE="openai-completions"; DEFAULT_AUTH_MODE="bearer" ;;
      responses)  API_TYPE="openai-responses"; DEFAULT_AUTH_MODE="bearer" ;;
      anthropic)  API_TYPE="anthropic-messages"; DEFAULT_AUTH_MODE="api-key" ;;
      google)     API_TYPE="google-generative-ai"; DEFAULT_AUTH_MODE="google-key" ;;
      *) die "--protocol must be chat, responses, anthropic, or google" ;;
    esac
    if [ -z "$AUTH_MODE" ] && [ "$INTERACTIVE" = 1 ]; then
      choose_menu "How should the API key be sent?" 1 \
        "${DEFAULT_AUTH_MODE}|Recommended for the selected protocol" \
        "bearer|Authorization: Bearer" \
        "api-key|x-api-key" \
        "google-key|x-goog-api-key"
      AUTH_MODE="$MENU_VALUE"
    fi
    AUTH_MODE="${AUTH_MODE:-$DEFAULT_AUTH_MODE}"
    case "$AUTH_MODE" in
      bearer)     AUTH_HEADER=true;  VALIDATION_AUTH="bearer" ;;
      api-key)    AUTH_HEADER=false; VALIDATION_AUTH="x-api-key" ;;
      google-key) AUTH_HEADER=false; VALIDATION_AUTH="x-goog-api-key" ;;
      *) die "--auth-mode must be bearer, api-key, or google-key" ;;
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
          "MiniMax-M3|MiniMax M3" \
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
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  Pi provider setup                                            |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
info "Provider : $DISPLAY_NAME ($PROVIDER)"
info "Protocol : $API_TYPE"
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

ensure_node 22 19
if command -v pi >/dev/null 2>&1; then
  ok "Pi already installed ($(pi --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing @earendil-works/pi-coding-agent globally..."
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  command -v pi >/dev/null 2>&1 || die "pi is not on PATH after npm install"
  ok "Pi installed"
fi

PROVIDER_SUFFIX="$(safe_id "$PROVIDER")"
[ -n "$PROVIDER_SUFFIX" ] || die "provider ID did not contain usable characters"
PROVIDER_ID="script-toolbox-${PROVIDER_SUFFIX}"
KEY_FILE="${KEY_DIR}/${PROVIDER_ID}.key"
KEY_COMMAND='!cat "$HOME/.pi/agent/provider-keys/'"${PROVIDER_ID}"'.key"'

if [ -f "$STATE_FILE" ]; then
  old_id="$(sed -n '1p' "$STATE_FILE")"
  ORIGINAL_DEFAULT_PROVIDER="$(sed -n '3p' "$STATE_FILE")"
  ORIGINAL_DEFAULT_MODEL="$(sed -n '4p' "$STATE_FILE")"
  ORIGINAL_DEFAULT_PROVIDER="${ORIGINAL_DEFAULT_PROVIDER:-$STATE_UNSET}"
  ORIGINAL_DEFAULT_MODEL="${ORIGINAL_DEFAULT_MODEL:-$STATE_UNSET}"
  case "$old_id" in
    script-toolbox-*) ;;
    *) [ "$FORCE" = 1 ] || die "unexpected state marker; use --force to replace it" ;;
  esac
elif jq -e --arg id "$PROVIDER_ID" '.providers[$id] != null' "$MODELS_FILE" >/dev/null; then
  [ "$FORCE" = 1 ] || die "$MODELS_FILE already contains $PROVIDER_ID; use --force to replace it"
  ORIGINAL_DEFAULT_PROVIDER="$(jq -r '.defaultProvider // empty' "$SETTINGS_FILE")"
  ORIGINAL_DEFAULT_MODEL="$(jq -r '.defaultModel // empty' "$SETTINGS_FILE")"
  ORIGINAL_DEFAULT_PROVIDER="${ORIGINAL_DEFAULT_PROVIDER:-$STATE_UNSET}"
  ORIGINAL_DEFAULT_MODEL="${ORIGINAL_DEFAULT_MODEL:-$STATE_UNSET}"
else
  ORIGINAL_DEFAULT_PROVIDER="$(jq -r '.defaultProvider // empty' "$SETTINGS_FILE")"
  ORIGINAL_DEFAULT_MODEL="$(jq -r '.defaultModel // empty' "$SETTINGS_FILE")"
  ORIGINAL_DEFAULT_PROVIDER="${ORIGINAL_DEFAULT_PROVIDER:-$STATE_UNSET}"
  ORIGINAL_DEFAULT_MODEL="${ORIGINAL_DEFAULT_MODEL:-$STATE_UNSET}"
fi

OLD_KEY_FILE="$(previous_key_file)"
TMP_MODELS="$(make_temp_near "$MODELS_FILE")"
TMP_SETTINGS="$(make_temp_near "$SETTINGS_FILE")"
if ! remove_previous_provider "$MODELS_FILE" "$TMP_MODELS" "$SETTINGS_FILE" "$TMP_SETTINGS"; then
  rm -f "$TMP_MODELS" "$TMP_SETTINGS"
  die "failed to prepare Pi configuration; the original files were left unchanged"
fi

TMP_MODELS_OUT="$(make_temp_near "$MODELS_FILE")"
if ! jq \
  --arg id "$PROVIDER_ID" \
  --arg base "$BASE_URL" \
  --arg api "$API_TYPE" \
  --arg keycmd "$KEY_COMMAND" \
  --arg model "$MODEL" \
  --argjson auth_header "$AUTH_HEADER" '
  .providers = (.providers // {})
  | .providers[$id] = {
      baseUrl: $base,
      api: $api,
      apiKey: $keycmd,
      authHeader: $auth_header,
      models: [
        {
          id: $model,
          name: $model,
          reasoning: true
        }
      ]
    }
' "$TMP_MODELS" > "$TMP_MODELS_OUT"; then
  rm -f "$TMP_MODELS" "$TMP_SETTINGS" "$TMP_MODELS_OUT"
  die "failed to update $MODELS_FILE with jq; the original files were left unchanged"
fi

TMP_SETTINGS_OUT="$(make_temp_near "$SETTINGS_FILE")"
if ! jq \
  --arg id "$PROVIDER_ID" \
  --arg model "$MODEL" '
  .defaultProvider = $id
  | .defaultModel = $model
' "$TMP_SETTINGS" > "$TMP_SETTINGS_OUT"; then
  rm -f "$TMP_MODELS" "$TMP_SETTINGS" "$TMP_MODELS_OUT" "$TMP_SETTINGS_OUT"
  die "failed to update $SETTINGS_FILE with jq; the original files were left unchanged"
fi
rm -f "$TMP_MODELS" "$TMP_SETTINGS"

write_secret_file "$KEY_FILE" "$KEY"
if ! replace_file_pair "$TMP_MODELS_OUT" "$MODELS_FILE" "$TMP_SETTINGS_OUT" "$SETTINGS_FILE"; then
  die "failed to replace Pi configuration; both original files were restored"
fi
[ -z "$OLD_KEY_FILE" ] || [ "$OLD_KEY_FILE" = "$KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
write_secret_file "$STATE_FILE" "$(printf '%s\n%s\n%s\n%s' \
  "$PROVIDER_ID" "$KEY_FILE" "$ORIGINAL_DEFAULT_PROVIDER" "$ORIGINAL_DEFAULT_MODEL")"
ok "wrote Pi models/settings and a separate chmod-600 credential"

echo
printf '%s%s%s\n' "${C_BOLD}" "Ready" "${C_RESET}"
printf '  %s\n' "Run: pi"
printf '  %s\n' "Default model: $PROVIDER_ID/$MODEL"
printf '  %s\n' "Use /model to switch; uninstall this provider config with: $UNINSTALL_COMMAND"
ok "done"
