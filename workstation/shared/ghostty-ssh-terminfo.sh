#!/usr/bin/env bash
# Install Ghostty's terminfo entry locally or on an SSH server.

set -Eeuo pipefail

SCRIPT_NAME="${0##*/}"
TERMINFO_NAME='xterm-ghostty'

SYSTEM_INSTALL=0
CHECK_ONLY=0
USER_ONLY=0
MODE_SELECTED=0
DESTINATION=''

say()     { printf '%s\n' "$*"; }
info()    { printf '==> %s\n' "$*"; }
success() { printf 'OK  %s\n' "$*"; }
die()     { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF_USAGE
Usage: $SCRIPT_NAME [options] [user@host]

Install the $TERMINFO_NAME terminfo entry for the current user or copy it
from this machine to an SSH server.

Options:
  --user       Install only for the current user without opening the menu.
  --system     Also install the entry system-wide using sudo or doas.
  --check      Check whether the entry is available without installing it.
  --help, -h   Show this help.

Examples:
  $SCRIPT_NAME
  $SCRIPT_NAME --user server.example.com
  $SCRIPT_NAME --system user@server.example.com
  $SCRIPT_NAME --system
  $SCRIPT_NAME --check user@server.example.com

Without --user, --system, or --check, an interactive menu selects the action.
With no destination, run this inside an interactive Ghostty SSH session after
Ghostty's ssh-terminfo integration has copied the entry for your user.
EOF_USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$SYSTEM_INSTALL" -eq 0 ] \
        || die "--user and --system cannot be used together."
      USER_ONLY=1
      MODE_SELECTED=1
      ;;
    --system)
      [ "$USER_ONLY" -eq 0 ] \
        || die "--user and --system cannot be used together."
      SYSTEM_INSTALL=1
      MODE_SELECTED=1
      ;;
    --check)
      CHECK_ONLY=1
      MODE_SELECTED=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      [ "$#" -gt 0 ] || die "Missing SSH destination after --."
      [ -z "$DESTINATION" ] || die "Only one SSH destination is supported."
      DESTINATION="$1"
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      [ -z "$DESTINATION" ] || die "Only one SSH destination is supported."
      DESTINATION="$1"
      ;;
  esac
  shift
done

has() {
  command -v "$1" >/dev/null 2>&1
}

require() {
  has "$1" || die "Required command not found: $1"
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif has sudo; then
    sudo "$@"
  elif has doas; then
    doas "$@"
  else
    die "System installation requires root, sudo, or doas."
  fi
}

show_term() {
  say "Current TERM: ${TERM:-<unset>}"
}

interactive_menu() {
  local selection=''

  say
  say "Ghostty SSH terminfo setup"
  if [ -n "$DESTINATION" ]; then
    say "Target: $DESTINATION"
  else
    say "Target: this machine"
  fi
  say
  say "1) Install for the current user only"
  say "2) Install for the current user and system-wide (recommended for sudo)"
  say "3) Check the current-user installation"
  say "4) Check the system-wide installation"
  say "5) Exit"

  while :; do
    printf 'Select an option [1-5]: '
    IFS= read -r selection || die \
      "No selection received. Use --user, --system, or --check for non-interactive use."

    case "$selection" in
      1)
        SYSTEM_INSTALL=0
        CHECK_ONLY=0
        return
        ;;
      2)
        SYSTEM_INSTALL=1
        CHECK_ONLY=0
        return
        ;;
      3)
        SYSTEM_INSTALL=0
        CHECK_ONLY=1
        return
        ;;
      4)
        SYSTEM_INSTALL=1
        CHECK_ONLY=1
        return
        ;;
      5)
        say "No changes were made."
        exit 0
        ;;
      *)
        say "Please enter a number from 1 to 5."
        ;;
    esac
  done
}

require_source() {
  require infocmp
  infocmp -x "$TERMINFO_NAME" >/dev/null 2>&1 || die \
    "The local $TERMINFO_NAME entry is unavailable. Run this from Ghostty, or install Ghostty's terminfo first."
}

check_local_user() {
  require infocmp
  if infocmp -x "$TERMINFO_NAME" >/dev/null 2>&1; then
    success "$TERMINFO_NAME is available to the current user."
  else
    die "$TERMINFO_NAME is not available to the current user."
  fi
}

check_local_system() {
  if as_root infocmp -x "$TERMINFO_NAME" >/dev/null 2>&1; then
    success "$TERMINFO_NAME is available system-wide."
  else
    die "$TERMINFO_NAME is not available system-wide."
  fi
}

