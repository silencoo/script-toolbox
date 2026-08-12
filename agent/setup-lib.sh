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
  have_tty || die "no API key supplied and no TTY is available; use --key-file, --key, or the provider environment variable"
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

file_mode() {
  local path="$1" mode=""
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || true)"
  printf '%s' "$mode"
}

is_windows_posix_shell() {
  case "$(uname -s 2>/dev/null || printf unknown)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

require_private_secret_file() {
  local path="$1" mode
  [ -n "$path" ] || die "--key-file requires a path"
  [ -f "$path" ] || die "API key file does not exist or is not a regular file: $path"
  [ ! -L "$path" ] || die "refusing symlinked API key file: $path"
  [ -r "$path" ] || die "API key file is not readable: $path"
  # Git for Windows exposes synthesized POSIX mode bits that do not describe
  # the file's NTFS ACL. Keep the regular-file/symlink/readability checks, but
  # do not reject a private temporary key merely because stat reports 0644.
  is_windows_posix_shell && return 0
  mode="$(file_mode "$path")"
  case "$mode" in
    ?00|??00) ;;
    "")
      die "could not inspect API key file permissions: $path"
      ;;
    *)
      die "API key file must be owner-only (for example chmod 600 '$path'); found mode $mode"
      ;;
  esac
}

resolve_api_key() {
  # Args: direct-key key-file env-name allow-missing-for-dry-run prompt-label
  # Results: RESOLVED_API_KEY and API_KEY_SOURCE. Secret values are never
  # included in API_KEY_SOURCE.
  local direct_key="$1" input_file="$2" env_name="$3"
  local allow_missing="${4:-0}" prompt_label="${5:-API key}"
  local line_count value=""

  [ -z "$direct_key" ] || [ -z "$input_file" ] ||
    die "--key and --key-file are mutually exclusive"

  if [ -n "$direct_key" ]; then
    value="$direct_key"
    API_KEY_SOURCE="--key (redacted)"
  elif [ -n "$input_file" ]; then
    require_private_secret_file "$input_file"
    line_count="$(awk 'END { print NR + 0 }' "$input_file")"
    [ "$line_count" -eq 1 ] ||
      die "API key file must contain exactly one non-empty line: $input_file"
    value="$(sed -n '1p' "$input_file")"
    API_KEY_SOURCE="file: $input_file"
  else
    value="$(read_env "$env_name")"
    if [ -n "$value" ]; then
      API_KEY_SOURCE="environment: $env_name"
    elif [ "$allow_missing" = 1 ]; then
      API_KEY_SOURCE="not supplied (apply mode will prompt)"
    else
      prompt_secret "$prompt_label"
      value="$PROMPT_REPLY"
      API_KEY_SOURCE="interactive prompt"
    fi
  fi

  case "$value" in
    *"
"*) die "API keys must contain exactly one line" ;;
    *$'\r'*) die "API keys must not contain carriage returns" ;;
  esac
  if [ "$allow_missing" != 1 ] || [ -n "$value" ]; then
    [ -n "$value" ] || die "no API key supplied"
  fi
  RESOLVED_API_KEY="$value"
}

print_provider_plan() {
  # Args: client provider base-url model cli install-hint config-paths
  #       state-path credential-target credential-source validation
  local client="$1" provider="$2" base_url="$3" model="$4"
  local cli="$5" install_hint="$6" config_paths="$7" state_path="$8"
  local credential_target="$9"
  shift 9
  local credential_source="$1" validation="$2"

  log "[dry-run] ${client} provider setup"
  info "Provider          : $provider"
  info "Base URL          : $base_url"
  info "Model             : $model"
  if command -v "$cli" >/dev/null 2>&1; then
    info "CLI action        : keep installed $cli"
  else
    info "CLI action        : install $install_hint"
  fi
  info "Configuration     : $config_paths"
  info "Ownership state   : $state_path"
  info "Credential target : $credential_target"
  info "Credential source : $credential_source"
  info "Validation        : $validation"
  log "[dry-run] no validation request, package installation, or file change was performed"
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

install_jq() {
  local pm
  pm="$(detect_pm)"
  case "$pm" in
    apt)
      info "Installing jq via apt..."
      run_as_root apt-get install -y jq
      ;;
    dnf|yum)
      info "Installing jq via ${pm}..."
      run_as_root "$pm" install -y jq
      ;;
    brew)
      info "Installing jq via Homebrew..."
      brew install jq
      ;;
    apk)
      info "Installing jq via apk..."
      run_as_root apk add --no-cache jq
      ;;
    *)
      die "jq is required, and no supported package manager was found; install jq manually and re-run"
      ;;
  esac
}

ensure_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    warn "jq not found - installing it because JSON configuration cannot be updated without it"
    install_jq
  fi
  command -v jq >/dev/null 2>&1 ||
    die "jq installation finished but jq is still not on PATH"
  ok "jq $(jq --version 2>/dev/null || printf installed)"
}

