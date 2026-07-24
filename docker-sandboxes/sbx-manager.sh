#!/usr/bin/env bash
# sbx-manager.sh
# Install, configure, inspect, and launch Docker Sandboxes (sbx).
# Compatible with the Bash 3.2 shipped by macOS.
#
# Officially supported hosts at the time this script was written:
#   - macOS 14+ on Apple silicon
#   - Ubuntu 24.04+ with KVM
# Debian support uses Docker's standalone Linux release archive. It is
# experimental and must be explicitly enabled.

set -Eeuo pipefail

SCRIPT_NAME="${0##*/}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_VERSION="1.2.2"
CATALOG_DATE="2026-07-20"

ASSUME_YES=0
EXPERIMENTAL_DEBIAN=0
SKIP_LOGIN=0
KVM_SESSION_REFRESH_REQUIRED=0
PARSED_GLOBAL_OPTION_COUNT=0

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/sbx-manager"
DAEMON_ENV_FILE="$CONFIG_DIR/daemon.env"

DOCS_ROOT="https://docs.docker.com/ai/sandboxes/"
SBX_RELEASES_API="https://api.github.com/repos/docker/sbx-releases/releases/latest"
TEMPLATE_REPO="docker.io/docker/sandbox-templates"
HUB_TAGS_API="https://hub.docker.com/v2/namespaces/docker/repositories/sandbox-templates/tags?page_size=100"
DEFAULT_SHELL_KIT="${SBX_MANAGER_SHELL_KIT:-$SCRIPT_DIR/kits/zsh-shell}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BLUE=$'\033[34m'
  C_RESET=$'\033[0m'
else
  C_BOLD=''
  C_DIM=''
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
  C_BLUE=''
  C_RESET=''
fi

