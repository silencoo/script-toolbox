#!/usr/bin/env python3
"""Login-notify regressions. Temporary databases and a local fake Bark only.

Debian 13 sshd-session and login/getty shapes below come from observed logs;
other methods, terminal numbers and Debian 12 sshd shapes are synthetic coverage.
"""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('login_notify', ROOT / 'tools/login-notify.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def ssh(cursor='ssh-1', method='publickey', **overrides):
    row = dict(__CURSOR=cursor, __REALTIME_TIMESTAMP=1790103556051767,
               _UID='0', _COMM='sshd-session', _EXE='/usr/lib/openssh/sshd-session',
               SYSLOG_IDENTIFIER='sshd-session', _SYSTEMD_UNIT='ssh.service',
               MESSAGE=f'Accepted {method} for root from 203.0.113.10 port 60436 ssh2: ED25519 SHA256:REDACTED')
    row.update(overrides)
    return row


def local(cursor='local-1', **overrides):
    row = dict(__CURSOR=cursor, __REALTIME_TIMESTAMP=1790104142875552,
               _UID='0', _COMM='login', _EXE='/usr/bin/login', SYSLOG_IDENTIFIER='login',
               _SYSTEMD_UNIT='getty@tty1.service',
               MESSAGE='pam_unix(login:session): session opened for user root(uid=0) by root(uid=0)')
    row.update(overrides)
    return row


class IdentifyTests(unittest.TestCase):
    def test_all_ssh_methods_and_no_tty(self):
        for method in ('password', 'publickey', 'keyboard-interactive/pam', 'hostbased', 'gssapi-with-mic'):
            for comm, exe, unit in [('sshd', '/usr/sbin/sshd', 'sshd.service'),
                                    ('sshd-session', '/usr/lib/openssh/sshd-session', 'ssh.service')]:
                event = app.identify(ssh(method=method, _COMM=comm, _EXE=exe, _SYSTEMD_UNIT=unit))
                self.assertEqual(event['method'], method)
                self.assertEqual(event['user'], 'root')
                self.assertEqual(event['source_ip'], '203.0.113.10')
                self.assertNotIn('tty', event)
                self.assertNotIn('SHA256', json.dumps(event))

    def test_ipv6_and_missing_fields(self):
        event = app.identify(ssh(MESSAGE='Accepted publickey for alice from 2001:db8::1 port 22 ssh2'))
        self.assertEqual(event['source_ip'], '2001:db8::1')
        event = app.identify(ssh(MESSAGE='Accepted'))
        self.assertEqual((event['user'], event['method'], event['source_ip']), ('未知',)*3)
        self.assertEqual(app.identify(ssh(MESSAGE='Accepted for root'))['method'], '未知')
        self.assertEqual(app.identify(local(MESSAGE='pam_unix(login:session): session opened'))['user'], '未知')

    def test_arbitrary_terminals_and_missing_terminal(self):
        for unit, tty in [('getty@tty37.service', 'tty37'), ('serial-getty@ttyS42.service', 'ttyS42'),
                          ('getty@hvc0.service', 'hvc0'), ('custom-login.service', '未知')]:
            self.assertEqual(app.identify(local(_SYSTEMD_UNIT=unit))['tty'], tty)
        self.assertEqual(app.identify(local(_SYSTEMD_UNIT='', TTY='/dev/pts/42'))['tty'], 'pts/42')

    def test_no_ssh_pam_duplicate_or_other_sessions(self):
        for service in ('sshd', 'sudo', 'su', 'cron', 'systemd-user', 'gdm-password'):
            msg = f'pam_unix({service}:session): session opened for user root(uid=0)'
            self.assertIsNone(app.identify(ssh(MESSAGE=msg)))
            self.assertIsNone(app.identify(local(MESSAGE=msg)))
        for msg in ('ROOT LOGIN ON tty1', 'pam_unix(login:auth): authentication failure',
                    'pam_unix(login:session): session closed for user root'):
            self.assertIsNone(app.identify(local(MESSAGE=msg)))
        self.assertIsNone(app.identify(ssh(MESSAGE='Partial publickey for root from 203.0.113.10 port 22 ssh2')))

    def test_spoofed_identifier_and_wrong_process_rejected(self):
        self.assertIsNone(app.identify(ssh(_UID='1000')))
        self.assertIsNone(app.identify(ssh(_COMM='logger', _EXE='/usr/bin/logger')))
        self.assertIsNone(app.identify(local(_COMM='bash', _EXE='/usr/bin/bash')))
        self.assertIsNone(app.identify(ssh(_UID=None)))
        self.assertIsNotNone(app.identify(ssh(_EXE=None)))
        self.assertIsNone(app.identify(ssh(_EXE=None, _SYSTEMD_UNIT='user.service')))

    def test_payload_timezone_privacy_and_json(self):
        config = dict(app.DEFAULTS, machine_alias='server"\n$(touch /tmp/not-a-command)',
                      device_key='FAKE_KEY', timezone='Asia/Tokyo')
        data = app.payload(app.identify(local()), config)
        self.assertIn('+09:00', data['body'])
        self.assertNotIn('来源', data['body'])
        self.assertNotIn('session opened', data['body'])
        self.assertEqual(json.loads(json.dumps(data)), data)
        self.assertEqual(app.timestamp(None), '未知')


class FakeJournal:
    def __init__(self, rows):
        self.rows = rows
        self.position = -1
        self.seeks = []

    def tail(self):
        self.position = len(self.rows)-1
        return self.rows[-1] if self.rows else None

    def resume(self, cursor):
        for i, row in enumerate(self.rows):
            if row['__CURSOR'] == cursor:
                self.position = i
                return True
        return False

    def seek_time(self, usec):
        self.seeks.append(int(usec))
        self.position = next((i-1 for i, r in enumerate(self.rows)
                              if r['__REALTIME_TIMESTAMP'] >= int(usec)), len(self.rows)-1)

    def next(self):
        self.position += 1
        return self.rows[self.position] if self.position < len(self.rows) else None


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'queue.sqlite3'
        self.config = dict(app.DEFAULTS, machine_alias='test', device_key='FAKE_KEY')
        self.store = app.Store(self.path, self.config)
        self.addCleanup(lambda: self.store.close())

    def test_first_install_skips_history_without_startup_race(self):
        journal = FakeJournal([ssh('old')])
        app.prepare(journal, self.store)
        self.assertEqual(self.store.status()['queue'], {})
        journal.rows.append(ssh('new'))  # Login between tail capture and follow.
        self.store.consume([journal.next()])
        self.assertEqual(self.store.status()['queue'], {'pending': 1})
        self.assertEqual(self.store.get('cursor'), 'new')

    def test_empty_journal_does_not_silently_initialize(self):
        with self.assertRaises(RuntimeError):
            app.prepare(FakeJournal([]), self.store)
        self.assertIsNone(self.store.get('cursor'))

    def test_event_and_checkpoint_roll_back_together(self):
        self.store.consume([ssh('first')])
        self.store.db.execute("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON meta WHEN NEW.key='cursor' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.consume([ssh('second')])
        self.assertEqual(self.store.get('cursor'), 'first')
        self.assertEqual(self.store.status()['queue'], {'pending': 1})

    def test_restart_resume_and_deduplication(self):
        row = ssh('first')
        self.store.consume([row, ssh('pam', MESSAGE='pam_unix(sshd:session): session opened for user root(uid=0)')])
        self.store.close()
        self.store = app.Store(self.path, self.config)
        journal = FakeJournal([row, ssh('pam'), local('offline-login')])
        app.prepare(journal, self.store)
        self.assertEqual(journal.next()['__CURSOR'], 'offline-login')
        self.store.consume([row])
        self.assertEqual(self.store.status()['queue'], {'pending': 1})

    def test_cursor_gap_persists_and_recovers_from_saved_time(self):
        self.store.consume([ssh('gone')])
        newer = local('retained')
        journal = FakeJournal([newer])
        app.prepare(journal, self.store)
        self.assertEqual(journal.seeks, [ssh()['__REALTIME_TIMESTAMP']])
        self.assertEqual(self.store.get('cursor'), '')
        app.prepare(journal, self.store)  # Another restart before the first new commit.
        self.assertEqual(self.store.status()['alerts'][0]['count'], 1)
        self.store.consume([journal.next()])
        self.assertEqual(self.store.get('cursor'), 'retained')
        self.assertEqual(self.store.status()['queue']['pending'], 2)

    def test_queue_full_and_expired_pending_leave_durable_loss_records(self):
        self.config['max_events'] = 2
        self.store.consume([ssh('a'), ssh('b'), ssh('c')])
        self.assertEqual(self.store.get('cursor'), 'c')
        self.assertEqual(self.store.status()['queue'], {'pending': 2})
        self.assertEqual(self.store.status()['alerts'][0]['kind'], 'queue_full')
        with self.store.db:
            self.store.db.execute('UPDATE events SET created=?', (time.time()-31*86400,))
            self.store.maintain(time.time())
        self.assertEqual(self.store.status()['queue'], {})
        self.assertEqual({a['kind']:a['count'] for a in self.store.status()['alerts']},
                         {'queue_full':1, 'pending_expired':2})

    def test_capacity_reclaims_sent_before_dropping_new_events(self):
        self.config['max_events'] = 1
        self.store.consume([ssh('a')])
        app.deliver_one(self.store, self.config, send_fn=lambda *_: None)
        self.store.consume([ssh('b')])
        self.assertEqual(self.store.status()['queue'], {'pending':1})
        self.assertEqual(self.store.status()['alerts'], [])

    def test_offline_retry_survives_restart_and_logs_no_secret(self):
        self.store.consume([ssh()])
        def fail(*_):
            raise TimeoutError('https://fake/FAKE_SECRET and raw response')
        with self.assertLogs(app.LOG, level='WARNING') as logs:
            app.deliver_one(self.store, self.config, send_fn=fail, now=100)
        self.assertNotIn('FAKE_SECRET', str(logs.output))
        self.assertEqual(self.store.status()['pending_attempts'], 1)
        self.assertFalse(app.deliver_one(self.store, self.config, send_fn=lambda *_: self.fail('early retry'), now=101))
        self.store.close()
        self.store = app.Store(self.path, self.config)
        delivered = []
        app.deliver_one(self.store, self.config, send_fn=lambda e,c: delivered.append(e), now=10000)
        self.assertEqual(len(delivered), 1)
        self.assertEqual(self.store.status()['queue'], {'sent':1})

    def test_blocked_http_does_not_block_journal_commit(self):
        self.store.consume([ssh('first')])
        entered, release = threading.Event(), threading.Event()
        def task():
            other = app.Store(self.path, self.config)
            try:
                def wait_for_network(*_):
                    entered.set()
                    release.wait(5)
                app.deliver_one(other, self.config, send_fn=wait_for_network)
            finally:
                other.close()
        thread = threading.Thread(target=task)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.store.consume([local('during-outage')])
            self.assertEqual(self.store.get('cursor'), 'during-outage')
            self.assertEqual(self.store.status()['queue']['pending'], 2)
        finally:
            release.set()
            thread.join(5)


class HttpTests(unittest.TestCase):
    def test_real_network_timeout(self):
        release = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                release.wait(5)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = dict(app.DEFAULTS, server_url=f'http://127.0.0.1:{server.server_port}',
                      machine_alias='test', device_key='FAKE_SECRET', request_timeout=1)
        try:
            start = time.monotonic()
            with self.assertRaises(TimeoutError):
                app.send(app.identify(ssh()), config)
            self.assertLess(time.monotonic()-start, 3)
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_real_http_serialization_failures_and_redirects(self):
        received = []
        replies = [(500, b'{"code":500}'), (200, b'{"code":500}'),
                   (302, b''), (200, b'{"code":200}')]
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                code, body = replies.pop(0)
                self.send_response(code)
                if code == 302:
                    self.send_header('Location', '/leak')
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        # Only this test bypasses HTTPS config validation to exercise a local fake.
        config = dict(app.DEFAULTS, server_url=f'http://127.0.0.1:{server.server_port}',
                      machine_alias='test"\nserver', device_key='FAKE_SECRET')
        try:
            for _ in range(3):
                with self.assertRaises(Exception):
                    app.send(app.identify(ssh()), config)
            app.send(app.identify(ssh()), config)
            self.assertEqual(len(received), 4)
            for path, data in received:
                self.assertEqual(path, '/push')
                self.assertEqual(data['device_key'], 'FAKE_SECRET')
                self.assertNotIn('SHA256', data['body'])
                self.assertNotIn('Accepted', data['body'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_unsafe_config_rejected(self):
        for url in ('http://example.test', 'https://example.test/SECRET',
                    'https://name:SECRET@example.test', 'https://example.test?key=SECRET'):
            with self.assertRaises(ValueError):
                app.validate_config(dict(app.DEFAULTS, machine_alias='test', device_key='FAKE', server_url=url))
        with self.assertRaises(ValueError):
            app.validate_config(dict(app.DEFAULTS, machine_alias='test', device_key='FAKE', max_events=0))

    def test_config_permissions_are_strict(self):
        for mode, uid in [(0o644,0), (0o660,0), (0o750,0), (0o640,1000)]:
            info = SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=uid)
            with patch.object(app.os, 'lstat', return_value=info):
                with self.assertRaises(ValueError):
                    app.load_config('/unused')

    def test_config_error_does_not_leak_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'config.json'
            path.write_text('{"device_key":"FAKE_SECRET",invalid}')
            os.chmod(path, 0o600)
            info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
            with patch.object(app.os, 'lstat', return_value=info), \
                    patch.object(app.sys, 'argv', ['login-notify', 'check-config', '--config', str(path)]), \
                    self.assertLogs(app.LOG, level='ERROR') as logs:
                self.assertEqual(app.main(), 1)
            self.assertIn('JSONDecodeError', str(logs.output))
            self.assertNotIn('FAKE_SECRET', str(logs.output))


class ToolkitTests(unittest.TestCase):
    def shell(self, code):
        return subprocess.run(['bash', '-c', 'source "$1"\n' + code, 'test', str(ROOT/'server-toolkit.sh')],
                              capture_output=True, text=True, timeout=10,
                              env=dict(os.environ, TOOLKIT_LANG='en', DRY_RUN='1'))

    def test_dry_run_never_mutates_or_reads_credentials(self):
        result = self.shell('''
update_apt_once() { echo UNEXPECTED_APT; return 90; }
systemctl() { echo UNEXPECTED_SYSTEMCTL; return 90; }
runuser() { echo UNEXPECTED_RUNUSER; return 90; }
install_login_notify
configure_login_notify
login_notify_command test
uninstall_login_notify
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('UNEXPECTED', result.stdout)
        self.assertIn('DRY RUN', result.stdout)

    def test_explicit_profile_only_and_dispatch(self):
        result = self.shell('''
is_profile_module_known login_notify || exit 1
for profile in minimal docker-host dev-box secure-server; do
    modules="$(profile_modules_for_preset "$profile")" || exit 3
    case " $modules " in *" login_notify "*) exit 2 ;; esac
done
invoke_action() { echo "ACTION:$1"; }
run_profile_module login_notify
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('ACTION:install_login_notify', result.stdout)


if __name__ == '__main__':
    unittest.main()
