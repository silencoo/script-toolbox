#!/usr/bin/env bash
# agent/codex/mcp.sh — add web/docs/browser MCP servers to OpenAI Codex CLI
#
# What it writes:
#   [mcp_servers.brave]      -> https://api.search.brave.com/mcp        (X-Subscription-Token header)
#   [mcp_servers.exa]        -> https://mcp.exa.ai/mcp                  (Bearer)
#   [mcp_servers.context7]   -> https://mcp.context7.com/mcp            (Bearer, optional)
#   [mcp_servers.chrome-devtools] -> local npx Chrome DevTools MCP server
#
# Codex reads MCP entries from [mcp_servers.<name>] tables inside
# ~/.codex/config.toml (NOT a separate mcpServers block).
#
# What it never touches:
#   [model_providers.*] - owned by setup.sh
#   [profiles.*] - owned by setup.sh
#   User-managed [mcp_servers.*] entries

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
# ---------- end inlined common helpers ----------

# ---------- defaults ----------
PROVIDERS=()
PROVIDER_KEYS=()
PENDING_KEYS=()
ALL=0
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
DRY_RUN=0

SETTINGS_DIR="${HOME}/.codex"
SETTINGS_FILE="${SETTINGS_DIR}/config.toml"
# NOTE: marker string for entries this script owns. Don't change without
# bumping a migration step.
MANAGED_BY="agent/codex/mcp.sh"
BEGIN_MARKER="# >>> ${MANAGED_BY} >>>"
END_MARKER="# <<< ${MANAGED_BY} <<<"
LEGACY_MARKER="# Managed by ${MANAGED_BY}"

get_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { printf '%s' "${PROVIDER_KEYS[$i]:-}"; return 0; }; done; return 1; }
set_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { PROVIDER_KEYS["$i"]="$2"; return 0; }; done; return 1; }

# ---------- provider registry (parallel indexed arrays for bash 3.2) ----------
P_NAME=(brave exa context7 chrome-devtools)
P_DISPLAY=("Brave Search" "Exa" "Context7" "Chrome DevTools")
P_TRANSPORT=("http" "http" "http" "stdio")
P_MCP_URL=(
  "https://api.search.brave.com/mcp"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
  "npx -y chrome-devtools-mcp@latest"
)
P_HDR=("X-Subscription-Token" "Authorization" "Authorization" "")
P_PREFIX=("" "Bearer " "Bearer " "")
P_VAL_URL=(
  "https://api.search.brave.com/res/v1/web/search?q=ping&count=1"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
  ""
)
P_KEY_MODE=("required" "required" "optional" "none")

ALL_PROVIDERS=("${P_NAME[@]}")

p_index() {
  local name="$1" i
  for i in "${!P_NAME[@]}"; do
    if [ "${P_NAME[$i]}" = "$name" ]; then printf '%s' "$i"; return 0; fi
  done
  return 1
}
p_display()  { local i; i="$(p_index "$1")" || { err "unknown provider: $1"; return 1; }; printf '%s' "${P_DISPLAY[$i]}"; }
p_transport(){ local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_TRANSPORT[$i]}"; }
p_mcp_url()  { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_MCP_URL[$i]}"; }
p_hdr()      { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_HDR[$i]}"; }
p_prefix()   { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_PREFIX[$i]}"; }
p_val_url()  { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_VAL_URL[$i]}"; }
p_key_mode() { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_KEY_MODE[$i]}"; }

toml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

strip_owned_mcp_blocks() {
  local input="$1" output="$2"
  awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v legacy="$LEGACY_MARKER" '
    $0 == begin  { in_marked = 1; next }
    $0 == end && in_marked { in_marked = 0; next }
    in_marked    { next }
    $0 == legacy { in_legacy = 1; in_legacy_block = 0; next }
    /^\[[^]]+\]/ {
      sec = $0
      gsub(/^\[/, "", sec); gsub(/\].*$/, "", sec)
      if (in_legacy && sec ~ /^mcp_servers\.(brave|exa|context7|chrome-devtools)(\.headers)?$/) {
        in_legacy_block = 1
        next
      }
      in_legacy = 0
      in_legacy_block = 0
      print
      next
    }
    in_legacy || in_legacy_block { next }
    { print }
    END { if (in_marked) exit 2 }
  ' "$input" > "$output"
}

strip_selected_mcp_blocks() {
  local input="$1" output="$2" selected="$3"
  awk -v selected=" $selected " '
    /^\[[^]]+\]/ {
      sec = $0
      gsub(/^\[/, "", sec); gsub(/\].*$/, "", sec)
      name = sec
      sub(/^mcp_servers\./, "", name)
      sub(/\.headers$/, "", name)
      skip = (sec ~ /^mcp_servers\./ && index(selected, " " name " ") > 0)
    }
    skip { next }
    { print }
  ' "$input" > "$output"
}

make_temp_near() {
  mktemp "${1}.tmp.XXXXXX"
}

