import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'validate.py'
spec = importlib.util.spec_from_file_location('validation', MODULE)
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class DiscoveryTests(unittest.TestCase):
    def test_node_and_shell_discovery_ignores_dependencies_and_build_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            expected = ['deep/new.test.mjs', 'other.test.cjs', 'test.mjs']
            for name in expected + ['node_modules/vendor/bad.test.mjs', 'dist/bad.test.mjs', 'tests/new-test.sh']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            with patch.object(validation, 'run') as run:
                validation.node_tests(temp)
                self.assertEqual(set(run.call_args.args[2:]), {root / name for name in expected})
                validation.shell_tests(temp)
                self.assertEqual(run.call_args.args, ('bash', root / 'tests/new-test.sh'))

    def test_missing_component_fails_instead_of_silently_skipping(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(FileNotFoundError):
                validation.files(str(Path(temp) / 'missing'), ('*.test.mjs',))

    def test_missing_server_tests_are_discovered(self):
        scripts = {p.name for p in validation.files('server-toolkit/tests', ('test_*.py', '*-test.sh', 'test_*.sh'))}
        self.assertTrue({'test_fail2ban.py', 'test_capture_privacy.py', 'test_login_notify.py',
                         'test_bug_regressions.py', 'cloudflare-ddns-test.sh', 'vnstat-traffic-firewall-test.sh'} <= scripts)

    def test_workflows_are_pinned_and_scoped(self):
        import re
        root = MODULE.parents[1]
        for workflow in (root / '.github/workflows').glob('*.yml'):
            text = workflow.read_text()
            for action in re.findall(r'uses:\s+([^\s#]+)', text):
                self.assertTrue(action.startswith('./') or re.search(r'@[a-f0-9]{40}$', action), action)
            if workflow.name.startswith('validate'):
                self.assertIn('paths:', text, workflow.name)
                self.assertIn('scripts/validate.py', text, workflow.name)


if __name__ == '__main__':
    unittest.main()
