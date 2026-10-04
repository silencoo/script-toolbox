#!/usr/bin/env python3
"""Check system-wide terminfo installation without APT or privileged writes."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'


class TerminfoTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-terminfo-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def shell(self, code, status=0):
        prefix = r'''source "$1"
TEST_TMP="$2"
LOG_FILE="$TEST_TMP/toolkit.log"
trap cleanup_temp_files EXIT
install_packages_batch() { printf 'PACKAGES:%s\n' "$*"; }
# Direct system lookups and writes into an isolated database. Keep the real
# compiler and decoder so malformed entries cannot pass these tests.
toolkit_system_terminfo_supported() {
    infocmp -x -A "$TEST_TMP/system" "$1" >/dev/null 2>&1
}
write_file_atomic() {
    [ "$3 $4 $5" = '644 0 0' ] || return 1
    local destination="$TEST_TMP/system/${1#/usr/share/terminfo/}"
    mkdir -p "$(dirname "$destination")" || return 1
    cat > "$destination" || return 1
    chmod "$3" "$destination" || return 1
    printf 'INSTALLED:%s\n' "$1"
}
'''
        child = subprocess.run(
            ['bash', '-c', prefix + code, 'terminfo-test', str(TOOLKIT), str(self.root)],
            capture_output=True, text=True, timeout=15,
            env=dict(os.environ, DRY_RUN='0', NON_INTERACTIVE='1', TOOLKIT_LANG='en'))
        self.assertEqual(child.returncode, status, child.stdout + child.stderr)
        return child.stdout + child.stderr

    def test_full_package_set_is_installed_even_when_ghostty_exists(self):
        output = self.shell('''toolkit_system_terminfo_supported() { return 0; }
tic() { echo UNEXPECTED_COMPILE; return 1; }
install_terminal_terminfo
''')
        self.assertIn('PACKAGES:ncurses-base ncurses-bin ncurses-term kitty-terminfo', output)
        self.assertNotIn('UNEXPECTED_COMPILE', output)
        self.assertNotIn('INSTALLED:', output)

    def test_user_only_entry_is_not_system_support(self):
        # Restore the production lookup and simulate infocmp succeeding only
        # when it is allowed to search the user's database.
        output = self.shell(r'''source "$1"
infocmp() {
    printf 'PROBE:%s\n' "$*" >> "$TEST_TMP/probes"
    case " $* " in *' -A '*) return 1;; *) return 0;; esac
}
if toolkit_system_terminfo_supported xterm-ghostty; then exit 9; fi
cat "$TEST_TMP/probes"
''')
        for directory in ('/etc/terminfo', '/lib/terminfo', '/usr/share/terminfo'):
            self.assertIn(f'PROBE:-x -A {directory} xterm-ghostty', output)

    def test_dry_run_never_creates_or_compiles_entries(self):
        output = self.shell('''DRY_RUN=1
toolkit_system_terminfo_supported() { return 1; }
mktemp() { echo UNEXPECTED_TEMPFILE; return 1; }
tic() { echo UNEXPECTED_COMPILE; return 1; }
install_terminal_terminfo
''')
        self.assertIn('[DRY RUN]', output)
        self.assertNotIn('UNEXPECTED_', output)
        self.assertNotIn('INSTALLED:', output)
        self.assertFalse((self.root / 'system').exists())

    def test_package_failure_stops_before_compilation(self):
        output = self.shell('''install_packages_batch() { return 7; }
tic() { echo UNEXPECTED_COMPILE; return 1; }
install_terminal_terminfo
''', status=1)
        self.assertNotIn('UNEXPECTED_COMPILE', output)
        self.assertNotIn('INSTALLED:', output)

    def test_compile_failure_does_not_install_entries(self):
        output = self.shell('''toolkit_system_terminfo_supported() { return 1; }
tic() { return 9; }
install_terminal_terminfo
''', status=1)
        self.assertIn('failed (exit code: 9)', output)
        self.assertNotIn('INSTALLED:', output)
        self.assertFalse((self.root / 'system').exists())

    @unittest.skipUnless(shutil.which('tic') and shutil.which('infocmp') and shutil.which('tput'),
                         'requires ncurses tools')
    def test_fallback_restores_redraw_capabilities_and_is_idempotent(self):
        output = self.shell('''tic() { echo COMPILED; command tic "$@"; }
install_terminal_terminfo
install_terminal_terminfo
''')
        self.assertEqual(output.count('COMPILED'), 1)
        self.assertEqual(output.count('INSTALLED:'), 2)
        database = self.root / 'system'
        for terminal in ('xterm-ghostty', 'ghostty'):
            subprocess.run(['infocmp', '-x', '-A', str(database), terminal],
                           capture_output=True, check=True)
            env = dict(os.environ, TERMINFO=str(database), TERMINFO_DIRS=str(database))
            for capability, expected in (('cr', b'\r'), ('cub1', b'\b'),
                                         ('el', b'\x1b[K'), ('cuu1', b'\x1b[A'),
                                         ('clear', b'\x1b[H\x1b[2J'), ('colors', b'256\n')):
                with self.subTest(terminal=terminal, capability=capability):
                    value = subprocess.run(['tput', '-T', terminal, capability],
                                           env=env, capture_output=True, check=True).stdout
                    self.assertEqual(value, expected)
        for entry in database.glob('*/*'):
            self.assertEqual(entry.stat().st_mode & 0o777, 0o644)

    @unittest.skipUnless(shutil.which('tic') and shutil.which('infocmp'), 'requires ncurses tools')
    def test_existing_custom_entry_is_preserved_when_alias_is_missing(self):
        output = self.shell('''toolkit_ghostty_terminfo_source | sed 's/cols#80/cols#90/' > "$TEST_TMP/custom.terminfo"
command tic -x -o "$TEST_TMP/system" "$TEST_TMP/custom.terminfo"
for entry in "$TEST_TMP/system"/*/ghostty; do rm "$entry"; done
install_terminal_terminfo
infocmp -x -A "$TEST_TMP/system" xterm-ghostty
''')
        self.assertIn('cols#90', output)
        self.assertEqual(output.count('INSTALLED:'), 1)
        installed_line = next(line for line in output.splitlines() if line.startswith('INSTALLED:'))
        self.assertTrue(installed_line.endswith('/ghostty'))

    @unittest.skipUnless(shutil.which('tic'), 'requires ncurses compiler')
    def test_invalid_compiled_entry_is_rejected_before_writes(self):
        output = self.shell('''infocmp() { return 1; }
install_terminal_terminfo
''', status=1)
        self.assertIn('Compiled terminal definition is invalid:', output)
        self.assertNotIn('INSTALLED:', output)


if __name__ == '__main__':
    unittest.main()
