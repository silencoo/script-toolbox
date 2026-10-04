#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
brewfile="$script_dir/Brewfile"
command_name="menu"
include_optional=0
assume_yes=0
dry_run=0
profiles=()
selected_keys=()
uninstall_requests=()
uninstall_keys=()
uninstall_labels=()

usage() {
  cat <<'USAGE'
Usage:
  ./setup.sh [menu] [options]
  ./setup.sh plan [profiles...] [options]
  ./setup.sh install [profiles...] [options]
  ./setup.sh uninstall [profiles...] [options]
  ./setup.sh list

Profiles:
  core  media  maintenance  desktop  admin  terminal

Options:
  --include-optional  Include opt-in apps and alternatives
  --yes               Skip the initializer confirmation
  --dry-run           Preview the Homebrew command without running it
  --packages TOKENS   Uninstall exact catalog tokens instead of using the menu
  --brewfile PATH     Use another compatible Brewfile
  -h, --help          Show this help

Examples:
  ./setup.sh
  ./setup.sh plan core media
  ./setup.sh install core desktop
  ./setup.sh install terminal
  ./setup.sh install maintenance --include-optional --yes
  ./setup.sh uninstall
  ./setup.sh uninstall maintenance
  ./setup.sh uninstall --packages keepassxc,stats --dry-run
USAGE
}

die() {
  printf 'ERROR %s\n' "$*" >&2
  exit 1
}

contains_profile() {
  local wanted="$1"
  local profile_name
  for profile_name in "${profiles[@]+"${profiles[@]}"}"; do
    if [[ "$profile_name" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

add_profile() {
  local raw_name="$1"
  local profile_name
  local old_ifs="$IFS"
  IFS=','
  for profile_name in $raw_name; do
    profile_name="$(
      printf '%s' "$profile_name" |
        tr '[:upper:]' '[:lower:]' |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
    )"
    [[ -n "$profile_name" ]] || continue
    case "$profile_name" in
      core|media|maintenance|desktop|admin|terminal) ;;
      *) die "Unknown profile '$profile_name'. Run './setup.sh list'." ;;
    esac
    if ! contains_profile "$profile_name"; then
      profiles+=("$profile_name")
    fi
  done
  IFS="$old_ifs"
}

profile_is_selected() {
  local available_profiles="$1"
  local candidate
  local old_ifs="$IFS"
  IFS=','
  for candidate in $available_profiles; do
    if contains_profile "$candidate"; then
      IFS="$old_ifs"
      return 0
    fi
  done
  IFS="$old_ifs"
  return 1
}

key_is_selected() {
  local wanted="$1"
  local selected_key
  for selected_key in "${selected_keys[@]+"${selected_keys[@]}"}"; do
    if [[ "$selected_key" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

uninstall_key_is_selected() {
  local wanted="$1"
  local selected_key
  for selected_key in \
      "${uninstall_keys[@]+"${uninstall_keys[@]}"}"; do
    if [[ "$selected_key" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

select_menu_profiles() {
  local reply
  local item
  local selected_profile
  local valid
  local -a items=()

  printf '\nChoose profiles\n'
  printf '  1. Core          Everyday apps, archives, transfer, and window layout\n'
  printf '  2. Terminal      Ghostty, Starship, Zsh plugins, Yazi, and CLI tools\n'
  printf '  3. Media         Download, inspect, and convert media\n'
  printf '  4. Maintenance   Disk inspection, monitoring, and backups\n'
  printf '  5. Desktop       LocalSend, Rectangle, and wake control\n'
  printf '  6. Admin         Networking, remote access, and encryption\n'
  printf '  0. Cancel\n'

  while true; do
    printf '\nEnter profile numbers separated by commas or spaces [1]: '
    IFS= read -r reply || return 1
    case "$reply" in
      0|q|Q|quit|QUIT|cancel|CANCEL) return 1 ;;
    esac
    reply="${reply//,/ }"
    IFS=$' \t' read -r -a items <<< "$reply"
    profiles=()
    valid=1
    for item in "${items[@]+"${items[@]}"}"; do
      case "$item" in
        1) selected_profile=core ;;
        2) selected_profile=terminal ;;
        3) selected_profile=media ;;
        4) selected_profile=maintenance ;;
        5) selected_profile=desktop ;;
        6) selected_profile=admin ;;
        *) valid=0; break ;;
      esac
      add_profile "$selected_profile"
    done
    if [[ "$valid" -eq 1 ]]; then
      if [[ "${#profiles[@]}" -eq 0 ]]; then
        profiles=(core)
      fi
      return 0
    fi
    printf 'WARN Choose numbers from 1 to 6, or 0 to cancel.\n'
  done
}

