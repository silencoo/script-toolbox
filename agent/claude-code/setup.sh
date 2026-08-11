#!/usr/bin/env bash
# agent/claude-code/setup.sh — install Claude Code and choose an Anthropic-compatible provider.

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
AUTH_MODE_OVERRIDE=""
CONTEXT_WINDOW_TOKENS=""
AUTO_COMPACT_TOKENS=""
CONTEXT_POLICY_SET=0
REGION=""
FORCE=0
FORCE_CONTEXT=0
SKIP_VALIDATE=0
UNINSTALL=0
LIST_PROVIDERS=0
INTERACTIVE=0
CLEAN_SHELL_ENV=0
DRY_RUN=0
INSTALL_STATUSLINE=1

SETTINGS_DIR="${HOME}/.claude"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
STATE_FILE="${SETTINGS_DIR}/.script-toolbox-provider"
CONTEXT_STATE_FILE="${SETTINGS_DIR}/.script-toolbox-provider-context.json"
MANAGED_BY="agent/claude-code/setup.sh"
SETUP_COMMAND="${AGENTCTL_SETUP_COMMAND:-./setup.sh}"
UNINSTALL_COMMAND="${AGENTCTL_UNINSTALL_COMMAND:-$0 --uninstall}"

usage() {
  cat <<EOF
${C_BOLD}${SETUP_COMMAND}${C_RESET} - interactive Claude Code provider setup

${C_BOLD}Usage:${C_RESET}
  ${SETUP_COMMAND} [options]

${C_BOLD}Options:${C_RESET}
  --provider <id>            anthropic, deepseek, openrouter, minimax-cn,
                             minimax-global, or custom. Omit for a menu.
  --model <model-id>         Omit for an interactive model menu.
  --key <api-key>            Falls back to the provider's standard env var.
  --key-file <path>          Read the key from one owner-only file (recommended).
  --base-url <url>           Override the preset URL; required for custom.
  --models-url <url>         Override the key/model validation endpoint.
  --key-env <name>           Custom provider environment variable.
  --auth-mode <mode>         custom only: api-key or auth-token.
  --context-window-tokens <tokens|auto>
                             Set the real model window or restore the prior value.
  --auto-compact-tokens <tokens|auto>
                             Set the auto-compact trigger or restore the prior value.
  --region <china|global>    Backward-compatible alias for MiniMax selection.
  --list-providers           Print presets and current model IDs.
  --skip-validate            Skip the models endpoint probe.
  --dry-run                  Preview resolution without network/install/writes.
  --clean-shell-env          Back up shell rc files and remove ANTHROPIC auth
                             exports that would override settings.json.
  --no-statusline            Do not install/update the managed status-line
                             preset when settings.json has no external one.
  --force                    Replace a provider config not created by this script.
  --force-context            Replace context values changed after agentctl applied them.
  --uninstall                Remove only this script's Claude environment/model keys;
                             the independent status-line preset is preserved.
  -h | --help                Show this help.

${C_BOLD}Examples:${C_RESET}
  ${SETUP_COMMAND}
  ${SETUP_COMMAND} --provider deepseek --model deepseek-v4-pro
  OPENROUTER_API_KEY=sk-or-... ${SETUP_COMMAND} --provider openrouter
  ${SETUP_COMMAND} --provider custom --base-url https://gateway.example.com/anthropic \\
    --model my-model --key-env MY_API_KEY
EOF
}