say()     { printf '%b\n' "$*"; }
info()    { printf '%b==>%b %s\n' "$C_BLUE" "$C_RESET" "$*"; }
success() { printf '%bOK%b  %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()    { printf '%bWARN%b %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()     { printf '%bERROR%b %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

section() {
  printf '\n%b%s%b\n' "$C_BOLD" "$1" "$C_RESET"
  printf '%s\n' '------------------------------------------------------------'
}

confirm() {
  # Usage: confirm "Question"
  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    return 1
  fi
  local reply=''
  printf '%s [y/N] ' "$1" >&2
  read -r reply || return 1
  case "$reply" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    die "This operation needs root privileges, but sudo is unavailable."
  fi
}

require_sbx() {
  has sbx || die "sbx is not installed. Run: $SCRIPT_NAME install"
}

shell_quote_command() {
  # Print a command in a copy/paste-friendly form.
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

usage() {
  cat <<EOF_USAGE
${C_BOLD}sbx-manager ${SCRIPT_VERSION}${C_RESET}
Install, configure, inspect, and launch Docker Sandboxes.

${C_BOLD}Usage${C_RESET}
  $SCRIPT_NAME [global options] <command> [arguments]

${C_BOLD}Global options${C_RESET}
  -y, --yes                  Accept destructive-policy prompts.
      --skip-login           Do not run Docker OAuth login during setup.
      --experimental-debian  Install the standalone release on Debian 13+.
  -h, --help                 Show this help.

${C_BOLD}Main commands${C_RESET}
  install                    Install sbx for the detected host.
  setup [open|balanced|locked]
                             Install if needed, sign in, set policy, show info.
  login                      Sign in to Docker using sbx OAuth.
  info                       Show host, daemon, policy, sandbox, and cache info.
  doctor                     Run host checks plus 'sbx diagnose'.
  templates [--remote]       Print supported templates and launch commands.
                             --remote also queries every published Hub tag.

${C_BOLD}Network commands${C_RESET}
  network set <mode>         Reset local policy to open, balanced, or locked.
  network allow <resources>  Add an allow rule, e.g. '**' or github.com.
  network deny <resources>   Add a deny rule.
  network check <target>     Evaluate a URL, host, host:port, or IP.
  network status             Show active/inactive policy rules and checks.
  network logs               Show recent policy decisions.
  network proxy <URL>        Save an upstream proxy and restart sandboxd.
  network proxy off          Remove the manager's saved proxy setting.

${C_BOLD}Daemon commands${C_RESET}
  daemon start|stop|restart|status

${C_BOLD}Run helper${C_RESET}
  run [agent] [workspace] [options] [-- agent arguments]

  Agents: claude, codex, copilot, cursor, docker-agent, droid,
          gemini, kiro, opencode, shell (default)

  Options:
    --name NAME              Set a persistent sandbox name.
    --clone                  Use a private clone of a Git repository.
    --no-docker              Use the lighter template without nested dockerd.
    --minimal                Use Claude's minimal template (Claude only).
    -t, --template IMAGE     Use an explicit template image.
    -d, --detached           Create/start without attaching.
    --docker-size SIZE       Set internal Docker volume size, e.g. 10g.
    --no-shell-kit           Do not install the default zsh shell kit.

${C_BOLD}Examples${C_RESET}
  $SCRIPT_NAME setup open
  $SCRIPT_NAME templates --remote
  $SCRIPT_NAME run ~/Projects/app
  $SCRIPT_NAME run ~/Projects/app --name app-shell --clone
  $SCRIPT_NAME run claude ~/Projects/app --name app-claude --clone
  $SCRIPT_NAME run codex . --name app-codex --no-docker
  $SCRIPT_NAME network allow '**'
  $SCRIPT_NAME network check https://api.minimax.io

Official documentation: ${DOCS_ROOT}
EOF_USAGE
}

host_os() {
  uname -s 2>/dev/null || printf 'Unknown\n'
}

host_arch() {
  uname -m 2>/dev/null || printf 'unknown\n'
}

check_macos_prereqs() {
  local arch version major
  arch="$(host_arch)"
  version="$(sw_vers -productVersion 2>/dev/null || printf '0')"
  major="${version%%.*}"

  [ "$arch" = "arm64" ] || die "Docker Sandboxes requires Apple silicon; detected architecture: $arch"
  case "$major" in
    ''|*[!0-9]*) die "Could not determine the macOS version: $version" ;;
  esac
  [ "$major" -ge 14 ] || die "Docker Sandboxes requires macOS 14 or newer; detected: $version"
  success "macOS prerequisite check passed ($version, $arch)."
}

linux_release_info() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    printf '%s|%s|%s\n' "${ID:-unknown}" "${VERSION_ID:-unknown}" "${PRETTY_NAME:-Linux}"
  else
    printf 'unknown|unknown|Linux\n'
  fi
}

check_kvm() {
  local target_user
  target_user="${SUDO_USER:-${USER:-$(id -un)}}"

  section "KVM / virtualization"

  if [ -e /dev/kvm ]; then
    ls -l /dev/kvm || true
    if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
      success "/dev/kvm is readable and writable by the current user."
    else
      warn "/dev/kvm exists, but the current user cannot read and write it."
      if id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx kvm; then
        warn "$target_user is configured in the kvm group, but this process has not inherited it."
        say "Open a new login/SSH session, or run 'newgrp kvm' for a temporary subshell."
      else
        say "Add the user to the kvm group, then log out/in:"
        say "  sudo usermod -aG kvm \"$target_user\""
      fi
    fi
  else
    warn "/dev/kvm does not exist. sbx cannot start Linux microVMs without KVM."
  fi

  if has lsmod; then
    if lsmod | grep -E '^kvm(_intel|_amd|_arm64)?[[:space:]]' >/dev/null 2>&1; then
      lsmod | grep -E '^kvm' || true
    else
      warn "No loaded KVM module was found by lsmod."
    fi
  fi

  if has systemd-detect-virt; then
    say "Virtualization host type: $(systemd-detect-virt 2>/dev/null || printf 'none/unknown')"
  fi

  if [ -r /proc/cpuinfo ]; then
    if grep -Eq '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo; then
      success "CPU virtualization flags are visible to this OS."
    elif [ "$(host_arch)" = "x86_64" ] || [ "$(host_arch)" = "amd64" ]; then
      warn "No vmx/svm CPU flag is visible. On a VPS, nested virtualization may not be enabled."
    fi
  fi
}

github_release_asset_value() {
  # Usage: github_release_asset_value "$json" "$asset_name" digest|browser_download_url
  # GitHub renders each asset's name before its digest and download URL. The
  # API may return compact or pretty-printed JSON, so collect it before
  # scanning. This keeps jq/Python out of the bootstrap dependency set.
  local metadata="$1"
  local asset_name="$2"
  local field="$3"

  printf '%s\n' "$metadata" | awk -v asset="$asset_name" -v field="$field" '
    {
      json = json $0
    }
    END {
      asset_marker = "\"name\":\"" asset "\""
      asset_pos = index(json, asset_marker)
      if (asset_pos == 0) {
        asset_marker = "\"name\": \"" asset "\""
        asset_pos = index(json, asset_marker)
      }
      if (asset_pos == 0) {
        exit
      }

      tail = substr(json, asset_pos + length(asset_marker))
      marker = "\"" field "\":\""
      pos = index(tail, marker)
      if (pos == 0) {
        marker = "\"" field "\": \""
        pos = index(tail, marker)
      }
      if (pos > 0) {
        value = substr(tail, pos + length(marker))
        sub(/".*/, "", value)
        print value
      }
    }
  '
}

install_linux_standalone() {
  local release_arch="$1"
  local metadata tag asset_name asset_url expected_digest actual_digest
  local tmp_dir archive install_script

  asset_name="DockerSandboxes-linux-${release_arch}.tar.gz"

  info "Resolving the latest standalone sbx release from Docker..."
  metadata="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: sbx-manager' \
    "$SBX_RELEASES_API")" \
    || die "Could not read the latest release metadata from $SBX_RELEASES_API"

  tag="$(printf '%s\n' "$metadata" \
    | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  asset_url="$(github_release_asset_value "$metadata" "$asset_name" browser_download_url)"
  expected_digest="$(github_release_asset_value "$metadata" "$asset_name" digest)"
  expected_digest="${expected_digest#sha256:}"

  [ -n "$tag" ] || die "The Docker release metadata did not contain a version tag."
  [ -n "$asset_url" ] || die "Docker $tag does not publish $asset_name. Check the release notes for architecture availability."
  [ -n "$expected_digest" ] || die "Docker $tag did not publish a SHA-256 digest for $asset_name."

  tmp_dir="$(mktemp -d /tmp/sbx-manager-install.XXXXXX)"
  archive="$tmp_dir/$asset_name"

  info "Downloading Docker sbx $tag standalone archive..."
  if ! curl -fL --retry 3 --connect-timeout 20 "$asset_url" -o "$archive"; then
    rm -rf -- "$tmp_dir"
    die "Failed to download $asset_url"
  fi

  actual_digest="$(sha256sum "$archive" | awk '{print $1}')"
  if [ "$actual_digest" != "$expected_digest" ]; then
    rm -rf -- "$tmp_dir"
    die "SHA-256 verification failed for $asset_name."
  fi
  success "Verified $asset_name ($actual_digest)."

  if ! tar -xzf "$archive" -C "$tmp_dir"; then
    rm -rf -- "$tmp_dir"
    die "Could not extract $asset_name."
  fi

  install_script="$tmp_dir/docker-sbx/install.sh"
  if [ ! -f "$install_script" ]; then
    rm -rf -- "$tmp_dir"
    die "The release archive does not contain docker-sbx/install.sh."
  fi

  info "Installing the standalone release under /usr/local..."
  if ! as_root env \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH" \
    PREFIX=/usr/local \
    bash "$install_script"; then
    rm -rf -- "$tmp_dir"
    die "Docker's standalone installer failed."
  fi
  rm -rf -- "$tmp_dir"
  hash -r

  warn "This standalone installation is outside APT; rerun the installer manually to apply future sbx updates."
}

configure_kvm_group() {
  local target_user="$1"

  if ! getent group kvm >/dev/null 2>&1; then
    as_root groupadd kvm
  fi

  if [ "$target_user" != root ]; then
    id "$target_user" >/dev/null 2>&1 || die "Cannot add unknown user to the kvm group: $target_user"
    as_root usermod -aG kvm "$target_user"
    if { [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; } \
      && id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx kvm; then
      KVM_SESSION_REFRESH_REQUIRED=1
    fi
  fi
}

install_macos() {
  check_macos_prereqs

  if has sbx; then
    success "sbx is already installed at $(command -v sbx)."
    sbx version || true
    return 0
  fi

  has brew || die "Homebrew is required for the supported macOS installation. Install it from https://brew.sh, then rerun this command."

  info "Installing sbx from Docker's Homebrew tap..."
  if brew help trust >/dev/null 2>&1; then
    brew trust docker/tap || warn "'brew trust docker/tap' failed; continuing with the install attempt."
  fi
  brew install docker/tap/sbx
  hash -r

  if ! has sbx; then
    local brew_prefix
    brew_prefix="$(brew --prefix)"
    export PATH="$brew_prefix/bin:$PATH"
    hash -r
  fi

  require_sbx
  success "Installed $(sbx version 2>/dev/null | head -n 1)."
}

install_linux() {
  local rel id version pretty major target_user release_arch
  rel="$(linux_release_info)"
  id="${rel%%|*}"
  rel="${rel#*|}"
  version="${rel%%|*}"
  pretty="${rel#*|}"
  major="${version%%.*}"
  target_user="${SUDO_USER:-${USER:-$(id -un)}}"

  say "Detected: $pretty ($(host_arch))"

  case "$(host_arch)" in
    x86_64|amd64) release_arch=amd64 ;;
    aarch64|arm64) release_arch=arm64 ;;
    *) die "Unsupported Linux architecture: $(host_arch)" ;;
  esac

  if [ "$id" = "ubuntu" ]; then
    case "$major" in
      ''|*[!0-9]*) die "Could not parse Ubuntu version: $version" ;;
    esac
    [ "$major" -ge 24 ] || die "The official Linux installation requires Ubuntu 24.04 or newer."
  elif [ "$id" = "debian" ]; then
    if [ "$EXPERIMENTAL_DEBIAN" -ne 1 ]; then
      die "Debian is not an officially supported sbx host. Rerun with --experimental-debian to use Docker's standalone Linux archive; Ubuntu 24.04+ is the supported path."
    fi
    case "$major" in
      ''|*[!0-9]*) die "Could not parse Debian version: $version" ;;
    esac
    [ "$major" -ge 13 ] || die "Experimental Debian mode is limited to Debian 13 or newer."
    warn "Proceeding on unsupported Debian $version. Installation or runtime behavior may fail."
  else
    die "Official APT installation is supported on Ubuntu 24.04+. Detected distribution: $id"
  fi

  if has sbx; then
    success "sbx is already installed at $(command -v sbx)."
    sbx version || true
    check_kvm
    return 0
  fi

  info "Installing host prerequisites..."
  as_root apt-get update
  as_root apt-get install -y ca-certificates curl e2fsprogs tar

  if [ "$id" = "debian" ]; then
    install_linux_standalone "$release_arch"
  else
    info "Adding Docker's APT repository..."
    if [ "$(id -u)" -eq 0 ]; then
      curl -fsSL https://get.docker.com | REPO_ONLY=1 sh
    else
      curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh
    fi
    as_root apt-get update

    if ! apt-cache show docker-sbx >/dev/null 2>&1; then
      die "The configured repository does not publish docker-sbx for $pretty / $(host_arch)."
    fi

    as_root apt-get install -y docker-sbx
  fi

  configure_kvm_group "$target_user"

  require_sbx
  success "Installed $(sbx version 2>/dev/null | head -n 1)."
  warn "The kvm group change may require logging out and back in before sbx can use /dev/kvm."
  check_kvm
}