select_menu_optional_packages() {
  local metadata
  local available_profiles
  local package_kind
  local token
  local label
  local optional_state
  local optional_count=0
  local reply

  [[ -f "$brewfile" ]] || die "Brewfile not found: $brewfile"
  while IFS='|' read -r metadata available_profiles package_kind token \
      label optional_state; do
    [[ "$metadata" == '# workstation-package' ]] || continue
    [[ "$optional_state" == optional ]] || continue
    profile_is_selected "$available_profiles" || continue
    if [[ "$optional_count" -eq 0 ]]; then
      printf '\nOptional additions for these profiles:\n'
    fi
    printf '  %-32s %s\n' "$token" "$label"
    optional_count="$((optional_count + 1))"
  done < <(grep '^# workstation-package|' "$brewfile")

  [[ "$optional_count" -gt 0 && "$include_optional" -eq 0 ]] || return 0
  while true; do
    printf 'Include these optional additions? [y/N, 0 to cancel]: '
    IFS= read -r reply || return 1
    case "$reply" in
      [Yy]|[Yy][Ee][Ss]) include_optional=1; return 0 ;;
      ''|[Nn]|[Nn][Oo]) return 0 ;;
      0|q|Q|quit|QUIT|cancel|CANCEL) return 1 ;;
      *) printf 'WARN Enter y, n, or 0 to cancel.\n' ;;
    esac
  done
}

run_setup_menu() {
  local reply

  [[ "${#profiles[@]}" -eq 0 ]] ||
    die 'Use install or plan with profile arguments, or choose profiles in the menu.'
  printf '\nmacOS workstation setup\n'
  printf '  1. Install profiles\n'
  printf '  2. Preview profiles\n'
  printf '  3. Uninstall packages\n'
  printf '  0. Exit\n'
  while true; do
    printf '\nChoose an action [0]: '
    IFS= read -r reply || return 1
    case "$reply" in
      1) command_name=install; break ;;
      2) command_name=plan; break ;;
      3) command_name=uninstall; return 0 ;;
      ''|0|q|Q|quit|QUIT|cancel|CANCEL) return 1 ;;
      *) printf 'WARN Choose 1, 2, 3, or 0.\n' ;;
    esac
  done
  select_menu_profiles || return 1
  select_menu_optional_packages || return 1
}

show_profiles() {
  printf '\nWorkstation utilities for macOS\n'
  printf '%s\n' '--------------------------------------------------------------------'
  printf '  %-13s %s\n' core \
    'Passwords, archives, transfer, disk usage, playback, and layout'
  printf '  %-13s %s\n' media \
    'Media download, inspection, playback, and conversion'
  printf '  %-13s %s\n' maintenance \
    'Inspection, maintenance, hardware monitoring, drive health, and backup'
  printf '  %-13s %s\n' desktop \
    'Transfer, window layout, wake control, and opt-in launchers'
  printf '  %-13s %s\n' admin \
    'Explicit networking, remote access, and encryption tools'
  printf '  %-13s %s\n' terminal \
    'Ghostty, Starship, Zsh plugins, Yazi, navigation, and CLI tools'
  printf '\nUse --include-optional for AppCleaner, mpv, Maccy, Raycast, VeraCrypt, btop, ncdu, and duf.\n'
  printf 'The admin profile may require elevation, extensions, or account setup.\n'
}

