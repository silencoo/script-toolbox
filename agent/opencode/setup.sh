#!/usr/bin/env bash
# agent/opencode/setup.sh — point OpenCode at MiniMax (China by default).
#
# What it does:
#   1. Installs opencode-ai via npm if missing.
#   2. Validates the API key against the MiniMax /v1/models endpoint.
#   3. Writes ~/.config/opencode/config.json with provider.anthropic.options.baseURL
#      overridden to the MiniMax Anthropic-compatible base URL.
#   4. Scrubs stale ANTHROPIC_* / OPENAI_API_KEY exports from
#      ~/.zshrc / ~/.bashrc that would override config.json.
#
# Re-runnable: safe to execute again. Pass --force to overwrite.

set -euo pipefail

# ---------- inlined common helpers (no shared lib) ----------
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

log()  { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "${C_BLUE}▸${C_RESET}" " " "$*"; }
ok()   { printf '%s%s%s\n' "${C_GREEN}✓${C_RESET}" " " "$*"; }
warn() { printf '%s%s%s\n' "${C_YELLOW}!${C_RESET}" " " "$*" >&2; }
err()  { printf '%s%s%s\n' "${C_RED}✗${C_RESET}" " " "$*" >&2; }
die()  { err "$*"; exit 1; }

on_error() {
  local exit_code=$?
  err "failed at line $1 (exit $exit_code)"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

ask_yes_no() {
  local ans
  while true; do
    printf '%s [y/N] ' "$1"
    read -r ans
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no|"") return 1 ;;
    esac
  done
}

detect_pm() {
  if   command -v apt-get >/dev/null 2>&1; then echo "apt"
  elif command -v dnf     >/dev/null 2>&1; then echo "dnf"
  elif command -v yum     >/dev/null 2>&1; then echo "yum"
  elif command -v brew    >/dev/null 2>&1; then echo "brew"
  elif command -v apk     >/dev/null 2>&1; then echo "apk"
  else echo "none"
  fi
}
# ---------- end inlined common helpers ----------

# ---------- defaults ----------
REGION="china"
MODEL="MiniMax-M3"
KEY=""
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0

SETTINGS_DIR="${HOME}/.config/opencode"
SETTINGS_FILE="${SETTINGS_DIR}/config.json"
# Marker we add under a "_managed_by" JSON key so --uninstall only strips
# what we wrote. Don't change without bumping a migration step.
MANAGED_BY="agent/opencode/setup.sh"

# ---------- usage ----------
usage() {
  cat <<EOF
${C_BOLD}agent/opencode/setup.sh${C_RESET} - point OpenCode at MiniMax

${C_BOLD}Usage:${C_RESET}
  setup.sh [options]

${C_BOLD}Options:${C_RESET}
  --region <china|global>   Default: china
                              china  -> https://api.minimaxi.com/anthropic
                              global -> https://api.minimax.io/anthropic
  --model  <model-id>       Default: MiniMax-M3
  --key    <api-key>        Default: read from \$MINIMAX_API_KEY, otherwise prompt
  --force                   Overwrite config.json even if base URL differs
  --skip-validate           Skip the /v1/models probe (offline / sandboxed use)
  --uninstall               Remove the MiniMax provider block from config.json
  -h | --help               Show this help

${C_BOLD}Examples:${C_RESET}
  # Interactive (prompts for the API key)
  ${C_DIM}./setup.sh${C_RESET}

  # Non-interactive
  ${C_DIM}MINIMAX_API_KEY=sk-... ./setup.sh${C_RESET}

  # International account + a specific model
  ${C_DIM}./setup.sh --region global --model MiniMax-M3${C_RESET}
EOF
}

# ---------- arg parse ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --region)         REGION="${2:?}"; shift 2 ;;
    --model)          MODEL="${2:?}"; shift 2 ;;
    --key)            KEY="${2:?}"; shift 2 ;;
    --force)          FORCE=1; shift ;;
    --skip-validate)  SKIP_VALIDATE=1; shift ;;
    --uninstall)      UNINSTALL=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "unknown argument: $1 (use --help)" ;;
  esac
done

# ---------- banner ----------
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  agent/opencode/setup.sh                                      |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
echo

