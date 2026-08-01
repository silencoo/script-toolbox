#!/usr/bin/env bash
# agent/codex/setup.sh — install Codex CLI and choose a Responses-compatible provider.

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
KEY_INPUT_FILE=""
KEY_ENV_OVERRIDE=""
BASE_URL_OVERRIDE=""
MODELS_URL_OVERRIDE=""
CUSTOM_NAME=""
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
LIST_PROVIDERS=0
INTERACTIVE=0
DRY_RUN=0

SETTINGS_DIR="${HOME}/.codex"
SETTINGS_FILE="${SETTINGS_DIR}/config.toml"
STATE_FILE="${SETTINGS_DIR}/.script-toolbox-provider-key"
KEY_DIR="${SETTINGS_DIR}/provider-keys"
MANAGED_BY="agent/codex/setup.sh"
BEGIN_MARKER="# >>> ${MANAGED_BY} >>>"
END_MARKER="# <<< ${MANAGED_BY} <<<"
PROFILE_NAME="script_toolbox"
SETUP_COMMAND="${AGENTCTL_SETUP_COMMAND:-./setup.sh}"
UNINSTALL_COMMAND="${AGENTCTL_UNINSTALL_COMMAND:-$0 --uninstall}"

usage() {
  cat <<EOF
${C_BOLD}${SETUP_COMMAND}${C_RESET} - interactive Codex provider setup

${C_BOLD}Usage:${C_RESET}
  ${SETUP_COMMAND} [options]

${C_BOLD}Options:${C_RESET}
  --provider <id>            openai, openrouter, or custom. Omit for a menu.
  --model <model-id>         Omit for an interactive model menu.
  --key <api-key>            Falls back to the provider's standard env var.
  --key-file <path>          Read the key from one owner-only file (recommended).
  --base-url <url>           Override the preset URL; required for custom.
  --models-url <url>         Override the key/model validation endpoint.
  --key-env <name>           Custom provider environment variable.
  --provider-name <name>     Display name for a custom provider.
  --list-providers           Print presets and current model IDs.
  --skip-validate            Skip the models endpoint probe.
  --dry-run                  Preview resolution without network/install/writes.
  --force                    Replace this script's previous/legacy block.
  --uninstall                Remove this script's provider/profile and key file.
  -h | --help                Show this help.

${C_BOLD}Important:${C_RESET}
  Current Codex only supports the Responses API for custom providers.
  Chat-Completions-only endpoints (including current MiniMax and DeepSeek)
  cannot be made compatible by setting wire_api = "chat".

${C_BOLD}Examples:${C_RESET}
  ${SETUP_COMMAND}
  OPENAI_API_KEY=sk-... ${SETUP_COMMAND} --provider openai --model gpt-5.6
  OPENROUTER_API_KEY=sk-or-... ${SETUP_COMMAND} --provider openrouter
  ${SETUP_COMMAND} --provider custom --base-url https://gateway.example.com/v1 \\
    --model my-model --key-env MY_API_KEY
EOF
}

list_providers() {
  cat <<'EOF'
openai      gpt-5.6 (default), gpt-5.6-terra, gpt-5.6-luna
openrouter  openai/gpt-5.6 (default), openrouter/auto, custom OpenRouter model ID
custom      any OpenAI Responses-compatible base URL and model ID

Not listed: providers exposing only /chat/completions. Current Codex accepts
wire_api = "responses" only.
EOF
}

strip_managed_block() {
  local input="$1" output="$2"
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
    $0 == begin { skip = 1; next }
    $0 == end   { skip = 0; next }
    !skip       { print }
  ' "$input" > "$output"
}

strip_legacy_minimax() {
  local input="$1" output="$2"
  awk -v mgr="$MANAGED_BY" '
    BEGIN { skip = 0 }
    /^\[[^]]+\]/ {
      sec = $0
      gsub(/^\[/, "", sec); gsub(/\].*$/, "", sec)
      skip = (sec == "model_providers.minimax" || sec == "profiles.minimax")
    }
    skip { next }
    index($0, mgr) { next }
    { print }
  ' "$input" > "$output"
}

toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

