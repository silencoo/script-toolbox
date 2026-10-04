#!/usr/bin/env python3
"""Check saved command history using temporary files and real Zsh history."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

TOOLKIT = Path(__file__).resolve().parents[1] / 'server-toolkit.sh'


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='toolkit-history-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.seed_file = self.root / 'user' / '.config' / 'linux-server-toolkit' / 'command-history'
        self.history_file = self.root / 'custom-history'
        self.history_file.write_text(': 1700000000:0;echo existing-command\n')

    def shell(self, code, *, dry_run='0'):
        prefix = r'''source "$1"
TEST_TMP="$2"
INSTALL_HOME="$TEST_TMP/user"
INSTALL_USER="$(id -un)"
LOG_FILE="$TEST_TMP/toolkit.log"
BACKUP_DIR="$TEST_TMP/backups"
run_as_user() { bash -c "$1"; }
'''
        child = subprocess.run(
            ['bash', '-c', prefix + code, 'history-test', str(TOOLKIT), str(self.root)],
            text=True, capture_output=True, timeout=15,
            env=dict(os.environ, DRY_RUN=dry_run, TOOLKIT_LANG='en'),
        )
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertNotIn('unbound variable', child.stderr)
        return child.stdout

    def history_script(self):
        block = self.shell('terminal_zshrc_block')
        complete = self.root / 'zshrc'
        complete.write_text(block)
        subprocess.run(['zsh', '-n', str(complete)], check=True, capture_output=True)
        # Load the emitted history configuration without sourcing the
        # developer's personal Oh My Zsh setup or modifying their home.
        history = block.split('# Persistent command history, shared by SSH sessions.\n', 1)[1]
        script = self.root / 'history.zsh'
        script.write_text(history.split('# Optional prompt and navigation tools.\n', 1)[0])
        return script

    def zsh(self, code, *, env=None):
        child = subprocess.run(
            ['zsh', '-f', '-ic', 'source "$1"\n' + code,
             'history-session', str(self.history_script())],
            text=True, capture_output=True, timeout=15,
            env=dict(os.environ, HISTFILE=str(self.history_file),
                     TOOLKIT_HISTORY_SEEDS=str(self.seed_file), **(env or {})),
        )
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertEqual(child.stderr, '')
        return child.stdout

    def test_first_install_creates_private_user_owned_defaults_and_records_change(self):
        output = self.shell('''install_terminal_history
printf 'OPERATIONS:%s\n' "${#OPERATION_TARGETS[@]}"
''')
        self.assertIn('OPERATIONS:1', output)
        self.assertIn('claude --dangerously-skip-permissions', self.seed_file.read_text())
        self.assertEqual(self.seed_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.seed_file.stat().st_uid, os.getuid())
        self.assertEqual(self.seed_file.stat().st_gid, os.getgid())
        self.assertEqual(self.history_file.read_text(), ': 1700000000:0;echo existing-command\n')

    def test_reinstall_keeps_custom_additions_and_removed_defaults(self):
        self.seed_file.parent.mkdir(parents=True)
        custom = '# My commands\nclaude --continue\nmy-special-command --option\n'
        self.seed_file.write_text(custom)
        output = self.shell('''install_terminal_history
printf 'OPERATIONS:%s\n' "${#OPERATION_TARGETS[@]}"
''')
        self.assertIn('OPERATIONS:0', output)
        self.assertEqual(self.seed_file.read_text(), custom)

    def test_dry_run_creates_no_seed_file_or_directory(self):
        output = self.shell('install_terminal_history', dry_run='1')
        self.assertIn('[DRY RUN]', output)
        self.assertFalse(self.seed_file.parent.exists())

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_import_is_deduplicated_preserves_history_and_never_executes_commands(self):
        self.seed_file.parent.mkdir(parents=True)
        marker = self.root / 'must-not-execute'
        self.seed_file.write_text(
            '# a comment\n\nclaude --dangerously-skip-permissions\n'
            'claude --dangerously-skip-permissions\n'
            f'touch "{marker}"\n'
            f'printf "%s" "$(touch {marker})"\n'
        )
        output = self.zsh('''source "$1"
builtin fc -ln 1
printf 'HISTFILE:%s\nSIZES:%s,%s\n' "$HISTFILE" "$HISTSIZE" "$SAVEHIST"
''')
        self.assertEqual(output.count('claude --dangerously-skip-permissions'), 1)
        self.assertIn('echo existing-command', output)
        self.assertNotIn('# a comment', output)
        self.assertFalse(marker.exists())
        self.assertIn(f'HISTFILE:{self.history_file}', output)
        self.assertIn('SIZES:100000,50000', output)
        self.assertIn('echo existing-command', self.history_file.read_text())
        # A new SSH session gets the presets again, with no duplicate entries.
        self.assertEqual(self.zsh('builtin fc -ln 1').count('claude --dangerously-skip-permissions'), 1)

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_missing_presets_and_fzf_leave_native_ctrl_r_search_working(self):
        # Explicitly make fzf unavailable while keeping the real Zsh builtins.
        script = self.history_script()
        code = r'''command() {
    if [[ "$1" == '-v' && "$2" == fzf ]]; then return 1; fi
    builtin command "$@"
}
source "$1"
bindkey -M emacs '^R'
bindkey -M viins '^R'
'''
        child = subprocess.run(
            ['zsh', '-f', '-ic', code, 'native-history-test', str(script)],
            text=True, capture_output=True, timeout=15,
            env=dict(os.environ, HISTFILE=str(self.history_file),
                     TOOLKIT_HISTORY_SEEDS=str(self.seed_file)),
        )
        self.assertEqual(child.returncode, 0, child.stdout + child.stderr)
        self.assertEqual(child.stderr, '')
        self.assertEqual(child.stdout.count('history-incremental-search-backward'), 2)

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_recent_fzf_integration_sets_ctrl_r_without_running_selection(self):
        fake_bin = self.root / 'bin'
        fake_bin.mkdir()
        fake_fzf = fake_bin / 'fzf'
        fake_fzf.write_text('''#!/bin/sh
if [ "$1" != --zsh ]; then echo UNEXPECTED_SELECTION >&2; exit 99; fi
cat <<'EOF'
fzf-history-widget() { BUFFER='claude --dangerously-skip-permissions'; }
zle -N fzf-history-widget
bindkey -M emacs '^R' fzf-history-widget
EOF
''')
        fake_fzf.chmod(0o755)
        output = self.zsh("bindkey -M emacs '^R'", env={
            'PATH': str(fake_bin) + ':' + os.environ['PATH'],
        })
        self.assertIn('fzf-history-widget', output)
        self.assertNotIn('UNEXPECTED_SELECTION', output)

    @unittest.skipUnless(shutil.which('zsh'), 'requires zsh')
    def test_saved_commands_survive_between_sessions(self):
        self.zsh("print -s -- 'echo new-session-command'\nbuiltin fc -AI \"$HISTFILE\"")
        output = self.zsh('builtin fc -ln 1')
        self.assertIn('echo existing-command', output)
        self.assertIn('echo new-session-command', output)


if __name__ == '__main__':
    unittest.main()
