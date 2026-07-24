#!/usr/bin/env bash
# Install Ghostty on macOS/Linux and manage its SSH-safe shell integration.

set -Eeuo pipefail

SCRIPT_NAME="${0##*/}"
CONFIG_DIR="$HOME/.config/ghostty"
CONFIG_FILE="$CONFIG_DIR/config.ghostty"
FEATURES='cursor,no-sudo,title,ssh-env,ssh-terminfo,path'
MANAGED_BEGIN='# >>> script-toolbox Ghostty shell integration >>>'
MANAGED_END='# <<< script-toolbox Ghostty shell integration <<<'

ASSUME_YES=0
CONFIG_ONLY=0
SKIP_VALIDATE=0
TEMP_FILE=''
TEMP_DIR=''

say()     { printf '%s\n' "$*"; }
info()    { printf '==> %s\n' "$*"; }
success() { printf 'OK  %s\n' "$*"; }
warn()    { printf 'WARN: %s\n' "$*" >&2; }
die()     { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$TEMP_FILE" ] && [ -e "$TEMP_FILE" ]; then
    rm -f -- "$TEMP_FILE"
  fi
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
  fi
}
trap cleanup EXIT HUP INT TERM

usage() {
  cat <<EOF_USAGE
Usage: $SCRIPT_NAME [options]

Install Ghostty on macOS or Linux and configure:
  $CONFIG_FILE

Options:
  --config-only  Write or update the configuration without installing Ghostty.
  --yes, -y      Accept community Linux package-source prompts.
  --no-validate  Do not run 'ghostty +validate-config' after writing.
  --help, -h     Show this help.

The managed setting is:
  shell-integration-features = $FEATURES
EOF_USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config-only) CONFIG_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-validate) SKIP_VALIDATE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

has() {
  command -v "$1" >/dev/null 2>&1
}

confirm() {
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
  elif has doas; then
    doas "$@"
  else
    die "Root privileges are required, but neither sudo nor doas is available."
  fi
}

ghostty_binary() {
  if has ghostty; then
    command -v ghostty
  elif [ -x /Applications/Ghostty.app/Contents/MacOS/ghostty ]; then
    printf '%s\n' /Applications/Ghostty.app/Contents/MacOS/ghostty
  elif [ -x "$HOME/Applications/Ghostty.app/Contents/MacOS/ghostty" ]; then
    printf '%s\n' "$HOME/Applications/Ghostty.app/Contents/MacOS/ghostty"
  else
    return 1
  fi
}

ghostty_is_installed() {
  ghostty_binary >/dev/null 2>&1
}

install_macos() {
  if ghostty_is_installed; then
    success "Ghostty is already installed."
    return
  fi

  has brew || die \
    "Homebrew is required for automated macOS installation. Install Ghostty from https://ghostty.org/download or rerun with --config-only."

  info "Installing the Ghostty Homebrew cask..."
  brew install --cask ghostty
  ghostty_is_installed \
    || die "Homebrew completed, but Ghostty.app could not be found."
  success "Ghostty was installed."
}

confirm_community_source() {
  local description="$1"
  warn "$description"
  confirm "Continue with this community-maintained package source?" \
    || die "Installation cancelled. Use --config-only to configure an existing installation."
}

install_snap() {
  has snap || return 1
  confirm_community_source \
    "Ghostty's Snap package is a Linux community build listed by the Ghostty project."
  info "Installing Ghostty from Snap..."
  as_root snap install ghostty --classic
}

install_ubuntu_family() {
  confirm_community_source \
    "Ubuntu packages are provided by the mkasberg/ghostty-ubuntu community PPA."

  info "Adding the Ghostty Ubuntu PPA..."
  as_root apt-get update
  as_root apt-get install -y software-properties-common
  as_root add-apt-repository -y ppa:mkasberg/ghostty-ubuntu
  as_root apt-get update
  as_root apt-get install -y ghostty
}

install_fedora() {
  confirm_community_source \
    "Fedora packages are provided by the scottames/ghostty community COPR."

  info "Enabling the Ghostty Fedora COPR..."
  as_root dnf -y install dnf-plugins-core
  as_root dnf -y copr enable scottames/ghostty
  as_root dnf -y install ghostty
}

