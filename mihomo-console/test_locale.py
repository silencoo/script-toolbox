"""Language selection, translation integrity and terminal rendering regressions."""

import ast
import contextlib
import copy
import io
import json
import string
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import mihomo_console as manager


class RecordingScreen:
    def __init__(self, height=24, width=80):
        self.height, self.width = height, width
        self.calls = []

    def getmaxyx(self):
        return self.height, self.width

    def erase(self):
        self.calls.clear()

    def addstr(self, row, column, value, attr=0):
        assert 0 <= row < self.height
        assert column + manager.display_width(value) < self.width
        self.calls.append((row, column, value))

    def refresh(self):
        pass

    def clear(self):
        self.erase()

    @property
    def text(self):
        return '\n'.join(value for _, _, value in self.calls)


def make_console(height=24, width=80):
    curses = types.SimpleNamespace(
        error=RuntimeError, A_BOLD=1, A_REVERSE=2, A_DIM=4,
        color_pair=lambda _: 0, KEY_UP=259, KEY_DOWN=258,
        KEY_RIGHT=261, KEY_LEFT=260, KEY_BTAB=353, KEY_ENTER=343,
    )
    screen = RecordingScreen(height, width)
    console = manager.ConsoleTUI(screen, curses, Path('/unused/manager.json'))
    console.registry = {
        'active': 'premium',
        'subscriptions': {'premium': {'last_result': 'validated'}},
        'history': [{'kind': 'update', 'status': 'validated', 'subscription': 'premium',
                     'finished_at': '2026-09-10T02:10:56+09:00'}],
    }
    console.status = {
        'mihomo_service': 'active', 'timer_active': 'inactive', 'timer_enabled': 'disabled',
        'last_result': 'validated', 'active_subscription': 'premium',
        'summary': {'proxies': 431, 'providers': 2, 'groups': 10, 'rules': 500},
        'backups': 1, 'history': 1, 'target_config': '/etc/mihomo/config.yaml',
        'config_sha256': 'a' * 64,
    }
    console.backups = [{'name': 'config.yaml.20260910', 'size': 300000, 'summary': {'proxies': 431}}]
    console.logs = ['level=error msg="Original Mihomo diagnostic"']
    return console


class LocaleTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(manager, 'LANGUAGE', 'zh_CN')
        patch.start()
        self.addCleanup(patch.stop)

    def test_locale_precedence_and_fallback(self):
        cases = [
            ('zh_CN', {'MIHOMO_CONSOLE_LANG': 'en_US'}, 'zh_CN'),
            ('auto', {'MIHOMO_CONSOLE_LANG': 'en', 'LC_ALL': 'zh_CN.UTF-8'}, 'en_US'),
            ('auto', {'MIHOMO_CONSOLE_LANG': 'auto', 'LC_ALL': 'en_GB.UTF-8', 'LANG': 'zh_CN'}, 'en_US'),
            ('auto', {'LC_ALL': 'C', 'LANG': 'en_US.UTF-8'}, 'zh_CN'),
            ('auto', {'LC_MESSAGES': 'en-US', 'LANG': 'zh_CN'}, 'en_US'),
            ('auto', {'LANG': 'en_US.UTF-8'}, 'en_US'),
            ('auto', {'LANG': 'zh_CN.UTF-8'}, 'zh_CN'),
            ('auto', {'LANG': 'fr_FR.UTF-8'}, 'zh_CN'),
            ('auto', {}, 'zh_CN'),
        ]
        for requested, environment, expected in cases:
            with self.subTest(requested=requested, environment=environment):
                self.assertEqual(manager.resolve_language(requested, environment), expected)

    def test_catalog_covers_messages_and_preserves_format_fields(self):
        tree = ast.parse(Path(manager.__file__).read_text())
        messages = set(manager.STATE_MESSAGES.values()) | set(manager.ConsoleTUI.PAGES)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'tr':
                if node.args and isinstance(node.args[0], ast.Constant):
                    messages.add(node.args[0].value)
        self.assertFalse(messages - manager.EN_MESSAGES.keys())
        formatter = string.Formatter()
        for source, translated in manager.EN_MESSAGES.items():
            with self.subTest(message=source):
                fields = lambda value: sorted((field, spec, conversion) for _, field, spec, conversion
                                               in formatter.parse(value) if field is not None)
                self.assertEqual(fields(source), fields(translated))

    def test_status_translation_preserves_unknown_codes_and_user_values(self):
        self.assertEqual(manager.format_state('validated'), '校验通过')
        self.assertEqual(manager.format_state('enabled'), '已启用')
        self.assertEqual(manager.format_state('future-state'), 'future-state')
        manager.set_language('en_US')
        self.assertEqual(manager.format_state('validated'), 'Validated')
        self.assertEqual(manager.tr('找不到订阅：{name}', name='中文{profile}'),
                         'Subscription not found: 中文{profile}')

    def test_cli_language_applies_before_top_level_and_subcommand_help(self):
        for language, expected in [('zh_CN', '仅下载和校验'), ('en_US', 'Download and validate only')]:
            for arguments in [[], ['update-active']]:
                result = subprocess.run(
                    [sys.executable, manager.__file__, '--lang', language, *arguments, '--help'],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                prefix = '用法：' if language == 'zh_CN' else 'Usage: '
                self.assertTrue(result.stdout.startswith(prefix))
                self.assertNotIn(prefix + prefix, result.stdout)
                if arguments:
                    self.assertIn(expected, result.stdout)
                if language == 'en_US':
                    self.assertFalse(any('\u4e00' <= c <= '\u9fff' for c in result.stdout))

    def test_all_pages_render_in_both_languages_at_supported_sizes(self):
        for language in ('zh_CN', 'en_US'):
            manager.set_language(language)
            for height, width in ((18, 70), (24, 80), (30, 120)):
                console = make_console(height, width)
                before = copy.deepcopy(console.registry)
                for page, name in enumerate(console.PAGES):
                    with self.subTest(language=language, size=(height, width), page=page):
                        console.page = page
                        console.draw()
                        text = console.screen.text
                        self.assertIn(manager.tr(name), text)
                        if language == 'zh_CN':
                            for raw in ('validated', 'inactive', 'disabled', 'Dry-run', 'provider'):
                                self.assertNotIn(raw, text)
                        if page == 0:
                            self.assertIn('校验通过' if language == 'zh_CN' else 'Validated', text)
                        if page == 4:
                            self.assertIn(console.logs[0], text)
                self.assertEqual(console.registry, before)

    def test_language_key_preserves_page_and_selection(self):
        console = make_console()
        console.page = 1
        with mock.patch.object(console, 'refresh'):
            self.assertTrue(console.handle_key(ord('l')))
            self.assertEqual(manager.LANGUAGE, 'en_US')
            console.draw()
            self.assertIn('Profiles', console.screen.text)
            self.assertEqual(console.page, 1)
            self.assertEqual(console.selected_subscription(), 'premium')
            self.assertTrue(console.handle_key(ord('L')))
            self.assertEqual(manager.LANGUAGE, 'zh_CN')

    def test_recent_error_remains_above_footer_in_small_terminal(self):
        for language in ('zh_CN', 'en_US'):
            manager.set_language(language)
            console = make_console(18, 70)
            console.status['last_error'] = 'invalid REALITY short ID'
            console.draw()
            matches = [row for row, _, text in console.screen.calls if 'invalid REALITY' in text]
            self.assertTrue(matches)
            self.assertTrue(all(row < 16 for row in matches))

    def test_english_update_messages_keep_history_codes_stable(self):
        manager.set_language('en_US')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = copy.deepcopy(manager.DEFAULTS)
            registry.update(target_config=str(root / 'config.yaml'), overlay_file=str(root / 'overlay.yaml'),
                            lock_file=str(root / 'lock'), backup_dir=str(root / 'backups'),
                            active='premium', subscriptions={'premium': {'url': 'https://example.invalid'}})
            path = root / 'manager.json'
            manager.save_registry(path, registry)
            output = io.StringIO()
            with (mock.patch.object(manager, 'download_profile', return_value=b'proxies: [{name: sample, type: ss}]'),
                  mock.patch.object(manager, 'validate_with_mihomo'),
                  mock.patch.object(manager, 'restart_mihomo') as restart,
                  contextlib.redirect_stdout(output)):
                manager.update_profile(path, registry, 'premium', dry_run=True)
            self.assertIn('Validation passed', output.getvalue())
            self.assertNotIn('正在', output.getvalue())
            self.assertEqual(json.loads(path.read_text())['history'][-1]['status'], 'validated')
            self.assertFalse((root / 'config.yaml').exists())
            restart.assert_not_called()

    def test_english_lock_contention_does_not_write_failure_history(self):
        manager.set_language('en_US')
        with (mock.patch.object(manager, '_update_profile_impl',
                                side_effect=manager.ConcurrentUpdateError(manager.tr('另一个更新任务正在运行'))),
              mock.patch.object(manager, 'load_registry') as load):
            with self.assertRaisesRegex(manager.ConcurrentUpdateError, 'Another update'):
                manager.update_profile(Path('/unused'), {}, 'premium')
            load.assert_not_called()

    def test_localized_error_preserves_original_mihomo_diagnostic(self):
        manager.set_language('en_US')
        diagnostic = 'proxy 430: invalid REALITY short ID'
        result = subprocess.CompletedProcess([], 1, diagnostic)
        with mock.patch.object(manager, 'command_output', return_value=result):
            with self.assertRaises(manager.ManagerError) as error:
                manager.validate_with_mihomo(manager.DEFAULTS, Path('/unused/config.yaml'))
        self.assertEqual(str(error.exception), 'Mihomo configuration validation failed:\n' + diagnostic)


if __name__ == '__main__':
    unittest.main()
