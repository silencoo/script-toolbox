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
xanmod_check_sources() { return 0; }
xanmod_grub_entry() { echo 'gnulinux-advanced-root>gnulinux-6.12-test-advanced-root'; }
xanmod_verify_boot_default() { echo VERIFY_BOOT_DEFAULT; }
uname() { echo 6.12-test; }
grub-editenv() { :; }
install_packages_batch() { echo DEPS; }
download_and_verify_sha256() { printf 'KEY:%s:%s\n' "$1" "$2"; echo KEYDATA > "$3"; }
write_file_atomic() { echo "WRITE:$1 ROLLBACK:$ROLLBACK_ENABLED"; cat; }
update_apt_once() { echo UPDATE; }
run_command() { shift; printf 'CMD:%s\n' "$*"; }
'''


class XanmodTest(unittest.TestCase):
    def shell(self, code, status=0):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(['bash', '-c', 'source "$1"\nTEST_TMP="$2"\nLOG_FILE="$2/log"\ntrap cleanup_temp_files EXIT\n' + code,
                                     'test', str(TOOLKIT), tmp], text=True, capture_output=True,
                                    env=dict(os.environ, TOOLKIT_LANG='en', TOOLKIT_EFFECTIVE_LANG='en',
                                             NON_INTERACTIVE='1', DRY_RUN='0', ALLOW_DANGEROUS='0',
                                             ROLLBACK_ENABLED='true'),
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
xanmod_check_sources() { return 1; }
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
        self.assertIn("GRUB_DEFAULT='gnulinux-advanced-root>gnulinux-6.12-test-advanced-root'", output)
        self.assertIn('GRUB_SAVEDEFAULT=false', output)
        self.assertIn('WRITE:/etc/default/grub.d/99-toolkit-xanmod.cfg ROLLBACK:false', output)
        self.assertLess(output.index('VERIFY_BOOT_DEFAULT'), output.index('--no-remove -y install'))
        self.assertEqual(output.count('VERIFY_BOOT_DEFAULT'), 2)

    def test_simulation_failure_stops_install(self):
        output = self.shell(MOCK_INSTALL + '''
run_command() { echo "CMD:$*"; case "$*" in *--simulate*) return 42;; esac; }
action_install_xanmod
''', 1)
        self.assertNotIn('--no-remove -y install', output)
        self.assertNotIn('packages installed;', output)

    def test_boot_default_failure_prevents_kernel_install(self):
        for failure in ('xanmod_verify_boot_default() { return 1; }',
                        'grub-editenv() { echo next_entry=another-kernel; }',
                        'grub-editenv() { return 1; }'):
            with self.subTest(failure=failure):
                output = self.shell(MOCK_INSTALL + failure + '\naction_install_xanmod\n', 1)
                self.assertNotIn('--no-remove -y install', output)

    def test_failed_kernel_install_keeps_guard_out_of_file_rollback(self):
        output = self.shell(MOCK_INSTALL + '''
write_file_atomic() {
    cat > "$TEST_TMP/${1##*/}"
    if [ "$ROLLBACK_ENABLED" = true ]; then echo "TRACKED:$1"; fi
}
run_command() { case "$*" in *'--no-remove -y install'*) return 42;; esac; }
status=0
action_install_xanmod || status=$?
[ "$status" = 1 ]
[ "$ROLLBACK_ENABLED" = true ]
cat "$TEST_TMP/99-toolkit-xanmod.cfg"
''')
        self.assertIn('TRACKED:/etc/apt/sources.list.d/toolkit-xanmod.list', output)
        self.assertNotIn('TRACKED:/etc/default/grub.d/', output)
        self.assertIn('GRUB_DEFAULT=', output)

    def test_grub_entry_uses_exact_version_and_stable_ids(self):
        for submenu in (False, True):
            with self.subTest(submenu=submenu):
                prefix = "submenu 'Options avancées' $menuentry_id_option 'gnulinux-advanced-root' {\n" if submenu else ''
                fixture = prefix + """menuentry 'Linux newer' $menuentry_id_option 'gnulinux-6.18-xanmod-advanced-root' {
}
menuentry 'Linux current' $menuentry_id_option 'gnulinux-6.12-test-advanced-root' {
}
menuentry 'Linux recovery' $menuentry_id_option 'gnulinux-6.12-test-recovery-root' {
}
""" + ('}\n' if submenu else '')
                output = self.shell("cat > \"$TEST_TMP/grub.cfg\" <<'GRUB'\n" + fixture + "GRUB\n" + '''