show_builtin_tools() {
  if contains_profile core || contains_profile desktop ||
      contains_profile maintenance || contains_profile admin; then
    printf '\nBuilt into macOS (nothing will be installed):\n'
  fi
  if contains_profile core || contains_profile desktop; then
    printf '  Spotlight and mdfind       Fast file search\n'
    printf '  Preview                    PDF viewing\n'
    printf '  Screenshot                 Screenshots and screen recording\n'
  fi
  if contains_profile maintenance; then
    printf '  Time Machine               System backup\n'
  fi
  if contains_profile admin; then
    printf '  Activity Monitor           Process and system inspection\n'
  fi
}

show_plan() {
  local metadata
  local available_profiles
  local package_kind
  local token
  local label
  local optional_state
  local key

  [[ -f "$brewfile" ]] || die "Brewfile not found: $brewfile"
  selected_keys=()

  printf '\nPlan: %s profile(s)\n' "${profiles[*]}"
  printf '%s\n' '--------------------------------------------------------------------'
  printf 'Brewfile: %s\n' "$brewfile"
  if [[ "$include_optional" -eq 1 ]]; then
    printf 'Optional packages: included\n\n'
  else
    printf 'Optional packages: excluded\n\n'
  fi
  printf 'Selected packages (Homebrew skips those already installed):\n\n'

  while IFS='|' read -r metadata available_profiles package_kind token \
      label optional_state; do
    [[ "$metadata" == '# workstation-package' ]] || continue
    profile_is_selected "$available_profiles" || continue
    if [[ "$optional_state" == 'optional' &&
        "$include_optional" -ne 1 ]]; then
      continue
    fi

    key="$package_kind:$token"
    key_is_selected "$key" && continue
    selected_keys+=("$key")

    if [[ "$optional_state" == 'optional' ]]; then
      printf '  %-6s %-32s %s [optional]\n' \
        "$package_kind" "$token" "$label"
    else
      printf '  %-6s %-32s %s\n' "$package_kind" "$token" "$label"
    fi
  done < <(grep '^# workstation-package|' "$brewfile")

  [[ "${#selected_keys[@]}" -gt 0 ]] ||
    die 'The selected profiles did not resolve to any packages.'

  show_builtin_tools
  if key_is_selected 'cask:ghostty'; then
    printf '\nGhostty configuration:\n'
    printf '  - enables SSH environment forwarding and remote terminfo setup\n'
    printf '  - preserves other settings and backs up changed configuration\n'
    printf '  - configures ~/.config/ghostty/config.ghostty for the current user\n'
    if key_is_selected 'cask:font-jetbrains-mono-nerd-font'; then
      printf '  - uses JetBrains Mono Nerd Font when no font preference is configured\n'
    fi
  fi
  if key_is_selected 'brew:starship'; then
    printf '\nZsh terminal configuration:\n'
    printf '  - enables Starship, fuzzy history/completion, and smart directory navigation\n'
    printf '  - loads autosuggestions, syntax highlighting, and Homebrew completions\n'
    printf '  - adds icon-aware file aliases and preserves existing aliases/editor settings\n'
    if key_is_selected 'brew:yazi'; then
      printf '  - adds y to open Yazi and return to the selected directory when it exits\n'
    fi
    printf '  - updates a managed block in %s/.zshrc, preserving other content with backups\n' "${ZDOTDIR:-$HOME}"
  fi
  printf '\nSafety boundary:\n'
  printf '  - installs missing packages only; Homebrew upgrades are disabled\n'
  printf '  - the install action never uninstalls applications or deletes files\n'
  printf '  - never clears caches or changes macOS security settings\n'
}

