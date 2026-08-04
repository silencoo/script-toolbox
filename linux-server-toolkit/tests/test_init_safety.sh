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

APT_SOURCE_RECOVERY="invalid"
if validate_runtime_modes > /dev/null 2>&1; then
    fail "invalid APT_SOURCE_RECOVERY should fail runtime validation"
fi
pass "invalid APT_SOURCE_RECOVERY fails before execution"
APT_SOURCE_RECOVERY="prompt"

prompt_output="$(confirm_dangerous_action "测试操作" "测试说明" <<< "YES")"
assert_contains "$prompt_output" $'\033[0;31m确认执行此操作?' \
    "dangerous confirmation renders an ANSI-colored prompt"
assert_not_contains "$prompt_output" '\033[0;31m确认执行此操作?' \
    "dangerous confirmation does not print literal color escapes"

APT_SOURCES_DIR="$TEST_TMP/apt-sources"
mkdir -p "$APT_SOURCES_DIR"
ookla_source="$APT_SOURCES_DIR/ookla_speedtest-cli.list"
printf '%s\n' \
    'deb https://packagecloud.io/ookla/speedtest-cli/debian bookworm main' > "$ookla_source"
printf '%s\n' \
    'deb https://packagecloud.io/ookla/speedtest-cli/debian bookworm main' > "$APT_SOURCES_DIR/combined.list"
known_sources="$(known_ookla_apt_source_files)"
assert_contains "$known_sources" "$ookla_source" \
    "known Ookla recovery locates the dedicated official source file"
assert_not_contains "$known_sources" "$APT_SOURCES_DIR/combined.list" \
    "known Ookla recovery does not disable an arbitrary combined source file"

printf '%s\n' \
    'E: Failed to fetch https://packagecloud.io/ookla/speedtest-cli/debian/dists/bookworm/InRelease 402 Payment Required' \
    'unrelated later log line' > "$LOG_FILE"
if apt_update_log_has_known_ookla_failure 2; then
    fail "APT recovery should ignore failures from an older log segment"
fi
pass "APT recovery scopes diagnosis to the current apt update attempt"
printf '%s\n' \
    "E: The repository 'https://packagecloud.io/ookla/speedtest-cli/debian bookworm InRelease' is no longer signed." \
    >> "$LOG_FILE"
apt_update_log_has_known_ookla_failure 3 || fail "current Ookla failure should be recognized"
pass "APT recovery recognizes the current Ookla 402/signature failure"

(
    APT_SOURCE_RECOVERY="auto-known"
    NON_INTERACTIVE=1
    DRY_RUN=0
    BACKUP_DIR="$TEST_TMP/apt-backups"
    OPERATION_HISTORY=()
    OPERATION_TARGETS=()
    OPERATION_BACKUPS=()
    OPERATION_DESCRIPTIONS=()
    OPERATION_TYPES=()
    quarantine_known_ookla_apt_sources
)
[ ! -e "$ookla_source" ] || fail "known broken Ookla source was not quarantined"
disabled_ookla_source="$(find "$APT_SOURCES_DIR" -maxdepth 1 -type f \
    -name 'ookla_speedtest-cli.list.disabled-by-init-*.save' -print -quit)"
[ -n "$disabled_ookla_source" ] || fail "quarantined Ookla source was not preserved"
pass "auto-known recovery preserves the source with an APT-silent suffix"

fake_apt_bin="$TEST_TMP/fake-apt-bin"
mkdir -p "$fake_apt_bin"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$2" in' \
    '  available) printf "  Candidate: 1.2.3\\n" ;;' \
    '  missing) printf "  Candidate: (none)\\n" ;;' \
    'esac' > "$fake_apt_bin/apt-cache"
chmod +x "$fake_apt_bin/apt-cache"
PATH="$fake_apt_bin:$PATH" apt_package_has_candidate available || \
    fail "available APT package candidate should be accepted"
pass "APT candidate detection accepts an available package"
if PATH="$fake_apt_bin:$PATH" apt_package_has_candidate missing; then
    fail "missing APT package candidate should be rejected"