install_sbx() {
  case "$(host_os)" in
    Darwin) install_macos ;;
    Linux) install_linux ;;
    *) die "This script currently supports macOS and Linux hosts. Detected: $(host_os)" ;;
  esac
}

is_authenticated() {
  local diagnosis
  require_sbx
  diagnosis="$(NO_COLOR=1 sbx diagnose --output json 2>/dev/null)" || return 1
  printf '%s\n' "$diagnosis" | awk '
    /"name"[[:space:]]*:[[:space:]]*"Authentication"/ {
      authentication_check = 1
      next
    }
    authentication_check &&
      /"message"[[:space:]]*:[[:space:]]*"authenticated"/ {
      authenticated = 1
    }
    authentication_check && /^[[:space:]]*}/ {
      authentication_check = 0
    }
    END {
      exit authenticated ? 0 : 1
    }
  '
}

login_sbx() {
  require_sbx
  load_daemon_env
  if is_authenticated; then
    success "sbx is already authenticated."
    return 0
  fi
  info "Starting Docker OAuth login..."
  sbx login
  success "Docker login completed."
}

load_daemon_env() {
  # Debian's default non-root PATH may omit sbin even though e2fsprogs installs
  # mkfs.ext4 there. sandboxd discovers the block-volume driver from PATH when
  # it starts, so keep the system administration directories visible.
  if [ "$(host_os)" = "Linux" ]; then
    case ":$PATH:" in
      *:/usr/sbin:*) ;;
      *) PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH" ;;
    esac
    export PATH
  fi

  if [ -r "$DAEMON_ENV_FILE" ]; then
    # This file is generated by this script with shell-escaped values.
    # shellcheck disable=SC1090
    . "$DAEMON_ENV_FILE"
    export DOCKER_SANDBOXES_PROXY HTTP_PROXY HTTPS_PROXY NO_PROXY
  fi
}