confirm_install() {
  local reply
  if [[ "$assume_yes" -eq 1 || "$dry_run" -eq 1 ]]; then
    return 0
  fi
  printf 'Install the missing packages in this plan? [y/N] '
  IFS= read -r reply || return 1
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

install_packages() {
  printf '\nInstalling missing Homebrew packages\n'
  printf '%s\n' '--------------------------------------------------------------------'
  printf '    $ <filtered Brewfile> | '
  printf 'brew bundle install --no-upgrade --file=-\n'

  local ghostty_setup="$script_dir/../shared/ghostty-setup.sh"
  local zsh_setup="$script_dir/terminal-setup.sh"
  local -a ghostty_options=(--config-only)
  if key_is_selected 'cask:font-jetbrains-mono-nerd-font'; then
    ghostty_options+=(--font-if-unset 'JetBrainsMono Nerd Font')
  fi
  if key_is_selected 'cask:ghostty'; then
    [[ -f "$ghostty_setup" ]] || die "Ghostty configuration helper not found: $ghostty_setup"
    printf '    $ bash %q' "$ghostty_setup"
    printf ' %q' "${ghostty_options[@]}"
    printf '\n'
  fi
  if key_is_selected 'brew:starship'; then
    [[ -f "$zsh_setup" && -f "$script_dir/zshrc.zsh" ]] || die 'Zsh configuration helper or template not found.'
    printf '    $ bash %q\n' "$zsh_setup"
  fi

  if [[ "$dry_run" -eq 1 ]]; then
    printf 'OK   Dry run completed; no changes were made\n'
    return 0
  fi

  [[ "$(uname -s)" == 'Darwin' ]] ||
    die 'The install command must run on macOS.'
  command -v brew >/dev/null 2>&1 ||
    die 'Homebrew is required. Install it from https://brew.sh/ and rerun.'

  generate_selected_brewfile |
    brew bundle install --no-upgrade --file=-

  if key_is_selected 'cask:ghostty'; then
    bash "$ghostty_setup" "${ghostty_options[@]}"
  fi
  if key_is_selected 'brew:starship'; then
    bash "$zsh_setup"
  fi

  printf 'OK   Requested utility packages are installed\n'
}

brew_package_is_installed() {
  local package_kind="$1"
  local token="$2"
  local type_flag

  case "$package_kind" in
    brew) type_flag='--formula' ;;
    cask) type_flag='--cask' ;;
    *) return 1 ;;
  esac

  brew list "$type_flag" --versions "$token" >/dev/null 2>&1
}

add_uninstall_entry() {
  local package_kind="$1"
  local token="$2"
  local label="$3"
  local key="$package_kind:$token"

  if ! uninstall_key_is_selected "$key"; then
    uninstall_keys+=("$key")
    uninstall_labels+=("$label")
  fi
}

resolve_requested_uninstall_packages() {
  local raw_request
  local request
  local old_ifs
  local metadata
  local available_profiles
  local package_kind
  local token
  local label
  local optional_state
  local matched

  for raw_request in \
      "${uninstall_requests[@]+"${uninstall_requests[@]}"}"; do
    old_ifs="$IFS"
    IFS=','
    for request in $raw_request; do
      request="$(
        printf '%s' "$request" |
          sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
      )"
      [[ -n "$request" ]] || continue
      matched=0
      while IFS='|' read -r metadata available_profiles package_kind token \
          label optional_state; do
        [[ "$metadata" == '# workstation-package' ]] || continue
        [[ "$package_kind" != 'tap' ]] || continue
        if [[ "$request" == "$token" ||
            "$request" == "$package_kind:$token" ]]; then
          add_uninstall_entry "$package_kind" "$token" "$label"
          matched=1
        fi
      done < <(grep '^# workstation-package|' "$brewfile")
      [[ "$matched" -eq 1 ]] ||
        die "Unknown uninstall package '$request'."
    done
    IFS="$old_ifs"
  done
}

