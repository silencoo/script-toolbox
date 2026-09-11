#!/usr/bin/env python3
"""Exercise startup under a PTY without running system-management actions."""
import os
from pathlib import Path
import pty
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'


class TerminalTest(unittest.TestCase):
    def run_ui(self, term='xterm-kitty', supported='xterm-kitty', tty=True,
               clear_status='0', missing_tools=False, unset_term=False, no_color=''):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            commands = {
                'infocmp': 'case " $TEST_SUPPORTED " in *" $1 "*) exit 0;; *) exit 1;; esac',
                'tput': 'case "$1" in colors) echo 256;; cols) echo 80;; esac',
                'clear': 'echo CLEAR_CALLED; exit "$TEST_CLEAR_STATUS"',
            }
            for name, body in commands.items():
                path = root / name
                path.write_text('#!/bin/bash\n' + body + '\n')
                path.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'],
                       TERM=term, TEST_SUPPORTED=supported, TEST_CLEAR_STATUS=clear_status,
                       NO_COLOR=no_color, NON_INTERACTIVE='0', DRY_RUN='0')
            code = '''source "$1"
validate_runtime_modes() { :; }
action_system_overview() {
    ui_clear_screen
    printf '\\nRESULT term=%s color=%s\\n' "${TERM:-unset}" "${RED:+yes}"
}
'''
            if missing_tools:
                code += '''command() {
    case "${2:-}" in infocmp|tput|clear) return 1;; esac
    builtin command "$@"
}
'''
            if unset_term:
                code += 'unset TERM\n'
            code += 'main --overview\n'
            args = ['bash', '-c', code, 'terminal-test', str(TOOLKIT)]
            if tty:
                master, slave = pty.openpty()
                try:
                    child = subprocess.Popen(args, env=env, stdout=slave, stderr=slave)
                    os.close(slave)
                    slave = None
                    child.wait(timeout=10)
                    chunks = []
                    while True:
                        try:
                            chunk = os.read(master, 4096)
                        except OSError:
                            break
                        if not chunk:
                            break
                        chunks.append(chunk)
                    output = b''.join(chunks).decode()
                    status = child.returncode
                finally:
                    if slave is not None:
                        os.close(slave)
                    os.close(master)
            else:
                child = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
                output, status = child.stdout + child.stderr, child.returncode
            self.assertEqual(status, 0, output)
            return output

    def test_supported_terminal_is_preserved(self):
        self.assertIn('RESULT term=xterm-kitty color=yes', self.run_ui())

    def test_missing_kitty_uses_installed_fallback(self):
        self.assertIn('RESULT term=xterm-256color color=yes', self.run_ui(supported='xterm-256color'))
        self.assertIn('RESULT term=xterm color=yes', self.run_ui(supported='xterm'))

    def test_failed_clear_cannot_abort_startup(self):
        output = self.run_ui(clear_status='1')
        self.assertIn('CLEAR_CALLED', output)
        self.assertIn('RESULT', output)

    def test_no_capabilities_falls_back_to_plain_text(self):
        for kwargs in ({'supported': ''}, {'missing_tools': True}, {'term': 'dumb'}):
            output = self.run_ui(**kwargs)
            self.assertIn('RESULT term=dumb color=', output)
            self.assertNotIn('color=yes', output)
            self.assertNotIn('CLEAR_CALLED', output)

    def test_redirected_output_and_no_color(self):
        output = self.run_ui(tty=False)
        self.assertIn('RESULT term=xterm-kitty color=', output)
        self.assertNotIn('color=yes', output)
        self.assertNotIn('CLEAR_CALLED', output)
        self.assertNotIn('color=yes', self.run_ui(no_color='1'))

    def test_unset_terminal_does_not_trip_nounset(self):
        self.assertIn('RESULT term=xterm color=yes', self.run_ui(unset_term=True, supported='xterm'))


if __name__ == '__main__':
    unittest.main()