install_debian_community_package() {
  local codename=''
  local architecture=''
  local metadata=''
  local asset_record=''
  local expected_digest=''
  local asset_url=''
  local package_file=''
  local actual_digest=''

  if [ -r /etc/os-release ]; then
    local VERSION_CODENAME=''
    # shellcheck disable=SC1091
    . /etc/os-release
    codename="${VERSION_CODENAME:-}"
  fi
  case "$codename" in
    trixie|forky) ;;
    *) return 1 ;;
  esac

  confirm_community_source \
    "Debian packages are provided by the mkasberg/ghostty-ubuntu community project."

  if ! has curl || ! has jq; then
    as_root apt-get install -y ca-certificates curl jq
  fi
  has sha256sum \
    || die "sha256sum is required to verify the downloaded Ghostty package."

  architecture="$(dpkg --print-architecture)"
  case "$architecture" in
    amd64|arm64) ;;
    *) die "The community Debian package does not support architecture: $architecture" ;;
  esac

  info "Resolving the latest verified Ghostty package for Debian $codename..."
  metadata="$(curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    -H 'User-Agent: script-toolbox-ghostty-setup' \
    https://api.github.com/repos/mkasberg/ghostty-ubuntu/releases/latest)" \
    || die "Could not read the latest ghostty-ubuntu release metadata."

  asset_record="$(printf '%s\n' "$metadata" \
    | jq -r --arg suffix "_${architecture}_${codename}.deb" '
        .assets[]
        | select(.name | endswith($suffix))
        | "\(.digest)|\(.browser_download_url)"
      ' \
    | sed -n '1p')"

  expected_digest="${asset_record%%|*}"
  asset_url="${asset_record#*|}"
  expected_digest="${expected_digest#sha256:}"
  [ -n "$asset_record" ] && [ "$asset_url" != "$asset_record" ] \
    || die "The latest release does not contain a Debian $codename package for $architecture."
  [ -n "$expected_digest" ] && [ "$expected_digest" != null ] \
    || die "The GitHub release does not provide a SHA-256 digest for the package."

  TEMP_DIR="$(mktemp -d /tmp/ghostty-setup.XXXXXX)"
  package_file="$TEMP_DIR/${asset_url##*/}"
  info "Downloading ${asset_url##*/}..."
  curl -fL --retry 3 --connect-timeout 20 \
    "$asset_url" -o "$package_file"

  actual_digest="$(sha256sum "$package_file" | awk '{print $1}')"
  [ "$actual_digest" = "$expected_digest" ] \
    || die "SHA-256 verification failed for ${asset_url##*/}."
  success "Verified ${asset_url##*/} ($actual_digest)."

  as_root apt-get install -y "$package_file"
  rm -rf -- "$TEMP_DIR"
  TEMP_DIR=''
}

install_linux() {
  if ghostty_is_installed; then
    success "Ghostty is already installed."
    return
  fi

  local linux_id='unknown'
  local linux_like=''
  if [ -r /etc/os-release ]; then
    local ID=''
    local ID_LIKE=''
    # shellcheck disable=SC1091
    . /etc/os-release
    linux_id="${ID:-unknown}"
    linux_like="${ID_LIKE:-}"
  fi

  case "$linux_id" in
    arch|cachyos|endeavouros|manjaro)
      info "Installing Ghostty from the Arch repository..."
      if [ "$ASSUME_YES" -eq 1 ]; then
        as_root pacman -S --needed --noconfirm ghostty
      else
        as_root pacman -S --needed ghostty
      fi
      ;;
    alpine)
      info "Installing Ghostty from the Alpine repository..."
      as_root apk add ghostty
      ;;
    gentoo)
      info "Installing Ghostty from the Gentoo repository..."
      if [ "$ASSUME_YES" -eq 1 ]; then
        as_root emerge --ask=n ghostty
      else
        as_root emerge -av ghostty
      fi
      ;;
    solus)
      info "Installing Ghostty from the Solus repository..."
      if [ "$ASSUME_YES" -eq 1 ]; then
        as_root eopkg install -y ghostty
      else
        as_root eopkg install ghostty
      fi
      ;;
    void)
      info "Installing Ghostty from the Void repository..."
      if [ "$ASSUME_YES" -eq 1 ]; then
        as_root xbps-install -Sy ghostty
      else
        as_root xbps-install -S ghostty
      fi
      ;;
    ubuntu|pop|tuxedo|neon|elementary|linuxmint|zorin)
      install_ubuntu_family
      ;;
    fedora)
      install_fedora
      ;;
    debian)
      info "Checking the configured Debian repositories for Ghostty..."
      as_root apt-get update
      if apt-cache show ghostty >/dev/null 2>&1; then
        as_root apt-get install -y ghostty
      elif install_debian_community_package; then
        :
      elif ! install_snap; then
        die "No Ghostty package was found. Debian users can follow https://ghostty.org/docs/install/binary or rerun with --config-only."
      fi
      ;;
    *)
      case " $linux_like " in
        *" arch "*)
          info "Installing Ghostty from the Arch-compatible repository..."
          as_root pacman -S --needed ghostty
          ;;
        *" ubuntu "*)
          install_ubuntu_family
          ;;
        *" fedora "*|*" rhel "*)
          install_fedora
          ;;
        *)
          if ! install_snap; then
            die "Unsupported Linux distribution: $linux_id. See https://ghostty.org/docs/install/binary or rerun with --config-only."
          fi
          ;;
      esac
      ;;
  esac

  ghostty_is_installed \
    || die "The package command completed, but 'ghostty' is not available."
  success "Ghostty was installed."
}