list_providers() {
  cat <<'EOF'
anthropic       claude-sonnet-4-6 (default), claude-opus-4-8, claude-fable-5
deepseek        deepseek-v4-pro (default), deepseek-v4-flash
openrouter      ~anthropic/claude-sonnet-latest (default), ~anthropic/claude-opus-latest, openrouter/auto
minimax-cn      MiniMax-M3 (default), MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5
minimax-global  MiniMax-M3 (default), MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5
custom          any Anthropic Messages-compatible URL and model ID
EOF
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
    --auth-mode)      AUTH_MODE_OVERRIDE="${2:?}"; shift 2 ;;
    --context-window-tokens)
      CONTEXT_WINDOW_TOKENS="${2:?}"; CONTEXT_POLICY_SET=1; shift 2 ;;
    --auto-compact-tokens)
      AUTO_COMPACT_TOKENS="${2:?}"; CONTEXT_POLICY_SET=1; shift 2 ;;
    --region)         REGION="${2:?}"; shift 2 ;;
    --list-providers) LIST_PROVIDERS=1; shift ;;
    --skip-validate)  SKIP_VALIDATE=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --clean-shell-env) CLEAN_SHELL_ENV=1; shift ;;
    --no-statusline)   INSTALL_STATUSLINE=0; shift ;;
    --force)          FORCE=1; shift ;;
    --force-context)  FORCE_CONTEXT=1; shift ;;
    --uninstall)      UNINSTALL=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown argument: $1 (use --help)" ;;
  esac
done

if [ "$LIST_PROVIDERS" = 1 ]; then
  list_providers
  exit 0
fi

validate_context_tokens() {
  local value="$1" label="$2"
  [ -z "$value" ] && return 0
  [ "$value" = "auto" ] && return 0
  case "$value" in
    *[!0-9]*|0|0*) die "$label must be a positive integer or auto" ;;
  esac
  [ "$value" -le 10000000 ] 2>/dev/null ||
    die "$label must not exceed 10000000"
}

validate_context_tokens "$CONTEXT_WINDOW_TOKENS" "--context-window-tokens"
validate_context_tokens "$AUTO_COMPACT_TOKENS" "--auto-compact-tokens"
if [ -n "$CONTEXT_WINDOW_TOKENS" ] && [ "$CONTEXT_WINDOW_TOKENS" != "auto" ] &&
   [ -n "$AUTO_COMPACT_TOKENS" ] && [ "$AUTO_COMPACT_TOKENS" != "auto" ] &&
   [ "$AUTO_COMPACT_TOKENS" -gt "$CONTEXT_WINDOW_TOKENS" ]; then
  die "--auto-compact-tokens cannot exceed --context-window-tokens"
fi

CONTEXT_STATE_ACTION="preserve"
CONTEXT_STATE_TEMP=""

context_state_json() {
  if [ ! -e "$CONTEXT_STATE_FILE" ]; then
    jq -nc --arg managed_by "$MANAGED_BY" \
      '{schema: 1, managed_by: $managed_by, fields: {}}'
    return
  fi
  [ -f "$CONTEXT_STATE_FILE" ] && [ ! -L "$CONTEXT_STATE_FILE" ] ||
    die "context ownership state must be a regular, non-symlink file: $CONTEXT_STATE_FILE"
  case "$(file_mode "$CONTEXT_STATE_FILE")" in
    ?00|??00) ;;
    *) die "context ownership state must be owner-only (chmod 600): $CONTEXT_STATE_FILE" ;;
  esac
  [ "$(wc -c < "$CONTEXT_STATE_FILE" | tr -d ' ')" -le 65536 ] ||
    die "context ownership state is unexpectedly large: $CONTEXT_STATE_FILE"
  jq -ce --arg managed_by "$MANAGED_BY" '
    select(
    .schema == 1
    and .managed_by == $managed_by
    and (.fields | type == "object")
    and ((.fields | keys) - ["window_tokens", "auto_compact_tokens"] | length == 0)
    and (all(.fields[];
      type == "object"
      and ((keys - ["before", "applied"]) | length == 0)
      and (.before | type == "object")
      and ((.before | keys) - ["present", "value"] | length == 0)
      and (.before.present | type == "boolean")
      and (has("applied"))
    ))
    and (.fields.window_tokens == null or (
      (.fields.window_tokens.applied | type == "string")
      and (.fields.window_tokens.applied | test("^[1-9][0-9]*$"))
      and ((.fields.window_tokens.applied | tonumber) <= 10000000)
      and ([.fields.window_tokens.before.value | type] - ["null", "string", "number"] | length == 0)
    ))
    and (.fields.auto_compact_tokens == null or (
      (.fields.auto_compact_tokens.applied | type == "number")
      and (.fields.auto_compact_tokens.applied % 1 == 0)
      and (.fields.auto_compact_tokens.applied >= 1)
      and (.fields.auto_compact_tokens.applied <= 10000000)
      and ([.fields.auto_compact_tokens.before.value | type] - ["null", "number"] | length == 0)
    ))
    )
  ' "$CONTEXT_STATE_FILE" ||
    die "context ownership state is invalid: $CONTEXT_STATE_FILE"
}

