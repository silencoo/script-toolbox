#!/usr/bin/env python3
"""Login alerts for Debian 12/13. Standard library + system libsystemd only.

No authentication hooks, shell commands, credentials in argv, or raw-log storage.
The journal reader and HTTP worker use separate SQLite connections.
"""
import argparse
import ctypes as C
import datetime as dt
import errno
import fcntl
import getpass
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import random
import re
import signal
import sqlite3
import stat
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo

CONFIG = '/etc/login-notify/config.json'
STATE = '/var/lib/login-notify'
LOG = logging.getLogger('login-notify')
DEFAULTS = dict(machine_alias='', timezone='', server_url='https://api.day.app',
                device_key='', max_events=10000, sent_retention_days=7,
                pending_retention_days=30, request_timeout=10,
                retry_initial=5, retry_max=3600)


def clean(value, limit=256):
    if not isinstance(value, str):
        return '未知'
    value = ''.join(c for c in value if c.isprintable()).strip()
    return value[:limit] or '未知'


def timestamp(usec, timezone=''):
    try:
        value = dt.datetime.fromtimestamp(int(usec) / 1e6, dt.timezone.utc)
        value = value.astimezone(ZoneInfo(timezone)) if timezone else value.astimezone()
        rendered = value.strftime('%Y-%m-%d %H:%M:%S %z')
        return rendered[:-2] + ':' + rendered[-2:]
    except (ValueError, TypeError, OverflowError, OSError):
        return '未知'


SSH_PROCESSES = {'sshd', 'sshd-session', 'sshd-auth'}
SSH_EXES = {'/usr/sbin/sshd', '/usr/bin/sshd'} | {
    directory + '/' + name for directory in ('/usr/lib/openssh', '/usr/libexec/openssh', '/usr/libexec')
    for name in SSH_PROCESSES}


def identify(entry):
    """Require trusted root process metadata, then recognize a success message.

    SYSLOG_IDENTIFIER alone is sender-controlled and is never sufficient.
    Terminal names do not participate in deciding whether a login happened.
    """
    if entry.get('_UID') != '0':
        return None
    message = entry.get('MESSAGE', '')
    if not isinstance(message, str):
        return None
    comm, exe = entry.get('_COMM'), entry.get('_EXE')
    unit = entry.get('_SYSTEMD_UNIT', '')
    ssh = exe in SSH_EXES or (not exe and comm in SSH_PROCESSES and
                             re.fullmatch(r'sshd?(?:@[^/]+)?\.service', unit or ''))
    local = exe in ('/usr/bin/login', '/bin/login') or (not exe and comm == 'login')
    event = None
    if ssh and re.match(r'^Accepted(?:\s|$)', message):
        method = re.match(r'^Accepted\s+((?!for\b|from\b)\S+)', message)
        user = re.search(r'\bfor\s+(\S+)', message)
        source = re.search(r'\bfrom\s+(\S+)', message)
        source_ip = '未知'
        if source:
            try:
                source_ip = str(ipaddress.ip_address(source[1]))
            except ValueError:
                pass
        event = dict(kind='ssh', user=clean(user[1] if user else None),
                     method=clean(method[1] if method else None), source_ip=source_ip)
    elif local and re.match(r'^pam_unix\(login:session\): session opened(?:\s|$)', message):
        user = re.search(r'\bfor user\s+([^\s(]+)', message)
        terminal = entry.get('TTY') or entry.get('_TTY')
        if not terminal:
            tty = re.search(r'\btty=(\S+)', message)
            terminal = tty[1] if tty else None
        if not terminal:
            match = re.fullmatch(r'(?:serial-getty|getty)@(.+)\.service', unit or '')
            if match:
                terminal = re.sub(r'\\x([0-9a-fA-F]{2})',
                                  lambda m: chr(int(m[1], 16)), match[1])
        if isinstance(terminal, str) and terminal.startswith('/dev/'):
            terminal = terminal[5:]
        event = dict(kind='local', user=clean(user[1] if user else None), tty=clean(terminal))
    if event:
        event['time_us'] = entry.get('__REALTIME_TIMESTAMP')
    return event


