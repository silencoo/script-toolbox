"""Configuration preservation and real Starship render previews (when installed)."""
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import unittest

SHARED = Path(__file__).resolve().parents[1] / 'shared'
spec = importlib.util.spec_from_file_location('prompt_setup', SHARED / 'starship-prompt-setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
TEMPLATE = (SHARED / 'starship-prompt.toml').read_text()


class PromptTests(unittest.TestCase):
    def test_merge_preserves_customization(self):
        source = '''# my settings
command_timeout = 10000
format = """
$directory
$character"""
[directory]
style = 'bold blue'
truncation_length = 2
[aws]
disabled = true
[custom.example]
command = 'echo hello'
'''
        merged = setup.merge(source, TEMPLATE)
        data = tomllib.loads(merged)
        self.assertIn('# my settings', merged)
        self.assertEqual(data['directory']['style'], 'bold blue')
        self.assertEqual(data['directory']['truncation_length'], 2)
        self.assertTrue(data['aws']['disabled'])
        self.assertEqual(data['custom']['example']['command'], 'echo hello')
        self.assertEqual(data['command_timeout'], 500)
        self.assertEqual(setup.merge(merged, TEMPLATE), merged)

    def test_unsupported_layout_fails_closed(self):
        with self.assertRaises(ValueError):
            setup.merge('"format" = "$all"\n', TEMPLATE)

    def test_backup_symlink_and_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'real'
            link = Path(tmp) / 'link'
            target.write_text('original')
            target.chmod(0o640)
            link.symlink_to(target)
            setup.write_backed_up(link, 'updated')
            setup.write_backed_up(link, 'updated')
            self.assertTrue(link.is_symlink())
            backups = list(Path(tmp).glob('real.bak.*'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), 'original')
            self.assertEqual(target.stat().st_mode & 0o777, 0o640)

    def test_script_opt_in_and_existing_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            rc = home / '.zshrc'
            rc.write_text('# custom\neval "$(starship init zsh)"\n')
            original = rc.read_bytes()
            env = dict(os.environ, HOME=tmp, ZDOTDIR=tmp,
                       STARSHIP_CONFIG=str(home / 'custom.toml'))
            subprocess.run(['python3', str(SHARED / 'starship-prompt-setup.py')],
                           env=env, check=True, capture_output=True)
            self.assertEqual(rc.read_bytes(), original)
            self.assertFalse(list(home.glob('.zshrc.bak.*')))
            self.assertTrue((home / 'custom.toml').exists())

    @unittest.skipUnless(shutil.which('starship'), 'Starship not installed')
    def test_render_previews(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            config = home / 'starship.toml'
            subprocess.run(['bash', str(SHARED / 'ghostty-setup.sh'),
                            '--config-only', '--no-validate', '--prompt'],
                           env=dict(os.environ, HOME=tmp, ZDOTDIR=tmp,
                                    STARSHIP_CONFIG=str(config)), check=True, capture_output=True)
            self.assertEqual(tomllib.loads(config.read_text()), tomllib.loads(TEMPLATE))
            normal = home / 'normal'
            normal.mkdir()
            env = {k: v for k, v in os.environ.items() if not k.startswith(
                ('STARSHIP_', 'SSH_', 'DOCKER_', 'VIRTUAL_ENV', 'CONDA_'))}
            env.update(STARSHIP_CONFIG=str(config), STARSHIP_SHELL='sh',
                       STARSHIP_CACHE=str(home / 'cache'), HOME=tmp)

            def render(path=normal, extra=None, **values):
                args = ['starship', 'prompt', '--path', str(path), '--logical-path', str(path)]
                for key, value in values.items():
                    args.extend(['--' + key.replace('_', '-'), str(value)])
                result = subprocess.run(args, cwd=path, env=dict(env, PWD=str(path), **(extra or {})),
                                        text=True, capture_output=True, check=True)
                self.assertNotIn('WARN', result.stderr)
                self.assertNotIn('ERROR', result.stderr)
                return re.sub(r'\x1b\[[0-9;]*m', '', result.stdout)

            plain = render(status=0, jobs=0, cmd_duration=2000)
            self.assertEqual(plain.count('\n'), 1)
            for hidden in ['exit:', 'jobs:', 'took ', 'SSH', 'node ', 'py ', 'docker:', 'container:']:
                self.assertNotIn(hidden, plain)
            self.assertIn('@', plain)
            self.assertIn('❯', plain.split('\n')[1])
            failed = render(status=42)
            self.assertIn('exit:42', failed.split('\n')[1])
            jobs = render(jobs=1)
            self.assertIn('jobs:1', jobs.split('\n')[1])
            self.assertIn('jobs:2', render(jobs=2))
            self.assertIn('took ', render(cmd_duration=2001))
            ssh = render(extra={'SSH_CONNECTION': '192.0.2.1 1000 192.0.2.2 22'})
            self.assertIn('SSH', ssh.split('\n')[0])
            self.assertIn('docker:preview', render(extra={'DOCKER_CONTEXT': 'preview'}))
            # No daemon is contacted; context is read from the environment/config.
            repo = home / 'project'
            repo.mkdir()
            subprocess.run(['git', 'init', '-b', 'preview', str(repo)], check=True, capture_output=True)
            (repo / 'untracked.txt').write_text('preview')
            git = render(repo)
            self.assertIn('preview', git)
            self.assertIn('?', git)
            if shutil.which('node'):
                (repo / 'package.json').write_text('{"name":"preview", "version":"1.0.0"}')
                self.assertIn('node v', render(repo))
            if shutil.which('python3'):
                self.assertIn('py v', render(extra={'VIRTUAL_ENV': str(home / 'preview-venv')}))
                self.assertIn('preview-venv', render(extra={'VIRTUAL_ENV': str(home / 'preview-venv')}))
            right = subprocess.run(['starship', 'prompt', '--right'], env=env,
                                   text=True, capture_output=True, check=True)
            self.assertRegex(right.stdout, r'\d{2}:\d{2}:\d{2}')
            for label, preview in [('normal', plain), ('git', git), ('failure', failed),
                                   ('background job', jobs), ('SSH (simulated)', ssh)]:
                anonymized = re.sub(r'^[^ @\n]+@[^ \n]+', 'user@host', preview)
                print(f'\n{label}:\n{anonymized}')


if __name__ == '__main__':
    unittest.main()