daemon_start() {
  require_sbx
  load_daemon_env
  sbx daemon start --detach
}

daemon_restart() {
  require_sbx
  load_daemon_env
  sbx daemon stop >/dev/null 2>&1 || true
  sbx daemon start --detach
  sbx daemon status
}

daemon_log_path() {
  local status
  status="$(sbx daemon status 2>/dev/null || true)"
  printf '%s\n' "$status" | sed -n 's/^Logs:[[:space:]]*//p' | head -n 1
}

daemon_block_driver_disabled() {
  local log_path
  log_path="$(daemon_log_path)"
  [ -n "$log_path" ] && [ -r "$log_path" ] || return 1

  # The log is append-only. Reset at each daemon session marker so an old
  # failure does not make a successfully restarted daemon look unhealthy.
  awk '
    /"msg":"loggingkit started"/ {
      disabled = 0
    }
    /mkfs\.ext4 not available, disabling block volume driver/ {
      disabled = 1
    }
    END {
      exit disabled ? 0 : 1
    }
  ' "$log_path"
}

ensure_block_volume_driver() {
  local active_sandboxes=''
  [ "$(host_os)" = "Linux" ] || return 0

  load_daemon_env
  if ! has mkfs.ext4; then
    die "mkfs.ext4 is required for sandbox kit volumes. Install e2fsprogs, then rerun this command."
  fi

  daemon_block_driver_disabled || return 0
  warn "sandboxd started without mkfs.ext4 in PATH, so its block-volume driver is disabled."

  # A stopped daemon can be started by the list operation below. If that
  # already picked up the corrected PATH, no explicit restart is needed.
  if ! active_sandboxes="$(sbx ls -q 2>/dev/null)"; then
    die "Could not list sandboxes safely before restarting sandboxd. Run '$SCRIPT_NAME doctor' for details."
  fi
  if ! daemon_block_driver_disabled; then
    success "sandboxd picked up mkfs.ext4 and enabled block-volume support."
    return 0
  fi

  if [ -n "$active_sandboxes" ]; then
    warn "Restarting sandboxd stops running sandboxes; their disks are preserved."
    confirm "Restart sandboxd to enable block-volume support?" \
      || die "Cannot launch this agent until sandboxd is restarted with mkfs.ext4 available."
  fi

  info "Restarting sandboxd with system sbin directories in PATH..."
  daemon_restart >/dev/null
  if daemon_block_driver_disabled; then
    die "sandboxd still could not enable its block-volume driver. Run '$SCRIPT_NAME doctor' and inspect the daemon log."
  fi
  success "Enabled sandboxd block-volume support."
}

daemon_command() {
  local action="${1:-status}"
  require_sbx
  case "$action" in
    start) daemon_start ;;
    stop) sbx daemon stop ;;
    restart) daemon_restart ;;
    status) sbx daemon status ;;
    *) die "Unknown daemon action: $action (use start, stop, restart, or status)" ;;
  esac
}

policy_mode_to_preset() {
  case "$1" in
    open|allow-all) printf 'allow-all\n' ;;
    balanced) printf 'balanced\n' ;;
    locked|locked-down|deny-all) printf 'deny-all\n' ;;
    *) return 1 ;;
  esac
}

policy_check_capture() {
  local target="$1"
  sbx policy check network "$target" 2>&1 || true
}

policy_check_allowed() {
  local result
  result="$(policy_check_capture "$1")"
  case "$result" in
    *Allowed:*) return 0 ;;
    *) return 1 ;;
  esac
}

current_network_preset() {
  local rules
  rules="$(sbx policy ls \
    --include-inactive \
    --source local \
    --type network \
    --json 2>/dev/null)" || return 1

  case "$rules" in
    *default-allow-all*) printf 'allow-all\n' ;;
    *default-deny-all*) printf 'deny-all\n' ;;
    *'"origin"'*'"local"'*) printf 'balanced\n' ;;
    *) return 1 ;;
  esac
}

