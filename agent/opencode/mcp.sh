#!/usr/bin/env bash
# agent/opencode/mcp.sh — add web/docs/browser/repository MCP servers to OpenCode
#
# What it writes (in ~/.config/opencode/opencode.json):
#   mcp.brave      -> https://api.search.brave.com/mcp        (X-Subscription-Token)
#   mcp.exa        -> https://mcp.exa.ai/mcp                  (Bearer)
#   mcp.context7   -> https://mcp.context7.com/mcp            (Bearer, optional)
#   mcp.github     -> https://api.githubcopilot.com/mcp/       (Bearer from environment)
#   mcp.chrome-devtools -> local Chrome DevTools MCP + CloakBrowser
#
# OpenCode's MCP config is shaped like { "mcp": { "<name>": { type, ... } } }
# (different from Claude Code's "mcpServers" key).
#
# What it never touches:
#   provider.* - owned by setup.sh
#   Any other top-level key

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
PROVIDERS=()
PROVIDER_KEYS=()
PENDING_KEYS=()
ALL=0
FORCE=0
SKIP_VALIDATE=0
UNINSTALL=0
DRY_RUN=0
CHROME_BROWSER="cloak"
CLOAKBROWSER_EXECUTABLE="${CLOAKBROWSER_BINARY_PATH:-}"

SETTINGS_DIR="${HOME}/.config/opencode"
SETTINGS_FILE="${SETTINGS_DIR}/opencode.json"
LEGACY_SETTINGS_FILE="${SETTINGS_DIR}/config.json"
# Marker string for entries this script owns. Don't change without bumping
# a migration step.
MANAGED_BY="agent/opencode/mcp.sh"

get_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { printf '%s' "${PROVIDER_KEYS[$i]:-}"; return 0; }; done; return 1; }
set_key()  { local i; for i in "${!PROVIDERS[@]}"; do [ "${PROVIDERS[$i]}" = "$1" ] && { PROVIDER_KEYS["$i"]="$2"; return 0; }; done; return 1; }

# ---------- provider registry (parallel indexed arrays for bash 3.2) ----------
P_NAME=(brave exa context7 github chrome-devtools)
P_DISPLAY=("Brave Search" "Exa" "Context7" "GitHub" "Chrome DevTools")
P_TRANSPORT=("http" "http" "http" "http" "stdio")
P_MCP_URL=(
  "https://api.search.brave.com/mcp"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
  "https://api.githubcopilot.com/mcp/"
  "npx -y chrome-devtools-mcp@latest"
)
P_HDR=("X-Subscription-Token" "Authorization" "Authorization" "Authorization" "")
P_PREFIX=("" "Bearer " "Bearer " "Bearer " "")
P_ENV=("BRAVE_API_KEY" "EXA_API_KEY" "CONTEXT7_API_KEY" "GITHUB_PERSONAL_ACCESS_TOKEN" "")
P_VAL_URL=(
  "https://api.search.brave.com/res/v1/web/search?q=ping&count=1"
  "https://mcp.exa.ai/mcp"
  "https://mcp.context7.com/mcp"
  "https://api.githubcopilot.com/mcp/"
  ""
)
P_KEY_MODE=("required" "required" "optional" "required" "none")

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
p_env()      { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_ENV[$i]}"; }
p_val_url()  { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_VAL_URL[$i]}"; }
p_key_mode() { local i; i="$(p_index "$1")" || return 1; printf '%s' "${P_KEY_MODE[$i]}"; }

provider_selected() {
  local wanted="$1" p
  for p in "${PROVIDERS[@]}"; do
    [ "$p" = "$wanted" ] && return 0
  done
  return 1
}

