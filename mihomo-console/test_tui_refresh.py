"""The curses thread must stay responsive even when readers are blocked."""
import contextlib
import copy
import threading
import time
import unittest
from unittest import mock

import mihomo_console as manager
from test_locale import make_console


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.console = make_console()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.release = threading.Event()
        self.addCleanup(self.cleanup_readers)
        self.readers = {}
        values = {'load_registry': copy.deepcopy(self.console.registry),
                  'collect_status': self.console.status, 'backup_rows': [],
                  'fetch_journal': ['new log'], 'collect_core_status': {'version': 'test'},
                  'proxy_groups': {'test': {'all': ['DIRECT']}},
                  'controller_request': {'mode': 'rule'}}
        for name, value in values.items():
            self.readers[name] = self.stack.enter_context(mock.patch.object(manager, name, return_value=value))

    def cleanup_readers(self):
        self.console.close()
        self.release.set()
        deadline = time.monotonic() + 2
        while self.console._pending and time.monotonic() < deadline:
            self.console.poll_refresh()
            time.sleep(0.001)

    def wait_for(self, predicate):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            self.console.poll_refresh()
            if predicate():
                return
            time.sleep(0.001)
        self.fail('Background refresh did not finish')

    def ready(self):
        self.console.refresh()
        self.wait_for(lambda: 'status' in self.console._checked)

    def test_navigation_and_quit_do_not_wait_for_slow_readers(self):
        started = threading.Event()
        def slow(*args, **kwargs):
            started.set()
            self.release.wait(2)
            return ['slow log']
        self.readers['fetch_journal'].side_effect = slow
        self.ready()
        self.console.change_page(4)
        self.assertTrue(started.wait(1))
        began = time.monotonic()
        for _ in range(70):
            self.console.handle_key(9)
            self.console.draw()
        self.assertFalse(self.console.handle_key(ord('q')))
        self.console.close()
        self.assertLess(time.monotonic() - began, 0.5)
        self.assertFalse(self.release.is_set())
        self.readers['fetch_journal'].assert_called_once()

    def test_reads_only_visible_page_and_reuses_cache(self):
        self.ready()
        for page in (1, 2, 0, 1):
            self.console.change_page(page)
        self.readers['backup_rows'].assert_not_called()
        self.readers['fetch_journal'].assert_not_called()
        self.readers['collect_core_status'].assert_not_called()
        self.readers['proxy_groups'].assert_not_called()
        self.console.change_page(3)
        self.wait_for(lambda: 'backups' in self.console._checked)
        for page in (2, 3, 2, 3):
            self.console.change_page(page)
        self.readers['backup_rows'].assert_called_once()
        self.readers['collect_status'].assert_called_once()

    def test_old_snapshot_is_discarded_after_action(self):
        started = threading.Event()
        def slow(*args):
            started.set()
            self.release.wait(2)
            return {'version': 'old'}
        self.readers['collect_core_status'].side_effect = slow
        self.ready()
        self.console.change_page(5)
        self.assertTrue(started.wait(1))
        self.console.invalidate()
        self.console.core_status = {'version': 'new'}
        self.console.change_page(0)
        self.release.set()
        self.wait_for(lambda: 'core' not in self.console._pending)
        self.assertEqual(self.console.core_status['version'], 'new')

    def test_log_switch_does_not_show_old_unit_result(self):
        started = threading.Event()
        def logs(unit, **kwargs):
            if unit == manager.DEFAULT_UPDATER_SERVICE:
                started.set()
                self.release.wait(2)
            return [unit]
        self.console.registry['systemd_service'] = 'mihomo.service'
        self.readers['load_registry'].return_value = copy.deepcopy(self.console.registry)
        self.readers['fetch_journal'].side_effect = logs
        self.ready()
        self.console.change_page(4)
        self.assertTrue(started.wait(1))
        self.console.handle_key(ord('t'))
        self.assertEqual(self.console.logs, [])
        self.release.set()
        self.wait_for(lambda: self.console.logs == ['mihomo.service'])

    def test_controller_failure_can_retry_without_losing_navigation(self):
        self.ready()
        self.readers['proxy_groups'].side_effect = manager.ManagerError('offline')
        self.console.change_page(6)
        self.wait_for(lambda: self.console.controller_error == 'offline')
        self.console.draw()
        self.assertIn('offline', self.console.screen.text)
        self.readers['proxy_groups'].side_effect = None
        self.console.handle_key(ord('r'))
        self.wait_for(lambda: self.console.live_config.get('mode') == 'rule')
        self.assertIsNone(self.console.controller_error)

    def test_periodic_refresh_is_nonblocking_and_coalesced(self):
        self.ready()
        self.console._checked['status'] -= 6
        self.readers['collect_status'].side_effect = lambda *args: self.release.wait(2) or {}
        began = time.monotonic()
        for _ in range(50):
            self.console.poll_refresh()
        self.assertLess(time.monotonic() - began, 0.2)
        self.assertLessEqual(self.readers['collect_status'].call_count, 2)


if __name__ == '__main__':
    unittest.main()