make_temp_near() {
  local target="$1"
  mktemp "${target}.tmp.XXXXXX"
}

replace_file() {
  local temporary="$1" target="$2" mode="${3:-600}"
  chmod "$mode" "$temporary"
  mv "$temporary" "$target"
}

replace_file_pair() {
  local temporary_a="$1" target_a="$2" temporary_b="$3" target_b="$4"
  local backup_a backup_b
  backup_a="$(make_temp_near "$target_a")" || return 1
  if ! backup_b="$(make_temp_near "$target_b")"; then
    rm -f "$backup_a"
    return 1
  fi
  if ! cp -p "$target_a" "$backup_a" || ! cp -p "$target_b" "$backup_b"; then
    rm -f "$backup_a" "$backup_b"
    return 1
  fi
  if ! chmod 600 "$temporary_a" "$temporary_b"; then
    rm -f "$backup_a" "$backup_b"
    return 1
  fi
  if ! mv "$temporary_a" "$target_a" || ! mv "$temporary_b" "$target_b"; then
    mv "$backup_a" "$target_a" 2>/dev/null || true
    mv "$backup_b" "$target_b" 2>/dev/null || true
    rm -f "$temporary_a" "$temporary_b" "$backup_a" "$backup_b"
    return 1
  fi
  rm -f "$backup_a" "$backup_b"
}

require_json_object() {
  local path="$1"
  jq -e 'type == "object"' "$path" >/dev/null 2>&1 ||
    die "$path is not a valid JSON object; it was left unchanged"
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
  local base="$1" path query=""
  case "$base" in
    *\?*) path="${base%%\?*}"; query="?${base#*\?}" ;;
    *) path="$base" ;;
  esac
  path="${path%/}"
  case "$path" in
    */v1) printf '%s/models%s' "$path" "$query" ;;
    *)    printf '%s/v1/models%s' "$path" "$query" ;;
  esac
}

validate_provider_url() {
  # These URLs are persisted in client config and printed in plans. Keep
  # credentials out of them entirely, and allow cleartext only on loopback.
  local url="$1" label="${2:-provider URL}" remainder authority lower_authority host_port
  local query part name
  [ -n "$url" ] || die "$label must not be empty"
  case "$url" in
    *[[:space:]]*) die "$label must not contain whitespace" ;;
    *\#*) die "$label must not contain a fragment" ;;
  esac
  case "$url" in
    https://*) remainder="${url#https://}" ;;
    http://*) remainder="${url#http://}" ;;
    *) die "$label must be an absolute HTTP(S) URL" ;;
  esac
  authority="${remainder%%[/?#]*}"
  [ -n "$authority" ] || die "$label must include a host"
  case "$authority" in *@*) die "$label must not contain embedded credentials" ;; esac

  case "$url" in *\?*) query="${url#*\?}" ;; *) query="" ;; esac
  while [ -n "$query" ]; do
    part="${query%%&*}"
    if [ "$part" = "$query" ]; then query=""; else query="${query#*&}"; fi
    name="${part%%=*}"
    name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    case "$name" in
      *%*|key|api-key|api_key|apikey|x-api-key|x_api_key|access-key|access_key|secret-key|secret_key|access-token|access_token|token|secret|password|credential|auth|authorization|signature|sig|*-key|*_key|key-*|key_*|*-token|*_token|token-*|token_*|*-secret|*_secret|secret-*|secret_*|*-password|*_password|password-*|password_*|*-credential|*_credential|credential-*|credential_*|*-auth|*_auth|auth-*|auth_*)
        die "$label must not contain credentials in query parameters; pass credentials with --key-file or the provider environment variable"
        ;;
    esac
  done

  case "$url" in https://*) return 0 ;; esac
  lower_authority="$(printf '%s' "$authority" | tr '[:upper:]' '[:lower:]')"
  case "$lower_authority" in
    localhost) return 0 ;;
    localhost:*) host_port="${lower_authority#localhost:}" ;;
    127.0.0.1) return 0 ;;
    127.0.0.1:*) host_port="${lower_authority#127.0.0.1:}" ;;
    \[::1\]) return 0 ;;
    \[::1\]:*) host_port="${lower_authority#\[::1\]:}" ;;
    *) die "$label must use HTTPS unless it is loopback-only" ;;
  esac
  case "$host_port" in
    ""|*[!0-9]*) die "$label has an invalid loopback port" ;;
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
  local path="$1" value="$2" temporary
  mkdir -p "$(dirname "$path")"
  umask 077
  temporary="$(make_temp_near "$path")"
  if ! printf '%s\n' "$value" > "$temporary"; then
    rm -f "$temporary"
    die "failed to write $path; the original file was left unchanged"
  fi
  replace_file "$temporary" "$path"
}

safe_id() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9_-' '_' | sed 's/^_*//; s/_*$//'
}