apply_context_policy_to_temp() {
  local settings_temp="$1" old_state bundle next_settings window_managed auto_managed
  [ "$CONTEXT_POLICY_SET" = 1 ] || return 0
  old_state="$(context_state_json)"

  window_managed="$(printf '%s' "$old_state" | jq -r '.fields | has("window_tokens")')"
  auto_managed="$(printf '%s' "$old_state" | jq -r '.fields | has("auto_compact_tokens")')"
  if [ "$FORCE_CONTEXT" != 1 ] && [ -n "$CONTEXT_WINDOW_TOKENS" ] &&
     [ "$window_managed" = true ] &&
     ! printf '%s' "$old_state" | jq -e --slurpfile settings "$settings_temp" '
       .fields.window_tokens.applied ==
         ($settings[0].env.CLAUDE_CODE_MAX_CONTEXT_TOKENS // null)
     ' >/dev/null; then
    die "managed Claude context window changed externally; use --force to replace it"
  fi
  if [ "$FORCE_CONTEXT" != 1 ] && [ -n "$AUTO_COMPACT_TOKENS" ] &&
     [ "$auto_managed" = true ] &&
     ! printf '%s' "$old_state" | jq -e --slurpfile settings "$settings_temp" '
       .fields.auto_compact_tokens.applied ==
         ($settings[0].autoCompactWindow // null)
     ' >/dev/null; then
    die "managed Claude auto-compact window changed externally; use --force to replace it"
  fi

  bundle="$(make_temp_near "$settings_temp")"
  next_settings="$(make_temp_near "$settings_temp")"
  CONTEXT_STATE_TEMP="$(make_temp_near "$CONTEXT_STATE_FILE")"
  if ! jq -n \
    --slurpfile settings "$settings_temp" \
    --argjson old "$old_state" \
    --arg window "$CONTEXT_WINDOW_TOKENS" \
    --arg auto_compact "$AUTO_COMPACT_TOKENS" '
    ($settings[0]) as $current
    | {
        settings: (
          $current
          | if $window == "" then .
            elif $window == "auto" then
              if $old.fields.window_tokens == null then .
              elif $old.fields.window_tokens.before.present then
                .env = (.env // {})
                | .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS =
                    $old.fields.window_tokens.before.value
              else del(.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
              end
            else
              .env = (.env // {})
              | .env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = $window
            end
          | if .env == {} then del(.env) else . end
          | if $auto_compact == "" then .
            elif $auto_compact == "auto" then
              if $old.fields.auto_compact_tokens == null then .
              elif $old.fields.auto_compact_tokens.before.present then
                .autoCompactWindow = $old.fields.auto_compact_tokens.before.value
              else del(.autoCompactWindow)
              end
            else .autoCompactWindow = ($auto_compact | tonumber)
            end
        ),
        state: (
          $old
          | .fields = (.fields // {})
          | if $window == "" then .
            elif $window == "auto" then del(.fields.window_tokens)
            else
              .fields.window_tokens = (
                .fields.window_tokens // {
                  before: {
                    present: (($current.env // {}) | has("CLAUDE_CODE_MAX_CONTEXT_TOKENS")),
                    value: ($current.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS // null)
                  },
                  applied: null
                }
              )
              | .fields.window_tokens.applied = $window
            end
          | if $auto_compact == "" then .
            elif $auto_compact == "auto" then del(.fields.auto_compact_tokens)
            else
              .fields.auto_compact_tokens = (
                .fields.auto_compact_tokens // {
                  before: {
                    present: ($current | has("autoCompactWindow")),
                    value: ($current.autoCompactWindow // null)
                  },
                  applied: null
                }
              )
              | .fields.auto_compact_tokens.applied = ($auto_compact | tonumber)
            end
        )
      }
  ' > "$bundle"; then
    rm -f "$bundle" "$next_settings" "$CONTEXT_STATE_TEMP"
    CONTEXT_STATE_TEMP=""
    die "failed to render Claude context policy"
  fi
  jq '.settings' "$bundle" > "$next_settings" || {
    rm -f "$bundle" "$next_settings" "$CONTEXT_STATE_TEMP"
    CONTEXT_STATE_TEMP=""
    die "failed to render Claude context settings"
  }
  jq '.state' "$bundle" > "$CONTEXT_STATE_TEMP" || {
    rm -f "$bundle" "$next_settings" "$CONTEXT_STATE_TEMP"
    CONTEXT_STATE_TEMP=""
    die "failed to render Claude context ownership state"
  }
  rm -f "$bundle"
  replace_file "$next_settings" "$settings_temp"
  if jq -e '.fields | length == 0' "$CONTEXT_STATE_TEMP" >/dev/null; then
    rm -f "$CONTEXT_STATE_TEMP"
    CONTEXT_STATE_TEMP=""
    CONTEXT_STATE_ACTION="remove"
  else
    chmod 600 "$CONTEXT_STATE_TEMP"
    CONTEXT_STATE_ACTION="write"
  fi
}

finalize_context_state() {
  case "$CONTEXT_STATE_ACTION" in
    write)
      replace_file "$CONTEXT_STATE_TEMP" "$CONTEXT_STATE_FILE" 600
      CONTEXT_STATE_TEMP=""
      ;;
    remove) rm -f "$CONTEXT_STATE_FILE" ;;
  esac
}

[ "$UNINSTALL" != 1 ] || [ "$DRY_RUN" != 1 ] ||
  die "--dry-run previews setup only and cannot be combined with --uninstall"

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no settings.json at $SETTINGS_FILE"
  ensure_jq
  require_json_object "$SETTINGS_FILE"
  [ -f "$STATE_FILE" ] || {
    existing="$(jq -r '.env.ANTHROPIC_BASE_URL // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
    case "$existing" in
      *api.minimax.io*|*api.minimaxi.com*) warn "migrating legacy MiniMax install without a state marker" ;;
      *) die "no $MANAGED_BY state marker; refusing to remove possibly user-owned settings" ;;
    esac
  }
  TMP="$(make_temp_near "$SETTINGS_FILE")"
  if ! jq '
    if .env then
      del(
        .env.ANTHROPIC_BASE_URL,
        .env.ANTHROPIC_AUTH_TOKEN,
        .env.ANTHROPIC_API_KEY,
        .env.ANTHROPIC_MODEL,
        .env.ANTHROPIC_SMALL_FAST_MODEL,
        .env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        .env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        .env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        .env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
        .env.API_TIMEOUT_MS
      )
      | if .env == {} then del(.env) else . end
    else . end
    | del(.model)
  ' "$SETTINGS_FILE" > "$TMP"; then
    rm -f "$TMP"
    die "failed to update $SETTINGS_FILE with jq; the original file was left unchanged"
  fi
  if [ -e "$CONTEXT_STATE_FILE" ]; then
    CONTEXT_WINDOW_TOKENS="auto"
    AUTO_COMPACT_TOKENS="auto"
    CONTEXT_POLICY_SET=1
    apply_context_policy_to_temp "$TMP"
  fi
  replace_file "$TMP" "$SETTINGS_FILE"
  finalize_context_state
  rm -f "$STATE_FILE"
  ok "removed $MANAGED_BY settings"
  exit 0
fi

if [ -n "$REGION" ] && [ -z "$PROVIDER" ]; then
  case "$REGION" in
    china)  PROVIDER="minimax-cn" ;;
    global) PROVIDER="minimax-global" ;;
    *)      die "--region must be china or global" ;;
  esac
fi

if [ -z "$PROVIDER" ]; then
  INTERACTIVE=1
  choose_menu "Choose the Claude Code provider:" 1 \
    "anthropic|Anthropic (official Claude API)" \
    "deepseek|DeepSeek (Anthropic-compatible)" \
    "openrouter|OpenRouter (Anthropic skin)" \
    "minimax-cn|MiniMax (mainland China)" \
    "minimax-global|MiniMax (international)" \
    "custom|Custom Anthropic-compatible provider"
  PROVIDER="$MENU_VALUE"
fi

case "$PROVIDER" in
  anthropic)
    DISPLAY_NAME="Anthropic"
    BASE_URL="https://api.anthropic.com"
    MODELS_URL="https://api.anthropic.com/v1/models"
    KEY_ENV="ANTHROPIC_API_KEY"
    KEY_DOC_URL="https://console.anthropic.com/settings/keys"
    AUTH_MODE="api-key"
    VALIDATION_AUTH="x-api-key"
    DEFAULT_MODEL="claude-sonnet-4-6"
    MODEL_CHOICES="anthropic"
    ;;
  deepseek)
    DISPLAY_NAME="DeepSeek"
    BASE_URL="https://api.deepseek.com/anthropic"
    MODELS_URL="https://api.deepseek.com/models"
    KEY_ENV="DEEPSEEK_API_KEY"
    KEY_DOC_URL="https://platform.deepseek.com/api_keys"
    AUTH_MODE="auth-token"
    VALIDATION_AUTH="bearer"
    DEFAULT_MODEL="deepseek-v4-pro"
    MODEL_CHOICES="deepseek"
    ;;
  openrouter)
    DISPLAY_NAME="OpenRouter"
    BASE_URL="https://openrouter.ai/api"
    MODELS_URL="https://openrouter.ai/api/v1/models"
    KEY_ENV="OPENROUTER_API_KEY"
    KEY_DOC_URL="https://openrouter.ai/settings/keys"
    AUTH_MODE="auth-token"
    VALIDATION_AUTH="bearer"
    DEFAULT_MODEL="~anthropic/claude-sonnet-latest"
    MODEL_CHOICES="openrouter"
    ;;
  minimax-cn|minimax-global)
    DISPLAY_NAME="MiniMax"
    KEY_ENV="MINIMAX_API_KEY"
    AUTH_MODE="auth-token"
    VALIDATION_AUTH="x-api-key"
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
    DISPLAY_NAME="Custom provider"
    KEY_ENV="${KEY_ENV_OVERRIDE:-CUSTOM_API_KEY}"
    KEY_DOC_URL="your provider console"
    VALIDATION_AUTH="bearer"
    DEFAULT_MODEL=""
    MODEL_CHOICES="custom"
    BASE_URL="${BASE_URL_OVERRIDE:-}"
    [ -n "$BASE_URL" ] || {
      prompt_value "Anthropic-compatible base URL (before /v1/messages)" ""
      BASE_URL="$PROMPT_REPLY"
    }
    MODELS_URL="$(derive_models_url "$BASE_URL")"
    AUTH_MODE="${AUTH_MODE_OVERRIDE:-}"
    if [ -z "$AUTH_MODE" ] && [ "$INTERACTIVE" = 1 ]; then
      choose_menu "How should Claude Code send the key?" 1 \
        "auth-token|Bearer token (most gateways)" \
        "api-key|x-api-key (Anthropic SDK style)"
      AUTH_MODE="$MENU_VALUE"
    fi
    AUTH_MODE="${AUTH_MODE:-auth-token}"
    [ "$AUTH_MODE" = "api-key" ] && VALIDATION_AUTH="x-api-key"
    ;;
  *) die "unknown provider '$PROVIDER' (use --list-providers)" ;;