configure_network_mode() {
  local mode="$1" keep_matching="${2:-0}"
  local preset init_output current_preset='' initialized=0
  require_sbx
  load_daemon_env
  preset="$(policy_mode_to_preset "$mode")" || die "Unknown network mode: $mode (use open, balanced, or locked)"

  # Do not probe with `policy inspect` or another daemon-backed command here.
  # On an uninitialized installation, starting the daemon opens sbx's
  # interactive policy picker. `policy init` is both the non-interactive probe
  # and the initialization operation, and reports a stable error when a policy
  # already exists.
  if init_output="$(sbx policy init "$preset" 2>&1)"; then
    [ -z "$init_output" ] || say "$init_output"
    initialized=1
  else
    case "$init_output" in
      *"global network policy is already initialized"*)
        current_preset="$(current_network_preset || true)"
        if [ "$keep_matching" -eq 1 ] && [ "$current_preset" = "$preset" ]; then
          success "Local network policy already uses preset: $preset"
        else
          warn "Changing the preset resets local policy rules and stops the sbx daemon. Sandbox disks are preserved."
          confirm "Reset local policy to '$mode'?" || die "Cancelled."
          sbx policy reset --force
          sbx policy init "$preset"
          initialized=1
        fi
        ;;
      *)
        [ -z "$init_output" ] || warn "$init_output"
        die "Could not initialize the local network policy preset: $preset"
        ;;
    esac
  fi

  if [ "$initialized" -eq 1 ]; then
    success "Initialized local policy preset: $preset"
  fi

  # v0.35.0 could occasionally retain a stale policy snapshot. Restart only
  # when the open preset fails an actual policy check.
  if [ "$preset" = "allow-all" ]; then
    if ! policy_check_allowed github.com; then
      warn "Open policy is present but the daemon check is stale; restarting sandboxd once."
      daemon_restart >/dev/null
    fi
    say "$(policy_check_capture github.com)"
    say "$(policy_check_capture api.minimax.io)"
  fi

  sbx policy ls --include-inactive --wide
}

redact_proxy() {
  # Hide user:password while retaining scheme/host/port.
  printf '%s' "$1" | sed -E 's#(://)[^/@]+@#\1***@#'
}

save_proxy() {
  local url="$1"
  case "$url" in
    http://*|https://*|socks5://*|socks5h://*) ;;
    *) die "Proxy URL must start with http://, https://, socks5://, or socks5h://" ;;
  esac

  mkdir -p "$CONFIG_DIR"
  umask 077
  {
    printf 'DOCKER_SANDBOXES_PROXY=%q\n' "$url"
    printf 'HTTP_PROXY=%q\n' "$url"
    printf 'HTTPS_PROXY=%q\n' "$url"
    printf 'NO_PROXY=%q\n' 'localhost,127.0.0.1'
  } > "$DAEMON_ENV_FILE"
  chmod 600 "$DAEMON_ENV_FILE"

  success "Saved manager proxy configuration: $(redact_proxy "$url")"
  warn "This file is used when the daemon is started through $SCRIPT_NAME. It does not rewrite your shell profile."
  daemon_restart
}

remove_proxy() {
  if [ -e "$DAEMON_ENV_FILE" ]; then
    rm -f "$DAEMON_ENV_FILE"
    success "Removed $DAEMON_ENV_FILE"
  else
    info "No manager proxy file exists."
  fi
  warn "Proxy variables inherited from your current shell, if any, still apply."
  daemon_restart
}

network_status() {
  require_sbx
  section "Policy rules"
  sbx policy ls --include-inactive --wide || true
  section "Representative checks"
  sbx policy check network https://github.com || true
  sbx policy check network https://registry-1.docker.io || true
  sbx policy check network https://auth.docker.io || true
  sbx policy check network https://api.minimax.io || true
  section "Saved upstream proxy"
  if [ -r "$DAEMON_ENV_FILE" ]; then
    local saved_proxy=''
    # shellcheck disable=SC1090
    . "$DAEMON_ENV_FILE"
    saved_proxy="${DOCKER_SANDBOXES_PROXY:-}"
    say "Manager config: $(redact_proxy "$saved_proxy")"
  else
    say "Manager config: none"
  fi
  say "Current shell DOCKER_SANDBOXES_PROXY: $(redact_proxy "${DOCKER_SANDBOXES_PROXY:-<unset>}")"
  say "Current shell HTTPS_PROXY: $(redact_proxy "${HTTPS_PROXY:-${https_proxy:-<unset>}}")"
}

network_command() {
  local sub="${1:-status}"
  shift || true
  require_sbx

  case "$sub" in
    set)
      [ "$#" -ge 1 ] || die "Usage: $SCRIPT_NAME network set <open|balanced|locked>"
      configure_network_mode "$1"
      ;;
    allow)
      [ "$#" -ge 1 ] || die "Usage: $SCRIPT_NAME network allow <resource[,resource...]>"
      sbx policy allow network "$1"
      if [ "$1" = "**" ] && ! policy_check_allowed github.com; then
        warn "Wildcard rule did not appear in the daemon snapshot; restarting sandboxd once."
        daemon_restart >/dev/null
      fi
      sbx policy ls --include-inactive --wide
      ;;
    deny)
      [ "$#" -ge 1 ] || die "Usage: $SCRIPT_NAME network deny <resource[,resource...]>"
      sbx policy deny network "$1"
      sbx policy ls --include-inactive --wide
      ;;
    check)
      [ "$#" -ge 1 ] || die "Usage: $SCRIPT_NAME network check <target>"
      sbx policy check network "$1"
      ;;
    status) network_status ;;
    logs|log) sbx policy log ;;
    proxy)
      [ "$#" -ge 1 ] || die "Usage: $SCRIPT_NAME network proxy <URL|off>"
      if [ "$1" = "off" ]; then remove_proxy; else save_proxy "$1"; fi
      ;;
    *) die "Unknown network command: $sub" ;;
  esac
}

base_variant_for_agent() {
  case "$1" in
    claude) printf 'claude-code\n' ;;
    codex) printf 'codex\n' ;;
    copilot) printf 'copilot\n' ;;
    cursor) printf 'cursor-agent\n' ;;
    docker-agent) printf 'docker-agent\n' ;;
    droid) printf 'droid\n' ;;
    gemini) printf 'gemini\n' ;;
    kiro) printf 'kiro\n' ;;
    opencode) printf 'opencode\n' ;;
    shell) printf 'shell\n' ;;
    *) return 1 ;;
  esac
}