replace_file() {
  local temporary="$1" target="$2"
  chmod 600 "$temporary"
  mv "$temporary" "$target"
}

# ---------- usage ----------
usage() {
  cat <<EOF
${C_BOLD}agent/codex/mcp.sh${C_RESET} - add web/docs/browser MCP servers to Codex CLI

${C_BOLD}Usage:${C_RESET}
  mcp.sh [options]

${C_BOLD}Options:${C_RESET}
  --provider <name>          Add a provider. Repeatable. name in {${ALL_PROVIDERS[*]}}
                             Default: choose each MCP interactively via /dev/tty.
  --key NAME=value           API key for provider NAME. Repeatable.
                             Falls back to env: BRAVE_API_KEY, EXA_API_KEY, CONTEXT7_API_KEY.
  --all                      Enable all four providers.
  --force                    Overwrite existing entries without asking.
  --skip-validate            Skip per-provider probes (offline use).
  --dry-run                  Print the would-be TOML, write nothing.
  --uninstall                Remove the [mcp_servers.*] blocks this script wrote.
  -h | --help                Show this help.
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
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  agent/codex/mcp.sh                                           |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
echo

# ---------- uninstall path ----------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no config.toml at $SETTINGS_FILE"
  if ! grep -qF "$BEGIN_MARKER" "$SETTINGS_FILE" && ! grep -qF "$LEGACY_MARKER" "$SETTINGS_FILE"; then
    die "no ${MANAGED_BY} marker; refusing to modify config.toml"
  fi
  info "Removing [mcp_servers.*] entries written by ${MANAGED_BY}..."
  TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
  if ! strip_owned_mcp_blocks "$SETTINGS_FILE" "$TMP_OUT"; then
    rm -f "$TMP_OUT"
    die "failed to prepare config.toml update"
  fi
  replace_file "$TMP_OUT" "$SETTINGS_FILE"
  ok "removed ${MANAGED_BY}-owned entries from $SETTINGS_FILE"
  exit 0
fi

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
    endpoint="$(p_mcp_url "$p")"
    case "$(p_key_mode "$p")" in
      optional) key_note="API key optional" ;;
      required) key_note="API key required" ;;
      none)     key_note="no API key; local process" ;;
    esac
    if ask_yes_no "Enable ${display} (${key_note}; ${endpoint})?"; then
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
    elif [ "$(p_key_mode "$k")" = "none" ]; then
      warn "--key $k=... provided but '$k' does not use an API key - ignoring"
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
  key_mode="$(p_key_mode "$p")"
  if [ "$key_mode" = "none" ]; then
    set_key "$p" ""
    info "${display}: no API key required"
    continue
  fi
  if [ -n "$(get_key "$p")" ]; then
    ok "${display}: using --key value"
    continue
  fi
  # Codex reads MCP headers via the [mcp_servers.<name>].headers table,
  # not env vars. We still respect env vars for key input convenience,
  # but never write them into the config.
  envname_upper="$(echo "$p" | tr '[:lower:]' '[:upper:]')_API_KEY"
  envval="${!envname_upper:-}"
  if [ -n "$envval" ]; then
    set_key "$p" "$envval"
    ok "${display}: using \$${envname_upper}"
    continue
  fi
  if [ "$key_mode" = "optional" ]; then
    if have_tty && ask_yes_no "${display} key is optional (higher rate limit). Provide one?"; then
      prompt_secret "${display} API key (input hidden)"
      set_key "$p" "$PROMPT_SECRET_REPLY"
    else
      set_key "$p" ""
      info "${display}: proceeding without a key (lower rate limit)"
    fi
  else
    if ! have_tty; then
      die "no key for required provider '${p}' (use --key ${p}=..., or set \$${envname_upper})"
    fi
    prompt_secret "${display} API key (input hidden)"
    [ -n "$PROMPT_SECRET_REPLY" ] || die "no key supplied for required provider '${p}'"
    set_key "$p" "$PROMPT_SECRET_REPLY"
  fi
done
echo

# ---------- validate each provider (same probes as agent/claude-code/mcp.sh) ----------
MCP_INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-codex-mcp","version":"0.1"}}}'