resolve_cloakbrowser_executable() {
  local diagnostics

  provider_selected chrome-devtools || return 0
  [ "$CHROME_BROWSER" = "cloak" ] || return 0

  command -v node >/dev/null 2>&1 ||
    die "CloakBrowser requires Node.js 20 or newer"
  command -v npx >/dev/null 2>&1 ||
    die "CloakBrowser requires npm/npx"

  if [ -z "$CLOAKBROWSER_EXECUTABLE" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      die "--dry-run with CloakBrowser requires --cloakbrowser-executable PATH (dry-run will not download a browser)"
    fi
    info "Installing/resolving the CloakBrowser Chromium binary..."
    npx -y cloakbrowser@latest install >/dev/null ||
      die "CloakBrowser installation failed; run 'npx -y cloakbrowser@latest info' for diagnostics"
    diagnostics="$(npx -y cloakbrowser@latest info --quick --json)" ||
      die "CloakBrowser diagnostics failed"
    CLOAKBROWSER_EXECUTABLE="$(
      printf '%s' "$diagnostics" | node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
          try {
            const value = JSON.parse(input)?.binary?.path;
            if (typeof value !== "string" || value.length === 0) process.exit(2);
            process.stdout.write(value);
          } catch {
            process.exit(2);
          }
        });
      '
    )" || die "CloakBrowser did not report its Chromium executable path"
  fi

  [ -f "$CLOAKBROWSER_EXECUTABLE" ] ||
    die "CloakBrowser executable not found: $CLOAKBROWSER_EXECUTABLE"
  [ -x "$CLOAKBROWSER_EXECUTABLE" ] ||
    die "CloakBrowser executable is not executable: $CLOAKBROWSER_EXECUTABLE"
  ok "CloakBrowser executable: $CLOAKBROWSER_EXECUTABLE"
}

# ---------- usage ----------
usage() {
  cat <<EOF
${C_BOLD}agent/opencode/mcp.sh${C_RESET} - add web/docs/browser/repository MCP servers to OpenCode

${C_BOLD}Usage:${C_RESET}
  mcp.sh [options]

${C_BOLD}Options:${C_RESET}
  --provider <name>          Add a provider. Repeatable. name in {${ALL_PROVIDERS[*]}}
                             Default: choose each MCP interactively via /dev/tty.
  --key NAME=value           API key/PAT for provider NAME. Repeatable.
                             Falls back to env: BRAVE_API_KEY, EXA_API_KEY,
                             CONTEXT7_API_KEY, GITHUB_PERSONAL_ACCESS_TOKEN.
  --all                      Enable all five providers.
  --cloakbrowser-executable <path>
                             Use an existing CloakBrowser Chromium binary.
                             Default: CLOAKBROWSER_BINARY_PATH or install via npx.
  --stock-chrome             Let Chrome DevTools MCP use stock Google Chrome.
  --force                    Overwrite existing entries without asking.
  --skip-validate            Skip per-provider probes (offline use).
  --dry-run                  Print the would-be JSON, write nothing.
  --uninstall                Remove the mcp.* entries this script wrote.
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
    --cloakbrowser-executable)
      CLOAKBROWSER_EXECUTABLE="${2:?}"
      CHROME_BROWSER="cloak"
      shift 2
      ;;
    --stock-chrome)    CHROME_BROWSER="stock"; shift ;;
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
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "|  agent/opencode/mcp.sh                                        |" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_BLUE}" "+--------------------------------------------------------------+" "${C_RESET}"
echo

# OpenCode's current global config filename is opencode.json. Preserve users of
# the previous script by copying its legacy config.json once when needed.
if [ ! -f "$SETTINGS_FILE" ] && [ -f "$LEGACY_SETTINGS_FILE" ]; then
  mkdir -p "$SETTINGS_DIR"
  cp "$LEGACY_SETTINGS_FILE" "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
  warn "copied legacy config.json to the current global path: $SETTINGS_FILE"
fi