fi
pass "APT candidate detection rejects a package without a candidate"

fake_shell_bin="$TEST_TMP/fake-shell-bin"
mkdir -p "$fake_shell_bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$fake_shell_bin/zsh"
chmod +x "$fake_shell_bin/zsh"
test_shells_file="$TEST_TMP/shells"
printf '%s\n' "$fake_shell_bin/zsh" > "$test_shells_file"
original_shells_file="$LOGIN_SHELLS_FILE"
LOGIN_SHELLS_FILE="$test_shells_file"
resolved_zsh="$(PATH="$fake_shell_bin:$PATH" resolve_zsh_login_shell)"
[ "$resolved_zsh" = "$fake_shell_bin/zsh" ] || \
    fail "Zsh resolver did not select the registered executable"
pass "Zsh login-shell resolution requires an executable registered in /etc/shells"
: > "$test_shells_file"
if PATH="$fake_shell_bin:$PATH" resolve_zsh_login_shell > /dev/null; then
    fail "Zsh resolver accepted an executable absent from the shell registry"
fi
pass "Zsh login-shell resolution rejects an unregistered executable"
LOGIN_SHELLS_FILE="$original_shells_file"

original_resolve_zsh_login_shell="$(declare -f resolve_zsh_login_shell)"
test_login_shell="/bin/bash"
getent() {
    [ "$1" = "passwd" ] || return 1
    printf 'shell-test:x:1000:1000::/home/shell-test:%s\n' "$test_login_shell"
}
resolve_zsh_login_shell() {
    printf '%s\n' /bin/zsh
}
usermod() {
    [ "$1" = "--shell" ] || return 1
    test_login_shell="$2"
}
set_user_login_shell_to_zsh shell-test > /dev/null || \
    fail "verified login-shell change should succeed"
[ "$test_login_shell" = "/bin/zsh" ] || fail "login-shell changer did not target Zsh"
pass "login-shell change is applied and verified"
test_login_shell="/bin/bash"
usermod() {
    return 0
}
if set_user_login_shell_to_zsh shell-test > /dev/null 2>&1; then
    fail "unapplied login-shell change should fail verification"
fi
pass "login-shell change cannot report success without passwd verification"
unset -f getent usermod
eval "$original_resolve_zsh_login_shell"

zshrc_block="$(terminal_zshrc_block)"
assert_contains "$zshrc_block" '[[ -r "$ZSH/oh-my-zsh.sh" ]]' \
    "generated zshrc guards Oh My Zsh loading"
assert_contains "$zshrc_block" 'command -v starship' \
    "generated zshrc guards Starship initialization"
assert_contains "$zshrc_block" 'command -v uv' \
    "generated zshrc guards uv completion"
assert_contains "$zshrc_block" '$HOME/.cargo/bin' \
    "generated zshrc includes user Cargo binaries"
assert_not_contains "$zshrc_block" $'\nsource $ZSH/oh-my-zsh.sh' \
    "generated zshrc has no unconditional Oh My Zsh source"

remote_policy_dest="$TEST_TMP/remote-policy-script"
(
    confirm_remote_script_execution() { return 0; }
    remote_script_expected_sha256() { return 1; }
    fetch_file() { printf '%s\n' '#!/bin/sh' 'exit 0' > "$2"; }
    NON_INTERACTIVE=0
    ALLOW_UNVERIFIED_REMOTE=0
    download_remote_script_with_policy allow-unverified \
        https://example.test/install.sh "$remote_policy_dest" "测试安装器" > /dev/null
) || fail "interactive typed confirmation should authorize an explicitly allowed unpinned installer"
pass "interactive confirmation does not require ALLOW_UNVERIFIED_REMOTE"
(
    confirm_remote_script_execution() { return 0; }
    remote_script_expected_sha256() { return 1; }
    fetch_file() { printf '%s\n' '#!/bin/sh' 'exit 0' > "$2"; }
    NON_INTERACTIVE=1
    ALLOW_DANGEROUS=1
    ALLOW_UNVERIFIED_REMOTE=0
    ! download_remote_script_with_policy allow-unverified \
        https://example.test/install.sh "$remote_policy_dest" "测试安装器" > /dev/null 2>&1
) || fail "non-interactive unpinned installer should require its explicit opt-in"
pass "non-interactive unpinned installer still requires ALLOW_UNVERIFIED_REMOTE"
(
    confirm_remote_script_execution() { return 0; }
    remote_script_expected_sha256() { return 1; }
    fetch_file() { printf '%s\n' '#!/bin/sh' 'exit 0' > "$2"; }
    NON_INTERACTIVE=1
    ALLOW_DANGEROUS=0
    ALLOW_UNVERIFIED_REMOTE=1
    ! download_remote_script_with_policy allow-unverified \
        https://example.test/install.sh "$remote_policy_dest" "测试安装器" > /dev/null 2>&1
) || fail "non-interactive unpinned installer should retain dangerous-action opt-in"
pass "non-interactive unpinned installer still requires ALLOW_DANGEROUS"