esac

[ -n "$KEY_ENV_OVERRIDE" ] && KEY_ENV="$KEY_ENV_OVERRIDE"
[ -n "$BASE_URL_OVERRIDE" ] && BASE_URL="$BASE_URL_OVERRIDE"
[ -n "$MODELS_URL_OVERRIDE" ] && MODELS_URL="$MODELS_URL_OVERRIDE"
[ -n "$AUTH_MODE_OVERRIDE" ] && AUTH_MODE="$AUTH_MODE_OVERRIDE"
case "$AUTH_MODE" in api-key|auth-token) ;; *) die "--auth-mode must be api-key or auth-token" ;; esac

if [ -z "$MODEL" ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    case "$MODEL_CHOICES" in
      anthropic)
        choose_menu "Choose a model:" 1 \
          "claude-sonnet-4-6|Claude Sonnet 4.6 (balanced default)" \
          "claude-opus-4-8|Claude Opus 4.8" \
          "claude-fable-5|Claude Fable 5" \
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
          "~anthropic/claude-sonnet-latest|Claude Sonnet latest route" \
          "~anthropic/claude-opus-latest|Claude Opus latest route" \
          "openrouter/auto|OpenRouter Auto" \
          "__custom__|Enter another OpenRouter model ID"
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
  CONFIG_PLAN="$SETTINGS_FILE"
  if [ "$INSTALL_STATUSLINE" = 1 ]; then
    CONFIG_PLAN="${CONFIG_PLAN}; managed status-line preset if no external statusLine exists"
  fi
  if [ "$CLEAN_SHELL_ENV" = 1 ]; then
    CONFIG_PLAN="${CONFIG_PLAN}; matching shell startup exports (with backups)"
  fi
  print_provider_plan \
    "Claude Code" "$DISPLAY_NAME ($PROVIDER)" "$BASE_URL" "$MODEL" \
    "claude" "Claude Code (native installer, npm fallback)" \
    "$CONFIG_PLAN" "$STATE_FILE" \
    "$SETTINGS_FILE (embedded, mode 600)" "$API_KEY_SOURCE" "$VALIDATION_PLAN"
  exit 0
