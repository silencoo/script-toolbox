#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLKIT="$TEST_DIR/../server-toolkit.sh"
TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/linux-server-toolkit-test.XXXXXX")"
TEST_COUNT=0

cleanup_test_files() {
    rm -rf -- "$TEST_TMP"
}
trap cleanup_test_files EXIT

fail() {
    printf 'not ok - %s\n' "$*" >&2
    exit 1
}

pass() {
    TEST_COUNT=$((TEST_COUNT + 1))
    printf 'ok %d - %s\n' "$TEST_COUNT" "$1"
}

assert_contains() {
    local value="$1" expected="$2" label="$3"
    case "$value" in
        *"$expected"*) pass "$label" ;;
        *) fail "$label (missing: $expected)" ;;
    esac
}

assert_not_contains() {
    local value="$1" unexpected="$2" label="$3"
    case "$value" in
        *"$unexpected"*) fail "$label (found: $unexpected)" ;;
        *) pass "$label" ;;
    esac
}

bash -n "$TOOLKIT"
pass "toolkit passes bash -n"

# shellcheck source=../server-toolkit.sh
source "$TOOLKIT"
LOG_FILE="$TEST_TMP/test.log"
LOG_READY=false
BACKUP_DIR="$TEST_TMP/backups"

timezone_name_is_valid "Etc/UTC" || fail "Etc/UTC should be a valid timezone"
pass "valid IANA timezone is accepted"
if timezone_name_is_valid "../etc/passwd"; then
    fail "timezone traversal should be rejected"
fi
pass "timezone traversal is rejected"

RECORDED_COMMAND=""
run_command() {
    RECORDED_COMMAND="$*"
    return 0
}

SYSTEM_TIMEZONE=""
configure_system_timezone
[ -z "$RECORDED_COMMAND" ] || fail "unset SYSTEM_TIMEZONE should not change the host"
pass "unset SYSTEM_TIMEZONE preserves the host timezone"

SYSTEM_TIMEZONE="Etc/UTC"
configure_system_timezone
assert_contains "$RECORDED_COMMAND" "timedatectl set-timezone Etc/UTC" \
    "explicit SYSTEM_TIMEZONE is applied"

SYSTEM_TIMEZONE="../invalid"
if validate_runtime_modes > /dev/null 2>&1; then
    fail "invalid SYSTEM_TIMEZONE should fail runtime validation"
fi
pass "invalid SYSTEM_TIMEZONE fails before execution"
SYSTEM_TIMEZONE=""

SWAP_SIZE_MB="511"
if validate_runtime_modes > /dev/null 2>&1; then
    fail "SWAP_SIZE_MB below 512 should fail runtime validation"
fi
pass "invalid SWAP_SIZE_MB fails before execution"
SWAP_SIZE_MB=""

for preset in $(profile_presets); do
    preset_modules="$(profile_modules_for_preset "$preset")"
    assert_not_contains " $preset_modules " " swap " \
        "$preset keeps Swap opt-in"
    assert_not_contains "$preset_modules" "dd_reinstall" \
        "$preset excludes DD reinstall"
    assert_not_contains "$preset_modules" "clean_traces" \
        "$preset excludes trace cleaning"

    plan_output="$(PLAN_ONLY=1 INIT_PROFILE="$preset" "$TOOLKIT")"
    assert_contains "$plan_output" "$preset" "$preset plan renders safely"
done

quick_init_no_mirror="$(declare -f task_init_no_mirror)"
quick_init_with_mirror="$(declare -f task_init_with_mirror)"
custom_init="$(declare -f task_custom_init)"
assert_not_contains "$quick_init_no_mirror" "action_optimize_system" \
    "standard init leaves broad sysctl tuning opt-in"
assert_not_contains "$quick_init_no_mirror" "action_configure_swap" \
    "standard init leaves Swap opt-in"
assert_not_contains "$quick_init_with_mirror" "action_optimize_system" \
    "mirror init leaves broad sysctl tuning opt-in"
assert_not_contains "$quick_init_with_mirror" "action_configure_swap" \
    "mirror init leaves Swap opt-in"
assert_contains "$custom_init" "action_optimize_system" \
    "custom init still exposes sysctl tuning"
assert_contains "$custom_init" "action_configure_swap" \
    "custom init still exposes Swap"

if validate_profile_modules "essentials dd_reinstall" > /dev/null 2>&1; then
    fail "DD reinstall should be rejected from custom profiles"
fi
pass "custom profiles reject DD reinstall"
if validate_profile_modules "essentials clean_traces" > /dev/null 2>&1; then
    fail "trace cleaning should be rejected from custom profiles"
fi
pass "custom profiles reject trace cleaning"

advanced_menu="$(declare -f show_advanced_menu)"
profile_runner="$(declare -f run_profile_module)"
dd_action="$(declare -f action_dd_reinstall)"
trace_action="$(declare -f action_clean_traces)"
assert_contains "$advanced_menu" "action_dd_reinstall" \
    "DD reinstall remains in the Advanced menu"
assert_contains "$advanced_menu" "action_clean_traces" \
    "trace cleaning remains in the Advanced menu"
assert_not_contains "$profile_runner" "action_dd_reinstall" \
    "profile runner cannot invoke DD reinstall"
assert_not_contains "$profile_runner" "action_clean_traces" \
    "profile runner cannot invoke trace cleaning"
assert_contains "$dd_action" "confirm_dd" \
    "DD reinstall retains its typed install confirmation"
assert_contains "$dd_action" "confirm_dangerous_action" \
    "DD reinstall retains its final typed confirmation"
assert_contains "$trace_action" "confirm_dangerous_action" \
    "trace cleaning retains its typed confirmation"

safe_target="$TEST_TMP/validated.conf"
printf '%s\n' "known-good" > "$safe_target"
if write_file_atomic "$safe_target" "fault injection" 600 0 0 \
    validate_nonempty_text_candidate > /dev/null 2>&1 <<'EOF'
EOF
then
    fail "empty candidate should fail validation"
fi
[ "$(cat "$safe_target")" = "known-good" ] || \
    fail "failed validation should preserve the original file"
pass "failed atomic validation preserves the original file"

printf '1..%d\n' "$TEST_COUNT"
