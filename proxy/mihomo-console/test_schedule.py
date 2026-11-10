"""Persisted schedule settings, systemd recovery and live container rescheduling."""
import copy
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import container_runtime
import mihomo_console as manager
from test_locale import make_console


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'manager.json'
        self.dropin = self.root / 'timer.d' / 'zz-mihomo-console.conf'
        self.registry = copy.deepcopy(manager.DEFAULTS)
        self.registry.update(lock_file=str(self.root / 'lock'), active='demo',
                             subscriptions={'demo': {}}, runtime_file=str(self.root / 'runtime.json'))
        manager.save_registry(self.config, self.registry)
        self.commands = []
        self.active, self.enabled = 'inactive', 'disabled'
        patch = mock.patch.object(manager, 'LANGUAGE', 'zh_CN')
        patch.start()
        self.addCleanup(patch.stop)

    def command(self, args, **kwargs):
        self.commands.append(args)
        output = (f'LoadState=loaded\nActiveState={self.active}\nUnitFileState={self.enabled}\n'
                  if args[1] == 'show' else '')
        return subprocess.CompletedProcess(args, 0, output)

    def configure(self, interval=None, **kwargs):
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'command_output', side_effect=self.command)):
            manager.configure_update_schedule(self.config, self.registry, interval, dropin=self.dropin, **kwargs)

    def test_interval_validation_before_any_write(self):
        for value, seconds in [('30m', 1800), ('1h', 3600), ('6h', 21600),
                               ('12h', 43200), ('1d', 86400), (' 2H ', 7200), ('30d', 2592000)]:
            self.assertEqual(manager.parse_update_interval(value), seconds)
        original = self.config.read_bytes()
        for value in ('0', '0m', '-1h', '1s', '31d', 'hourly', '1.5h', '1h\nOnCalendar=daily', '999999999d'):
            with self.assertRaises(manager.ManagerError):
                self.configure(value)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.config.read_bytes(), original)
        self.assertFalse(self.dropin.exists())

    def test_frequency_change_preserves_disabled_timer(self):
        self.configure('6h')
        self.assertEqual(manager.current_update_interval(manager.load_registry(self.config)), 21600)
        content = self.dropin.read_text()
        self.assertIn('OnCalendar=\n', content)
        self.assertIn('OnUnitInactiveSec=21600s\n', content)
        self.assertIn('OnActiveSec=21600s\n', content)
        self.assertEqual([c[1] for c in self.commands], ['show', 'daemon-reload'])
        self.assertEqual(self.dropin.stat().st_mode & 0o777, 0o644)

    def test_active_timer_restarted_to_apply_frequency_without_changing_autostart(self):
        self.active, self.enabled = 'active', 'enabled'
        self.configure('30m')
        self.assertEqual([c[1] for c in self.commands], ['show', 'daemon-reload', 'restart'])

    def test_disable_keeps_selected_interval_and_enable_uses_it(self):
        self.configure('12h', enabled=True)
        original = self.dropin.read_bytes()
        self.configure(enabled=False)
        self.assertIn(['systemctl', 'disable', '--now', manager.DEFAULT_UPDATER_TIMER], self.commands)
        self.assertEqual(self.dropin.read_bytes(), original)
        self.assertEqual(manager.current_update_interval(self.registry), 43200)
        self.configure(enabled=True)
        self.assertEqual(self.dropin.read_bytes(), original)

    def test_no_subscription_can_set_interval_but_cannot_enable(self):
        self.registry['active'] = None
        manager.save_registry(self.config, self.registry)
        self.configure('1d')
        with self.assertRaisesRegex(manager.ManagerError, '尚未选择'):
            self.configure(enabled=True)

    def test_failed_restart_restores_file_registry_and_running_state(self):
        self.configure('1h')
        old_registry, old_dropin = self.config.read_bytes(), self.dropin.read_bytes()
        self.active, self.enabled = 'active', 'enabled'
        original_command = self.command
        failed = False
        def fail_once(args, **kwargs):
            nonlocal failed
            if args[1] == 'restart' and not failed:
                failed = True
                return subprocess.CompletedProcess(args, 1, 'test failure')
            return original_command(args, **kwargs)
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'command_output', side_effect=fail_once)):
            with self.assertRaisesRegex(manager.ManagerError, '已恢复原设置'):
                manager.configure_update_schedule(self.config, self.registry, '6h', dropin=self.dropin)
        self.assertEqual(self.config.read_bytes(), old_registry)
        self.assertEqual(self.dropin.read_bytes(), old_dropin)
        self.assertEqual(self.commands[-1][1], 'restart')

    def test_registry_save_failure_removes_new_dropin_and_restores_disabled_state(self):
        old_registry = self.config.read_bytes()
        with (mock.patch.object(manager, 'require_native_root'),
              mock.patch.object(manager, 'command_output', side_effect=self.command),
              mock.patch.object(manager, 'save_registry', side_effect=OSError('disk full'))):
            with self.assertRaisesRegex(manager.ManagerError, '已恢复原设置'):
                manager.configure_update_schedule(self.config, self.registry, '6h', enabled=True, dropin=self.dropin)
        self.assertFalse(self.dropin.exists())
        self.assertEqual(self.config.read_bytes(), old_registry)
        self.assertEqual([c[1] for c in self.commands][-2:], ['disable', 'stop'])

    def test_concurrent_update_prevents_schedule_write(self):
        with manager.operation_lock(self.registry):
            with self.assertRaises(manager.ConcurrentUpdateError):
                self.configure('6h')
        self.assertFalse(self.dropin.exists())

    def test_tui_frequency_action_calls_interactive_schedule(self):
        console = make_console()
        with (mock.patch.object(console, 'run_external', side_effect=lambda title, action: action()),
              mock.patch.object(manager, 'choose_update_schedule') as choose):
            console.handle_core_key(ord('f'))
        choose.assert_called_once_with(console.manager_config, console.registry)

    def test_container_schedule_overrides_environment_and_survives_reload(self):
        self.registry['service_backend'] = 'container'
        manager.save_registry(self.config, self.registry)
        with mock.patch.object(manager, 'command_output') as systemctl:
            self.configure('6h', enabled=True)
            settings = manager.update_schedule_settings(manager.load_registry(self.config), 0)
            self.assertEqual(settings, (21600, True))
            self.configure(enabled=False)
            self.assertEqual(manager.update_schedule_settings(manager.load_registry(self.config), 3600), (21600, False))
            systemctl.assert_not_called()
        self.assertFalse(self.dropin.exists())

    def test_container_loop_picks_up_interval_and_enable_changes_without_restart(self):
        self.registry['service_backend'] = 'container'
        manager.save_registry(self.config, self.registry)
        clock = [0.0]
        runtime = container_runtime.ContainerRuntime()
        runtime.update_interval = 0
        updates, states = [], []
        class Stop:
            def is_set(inner):
                return clock[0] >= 211
            def wait(inner, delay):
                clock[0] += delay
                changes = {5: ('1m', True), 20: ('2m', None), 141: (None, False), 150: (None, True)}
                if clock[0] in changes:
                    interval, enabled = changes[clock[0]]
                    manager.configure_update_schedule(self.config, self.registry, interval, enabled=enabled)
                return inner.is_set()
        runtime.stop_event = Stop()
        with (mock.patch.object(container_runtime, 'MANAGER_CONFIG', self.config),
              mock.patch.object(container_runtime.time, 'monotonic', side_effect=lambda: clock[0]),
              mock.patch.object(runtime, 'write_state', side_effect=lambda **kw: states.append(kw)),
              mock.patch.object(runtime, 'run_update', side_effect=lambda: updates.append(clock[0]))):
            runtime.update_loop()
        # Initial interval=0 stays available for later enable; changing frequency
        # resets the countdown. Re-enabling retains the chosen two-minute delay.
        self.assertEqual(updates, [140])
        self.assertTrue(any(s.get('updater_enabled') is False for s in states))
        self.assertEqual(states[-1]['update_interval_seconds'], 120)


if __name__ == '__main__':
    unittest.main()