install_local_user() {
  local user_terminfo="$HOME/.terminfo"

  require_source
  require tic
  info "Installing $TERMINFO_NAME for the current user..."
  mkdir -p "$user_terminfo"
  infocmp -x "$TERMINFO_NAME" | tic -x -o "$user_terminfo" -

  TERMINFO="$user_terminfo" infocmp -x "$TERMINFO_NAME" >/dev/null 2>&1 \
    || die "The per-user terminfo verification failed."
  success "$TERMINFO_NAME was installed in $user_terminfo."
}

install_local_system() {
  require_source
  require tic
  info "Installing $TERMINFO_NAME system-wide..."
  infocmp -x "$TERMINFO_NAME" | as_root tic -x -
  check_local_system
}

ssh_with_optional_tty() {
  if [ -t 0 ]; then
    ssh -t "$@"
  else
    ssh "$@"
  fi
}

check_remote_user() {
  local remote_check='
set -eu
printf "Remote TERM: %s\n" "${TERM:-<unset>}"
if infocmp -x xterm-ghostty >/dev/null 2>&1; then
  printf "OK  xterm-ghostty is available to the remote user.\n"
else
  printf "ERROR: xterm-ghostty is not available to the remote user.\n" >&2
  exit 1
fi
'

  ssh_with_optional_tty "$DESTINATION" "$remote_check"
}

check_remote_system() {
  local remote_check='
set -eu
printf "Remote TERM: %s\n" "${TERM:-<unset>}"
if [ "$(id -u)" -eq 0 ]; then
  infocmp -x xterm-ghostty >/dev/null
elif command -v sudo >/dev/null 2>&1; then
  sudo infocmp -x xterm-ghostty >/dev/null
elif command -v doas >/dev/null 2>&1; then
  doas infocmp -x xterm-ghostty >/dev/null
else
  printf "ERROR: System verification requires root, sudo, or doas.\n" >&2
  exit 1
fi
printf "OK  xterm-ghostty is available system-wide.\n"
'

  ssh_with_optional_tty "$DESTINATION" "$remote_check"
}

install_remote_user() {
  local remote_install='
set -eu
command -v tic >/dev/null 2>&1 || {
  printf "ERROR: The remote server does not have tic (usually provided by ncurses).\n" >&2
  exit 1
}
user_terminfo="$HOME/.terminfo"
mkdir -p "$user_terminfo"
tic -x -o "$user_terminfo" -
TERMINFO="$user_terminfo" infocmp -x xterm-ghostty >/dev/null
printf "OK  xterm-ghostty was installed in %s.\n" "$user_terminfo"
'

  require ssh
  require_source
  info "Copying $TERMINFO_NAME to $DESTINATION..."
  infocmp -x "$TERMINFO_NAME" | ssh "$DESTINATION" "$remote_install"
}

install_remote_system() {
  local remote_install='
set -eu
if [ "$(id -u)" -eq 0 ]; then
  infocmp -x xterm-ghostty | tic -x -
  infocmp -x xterm-ghostty >/dev/null
elif command -v sudo >/dev/null 2>&1; then
  infocmp -x xterm-ghostty | sudo tic -x -
  sudo infocmp -x xterm-ghostty >/dev/null
elif command -v doas >/dev/null 2>&1; then
  infocmp -x xterm-ghostty | doas tic -x -
  doas infocmp -x xterm-ghostty >/dev/null
else
  printf "ERROR: System installation requires root, sudo, or doas.\n" >&2
  exit 1
fi
printf "OK  xterm-ghostty was installed system-wide.\n"
printf "Remote TERM: %s\n" "${TERM:-<unset>}"
'

  info "Promoting $TERMINFO_NAME to the system database on $DESTINATION..."
  ssh_with_optional_tty "$DESTINATION" "$remote_install"
}

main() {
  if [ "$MODE_SELECTED" -eq 0 ]; then
    interactive_menu
  fi

  if [ -z "$DESTINATION" ]; then
    show_term
    if [ "$CHECK_ONLY" -eq 1 ]; then
      check_local_user
      if [ "$SYSTEM_INSTALL" -eq 1 ]; then
        check_local_system
      fi
      return
    fi

    install_local_user
    if [ "$SYSTEM_INSTALL" -eq 1 ]; then
      install_local_system
    fi
    return
  fi

  require ssh
  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ "$SYSTEM_INSTALL" -eq 1 ]; then
      check_remote_system
    else
      check_remote_user
    fi
    return
  fi

  install_remote_user
  if [ "$SYSTEM_INSTALL" -eq 1 ]; then
    install_remote_system
  else
    check_remote_user
  fi
}

main