print_template_catalog() {
  section "Official documented template families"
  say "Catalog date: $CATALOG_DATE"
  say "Repository: $TEMPLATE_REPO:<variant>"
  say "There are 11 documented base variants; each also has a -docker variant (22 stable variant names)."
  say "Built-in agent launches use the -docker variant by default."
  printf '\n%-14s %-25s %-32s %s\n' "AGENT" "LIGHT TEMPLATE" "DOCKER TEMPLATE (DEFAULT)" "START COMMAND"
  printf '%-14s %-25s %-32s %s\n' "--------------" "-------------------------" "--------------------------------" "------------------------------"
  printf '%-14s %-25s %-32s %s\n' "claude" "claude-code" "claude-code-docker" "sbx run claude /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "codex" "codex" "codex-docker" "sbx run codex /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "copilot" "copilot" "copilot-docker" "sbx run copilot /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "cursor" "cursor-agent" "cursor-agent-docker" "sbx run cursor /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "docker-agent" "docker-agent" "docker-agent-docker" "sbx run docker-agent /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "droid" "droid" "droid-docker" "sbx run droid /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "gemini" "gemini" "gemini-docker" "sbx run gemini /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "kiro" "kiro" "kiro-docker" "sbx run kiro /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "opencode" "opencode" "opencode-docker" "sbx run opencode /path/to/project"
  printf '%-14s %-25s %-32s %s\n' "shell" "shell" "shell-docker" "sbx run shell /path/to/project"

  section "Additional Claude minimal variants"
  say "  $TEMPLATE_REPO:claude-code-minimal"
  say "  $TEMPLATE_REPO:claude-code-minimal-docker"
  say "Launch examples:"
  say "  sbx run --template $TEMPLATE_REPO:claude-code-minimal claude /path/to/project"
  say "  sbx run --template $TEMPLATE_REPO:claude-code-minimal-docker claude /path/to/project"

  section "Common launch patterns"
  cat <<EOF_PATTERNS
  # Default Docker-enabled template
  sbx run --name my-agent claude /path/to/project

  # Protect the host working tree with a private Git clone
  sbx run --clone --name my-agent claude /path/to/git-repository

  # Lighter template: no nested Docker Engine
  sbx run --template $TEMPLATE_REPO:claude-code claude /path/to/project

  # Reattach to an existing sandbox
  sbx run --name my-agent

  # Open an extra Bash shell in a running sandbox
  sbx exec -it my-agent bash

  # Stop without deleting, or remove permanently
  sbx stop my-agent
  sbx rm my-agent
EOF_PATTERNS
}

list_local_templates() {
  section "Templates cached locally by sbx"
  if has sbx; then
    sbx template ls || warn "Could not list the local sbx template store."
  else
    say "sbx is not installed; no local cache can be queried."
  fi
}

remote_tags_python() {
  python3 - "$HUB_TAGS_API" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = sys.argv[1]
tags = []
seen_urls = set()
try:
    while url:
        if url in seen_urls:
            raise RuntimeError("pagination loop detected")
        seen_urls.add(url)
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "sbx-manager/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.load(response)
        tags.extend(item["name"] for item in payload.get("results", []) if item.get("name"))
        url = payload.get("next")
except Exception as exc:
    print(f"remote tag query failed: {exc}", file=sys.stderr)
    sys.exit(1)

for tag in sorted(set(tags)):
    print(tag)
print(f"\nTotal published tags: {len(set(tags))}")
PY
}

remote_tags_jq() {
  local url body next
  url="$HUB_TAGS_API"
  while [ -n "$url" ]; do
    body="$(curl -fsSL --connect-timeout 15 --max-time 45 "$url")" || return 1
    printf '%s\n' "$body" | jq -r '.results[]?.name'
    next="$(printf '%s\n' "$body" | jq -r '.next // empty')"
    url="$next"
  done | sort -u
}

list_remote_tags() {
  section "Every currently published Docker Hub tag"
  say "Source: docker/sandbox-templates"
  say "This includes stable aliases, versioned tags, and nightly tags."
  printf '\n'

  if has python3; then
    remote_tags_python || warn "Remote tags could not be fetched; the static supported catalog above is still available."
  elif has curl && has jq; then
    local tmp count
    tmp="$(mktemp -t sbx-tags.XXXXXX)"
    if remote_tags_jq > "$tmp"; then
      cat "$tmp"
      count="$(wc -l < "$tmp" | tr -d ' ')"
      say ""
      say "Total published tags: $count"
    else
      warn "Remote tags could not be fetched."
    fi
    rm -f "$tmp"
  else
    warn "Fetching all remote tags requires python3, or curl plus jq."
  fi
}

templates_command() {
  local remote=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --remote) remote=1 ;;
      *) die "Unknown templates option: $1" ;;
    esac
    shift
  done

  print_template_catalog
  list_local_templates
  if [ "$remote" -eq 1 ]; then
    list_remote_tags
  fi
}

show_host_info() {
  section "Host"
  say "OS: $(host_os)"
  say "Architecture: $(host_arch)"
  say "Kernel: $(uname -sr 2>/dev/null || true)"

  case "$(host_os)" in
    Darwin)
      sw_vers 2>/dev/null || true
      ;;
    Linux)
      if [ -r /etc/os-release ]; then
        grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
      fi
      if has systemd-detect-virt; then
        say "Virtualization: $(systemd-detect-virt 2>/dev/null || printf 'none/unknown')"
      fi
      if [ -e /dev/kvm ]; then
        ls -l /dev/kvm || true
      else
        say "/dev/kvm: missing"
      fi
      ;;
  esac
}

