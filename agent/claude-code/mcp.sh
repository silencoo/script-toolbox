#!/usr/bin/env bash
# agent/claude-code/mcp.sh — add web/docs MCP servers to Claude Code
#
# What it writes:
#   mcpServers.brave       -> https://api.search.brave.com/mcp        (X-Subscription-Token)
#   mcpServers.exa         -> https://mcp.exa.ai/mcp                  (Bearer)
#   mcpServers.context7    -> https://mcp.context7.com/mcp            (Bearer, optional)
#
# What it never touches:
#   env   - owned by setup.sh
#   model - owned by setup.sh
#   mcpServers entries it didn't write (tracked via _managed_by marker)
#
# Why this exists: Anthropic-hosted Claude Code gets WebSearch / WebFetch and
# docs-aware retrieval for free. When you route through MiniMax (or any
# third-party Anthropic-compatible provider), those built-ins stop working -
# adding these three MCPs restores that capability.

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

select_tty() {
  if [ -t 0 ]; then
    TTY_MODE="stdio"
  elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
    TTY_MODE="devtty"
  else
    return 1
  fi
}

have_tty() {
  select_tty
}

ask_yes_no() {
  local ans lower
  have_tty || return 1
  while true; do
    if [ "$TTY_MODE" = "stdio" ]; then
      printf '%s [y/N] ' "$1" >&2
      IFS= read -r ans || return 1
    else
      printf '%s [y/N] ' "$1" > /dev/tty
      IFS= read -r ans < /dev/tty || return 1
    fi
    lower="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      y|yes) return 0 ;;
      n|no|"") return 1 ;;
    esac
  done
}

prompt_secret() {
  local label="$1" input
  have_tty || die "interactive API key input needs a TTY; use --key NAME=value or the provider environment variable"
  if [ "$TTY_MODE" = "stdio" ]; then
    printf '%s: ' "$label" >&2
    stty -echo <&0 2>/dev/null || true
    if ! IFS= read -r input; then
      stty echo <&0 2>/dev/null || true
      printf '\n' >&2
      die "failed to read API key from the terminal"
    fi
    stty echo <&0 2>/dev/null || true
    printf '\n' >&2
  else
    printf '%s: ' "$label" > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    if ! IFS= read -r input < /dev/tty; then
      stty echo < /dev/tty 2>/dev/null || true
      printf '\n' > /dev/tty
      die "failed to read API key from the terminal"
    fi
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty
  fi
  PROMPT_SECRET_REPLY="$input"
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

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "administrator privileges are required for package installation; install jq manually or add sudo"
  fi
}

ensure_jq() {
  local pm
  command -v jq >/dev/null 2>&1 && return 0
  pm="$(detect_pm)"
  warn "jq not found - installing it because JSON configuration cannot be updated without it"
  case "$pm" in
    apt)     run_as_root apt-get install -y jq ;;
    dnf|yum) run_as_root "$pm" install -y jq ;;
    brew)    brew install jq ;;
    apk)     run_as_root apk add --no-cache jq ;;
    *)       die "jq is required, and no supported package manager was found; install jq manually and re-run" ;;
  esac
  command -v jq >/dev/null 2>&1 || die "jq installation finished but jq is still not on PATH"
}

make_temp_near() {
  mktemp "${1}.tmp.XXXXXX"
}

replace_file() {
  local temporary="$1" target="$2"
  chmod 600 "$temporary"
  mv "$temporary" "$target"
}

require_json_object() {
  jq -e 'type == "object"' "$1" >/dev/null 2>&1 ||
    die "$1 is not a valid JSON object; it was left unchanged"
}

json_quote() {
  jq -Rn --arg value "$1" '$value'
}
# ---------- end inlined common helpers ----------

# ---------- defaults ----------
PROVIDERS=()                  # which providers to enable (in user-specified order)
PROVIDER_KEYS=()              # parallel array: PROVIDER_KEYS[i] is the key for PROVIDERS[i]
PENDING_KEYS=()               # --key flags parsed before we know the provider set
ALL=0
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
DRY_RUN=0

SETTINGS_DIR="${HOME}/.claude"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
# NOTE: this string is also the marker key inside ~/.claude/settings.json.
# Renaming it would orphan existing entries on a user's machine. Don't change.
MANAGED_BY="agent/claude-code/mcp.sh"

# Lookup helpers - bash 3.2 has no associative arrays, so we keep PROVIDERS
# in a flat array and walk it linearly. With <=10 providers this is negligible.
get_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { printf '%s' "${PROVIDER_KEYS[$i]:-}"; return 0; }; done; return 1; }
set_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { PROVIDER_KEYS["$i"]="$2"; return 0; }; done; return 1; }