# ---------- region -> URLs ----------
case "$REGION" in
  china)
    BASE_URL="https://api.minimaxi.com/anthropic"
    API_HOST="https://api.minimaxi.com"
    KEY_DOC_URL="https://platform.minimaxi.com/user-center/basic-information/interface-key"
    ;;
  global)
    BASE_URL="https://api.minimax.io/anthropic"
    API_HOST="https://api.minimax.io"
    KEY_DOC_URL="https://platform.minimax.io/user-center/basic-information/interface-key"
    ;;
  *)
    die "--region must be 'china' or 'global'"
    ;;
esac

info "Region : ${REGION}"
info "Base   : ${BASE_URL}"
info "Model  : ${MODEL}"
echo

# ---------- uninstall path ----------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no config.json at $SETTINGS_FILE"
  command -v jq >/dev/null 2>&1 || die "jq is required for --uninstall"
  jq --arg mgr "$MANAGED_BY" '
    .provider = (
      (.provider // {})
      | with_entries(
          if (.value | type) == "object" and .value._managed_by == $mgr
          then empty
          else .
          end
        )
    )
    | del(._managed_by)
  ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
  ok "removed ${MANAGED_BY}-owned entries from $SETTINGS_FILE"
  exit 0
fi

# ---------- preflight ----------
command -v curl >/dev/null 2>&1 || die "curl is required but not installed"
command -v jq   >/dev/null 2>&1 || warn "jq not found - /v1/models validation will be skipped"

# ---------- detect package manager ----------
PM="$(detect_pm)"

# ---------- install Node if needed ----------
install_node() {
  local pm="$1"
  case "$pm" in
    apt)
      info "Installing Node.js via NodeSource (requires sudo)..."
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    dnf|yum)
      info "Installing Node.js via NodeSource (requires sudo)..."
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo -E bash -
      sudo "$pm" install -y nodejs
      ;;
    brew)
      info "Installing Node.js via Homebrew..."
      brew install node
      ;;
    apk)
      info "Installing Node.js via apk..."
      sudo apk add --no-cache nodejs npm
      ;;
    *)
      die "could not detect a supported package manager. Install Node.js 18+ manually: https://nodejs.org/"
      ;;
  esac
}

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    warn "Node.js $NODE_MAJOR detected - OpenCode needs 18+. Attempting install..."
    install_node "$PM"
  else
    ok "Node.js $(node --version) found"
  fi
else
  info "Node.js not found - installing..."
  install_node "$PM"
fi

command -v node >/dev/null 2>&1 || die "Node.js still not on PATH after install. Aborting."
command -v npm  >/dev/null 2>&1 || die "npm not on PATH after install. Aborting."
ok "Node.js $(node --version), npm $(npm --version)"

# ---------- install OpenCode if needed ----------
if command -v opencode >/dev/null 2>&1; then
  ok "OpenCode already installed ($(opencode --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing opencode-ai globally..."
  npm install -g opencode-ai
  command -v opencode >/dev/null 2>&1 || die "opencode CLI not on PATH after install. Check npm prefix -g."
  ok "OpenCode installed"
fi
echo

# ---------- API key ----------
if [ -z "$KEY" ]; then
  KEY="${MINIMAX_API_KEY:-}"
fi

if [ -z "$KEY" ]; then
  printf '%s%s%s' "${C_BOLD}" "MiniMax API key (input hidden, see ${KEY_DOC_URL}): " "${C_RESET}"
  stty -echo 2>/dev/null || true
  IFS= read -r KEY
  stty echo 2>/dev/null || true
  printf '\n'
fi

if [ -z "$KEY" ]; then
  die "no API key supplied (use --key, \$MINIMAX_API_KEY, or the interactive prompt)"
fi
ok "API key captured"

# ---------- validate against /v1/models ----------
if [ "$SKIP_VALIDATE" = 1 ]; then
  warn "--skip-validate set; skipping /v1/models probe"