xanmod_grub_entry "$TEST_TMP/grub.cfg" 6.12-test
if xanmod_grub_entry "$TEST_TMP/grub.cfg" 6.12; then exit 10; fi
''')
                self.assertEqual(output.strip(), ('gnulinux-advanced-root>' if submenu else '') +
                                 'gnulinux-6.12-test-advanced-root')

    def test_grub_verification_rejects_missing_ambiguous_or_wrong_default(self):
        self.shell(r'''
cfg="$TEST_TMP/grub.cfg"
entry=gnulinux-6.12-test-advanced-root
printf "menuentry 'Linux' \$menuentry_id_option '%s' {\n}\n" "$entry" > "$cfg"
printf 'set default="0"\n' >> "$cfg"
if xanmod_verify_boot_default 6.12-test "$entry" "$cfg"; then exit 10; fi
printf 'set default="%s"\n' "$entry" >> "$cfg"
xanmod_verify_boot_default 6.12-test "$entry" "$cfg" || exit 11
printf 'set default="0"\n' >> "$cfg"
if xanmod_verify_boot_default 6.12-test "$entry" "$cfg"; then exit 14; fi
printf "menuentry 'Duplicate' --id '%s' {\n}\n" "$entry" >> "$cfg"
if xanmod_grub_entry "$cfg" 6.12-test; then exit 12; fi
: > "$cfg"
if xanmod_grub_entry "$cfg" 6.12-test; then exit 13; fi
''')

    def test_owned_source_can_be_retried_but_operator_sources_are_rejected(self):
        self.shell(r'''
mkdir "$TEST_TMP/sources"
own="$TEST_TMP/sources/toolkit-xanmod.list"
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/toolkit-xanmod.asc] https://deb.xanmod.org trixie main' > "$own"
xanmod_check_sources trixie "$TEST_TMP/sources" "$TEST_TMP/sources.list" || exit 10
printf 'Types: deb\nURIs: https://deb.xanmod.org\n' > "$TEST_TMP/sources/custom.sources"
if xanmod_check_sources trixie "$TEST_TMP/sources" "$TEST_TMP/sources.list"; then exit 11; fi
rm "$TEST_TMP/sources/custom.sources"
printf '# operator modification\n' >> "$own"
if xanmod_check_sources trixie "$TEST_TMP/sources" "$TEST_TMP/sources.list"; then exit 12; fi
''')

    def test_failed_update_can_be_retried_with_retained_owned_source(self):
        output = self.shell('''
eval "$(declare -f xanmod_check_sources | sed '1s/xanmod_check_sources/check_real_sources/')"
''' + MOCK_INSTALL + r'''
mkdir "$TEST_TMP/sources"
xanmod_check_sources() { check_real_sources "$1" "$TEST_TMP/sources" "$TEST_TMP/sources.list"; }
write_file_atomic() {
    case "$1" in
        */toolkit-xanmod.list) cat > "$TEST_TMP/sources/toolkit-xanmod.list" ;;
        *) cat >/dev/null ;;
    esac
}
update_apt_once() { return 42; }
status=0
action_install_xanmod || status=$?
[ "$status" = 1 ]
[ -f "$TEST_TMP/sources/toolkit-xanmod.list" ]
update_apt_once() { return 0; }
action_install_xanmod
''')
        self.assertEqual(output.count('--no-remove -y install linux-xanmod-lts-x64v1'), 1)

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