terminal_action_source="$(declare -f action_install_terminal_tools)"
assert_contains "$terminal_action_source" \
    'run_remote_script_as_user_unverified_sh "https://starship.rs/install.sh"' \
    "Starship installer uses its required POSIX shell"
assert_contains "$terminal_action_source" \
    'run_remote_script_as_user_unverified_sh "https://astral.sh/uv/install.sh"' \
    "uv installer uses POSIX shell"
assert_contains "$terminal_action_source" \
    'run_remote_script_as_user_unverified_sh' \
    "terminal upstream installers use the explicit POSIX runner"
if run_remote_script_as_user_with_policy_interpreter \
    allow-unverified python https://example.test/install.py "不支持的解释器" > /dev/null 2>&1; then
    fail "remote script runner should reject an unsupported interpreter"
fi
pass "remote script runner restricts interpreter selection"

SWAP_SIZE_MB="511"
if validate_runtime_modes > /dev/null 2>&1; then
    fail "SWAP_SIZE_MB below 512 should fail runtime validation"
fi
pass "invalid SWAP_SIZE_MB fails before execution"
SWAP_SIZE_MB=""

baseline_modules="$(profile_baseline_modules)"
for preset in $(profile_presets); do
    preset_modules="$(profile_modules_for_preset "$preset")"
    for baseline_module in $baseline_modules; do
        assert_contains " $preset_modules " " $baseline_module " \
            "$preset includes baseline module $baseline_module"
    done
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

for preset_choice in 1 2 3; do
    preset_content="$(sysctl_preset_content "$preset_choice")"
    assert_contains "$preset_content" "net.core.default_qdisc = fq" \
        "sysctl preset $preset_choice enables fq"
    assert_contains "$preset_content" "net.ipv4.tcp_congestion_control = bbr" \
        "sysctl preset $preset_choice enables BBR"
done
if sysctl_preset_content 4 > /dev/null 2>&1; then
    fail "unknown sysctl preset should be rejected"
fi
pass "unknown sysctl preset is rejected"

assert_contains "$(network_family_status '192.0.2.10/24' 'default via 192.0.2.1' '1.1.1.1 via 192.0.2.1' '203.0.113.8')" \
    "正常" "network status accepts a working public egress"
assert_contains "$(network_family_status '' '' '' '')" \
    "未配置" "network status distinguishes an unconfigured address family"
assert_contains "$(network_family_status '2001:db8::10/64' '' '' '')" \
    "缺少默认路由" "network status detects a missing default route"
assert_contains "$(network_family_status '2001:db8::10/64' 'default via fe80::1' 'RTNETLINK answers: Network is unreachable' '')" \
    "无法选路" "network status detects an unusable route"
assert_contains "$(network_family_status '2001:db8::10/64' 'default via fe80::1' '2606:4700:4700::1111 via fe80::1' '')" \
    "出口失败" "network status detects a broken routed egress"
main_action="$(declare -f main)"
assert_contains "$main_action" "NETWORK_DIAGNOSTIC_ONLY=1" \
    "main exposes direct network diagnostic mode"