fi

ensure_jq

printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  Claude Code provider setup                                   |" "${C_RESET}"
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
  validate_model_api "$MODELS_URL" "$VALIDATION_AUTH" "$KEY" "$MODEL"
fi

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing Claude Code through Anthropic's native installer..."
  if ! curl -fsSL https://claude.ai/install.sh | bash || ! command -v claude >/dev/null 2>&1; then
    warn "native install was unavailable; falling back to npm"
    ensure_npm_cli claude @anthropic-ai/claude-code "Claude Code"
  else
    ok "Claude Code installed"
  fi
fi

mkdir -p "$SETTINGS_DIR"
if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{}\n' > "$SETTINGS_FILE"
fi
require_json_object "$SETTINGS_FILE"

existing_url="$(jq -r '.env.ANTHROPIC_BASE_URL // empty' "$SETTINGS_FILE")"
if [ -n "$existing_url" ] && [ "$existing_url" != "$BASE_URL" ] && [ ! -f "$STATE_FILE" ]; then
  case "$existing_url" in
    *api.minimax.io*|*api.minimaxi.com*) warn "upgrading the legacy MiniMax-only setup" ;;
    *) [ "$FORCE" = 1 ] || die "settings.json already has ANTHROPIC_BASE_URL=$existing_url; use --force to replace it" ;;
  esac