validate_provider() {
  local p="$1"
  local key hdr prefix val_url display transport
  transport="$(p_transport "$p")"
  display="$(p_display "$p")"

  info "Validating ${display}..."

  if [ "$transport" = "stdio" ]; then
    command -v node >/dev/null 2>&1 \
      || die "${display} requires Node.js LTS"
    command -v npx >/dev/null 2>&1 \
      || die "${display} requires npm/npx"
    npx -y chrome-devtools-mcp@latest --help >/dev/null 2>&1 \
      || die "${display} failed to start; check Node.js LTS and npm connectivity"
    ok "${display} launcher is available"
    return
  fi

  command -v curl >/dev/null 2>&1 \
    || die "${display} validation requires curl (or use --skip-validate)"
  key="$(get_key "$p")"
  hdr="$(p_hdr "$p")"
  prefix="$(p_prefix "$p")"
  val_url="$(p_val_url "$p")"

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
      if [ "$(p_key_mode "$p")" = "optional" ] && [ -z "$key" ]; then
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
    if [ "$(p_key_mode "$p")" = "optional" ] && [ -z "$(get_key "$p")" ]; then
      info "Skipping $(p_display "$p") probe (no key provided)"
      continue
    fi
    validate_provider "$p"
  done
fi
echo

# ---------- build the [mcp_servers.*] TOML block ----------
TMP_NEW="$(mktemp)"
{
  printf '\n%s\n' "$BEGIN_MARKER"
  for p in "${PROVIDERS[@]}"; do
    printf '\n[mcp_servers.%s]\n' "$p"
    if [ "$(p_transport "$p")" = "stdio" ]; then
      printf 'command = "npx"\n'
      printf 'args = ["-y", "chrome-devtools-mcp@latest"]\n'
    else
      url="$(p_mcp_url "$p")"
      hdr="$(p_hdr "$p")"
      prefix="$(p_prefix "$p")"
      key="$(get_key "$p")"
      escaped_header="$(toml_escape "$hdr")"
      escaped_value="$(toml_escape "${prefix}${key}")"

      printf 'url = "%s"\n' "$url"
      if [ -n "$key" ]; then
        printf '\n[mcp_servers.%s.headers]\n' "$p"
        printf '"%s" = "%s"\n' "$escaped_header" "$escaped_value"
      fi
    fi
  done
  printf '%s\n' "$END_MARKER"
} > "$TMP_NEW"

if [ "$DRY_RUN" = 1 ]; then
  printf '%s%s%s\n' "${C_BOLD}" "Dry run - would append the following to $SETTINGS_FILE:" "${C_RESET}"
  cat "$TMP_NEW"
  rm -f "$TMP_NEW"
  exit 0
fi

# ---------- write config.toml ----------
mkdir -p "$SETTINGS_DIR"
[ -w "$SETTINGS_DIR" ] || die "$SETTINGS_DIR is not writable - fix permissions and re-run"

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '# Codex CLI configuration. Created by %s.\n' "$MANAGED_BY" > "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
fi

# Strip only this script's prior block. User-owned entries survive unless a
# selected provider has the same table name and --force explicitly authorizes
# replacing that one entry.
TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
if ! strip_owned_mcp_blocks "$SETTINGS_FILE" "$TMP_OUT"; then
  rm -f "$TMP_NEW" "$TMP_OUT"
  die "failed to prepare config.toml update"
fi

conflict=0
for p in "${PROVIDERS[@]}"; do
  if grep -qE "^\\[mcp_servers\\.${p}(\\.headers)?\\][[:space:]]*$" "$TMP_OUT"; then
    warn "mcp_servers.${p} already exists and is not marked as ours"
    conflict=1
  fi
done
if [ "$conflict" = 1 ]; then
  if [ "$FORCE" != 1 ]; then
    rm -f "$TMP_NEW" "$TMP_OUT"
    die "config.toml has user-managed entries with the same names; re-run with --force to replace only those entries"
  fi
  SELECTED="${PROVIDERS[*]}"
  TMP_FORCE="$(make_temp_near "$SETTINGS_FILE")"
  if ! strip_selected_mcp_blocks "$TMP_OUT" "$TMP_FORCE" "$SELECTED"; then
    rm -f "$TMP_NEW" "$TMP_OUT" "$TMP_FORCE"
    die "failed to replace selected MCP entries"
  fi
  mv "$TMP_FORCE" "$TMP_OUT"
fi

if ! cat "$TMP_NEW" >> "$TMP_OUT"; then
  rm -f "$TMP_NEW" "$TMP_OUT"
  die "failed to build config.toml update"
fi
replace_file "$TMP_OUT" "$SETTINGS_FILE"
rm -f "$TMP_NEW"
ok "wrote $SETTINGS_FILE (chmod 600)"
echo

# ---------- post-install checklist ----------
printf '%s%s%s\n' "${C_BOLD}" "Next steps" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"
cat <<EOF
1. Start (or restart) Codex CLI:
     ${C_DIM}codex${C_RESET}

2. Inside the TUI, MCP servers should appear automatically.

3. Smoke-test one of each (the model decides which to call):
     ${C_DIM}"search the web for MiniMax M3 release notes 2026"${C_RESET}   -> brave
     ${C_DIM}"find recent blog posts about Claude Code with MiniMax"${C_RESET}   -> exa
     ${C_DIM}"what's the latest useGSAP hook signature in React?"${C_RESET}     -> context7
     ${C_DIM}"open example.com and inspect its network requests"${C_RESET}       -> chrome-devtools

4. To uninstall:
     ${C_DIM}$0 --uninstall${C_RESET}
EOF
echo
ok "done"
