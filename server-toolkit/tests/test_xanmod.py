#!/usr/bin/env python3
"""XanMod menu regressions, with all installation operations mocked."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'
MOCK_INSTALL = r'''
id() { echo 0; }
confirm_dangerous_action() { return 0; }
confirm_external_resource() { return 0; }
xanmod_host_preflight() { return 0; }
xanmod_detect_suite() { echo trixie; }
xanmod_running_package() { echo linux-image-6.12-test; }
grep() { return 1; }
install_packages_batch() { echo DEPS; }
download_and_verify_sha256() { printf 'KEY:%s:%s\n' "$1" "$2"; echo KEYDATA > "$3"; }
write_file_atomic() { echo "WRITE:$1"; cat; }
update_apt_once() { echo UPDATE; }
run_command() { shift; printf 'CMD:%s\n' "$*"; }
'''


class XanmodTest(unittest.TestCase):
    def shell(self, code, status=0):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(['bash', '-c', 'source "$1"\nLOG_FILE="$2/log"\n' + code,
                                     'test', str(TOOLKIT), tmp], text=True, capture_output=True,
                                    env=dict(os.environ, TOOLKIT_LANG='en', TOOLKIT_EFFECTIVE_LANG='en',
                                             NON_INTERACTIVE='1', DRY_RUN='0', ALLOW_DANGEROUS='0'),
                                    timeout=10)
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_suite_allowlist(self):
        self.shell('''
xanmod_suite debian bookworm || exit 2
xanmod_suite ubuntu noble || exit 3
if xanmod_suite ubuntu jammy; then exit 4; fi
if xanmod_suite debian 'trixie main extra'; then exit 5; fi
if xanmod_suite fedora trixie; then exit 6; fi
''')

    def test_dry_run_no_host_checks_or_writes(self):
        output = self.shell(MOCK_INSTALL + '''
DRY_RUN=1
xanmod_host_preflight() { echo UNEXPECTED; return 1; }
action_install_xanmod
''')
        self.assertIn('DRY RUN', output)
        for marker in ('UNEXPECTED', 'CMD:', 'WRITE:', 'KEY:', 'DEPS'):
            self.assertNotIn(marker, output)

    def test_confirmation_denial(self):
        output = self.shell(MOCK_INSTALL + '''
confirm_dangerous_action() { return 1; }
action_install_xanmod
''', 1)
        self.assertNotIn('WRITE:', output)
        self.assertNotIn('DEPS', output)

    def test_unsupported_host_stops_before_changes(self):
        output = self.shell(MOCK_INSTALL + '''
xanmod_host_preflight() { return 1; }
action_install_xanmod
''', 1)
        self.assertNotIn('DEPS', output)

    def test_arm_host_rejected(self):
        self.shell('uname() { case "$1" in -s) echo Linux;; -m) echo aarch64;; esac; }; xanmod_host_preflight', 1)

    def test_container_rejected(self):
        self.shell('''
uname() { case "$1" in -s) echo Linux;; -m) echo x86_64;; esac; }
dpkg() { echo amd64; }
systemd-detect-virt() { return 0; }
xanmod_host_preflight
''', 1)

    def test_key_mismatch_stops_repo_and_install(self):
        output = self.shell(MOCK_INSTALL + '''
download_and_verify_sha256() { return 1; }
action_install_xanmod
''', 1)
        self.assertNotIn('WRITE:', output)
        self.assertNotIn('CMD:', output)

    def test_existing_source_is_not_overwritten(self):
        output = self.shell(MOCK_INSTALL + '''
grep() { return 0; }
action_install_xanmod
''', 1)
        self.assertNotIn('WRITE:', output)
        self.assertNotIn('DEPS', output)

    def test_install_keeps_kernel_scopes_repo_and_never_reboots(self):
        output = self.shell(MOCK_INSTALL + 'action_install_xanmod')
        self.assertIn('ed26eb39330fd296cd037b8229adccea0197b21989ec0a1ad4f4f74f5a41c7a7', output)
        self.assertIn('signed-by=/etc/apt/keyrings/toolkit-xanmod.asc', output)
        self.assertIn('https://deb.xanmod.org trixie main', output)
        self.assertIn('Pin-Priority: -1', output)
        self.assertIn('CMD:apt-mark manual linux-image-6.12-test', output)
        self.assertIn('--no-remove --simulate install linux-xanmod-lts-x64v1', output)
        self.assertIn('--no-remove -y install linux-xanmod-lts-x64v1', output)
        self.assertNotIn('CMD:reboot', output)
        self.assertNotIn('CMD:sysctl', output)

    def test_simulation_failure_stops_install(self):
        output = self.shell(MOCK_INSTALL + '''
run_command() { echo "CMD:$*"; case "$*" in *--simulate*) return 42;; esac; }
action_install_xanmod
''', 1)
        self.assertNotIn('--no-remove -y install', output)
        self.assertNotIn('packages installed;', output)

    def test_post_reboot_status(self):
        self.shell('uname() { echo 6.18-xanmod1; }; sysctl() { echo bbr; }; action_xanmod_status')
        self.shell('uname() { echo 6.12-stock; }; sysctl() { echo bbr; }; action_xanmod_status', 1)
        self.shell('uname() { echo 6.18-xanmod1; }; sysctl() { echo skyline_cc; }; action_xanmod_status', 1)

    def test_built_in_bbr_does_not_require_module(self):
        output = self.shell('''
skyline_require_uninstalled() { return 0; }
COUNT=0
sysctl() { case "$*" in *tcp_available*) echo 'cubic bbr';; *) echo cubic;; esac; }
modprobe() { echo UNEXPECTED; return 1; }
write_file_atomic() { cat >/dev/null; }
run_command() { sysctl() { echo bbr; }; }
action_enable_bbr
''')
        self.assertNotIn('UNEXPECTED', output)


if __name__ == '__main__':
    unittest.main()