select_installed_packages_for_uninstall() {
  local metadata
  local available_profiles
  local package_kind
  local token
  local label
  local optional_state
  local key
  local reply
  local item
  local selected_number
  local index
  local number
  local selected_numbers=()
  local menu_keys=()
  local menu_labels=()

  printf '\nInstalled workstation utilities\n'
  printf '%s\n' '--------------------------------------------------------------------'
  printf '==> Checking catalog packages with Homebrew\n'

  while IFS='|' read -r metadata available_profiles package_kind token \
      label optional_state; do
    [[ "$metadata" == '# workstation-package' ]] || continue
    [[ "$package_kind" != 'tap' ]] || continue
    if [[ "${#profiles[@]}" -gt 0 ]]; then
      profile_is_selected "$available_profiles" || continue
    fi
    key="$package_kind:$token"
    uninstall_key_is_selected "$key" && continue
    if brew_package_is_installed "$package_kind" "$token"; then
      add_uninstall_entry "$package_kind" "$token" "$label"
      menu_keys+=("$key")
      menu_labels+=("$label")
    fi
  done < <(grep '^# workstation-package|' "$brewfile")

  if [[ "${#menu_keys[@]}" -eq 0 ]]; then
    printf 'SKIP No matching catalog packages are installed.\n'
    uninstall_keys=()
    uninstall_labels=()
    return 0
  fi

  printf '\n'
  for ((index = 0; index < ${#menu_keys[@]}; index += 1)); do
    printf '  %2d. %-30s %s\n' \
      "$((index + 1))" "${menu_labels[$index]}" "${menu_keys[$index]}"
  done

  printf '\nEnter package numbers separated by commas, or Q to cancel: '
  if ! IFS= read -r reply; then
    die 'Could not read an uninstall selection; no packages were removed.'
  fi
  case "$reply" in
    ''|q|Q|quit|QUIT|cancel|CANCEL)
      uninstall_keys=()
      uninstall_labels=()
      return 0
      ;;
  esac

  uninstall_keys=()
  uninstall_labels=()
  reply="${reply//,/ }"
  for item in $reply; do
    case "$item" in
      ''|*[!0-9]*)
        die "Invalid uninstall selection '$item'; no packages were removed."
        ;;
    esac
    number="$((10#$item))"
    if [[ "$number" -lt 1 || "$number" -gt "${#menu_keys[@]}" ]]; then
      die "Invalid uninstall selection '$item'; no packages were removed."
    fi
    for selected_number in \
        "${selected_numbers[@]+"${selected_numbers[@]}"}"; do
      if [[ "$selected_number" -eq "$number" ]]; then
        number=0
        break
      fi
    done
    [[ "$number" -ne 0 ]] || continue
    selected_numbers+=("$number")
    index="$((number - 1))"
    uninstall_keys+=("${menu_keys[$index]}")
    uninstall_labels+=("${menu_labels[$index]}")
  done
}

show_uninstall_selection() {
  local index

  printf '\nUninstall selection\n'
  printf '%s\n' '--------------------------------------------------------------------'
  for ((index = 0; index < ${#uninstall_keys[@]}; index += 1)); do
    printf '  %-38s %s\n' \
      "${uninstall_keys[$index]}" "${uninstall_labels[$index]}"
  done
  printf '\nRemoval boundary:\n'
  printf '  - removes only the selected application packages\n'
  printf '  - never uses Homebrew zap, autoremove, or cleanup\n'
  printf '%s\n' \
    '  - does not issue commands to delete user files, password databases, or backups'
}

confirm_uninstall() {
  local reply
  if [[ "$assume_yes" -eq 1 || "$dry_run" -eq 1 ]]; then
    return 0
  fi
  printf 'Type UNINSTALL to remove exactly the packages shown above: '
  if ! IFS= read -r reply; then
    return 1
  fi
  [[ "$reply" == 'UNINSTALL' ]]
}

uninstall_selected_packages() {
  local index
  local key
  local package_kind
  local token
  local label
  local type_flag
  local failure_count=0

  printf '\nUninstalling selected Homebrew packages\n'
  printf '%s\n' '--------------------------------------------------------------------'
  for ((index = 0; index < ${#uninstall_keys[@]}; index += 1)); do
    key="${uninstall_keys[$index]}"
    label="${uninstall_labels[$index]}"
    package_kind="${key%%:*}"
    token="${key#*:}"
    case "$package_kind" in
      brew) type_flag='--formula' ;;
      cask) type_flag='--cask' ;;
      *) die "Unsupported uninstall package kind '$package_kind'." ;;
    esac

    printf '==> [%d/%d] %s\n' \
      "$((index + 1))" "${#uninstall_keys[@]}" "$label"
    printf '    $ brew uninstall %s %s\n' "$type_flag" "$token"
    if [[ "$dry_run" -eq 1 ]]; then
      continue
    fi
    if ! brew_package_is_installed "$package_kind" "$token"; then
      printf 'SKIP %s is not installed\n' "$token"
      continue
    fi
    if brew uninstall "$type_flag" "$token"; then
      printf 'OK   %s uninstalled\n' "$label"
    else
      printf 'WARN %s could not be uninstalled\n' "$label" >&2
      failure_count="$((failure_count + 1))"
    fi
  done

  if [[ "$dry_run" -eq 1 ]]; then
    printf 'OK   Dry run completed; no changes were made\n'
  elif [[ "$failure_count" -eq 0 ]]; then
    printf 'OK   Selected utility packages were uninstalled\n'
  else
    die "$failure_count package(s) could not be uninstalled."
  fi
}

run_uninstall() {
  [[ -f "$brewfile" ]] || die "Brewfile not found: $brewfile"
  uninstall_keys=()
  uninstall_labels=()

  if [[ "$dry_run" -ne 1 || "${#uninstall_requests[@]}" -eq 0 ]]; then
    [[ "$(uname -s)" == 'Darwin' ]] ||
      die 'The uninstall menu must run on macOS.'
    command -v brew >/dev/null 2>&1 ||
      die 'Homebrew is required to find and uninstall catalog packages.'
  fi

  if [[ "${#uninstall_requests[@]}" -gt 0 ]]; then
    resolve_requested_uninstall_packages
  else
    select_installed_packages_for_uninstall
  fi

  if [[ "${#uninstall_keys[@]}" -eq 0 ]]; then
    printf 'WARN Uninstall cancelled; no changes were made.\n'
    return 0
  fi

  show_uninstall_selection
  if ! confirm_uninstall; then
    printf 'WARN Uninstall cancelled; no changes were made.\n'
    return 0
  fi
  uninstall_selected_packages

  printf 'NOTE Homebrew taps and user configuration files were retained.\n'
}

generate_selected_brewfile() {
  local selected_key
  local package_kind
  local token

  printf '# Generated by workstation/macos/setup.sh\n'
  for selected_key in "${selected_keys[@]+"${selected_keys[@]}"}"; do
    package_kind="${selected_key%%:*}"
    token="${selected_key#*:}"
    printf '%s "%s"\n' "$package_kind" "$token"
  done
}

if [[ "$#" -gt 0 ]]; then
  case "$1" in
    menu|plan|install|uninstall|list)
      command_name="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*) ;;
    *)
      die "Unknown command '$1'. Expected menu, plan, install, uninstall, or list."
      ;;
  esac
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --include-optional)
      include_optional=1
      ;;
    --yes)
      assume_yes=1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --packages)
      shift
      [[ "$#" -gt 0 ]] || die '--packages requires catalog tokens.'
      uninstall_requests+=("$1")
      ;;
    --brewfile)
      shift
      [[ "$#" -gt 0 ]] || die '--brewfile requires a path.'
      brewfile="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown option '$1'."
      ;;
    *)
      add_profile "$1"
      ;;
  esac
  shift
done

if [[ "$command_name" == menu ]]; then
  [[ "${#uninstall_requests[@]}" -eq 0 ]] ||
    die '--packages is valid only with the uninstall command.'
  if ! run_setup_menu; then
    printf 'WARN Setup cancelled; no changes were made.\n'
    exit 0
  fi
fi

if [[ "$command_name" == 'uninstall' ]]; then
  run_uninstall
  exit 0
fi

if [[ "${#uninstall_requests[@]}" -gt 0 ]]; then
  die '--packages is valid only with the uninstall command.'
fi

if [[ "$command_name" == 'list' ]]; then
  show_profiles
  exit 0
fi

if [[ "${#profiles[@]}" -eq 0 ]]; then
  profiles=('core')
fi

show_plan
if [[ "$command_name" == 'plan' ]]; then
  exit 0
fi

if ! confirm_install; then
  printf 'WARN Installation cancelled; no changes were made.\n'
  exit 0
fi
install_packages