# ---------- provider registry ----------
# Parallel indexed arrays (no associative arrays) so this works on bash 3.2
# (macOS /bin/bash). Each provider occupies a contiguous slot.
P_NAME=(brave exa context7)
P_DISPLAY=("Brave Search" "Exa" "Context7")
P_MCP_URL=(
  "https://api.search.brave.com/mcp"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
)
P_HDR=("X-Subscription-Token" "Authorization" "Authorization")
P_PREFIX=("" "Bearer " "Bearer ")
P_ENV=("BRAVE_API_KEY" "EXA_API_KEY" "CONTEXT7_API_KEY")
P_VAL_URL=(
  "https://api.search.brave.com/res/v1/web/search?q=ping&count=1"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
)
P_OPTIONAL=("no" "no" "yes")

ALL_PROVIDERS=("${P_NAME[@]}")

# Field-by-name lookups. Die with a clear message if the provider isn't registered.
p_index() {
  local name="$1" i
  for i in "${!P_NAME[@]}"; do
    if [ "${P_NAME[$i]}" = "$name" ]; then printf '%s' "$i"; return 0; fi
  done
  return 1
}
p_display()  { local i; i="$(p_index "$1")" || { err "unknown provider: $1"; return 1; }; printf '%s' "${P_DISPLAY[$i]}"; }
p_mcp_url()  { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_MCP_URL[$i]}"; }
p_hdr()      { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_HDR[$i]}"; }
p_prefix()   { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_PREFIX[$i]}"; }
p_env()      { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_ENV[$i]}"; }
p_val_url()  { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_VAL_URL[$i]}"; }
p_optional() { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_OPTIONAL[$i]}"; }

# ---------- usage ----------
usage() {
  cat <<EOF
${C_BOLD}agent/claude-code/mcp.sh${C_RESET} - add web/docs MCP servers to Claude Code

${C_BOLD}Usage:${C_RESET}
  mcp.sh [options]

${C_BOLD}Options:${C_RESET}
  --provider <name>          Add a provider to the set. Repeatable.
                             name in {${ALL_PROVIDERS[*]}}
                             Default: choose each MCP interactively via /dev/tty.
  --key NAME=value           API key for provider NAME. Repeatable.
                             e.g. --key brave=BSA... --key exa=EXA...
                             Falls back to env: BRAVE_API_KEY, EXA_API_KEY, CONTEXT7_API_KEY.
  --all                      Enable all three providers (still need keys).
  --force                    Overwrite existing mcpServers entries without asking.
  --skip-validate            Skip per-provider probes (offline use).
  --dry-run                  Print the would-be JSON, write nothing.
  --uninstall                Remove the mcpServers block this script wrote.
  -h | --help                Show this help.

${C_BOLD}Examples:${C_RESET}
  # Interactive - choose MCPs, then enter only the keys they need
  ${C_DIM}./mcp.sh${C_RESET}

  # Non-interactive, all three providers
  ${C_DIM}./mcp.sh --all \\
    --key brave=BSA... --key exa=EXA... --key context7=CT7...${C_RESET}

  # Just brave + exa, keys from env
  ${C_DIM}BRAVE_API_KEY=BSA... EXA_API_KEY=EXA... \\
    ./mcp.sh --provider brave --provider exa${C_RESET}

  # See what would change without writing
  ${C_DIM}./mcp.sh --dry-run${C_RESET}
EOF
}

# ---------- arg parse ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --provider)        PROVIDERS+=("${2:?}"); shift 2 ;;
    --key)
      kv="${2:?}"
      k="${kv%%=*}"
      v="${kv#*=}"
      PENDING_KEYS+=("$k=$v")
      shift 2
      ;;
    --all)             ALL=1; shift ;;
    --force)           FORCE=1; shift ;;
    --skip-validate)   SKIP_VALIDATE=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --uninstall)       UNINSTALL=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 die "unknown argument: $1 (use --help)" ;;
  esac
done

# ---------- banner ----------
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  agent/claude-code/mcp.sh                                     |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
echo

