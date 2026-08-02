#!/usr/bin/env bash

set -euo pipefail

test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$test_dir/.." && pwd)"
setup_script="$project_dir/macos/setup.sh"
brewfile="$project_dir/macos/Brewfile"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local text="$1"
  local expected="$2"
  local description="$3"
  if [[ "$text" != *"$expected"* ]]; then
    fail "$description (missing '$expected')"
  fi
}

assert_not_contains() {
  local text="$1"
  local unexpected="$2"
  local description="$3"
  if [[ "$text" == *"$unexpected"* ]]; then
    fail "$description (unexpected '$unexpected')"
  fi
}

bash -n "$setup_script"
if command -v ruby >/dev/null 2>&1; then
  ruby -c "$brewfile" >/dev/null
fi

metadata_count="$(
  grep -c '^# workstation-package|' "$brewfile"
)"
entry_count="$(
  grep -Ec '^(brew|cask|tap) "[^"]+" if false' "$brewfile"
)"
[[ "$metadata_count" -eq "$entry_count" ]] ||
  fail "Brewfile metadata count ($metadata_count) differs from entries ($entry_count)"

while IFS='|' read -r marker package_profiles package_kind token label \
    optional_state; do
  [[ "$marker" == '# workstation-package' ]] ||
    fail "Unexpected catalog marker '$marker'"
  [[ -n "$package_profiles" && -n "$package_kind" && -n "$token" &&
      -n "$label" ]] ||
    fail "Incomplete catalog metadata for '$token'"
  [[ "$package_kind" == 'brew' || "$package_kind" == 'cask' ||
      "$package_kind" == 'tap' ]] ||
    fail "Unknown package kind '$package_kind'"
  [[ "$optional_state" == 'required' ||
      "$optional_state" == 'optional' ]] ||
    fail "Unknown optional state '$optional_state'"
  grep -Eq "^${package_kind} \"${token}\" if false" "$brewfile" ||
    fail "Catalog metadata has no Brewfile entry for '$token'"
done < <(grep '^# workstation-package|' "$brewfile")

core_media_output="$("$setup_script" plan core media)"
assert_contains "$core_media_output" 'Plan: core media profile(s)' \
  'Combined plan did not preserve profile order'
assert_contains "$core_media_output" 'cask   keka' \
  'Core plan did not include Keka'
assert_contains "$core_media_output" 'cask   keepassxc' \
  'Core plan did not include KeePassXC'
assert_contains "$core_media_output" 'brew   sevenzip' \
  'Core plan did not include the 7-Zip CLI'
assert_contains "$core_media_output" 'brew   yt-dlp' \
  'Media plan did not include yt-dlp'
assert_contains "$core_media_output" 'brew   gallery-dl' \
  'Media plan did not include gallery-dl'
assert_contains "$core_media_output" 'cask   handbrake-app' \
  'Media plan did not include the current HandBrake cask'
assert_not_contains "$core_media_output" 'brew   mpv' \
  'Optional mpv appeared without --include-optional'

optional_output="$("$setup_script" plan media maintenance --include-optional)"
assert_contains "$optional_output" 'brew   mpv' \
  'Optional media plan did not include mpv'
assert_contains "$optional_output" 'cask   appcleaner' \
  'Optional maintenance plan did not include AppCleaner'
assert_contains "$optional_output" 'cask   stats' \
  'Maintenance plan did not include Stats'

admin_output="$("$setup_script" plan admin)"
assert_contains "$admin_output" 'cask   moonlight' \
  'Admin plan did not include Moonlight'
assert_contains "$admin_output" 'tap    LizardByte/homebrew' \
  'Admin plan did not include the official Sunshine tap'
assert_contains "$admin_output" 'brew   lizardbyte/homebrew/sunshine' \
  'Admin plan did not include Sunshine'

deduplicated_output="$("$setup_script" plan core desktop)"
localsend_count="$(
  printf '%s\n' "$deduplicated_output" |
    grep -c 'cask   localsend'
)"
[[ "$localsend_count" -eq 1 ]] ||
  fail "LocalSend appeared $localsend_count times in a composed plan"

dry_run_output="$("$setup_script" install core media --dry-run --yes)"
assert_contains "$dry_run_output" 'brew bundle install --no-upgrade' \
  'Dry run did not preview Homebrew Bundle'
assert_contains "$dry_run_output" \
  'OK   Dry run completed; no changes were made' \
  'Dry run did not report its safety boundary'

uninstall_dry_run_output="$(
  "$setup_script" uninstall \
    --packages keepassxc,stats,restic \
    --dry-run \
    --yes
)"
assert_contains "$uninstall_dry_run_output" \
  'brew uninstall --cask keepassxc' \
  'Uninstall dry run omitted KeePassXC'
assert_contains "$uninstall_dry_run_output" \
  'brew uninstall --cask stats' \
  'Uninstall dry run omitted Stats'
assert_contains "$uninstall_dry_run_output" \
  'brew uninstall --formula restic' \
  'Uninstall dry run omitted the selected formula'
assert_contains "$uninstall_dry_run_output" \
  'never uses Homebrew zap, autoremove, or cleanup' \
  'Uninstall plan omitted its package-only safety boundary'
assert_contains "$uninstall_dry_run_output" \
  'OK   Dry run completed; no changes were made' \
  'Uninstall dry run did not report that it made no changes'

if "$setup_script" uninstall \
    --packages not-a-catalog-package \
    --dry-run \
    --yes >/dev/null 2>&1; then
  fail 'Unknown uninstall package was accepted'
fi

fake_bin="$test_dir/fixtures/macos-bin"
bash -n "$fake_bin/brew" "$fake_bin/uname"

interactive_uninstall_output="$(
  printf '1\n' |
    PATH="$fake_bin:$PATH" \
      "$setup_script" uninstall --dry-run --yes
)"
assert_contains "$interactive_uninstall_output" \
  'Enter package numbers separated by commas' \
  'Uninstall menu did not prompt for numbered selection'
assert_contains "$interactive_uninstall_output" \
  'brew uninstall --cask keepassxc' \
  'Uninstall menu did not select the requested package'
assert_not_contains "$interactive_uninstall_output" \
  'brew uninstall --cask stats' \
  'Uninstall menu selected an unrequested package'

if "$setup_script" plan unknown >/dev/null 2>&1; then
  fail 'Unknown profile was accepted'
fi

if grep -Eiq \
    'brew[[:space:]]+(autoremove|cleanup)|--zap|rm[[:space:]]+-|defaults[[:space:]]+write|csrutil|spctl' \
    "$setup_script" "$brewfile"; then
  fail 'Installer source contains a prohibited cleanup or security command'
fi

printf 'PASS: macOS workstation utility planner and Brewfile\n'
