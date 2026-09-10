"""Optional live tests: MIHOMO_TEST_BINARY=/absolute/path/to/mihomo python -m unittest discover -v."""
import copy
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
import urllib.parse
from unittest import mock

import mihomo_console as manager


@unittest.skipUnless(os.environ.get('MIHOMO_TEST_BINARY'), 'Set MIHOMO_TEST_BINARY to run isolated live-core tests')
class LiveCoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='mihomo-integration-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binary = Path(os.environ['MIHOMO_TEST_BINARY']).resolve()
        self.assertTrue(self.binary.is_file())
        language = mock.patch.object(manager, 'LANGUAGE', 'en_US')
        language.start()
        self.addCleanup(language.stop)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        self.registry = copy.deepcopy(manager.DEFAULTS)
        self.registry.update(
            mihomo_binary=str(self.binary), mihomo_home=str(self.root),
            target_config=str(self.root / 'config.yaml'), overlay_file=str(self.root / 'overlay.yaml'),
            lock_file=str(self.root / 'lock'), backup_dir=str(self.root / 'backups'),
            service_backend='container', runtime_file=str(self.root / 'runtime.json'),
            container_log_dir=str(self.root / 'logs'),
        )
        self.group = 'fixture / group?'
        profile = {
            'external-controller': f'127.0.0.1:{port}', 'secret': 'isolated-fixture-secret',
            'mode': 'rule', 'log-level': 'warning', 'proxies': [],
            'profile': {'store-selected': True},
            'proxy-groups': [{'name': self.group, 'type': 'select', 'proxies': ['DIRECT', 'REJECT']}],
            'rules': ['MATCH,DIRECT'],
        }
        manager.secure_atomic_write(Path(self.registry['target_config']), manager.yaml.safe_dump(profile).encode(), mode=0o600)
        manager.secure_atomic_write(Path(self.registry['overlay_file']), b'mode: rule\n', mode=0o600)
        self.config = self.root / 'manager.json'
        manager.save_registry(self.config, self.registry)
        self.log = (self.root / 'core.log').open('w')
        self.addCleanup(self.log.close)
        self.process = None
        self.addCleanup(self.stop_core)
        self.start_core()

    def start_core(self):
        self.process = subprocess.Popen(
            [str(self.binary), '-d', str(self.root), '-f', self.registry['target_config']],
            stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT,
        )
        (self.root / 'runtime.json').write_text(json.dumps({
            'mihomo_state': 'running', 'mihomo_pid': self.process.pid, 'updater_enabled': False,
        }))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                # /version can respond before initial proxy groups have loaded.
                if self.group in manager.proxy_groups(self.registry):
                    return
            except manager.ManagerError:
                pass
            if self.process.poll() is not None:
                self.fail('Isolated core exited: ' + (self.root / 'core.log').read_text())
            time.sleep(0.05)
        self.fail('Isolated core did not become ready')

    def stop_core(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)

    def test_node_and_mode_selection_survive_restart(self):
        manager.select_proxy(self.registry, self.group, 'REJECT')
        manager.set_proxy_mode(self.registry, 'global')
        path = '/proxies/' + urllib.parse.quote(self.group, safe='')
        self.assertEqual(manager.controller_request(self.registry, path)['now'], 'REJECT')
        self.assertEqual(manager.controller_request(self.registry, '/configs')['mode'], 'global')
        self.stop_core()
        self.start_core()
        self.assertEqual(manager.controller_request(self.registry, path)['now'], 'REJECT')
        self.assertEqual(manager.controller_request(self.registry, '/configs')['mode'], 'global')
        self.assertEqual(manager.read_yaml_mapping(Path(self.registry['overlay_file']))['mode'], 'global')

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze is unavailable')
    def test_generated_service_passes_systemd_validation(self):
        unit = self.root / 'mihomo-console-integration.service'
        unit.write_bytes(manager.render_mihomo_service(self.registry))
        result = subprocess.run(['systemd-analyze', 'verify', str(unit)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        timer = self.root / 'mihomo-console-integration.timer'
        base = Path(manager.__file__).with_name('mihomo-subscription-update.timer').read_text()
        timer.write_text(base.replace(manager.DEFAULT_UPDATER_SERVICE, unit.name))
        dropin = self.root / (timer.name + '.d') / 'zz-mihomo-console.conf'
        dropin.parent.mkdir()
        dropin.write_bytes(manager.render_update_schedule(21600))
        result = subprocess.run(['systemd-analyze', 'verify', str(timer)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tui_navigation_and_mode_change_in_real_terminal(self):
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 120, 0, 0))
        process = subprocess.Popen(
            [sys.executable, manager.__file__, '--lang', 'en_US', '--manager-config', str(self.config)],
            stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, 'TERM': 'xterm-256color', 'LC_ALL': 'C.UTF-8'},
        )
        os.close(slave)
        def stop_tui():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        self.addCleanup(stop_tui)
        def expect(text):
            data = bytearray()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data.extend(os.read(master, 65536))
                    except OSError:
                        break
                    if text.encode() in data:
                        return
            self.fail('Missing terminal text ' + repr(text) + ': ' + data.decode(errors='replace'))
        expect('Runtime overview')
        os.write(master, b'6')
        expect('Core & service')
        os.write(master, b'7')
        expect('Proxies & mode')
        os.write(master, b'm')
        expect('Proxy mode [rule]:')
        os.write(master, b'direct\n')
        expect('Switched and saved proxy mode: Direct')
        os.write(master, b'\n')
        # Curses initially paints the cached page and then updates just the mode
        # cell when the asynchronous controller read finishes.
        expect('Direct')
        os.write(master, b'l')
        expect('节点与模式')
        os.write(master, b'6')
        expect('内核与服务')
        os.write(master, b'f')
        expect('更新频率 [1h]:')
        os.write(master, b'6h\n')
        expect('自动更新设置已保存。')
        os.write(master, b'\n')
        expect('内核与服务')
        os.write(master, b'q')
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(manager.controller_request(self.registry, '/configs')['mode'], 'direct')
        self.assertEqual(manager.update_schedule_settings(manager.load_registry(self.config))[0], 21600)


if __name__ == '__main__':
    unittest.main()