# ---------- uninstall path ----------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no settings.json at $SETTINGS_FILE"
  ensure_jq
  require_json_object "$SETTINGS_FILE"
  info "Removing MCP entries written by ${MANAGED_BY}..."
  TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
  if ! jq --arg mgr "$MANAGED_BY" '
    .mcpServers = (
      (.mcpServers // {})
      | with_entries(select(.value._managed_by != $mgr))
    )
    | if (.mcpServers // {}) == {} then del(.mcpServers) else . end
  ' "$SETTINGS_FILE" > "$TMP_OUT"; then
    rm -f "$TMP_OUT"
    die "failed to prepare settings.json update"
  fi
  replace_file "$TMP_OUT" "$SETTINGS_FILE"
  ok "removed ${MANAGED_BY}-owned entries from $SETTINGS_FILE"
  exit 0
fi

# ---------- preflight ----------
command -v curl >/dev/null 2>&1 || die "curl is required but not installed"
ensure_jq

# ---------- resolve provider set ----------
if [ "$ALL" = 1 ]; then
  PROVIDERS=("${ALL_PROVIDERS[@]}")
fi

if [ ${#PROVIDERS[@]} -eq 0 ]; then
  if ! have_tty; then
    die "no --provider / --all given and no interactive TTY is available - nothing to do"
  fi
  info "Interactive MCP selection - choose each service independently."
  for p in "${ALL_PROVIDERS[@]}"; do
    display="$(p_display "$p")"
    url="$(p_mcp_url "$p")"
    if [ "$(p_optional "$p")" = "yes" ]; then
      key_note="API key optional"
    else
      key_note="API key required"
    fi
    if ask_yes_no "Enable ${display} (${key_note}; ${url})?"; then
      PROVIDERS+=("$p")
    fi
  done
  if [ ${#PROVIDERS[@]} -eq 0 ]; then
    die "no providers selected - nothing to do"
  fi
fi
info "Selected MCPs: ${PROVIDERS[*]}"

# Validate names + apply pending --key flags
for p in "${PROVIDERS[@]}"; do
  p_display "$p" >/dev/null 2>&1 || die "unknown provider: '$p' (valid: ${ALL_PROVIDERS[*]})"
done
if [ ${#PENDING_KEYS[@]} -gt 0 ]; then
  for kv in "${PENDING_KEYS[@]}"; do
    k="${kv%%=*}"
    matched=0
    for p in "${PROVIDERS[@]}"; do
      if [ "$k" = "$p" ]; then matched=1; break; fi
    done
    if [ "$matched" = 0 ]; then
      warn "--key $k=... provided but '$k' isn't in the enabled provider set - ignoring"
    else
      set_key "$k" "${kv#*=}"
    fi
  done
fi
echo

# ---------- collect keys ----------
info "Collecting API keys (CLI flag -> env var -> hidden prompt)..."
for p in "${PROVIDERS[@]}"; do
  display="$(p_display "$p")"
  if [ -n "$(get_key "$p")" ]; then
    ok "${display}: using --key value"
    continue
  fi
  envname="$(p_env "$p")"
  envval="${!envname:-}"
  if [ -n "$envval" ]; then
    set_key "$p" "$envval"
    ok "${display}: using \$${envname}"
    continue
  fi
  if [ "$(p_optional "$p")" = "yes" ]; then
    if have_tty && ask_yes_no "${display} key is optional (higher rate limit). Provide one?"; then
      prompt_secret "${display} API key (input hidden)"
      set_key "$p" "$PROMPT_SECRET_REPLY"
    else
      set_key "$p" ""
      info "${display}: proceeding without a key (lower rate limit)"
    fi
  else
    if ! have_tty; then
      die "no key for required provider '${p}' (use --key ${p}=..., or set \$${envname})"
    fi
    prompt_secret "${display} API key (input hidden)"
    [ -n "$PROMPT_SECRET_REPLY" ] || die "no key supplied for required provider '${p}'"
    set_key "$p" "$PROMPT_SECRET_REPLY"
  fi
done
echo

# ---------- validate each provider ----------
MCP_INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-claude-code-mcp","version":"0.1"}}}'

validate_provider() {
  local p="$1"
  local key hdr prefix val_url display
  key="$(get_key "$p")"
  hdr="$(p_hdr "$p")"
  prefix="$(p_prefix "$p")"
  val_url="$(p_val_url "$p")"
  display="$(p_display "$p")"

  info "Validating ${display}..."

  if [ "$p" = "brave" ]; then
    HTTP="$(curl -sS -o /dev/null -w '%{http_code}' \
      -H "${hdr}: ${key}" "$val_url" || echo 000)"
    case "$HTTP" in
      200) ok "${display} key accepted" ;;
      401|403) die "${display} key rejected (HTTP $HTTP) - get one at https://brave.com/search/api/" ;;
      *) die "${display} probe failed (HTTP $HTTP)" ;;
    esac
    return
  fi

  local hdr_value="${prefix}${key}"
  local resp
  resp="$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "${hdr}: ${hdr_value}" \
    --data "$MCP_INIT_BODY" \
    "$val_url" || echo 000)"

  case "$resp" in
    200) ok "${display} accepted (${key:+with key}${key:+/rate-limit-boost}${key:-anonymous})" ;;
    401|403)
      if [ "$(p_optional "$p")" = "yes" ] && [ -z "$key" ]; then
        ok "${display} accepted anonymously"
      else
        die "${display} key rejected (HTTP $resp) - get one at ${p}.ai / context7.com"
      fi
      ;;
    *) die "${display} probe failed (HTTP $resp)" ;;
  esac
}

if [ "$SKIP_VALIDATE" = 1 ]; then
  warn "--skip-validate set; skipping per-provider probes"
else
  for p in "${PROVIDERS[@]}"; do
    if [ "$(p_optional "$p")" = "yes" ] && [ -z "$(get_key "$p")" ]; then
      info "Skipping $(p_display "$p") probe (no key provided)"
      continue
    fi
    validate_provider "$p"
  done
fi
echo

# ---------- build the mcpServers block ----------
TMP_NEW="$(mktemp)"
{
  printf '{\n'
  printf '  "mcpServers": {\n'
  first=1
  for p in "${PROVIDERS[@]}"; do
    if [ "$first" -eq 0 ]; then printf ',\n'; fi
    first=0
    url="$(p_mcp_url "$p")"
    hdr="$(p_hdr "$p")"
    prefix="$(p_prefix "$p")"
    key="$(get_key "$p")"
    env_var="$(p_env "$p")"

    printf '    %s: {\n' "$(json_quote "$p")"
    printf '      "type": "http",\n'
    printf '      "url": %s' "$(json_quote "$url")"
    if [ -n "$key" ]; then
      printf ',\n      "headers": { %s: %s }' \
        "$(json_quote "$hdr")" "$(json_quote "${prefix}${key}")"
      if [ -n "$env_var" ]; then
        printf ',\n      "env": { %s: %s }\n' \
          "$(json_quote "$env_var")" "$(json_quote "$key")"
      else
        printf '\n'
      fi
    else
      printf '\n'
    fi
    printf '    }'
  done
  printf '\n  }\n}\n'
} > "$TMP_NEW"

if [ "$DRY_RUN" = 1 ]; then
  printf '%s%s%s\n' "${C_BOLD}" "Dry run - would merge the following into $SETTINGS_FILE:" "${C_RESET}"
  cat "$TMP_NEW"
  rm -f "$TMP_NEW"
  exit 0
fi

# ---------- write settings.json (merge with existing, never touch env/model) ----------
mkdir -p "$SETTINGS_DIR"
[ -w "$SETTINGS_DIR" ] || die "$SETTINGS_DIR is not writable - fix permissions and re-run"

if [ -f "$SETTINGS_FILE" ]; then
  require_json_object "$SETTINGS_FILE"
  conflict=0
  for p in "${PROVIDERS[@]}"; do
    new_url="$(p_mcp_url "$p")"
    existing_url="$(jq -r --arg k "$p" '.mcpServers[$k].url // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
    if [ -n "$existing_url" ] && [ "$existing_url" != "$new_url" ]; then
      warn "mcpServers.${p} already points to ${existing_url} (this script would change it to ${new_url})"
      conflict=1
    fi
  done
  if [ "$conflict" = 1 ] && [ "$FORCE" != 1 ]; then
    die "settings.json has existing mcpServers with different URLs - re-run with --force to overwrite."
  fi
else
  printf '{}\n' > "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
fi

TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
if ! jq --slurpfile new "$TMP_NEW" --arg mgr "$MANAGED_BY" '
  .mcpServers = (.mcpServers // {})
  | reduce ($new[0].mcpServers | to_entries[]) as $e (.;
      .mcpServers[$e.key] = ($e.value + { _managed_by: $mgr }))
' "$SETTINGS_FILE" > "$TMP_OUT"; then
  rm -f "$TMP_NEW" "$TMP_OUT"
  die "failed to merge MCP entries; settings.json was left unchanged"
fi
replace_file "$TMP_OUT" "$SETTINGS_FILE"
rm -f "$TMP_NEW"
ok "wrote $SETTINGS_FILE (chmod 600)"
echo

# ---------- post-install checklist ----------
printf '%s%s%s\n' "${C_BOLD}" "Next steps" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"
cat <<EOF
1. Start (or restart) Claude Code:
     ${C_DIM}claude${C_RESET}

2. Inside the TUI, run:
     ${C_DIM}/mcp${C_RESET}    -> should list each provider as connected

3. Smoke-test one of each (the model decides which to call):
     ${C_DIM}"search the web for MiniMax M3 release notes 2026"${C_RESET}   -> brave
     ${C_DIM}"find recent blog posts about Claude Code with MiniMax"${C_RESET}   -> exa
     ${C_DIM}"what's the latest useGSAP hook signature in React?"${C_RESET}     -> context7

4. To uninstall:
     ${C_DIM}$0 --uninstall${C_RESET}
EOF
echo
ok "done"
