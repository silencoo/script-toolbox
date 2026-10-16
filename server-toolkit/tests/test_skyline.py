#!/usr/bin/env python3
"""Skyline integration tests: never install software or change networking."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'
BOOTSTRAP_MOCK = r'''
skyline_use_pinned_release() { return 0; }
download_remote_script() {
    echo "PIN:$REMOTE_SCRIPT_SHA256 ARCHIVE:$SKYLINE_SHA256"
    cat > "$2" <<'SH'
printf 'EXEC:'; printf '<%s>' "$@"; printf '\n'
printf 'ARTIFACT:%s\n' "${SKYLINE_ARTIFACT_URL:-none}"
if [ -n "${SKYLINE_ARTIFACT_URL:-}" ]; then
    test -f "$SKYLINE_ARTIFACT_URL" || exit 8
    cat "$SKYLINE_ARTIFACT_URL.sha256"
fi
exit "${MOCK_BOOTSTRAP_EXIT:-0}"
SH
}
download_and_verify_sha256() {
    printf 'DOWNLOAD:%s SHA:%s\n' "$1" "$2"
    printf artifact > "$3"
}
'''


class SkylineTest(unittest.TestCase):
    def shell(self, code, status=0):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                ['bash', '-c', 'source "$1"\nTEST_TMP="$2"\nLOG_FILE="$2/log"\n' + code,
                 'test', str(TOOLKIT), tmp], text=True, capture_output=True,
                env=dict(os.environ, TOOLKIT_LANG='en', TOOLKIT_EFFECTIVE_LANG='en',
                         NON_INTERACTIVE='1', DRY_RUN='0', ALLOW_EXTERNAL='0',
                         ALLOW_REMOTE_EXEC='0', ALLOW_DANGEROUS='0'), timeout=10)
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_kernel_floor(self):
        self.shell('''
for v in 6.12.0 6.18.42-custom 7.1.6; do skyline_kernel_supported "$v" || exit 10; done
for v in 5.15.0 6.1.180 6.6.148 6.11.9 garbage; do
    if skyline_kernel_supported "$v"; then exit 11; fi
done
''')

    def test_pins_and_forwarded_arguments_are_scoped(self):
        output = self.shell(BOOTSTRAP_MOCK + '''
REMOTE_SCRIPT_SHA256=original
SKYLINE_SHA256=original
export SKYLINE_ARTIFACT_URL=untrusted
skyline_bootstrap --check
printf 'AFTER:%s:%s:%s\\n' "$REMOTE_SCRIPT_SHA256" "$SKYLINE_SHA256" "$SKYLINE_ARTIFACT_URL"
''')
        self.assertIn('PIN:cede45a8', output)
        self.assertIn('ARCHIVE:fda35f0c', output)
        self.assertIn('<--ref><1f2e700aaa8f6c4e00d27a5c708f4945c81db5e5>', output)
        self.assertIn('<--release><v0.5.2>', output)
        self.assertIn('<--check>', output)
        self.assertIn('AFTER:original:original:untrusted', output)
        self.assertIn('ARTIFACT:none', output)
        self.assertNotIn('DOWNLOAD:', output)

    def test_release_artifact_is_verified_and_cleaned_up(self):
        output = self.shell(BOOTSTRAP_MOCK + 'skyline_bootstrap\n')
        self.assertIn('releases/download/v0.5.2/skyline-speeder-v0.5.2-x86_64.tar.gz', output)
        self.assertIn('SHA:23cda4337c5b03f52a8bada9183a5dd2b6475ec0e7c6fabf3e885e8a9446963b', output)
        self.assertLess(output.index('DOWNLOAD:'), output.index('EXEC:'))
        artifact = next(line.removeprefix('ARTIFACT:') for line in output.splitlines()
                        if line.startswith('ARTIFACT:'))
        self.assertFalse(Path(artifact).parent.exists())

    def test_artifact_mismatch_prevents_execution(self):
        output = self.shell(BOOTSTRAP_MOCK + '''
download_and_verify_sha256() { echo MISMATCH; return 1; }
skyline_bootstrap
''', 1)
        self.assertIn('MISMATCH', output)
        self.assertNotIn('EXEC:', output)

    def test_unsupported_binary_platform_uses_pinned_source(self):
        output = self.shell(BOOTSTRAP_MOCK + '''
export SKYLINE_ARTIFACT_URL=untrusted
skyline_use_pinned_release() { return 1; }
skyline_bootstrap
''')
        self.assertIn('<--source>', output)
        self.assertIn('ARTIFACT:none', output)
        self.assertNotIn('DOWNLOAD:', output)
        self.assertNotIn('<--release>', output)

    def test_bootstrap_failure_propagates(self):
        self.shell(BOOTSTRAP_MOCK + 'export MOCK_BOOTSTRAP_EXIT=42\nskyline_bootstrap\n', 42)

    def test_artifact_platform_selection(self):
        self.shell('''
uname() { echo x86_64; }
getconf() { echo 'glibc 2.39'; }
dpkg() { [ "$*" = '--compare-versions 2.39 ge 2.39' ]; }
skyline_use_pinned_release || exit 1
uname() { echo aarch64; }
if skyline_use_pinned_release; then exit 2; fi
uname() { echo x86_64; }
getconf() { echo 'glibc 2.36'; }
if skyline_use_pinned_release; then exit 3; fi
getconf() { return 1; }
if skyline_use_pinned_release; then exit 4; fi
''')

    def test_install_failure_propagates(self):
        self.shell('''
confirm_dangerous_action() { return 0; }
skyline_preflight() { return 0; }
skyline_bootstrap() { return 42; }
action_skyline_install
''', 42)

    def test_preflight_failure_blocks_download(self):
        output = self.shell('''
confirm_dangerous_action() { return 0; }
skyline_preflight() { return 1; }
skyline_bootstrap() { echo UNEXPECTED; }
action_skyline_install
''', 1)
        self.assertNotIn('UNEXPECTED', output)

    def test_denied_confirmation_blocks_install(self):
        output = self.shell('''
confirm_dangerous_action() { return 1; }
skyline_bootstrap() { echo UNEXPECTED; }
action_skyline_install
''', 1)
        self.assertNotIn('UNEXPECTED', output)

    def test_dry_run_never_downloads_or_checks_host(self):
        output = self.shell('''
DRY_RUN=1
confirm_dangerous_action() { return 0; }
skyline_preflight() { echo UNEXPECTED; return 1; }
fetch_file() { echo UNEXPECTED; return 1; }
action_skyline_install && action_skyline_check && action_skyline_uninstall
''')
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('DRY RUN', output)

    def test_remote_policy_still_denies_unattended_execution(self):
        output = self.shell('''
fetch_file() { echo UNEXPECTED; return 1; }
skyline_bootstrap --check
''', 1)
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('denied', output)

    def test_uninstall_modes_skip_kernel_preflight(self):
        output = self.shell('''
confirm_dangerous_action() { return 0; }
skyline_preflight() { echo UNEXPECTED; return 1; }
skyline_local_installer() { return 1; }
skyline_bootstrap() { printf 'ARGS:%s\\n' "$*"; }
action_skyline_uninstall restore
action_skyline_uninstall bbr
''')
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('ARGS:--uninstall --restore-pre-install', output)
        self.assertIn('ARGS:--uninstall\n', output)

    def test_local_uninstall_is_offline_and_preserves_modes(self):
        output = self.shell(r'''
confirm_dangerous_action() { return 0; }
skyline_preflight() { echo UNEXPECTED; return 1; }
skyline_bootstrap() { echo UNEXPECTED; return 1; }
cat > "$TEST_TMP/install.sh" <<'SH'
#!/bin/bash
printf 'LOCAL:%s\n' "$*"
exit "${LOCAL_EXIT:-0}"
SH
chmod +x "$TEST_TMP/install.sh"
skyline_local_installer() { echo "$TEST_TMP/install.sh"; }
action_skyline_uninstall restore
action_skyline_uninstall bbr
export LOCAL_EXIT=42
status=0
action_skyline_uninstall || status=$?
[ "$status" = 42 ]
DRY_RUN=1 action_skyline_uninstall
''')
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('LOCAL:--uninstall --restore-pre-install', output)
        self.assertIn('LOCAL:--uninstall\n', output)
        self.assertEqual(output.count('LOCAL:'), 3)

    def test_bbr_enable_still_blocks_active_skyline(self):
        output = self.shell('''
sysctl() { echo skyline_cc; }
modprobe() { echo UNEXPECTED; }
write_file_atomic() { echo UNEXPECTED; }
action_enable_bbr
''', 1)
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('Remove Skyline', output)

    def test_tuning_preserves_skyline_and_loads_only_its_own_file(self):
        for action in ('action_optimize_system', 'action_sysctl_presets'):
            for preset in ('1', '2', '3') if action == 'action_sysctl_presets' else ('1',):
                with self.subTest(action=action, preset=preset):
                    output = self.shell('''
sysctl() { echo skyline_cc; }
modprobe() { echo UNEXPECTED; return 1; }
write_file_atomic() { cat; }
ensure_block_in_file() { :; }
run_command() { shift; printf 'APPLY:%s\\n' "$*"; }
ui_read() { printf -v "$1" '%s' ''' + preset + '; }\n' + action)
                    self.assertNotIn('UNEXPECTED', output)
                    self.assertNotIn('net.core.default_qdisc', output)
                    self.assertNotIn('net.ipv4.tcp_congestion_control', output)
                    self.assertNotIn('--system', output)
                    self.assertIn('net.core.somaxconn =', output)
                    self.assertIn('APPLY:sysctl -p /etc/sysctl.d/99-init-', output)

    def test_tuning_without_skyline_keeps_bbr_settings(self):
        for action in ('action_optimize_system', 'action_sysctl_presets'):
            with self.subTest(action=action):
                output = self.shell('''
skyline_is_installed() { return 1; }
sysctl() { case "$*" in *default_qdisc*) echo fq;; *) echo bbr;; esac; }
modprobe() { return 0; }
write_file_atomic() { cat; }
ensure_block_in_file() { :; }
run_command() { :; }
ui_read() { printf -v "$1" '%s' 1; }
''' + action)
                self.assertIn('net.core.default_qdisc = fq', output)
                self.assertIn('net.ipv4.tcp_congestion_control = bbr', output)

    def test_custom_init_continues_after_tuning_on_skyline(self):
        output = self.shell('''
set +u # macOS Bash 3 cannot expand empty ledger arrays under nounset.
sysctl() { echo skyline_cc; }
ui_clear_screen() { :; }
ui_read() { printf -v "$1" '%s' '3 4 5 6'; }
write_file_atomic() { cat >/dev/null; }
ensure_block_in_file() { :; }
run_command() { :; }
action_configure_swap() { echo REACHED:swap; }
action_configure_ssh() { echo REACHED:ssh; }
action_configure_firewall() { echo REACHED:firewall; }
task_custom_init <<'INPUT'
y
n
INPUT
''')
        self.assertEqual([line for line in output.splitlines() if line.startswith('REACHED:')],
                         ['REACHED:swap', 'REACHED:ssh', 'REACHED:firewall'])


if __name__ == '__main__':
    unittest.main()