fi

TMP="$(make_temp_near "$SETTINGS_FILE")"
if ! jq \
  --arg url "$BASE_URL" \
  --arg token "$KEY" \
  --arg model "$MODEL" \
  --arg auth "$AUTH_MODE" \
  --arg third "$([ "$PROVIDER" = "anthropic" ] && printf 0 || printf 1)" '
  .env = (.env // {})
  | .env.ANTHROPIC_BASE_URL = $url
  | .env.ANTHROPIC_MODEL = $model
  | .env.ANTHROPIC_SMALL_FAST_MODEL = $model
  | .env.ANTHROPIC_DEFAULT_SONNET_MODEL = $model
  | .env.ANTHROPIC_DEFAULT_OPUS_MODEL = $model
  | .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = $model
  | .model = $model
  | if $auth == "api-key"
    then .env.ANTHROPIC_API_KEY = $token | del(.env.ANTHROPIC_AUTH_TOKEN)
    else .env.ANTHROPIC_AUTH_TOKEN = $token | del(.env.ANTHROPIC_API_KEY)
    end
  | if $third == "1"
    then .env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
       | .env.API_TIMEOUT_MS = "3000000"
    else del(.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, .env.API_TIMEOUT_MS)
    end
' "$SETTINGS_FILE" > "$TMP"; then
  rm -f "$TMP"
  die "failed to update $SETTINGS_FILE with jq; the original file was left unchanged"
fi
apply_context_policy_to_temp "$TMP"
replace_file "$TMP" "$SETTINGS_FILE"
finalize_context_state
write_secret_file "$STATE_FILE" "$PROVIDER"
ok "wrote $SETTINGS_FILE (chmod 600)"

clean_shell_auth_exports() {
  local rc="$1" backup
  [ -f "$rc" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=' "$rc"; then
    if [ "$CLEAN_SHELL_ENV" = 1 ] ||
       { [ "$INTERACTIVE" = 1 ] && ask_yes_no "Remove duplicate ANTHROPIC auth exports from $rc? A backup will be saved."; }; then
      backup="${rc}.bak.$(date +%Y%m%d%H%M%S)"
      cp "$rc" "$backup"
      sed -i.tmp -E \
        '/^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=/d' \
        "$rc"
      rm -f "${rc}.tmp"
      ok "removed duplicate ANTHROPIC auth exports from $rc (backup: $backup)"
    else
      warn "$rc exports ANTHROPIC auth variables that override settings.json."
      warn "Re-run with --clean-shell-env, then open a new shell."
    fi
  fi
}

for rc in \
  "${ZDOTDIR:-$HOME}/.zshrc" \
  "${ZDOTDIR:-$HOME}/.zprofile" \
  "$HOME/.bashrc" \
  "$HOME/.bash_profile" \
  "$HOME/.profile"; do
  clean_shell_auth_exports "$rc"
done

if { [ "$AUTH_MODE" = "api-key" ] && [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; } ||
   { [ "$AUTH_MODE" = "auth-token" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; }; then
  warn "this already-running shell contains the other Claude credential type."
  warn "After cleaning shell startup files, run: unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL"
fi

install_default_statusline() {
  local manager="${SCRIPT_DIR}/statusline-setup.sh" downloaded_manager=""

  # An external command stays completely outside this setup's ownership. This
  # check also avoids downloading the optional helper for one-shot installs.
  if jq -e --arg command "~/.claude/scripts/script-toolbox-statusline.py" '
    has("statusLine")
    and .statusLine != {"type": "command", "command": $command}
  ' "$SETTINGS_FILE" >/dev/null 2>&1; then
    ok "kept the existing Claude Code status line"
    return 0
  fi

  if [ ! -x "$manager" ]; then
    downloaded_manager="$(mktemp)"
    if ! curl -fsSL \
      https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/claude-code/statusline-setup.sh \
      > "$downloaded_manager"; then
      rm -f "$downloaded_manager"
      warn "status-line preset helper could not be downloaded; provider setup is otherwise complete"
      return 0
    fi
    chmod 700 "$downloaded_manager"
    manager="$downloaded_manager"
  fi

  if ! AGENTCTL_STATUSLINE_COMMAND="$manager" \
    "$manager" install --yes --if-missing; then
    warn "provider setup succeeded, but the optional status-line preset was not installed"
    warn "Fix the reported issue, then run the status-line manager again"
  fi
  [ -z "$downloaded_manager" ] || rm -f "$downloaded_manager"
}

if [ "$INSTALL_STATUSLINE" = 1 ]; then
  install_default_statusline
fi

echo
printf '%s%s%s\n' "${C_BOLD}" "Ready" "${C_RESET}"
printf '  %s\n' "Run: claude"
printf '  %s\n' "Then check /status and /model; expected provider URL: $BASE_URL"
printf '  %s\n' "Uninstall this provider config: $UNINSTALL_COMMAND"
ok "done"