elif command -v jq >/dev/null 2>&1; then
  info "Validating key against ${API_HOST}/v1/models..."
  MODELS_JSON="$(mktemp)"
  HTTP_CODE="$(curl -sS -o "$MODELS_JSON" -w '%{http_code}' \
    -H "Authorization: Bearer $KEY" \
    "${API_HOST}/v1/models" || echo "000")"

  if [ "$HTTP_CODE" != "200" ]; then
    cat "$MODELS_JSON" >&2 || true
    rm -f "$MODELS_JSON"
    if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
      die "HTTP $HTTP_CODE from ${API_HOST}/v1/models.
  -> The key was rejected. Make sure you're using a Pay-as-You-Go key from
    ${KEY_DOC_URL}
    (Token-Plan / subscription keys do not work with coding tools)."
    else
      die "HTTP $HTTP_CODE from ${API_HOST}/v1/models - connectivity or region issue?"
    fi
  fi

  if ! jq -e --arg m "$MODEL" '.data[].id | select(. == $m)' "$MODELS_JSON" >/dev/null; then
    AVAILABLE="$(jq -r '.data[].id' "$MODELS_JSON" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
    rm -f "$MODELS_JSON"
    die "Model '${MODEL}' not visible to this key at ${API_HOST}.
  Available models: ${AVAILABLE:-<none>}
  -> Wrong region? Try --region $([ "$REGION" = "china" ] && echo global || echo china).
  -> Wrong key type? You need a Pay-as-You-Go key."
  fi
  rm -f "$MODELS_JSON"
  ok "Key valid, model '${MODEL}' is available"
else
  warn "jq not available - skipping validation"
fi
echo

# ---------- write ~/.config/opencode/config.json ----------
mkdir -p "$SETTINGS_DIR"
[ -w "$SETTINGS_DIR" ] || die "$SETTINGS_DIR is not writable. Fix permissions and re-run."

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{}\n' > "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
fi

# Idempotency: refuse to overwrite a different base URL without --force.
existing_url="$(jq -r '.provider.anthropic.options.baseURL // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
if [ -n "$existing_url" ] && [ "$existing_url" != "$BASE_URL" ]; then
  if [ "$FORCE" = 1 ]; then
    warn "config.json has a different provider.anthropic.baseURL - overwriting (--force)"
  else
    die "config.json already points at ${existing_url}.
  Re-run with --force to overwrite, or run --uninstall first."
  fi
fi

TMP="$(mktemp)"
jq --arg base "$BASE_URL" --arg mgr "$MANAGED_BY" '
  .provider = (.provider // {})
  | .provider.anthropic = (.provider.anthropic // {})
  | .provider.anthropic.options = (.provider.anthropic.options // {})
  | .provider.anthropic.options.baseURL = $base
  | .provider.anthropic._managed_by = $mgr
' "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE"
chmod 600 "$SETTINGS_FILE"
ok "wrote $SETTINGS_FILE (chmod 600)"
echo

# ---------- unset conflicting env in this shell ----------
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL OPENAI_API_KEY 2>/dev/null || true

# ---------- scrub stale exports from shell rc files ----------
scrub_rc_file() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=' "$rc"; then
    if [ ! -t 0 ] || [ "$FORCE" = 1 ]; then
      local backup="${rc}.bak.$(date +%Y%m%d%H%M%S)"
      cp "$rc" "$backup"
      sed -i.tmp -E '/^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=/d' "$rc"
      rm -f "${rc}.tmp"
      ok "removed stale provider env exports from $rc (backup: $backup)"
    else
      warn "$rc contains a stale provider env export that will override config.json."
      printf '  offending line(s):\n'
      grep -nE '^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=' "$rc" | sed 's/^/    /'
      if ask_yes_no "  Remove these lines from $rc now? (a backup will be saved)"; then
        local backup="${rc}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$rc" "$backup"
        sed -i.tmp -E '/^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|OPENAI_API_KEY)=/d' "$rc"
        rm -f "${rc}.tmp"
        ok "removed stale provider env exports from $rc (backup: $backup)"
      else
        warn "left $rc untouched - OpenCode may pick up the wrong key."
      fi
    fi
  fi
}

for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.zshenv" "$HOME/.bash_profile"; do
  scrub_rc_file "$rc"
done

# ---------- post-install checklist ----------
printf '%s%s%s\n' "${C_BOLD}" "Next steps" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"
cat <<EOF
1. Authenticate OpenCode with the MiniMax key:
     ${C_DIM}opencode auth login${C_RESET}
   Pick "Anthropic" as the provider when prompted - the base URL is
   already overridden in config.json.

2. Start OpenCode:
     ${C_DIM}opencode${C_RESET}

3. Inside the TUI, pick the model:
     ${C_DIM}/models${C_RESET}   -> choose ${MODEL}

4. To uninstall later:
     ${C_DIM}$0 --uninstall${C_RESET}
EOF
echo
ok "done"