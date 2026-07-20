#!/usr/bin/env bash
# agent/claude-code/setup.sh — point Claude Code at MiniMax (China by default).
#
# What it does:
#   1. Installs Claude Code (Anthropic's native installer first; npm fallback if that fails).
#   2. Installs Node.js 18+ so the npm fallback path is always available.
#   3. Validates the API key against the MiniMax /v1/models endpoint (skipped with --skip-validate).
#   4. Writes ~/.claude/settings.json with the MiniMax Anthropic-compatible base URL.
#   5. Scrubs stale ANTHROPIC_* exports from ~/.zshrc / ~/.bashrc that would
#      override settings.json (the silent "Both ANTHROPIC_AUTH_TOKEN and
#      ANTHROPIC_API_KEY set" warning on Claude Code startup).
#
# Re-runnable: safe to execute again. Pass --force to overwrite a different base URL.

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

SETTINGS_DIR="${HOME}/.claude"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"

# ---------- usage ----------
usage() {
  cat <<EOF
${C_BOLD}agent/claude-code/setup.sh${C_RESET} - point Claude Code at MiniMax

${C_BOLD}Usage:${C_RESET}
  setup.sh [options]

${C_BOLD}Options:${C_RESET}
  --region <china|global>   Default: china
                              china  -> https://api.minimaxi.com/anthropic
                              global -> https://api.minimax.io/anthropic
  --model  <model-id>       Default: MiniMax-M3
  --key    <api-key>        Default: read from \$MINIMAX_API_KEY, otherwise prompt
  --force                   Overwrite settings.json even if base URL differs
  --skip-validate           Skip the /v1/models probe (offline / sandboxed use)
  --uninstall               Remove the MiniMax entries from ~/.claude/settings.json
  -h | --help               Show this help

${C_BOLD}Examples:${C_RESET}
  # Interactive (prompts for the API key)
  ${C_DIM}./setup.sh${C_RESET}

  # Non-interactive
  ${C_DIM}MINIMAX_API_KEY=sk-... ./setup.sh${C_RESET}

  # International account + a newer model
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
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  agent/claude-code/setup.sh                                   |" "${C_RESET}"
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
  if [ ! -f "$SETTINGS_FILE" ]; then
    die "no settings.json at $SETTINGS_FILE"
  fi
  if command -v jq >/dev/null 2>&1; then
    jq '
      if .env then
        .env |= with_entries(select(.key | startswith("ANTHROPIC_") | not))
              | del(.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, .env.API_TIMEOUT_MS)
      else . end
      | del(.model)
    ' "$SETTINGS_FILE" > "$SETTINGS_FILE.tmp" && mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
    ok "removed MiniMax entries from $SETTINGS_FILE"
  else
    die "jq is required for --uninstall (install jq or edit the file by hand)"
  fi
  exit 0
fi

# ---------- preflight ----------
command -v curl >/dev/null 2>&1 || die "curl is required but not installed"

if ! command -v jq >/dev/null 2>&1; then
  warn "jq not found - /v1/models validation will be skipped. Install jq for the safety check."
fi

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
    warn "Node.js $NODE_MAJOR detected - the npm fallback path needs 18+. The native installer does not."
    install_node "$PM"
  else
    ok "Node.js $(node --version) found (kept for the npm fallback path)"
  fi
else
  info "Node.js not found - will only be needed if the native Claude Code installer fails."
  info "Installing anyway so the npm fallback is available…"
  install_node "$PM"
fi

command -v node >/dev/null 2>&1 || die "Node.js still not on PATH after install. Aborting."
command -v npm  >/dev/null 2>&1 || die "npm not on PATH after install. Aborting."
ok "Node.js $(node --version), npm $(npm --version)"

# ---------- install Claude Code if needed ----------
# Strategy (Anthropic's current recommendation is the native installer):
#   1. If `claude` is already on PATH, skip everything.
#   2. Try the native installer (`curl ... | bash` from claude.ai). No Node.js needed.
#   3. If that fails (sandboxed env, network restriction, etc.), fall back to the
#      npm path — which is why we still install Node.js below.
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code already installed ($(claude --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing Claude Code via Anthropic's native installer..."
  if curl -fsSL https://claude.ai/install.sh | bash; then
    if command -v claude >/dev/null 2>&1; then
      ok "Claude Code installed (native binary)"
    else
      warn "native installer exited 0 but 'claude' is not on PATH - falling back to npm"
      NATIVE_FAILED=1
    fi
  else
    warn "native installer failed (network blocked or sandbox?) - falling back to npm"
    NATIVE_FAILED=1
  fi

  if [ "${NATIVE_FAILED:-0}" = 1 ]; then
    # npm fallback path. Requires Node.js 18+ — we already installed it above.
    if command -v npm >/dev/null 2>&1; then
      info "Falling back to: npm install -g @anthropic-ai/claude-code"
      npm install -g @anthropic-ai/claude-code
      command -v claude >/dev/null 2>&1 || die "npm fallback also failed. Install Claude Code manually: https://claude.ai/download"
      ok "Claude Code installed (via npm)"
    else
      die "native installer failed and npm is unavailable. Install Claude Code manually: https://claude.ai/download"
    fi
  fi
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

# ---------- write ~/.claude/settings.json ----------
mkdir -p "$SETTINGS_DIR"
[ -w "$SETTINGS_DIR" ] || die "$SETTINGS_DIR is not writable. Fix permissions and re-run."

if [ -f "$SETTINGS_FILE" ]; then
  if grep -q "$BASE_URL" "$SETTINGS_FILE" 2>/dev/null; then
    info "settings.json already configured for ${BASE_URL} - updating in place"
  elif [ "$FORCE" = 1 ]; then
    warn "settings.json has a different base URL - overwriting (--force)"
  else
    die "settings.json exists with a different base URL.
  Re-run with --force to overwrite, or run --uninstall first."
  fi
fi

# Seed an empty object if the file is missing
if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{}\n' > "$SETTINGS_FILE"
fi

TMP="$(mktemp)"
jq \
  --arg url "$BASE_URL" \
  --arg tok "$KEY" \
  --arg m   "$MODEL" '
  .env = (.env // {}) |
  .env.ANTHROPIC_BASE_URL             = $url |
  .env.ANTHROPIC_AUTH_TOKEN           = $tok |
  .env.ANTHROPIC_MODEL                = $m |
  .env.ANTHROPIC_SMALL_FAST_MODEL     = $m |
  .env.ANTHROPIC_DEFAULT_SONNET_MODEL = $m |
  .env.ANTHROPIC_DEFAULT_OPUS_MODEL   = $m |
  .env.ANTHROPIC_DEFAULT_HAIKU_MODEL  = $m |
  .env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1" |
  .env.API_TIMEOUT_MS = "3000000" |
  .model = $m
' "$SETTINGS_FILE" > "$TMP" && mv "$TMP" "$SETTINGS_FILE"
chmod 600 "$SETTINGS_FILE"
ok "wrote $SETTINGS_FILE (chmod 600)"
echo

# ---------- unset conflicting env in this shell ----------
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL 2>/dev/null || true

# ---------- scrub stale exports from shell rc files ----------
# Claude Code warns:
#   "Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set - auth may not work as expected"
# whenever both are exported in the environment - typically because ~/.zshrc or ~/.bashrc
# still contains `export ANTHROPIC_API_KEY=...` left over from a previous `claude /login`
# or a manual copy-paste. settings.json is not enough; the warning comes from the shell env.
scrub_rc_file() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=' "$rc"; then
    if [ ! -t 0 ] || [ "$FORCE" = 1 ]; then
      local backup="${rc}.bak.$(date +%Y%m%d%H%M%S)"
      cp "$rc" "$backup"
      sed -i.tmp -E '/^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=/d' "$rc"
      rm -f "${rc}.tmp"
      ok "removed stale ANTHROPIC_* exports from $rc (backup: $backup)"
    else
      warn "$rc contains a stale ANTHROPIC_* export that will override settings.json."
      printf '  offending line(s):\n'
      grep -nE '^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=' "$rc" | sed 's/^/    /'
      if ask_yes_no "  Remove these lines from $rc now? (a backup will be saved)"; then
        local backup="${rc}.bak.$(date +%Y%m%d%H%M%S)"
        cp "$rc" "$backup"
        sed -i.tmp -E '/^[[:space:]]*(export[[:space:]]+)?(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=/d' "$rc"
        rm -f "${rc}.tmp"
        ok "removed stale ANTHROPIC_* exports from $rc (backup: $backup)"
      else
        warn "left $rc untouched - Claude Code may show 'Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set' on startup."
      fi
    fi
  fi
}

if [ "$UNINSTALL" != 1 ]; then
  for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.zshenv" "$HOME/.bash_profile"; do
    scrub_rc_file "$rc"
  done
fi

# ---------- post-install checklist ----------
printf '%s%s%s\n' "${C_BOLD}" "Next steps" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"
cat <<EOF
1. Start Claude Code:
     ${C_DIM}claude${C_RESET}

2. Inside the TUI, run:
     ${C_DIM}/status${C_RESET}   -> should show ${BASE_URL} and model ${MODEL}
     ${C_DIM}/model${C_RESET}    -> should list ${MODEL}

3. If you ever see this warning on startup:
     ${C_YELLOW}Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set - auth may not work as expected${C_RESET}

   it means your shell environment still has an old export (e.g. from a previous
   ${C_DIM}claude /login${C_RESET} that wrote ${C_DIM}export ANTHROPIC_API_KEY=...${C_RESET} into
   ${C_DIM}~/.zshrc${C_RESET} or ${C_DIM}~/.bashrc${C_RESET}). settings.json values are ignored
   when these shell vars are set. Re-run this script - it will scrub those lines
   for you, with a .bak backup.

4. To uninstall later:
     ${C_DIM}$0 --uninstall${C_RESET}
EOF
echo
ok "done"