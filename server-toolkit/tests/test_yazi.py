#!/usr/bin/env python3
"""Exercise Yazi installation with local archives and no system mutations."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'


class YaziTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-yazi-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin_dir = self.root / 'user' / '.local' / 'bin'
        self.bin_dir.mkdir(parents=True)

    def shell(self, code, *, arch='x86_64', status=0, dry_run='0'):
        prefix = r'''source "$1"
TEST_TMP="$2"
INSTALL_HOME="$TEST_TMP/user"
INSTALL_USER="$(id -un)"
LOG_FILE="$TEST_TMP/toolkit.log"
BACKUP_DIR="$TEST_TMP/backups"
trap cleanup_temp_files EXIT
run_as_user() { bash -c "$1"; }
terminal_user_command_path() {
    [ -x "$INSTALL_HOME/.local/bin/$1" ] || return 1
    printf '%s\n' "$INSTALL_HOME/.local/bin/$1"
}
uname() { printf '%s\n' "$TEST_ARCH"; }
download_and_verify_sha256() {
    printf 'DOWNLOAD:%s\nSHA:%s\n' "$1" "$2"
    cp "$TEST_TMP/archive.zip" "$3"
}
'''
        child = subprocess.run(
            ['bash', '-c', prefix + code, 'yazi-test', str(TOOLKIT), str(self.root)],
            text=True, capture_output=True, timeout=15,
            env=dict(os.environ, NON_INTERACTIVE='1', DRY_RUN=dry_run,
                     TEST_ARCH=arch, TOOLKIT_LANG='en'),
        )
        self.assertEqual(child.returncode, status, child.stdout + child.stderr)
        self.assertNotIn('unbound variable', child.stderr)
        return child.stdout + child.stderr

    def binary(self, name, version='26.9.1', exit_code=0):
        label = 'Yazi' if name == 'yazi' else 'Ya'
        return f'#!/bin/sh\nprintf "{label} {version}\\n"\nexit {exit_code}\n'

    def archive(self, target='x86_64-unknown-linux-musl', *, missing=(),
                ya_version='26.9.1', yazi_exit=0):
        with zipfile.ZipFile(self.root / 'archive.zip', 'w') as archive:
            for name in ('yazi', 'ya'):
                if name not in missing:
                    archive.writestr(
                        f'yazi-{target}/{name}',
                        self.binary(name, ya_version if name == 'ya' else '26.9.1',
                                    yazi_exit if name == 'yazi' else 0),
                    )

    def existing_pair(self, yazi_version='26.9.1', ya_version='26.9.1'):
        for name, version in (('yazi', yazi_version), ('ya', ya_version)):
            binary = self.bin_dir / name
            binary.write_text(self.binary(name, version))
            binary.chmod(0o755)

    def test_installs_matched_user_owned_pair_for_both_architectures(self):
        for arch, target, checksum in (
            ('x86_64', 'x86_64-unknown-linux-musl',
             '9b9c39decccf8cb0ff53a7d637d38f8a79d93bbd0099f4ea9c619ef6bb392f5d'),
            ('aarch64', 'aarch64-unknown-linux-musl',
             'dd569daecaae914185f295634109295ccd25c1b42b02eb89a74f651970024f2e'),
        ):
            with self.subTest(arch=arch):
                for binary in self.bin_dir.iterdir():
                    binary.unlink()
                self.archive(target)
                output = self.shell('install_terminal_yazi', arch=arch)
                self.assertIn(f'/v26.9.1/yazi-{target}.zip', output)
                self.assertIn(f'SHA:{checksum}', output)
                self.assertIn('Yazi and ya 26.9.1 installed for', output)
                for name in ('yazi', 'ya'):
                    binary = self.bin_dir / name
                    self.assertEqual(binary.stat().st_mode & 0o777, 0o755)
                    self.assertEqual(binary.stat().st_uid, os.getuid())
                    self.assertEqual(binary.stat().st_gid, os.getgid())
                    self.assertEqual(binary.read_text(), self.binary(name))

    def test_preserves_existing_working_pair_without_downloading(self):
        self.existing_pair('25.5.31', '25.5.31')
        output = self.shell('install_terminal_yazi')
        self.assertIn('already installed: 25.5.31', output)
        self.assertNotIn('DOWNLOAD:', output)
        self.assertEqual((self.bin_dir / 'yazi').read_text(), self.binary('yazi', '25.5.31'))

    def test_repairs_partial_or_mismatched_installation(self):
        for partial in (True, False):
            with self.subTest(partial=partial):
                self.existing_pair('25.5.31', '26.9.1')
                if partial:
                    (self.bin_dir / 'ya').unlink()
                self.archive()
                output = self.shell('install_terminal_yazi')
                self.assertIn('DOWNLOAD:', output)
                self.assertEqual((self.bin_dir / 'yazi').read_text(), self.binary('yazi'))
                self.assertEqual((self.bin_dir / 'ya').read_text(), self.binary('ya'))

    def test_rejects_invalid_pair_before_changing_existing_binary(self):
        for options in ({'missing': ('ya',)}, {'ya_version': '25.5.31'}, {'yazi_exit': 1}):
            with self.subTest(options=options):
                existing = self.bin_dir / 'yazi'
                existing.write_text('existing binary')
                existing.chmod(0o755)
                self.archive(**options)
                self.shell('install_terminal_yazi', status=1)
                self.assertEqual(existing.read_text(), 'existing binary')
                self.assertFalse((self.bin_dir / 'ya').exists())

    def test_download_failure_does_not_install_anything(self):
        self.shell('download_and_verify_sha256() { return 1; }\ninstall_terminal_yazi', status=1)
        self.assertEqual(list(self.bin_dir.iterdir()), [])

    def test_second_binary_write_failure_requests_rollback_from_own_checkpoint(self):
        self.archive()
        output = self.shell(r'''original_write="$(declare -f write_file_atomic)"
eval "${original_write/write_file_atomic/original_write_file_atomic}"
write_file_atomic() {
    case "$1" in */ya) return 1;; esac
    original_write_file_atomic "$@"
}
# Keep the shared rollback implementation outside this installer test.
# Verify the installer requests rollback from its own checkpoint.
record_created_file "$TEST_TMP/previous-action" 'Previous action'
rollback_operations_from() { printf 'ROLLBACK_START:%s\n' "$1"; }
install_terminal_yazi
''', status=1)
        self.assertIn('ROLLBACK_START:1', output)
        self.assertFalse((self.bin_dir / 'ya').exists())

    def test_unsupported_architecture_does_not_download(self):
        output = self.shell('install_terminal_yazi', arch='armv7l', status=1)
        self.assertIn('No pinned Yazi build', output)
        self.assertNotIn('DOWNLOAD:', output)

    def test_dry_run_has_no_downloads_or_files(self):
        output = self.shell('''mktemp() { echo UNEXPECTED_MKTEMP; return 1; }
install_terminal_yazi
''', dry_run='1')
        self.assertIn('[DRY RUN]', output)
        self.assertNotIn('UNEXPECTED_MKTEMP', output)
        self.assertNotIn('DOWNLOAD:', output)
        self.assertEqual(list(self.bin_dir.iterdir()), [])

    def test_terminal_setup_continues_when_yazi_is_unavailable(self):
        output = self.shell(r'''determine_target_user() { :; }
update_apt_once() { :; }
install_packages_batch() { printf 'PACKAGES:%s\n' "$*"; }
install_terminal_terminfo() { :; }
apt_package_has_candidate() { return 1; }
run_cmd() { :; }
run_as_user() { :; }
download_file() { return 1; }
install_terminal_yazi() { echo YAZI_ATTEMPT; return 1; }
# Stop at the next optional enhancement, after verifying continuation.
mkdir() { echo NEXT_ENHANCEMENT; return 81; }
action_install_terminal_tools
''', status=81)
        self.assertIn('YAZI_ATTEMPT', output)
        self.assertIn('continuing terminal setup', output)
        self.assertIn('NEXT_ENHANCEMENT', output)
        self.assertIn('bzip2 file', output)
        for package in ('ffmpeg', 'poppler-utils', 'imagemagick', 'resvg'):
            self.assertIn(f'skipped: {package}', output)

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_zsh_wrapper_changes_directory_and_cleans_up_on_success_or_failure(self):
        block = self.shell('terminal_zshrc_block')
        candidate = self.root / 'zshrc'
        candidate.write_text(block)
        subprocess.run(['zsh', '-n', str(candidate)], check=True, capture_output=True)
        # Exercise the actual emitted optional-tool block without loading the
        # developer's Oh My Zsh configuration or changing their home directory.
        optional = block.split('# Optional prompt and navigation tools.\n', 1)[1]
        candidate.write_text(optional.split('# Define aliases only', 1)[0])
        selected = self.root / 'selected directory'
        selected.mkdir()
        fake_yazi = self.bin_dir / 'yazi'
        fake_yazi.write_text('''#!/bin/sh
for arg do
    case "$arg" in --cwd-file=*) cwd_file=${arg#--cwd-file=};; esac
done
printf '%s' "$SELECTED_DIRECTORY" > "$cwd_file"
printf '%s' "$cwd_file" > "$CWD_RECORD"
exit "$YAZI_EXIT"
''')
        fake_yazi.chmod(0o755)
        for exit_code in (0, 7):
            with self.subTest(exit_code=exit_code):
                child = subprocess.run(
                    ['zsh', '-f', '-c', r'''source "$1"
y "argument with spaces"
result=$?
printf 'RESULT:%s\nPWD:%s\n' "$result" "$PWD"
''', 'wrapper-test', str(candidate)],
                    text=True, capture_output=True, timeout=10,
                    env=dict(os.environ, PATH=str(self.bin_dir) + ':' + os.environ['PATH'],
                             SELECTED_DIRECTORY=str(selected),
                             CWD_RECORD=str(self.root / 'cwd-record'), YAZI_EXIT=str(exit_code)),
                )
                self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
                self.assertIn(f'RESULT:{exit_code}', child.stdout)
                self.assertIn(f'PWD:{selected}', child.stdout)
                self.assertFalse(Path((self.root / 'cwd-record').read_text()).exists())


if __name__ == '__main__':
    unittest.main()
