#!/usr/bin/env python3
"""Verify consistent toolkit navigation without executing system actions."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'
FUNCTIONS = dict(re.findall(
    r'^(?:function )?(\w+)\(\) \{\n(.*?)^}', TOOLKIT.read_text(), re.M | re.S))
MENUS = sorted(name for name, body in FUNCTIONS.items()
               if re.search(r'^\s*menu_back_and_exit\s*$', body, re.M)
               or name == 'benchmark_results_prompt')


class MenuNavigationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-navigation-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        reports = self.root / 'reports'
        reports.mkdir(mode=0o700)
        (reports / 'fixture.log').write_text('Saved benchmark fixture\n')

    def shell(self, code, *, input, language='en'):
        prefix = '''source "$1"
LOG_FILE="$2/toolkit.log"
BENCHMARK_REPORT_DIR="$2/reports"
initialize_terminal
resolve_toolkit_language
ui_clear_screen() { :; }
ui_read() { printf '%s\\n' "$(ui_text "$2" "$3")"; builtin read -r "$1"; }
menu_pause() { echo PAUSE_CALLED; }
docker() { :; }
download_remote_script() { echo MOCK_DOWNLOAD; }
run_menu_action() { echo UNEXPECTED_ACTION; return 90; }
confirm_dangerous_action() { echo UNEXPECTED_DANGEROUS_ACTION; return 90; }
'''
        child = subprocess.run(
            ['bash', '-c', prefix + code, 'navigation-test', str(TOOLKIT), str(self.root)],
            input=input, text=True, capture_output=True, timeout=10,
            env=dict(os.environ, NON_INTERACTIVE='0', DRY_RUN='0',
                     TOOLKIT_LANG=language, TERM='dumb', NO_COLOR='1'))
        output = child.stdout + child.stderr
        self.assertEqual(child.returncode, 0, output)
        self.assertNotIn('UNEXPECTED_', output)
        return output

    def test_every_owned_submenu_has_matching_footer_and_navigation(self):
        self.assertGreaterEqual(len(MENUS), 33)
        for name in MENUS:
            with self.subTest(menu=name):
                body = FUNCTIONS[name]
                self.assertRegex(body, r'b\|B\) return(?: 0)? ;;')
                self.assertRegex(body, r'0\) exit 0 ;;')
        source = TOOLKIT.read_text()
        self.assertNotRegex(source, re.compile(r'^\s*0\) (?:return|break)', re.M))
        self.assertNotRegex(source, r'(?:\[0\]|0\.)[^\n]*(?:"Back|"Cancel)')
        self.assertNotIn('0 to go back', source)
        self.assertNotIn('Back to main menu', source)

    def test_back_returns_and_zero_exits_in_every_submenu(self):
        for name in MENUS:
            for key in ('b', 'B', '0'):
                with self.subTest(menu=name, key=key):
                    # The dangerous installer retains its initial typed gate;
                    # the mocked download writes nothing and executes nothing.
                    input = ('install\n' if name == 'action_dd_reinstall' else '') + key + '\n'
                    # Conditional invocation matches invoke_action's fault
                    # boundary and allows the legacy Bash-4-only declaration in
                    # custom initialization to be exercised on macOS Bash 3.
                    output = self.shell(f'''{name} || exit "$?"
echo MENU_RETURNED
''', input=input)
                    if key == '0':
                        self.assertNotIn('MENU_RETURNED', output)
                    else:
                        self.assertIn('MENU_RETURNED', output)
                    self.assertNotIn('PAUSE_CALLED', output)
                    self.assertIn('Back', output)
                    self.assertIn('Exit', output)

    def test_chinese_footer_and_exit_use_the_same_keys(self):
        for key in ('b', '0'):
            output = self.shell('''action_install_runtime || exit "$?"
echo MENU_RETURNED
''', input=key + '\n', language='zh')
            self.assertIn('b. 返回上一级菜单', output)
            self.assertIn('0. 退出', output)
            self.assertEqual('MENU_RETURNED' in output, key == 'b')

    def test_nested_back_returns_one_level_without_exiting(self):
        output = self.shell('''show_docker_app_menu || exit "$?"
echo MENU_RETURNED
''', input='2\n3\nb\nb\nb\n')
        self.assertIn('Container actions', output)
        self.assertEqual(output.count('Docker Manager'), 2)
        self.assertEqual(output.count('Docker and applications'), 2)
        self.assertIn('MENU_RETURNED', output)
        self.assertNotIn('PAUSE_CALLED', output)

    def test_multiselect_navigation_never_applies_partial_selection(self):
        for name in ('install_runtime_batch', 'task_custom_init'):
            for key in ('b', '0'):
                output = self.shell(f'''invoke_action() {{ echo UNEXPECTED_ACTION; return 90; }}
{name} || exit "$?"
echo MENU_RETURNED
''', input=f'1 {key}\n')
                self.assertEqual('MENU_RETURNED' in output, key == 'b')

    def test_main_menu_zero_still_exits(self):
        output = self.shell('show_menu\necho UNEXPECTED_RETURN', input='0\n')
        self.assertIn('0. Exit', output)


if __name__ == '__main__':
    unittest.main()
