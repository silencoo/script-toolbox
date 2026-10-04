#!/usr/bin/env python3
"""Exercise the macOS terminal profile with mocked Homebrew and Ghostty."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SETUP = Path(__file__).resolve().parents[1] / 'macos/setup.sh'


class MacOSTerminalTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workstation-terminal-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.config = self.home / '.config/ghostty/config.ghostty'
        self.log = self.root / 'commands.log'
        self.bundle = self.root / 'selected.Brewfile'
        commands = {
            'uname': "printf 'Darwin\\n'",
            'brew': r'''printf 'BREW:%s\n' "$*" >> "$TEST_LOG"
case "$1" in
  bundle) cat > "$TEST_BUNDLE"; exit "${TEST_BREW_STATUS:-0}";;
  list) printf 'ghostty 1.3.1\n';;
  uninstall) exit 0;;
  *) exit 9;;
esac''',
            'ghostty': r'''printf 'GHOSTTY:%s\n' "$*" >> "$TEST_LOG"
[ "$1" = '+validate-config' ] || exit 9
exit "${TEST_GHOSTTY_STATUS:-0}"''',
        }
        for name, body in commands.items():
            executable = self.bin / name
            executable.write_text('#!/usr/bin/env bash\n' + body + '\n')
            executable.chmod(0o755)

    def run_setup(self, *args, input='', status=0, overrides=None, setup=SETUP):
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                   HOME=str(self.home), TEST_LOG=str(self.log), TEST_BUNDLE=str(self.bundle),
                   TEST_BREW_STATUS='0', TEST_GHOSTTY_STATUS='0')
        env.pop('ZDOTDIR', None)
        env.update(overrides or {})
        child = subprocess.run(['bash', str(setup), *args], env=env, input=input,
                               capture_output=True, text=True, timeout=15)
        output = child.stdout + child.stderr
        self.assertEqual(child.returncode, status, output)
        return output

    def seed_config(self):
        self.config.parent.mkdir(parents=True)
        self.config.write_text('font-size = 14\nshell-integration-features = title\n')
        return self.config.read_text()

    def test_default_menu_installs_selected_terminal_profile_with_optional_monitors(self):
        output = self.run_setup(input='1\n2\ny\ny\n')
        self.assertIn('macOS workstation setup', output)
        self.assertIn('Plan: terminal profile(s)', output)
        self.assertIn('Include these optional additions?', output)
        self.assertIn('Install the missing packages in this plan?', output)
        bundle = self.bundle.read_text()
        for token in ['starship', 'btop', 'ncdu', 'duf']:
            self.assertIn('brew "' + token + '"', bundle)
        self.assertNotIn('keepassxc', bundle)
        self.assertTrue(self.config.exists())
        self.assertTrue((self.home / '.zshrc').exists())

    def test_menu_preview_combines_and_deduplicates_profile_numbers(self):
        output = self.run_setup('menu', input='2\n1, 5 1\nn\n')
        self.assertIn('Plan: core desktop profile(s)', output)
        self.assertIn('maccy', output)
        self.assertIn('raycast', output)
        self.assertNotIn('[optional]', output)
        self.assertEqual(output.count('cask   localsend'), 1)
        self.assertIn('Selected packages (Homebrew skips those already installed)', output)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.home.exists())

    def test_menu_preview_optional_flag_does_not_prompt_again(self):
        output = self.run_setup('menu', '--include-optional', input='2\n2\n')
        self.assertIn('Optional packages: included', output)
        self.assertIn('btop', output)
        self.assertNotIn('Include these optional additions?', output)
        self.assertFalse(self.log.exists())

    def test_menu_defaults_empty_profile_selection_to_core(self):
        output = self.run_setup(input='2\n\n')
        self.assertIn('Plan: core profile(s)', output)
        self.assertNotIn('Include these optional additions?', output)
        self.assertFalse(self.log.exists())

    def test_menu_optional_no_keeps_optional_packages_excluded(self):
        output = self.run_setup(input='2\n2\nn\n')
        self.assertIn('Optional packages: excluded', output)
        self.assertNotIn('[optional]', output)
        self.assertFalse(self.log.exists())

    def test_menu_invalid_choices_retry_without_selecting_partial_profiles(self):
        output = self.run_setup(input='bad\n2\n1,7\n2\nmaybe\nn\n')
        self.assertIn('WARN Choose 1, 2, 3, or 0.', output)
        self.assertIn('WARN Choose numbers from 1 to 6', output)
        self.assertIn('WARN Enter y, n, or 0', output)
        self.assertIn('Plan: terminal profile(s)', output)
        self.assertNotIn('cask   keepassxc', output)
        self.assertFalse(self.log.exists())

    def test_menu_cancel_or_eof_at_each_step_makes_no_changes(self):
        for input in ['', '\n', '0\n', 'q\n', '1\n', '1\n0\n',
                      '1\n2\n', '1\n2\n0\n', '1\n2\nn\n', '1\n2\nn\nn\n']:
            with self.subTest(input=input):
                output = self.run_setup(input=input)
                self.assertIn('cancelled; no changes were made', output)
                self.assertFalse(self.log.exists())
                self.assertFalse(self.home.exists())

    def test_menu_dry_run_previews_install_without_applying_it(self):
        output = self.run_setup('--dry-run', input='1\n2\ny\n')
        self.assertIn('brew bundle install --no-upgrade', output)
        self.assertIn('no changes were made', output)
        self.assertNotIn('Install the missing packages in this plan?', output)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.home.exists())

    def test_menu_uninstall_reuses_package_selection_and_confirmation(self):
        output = self.run_setup(input='3\n1\nUNINSTALL\n')
        self.assertIn('Enter package numbers separated by commas', output)
        self.assertIn('Type UNINSTALL', output)
        self.assertIn('BREW:uninstall --cask keepassxc', self.log.read_text())
        self.assertNotIn('BREW:bundle', self.log.read_text())
        self.assertFalse(self.home.exists())

    def test_menu_rejects_profile_arguments_and_uninstall_package_flags(self):
        for args in [('menu', 'terminal'), ('menu', '--packages', 'ghostty')]:
            with self.subTest(args=args):
                self.run_setup(*args, status=1)
                self.assertFalse(self.log.exists())
                self.assertFalse(self.home.exists())

    def test_explicit_plan_and_install_keep_the_default_core_profile(self):
        plan = self.run_setup('plan')
        self.assertIn('Plan: core profile(s)', plan)
        self.assertNotIn('Choose an action', plan)
        output = self.run_setup('install', '--yes')
        self.assertIn('Plan: core profile(s)', output)
        self.assertNotIn('Choose an action', output)
        self.assertIn('cask "keepassxc"', self.bundle.read_text())
        self.assertNotIn('ghostty', self.bundle.read_text())

    def test_menu_custom_brewfile_limits_selection_to_that_catalog(self):
        catalog = self.root / 'custom.Brewfile'
        catalog.write_text('# workstation-package|core|brew|sevenzip|7-Zip CLI|required\n'
                           'brew "sevenzip" if false\n')
        output = self.run_setup('menu', '--brewfile', str(catalog), input='2\n1\n')
        self.assertIn('brew   sevenzip', output)
        self.assertNotIn('cask   keepassxc', output)
        self.assertFalse(self.log.exists())

    def test_plan_and_dry_run_do_not_install_or_configure(self):
        plan = self.run_setup('plan', 'terminal')
        self.assertIn('cask   ghostty', plan)
        self.assertIn('Ghostty configuration:', plan)
        self.assertIn('Zsh terminal configuration:', plan)
        self.assertIn('zsh-autosuggestions', plan)
        self.assertIn('font-jetbrains-mono-nerd-font', plan)
        preview = self.run_setup('install', 'terminal', '--dry-run')
        self.assertIn('ghostty-setup.sh --config-only', preview)
        self.assertIn('no changes were made', preview)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.config.exists())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_install_preserves_settings_and_is_idempotent(self):
        original = self.seed_config()
        self.run_setup('install', 'terminal', '--yes')
        self.assertIn('cask "ghostty"', self.bundle.read_text())
        self.assertNotIn('keepassxc', self.bundle.read_text())
        for token in ['starship', 'fzf', 'zoxide', 'eza', 'bat', 'ripgrep', 'fd',
                      'tmux', 'neovim', 'uv', 'zsh-autosuggestions',
                      'zsh-syntax-highlighting', 'zsh-completions']:
            self.assertIn('brew "' + token + '"', self.bundle.read_text())
        self.assertNotIn('brew "btop"', self.bundle.read_text())
        content = self.config.read_text()
        self.assertIn('font-size = 14', content)
        self.assertIn('font-family = JetBrainsMono Nerd Font', content)
        rc = self.home / '.zshrc'
        self.assertIn('starship init zsh', rc.read_text())
        zsh_content = rc.read_bytes()
        self.assertIn('shell-integration-features = cursor,no-sudo,title,ssh-env,ssh-terminfo,path', content)
        backups = list(self.config.parent.glob('config.ghostty.bak.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        self.assertEqual(self.log.read_text().splitlines(),
                         ['BREW:bundle install --no-upgrade --file=-', 'GHOSTTY:+validate-config'])
        self.run_setup('install', 'terminal', '--yes')
        self.assertEqual(self.config.read_text(), content)
        self.assertEqual(len(list(self.config.parent.glob('config.ghostty.bak.*'))), 1)
        self.assertEqual(rc.read_bytes(), zsh_content)
        self.assertEqual(list(self.home.glob('.zshrc.bak.*')), [])

    def test_composed_profiles_install_ghostty_once(self):
        self.run_setup('install', 'core', 'terminal', 'terminal', '--yes')
        self.assertEqual(self.bundle.read_text().count('cask "ghostty"'), 1)
        self.assertIn('cask "keepassxc"', self.bundle.read_text())
        self.assertEqual(self.bundle.read_text().count('brew "sevenzip"'), 1)
        self.assertEqual(self.bundle.read_text().count('brew "zstd"'), 1)
        self.assertEqual(self.log.read_text().count('GHOSTTY:+validate-config'), 1)

    def test_optional_terminal_monitors_are_selected_without_other_profile_options(self):
        self.run_setup('install', 'terminal', '--include-optional', '--yes')
        bundle = self.bundle.read_text()
        for token in ['btop', 'ncdu', 'duf']:
            self.assertIn('brew "' + token + '"', bundle)
        self.assertNotIn('appcleaner', bundle)
        self.assertNotIn('brew "mpv"', bundle)

    def test_other_profiles_do_not_configure_ghostty(self):
        self.run_setup('install', 'core', '--yes')
        self.assertNotIn('ghostty', self.bundle.read_text())
        self.assertNotIn('GHOSTTY:', self.log.read_text())
        self.assertFalse(self.config.exists())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_cancelled_install_does_not_touch_packages_or_config(self):
        output = self.run_setup('install', 'terminal', input='n\n')
        self.assertIn('Installation cancelled', output)
        self.assertFalse(self.log.exists())
        self.assertFalse(self.config.exists())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_failed_package_install_does_not_write_config(self):
        self.run_setup('install', 'terminal', '--yes', status=7,
                       overrides={'TEST_BREW_STATUS': '7'})
        self.assertNotIn('GHOSTTY:', self.log.read_text())
        self.assertFalse(self.config.exists())
        self.assertFalse((self.home / '.zshrc').exists())

    def test_missing_zsh_helper_is_reported_before_installing_packages(self):
        isolated = self.root / 'isolated/macos'
        shared = isolated.parent / 'shared'
        isolated.mkdir(parents=True)
        shared.mkdir()
        (isolated / 'setup.sh').write_bytes(SETUP.read_bytes())
        (isolated / 'Brewfile').write_bytes(SETUP.with_name('Brewfile').read_bytes())
        (shared / 'ghostty-setup.sh').write_bytes((SETUP.parent.parent / 'shared/ghostty-setup.sh').read_bytes())
        output = self.run_setup('install', 'terminal', '--yes', status=1,
                                setup=isolated / 'setup.sh')
        self.assertIn('Zsh configuration helper or template not found', output)
        self.assertFalse(self.log.exists())

    def test_missing_helper_is_reported_before_installing_packages(self):
        isolated = self.root / 'isolated/macos'
        isolated.mkdir(parents=True)
        (isolated / 'setup.sh').write_bytes(SETUP.read_bytes())
        (isolated / 'Brewfile').write_bytes(SETUP.with_name('Brewfile').read_bytes())
        output = self.run_setup('install', 'terminal', '--yes', status=1,
                                setup=isolated / 'setup.sh')
        self.assertIn('Ghostty configuration helper not found', output)
        self.assertFalse(self.log.exists())

    def test_config_validation_failure_is_reported_and_backup_retained(self):
        original = self.seed_config()
        output = self.run_setup('install', 'terminal', '--yes', status=1,
                                overrides={'TEST_GHOSTTY_STATUS': '1'})
        self.assertIn('Ghostty rejected the configuration', output)
        self.assertNotIn('Requested utility packages are installed', output)
        backups = list(self.config.parent.glob('config.ghostty.bak.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        self.assertFalse((self.home / '.zshrc').exists())

    def test_later_macos_config_is_preserved_and_warned_about(self):
        legacy = self.home / 'Library/Application Support/com.mitchellh.ghostty/config.ghostty'
        legacy.parent.mkdir(parents=True)
        legacy.write_text('font-size = 18\n')
        output = self.run_setup('install', 'terminal', '--yes')
        self.assertIn('macOS also loads this later config', output)
        self.assertEqual(legacy.read_text(), 'font-size = 18\n')

    def test_existing_font_choice_is_preserved(self):
        self.seed_config()
        self.config.write_text('font-family = Menlo\nfont-size = 16\n')
        self.run_setup('install', 'terminal', '--yes')
        self.assertIn('font-family = Menlo', self.config.read_text())
        self.assertNotIn('JetBrainsMono Nerd Font', self.config.read_text())

    def test_legacy_macos_font_or_included_config_prevents_default_font_override(self):
        legacy = self.home / 'Library/Application Support/com.mitchellh.ghostty/config.ghostty'
        legacy.parent.mkdir(parents=True)
        for choice in ['font-family = Menlo\n', 'config-file = custom.ghostty\n']:
            with self.subTest(choice=choice):
                legacy.write_text(choice)
                self.run_setup('install', 'terminal', '--yes')
                self.assertNotIn('JetBrainsMono Nerd Font', self.config.read_text())
                self.assertEqual(legacy.read_text(), choice)

    def test_older_xdg_config_settings_are_carried_forward(self):
        legacy = self.home / '.config/ghostty/config'
        legacy.parent.mkdir(parents=True)
        legacy.write_text('font-family = Menlo\nfont-size = 19\n')
        self.run_setup('install', 'terminal', '--yes')
        self.assertIn('font-family = Menlo', self.config.read_text())
        self.assertIn('font-size = 19', self.config.read_text())
        self.assertNotIn('JetBrainsMono Nerd Font', self.config.read_text())
        self.assertEqual(legacy.read_text(), 'font-family = Menlo\nfont-size = 19\n')

    def test_invalid_existing_zsh_configuration_is_preserved_and_failure_surfaces(self):
        self.home.mkdir()
        rc = self.home / '.zshrc'
        rc.write_text('export BROKEN="unterminated\n')
        output = self.run_setup('install', 'terminal', '--yes', status=1)
        self.assertIn('Zsh rejected the configuration', output)
        self.assertEqual(rc.read_text(), 'export BROKEN="unterminated\n')
        self.assertEqual(list(self.home.glob('.zshrc.bak.*')), [])
        self.assertNotIn('Requested utility packages are installed', output)

    def test_uninstall_removes_only_the_cask_and_preserves_configuration(self):
        original = self.seed_config()
        self.run_setup('uninstall', '--packages', 'ghostty', '--yes')
        self.assertIn('BREW:uninstall --cask ghostty', self.log.read_text())
        self.assertNotIn('GHOSTTY:', self.log.read_text())
        self.assertEqual(self.config.read_text(), original)


if __name__ == '__main__':
    unittest.main()
