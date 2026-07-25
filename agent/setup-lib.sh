#!/usr/bin/env bash
# agent/setup-lib.sh — shared interactive helpers for agent setup scripts.
#
# The per-agent setup scripts download this file from the same repository when
# they are executed through `curl .../setup.sh | bash`, so they remain usable
# both from a clone and as one-shot installers.

# shellcheck shell=bash

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

have_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

prompt_value() {
  # Result is returned in PROMPT_REPLY. Reading /dev/tty keeps prompts working
  # when setup.sh itself is being consumed from stdin by `curl | bash`.
  local label="$1" default_value="${2:-}" input
  have_tty || die "interactive input needs a TTY; pass --provider, --model and --key"
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" > /dev/tty
  else
    printf '%s: ' "$label" > /dev/tty
  fi
  IFS= read -r input < /dev/tty
  PROMPT_REPLY="${input:-$default_value}"
}

prompt_secret() {
  local label="$1" input
  have_tty || die "no API key supplied and no TTY is available; use --key or the provider environment variable"
  printf '%s: ' "$label" > /dev/tty
  stty -echo < /dev/tty 2>/dev/null || true
  IFS= read -r input < /dev/tty
  stty echo < /dev/tty 2>/dev/null || true
  printf '\n' > /dev/tty
  PROMPT_REPLY="$input"
}

ask_yes_no() {
  local label="$1" answer lower
  while true; do
    prompt_value "$label [y/N]" ""
    answer="$PROMPT_REPLY"
    lower="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      y|yes) return 0 ;;
      n|no|"") return 1 ;;
    esac
  done
}

choose_menu() {
  # Usage: choose_menu "Title" default-index "value|Label" ...
  # Results: MENU_VALUE and MENU_LABEL.
  local title="$1" default_index="$2" entry value label i=1
  shift 2
  have_tty || die "interactive selection needs a TTY; pass --provider and --model"
  printf '%s\n' "$title" > /dev/tty
  for entry in "$@"; do
    value="${entry%%|*}"
    label="${entry#*|}"
    printf '  %d) %s\n' "$i" "$label" > /dev/tty
    i=$((i + 1))
  done
  while true; do
    prompt_value "Choose" "$default_index"
    case "$PROMPT_REPLY" in
      *[!0-9]*|"") warn "enter a number from 1 to $#"; continue ;;
    esac
    [ "$PROMPT_REPLY" -ge 1 ] 2>/dev/null && [ "$PROMPT_REPLY" -le "$#" ] 2>/dev/null || {
      warn "enter a number from 1 to $#"
      continue
    }
    i=1
    for entry in "$@"; do
      if [ "$i" -eq "$PROMPT_REPLY" ]; then
        MENU_VALUE="${entry%%|*}"
        MENU_LABEL="${entry#*|}"
        return 0
      fi
      i=$((i + 1))
    done
  done
}

read_env() {
  # Avoid eval/indirect expansion for user-supplied custom env names.
  printenv "$1" 2>/dev/null || true
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

install_node() {
  local pm
  pm="$(detect_pm)"
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
      die "could not detect a supported package manager; install Node.js 18+ manually: https://nodejs.org/"
      ;;
  esac
}

ensure_node() {
  local required_major="${1:-18}" required_minor="${2:-0}"
  local version="" major=0 minor=0
  if command -v node >/dev/null 2>&1; then
    version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    major="${version%%.*}"
    case "$version" in
      *.*) minor="${version#*.}"; minor="${minor%%.*}" ;;
    esac
  fi
  case "$major" in *[!0-9]*|"") major=0 ;; esac
  case "$minor" in *[!0-9]*|"") minor=0 ;; esac
  if [ "$major" -lt "$required_major" ] ||
     { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then
    [ "$major" -eq 0 ] && info "Node.js not found - installing..." || warn "Node.js ${version:-unknown} is too old - upgrading..."
    install_node
  fi
  command -v node >/dev/null 2>&1 || die "Node.js is still not on PATH"
  command -v npm  >/dev/null 2>&1 || die "npm is still not on PATH"
  version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  major="${version%%.*}"
  minor="${version#*.}"; minor="${minor%%.*}"
  case "$major" in *[!0-9]*|"") major=0 ;; esac
  case "$minor" in *[!0-9]*|"") minor=0 ;; esac
  if [ "$major" -lt "$required_major" ] ||
     { [ "$major" -eq "$required_major" ] && [ "$minor" -lt "$required_minor" ]; }; then
    die "Node.js ${required_major}.${required_minor}+ is required; found ${version:-unknown}"
  fi
  ok "Node.js $(node --version), npm $(npm --version)"
}

ensure_npm_cli() {
  local command_name="$1" package_name="$2" display_name="$3"
  ensure_node
  if command -v "$command_name" >/dev/null 2>&1; then
    ok "$display_name already installed ($("$command_name" --version 2>/dev/null || echo 'unknown version'))"
  else
    info "Installing ${package_name} globally..."
    npm install -g "$package_name"
    command -v "$command_name" >/dev/null 2>&1 || die "$command_name is not on PATH after npm install"
    ok "$display_name installed"
  fi
}

derive_models_url() {
  local base="${1%/}"
  case "$base" in
    */v1) printf '%s/models' "$base" ;;
    *)    printf '%s/v1/models' "$base" ;;
  esac
}

validate_model_api() {
  # auth style: bearer | x-api-key | x-goog-api-key
  local url="$1" auth_style="$2" key="$3" model="$4"
  local body http_code available
  [ -n "$url" ] || { warn "provider has no models endpoint; skipping validation"; return 0; }
  body="$(mktemp)"
  if [ "$auth_style" = "x-api-key" ]; then
    http_code="$(curl -sS -o "$body" -w '%{http_code}' \
      -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" "$url" || printf '000')"
  elif [ "$auth_style" = "x-goog-api-key" ]; then
    http_code="$(curl -sS -o "$body" -w '%{http_code}' \
      -H "x-goog-api-key: $key" "$url" || printf '000')"
  else
    http_code="$(curl -sS -o "$body" -w '%{http_code}' \
      -H "Authorization: Bearer $key" "$url" || printf '000')"
  fi

  case "$http_code" in
    200) ;;
    401|403)
      rm -f "$body"
      die "provider rejected the API key (HTTP $http_code from $url)"
      ;;
    *)
      warn "could not validate through $url (HTTP $http_code); continuing. Use --skip-validate to suppress this probe."
      rm -f "$body"
      return 0
      ;;
  esac

  if command -v jq >/dev/null 2>&1 && ! jq -e --arg m "$model" '
    (.data[]?.id // empty), ((.models[]?.name // empty) | sub("^models/"; ""))
    | select(. == $m)
  ' "$body" >/dev/null 2>&1; then
    available="$(jq -r '
      (.data[]?.id // empty), ((.models[]?.name // empty) | sub("^models/"; ""))
    ' "$body" 2>/dev/null | head -n 12 | tr '\n' ' ' | sed 's/ $//')"
    warn "key is valid, but model '$model' was not returned by the models endpoint."
    [ -n "$available" ] && warn "first available models: $available"
    warn "the ID may be an alias or access-gated; continuing with your selection."
  else
    ok "API key valid; model '$model' is visible"
  fi
  rm -f "$body"
}

write_secret_file() {
  local path="$1" value="$2"
  mkdir -p "$(dirname "$path")"
  umask 077
  printf '%s\n' "$value" > "$path"
  chmod 600 "$path"
}

safe_id() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '_' | sed 's/^_*//; s/_*$//'
}
