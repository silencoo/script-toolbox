#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
brewfile="$script_dir/Brewfile"
command_name="plan"
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
  ./setup.sh plan [profiles...] [options]
  ./setup.sh install [profiles...] [options]
  ./setup.sh uninstall [profiles...] [options]
  ./setup.sh list

Profiles:
  core  media  maintenance  desktop  admin

Options:
  --include-optional  Include opt-in apps and alternatives
  --yes               Skip the initializer confirmation
  --dry-run           Preview the Homebrew command without running it
  --packages TOKENS   Uninstall exact catalog tokens instead of using the menu
  --brewfile PATH     Use another compatible Brewfile
  -h, --help          Show this help

Examples:
  ./setup.sh plan core media
  ./setup.sh install core desktop
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
      core|media|maintenance|desktop|admin) ;;
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

show_profiles() {
  printf '\nWorkstation utilities for macOS\n'
  printf '%s\n' '--------------------------------------------------------------------'
  printf '  %-13s %s\n' core \
    'Passwords, archives, transfer, disk usage, playback, and layout'
  printf '  %-13s %s\n' media \
    'Media download, inspection, playback, and conversion'
  printf '  %-13s %s\n' maintenance \
    'Inspection, hardware monitoring, drive health, and backup'
  printf '  %-13s %s\n' desktop \
    'Transfer, window layout, wake control, and opt-in launchers'
  printf '  %-13s %s\n' admin \
    'Explicit networking, remote access, and encryption tools'
  printf '\nUse --include-optional for AppCleaner, mpv, Maccy, Raycast, and VeraCrypt.\n'
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
  read -r -p 'Install the missing packages in this plan? [y/N] ' reply
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

install_packages() {
  printf '\nInstalling missing Homebrew packages\n'
  printf '%s\n' '--------------------------------------------------------------------'
  printf '    $ <filtered Brewfile> | '
  printf 'brew bundle install --no-upgrade --file=-\n'

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

  printf '# Generated by workstation-utils/macos/setup.sh\n'
  for selected_key in "${selected_keys[@]+"${selected_keys[@]}"}"; do
    package_kind="${selected_key%%:*}"
    token="${selected_key#*:}"
    printf '%s "%s"\n' "$package_kind" "$token"
  done
}

if [[ "$#" -gt 0 ]]; then
  case "$1" in
    plan|install|uninstall|list)
      command_name="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown command or option '$1'."
      ;;
    *)
      die "Unknown command '$1'. Expected plan, install, uninstall, or list."
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