# ---------- uninstall path ----------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$SETTINGS_FILE" ] || die "no opencode.json at $SETTINGS_FILE"
  ensure_jq
  require_json_object "$SETTINGS_FILE"
  info "Removing mcp.* entries written by ${MANAGED_BY}..."
  TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
  if ! jq --arg mgr "$MANAGED_BY" '
    .mcp = (
      (.mcp // {})
      | with_entries(select(.value._managed_by != $mgr))
    )
    | if (.mcp // {}) == {} then del(.mcp) else . end
  ' "$SETTINGS_FILE" > "$TMP_OUT"; then
    rm -f "$TMP_OUT"
    die "failed to prepare opencode.json update"
  fi
  replace_file "$TMP_OUT" "$SETTINGS_FILE"
  ok "removed ${MANAGED_BY}-owned entries from $SETTINGS_FILE"
  exit 0
fi

# ---------- preflight ----------
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
  envname_upper="$(p_env "$p")"
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
if provider_selected github && [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
  warn "GitHub PAT was supplied only for setup/validation; export GITHUB_PERSONAL_ACCESS_TOKEN before starting OpenCode"
fi
echo

resolve_cloakbrowser_executable
echo

# ---------- validate each provider (same probes as claude-code/mcp.sh) ----------
MCP_INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent-opencode-mcp","version":"0.1"}}}'

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
    if [ "$CHROME_BROWSER" = "cloak" ]; then
      "$CLOAKBROWSER_EXECUTABLE" --version >/dev/null 2>&1 ||
        die "CloakBrowser Chromium failed to execute: $CLOAKBROWSER_EXECUTABLE"
    fi
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
    200)
      if [ "$p" = "github" ]; then
        ok "${display} PAT accepted"
      else
        ok "${display} accepted (${key:+with key}${key:+/rate-limit-boost}${key:-anonymous})"
      fi
      ;;
    401|403)
      if [ "$(p_key_mode "$p")" = "optional" ] && [ -z "$key" ]; then
        ok "${display} accepted anonymously"
      else
        if [ "$p" = "github" ]; then
          die "${display} PAT rejected (HTTP $resp) - create a least-privilege token at https://github.com/settings/personal-access-tokens"
        fi
        die "${display} key rejected (HTTP $resp)"
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

# ---------- build the mcp block ----------
TMP_NEW="$(mktemp)"
{
  printf '{\n'
  printf '  "mcp": {\n'
  first=1
  for p in "${PROVIDERS[@]}"; do
    if [ "$first" -eq 0 ]; then printf ',\n'; fi
    first=0

    printf '    %s: {\n' "$(json_quote "$p")"
    if [ "$(p_transport "$p")" = "stdio" ]; then
      printf '      "type": "local",\n'
      if [ "$CHROME_BROWSER" = "cloak" ]; then
        printf '      "command": ["npx", "-y", "chrome-devtools-mcp@latest", "--executablePath", %s],\n' \
          "$(json_quote "$CLOAKBROWSER_EXECUTABLE")"
      else
        printf '      "command": ["npx", "-y", "chrome-devtools-mcp@latest"],\n'
      fi
    else
      url="$(p_mcp_url "$p")"
      hdr="$(p_hdr "$p")"
      prefix="$(p_prefix "$p")"
      key="$(get_key "$p")"

      printf '      "type": "remote",\n'
      printf '      "url": %s,\n' "$(json_quote "$url")"
      if [ "$p" = "github" ]; then
        runtime_header="Bearer {env:$(p_env "$p")}"
        printf '      "oauth": false,\n'
        printf '      "headers": { %s: %s },\n' \
          "$(json_quote "$hdr")" "$(json_quote "$runtime_header")"
      elif [ -n "$key" ]; then
        printf '      "headers": { %s: %s },\n' \
          "$(json_quote "$hdr")" "$(json_quote "${prefix}${key}")"
      fi
    fi
    printf '      "_managed_by": %s\n' "$(json_quote "$MANAGED_BY")"
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

# ---------- write opencode.json (merge, never touch provider.*) ----------
mkdir -p "$SETTINGS_DIR"
[ -w "$SETTINGS_DIR" ] || die "$SETTINGS_DIR is not writable - fix permissions and re-run"

if [ ! -f "$SETTINGS_FILE" ]; then
  printf '{}\n' > "$SETTINGS_FILE"
  chmod 600 "$SETTINGS_FILE"
fi
require_json_object "$SETTINGS_FILE"

# Refuse to replace a differently configured same-name HTTP or local entry
# unless --force explicitly authorizes it.
conflict=0
for p in "${PROVIDERS[@]}"; do
  existing_entry="$(jq -c --arg k "$p" '.mcp[$k] // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
  if [ -n "$existing_entry" ]; then
    existing_manager="$(jq -r --arg k "$p" '.mcp[$k]._managed_by // empty' "$SETTINGS_FILE")"
    [ "$existing_manager" = "$MANAGED_BY" ] && continue
    if [ "$(p_transport "$p")" = "stdio" ]; then
      existing_command="$(jq -c --arg k "$p" '.mcp[$k].command // []' "$SETTINGS_FILE")"
      if [ "$CHROME_BROWSER" = "cloak" ]; then
        expected_command="$(jq -cn --arg executable "$CLOAKBROWSER_EXECUTABLE" \
          '["npx", "-y", "chrome-devtools-mcp@latest", "--executablePath", $executable]')"
      else
        expected_command='["npx","-y","chrome-devtools-mcp@latest"]'
      fi
      if [ "$existing_command" != "$expected_command" ]; then
        warn "mcp.${p} already has a different local command"
        conflict=1
      fi
    else
      new_url="$(p_mcp_url "$p")"
      existing_url="$(jq -r --arg k "$p" '.mcp[$k].url // empty' "$SETTINGS_FILE")"
      if [ "$existing_url" != "$new_url" ]; then
        warn "mcp.${p} already points to ${existing_url:-a non-HTTP command} (this script would change it to ${new_url})"
        conflict=1
      fi
    fi
  fi
done
if [ "$conflict" = 1 ] && [ "$FORCE" != 1 ]; then
  die "opencode.json has existing mcp entries with different URLs - re-run with --force to overwrite."
fi

TMP_OUT="$(make_temp_near "$SETTINGS_FILE")"
if ! jq --slurpfile new "$TMP_NEW" --arg mgr "$MANAGED_BY" '
  .mcp = (.mcp // {})
  | reduce ($new[0].mcp | to_entries[]) as $e (.;
      .mcp[$e.key] = ($e.value + { _managed_by: $mgr }))
' "$SETTINGS_FILE" > "$TMP_OUT"; then
  rm -f "$TMP_NEW" "$TMP_OUT"
  die "failed to merge MCP entries; opencode.json was left unchanged"
fi
replace_file "$TMP_OUT" "$SETTINGS_FILE"
rm -f "$TMP_NEW"
ok "wrote $SETTINGS_FILE (chmod 600)"
echo

# ---------- post-install checklist ----------
printf '%s%s%s\n' "${C_BOLD}" "Next steps" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"
cat <<EOF
1. Start (or restart) OpenCode:
     ${C_DIM}opencode${C_RESET}

2. Inside the TUI, MCP servers should appear automatically.

3. Smoke-test one of each (the model decides which to call):
     ${C_DIM}"search the web for MiniMax M3 release notes 2026"${C_RESET}   -> brave
     ${C_DIM}"find recent blog posts about Claude Code with MiniMax"${C_RESET}   -> exa
     ${C_DIM}"what's the latest useGSAP hook signature in React?"${C_RESET}     -> context7
     ${C_DIM}"list my recently merged GitHub pull requests"${C_RESET}           -> github
     ${C_DIM}"open example.com and inspect its network requests"${C_RESET}       -> chrome-devtools

   GitHub reads its PAT from GITHUB_PERSONAL_ACCESS_TOKEN at OpenCode startup.
   Chrome DevTools launches CloakBrowser by default; pass --stock-chrome to opt out.

4. To uninstall:
     ${C_DIM}$0 --uninstall${C_RESET}
EOF
echo
ok "done"
