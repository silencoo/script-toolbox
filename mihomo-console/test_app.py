"""Native installation, core rollback and controller regression tests."""
import copy
import gzip
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import mihomo_console as manager
from test_locale import make_console


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.registry = copy.deepcopy(manager.DEFAULTS)
        self.registry.update(
            mihomo_binary=str(self.root / 'mihomo'), mihomo_home=str(self.root),
            target_config=str(self.root / 'config.yaml'), overlay_file=str(self.root / 'overlay.yaml'),
            backup_dir=str(self.root / 'backups'), lock_file=str(self.root / 'lock'),
        )
        self.binary = Path(self.registry['mihomo_binary'])
        self.target = Path(self.registry['target_config'])
        self.overlay = Path(self.registry['overlay_file'])
        self.config = self.root / 'manager.json'
        language = mock.patch.object(manager, 'LANGUAGE', 'zh_CN')
        language.start()
        self.addCleanup(language.stop)

    def properties(self, active='inactive'):
        return {'LoadState': 'loaded', 'ActiveState': active,
                'ExecStart': f'{{ path={self.binary} ; argv[]={self.binary} -d {self.root} ; }}'}

    @staticmethod
    def success():
        return subprocess.CompletedProcess([], 0, '')

    @staticmethod
    def release(architecture='amd64-v1', digest=None):
        name = f'mihomo-linux-{architecture}-v1.19.30.gz'
        return {'tag_name': 'v1.19.30', 'assets': [{
            'name': name, 'digest': digest or 'sha256:' + 'a' * 64,
            'browser_download_url': 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/' + name,
        }]}

    def seed_config(self):
        self.target.write_text('mode: rule\nexternal-controller: 0.0.0.0:9090\nsecret: test-secret\nproxies: []\n')
        self.overlay.write_text('secret: test-secret\n')

    def test_architecture_selection_uses_portable_x86_build(self):
        self.assertEqual(manager.core_architecture('x86_64'), ['amd64-v1', 'amd64-compatible'])
        for machine, expected in [('aarch64', 'arm64'), ('armv7l', 'armv7'), ('i686', '386')]:
            self.assertEqual(manager.core_architecture(machine), [expected])
        with self.assertRaises(manager.ManagerError):
            manager.core_architecture('unknown-cpu')

    def test_release_requires_stable_tag_digest_and_official_url(self):
        release = self.release()
        selected = manager.select_release_asset(release, ['amd64-v1'])
        self.assertEqual(selected['version'], 'v1.19.30')
        self.assertEqual(len(selected['sha256']), 64)
        for mutate in [
            lambda r: r.update(prerelease=True),
            lambda r: r.update(tag_name='alpha'),
            lambda r: r['assets'][0].update(digest=None),
            lambda r: r['assets'][0].update(browser_download_url='https://untrusted.invalid/core.gz'),
        ]:
            changed = copy.deepcopy(release)
            mutate(changed)
            with self.assertRaises(manager.ManagerError):
                manager.select_release_asset(changed, ['amd64-v1'])

    def test_release_version_rejects_path_injection_before_network(self):
        with mock.patch.object(manager, 'fetch_release_bytes') as fetch:
            with self.assertRaises(manager.ManagerError):
                manager.resolve_core_release('../../latest')
            fetch.assert_not_called()

    def test_release_fetch_is_bounded(self):
        response = io.BytesIO(b'x' * 20)
        with mock.patch.object(manager.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(manager.ManagerError, '大小限制'):
                manager.fetch_release_bytes('https://github.com/example', 10)

    def test_archive_checks_hash_elf_and_decompressed_limit(self):
        elf = b'\x7fELF' + b'x' * 100
        data = gzip.compress(elf)
        digest = hashlib.sha256(data).hexdigest()
        manager.unpack_core(data, digest, self.binary)
        self.assertEqual(self.binary.read_bytes(), elf)
        self.assertEqual(self.binary.stat().st_mode & 0o777, 0o755)
        with self.assertRaisesRegex(manager.ManagerError, 'SHA-256'):
            manager.unpack_core(data, '0' * 64, self.binary)
        with mock.patch.object(manager, 'MAX_CORE_BINARY_BYTES', 10):
            with self.assertRaises(manager.ManagerError):
                manager.unpack_core(data, digest, self.binary)
        self.assertEqual(self.binary.read_bytes(), elf)
        invalid = gzip.compress(b'#!/bin/sh\n')
        with self.assertRaises(manager.ManagerError):
            manager.unpack_core(invalid, hashlib.sha256(invalid).hexdigest(), self.binary)

    def test_install_preserves_existing_core_without_network(self):
        self.binary.write_bytes(b'existing')
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'core_version', return_value='v1.19.29'),
              mock.patch.object(manager, 'resolve_core_release') as release):
            manager.install_core(self.registry)
            release.assert_not_called()
        self.assertEqual(self.binary.read_bytes(), b'existing')

    def test_config_rollback_is_blocked_by_core_or_mode_operation(self):
        with manager.operation_lock(self.registry):
            with mock.patch.object(manager, '_rollback_backup_impl') as restore:
                with self.assertRaises(manager.ConcurrentUpdateError):
                    manager.rollback_backup(self.config, self.registry, 'config.yaml.backup')
                restore.assert_not_called()

    def test_candidate_validation_failure_never_replaces_core(self):
        self.binary.write_bytes(b'old-core')
        self.target.write_text('proxies: []')
        candidate = self.root / 'candidate'
        candidate.write_bytes(b'new-core')
        with (mock.patch.object(manager, 'core_version', return_value='v1.19.30'),
              mock.patch.object(manager, 'validate_with_mihomo', side_effect=manager.ManagerError('bad config')),
              mock.patch.object(manager, 'service_properties') as properties):
            with self.assertRaisesRegex(manager.ManagerError, 'bad config'):
                manager.replace_core(self.registry, candidate)
            properties.assert_not_called()
        self.assertEqual(self.binary.read_bytes(), b'old-core')

    def test_failed_upgrade_restores_binary_and_restarts_old_core(self):
        self.binary.write_bytes(b'old-core')
        candidate = self.root / 'candidate'
        candidate.write_bytes(b'new-core')
        observed = []
        def restart(_):
            observed.append(self.binary.read_bytes())
            if len(observed) == 1:
                raise manager.ManagerError('new core crashed')
        with (mock.patch.object(manager, 'core_version', return_value='v1.19.30'),
              mock.patch.object(manager, 'service_properties', return_value=self.properties('active')),
              mock.patch.object(manager, 'restart_mihomo', side_effect=restart)):
            with self.assertRaisesRegex(manager.ManagerError, '已恢复旧内核'):
                manager.replace_core(self.registry, candidate)
        self.assertEqual(observed, [b'new-core', b'old-core'])
        self.assertEqual(self.binary.read_bytes(), b'old-core')
        self.assertEqual(self.binary.with_name('mihomo.previous').read_bytes(), b'old-core')

    def test_upgrade_preserves_stopped_service(self):
        self.binary.write_bytes(b'old-core')
        candidate = self.root / 'candidate'
        candidate.write_bytes(b'new-core')
        with (mock.patch.object(manager, 'core_version', return_value='v1.19.30'),
              mock.patch.object(manager, 'service_properties', return_value=self.properties()),
              mock.patch.object(manager, 'restart_mihomo') as restart):
            manager.replace_core(self.registry, candidate)
            restart.assert_not_called()
        self.assertEqual(self.binary.read_bytes(), b'new-core')

    def test_upgrade_rejects_mismatched_service_or_symlink(self):
        self.binary.write_bytes(b'old-core')
        candidate = self.root / 'candidate'
        candidate.write_bytes(b'new-core')
        with (mock.patch.object(manager, 'core_version', return_value='v1.19.30'),
              mock.patch.object(manager, 'service_properties', return_value={**self.properties(), 'ExecStart': '{ path=/other/mihomo ; }'})):
            with self.assertRaisesRegex(manager.ManagerError, '路径'):
                manager.replace_core(self.registry, candidate)
        self.binary.with_name('mihomo.previous').symlink_to(self.binary)
        with self.assertRaisesRegex(manager.ManagerError, '符号链接'):
            manager.replace_core(self.registry, candidate)
        self.assertEqual(self.binary.read_bytes(), b'old-core')

    def test_manual_rollback_retains_replaced_core_as_previous(self):
        self.binary.write_bytes(b'new-core')
        previous = self.binary.with_name('mihomo.previous')
        previous.write_bytes(b'old-core')
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'core_version', return_value='v1.19.29'),
              mock.patch.object(manager, 'service_properties', return_value=self.properties())):
            manager.rollback_core(self.registry)
        self.assertEqual(self.binary.read_bytes(), b'old-core')
        self.assertEqual(previous.read_bytes(), b'new-core')

    def test_render_service_uses_explicit_config_and_escapes_paths(self):
        registry = {**self.registry, 'target_config': '/tmp/a b/$HOME/%i.yaml'}
        content = manager.render_mihomo_service(registry).decode()
        self.assertIn('-f "/tmp/a b/$$HOME/%%i.yaml"', content)
        self.assertIn('WantedBy=multi-user.target', content)
        with self.assertRaises(manager.ManagerError):
            manager.render_mihomo_service({**registry, 'target_config': '/tmp/config\nExecStart=bad'})
        with self.assertRaises(manager.ManagerError):
            manager.service_name({**registry, 'systemd_service': '--bad.service'})

    def test_existing_service_is_never_overwritten(self):
        unit = self.root / 'mihomo.service'
        unit.write_text('custom service')
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'service_properties', return_value=self.properties()),
              mock.patch.object(manager, 'command_output') as command):
            self.assertFalse(manager.install_mihomo_service(self.registry, unit_dir=self.root))
            command.assert_not_called()
        self.assertEqual(unit.read_text(), 'custom service')

    def test_new_service_creation_does_not_start_it(self):
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'service_properties', return_value={'LoadState': 'not-found'}),
              mock.patch.object(manager, 'command_output', return_value=self.success()) as command):
            self.assertTrue(manager.install_mihomo_service(self.registry, unit_dir=self.root))
            command.assert_called_once_with(['systemctl', 'daemon-reload'])
        self.assertIn('ExecStart=', (self.root / 'mihomo.service').read_text())

    def test_fresh_bootstrap_creates_private_config_and_enables_new_service(self):
        with (mock.patch.object(manager, 'DEFAULTS', self.registry),
              mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'service_properties', return_value={'LoadState': 'not-found'}),
              mock.patch.object(manager, 'install_core') as core,
              mock.patch.object(manager, 'install_mihomo_service', return_value=True),
              mock.patch.object(manager, 'install_systemd_sandbox'),
              mock.patch.object(manager, 'service_action') as action):
            manager.bootstrap_install(self.config)
            core.assert_called_once()
            self.assertEqual([c.args[1] for c in action.call_args_list], ['start', 'enable'])
        profile = manager.read_yaml_mapping(self.target)
        self.assertEqual(profile['external-controller'], '127.0.0.1:9090')
        self.assertFalse(profile['allow-lan'])
        self.assertEqual(profile['rules'], ['MATCH,DIRECT'])
        self.assertEqual(len(profile['secret']), 64)
        self.assertTrue(profile['profile']['store-selected'])
        for path in (self.target, self.overlay, self.config):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_reinstall_preserves_config_and_existing_service_state(self):
        self.seed_config()
        manager.save_registry(self.config, self.registry)
        before = {p: p.read_bytes() for p in (self.config, self.target, self.overlay)}
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'service_properties', return_value=self.properties()),
              mock.patch.object(manager, 'install_core'),
              mock.patch.object(manager, 'install_mihomo_service', return_value=False),
              mock.patch.object(manager, 'install_systemd_sandbox'),
              mock.patch.object(manager, 'service_action') as action):
            manager.bootstrap_install(self.config)
            action.assert_not_called()
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)

    def test_no_start_does_not_enable_or_start_new_service(self):
        with (mock.patch.object(manager, 'DEFAULTS', self.registry),
              mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'service_properties', return_value={'LoadState': 'not-found'}),
              mock.patch.object(manager, 'install_core'),
              mock.patch.object(manager, 'install_mihomo_service', return_value=True),
              mock.patch.object(manager, 'install_systemd_sandbox'),
              mock.patch.object(manager, 'service_action') as action):
            manager.bootstrap_install(self.config, start=False)
            action.assert_not_called()

    def test_enable_timer_needs_subscription_and_does_not_hold_update_lock(self):
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'operation_lock') as lock,
              mock.patch.object(manager, 'command_output', return_value=self.success()) as command):
            with self.assertRaises(manager.ManagerError):
                manager.service_action(self.registry, 'enable', timer=True)
            command.assert_not_called()
            self.registry.update(active='demo', subscriptions={'demo': {}})
            manager.service_action(self.registry, 'enable', timer=True)
            command.assert_called_once_with(['systemctl', 'enable', '--now', manager.DEFAULT_UPDATER_TIMER])
            lock.assert_not_called()

    def test_container_rejects_native_installation_but_can_restart(self):
        registry = {**self.registry, 'service_backend': 'container'}
        with mock.patch.object(manager, 'resolve_core_release') as release:
            with self.assertRaisesRegex(manager.ManagerError, '容器'):
                manager.install_core(registry)
            release.assert_not_called()
        with mock.patch.object(manager, 'restart_mihomo') as restart:
            manager.service_action(registry, 'restart')
            restart.assert_called_once_with(registry)

    def test_controller_maps_wildcards_and_ipv6_to_localhost(self):
        self.seed_config()
        self.assertEqual(manager.controller_endpoint(self.registry), ('http://127.0.0.1:9090', 'test-secret'))
        self.target.write_text('external-controller: "[::]:9090"\n')
        self.assertEqual(manager.controller_endpoint(self.registry)[0], 'http://[::1]:9090')
        for address in ('/tmp/controller.sock', 'http://remote:9090', 'user:pass@remote:9090'):
            self.target.write_text('external-controller: ' + json.dumps(address))
            with self.assertRaises(manager.ManagerError):
                manager.controller_endpoint(self.registry)

    def test_controller_auth_is_header_only_and_bypasses_environment_proxy(self):
        self.seed_config()
        response = io.BytesIO(b'{"mode":"rule"}')
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(manager.urllib.request, 'build_opener', return_value=opener) as build:
            result = manager.controller_request(self.registry, '/configs')
        self.assertEqual(result['mode'], 'rule')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-secret')
        self.assertNotIn('test-secret', request.full_url)
        self.assertEqual(build.call_args.args[0].proxies, {})
        self.assertIsInstance(build.call_args.args[1], manager.NoControllerRedirect)

    def test_controller_error_redacts_body_url_and_secret(self):
        self.seed_config()
        opener = mock.Mock()
        opener.open.side_effect = urllib.error.HTTPError('http://secret.invalid/test-secret', 401, 'test-secret', {}, None)
        with mock.patch.object(manager.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(manager.ManagerError, '认证失败') as error:
                manager.controller_request(self.registry, '/configs')
        self.assertNotIn('test-secret', str(error.exception))
        self.assertNotIn('secret.invalid', str(error.exception))

    def test_select_proxy_checks_group_type_membership_and_encodes_path(self):
        group = '日本 / test?'
        groups = {group: {'type': 'Selector', 'all': ['DIRECT', '日本 01']}}
        with (mock.patch.object(manager, 'proxy_groups', return_value=groups),
              mock.patch.object(manager, 'controller_request') as request):
            manager.select_proxy(self.registry, group, '日本 01')
            self.assertIn('%2F', request.call_args.args[1])
            self.assertIn('%3F', request.call_args.args[1])
            self.assertEqual(request.call_args.kwargs['payload'], {'name': '日本 01'})
            request.reset_mock()
            with self.assertRaises(manager.ManagerError):
                manager.select_proxy(self.registry, group, 'missing')
            groups[group]['type'] = 'URLTest'
            with self.assertRaises(manager.ManagerError):
                manager.select_proxy(self.registry, group, 'DIRECT')
            request.assert_not_called()

    def test_mode_is_saved_to_config_and_overlay_after_validation(self):
        self.seed_config()
        with (mock.patch.object(manager, 'validate_with_mihomo') as validate,
              mock.patch.object(manager, 'controller_request', side_effect=[{'mode': 'rule'}, {}]) as request):
            manager.set_proxy_mode(self.registry, 'global')
            validate.assert_called_once()
            self.assertEqual(request.call_args.kwargs['payload'], {'mode': 'global'})
        self.assertEqual(manager.read_yaml_mapping(self.target)['mode'], 'global')
        self.assertEqual(manager.read_yaml_mapping(self.overlay)['mode'], 'global')

    def test_mode_request_failure_restores_both_files_and_runtime_mode(self):
        self.seed_config()
        before = self.target.read_bytes(), self.overlay.read_bytes()
        with (mock.patch.object(manager, 'validate_with_mihomo'),
              mock.patch.object(manager, 'controller_request', side_effect=[{'mode': 'rule'}, manager.ManagerError('request failed'), {}]) as request):
            with self.assertRaisesRegex(manager.ManagerError, 'request failed'):
                manager.set_proxy_mode(self.registry, 'global')
            self.assertEqual(request.call_args.kwargs['payload'], {'mode': 'rule'})
        self.assertEqual((self.target.read_bytes(), self.overlay.read_bytes()), before)

    def test_invalid_mode_rejected_before_any_controller_request(self):
        with mock.patch.object(manager, 'controller_request') as request:
            with self.assertRaises(manager.ManagerError):
                manager.set_proxy_mode(self.registry, 'unknown')
            request.assert_not_called()

    def test_proxy_page_scroll_and_selection_routes_to_controller(self):
        console = make_console(18, 70)
        console.page = 6
        console.groups = {'manual': {'type': 'Selector', 'all': ['node' + str(i) for i in range(50)], 'now': 'node0'}}
        console.handle_proxy_key(10)
        self.assertEqual(console.open_group, 'manual')
        for _ in range(45):
            console.handle_proxy_key(console.curses.KEY_DOWN)
        console.draw()
        self.assertIn('node45', console.screen.text)
        with (mock.patch.object(console, 'run_external', side_effect=lambda title, action: action()),
              mock.patch.object(manager, 'select_proxy') as select):
            console.handle_proxy_key(10)
            select.assert_called_once_with(console.registry, 'manual', 'node45')
        console.handle_proxy_key(27)
        self.assertIsNone(console.open_group)


if __name__ == '__main__':
    unittest.main()
