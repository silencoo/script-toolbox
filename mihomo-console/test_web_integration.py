"""Optional end-to-end web/runtime tests using an isolated real Mihomo process."""
import copy
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar


FIXTURE_TOKEN = "isolated-web-fixture-token-" + "a" * 40


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class SubscriptionFixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/invalid"):
            payload = b"proxies: [{name: broken, type: unsupported-fixture-type}]\nrules: ['MATCH,DIRECT']\n"
        else:
            payload = b"proxies: [{name: fixture-direct, type: direct}]\nproxy-groups: [{name: fixture, type: select, proxies: [fixture-direct, DIRECT]}]\nrules: ['MATCH,DIRECT']\n"
        self.send_response(200)
        self.send_header("Content-Type", "application/yaml")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args):
        pass


class LANWebTests(unittest.TestCase):
    def test_all_interface_listener_preserves_login_session_and_csrf(self):
        import mihomo_console as manager
        import web_server
        from test_web import WebTests
        from unittest import mock
        fixture = WebTests("test_minimal_login_assets_and_security_headers")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_TOKEN": FIXTURE_TOKEN}):
            server = web_server.make_server(fixture.config, "0.0.0.0", 0)
        def close_server():
            server.task_dispatcher.shutdown()
            server.close()
        self.addCleanup(close_server)
        threading.Thread(target=server.run, daemon=True).start()
        address = manager.lan_ipv4_address() or "127.0.0.1"
        origin = f"http://{address}:{server.effective_port}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()))
        def call(route, data=None, csrf=""):
            request = urllib.request.Request(origin + "/api/" + route,
                data=json.dumps(data).encode() if data is not None else None,
                headers={"Content-Type": "application/json", "Origin": origin, "X-CSRF-Token": csrf})
            with opener.open(request, timeout=5) as response:
                return json.load(response)
        for route, data, expected in [("state", None, 401), ("login", {"token": "wrong"}, 401)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                call(route, data)
            self.assertEqual(error.exception.code, expected)
        session = call("login", {"token": FIXTURE_TOKEN})
        snapshot = call("state")
        self.assertNotIn(FIXTURE_TOKEN, json.dumps(snapshot))
        with self.assertRaises(urllib.error.HTTPError) as error:
            call("logout", {})
        self.assertEqual(error.exception.code, 403)
        call("logout", {}, session["csrf"])
        with self.assertRaises(urllib.error.HTTPError) as error:
            call("state")
        self.assertEqual(error.exception.code, 401)


@unittest.skipUnless(os.environ.get("MIHOMO_TEST_BINARY"), "Set MIHOMO_TEST_BINARY to run the isolated web/runtime test")
class WebRuntimeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mihomo-web-live-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.web_port, self.controller_port, self.mixed_port = unused_port(), unused_port(), unused_port()
        self.url = f"http://127.0.0.1:{self.web_port}"
        self.source = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SubscriptionFixture)
        threading.Thread(target=self.source.serve_forever, daemon=True).start()
        def close_source():
            self.source.shutdown()
            self.source.server_close()
        self.addCleanup(close_source)
        self.subscription = f"http://127.0.0.1:{self.source.server_port}/subscription?token=isolated-url-secret"
        launcher = self.root / "run.py"
        module_dir = Path(__file__).resolve().parent
        launcher.write_text(f'''import sys\nfrom pathlib import Path\nsys.path.insert(0, {str(module_dir)!r})\nimport container_runtime as runtime\nroot = Path({str(self.root)!r})\nruntime.DATA_DIR = root / "data"\nruntime.MANAGER_DIR = runtime.DATA_DIR / "manager"\nruntime.MIHOMO_HOME = runtime.DATA_DIR / "mihomo"\nruntime.LOG_DIR = runtime.DATA_DIR / "logs"\nruntime.MANAGER_CONFIG = runtime.MANAGER_DIR / "subscription-manager.json"\nruntime.OVERLAY_FILE = runtime.MANAGER_DIR / "local-overrides.yaml"\nruntime.TARGET_CONFIG = runtime.MIHOMO_HOME / "config.yaml"\nruntime.BACKUP_DIR = runtime.MANAGER_DIR / "backups"\nruntime.RUNTIME_DIR = root / "run"\nruntime.RUNTIME_FILE = runtime.RUNTIME_DIR / "runtime.json"\nruntime.LOCK_FILE = runtime.RUNTIME_DIR / "update.lock"\nruntime.MIHOMO_BINARY = Path({os.environ['MIHOMO_TEST_BINARY']!r})\nruntime.SEEDED_DATA_DIR = root / "unused-seed"\nraise SystemExit(runtime.main())\n''')
        self.log = (self.root / "runtime.log").open("w")
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen([sys.executable, str(launcher)], stdout=self.log, stderr=subprocess.STDOUT,
            env={**os.environ, "MIHOMO_WEB_TOKEN": FIXTURE_TOKEN, "MIHOMO_WEB_HOST": "127.0.0.1",
                 "MIHOMO_WEB_PORT": str(self.web_port), "CONTROLLER_PORT": str(self.controller_port),
                 "MIXED_PORT": str(self.mixed_port), "UPDATE_INTERVAL_SECONDS": "0",
                 "MIHOMO_WEB_PUBLIC_URL": "", "MIHOMO_WEB_SECURE_COOKIE": "false", "MIHOMO_WEB_TRUSTED_HOSTS": ""})
        def stop_runtime():
            if self.process.poll() is None:
                self.process.terminate()
                self.process.wait(timeout=10)
        self.addCleanup(stop_runtime)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                self.call("login", {"token": FIXTURE_TOKEN})
                self.csrf = self.call("session")["csrf"]
                if self.call("state")["service"] == "active":
                    break
            except (OSError, urllib.error.URLError):
                pass
            if self.process.poll() is not None:
                self.fail("Isolated runtime exited: " + (self.root / "runtime.log").read_text())
            time.sleep(.05)
        else:
            self.fail("Isolated runtime did not become ready: " + (self.root / "runtime.log").read_text())

    def call(self, route, data=None):
        request = urllib.request.Request(self.url + "/api/" + route,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json", "X-CSRF-Token": getattr(self, "csrf", ""), "Origin": self.url})
        with self.opener.open(request, timeout=10) as response:
            return json.load(response)

    def wait_job(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            job = self.call("state")["jobs"][0]
            if job["status"] != "running":
                return job
            time.sleep(.1)
        self.fail("The isolated web update did not finish")

    def test_real_subscription_validation_apply_restart_and_rejection(self):
        self.call("subscriptions", {"name": "Fixture subscription", "url": self.subscription})
        target = self.root / "data/mihomo/config.yaml"
        initial = target.read_bytes()
        self.call("subscriptions/action", {"name": "Fixture subscription", "action": "validate"})
        job = self.wait_job()
        self.assertEqual(job["status"], "succeeded", job)
        self.assertEqual(target.read_bytes(), initial)
        before = json.loads((self.root / "run/runtime.json").read_text())["generation"]
        self.call("subscriptions/action", {"name": "Fixture subscription", "action": "update"})
        job = self.wait_job()
        self.assertEqual(job["status"], "succeeded", job)
        saved = target.read_bytes()
        self.assertIn(b"fixture-direct", saved)
        self.assertGreater(json.loads((self.root / "run/runtime.json").read_text())["generation"], before)
        self.assertEqual(self.call("state")["service"], "active")
        self.assertTrue(list((self.root / "data/manager/backups").iterdir()))
        invalid_url = f"http://127.0.0.1:{self.source.server_port}/invalid"
        self.call("subscriptions", {"name": "Invalid fixture", "url": invalid_url})
        self.call("subscriptions/action", {"name": "Invalid fixture", "action": "update"})
        self.assertEqual(self.wait_job()["status"], "failed")
        self.assertEqual(target.read_bytes(), saved)
        self.assertEqual(self.call("state")["active"], "Fixture subscription")
        self.call("schedule", {"interval": "6h", "enabled": True})
        self.assertEqual(self.call("state")["schedule"]["interval"], "6h")
        self.assertNotIn("isolated-url-secret", json.dumps(self.call("state")))
        self.assertNotIn(FIXTURE_TOKEN, (self.root / "runtime.log").read_text())


if __name__ == "__main__":
    unittest.main()
