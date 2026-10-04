#!/usr/bin/env python3
"""Benchmark recording regressions; no downloads or real benchmarks are run."""
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'
PREFIX = '''source "$1"
TEST_TMP="$2"
LOG_FILE="$TEST_TMP/toolkit.log"
BENCHMARK_REPORT_DIR="$TEST_TMP/reports"
initialize_terminal
'''


class BenchmarkTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-benchmarks-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, NON_INTERACTIVE='0', DRY_RUN='0',
                        TOOLKIT_LANG='en', TOOLKIT_EFFECTIVE_LANG='en', NO_COLOR='1')

    def shell(self, code, *, input='', status=0, tty=False, env=None, input_after=None):
        args = ['bash', '-c', PREFIX + code, 'benchmark-test', str(TOOLKIT), str(self.root)]
        environment = dict(self.env, **(env or {}))
        if tty:
            master, slave = pty.openpty()
            child = None
            try:
                child = subprocess.Popen(args, env=environment, stdin=slave,
                                         stdout=slave, stderr=slave)
                if input and input_after is None:
                    os.write(master, input.encode())
                    input = ''
                chunks = []
                deadline = time.monotonic() + 15
                # Keep our slave open while draining: macOS may discard unread
                # master output when the last slave closes. Drain concurrently
                # so a full PTY buffer cannot block the benchmark process.
                while True:
                    if time.monotonic() > deadline:
                        self.fail('PTY fixture timed out')
                    ready, _, _ = select.select([master], [], [], 0.05)
                    if ready:
                        chunk = os.read(master, 4096)
                        if not chunk:
                            break
                        chunks.append(chunk)
                        if input and input_after.encode() in b''.join(chunks):
                            os.write(master, input.encode())
                            input = ''
                    elif child.poll() is not None:
                        break
                output = b''.join(chunks).decode()
                returncode = child.wait(timeout=1)
            finally:
                if slave is not None:
                    os.close(slave)
                os.close(master)
                if child is not None and child.poll() is None:
                    child.kill()
                    child.wait()
        else:
            child = subprocess.run(args, env=environment, input=input,
                                   capture_output=True, text=True, timeout=15)
            output = child.stdout + child.stderr
            returncode = child.returncode
        self.assertEqual(returncode, status, output)
        return output

    def test_streams_both_outputs_and_produces_private_plaintext(self):
        output = self.shell(r'''umask 022
fixture() {
    printf '\033[31mRESULT\033[0m\r\n'
    printf '\033[2J\033[HDETAILS\n'
    printf '\033]8;;https://example.test\007LINK\033]8;;\007\n'
    printf '\033]8;;https://example.test\033\\LINK2\033]8;;\033\\\n'
    printf 'STDERR\n' >&2
}
run_benchmark_command fixture 'Test benchmark' fixture
printf 'UMASK:%s\n' "$(umask)"
''')
        self.assertIn('RESULT', output)
        self.assertIn('STDERR', output)
        self.assertIn('UMASK:0022', output)
        raw, = (self.root / 'reports').glob('*.log')
        text, = (self.root / 'reports').glob('*.txt')
        self.assertIn(b'\x1b[31m', raw.read_bytes())
        self.assertIn('RESULT\nDETAILS\nLINK\nLINK2\nSTDERR', text.read_text())
        self.assertNotIn(b'\x1b', text.read_bytes())
        self.assertNotIn(b'\r', text.read_bytes())
        self.assertIn('Exit status: 0', text.read_text())
        self.assertEqual((self.root / 'reports').stat().st_mode & 0o777, 0o700)
        for report in (raw, text):
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)

    def test_failed_benchmark_preserves_partial_output_and_exit_status(self):
        output = self.shell('''fixture() { echo PARTIAL; echo FAILURE >&2; return 7; }
run_benchmark_command failure 'Failing benchmark' fixture
''', status=7)
        self.assertIn('exited with status 7', output)
        report, = (self.root / 'reports').glob('*.txt')
        for value in ('PARTIAL', 'FAILURE', 'Exit status: 7'):
            self.assertIn(value, report.read_text())

    def test_output_is_persisted_before_command_finishes(self):
        output = self.shell('''fixture() {
    echo FIRST_RESULT
    for ((attempt=0; attempt<100; attempt++)); do
        if grep -q FIRST_RESULT "$LAST_BENCHMARK_REPORT"; then
            echo SAVED_WHILE_RUNNING; return 0
        fi
        sleep 0.02
    done
    return 9
}
run_benchmark_command streaming 'Streaming benchmark' fixture
''')
        self.assertIn('SAVED_WHILE_RUNNING', output)

    def test_stdin_arguments_and_repeated_runs_are_preserved(self):
        self.shell('''fixture() { read -r response; printf 'INPUT:%s ARG:%s\n' "$response" "$1"; }
run_benchmark_command fixture first fixture 'spaces;$(not-a-command)'
run_benchmark_command fixture second fixture 'second argument'
''', input='first answer\nsecond answer\n')
        reports = list((self.root / 'reports').glob('*.txt'))
        self.assertEqual(len(reports), 2)
        contents = '\n'.join(report.read_text() for report in reports)
        self.assertIn('INPUT:first answer ARG:spaces;$(not-a-command)', contents)
        self.assertIn('INPUT:second answer ARG:second argument', contents)

    def test_dry_run_does_not_create_reports_download_or_execute(self):
        output = self.shell('''DRY_RUN=1
fixture() { echo UNEXPECTED_EXECUTION; return 9; }
download_remote_script_unverified() { echo UNEXPECTED_DOWNLOAD; return 9; }
run_benchmark_command dryrun 'Dry benchmark' fixture
run_remote_benchmark dryrun https://example.test 'Dry remote benchmark'
''')
        self.assertNotIn('UNEXPECTED_', output)
        self.assertFalse((self.root / 'reports').exists())

    def test_unusable_destination_stops_before_benchmark(self):
        (self.root / 'reports').write_text('keep me')
        output = self.shell('''fixture() { echo UNEXPECTED_EXECUTION; }
run_benchmark_command failure test fixture
''', status=1)
        self.assertNotIn('UNEXPECTED_EXECUTION', output)
        self.assertEqual((self.root / 'reports').read_text(), 'keep me')

    def test_existing_shared_directory_is_rejected_without_chmod(self):
        reports = self.root / 'reports'
        reports.mkdir(mode=0o755)
        output = self.shell('''fixture() { echo UNEXPECTED_EXECUTION; }
run_benchmark_command failure test fixture
''', status=1)
        self.assertIn('directory must be private', output)
        self.assertNotIn('UNEXPECTED_EXECUTION', output)
        self.assertEqual(reports.stat().st_mode & 0o777, 0o755)
        self.assertEqual(list(reports.iterdir()), [])

    def test_symlinked_destination_is_rejected(self):
        target = self.root / 'target'
        target.mkdir(mode=0o700)
        (self.root / 'reports').symlink_to(target)
        output = self.shell('''fixture() { echo UNEXPECTED_EXECUTION; }
run_benchmark_command failure test fixture
''', status=1)
        self.assertNotIn('UNEXPECTED_EXECUTION', output)
        self.assertEqual(list(target.iterdir()), [])

    def test_recording_failure_is_not_reported_as_success(self):
        for benchmark_status, expected_status in ((0, 12), (7, 7)):
            with self.subTest(benchmark_status=benchmark_status):
                output = self.shell(f'''tee() {{ cat; return 12; }}
fixture() {{ echo RESULT; return {benchmark_status}; }}
run_benchmark_command failure test fixture
''', status=expected_status)
                self.assertIn('recording or text conversion failed', output)
                self.assertNotIn('Benchmark report saved:', output)
        self.assertEqual(list((self.root / 'reports').glob('*.txt')), [])

    def test_failed_text_conversion_keeps_raw_but_not_broken_text(self):
        output = self.shell('''benchmark_plaintext() { echo INCOMPLETE; return 8; }
run_benchmark_command conversion test printf 'RAW_RESULT\n'
''', status=1)
        self.assertNotIn('Benchmark report saved:', output)
        raw, = (self.root / 'reports').glob('*.log')
        self.assertIn('RAW_RESULT', raw.read_text())
        self.assertEqual(list((self.root / 'reports').glob('*.txt')), [])

    def test_results_ignore_enter_and_invalid_input_without_clearing(self):
        output = self.shell('''ui_clear_screen() { echo UNEXPECTED_CLEAR; }
benchmark_view_report() { echo REVIEWED; }
benchmark_results_prompt /fake/report.log
echo EXPLICITLY_RETURNED
''', input='\ninvalid\nv\nb\n')
        self.assertEqual(output.count('Results remain visible'), 4)
        self.assertIn('REVIEWED', output)
        self.assertIn('EXPLICITLY_RETURNED', output)
        self.assertNotIn('UNEXPECTED_CLEAR', output)

    def test_noninteractive_result_prompt_does_not_read(self):
        self.shell('''NON_INTERACTIVE=1
ui_read() { echo UNEXPECTED_READ; return 9; }
benchmark_results_prompt /fake/report.log
''')

    def test_archive_is_read_only_and_handles_empty_directory(self):
        output = self.shell('action_view_benchmark_reports')
        self.assertIn('No saved benchmark reports', output)
        self.assertFalse((self.root / 'reports').exists())

    def test_archive_lists_newest_first_and_can_view_interrupted_transcript(self):
        reports = self.root / 'reports'
        reports.mkdir(mode=0o700)
        (reports / '20261001-old.log').write_text('OLD')
        (reports / '20261004-new.log').write_text('\x1b[2J\x1b[31mPARTIAL\x1b[0m\r\n')
        (reports / '20261005-symlink.log').symlink_to(reports / '20261001-old.log')
        output = self.shell('action_view_benchmark_reports', input='invalid\n999\n01\nb\n')
        self.assertIn('[1] 20261004-new.log', output)
        self.assertIn('[2] 20261001-old.log', output)
        self.assertNotIn('symlink.log', output)
        self.assertIn('PARTIAL', output)
        self.assertNotIn('\x1b', output)
        self.assertEqual(len(list(reports.iterdir())), 3)

    def test_all_menu_benchmarks_save_and_wait_for_explicit_back(self):
        for choice in range(1, 6):
            with self.subTest(choice=choice):
                output = self.shell('''confirm_action() { return 0; }
download_remote_script_unverified() {
    printf 'printf "REMOTE_RESULT\\nARG:%%s\\n" "$1"\n' > "$2"
    echo POLICY_CHECKED
}
goecs() { printf 'GO_RESULT\nARG:%s\n' "$@"; }
ui_clear_screen() { echo MENU_CLEAR; }
menu_pause() { echo UNEXPECTED_PAUSE; }
action_run_test_scripts
cleanup_temp_files
''', input=f'{choice}\n\nv\nb\nb\n')
                self.assertNotIn('UNEXPECTED_PAUSE', output)
                self.assertEqual(output.count('MENU_CLEAR'), 2)
                self.assertEqual(output.count('Results remain visible'), 3)
                self.assertIn('Benchmark report saved:', output)
                if choice != 5:
                    self.assertIn('POLICY_CHECKED', output)
                if choice == 4:
                    self.assertIn('ARG:-I', output)
                if choice == 5:
                    self.assertIn('ARG:-upload=false', output)
        self.assertEqual(len(list((self.root / 'reports').glob('*.txt'))), 5)

    def test_remote_confirmation_failure_never_executes_benchmark(self):
        output = self.shell('''download_remote_script_unverified() { echo POLICY_DENIED; return 1; }
run_benchmark_command() { echo UNEXPECTED_EXECUTION; return 9; }
status=0
run_remote_benchmark denied https://example.test test || status=$?
cleanup_temp_files
exit "$status"
''', status=1)
        self.assertIn('POLICY_DENIED', output)
        self.assertNotIn('UNEXPECTED_EXECUTION', output)
        self.assertFalse((self.root / 'reports').exists())

    def test_pty_recorder_flags_exit_status_and_bash_quoting(self):
        output = self.shell('''script() {
    if [ "$1" = --version ]; then echo 'script from util-linux'; return 0; fi
    [ "$1 $2 $3 $4 $5" = '-q -e -f -a -c' ] || return 90
    [ "$SHELL" = /bin/bash ] || return 91
    printf 'PTY_RECORDER_USED\n'
    local status=0
    /bin/bash -c "$6" >> "$7" 2>&1 || status=$?
    cat "$7"
    return "$status"
}
run_benchmark_command quoting test bash -c 'printf "ARG:%s\\n" "$1"; exit 9' fixture 'space;$(not-a-command)'
''', status=9, tty=True, env={'SHELL': '/bin/zsh'})
        self.assertIn('PTY_RECORDER_USED', output)
        self.assertIn('ARG:space;$(not-a-command)', output)
        text, = (self.root / 'reports').glob('*.txt')
        self.assertIn('Exit status: 9', text.read_text())

    def test_real_linux_recorder_preserves_interactive_tty_and_direct_tty_output(self):
        script = shutil.which('script')
        if not script or 'util-linux' not in subprocess.run(
                [script, '--version'], capture_output=True, text=True).stdout:
            self.skipTest('requires Linux util-linux script')
        output = self.shell('''run_benchmark_command tty test bash -c '
test -t 0 && test -t 1 && test -t 2 || exit 90
printf "DIRECT_TTY_RESULT\\n" > /dev/tty
printf "READY_FOR_INPUT\\n"
read -r answer
printf "ANSWER:%s\\n" "$answer"
exit 9'
''', input='interactive answer\n', status=9, tty=True, input_after='READY_FOR_INPUT')
        self.assertIn('DIRECT_TTY_RESULT', output)
        text, = (self.root / 'reports').glob('*.txt')
        self.assertIn('DIRECT_TTY_RESULT', text.read_text())
        self.assertIn('ANSWER:interactive answer', text.read_text())
        self.assertIn('Exit status: 9', text.read_text())


if __name__ == '__main__':
    unittest.main()
