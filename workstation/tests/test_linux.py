"""Exercise installation boundaries with fake package managers, never the host."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'linux/setup.py'
spec = importlib.util.spec_from_file_location('linux_setup', SOURCE)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class LinuxInstallerTest(unittest.TestCase):
    def setUp(self):
        self.catalog = setup.load_catalog()
        self.apps = setup.select_packages(self.catalog, ['apps'], 'all')
        self.apt = setup.package_ids(self.apps, 'apt')
        self.flatpak = setup.package_ids(self.apps, 'flatpak')
        self.addCleanup(patch.stopall)
        self.output = io.StringIO()
        patch('sys.stdout', self.output).start()
        patch('sys.stderr', self.output).start()

    def fake_host(self):
        patch.object(setup, 'require_debian').start()
        patch.object(setup.os, 'geteuid', return_value=1000, create=True).start()
        patch.object(setup.shutil, 'which', side_effect=lambda name: '/fixture/' + name).start()

    def test_apps_preserves_the_migrated_set_and_profiles_deduplicate(self):
        self.assertEqual(self.apt, ['firefox-esr'])
        self.assertEqual(set(self.flatpak), {
            'com.vscodium.codium', 'org.localsend.localsend_app', 'org.keepassxc.KeePassXC',
            'com.moonlight_stream.Moonlight', 'com.discordapp.Discord', 'org.gnome.Loupe',
        })
        composed = setup.select_packages(self.catalog, ['apps', 'core', 'desktop', 'admin'], 'all')
        self.assertEqual(composed, self.apps)

    def test_default_plan_and_dry_run_do_not_probe_or_install(self):
        with patch.object(setup.subprocess, 'run') as run, \
                patch.object(setup.shutil, 'which') as which, \
                patch.object(setup, 'require_debian') as require:
            for args in ([], ['plan', 'apps'], ['install', 'apps', '--dry-run', '--yes']):
                self.assertEqual(setup.main(args), 0)
            run.assert_not_called()
            which.assert_not_called()
            require.assert_not_called()
        self.assertIn('flatpak install --user flathub', self.output.getvalue())
        self.assertIn('apt-get install --no-upgrade', self.output.getvalue())

    def test_invalid_profiles_and_empty_filter_fail_before_probing(self):
        with patch.object(setup.subprocess, 'run') as run:
            self.assertEqual(setup.main(['install', 'unknown', '--yes']), 1)
            self.assertEqual(setup.main(['install', 'admin', '--manager', 'apt', '--yes']), 1)
            run.assert_not_called()

    def test_manager_filter_preserves_flatpak_bootstrap_only(self):
        selected = setup.select_packages(self.catalog, ['apps'], 'flatpak')
        self.assertEqual(setup.package_ids(selected, 'apt'), [])
        setup.show_plan(selected, ['apps'])
        self.assertNotIn('firefox-esr', self.output.getvalue())
        self.assertIn('install --no-upgrade flatpak', self.output.getvalue())

    def test_installed_apps_are_skipped_without_mutations(self):
        self.fake_host()
        with patch.object(setup, 'installed_apt', return_value=set(self.apt)), \
                patch.object(setup, 'installed_flatpak', return_value=set(self.flatpak)), \
                patch.object(setup, 'execute') as execute, patch('builtins.input') as prompt:
            setup.install(self.apps, False)
            execute.assert_not_called()
            prompt.assert_not_called()

    def test_only_missing_apps_are_installed_in_user_scope(self):
        self.fake_host()
        with patch.object(setup, 'installed_apt', return_value=set()), \
                patch.object(setup, 'installed_flatpak', return_value=set(self.flatpak[1:])), \
                patch.object(setup, 'execute') as execute:
            setup.install(self.apps, True)
        self.assertEqual([call.args[0] for call in execute.call_args_list], [
            ['sudo', 'apt-get', 'update'],
            ['sudo', 'apt-get', 'install', '--no-upgrade', 'firefox-esr'],
            ['flatpak', 'remote-add', '--user', '--if-not-exists', 'flathub', setup.FLATHUB],
            ['flatpak', 'install', '--user', 'flathub', self.flatpak[0]],
        ])

    def test_bootstrap_flatpak_then_recheck_retained_apps(self):
        self.fake_host()
        commands = []
        def which(name):
            return '/fixture/flatpak' if commands else None
        with patch.object(setup.shutil, 'which', side_effect=which), \
                patch.object(setup, 'installed_apt', return_value=set(self.apt)), \
                patch.object(setup, 'installed_flatpak', return_value=set(self.flatpak)) as inventory, \
                patch.object(setup, 'execute', side_effect=commands.append):
            setup.install(self.apps, True)
        self.assertEqual(commands, [['sudo', 'apt-get', 'update'],
                                    ['sudo', 'apt-get', 'install', '--no-upgrade', 'flatpak']])
        inventory.assert_called_once()

    def test_cancel_and_input_eof_do_not_install(self):
        self.fake_host()
        with patch.object(setup, 'installed_apt', return_value=set()), \
                patch.object(setup, 'installed_flatpak', return_value=set()), \
                patch.object(setup, 'execute') as execute:
            with patch('builtins.input', return_value='n'):
                setup.install(self.apps, False)
            with patch('builtins.input', side_effect=EOFError):
                setup.install(self.apps, False)
            execute.assert_not_called()

    def test_inventory_failure_stops_before_apt_mutation(self):
        self.fake_host()
        with patch.object(setup, 'installed_apt', return_value=set()), \
                patch.object(setup, 'installed_flatpak', side_effect=subprocess.CalledProcessError(1, 'flatpak')), \
                patch.object(setup, 'execute') as execute:
            self.assertEqual(setup.main(['install', 'apps', '--yes']), 1)
            execute.assert_not_called()

    def test_apt_failure_stops_before_flatpak_mutation(self):
        self.fake_host()
        with patch.object(setup, 'installed_apt', return_value=set()), \
                patch.object(setup, 'installed_flatpak', return_value=set()), \
                patch.object(setup, 'execute', side_effect=subprocess.CalledProcessError(1, 'apt-get')) as execute:
            self.assertEqual(setup.main(['install', 'apps', '--yes']), 1)
            self.assertEqual(execute.call_args_list[0].args[0], ['sudo', 'apt-get', 'update'])
            self.assertEqual(execute.call_count, 1)

    def test_root_cannot_install_user_flatpaks(self):
        self.fake_host()
        with patch.object(setup.os, 'geteuid', return_value=0), \
                patch.object(setup.subprocess, 'run') as run:
            self.assertEqual(setup.main(['install', 'apps', '--yes']), 1)
            run.assert_not_called()

    def test_unsupported_os_is_rejected_before_package_queries(self):
        with patch.object(setup.platform, 'system', return_value='Darwin'), \
                patch.object(setup.subprocess, 'run') as run:
            self.assertEqual(setup.main(['install', 'apps', '--yes']), 1)
            run.assert_not_called()
        with patch.object(setup.platform, 'system', return_value='Linux'), \
                patch.object(Path, 'read_text', return_value='ID=ubuntu\nVERSION_ID="24.04"\n'):
            with self.assertRaisesRegex(RuntimeError, 'Debian 13'):
                setup.require_debian()
        with patch.object(setup.platform, 'system', return_value='Linux'), \
                patch.object(Path, 'read_text', return_value='ID=debian\nVERSION_ID="13"\n'):
            setup.require_debian()

    def test_dpkg_status_distinguishes_installed_from_removed_or_unconfigured(self):
        result = subprocess.CompletedProcess([], 1, 'firefox-esr:amd64 ii \nflatpak rc \nother iU \n', '')
        with patch.object(setup.subprocess, 'run', return_value=result):
            self.assertEqual(setup.installed_apt(['firefox-esr', 'flatpak', 'other']), {'firefox-esr'})
        with patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 2, '', 'error')):
            with self.assertRaises(RuntimeError):
                setup.installed_apt(['firefox-esr'])

    def test_flatpak_inventory_deduplicates_user_and_system_copies(self):
        result = subprocess.CompletedProcess([], 0, 'com.vscodium.codium\ncom.vscodium.codium\n', '')
        with patch.object(setup.subprocess, 'run', return_value=result) as run:
            self.assertEqual(setup.installed_flatpak(), {'com.vscodium.codium'})
            self.assertEqual(run.call_args.args[0], ['flatpak', 'list', '--app', '--columns=application'])

    def test_apt_only_profile_does_not_query_flatpak(self):
        self.fake_host()
        packages = setup.select_packages(self.catalog, ['apps'], 'apt')
        with patch.object(setup, 'installed_apt', return_value={'firefox-esr'}), \
                patch.object(setup, 'installed_flatpak') as inventory, \
                patch.object(setup, 'execute') as execute:
            setup.install(packages, True)
            inventory.assert_not_called()
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