write_config() {
  info "Configuring Ghostty at $CONFIG_FILE..."
  mkdir -p "$CONFIG_DIR"
  TEMP_FILE="$(mktemp "$CONFIG_DIR/.config.ghostty.XXXXXX")"

  local source_file=/dev/null
  if [ -f "$CONFIG_FILE" ]; then
    source_file="$CONFIG_FILE"
  fi

  awk \
    -v managed_begin="$MANAGED_BEGIN" \
    -v managed_end="$MANAGED_END" '
      $0 == managed_begin {
        in_managed = 1
        next
      }
      in_managed {
        if ($0 == managed_end) {
          in_managed = 0
        }
        next
      }
      /^[[:space:]]*shell-integration-features[[:space:]]*=/ {
        next
      }
      /^[[:space:]]*$/ {
        blank_lines++
        next
      }
      {
        while (blank_lines > 0) {
          print ""
          blank_lines--
        }
        print
      }
    ' "$source_file" > "$TEMP_FILE"

  if [ -s "$TEMP_FILE" ]; then
    printf '\n' >> "$TEMP_FILE"
  fi
  printf '%s\n' \
    "$MANAGED_BEGIN" \
    "shell-integration-features = $FEATURES" \
    "$MANAGED_END" >> "$TEMP_FILE"
  chmod 600 "$TEMP_FILE"

  if [ -f "$CONFIG_FILE" ] && cmp -s "$TEMP_FILE" "$CONFIG_FILE"; then
    rm -f -- "$TEMP_FILE"
    TEMP_FILE=''
    success "Ghostty configuration is already current."
    return
  fi

  if [ -f "$CONFIG_FILE" ]; then
    local backup
    backup="$CONFIG_FILE.bak.$(date +%Y%m%d%H%M%S).$$"
    cp -p "$CONFIG_FILE" "$backup"
    say "Backup: $backup"
  fi

  mv "$TEMP_FILE" "$CONFIG_FILE"
  TEMP_FILE=''
  success "Ghostty configuration was updated."
}

warn_macos_config_precedence() {
  [ "$(uname -s)" = Darwin ] || return 0

  local legacy_dir
  local legacy_file
  legacy_dir="$HOME/Library/Application Support/com.mitchellh.ghostty"
  for legacy_file in \
    "$legacy_dir/config.ghostty" \
    "$legacy_dir/config"; do
    if [ -s "$legacy_file" ]; then
      warn "macOS also loads this later config, which can override $CONFIG_FILE:"
      warn "  $legacy_file"
      warn "Move any settings you want to keep into the XDG file, then rename or remove the later file."
    fi
  done
}

validate_config() {
  [ "$SKIP_VALIDATE" -eq 0 ] || return 0

  local binary=''
  binary="$(ghostty_binary 2>/dev/null || true)"
  if [ -z "$binary" ]; then
    warn "Ghostty is not installed or not discoverable; configuration validation was skipped."
    return 0
  fi

  info "Validating the Ghostty configuration..."
  if "$binary" +validate-config; then
    success "Ghostty configuration validation passed."
  else
    die "Ghostty rejected the configuration. Restore the printed backup if needed."
  fi
}

main() {
  local os
  os="$(uname -s)"

  if [ "$CONFIG_ONLY" -eq 0 ]; then
    case "$os" in
      Darwin) install_macos ;;
      Linux) install_linux ;;
      *) die "Unsupported operating system: $os" ;;
    esac
  fi

  write_config
  warn_macos_config_precedence
  validate_config

  say
  success "Ghostty setup is complete."
  say "Configuration: $CONFIG_FILE"
  say "Open a completely new Ghostty window, then verify:"
  say "  type ssh"
  say "Expected in an integrated interactive shell: ssh is a shell function"

  if [ "$os" = Darwin ] && [ "${SHELL:-}" = /bin/bash ]; then
    warn "macOS /bin/bash 3.2 does not support Ghostty's automatic shell integration; use zsh, a newer Bash, or configure manual integration."
  fi
}

main
