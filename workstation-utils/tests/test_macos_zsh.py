#!/usr/bin/env python3
"""Validate managed Zsh configuration and exercise it in real Zsh sessions."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[1] / 'macos/terminal-setup.sh'
ZSH = shutil.which('zsh')
BEGIN = '# >>> script-toolbox macOS terminal >>>'
END = '# <<< script-toolbox macOS terminal <<<'


@unittest.skipUnless(ZSH, 'Zsh is required for shell syntax and runtime checks')
class MacOSZshTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workstation-zsh-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.rc = self.home / '.zshrc'
        self.prefix = self.root / 'brew-prefix'
        self.log = self.root / 'integration.log'
        self.env = dict(os.environ, HOME=str(self.home), ZDOTDIR=str(self.home),
                        HOMEBREW_PREFIX=str(self.prefix), TERM='xterm-256color',
                        TEST_LOG=str(self.log), PATH='/usr/bin:/bin:/usr/sbin:/sbin')

    def configure(self, *args, status=0, helper=HELPER):
        child = subprocess.run(['bash', str(helper), *args], env=self.env,
                               capture_output=True, text=True, timeout=15)
        output = child.stdout + child.stderr
        self.assertEqual(child.returncode, status, output)
        return output

    def shell(self, code):
        child = subprocess.run([ZSH, '-i', '-c', code], env=self.env,
                               capture_output=True, text=True, timeout=15)
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        return child.stdout, child.stderr

    def make_tools(self):
        tools = {
            'starship': "printf 'PROMPT=toolbox-test\\n'",
            'zoxide': "printf 'function __zoxide_z() { :; }; function z() { :; }\\n'",
            'fzf': "printf 'function fzf-history-widget() { :; }\\n'",
            'uv': "printf 'compdef _files uv\\n'",
            'eza': ':', 'bat': ':', 'nvim': ':',
        }
        for name, body in tools.items():
            executable = self.prefix / 'bin' / name
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_text('#!/bin/sh\nprintf "%s\\n" "' + name + ':$*" >> "$TEST_LOG"\n' + body + '\n')
            executable.chmod(0o755)
        for directory, filename, function, label in [
            ('zsh-autosuggestions', 'zsh-autosuggestions.zsh', '_zsh_autosuggest_start', 'autosuggest'),
            ('zsh-syntax-highlighting', 'zsh-syntax-highlighting.zsh', '_zsh_highlight', 'highlight'),
        ]:
            plugin = self.prefix / 'share' / directory / filename
            plugin.parent.mkdir(parents=True, exist_ok=True)
            plugin.write_text('print -r -- ' + label + ' >> "$TEST_LOG"\nfunction ' + function + '() { :; }\n')
        (self.prefix / 'share/zsh-completions').mkdir()
        (self.prefix / 'share/zsh/site-functions').mkdir(parents=True)

    def test_creates_configuration_and_repeat_install_does_not_rewrite(self):
        self.configure()
        original = self.rc.read_bytes()
        modified = self.rc.stat().st_mtime_ns
        self.assertEqual(original.decode().count(BEGIN), 1)
        self.assertEqual(original.decode().count(END), 1)
        self.assertIn('starship init zsh', original.decode())
        self.assertIn('already current', self.configure())
        self.assertEqual(self.rc.read_bytes(), original)
        self.assertEqual(self.rc.stat().st_mtime_ns, modified)
        self.assertEqual(list(self.home.glob('.zshrc.bak.*')), [])

    def test_replaces_old_block_and_preserves_user_content_permissions_and_backup(self):
        original = "# User settings\nexport EDITOR=vim\nalias ls='ls -G'\n" + BEGIN + '\n# old\n' + END + '\n# Keep this tail\n'
        self.rc.write_text(original)
        self.rc.chmod(0o640)
        self.configure()
        content = self.rc.read_text()
        self.assertIn("alias ls='ls -G'", content)
        self.assertIn('# Keep this tail', content)
        self.assertNotIn('# old', content)
        self.assertEqual(content.count(BEGIN), 1)
        self.assertEqual(self.rc.stat().st_mode & 0o777, 0o640)
        backups = list(self.home.glob('.zshrc.bak.*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        self.configure()
        self.assertEqual(self.rc.read_text(), content)
        self.assertEqual(list(self.home.glob('.zshrc.bak.*')), backups)

    def test_respects_zdotdir(self):
        directory = self.root / 'alternate-zdotdir'
        self.env['ZDOTDIR'] = str(directory)
        self.configure()
        self.assertTrue((directory / '.zshrc').is_file())
        self.assertFalse(self.rc.exists())

    def test_preserves_relative_symlink_and_backs_up_its_target(self):
        target = self.home / 'dotfiles/custom.zsh'
        target.parent.mkdir()
        target.write_text('# Linked user configuration\n')
        self.rc.symlink_to('dotfiles/custom.zsh')
        self.configure()
        self.assertTrue(self.rc.is_symlink())
        self.assertIn(BEGIN, target.read_text())
        backup = list(target.parent.glob('custom.zsh.bak.*'))
        self.assertEqual(len(backup), 1)
        self.assertEqual(backup[0].read_text(), '# Linked user configuration\n')

    def test_invalid_zsh_source_is_preserved(self):
        original = 'export BROKEN="unterminated\n'
        self.rc.write_text(original)
        self.assertIn('Zsh rejected', self.configure(status=1))
        self.assertEqual(self.rc.read_text(), original)
        self.assertEqual(list(self.home.glob('.zshrc.bak.*')), [])
        self.assertEqual(list(self.home.glob('.zshrc.toolbox.*')), [])

    def test_malformed_markers_are_preserved(self):
        for original in [BEGIN + '\n# unfinished\n', END + '\n',
                         BEGIN + '\n' + END + '\n' + BEGIN + '\n' + END + '\n']:
            with self.subTest(original=original):
                self.rc.write_text(original)
                self.assertIn('unmatched or duplicate markers', self.configure(status=1))
                self.assertEqual(self.rc.read_text(), original)

    def test_dry_run_does_not_create_directories_or_config(self):
        directory = self.root / 'missing-zdotdir'
        self.env['ZDOTDIR'] = str(directory)
        self.assertIn('Would update', self.configure('--dry-run'))
        self.assertFalse(directory.exists())

    def test_missing_template_fails_without_writing(self):
        isolated = self.root / 'isolated-helper.sh'
        isolated.write_bytes(HELPER.read_bytes())
        self.assertIn('Zsh template not found', self.configure(status=1, helper=isolated))
        self.assertFalse(self.rc.exists())

    def test_actual_zsh_session_initializes_tools_completion_aliases_and_plugins(self):
        self.make_tools()
        self.configure()
        out, err = self.shell('print -r -- "PROMPT=$PROMPT" "EDITOR=$EDITOR" "LS=${aliases[ls]}" "CAT=${aliases[cat]}"; whence -w z; print -r -- "HISTORY=$HISTSIZE/$SAVEHIST"; print -rl -- $fpath')
        self.assertEqual(err, '')
        self.assertIn('PROMPT=toolbox-test', out)
        self.assertIn('EDITOR=nvim', out)
        self.assertIn('LS=eza --icons', out)
        self.assertIn('CAT=bat --paging=never', out)
        self.assertIn('z: function', out)
        self.assertIn('HISTORY=10000/10000', out)
        self.assertIn(str(self.prefix / 'share/zsh-completions'), out)
        self.assertEqual(self.log.read_text().splitlines(),
                         ['fzf:--zsh', 'zoxide:init zsh', 'starship:init zsh',
                          'uv:generate-shell-completion zsh', 'autosuggest', 'highlight'])

    def test_user_editor_aliases_and_existing_plugins_survive_runtime_initialization(self):
        self.make_tools()
        self.rc.write_text("export EDITOR=vim\nalias ls='ls -G'\nfunction ll() { :; }\nfunction _zsh_autosuggest_start() { :; }\nfunction _zsh_highlight() { :; }\n")
        self.configure()
        out, err = self.shell('print -r -- "EDITOR=$EDITOR" "LS=${aliases[ls]}"; whence -w ll')
        self.assertEqual(err, '')
        self.assertIn('EDITOR=vim', out)
        self.assertIn('LS=ls -G', out)
        self.assertIn('ll: function', out)
        self.assertNotIn('autosuggest', self.log.read_text())
        self.assertNotIn('highlight', self.log.read_text())

    def test_missing_optional_executables_do_not_break_shell_startup(self):
        self.configure()
        out, err = self.shell('print -r -- shell-started')
        self.assertEqual(err, '')
        self.assertIn('shell-started', out)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