previous_key_file() {
  local old_key=""
  [ -f "$STATE_FILE" ] || return 0
  old_key="$(sed -n '1p' "$STATE_FILE")"
  case "$old_key" in
    "$KEY_DIR"/*.key) printf '%s' "$old_key" ;;
    *) warn "ignoring unexpected key path in $STATE_FILE"; return 0 ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --provider)       PROVIDER="${2:?}"; shift 2 ;;
    --model)          MODEL="${2:?}"; shift 2 ;;
    --key)            KEY="${2:?}"; shift 2 ;;
    --key-file)       KEY_INPUT_FILE="${2:?}"; shift 2 ;;
    --base-url)       BASE_URL_OVERRIDE="${2:?}"; shift 2 ;;
    --models-url)     MODELS_URL_OVERRIDE="${2:?}"; shift 2 ;;
    --key-env)        KEY_ENV_OVERRIDE="${2:?}"; shift 2 ;;
    --provider-name)  CUSTOM_NAME="${2:?}"; shift 2 ;;
    --region)         die "--region was a MiniMax-only option; current Codex requires a Responses-compatible provider" ;;
    --list-providers) LIST_PROVIDERS=1; shift ;;
    --skip-validate)  SKIP_VALIDATE=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
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

[ "$UNINSTALL" != 1 ] || [ "$DRY_RUN" != 1 ] ||
  die "--dry-run previews setup only and cannot be combined with --uninstall"

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no config.toml at $SETTINGS_FILE"
  if ! grep -qF "$BEGIN_MARKER" "$SETTINGS_FILE" && ! grep -q "$MANAGED_BY" "$SETTINGS_FILE"; then
    die "no $MANAGED_BY marker; refusing to touch config.toml"
  fi
  OLD_KEY_FILE="$(previous_key_file)"
  TMP="$(make_temp_near "$SETTINGS_FILE")"
  if ! strip_managed_block "$SETTINGS_FILE" "$TMP"; then
    rm -f "$TMP"
    die "failed to prepare config.toml update"
  fi
  if grep -q "$MANAGED_BY" "$TMP" 2>/dev/null; then
    TMP_LEGACY="$(make_temp_near "$SETTINGS_FILE")"
    if ! strip_legacy_minimax "$TMP" "$TMP_LEGACY"; then
      rm -f "$TMP" "$TMP_LEGACY"
      die "failed to remove the legacy Codex block"
    fi
    mv "$TMP_LEGACY" "$TMP"
  fi
  replace_file "$TMP" "$SETTINGS_FILE"
  [ -z "$OLD_KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
  rm -f "$STATE_FILE"
  ok "removed $MANAGED_BY provider/profile and credential"
  exit 0
fi

if [ -z "$PROVIDER" ]; then
  INTERACTIVE=1
  choose_menu "Choose the Codex provider:" 1 \
    "openai|OpenAI (official Responses API)" \
    "openrouter|OpenRouter (Responses API beta)" \
    "custom|Custom Responses-compatible provider"
  PROVIDER="$MENU_VALUE"
fi

case "$PROVIDER" in
  openai)
    DISPLAY_NAME="OpenAI"
    BASE_URL="https://api.openai.com/v1"
    MODELS_URL="https://api.openai.com/v1/models"
    KEY_ENV="OPENAI_API_KEY"
    KEY_DOC_URL="https://platform.openai.com/api-keys"
    DEFAULT_MODEL="gpt-5.6"
    MODEL_CHOICES="openai"
    ;;
  openrouter)
    DISPLAY_NAME="OpenRouter"
    BASE_URL="https://openrouter.ai/api/v1"
    MODELS_URL="https://openrouter.ai/api/v1/models"
    KEY_ENV="OPENROUTER_API_KEY"
    KEY_DOC_URL="https://openrouter.ai/settings/keys"
    DEFAULT_MODEL="openai/gpt-5.6"
    MODEL_CHOICES="openrouter"
    ;;
  custom)
    DISPLAY_NAME="${CUSTOM_NAME:-Custom Responses provider}"
    KEY_ENV="${KEY_ENV_OVERRIDE:-CUSTOM_API_KEY}"
    KEY_DOC_URL="your provider console"
    DEFAULT_MODEL=""
    MODEL_CHOICES="custom"
    BASE_URL="${BASE_URL_OVERRIDE:-}"
    [ -n "$BASE_URL" ] || {
      prompt_value "Responses-compatible base URL (usually ending in /v1)" ""
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
      openai)
        choose_menu "Choose a model:" 1 \
          "gpt-5.6|GPT-5.6 (flagship alias)" \
          "gpt-5.6-terra|GPT-5.6 Terra (balanced)" \
          "gpt-5.6-luna|GPT-5.6 Luna (efficient)" \
          "__custom__|Enter another OpenAI model ID"
        ;;
      openrouter)
        choose_menu "Choose a model:" 1 \
          "openai/gpt-5.6|OpenAI GPT-5.6 through OpenRouter" \
          "openrouter/auto|OpenRouter Auto" \
          "__custom__|Enter another OpenRouter model ID"
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

PROVIDER_SUFFIX="$(safe_id "$PROVIDER")"
[ -n "$PROVIDER_SUFFIX" ] || die "provider ID did not contain usable characters"
PROVIDER_ID="script_toolbox_${PROVIDER_SUFFIX}"
KEY_FILE="${KEY_DIR}/${PROVIDER_ID}.key"

resolve_api_key \
  "$KEY" "$KEY_INPUT_FILE" "$KEY_ENV" "$DRY_RUN" \
  "${DISPLAY_NAME} API key (see ${KEY_DOC_URL})"
KEY="$RESOLVED_API_KEY"

if [ "$SKIP_VALIDATE" = 1 ]; then
  VALIDATION_PLAN="skip (--skip-validate)"
else
  VALIDATION_PLAN="would probe $MODELS_URL"
fi
if [ "$DRY_RUN" = 1 ]; then
  print_provider_plan \
    "Codex" "$DISPLAY_NAME ($PROVIDER)" "$BASE_URL" "$MODEL" \
    "codex" "@openai/codex via npm" "$SETTINGS_FILE" "$STATE_FILE" \
    "$KEY_FILE (mode 600)" "$API_KEY_SOURCE" "$VALIDATION_PLAN"
  exit 0
fi

printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  Codex provider setup                                         |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
info "Provider : $DISPLAY_NAME ($PROVIDER)"
info "Base URL : $BASE_URL"
info "Model    : $MODEL"
info "Key      : $API_KEY_SOURCE"
echo

command -v curl >/dev/null 2>&1 || die "curl is required"
if [ "$SKIP_VALIDATE" = 1 ]; then
  warn "--skip-validate set; skipping provider probe"
else
  info "Validating the API key..."
  validate_model_api "$MODELS_URL" bearer "$KEY" "$MODEL"
fi

ensure_npm_cli codex @openai/codex "Codex CLI"

mkdir -p "$SETTINGS_DIR" "$KEY_DIR"
if [ ! -f "$SETTINGS_FILE" ]; then
  printf '# Codex CLI configuration.\n' > "$SETTINGS_FILE"
fi

if grep -qF "$BEGIN_MARKER" "$SETTINGS_FILE"; then
  info "refreshing the existing $MANAGED_BY block"
elif grep -q "$MANAGED_BY" "$SETTINGS_FILE"; then
  warn "upgrading the legacy MiniMax-only Codex block"
elif grep -q "\\[profiles.${PROFILE_NAME}\\]" "$SETTINGS_FILE" 2>/dev/null && [ "$FORCE" != 1 ]; then
  die "profile '$PROFILE_NAME' already exists but is not marked as ours; use --force"
fi

OLD_KEY_FILE="$(previous_key_file)"
TMP="$(make_temp_near "$SETTINGS_FILE")"
if ! strip_managed_block "$SETTINGS_FILE" "$TMP"; then
  rm -f "$TMP"
  die "failed to prepare config.toml update"
fi
if grep -q "$MANAGED_BY" "$TMP" 2>/dev/null; then
  TMP_LEGACY="$(make_temp_near "$SETTINGS_FILE")"
  if ! strip_legacy_minimax "$TMP" "$TMP_LEGACY"; then
    rm -f "$TMP" "$TMP_LEGACY"
    die "failed to upgrade the legacy Codex block"
  fi
  mv "$TMP_LEGACY" "$TMP"
fi

ESC_DISPLAY="$(toml_escape "$DISPLAY_NAME")"
ESC_BASE="$(toml_escape "$BASE_URL")"
ESC_MODEL="$(toml_escape "$MODEL")"
ESC_KEY_FILE="$(toml_escape "$KEY_FILE")"
{
  printf '\n%s\n' "$BEGIN_MARKER"
  printf '[model_providers.%s]\n' "$PROVIDER_ID"
  printf 'name = "%s"\n' "$ESC_DISPLAY"
  printf 'base_url = "%s"\n' "$ESC_BASE"
  printf 'wire_api = "responses"\n'
  printf 'requires_openai_auth = false\n'
  printf 'request_max_retries = 4\n'
  printf 'stream_max_retries = 10\n'
  printf 'stream_idle_timeout_ms = 300000\n'
  printf '\n[model_providers.%s.auth]\n' "$PROVIDER_ID"
  printf 'command = "cat"\n'
  printf 'args = ["%s"]\n' "$ESC_KEY_FILE"
  printf '\n[profiles.%s]\n' "$PROFILE_NAME"
  printf 'model = "%s"\n' "$ESC_MODEL"
  printf 'model_provider = "%s"\n' "$PROVIDER_ID"
  printf '%s\n' "$END_MARKER"
} >> "$TMP"

write_secret_file "$KEY_FILE" "$KEY"
replace_file "$TMP" "$SETTINGS_FILE"
[ -z "$OLD_KEY_FILE" ] || [ "$OLD_KEY_FILE" = "$KEY_FILE" ] || rm -f "$OLD_KEY_FILE"
write_secret_file "$STATE_FILE" "$KEY_FILE"
ok "wrote $SETTINGS_FILE and a separate chmod-600 credential"

echo
printf '%s%s%s\n' "${C_BOLD}" "Ready" "${C_RESET}"
printf '  %s\n' "Run: codex --profile $PROFILE_NAME"
printf '  %s\n' "Provider: $DISPLAY_NAME; model: $MODEL"
printf '  %s\n' "Uninstall this provider config: $UNINSTALL_COMMAND"
ok "done"