class Journal:
    """Small typed binding to stable sd-journal APIs (available on both targets).

    Reads the local system journal, not just the SSH unit. Each handle stays on
    the creating thread. get_cursor() memory is allocated by libc and freed here.
    """
    FIELDS = ('MESSAGE', '_UID', '_COMM', '_EXE', '_SYSTEMD_UNIT',
              'SYSLOG_IDENTIFIER', 'TTY', '_TTY')

    def __init__(self):
        self.lib = C.CDLL('libsystemd.so.0')
        self.libc = C.CDLL(None)
        self.libc.free.argtypes = [C.c_void_p]
        self.libc.free.restype = None
        specs = {
            'open': [C.POINTER(C.c_void_p), C.c_int],
            'close': [C.c_void_p], 'next': [C.c_void_p], 'previous': [C.c_void_p],
            'seek_tail': [C.c_void_p],
            'seek_cursor': [C.c_void_p, C.c_char_p],
            'test_cursor': [C.c_void_p, C.c_char_p],
            'seek_realtime_usec': [C.c_void_p, C.c_uint64],
            'get_cursor': [C.c_void_p, C.POINTER(C.c_void_p)],
            'get_realtime_usec': [C.c_void_p, C.POINTER(C.c_uint64)],
            'get_data': [C.c_void_p, C.c_char_p, C.POINTER(C.c_void_p), C.POINTER(C.c_size_t)],
            'set_data_threshold': [C.c_void_p, C.c_size_t],
            'wait': [C.c_void_p, C.c_uint64],
            'has_persistent_files': [C.c_void_p],
        }
        for name, args in specs.items():
            fn = getattr(self.lib, 'sd_journal_' + name)
            fn.argtypes = args
            fn.restype = None if name == 'close' else C.c_int
        self.handle = C.c_void_p()
        self.check(self.lib.sd_journal_open(C.byref(self.handle), 1 | 4))
        self.call('set_data_threshold', 8192)

    @staticmethod
    def check(rc):
        if rc < 0:
            raise OSError(-rc, 'journal API failed')
        return rc

    def call(self, name, *args):
        return self.check(getattr(self.lib, 'sd_journal_' + name)(self.handle, *args))

    def close(self):
        if self.handle:
            self.lib.sd_journal_close(self.handle)
            self.handle = None

    def entry(self):
        result = {}
        for field in self.FIELDS:
            data, size = C.c_void_p(), C.c_size_t()
            rc = self.lib.sd_journal_get_data(self.handle, field.encode(), C.byref(data), C.byref(size))
            if rc == -errno.ENOENT:
                continue
            self.check(rc)
            # Only copy a bounded prefix, even if libsystemd returns a larger field.
            raw = C.string_at(data, min(size.value, 8192))
            result[field] = raw.split(b'=', 1)[1].decode('utf-8', 'replace')
        cursor, usec = C.c_void_p(), C.c_uint64()
        self.call('get_cursor', C.byref(cursor))
        try:
            result['__CURSOR'] = C.string_at(cursor).decode('ascii')
        finally:
            self.libc.free(cursor)
        self.call('get_realtime_usec', C.byref(usec))
        result['__REALTIME_TIMESTAMP'] = usec.value
        return result

    def tail(self):
        self.call('seek_tail')
        return self.entry() if self.call('previous') else None

    def next(self):
        return self.entry() if self.call('next') else None

    def previous(self):
        return self.entry() if self.call('previous') else None

    def resume(self, cursor):
        encoded = cursor.encode('ascii')
        try:
            self.call('seek_cursor', encoded)
            return bool(self.call('next') and self.call('test_cursor', encoded))
        except OSError as exc:
            if exc.errno in (errno.EINVAL, errno.ENOENT):
                return False
            raise

    def seek_time(self, usec):
        self.call('seek_realtime_usec', int(usec))

    def wait(self):
        try:
            return self.call('wait', 1000000)
        except InterruptedError:
            return 0