show_proxy_info() {
  section "Proxy environment"
  if [ -r "$DAEMON_ENV_FILE" ]; then
    local saved=''
    # shellcheck disable=SC1090
    . "$DAEMON_ENV_FILE"
    saved="${DOCKER_SANDBOXES_PROXY:-}"
    say "Manager-saved upstream proxy: $(redact_proxy "$saved")"
    say "Config file: $DAEMON_ENV_FILE (mode should be 600)"
  else
    say "Manager-saved upstream proxy: <none>"
  fi
  say "Shell DOCKER_SANDBOXES_PROXY: $(redact_proxy "${DOCKER_SANDBOXES_PROXY:-<unset>}")"
  say "Shell HTTPS_PROXY: $(redact_proxy "${HTTPS_PROXY:-${https_proxy:-<unset>}}")"
  say "Shell NO_PROXY: ${NO_PROXY:-${no_proxy:-<unset>} }"
}

show_storage_info() {
  section "Local storage"
  if [ -d "$HOME/.sbx" ]; then
    du -sh "$HOME/.sbx" 2>/dev/null || true
  fi
  if [ -d "$HOME/Library/Application Support/com.docker.sandboxes" ]; then
    du -sh "$HOME/Library/Application Support/com.docker.sandboxes" 2>/dev/null || true
  fi
}

info_command() {
  show_host_info
  show_proxy_info

  section "sbx installation"
  if ! has sbx; then
    say "sbx: not installed"
    return 0
  fi
  say "Binary: $(command -v sbx)"
  sbx version || true

  section "Daemon"
  sbx daemon status || true

  section "Policy"
  sbx policy ls --include-inactive --wide || true

  section "Network policy checks"
  sbx policy check network github.com || true
  sbx policy check network auth.docker.io || true
  sbx policy check network registry-1.docker.io || true
  sbx policy check network api.minimax.io || true

  section "Sandboxes"
  sbx ls || true

  list_local_templates
  show_storage_info
}

doctor_command() {
  show_host_info
  if [ "$(host_os)" = "Linux" ]; then
    check_kvm
  fi

  section "sbx diagnostics"
  require_sbx
  sbx diagnose

  section "Daemon"
  sbx daemon status || true

  section "Policy checks"
  sbx policy check network https://github.com || true
  sbx policy check network https://auth.docker.io || true
  sbx policy check network https://registry-1.docker.io || true

  if has curl; then
    section "Host-side Docker Registry reachability"
    say "A 401 from registry-1.docker.io is normal: it means the registry is reachable and requested authentication."
    curl -sS -o /dev/null -w 'registry-1.docker.io: HTTP %{http_code}\n' \
      --connect-timeout 10 --max-time 20 https://registry-1.docker.io/v2/ || true
    curl -sS -o /dev/null -w 'auth.docker.io:       HTTP %{http_code}\n' \
      --connect-timeout 10 --max-time 20 \
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:docker/sandbox-templates:pull' || true
  fi
}

require_default_shell_kit() {
  [ -f "$DEFAULT_SHELL_KIT/spec.yaml" ] \
    || die "The default zsh shell kit is missing: $DEFAULT_SHELL_KIT/spec.yaml"
  [ -f "$DEFAULT_SHELL_KIT/files/home/.zshrc" ] \
    || die "The default zsh configuration is missing: $DEFAULT_SHELL_KIT/files/home/.zshrc"
  [ -f "$DEFAULT_SHELL_KIT/files/home/.config/starship.toml" ] \
    || die "The default Starship configuration is missing: $DEFAULT_SHELL_KIT/files/home/.config/starship.toml"
}