assert_contains "$main_action" "check_network" \
    "direct network diagnostic mode invokes the read-only helper"
direct_network_output="$(
    check_network() { printf '%s' 'direct-network-ok'; }
    check_root() { printf '%s' 'unexpected-root-check'; return 1; }
    main --network
)"
assert_contains "$direct_network_output" "direct-network-ok" \
    "direct network diagnostic runs without the interactive menu"
assert_not_contains "$direct_network_output" "unexpected-root-check" \
    "direct network diagnostic does not require root"

assert_contains "$(overview_ssh_auth_summary yes no no)" "仅公钥认证" \
    "system overview identifies public-key-only SSH"
assert_contains "$(overview_ssh_auth_summary yes yes no)" "均允许" \
    "system overview identifies mixed SSH authentication"
assert_contains "$(overview_ssh_auth_summary no yes no)" "仅密码" \
    "system overview identifies password-only SSH"
assert_contains "$(overview_ssh_auth_summary N/A N/A N/A)" "无法完整读取" \
    "system overview does not misclassify unreadable SSH settings"

overview_action="$(declare -f action_system_overview)"
assert_contains "$overview_action" "UTC 时间" \
    "system overview includes UTC time"
assert_contains "$overview_action" "TCP 拥塞控制" \
    "system overview includes network optimization state"
assert_contains "$overview_action" "Runtime / 工具版本" \
    "system overview includes runtime versions"
assert_not_contains "$overview_action" "cat *authorized_keys" \
    "system overview does not print authorized_keys"

direct_overview_output="$(
    action_system_overview() { printf '%s' 'direct-overview-ok'; }
    check_root() { printf '%s' 'unexpected-root-check'; return 1; }
    main --overview
)"
assert_contains "$direct_overview_output" "direct-overview-ok" \
    "direct system overview runs without the interactive menu"
assert_not_contains "$direct_overview_output" "unexpected-root-check" \
    "direct system overview does not require root"

native_aaaa_records="$(
    dig() {
        printf '%s\n' '::ffff:104.16.123.96' '2606:4700::6810:7b60'
    }
    network_dns_records 6 example.com
)"
assert_contains "$native_aaaa_records" "2606:4700::6810:7b60" \
    "AAAA inspection retains native IPv6 records"
assert_not_contains "$native_aaaa_records" "::ffff:" \
    "AAAA inspection ignores synthesized IPv4-mapped addresses"

broken_ipv6_diagnostic="$(
    network_global_addresses() {
        [ "$1" = "4" ] && printf '%s' '192.0.2.10/24 (eth0)' || printf '%s' '2001:db8::10/64 (eth0)'
    }
    network_default_route() {
        [ "$1" = "4" ] && printf '%s' 'default via 192.0.2.1 dev eth0' || printf '%s' 'default via fe80::1 dev eth0'
    }
    network_route_probe() {
        [ "$1" = "4" ] && printf '%s' '1.1.1.1 via 192.0.2.1 dev eth0' || printf '%s' '2606:4700:4700::1111 via fe80::1 dev eth0'
    }
    network_fetch_public_ip() {
        [ "$1" = "4" ] && printf '%s' '203.0.113.8' || return 1
    }
    network_dns_records() {
        [ "$1" = "4" ] && printf '%s' '104.16.123.96' || printf '%s' '2606:4700::6810:7b60'
    }
    network_resolvers() { printf '%s' '2001:4860:4860::8888'; }
    curl() { printf '%s' '200 0.050 198.51.100.10'; }
    log() { :; }
    check_network 2>&1
)"
assert_contains "$broken_ipv6_diagnostic" "路由存在但出口失败" \
    "dual-stack diagnostic identifies a broken IPv6 egress"
assert_contains "$broken_ipv6_diagnostic" "DNS 返回 AAAA" \
    "dual-stack diagnostic warns about AAAA with broken IPv6"
assert_contains "$broken_ipv6_diagnostic" "IPv6 DNS 解析器" \
    "dual-stack diagnostic warns about an IPv6 resolver on broken egress"

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