class Store:
    def __init__(self, path, config):
        self.config = config
        self.db = sqlite3.connect(path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                due REAL NOT NULL DEFAULT 0, sent REAL, error TEXT);
            CREATE INDEX IF NOT EXISTS events_due ON events(status, due);
            CREATE TABLE IF NOT EXISTS alerts (
                kind TEXT PRIMARY KEY, count INTEGER NOT NULL, first REAL NOT NULL,
                last REAL NOT NULL, start_us INTEGER, end_us INTEGER);
        ''')

    def close(self):
        self.db.close()

    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return row[0] if row else default

    def put(self, key, value):
        self.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, str(value)))

    def alert(self, kind, count=1, start_us=None, end_us=None):
        now = time.time()
        self.db.execute('''INSERT INTO alerts VALUES (?,?,?,?,?,?)
            ON CONFLICT(kind) DO UPDATE SET count=count+excluded.count, last=excluded.last,
            start_us=MIN(COALESCE(start_us, excluded.start_us), excluded.start_us),
            end_us=MAX(COALESCE(end_us, excluded.end_us), excluded.end_us)''',
                        (kind, count, now, now, start_us, end_us))

    def maintain(self, now):
        self.db.execute("DELETE FROM events WHERE status='sent' AND sent<?",
                        (now - self.config['sent_retention_days'] * 86400,))
        expired = self.db.execute("SELECT COUNT(*),MIN(created),MAX(created) FROM events WHERE status='pending' AND created<?",
                                  (now - self.config['pending_retention_days'] * 86400,)).fetchone()
        if expired[0]:
            self.alert('pending_expired', expired[0], int(expired[1]*1e6), int(expired[2]*1e6))
            self.db.execute("DELETE FROM events WHERE status='pending' AND created<?",
                            (now - self.config['pending_retention_days'] * 86400,))
            LOG.error('Pending retention exceeded; loss recorded in alerts')

    def enqueue(self, event_id, event, now):
        if self.db.execute('SELECT 1 FROM events WHERE id=?', (event_id,)).fetchone():
            return False
        count = self.db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        if count >= self.config['max_events']:
            self.db.execute("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE status='sent' ORDER BY sent LIMIT ?)",
                            (count - self.config['max_events'] + 1,))
            count = self.db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        if count >= self.config['max_events']:
            if not self.db.execute("SELECT 1 FROM alerts WHERE kind='queue_full'").fetchone():
                LOG.error('Queue capacity exceeded; loss recorded in persistent alerts')
            self.alert('queue_full', start_us=event.get('time_us'), end_us=event.get('time_us'))
            # The persistent aggregate is authoritative; avoid flooding journal.
            return False
        self.db.execute('INSERT INTO events(id,payload,created) VALUES (?,?,?)',
                        (event_id, json.dumps(event, ensure_ascii=False), now))
        return True

    def consume(self, entries):
        if not entries:
            return
        now = time.time()
        with self.db:
            for entry in entries:
                cursor = entry['__CURSOR']
                event = identify(entry)
                if event:
                    event_id = hashlib.sha256(cursor.encode()).hexdigest()
                    self.enqueue(event_id, event, now)
                    self.put('last_' + event['kind'], entry['__REALTIME_TIMESTAMP'])
            # The checkpoint and all events (or explicit loss records) commit together.
            self.put('cursor', entries[-1]['__CURSOR'])
            self.put('realtime_us', entries[-1]['__REALTIME_TIMESTAMP'])
            self.put('last_read', now)

    def status(self):
        def wall_time(key):
            value = self.get(key)
            return timestamp(int(float(value)*1e6), self.config['timezone']) if value else None
        oldest = self.db.execute("SELECT MIN(created) FROM events WHERE status='pending'").fetchone()[0]
        alerts = []
        for row in self.db.execute('SELECT * FROM alerts ORDER BY last DESC'):
            alert = dict(row)
            for key in ('first', 'last'):
                alert[key] = timestamp(int(alert[key]*1e6), self.config['timezone'])
            for key in ('start_us', 'end_us'):
                alert[key[:-3]] = timestamp(alert.pop(key), self.config['timezone'])
            alerts.append(alert)
        return dict(queue={r[0]: r[1] for r in self.db.execute('SELECT status,COUNT(*) FROM events GROUP BY status')},
                    checkpoint_saved=bool(self.get('cursor')),
                    last_read=wall_time('last_read'), last_sent=wall_time('last_sent'),
                    last_ssh=timestamp(self.get('last_ssh'), self.config['timezone']),
                    last_local=timestamp(self.get('last_local'), self.config['timezone']),
                    pending_attempts=self.db.execute("SELECT COALESCE(MAX(attempts),0) FROM events WHERE status='pending'").fetchone()[0],
                    oldest_pending=timestamp(int(oldest*1e6), self.config['timezone']) if oldest else None,
                    pending_errors={r[0]:r[1] for r in self.db.execute("SELECT error,COUNT(*) FROM events WHERE status='pending' AND error IS NOT NULL GROUP BY error")},
                    alerts=alerts)


def prepare(journal, store):
    cursor = store.get('cursor')
    if cursor is None:
        tail = journal.tail()
        if tail is None:
            # An empty view may mean missing read permissions. Never call it healthy.
            raise RuntimeError('No readable system journal entries')
        with store.db:
            store.put('cursor', tail['__CURSOR'])
            store.put('realtime_us', tail['__REALTIME_TIMESTAMP'])
        LOG.info('Initialized at current journal tail; history skipped')
    elif cursor and journal.resume(cursor):
        pass  # Positioned on the committed record; next() returns its successor.
    else:
        # Do not silently accept the closest entry returned by seek_cursor().
        if cursor:
            with store.db:
                store.alert('journal_gap', start_us=int(store.get('realtime_us')), end_us=int(time.time()*1e6))
                store.put('cursor', '')
            LOG.error('Journal cursor unavailable; gap recorded; recovering from saved realtime timestamp')
        journal.seek_time(store.get('realtime_us'))


def validate_config(data):
    if not isinstance(data, dict) or set(data) - set(DEFAULTS):
        raise ValueError('Invalid configuration fields')
    config = dict(DEFAULTS, **data)
    for key in ('machine_alias', 'timezone', 'server_url', 'device_key'):
        if not isinstance(config[key], str) or len(config[key]) > 2048:
            raise ValueError('Invalid configuration text')
    if not config['machine_alias'].strip() or not config['device_key'].strip():
        raise ValueError('Machine alias and device key are required')
    url = urllib.parse.urlsplit(config['server_url'])
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or
            url.query or url.fragment or url.path not in ('', '/')):
        raise ValueError('Bark server must be an HTTPS origin without key/path/query')
    _ = url.port
    config['server_url'] = config['server_url'].rstrip('/')
    if config['timezone']:
        ZoneInfo(config['timezone'])
    bounds = dict(max_events=(10, 1000000), sent_retention_days=(1, 365),
                  pending_retention_days=(1, 365), request_timeout=(1, 60),
                  retry_initial=(1, 3600), retry_max=(5, 86400))
    for key, (low, high) in bounds.items():
        if type(config[key]) is not int or not low <= config[key] <= high:
            raise ValueError('Invalid numeric configuration')
    if config['retry_initial'] > config['retry_max']:
        raise ValueError('Invalid retry bounds')
    return config


def load_config(path):
    info = os.lstat(path)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
            stat.S_IMODE(info.st_mode) not in (0o600, 0o640)):
        raise ValueError('Config must be root-owned, mode 0600 or 0640, and not a symlink')
    with open(path, encoding='utf-8') as stream:
        return validate_config(json.load(stream))


def payload(event, config):
    machine = clean(config['machine_alias'])
    when = timestamp(event.get('time_us'), config['timezone'])
    if event['kind'] == 'test':
        title, body = '🔔 登录通知测试', f'机器：{machine}\n时间：{when}\n测试通知，不代表实际登录事件。'
    elif event['kind'] == 'ssh':
        title = '🔐 SSH 登录成功'
        body = f"机器：{machine}\n用户：{clean(event.get('user'))}\n来源：{clean(event.get('source_ip'))}\n认证：{clean(event.get('method'))}\n时间：{when}"
    else:
        title = '🖥 本地控制台登录'
        body = f"机器：{machine}\n用户：{clean(event.get('user'))}\n终端：{clean(event.get('tty'))}\n时间：{when}"
    return dict(device_key=config['device_key'], title=title, body=body, group='登录通知')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send(event, config):
    request = urllib.request.Request(config['server_url'] + '/push',
                                     data=json.dumps(payload(event, config), ensure_ascii=False).encode(),
                                     headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    # No environment proxy inheritance or redirects carrying credentials elsewhere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=config['request_timeout']) as response:
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise RuntimeError('Bark rejected request')
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get('code') != 200:
            raise RuntimeError('Bark rejected request')


def deliver_one(store, config, send_fn=send, now=None):
    explicit_now = now is not None
    now = time.time() if now is None else now
    row = store.db.execute("SELECT * FROM events WHERE status='pending' AND due<=? ORDER BY due,created LIMIT 1", (now,)).fetchone()
    if row is None:
        return False
    try:
        send_fn(json.loads(row['payload']), config)
    except Exception as exc:
        # Never stringify an HTTP exception, URL, response, or user-controlled text.
        error = type(exc).__name__
        delay = min(config['retry_max'], config['retry_initial'] * 2**min(row['attempts'], 20))
        delay = min(config['retry_max'], delay * random.uniform(0.8, 1.2))
        with store.db:
            store.db.execute('UPDATE events SET attempts=attempts+1,due=?,error=? WHERE id=?',
                             ((now if explicit_now else time.time()) + delay, error, row['id']))
        LOG.warning('Bark delivery failed (%s); retry scheduled', error)
    else:
        with store.db:
            store.db.execute("UPDATE events SET status='sent',sent=?,error=NULL WHERE id=?", (time.time(), row['id']))
            store.put('last_sent', time.time())
    return True


def worker(path, config, stop):
    store = Store(path, config)
    try:
        while not stop.is_set():
            if not deliver_one(store, config):
                stop.wait(1)
    except Exception as exc:
        LOG.error('Sender stopped (%s)', type(exc).__name__)
    finally:
        store.close()


def run(state, config):
    os.umask(0o077)
    with open(state / 'daemon.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal, store = Journal(), Store(state / 'queue.sqlite3', config)
        stop = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stop.set())
        thread = None
        try:
            prepare(journal, store)
            if not journal.call('has_persistent_files'):
                with store.db:
                    store.alert('journal_not_persistent')
                LOG.warning('No persistent journal files; reboot recovery may have gaps')
            with store.db:
                store.maintain(time.time())
            thread = threading.Thread(target=worker, args=(state / 'queue.sqlite3', config, stop), daemon=True)
            thread.start()
            maintenance = time.monotonic()
            while not stop.is_set():
                if not thread.is_alive():
                    raise RuntimeError('Sender unavailable')
                batch = []
                for _ in range(128):
                    entry = journal.next()
                    if entry is None:
                        break
                    batch.append(entry)
                store.consume(batch)
                if time.monotonic() - maintenance >= 60:
                    with store.db:
                        store.maintain(time.time())
                    maintenance = time.monotonic()
                if not batch and journal.wait() == 2:  # File set changed, including rotation/vacuum.
                    prepare(journal, store)
        finally:
            stop.set()
            journal.close()
            store.close()
            if thread:
                thread.join(timeout=2)


def configure(path, chinese=False):
    """Read secrets from the terminal, never shell argv/env; atomically replace config.

    Existing config is retained until every input is validated. This path deliberately
    avoids the toolkit's general backup/report mechanism, which handles public files.
    """
    if not sys.stdin.isatty() or os.geteuid() != 0:
        raise RuntimeError('Configuration requires an interactive root terminal')
    data = load_config(path) if path.exists() else dict(DEFAULTS)
    prompts = [('machine_alias', 'Machine alias', '机器别名'),
               ('server_url', 'Bark server origin (no key)', 'Bark 服务地址（不含 key）'),
               ('timezone', 'Notification timezone (- = system; empty = keep)', '通知时区（- 使用系统时区；留空保留）')]
    for key, en, zh in prompts:
        current = data[key] or (os.uname().nodename if key == 'machine_alias' else '')
        answer = input(f'{zh if chinese else en} [{current}]: ').strip()
        data[key] = '' if key == 'timezone' and answer == '-' else answer or current
    prompt = 'Bark key（输入隐藏；留空保留已有值）: ' if chinese else 'Bark key (hidden; empty keeps existing): '
    key = getpass.getpass(prompt)
    data['device_key'] = key or data['device_key']
    data = validate_config(data)
    import grp
    gid = grp.getgrnam('login-notify').gr_gid
    fd, temporary = tempfile.mkstemp(prefix='.config-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, gid)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print('Configuration saved.' if not chinese else '配置已保存。')


def probe(chinese=False):
    """Read-only compatibility check, independent of credentials and queue.

    At most 100k entries / seven days. Missing samples are unverified, not failures.
    Output contains normalized fields and provenance, never original messages/IPs.
    """
    journal = Journal()
    found, scanned = {}, 0
    try:
        cutoff = int((time.time() - 7*86400)*1e6)
        entry = journal.tail()
        cursor_exact = bool(entry and journal.resume(entry['__CURSOR']))
        if entry and not cursor_exact:
            raise RuntimeError('Journal changed during probe; retry')
        for _ in range(100000):
            if entry is None or entry['__REALTIME_TIMESTAMP'] < cutoff:
                break
            scanned += 1
            event = identify(entry)
            if event:
                key = event['kind'] + ':' + event.get('method', 'login')
                if key not in found:
                    sample = dict(event)
                    if 'source_ip' in sample:
                        sample['source_ip'] = '<redacted>'
                    sample.update({k: clean(entry.get(k)) for k in ('_COMM', '_EXE', '_SYSTEMD_UNIT')})
                    found[key] = sample
            entry = journal.previous()
        print(json.dumps(dict(scanned=scanned, scan_limit_reached=scanned == 100000,
                              cursor_roundtrip=cursor_exact,
                              persistent=bool(journal.call('has_persistent_files')),
                              ssh='observed' if any(k.startswith('ssh:') for k in found) else 'unverified',
                              local='observed' if 'local:login' in found else 'unverified',
                              samples=found), ensure_ascii=not chinese, indent=2))
    finally:
        journal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('run', 'configure', 'check-config', 'test', 'status', 'probe'))
    parser.add_argument('--config', default=CONFIG)
    parser.add_argument('--state-dir', default=STATE)
    parser.add_argument('--zh', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    os.umask(0o077)
    try:
        if args.command == 'configure':
            configure(Path(args.config), args.zh)
            return 0
        if args.command == 'probe':
            probe(args.zh)
            return 0
        config = load_config(args.config)
        if args.command == 'check-config':
            print('Configuration valid (credentials hidden).')
            return 0
        state = Path(args.state_dir)
        if args.command == 'run':
            run(state, config)
            return 0
        if not (state / 'queue.sqlite3').exists():
            raise RuntimeError('Start the service to initialize its queue first')
        store = Store(state / 'queue.sqlite3', config)
        try:
            if args.command == 'test':
                with store.db:
                    ok = store.enqueue('test:' + uuid.uuid4().hex,
                                       dict(kind='test', time_us=int(time.time()*1e6)), time.time())
                if not ok:
                    raise RuntimeError('Queue full; test not enqueued')
                print('Test queued; check service status for delivery.')
            else:
                print(json.dumps(store.status(), ensure_ascii=not args.zh, indent=2))
        finally:
            store.close()
        return 0
    except Exception as exc:
        # Configuration errors may contain the key too (JSON, URL parsing, etc.).
        LOG.error('Operation failed (%s); check configuration, permissions, journal and disk space', type(exc).__name__)
        return 1


if __name__ == '__main__':
    sys.exit(main())