run_command() {
  local agent='shell'
  case "${1:-}" in
    claude|codex|copilot|cursor|docker-agent|droid|gemini|kiro|opencode|shell)
      agent="$1"
      shift
      ;;
  esac
  local workspace=''
  local name=''
  local clone=0
  local no_docker=0
  local minimal=0
  local detached=0
  local template=''
  local docker_size=''
  local shell_kit=1
  local shell_kit_explicitly_disabled=0
  local base=''
  local arg=''
  local seen_separator=0
  local workspace_provided=0
  local reattach=0
  local sandbox_names=''
  local cmd
  local extra_args

  # Bash 3.2-compatible indexed arrays.
  cmd=()
  extra_args=()

  base="$(base_variant_for_agent "$agent")" || die "Unsupported agent: $agent"

  while [ "$#" -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --name)
        [ "$#" -ge 1 ] || die "--name requires a value"
        name="$1"; shift
        ;;
      --clone) clone=1 ;;
      --no-docker) no_docker=1 ;;
      --minimal) minimal=1 ;;
      -t|--template)
        [ "$#" -ge 1 ] || die "$arg requires an image reference"
        template="$1"; shift
        ;;
      -d|--detached) detached=1 ;;
      --docker-size)
        [ "$#" -ge 1 ] || die "--docker-size requires a value such as 10g"
        docker_size="$1"; shift
        ;;
      --no-shell-kit)
        shell_kit=0
        shell_kit_explicitly_disabled=1
        ;;
      --)
        seen_separator=1
        while [ "$#" -gt 0 ]; do
          extra_args+=("$1")
          shift
        done
        ;;
      -*) die "Unknown run option: $arg" ;;
      *)
        if [ -z "$workspace" ]; then
          workspace="$arg"
          workspace_provided=1
        else
          die "Only one workspace is accepted by this helper. Use raw 'sbx run' for additional mounts."
        fi
        ;;
    esac
    [ "$seen_separator" -eq 0 ] || break
  done

  load_daemon_env
  if [ -n "$name" ]; then
    sandbox_names="$(sbx ls -q 2>/dev/null)" \
      || die "Could not list existing sandboxes before running '$name'."
    if printf '%s\n' "$sandbox_names" | grep -Fqx -- "$name"; then
      reattach=1
    fi
  fi

  if [ "$reattach" -eq 1 ]; then
    info "Reattaching to existing sandbox '$name'; its original agent and workspace are preserved."
    if [ "$clone" -eq 1 ] || [ "$no_docker" -eq 1 ] \
      || [ "$minimal" -eq 1 ] || [ "$detached" -eq 1 ] \
      || [ -n "$template" ] || [ -n "$docker_size" ] \
      || [ "$shell_kit_explicitly_disabled" -eq 1 ]; then
      warn "Ignoring creation-only options while reattaching to '$name'."
    fi
    if [ "$workspace_provided" -eq 1 ]; then
      say "Requested workspace is ignored for reattach: $workspace"
    fi

    cmd+=(sbx run --name "$name")
  else
    [ -n "$workspace" ] || workspace="$PWD"
    [ -d "$workspace" ] || die "Workspace directory does not exist: $workspace"

    if [ "$minimal" -eq 1 ]; then
      [ "$agent" = "claude" ] || die "--minimal is only valid with the claude agent."
      base="claude-code-minimal"
    fi

    if [ -n "$template" ] && { [ "$no_docker" -eq 1 ] || [ "$minimal" -eq 1 ]; }; then
      warn "An explicit --template overrides automatic --no-docker/--minimal template selection."
    fi

    if [ -z "$template" ]; then
      if [ "$minimal" -eq 1 ]; then
        if [ "$no_docker" -eq 1 ]; then
          template="$TEMPLATE_REPO:$base"
        else
          template="$TEMPLATE_REPO:${base}-docker"
        fi
      elif [ "$no_docker" -eq 1 ]; then
        template="$TEMPLATE_REPO:$base"
      fi
    fi

    if [ "$clone" -eq 1 ] && ! git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      warn "--clone was requested, but the workspace does not appear to be a Git working tree. sbx may reject it."
    fi

    ensure_block_volume_driver
    cmd+=(sbx run)
    [ -z "$name" ] || cmd+=(--name "$name")
    [ "$clone" -eq 0 ] || cmd+=(--clone)
    [ "$detached" -eq 0 ] || cmd+=(--detached)
    [ -z "$template" ] || cmd+=(--template "$template")
    if [ "$shell_kit" -eq 1 ]; then
      require_default_shell_kit
      cmd+=(--kit "$DEFAULT_SHELL_KIT")
    fi
    cmd+=("$agent" "$workspace")
  fi

  if [ "${#extra_args[@]}" -gt 0 ]; then
    cmd+=(--)
    cmd+=("${extra_args[@]}")
  fi

  if [ "$reattach" -eq 1 ]; then
    section "Reattaching sandbox"
  else
    section "Launching sandbox"
  fi
  printf 'Command:'
  shell_quote_command "${cmd[@]}"

  if [ "$reattach" -eq 0 ] && [ -n "$docker_size" ]; then
    export DOCKER_SANDBOXES_DOCKER_SIZE="$docker_size"
    say "DOCKER_SANDBOXES_DOCKER_SIZE=$docker_size"
  fi

  exec "${cmd[@]}"
}

setup_command() {
  local mode="${1:-balanced}"
  if ! has sbx; then
    install_sbx
  else
    success "Using existing sbx at $(command -v sbx)."
  fi

  if [ "$KVM_SESSION_REFRESH_REQUIRED" -eq 1 ]; then
    warn "sbx is installed, but this process has not inherited the new kvm group."
    say "Open a new login/SSH session and rerun:"
    if [ "$EXPERIMENTAL_DEBIAN" -eq 1 ]; then
      say "  $SCRIPT_NAME --experimental-debian setup $mode"
    else
      say "  $SCRIPT_NAME setup $mode"
    fi
    return 0
  fi

  # Initialize policy before diagnose/login: either command can start the
  # daemon and trigger sbx's first-use interactive policy picker.
  configure_network_mode "$mode" 1
  ensure_block_volume_driver

  if [ "$SKIP_LOGIN" -eq 0 ]; then
    login_sbx
  else
    warn "Skipping sbx login by request."
  fi

  info_command
  print_template_catalog
}

parse_global_options() {
  PARSED_GLOBAL_OPTION_COUNT=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -y|--yes) ASSUME_YES=1 ;;
      --experimental-debian) EXPERIMENTAL_DEBIAN=1 ;;
      --skip-login) SKIP_LOGIN=1 ;;
      -h|--help) usage; exit 0 ;;
      --version) say "$SCRIPT_VERSION"; exit 0 ;;
      *) break ;;
    esac
    shift
    PARSED_GLOBAL_OPTION_COUNT=$((PARSED_GLOBAL_OPTION_COUNT + 1))
  done
}

main() {
  parse_global_options "$@"
  # Bash 3.2 with nounset treats an empty array expansion as unbound.
  # Shift the parsed global options instead of copying the remainder.
  shift "$PARSED_GLOBAL_OPTION_COUNT"

  local command="${1:-help}"
  if [ "$#" -gt 0 ]; then shift; fi

  case "$command" in
    help|-h|--help) usage ;;
    install) install_sbx ;;
    setup) setup_command "$@" ;;
    login) login_sbx ;;
    info) info_command ;;
    doctor|diagnose) doctor_command ;;
    templates|template) templates_command "$@" ;;
    network|policy) network_command "$@" ;;
    daemon) daemon_command "$@" ;;
    run|start) require_sbx; run_command "$@" ;;
    *) die "Unknown command: $command. Run '$SCRIPT_NAME --help'." ;;
  esac
}

main "$@"
