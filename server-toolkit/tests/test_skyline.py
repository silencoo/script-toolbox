#!/usr/bin/env python3
"""Skyline integration tests: never install software or change networking."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'


class SkylineTest(unittest.TestCase):
    def shell(self, code, status=0):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                ['bash', '-c', 'source "$1"\nLOG_FILE="$2/log"\n' + code,
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
        output = self.shell('''
REMOTE_SCRIPT_SHA256=original
SKYLINE_SHA256=original
run_remote_script() {
    echo "PIN:$REMOTE_SCRIPT_SHA256 ARCHIVE:$SKYLINE_SHA256"
    printf '<%s>\\n' "$@"
}
skyline_bootstrap --check
printf 'AFTER:%s:%s\\n' "$REMOTE_SCRIPT_SHA256" "$SKYLINE_SHA256"
''')
        self.assertIn('PIN:cede45a8', output)
        self.assertIn('ARCHIVE:fda35f0c', output)
        self.assertIn('<--ref>\n<1f2e700aaa8f6c4e00d27a5c708f4945c81db5e5>', output)
        self.assertIn('<--check>', output)
        self.assertIn('AFTER:original:original', output)

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
skyline_bootstrap() { printf 'ARGS:%s\\n' "$*"; }
action_skyline_uninstall restore
action_skyline_uninstall bbr
''')
        self.assertNotIn('UNEXPECTED', output)
        self.assertIn('ARGS:--uninstall --restore-pre-install', output)
        self.assertIn('ARGS:--uninstall\n', output)

    def test_bbr_writers_block_active_skyline(self):
        for action in ('action_enable_bbr', 'action_optimize_system', 'action_sysctl_presets'):
            with self.subTest(action=action):
                output = self.shell('''
sysctl() { echo skyline_cc; }
modprobe() { echo UNEXPECTED; }
write_file_atomic() { echo UNEXPECTED; }
''' + action, 1)
                self.assertNotIn('UNEXPECTED', output)
                self.assertIn('Remove Skyline', output)


if __name__ == '__main__':
    unittest.main()
