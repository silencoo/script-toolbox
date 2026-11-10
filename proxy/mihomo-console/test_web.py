"""Server authentication, subscription operations and background-job regressions."""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

import mihomo_console as manager
import web_server


class WebTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="mihomo-web-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = self.root / "manager.json"
        self.registry = copy.deepcopy(manager.DEFAULTS)
        self.registry.update(service_backend="container", target_config=str(self.root / "config.yaml"),
                             lock_file=str(self.root / "lock"), backup_dir=str(self.root / "backups"),
                             runtime_file=str(self.root / "runtime.json"), overlay_file=str(self.root / "overlay.yaml"))
        Path(self.registry["target_config"]).write_text("proxies: []\nsecret: controller-test-secret\n")
        Path(self.registry["runtime_file"]).write_text(json.dumps({"mihomo_state": "running", "mihomo_pid": os.getpid(), "updater_enabled": False}))
        manager.save_registry(self.config, self.registry)
        environment = mock.patch.dict(os.environ, {"MIHOMO_WEB_PUBLIC_URL": "", "MIHOMO_WEB_SECURE_COOKIE": "", "MIHOMO_WEB_TRUSTED_HOSTS": ""})
        environment.start()
        self.addCleanup(environment.stop)
        self.token = "fixture-access-token-" + "1" * 40
        self.app = web_server.create_app(self.config, token=self.token)
        self.app.testing = True
        self.client = self.app.test_client()
        self.service = self.app.extensions["mihomo_web"]
        self.csrf = None

    def login(self):
        response = self.client.post("/api/login", json={"token": self.token})
        self.assertEqual(response.status_code, 200)
        self.csrf = response.json["csrf"]
        return response

    def post(self, path, data):
        return self.client.post("/api/" + path, json=data, headers={"X-CSRF-Token": self.csrf or ""})

    def add(self, name="demo", **extra):
        return self.post("subscriptions", {"name": name, "url": "https://example.invalid/sub?token=private-url-token", **extra})

    def test_api_requires_server_session_for_reads_and_writes(self):
        for path in ("/api/session", "/api/state"):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.add().status_code, 401)
        self.assertEqual(self.client.get("/api/state?token=" + self.token).status_code, 401)
        self.assertEqual(self.client.get("/api/state", headers={"Authorization": "Bearer " + self.token}).status_code, 401)

    def test_minimal_login_assets_and_security_headers(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'type="password"', response.data)
        self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        response.close()
        with self.client.get("/assets/app.js") as asset:
            self.assertEqual(asset.status_code, 200)
        self.assertEqual(self.client.get("/assets/../web-token").status_code, 404)
        self.assertEqual(self.client.get("/assets/web_server.py").status_code, 404)

    def test_login_cookie_is_opaque_http_only_and_bounded(self):
        response = self.login()
        cookie = response.headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Max-Age=43200", cookie)
        self.assertNotIn(self.token, cookie + response.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/session").json["csrf"], self.csrf)
        self.assertEqual(self.client.get("/api/state").status_code, 200)

    def test_invalid_login_and_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.client.post("/api/login", json={"token": "wrong"}).status_code, 401)
        response = self.client.post("/api/login", json={"token": self.token})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "60")

    def test_mutations_require_csrf_json_and_same_origin(self):
        self.login()
        self.assertEqual(self.client.post("/api/subscriptions", json={}).status_code, 403)
        self.assertEqual(self.client.post("/api/subscriptions", json={}, headers={"X-CSRF-Token": "é"}).status_code, 403)
        self.assertEqual(self.client.post("/api/logout", json={}, headers={"X-CSRF-Token": self.csrf, "Origin": "https://attacker.invalid"}).status_code, 403)
        self.assertEqual(self.client.post("/api/logout", data="{}", headers={"X-CSRF-Token": self.csrf}).status_code, 415)
        self.assertEqual(self.client.post("/api/logout", json={}, headers={"X-CSRF-Token": self.csrf, "Origin": "http://localhost"}).status_code, 200)

    def test_logout_revokes_a_previously_valid_cookie(self):
        self.login()
        old = self.client.get_cookie(web_server.COOKIE).value
        self.assertEqual(self.post("logout", {}).status_code, 200)
        self.client.set_cookie(web_server.COOKIE, old)
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_new_login_rotates_session_and_csrf(self):
        self.login()
        old_cookie = self.client.get_cookie(web_server.COOKIE).value
        old_csrf = self.csrf
        self.login()
        self.assertNotEqual(old_csrf, self.csrf)
        self.client.set_cookie(web_server.COOKIE, old_cookie)
        self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_session_expiry(self):
        self.login()
        with mock.patch.object(web_server.time, "monotonic", return_value=time.monotonic() + web_server.SESSION_SECONDS + 1):
            self.assertEqual(self.client.get("/api/state").status_code, 401)

    def test_https_reverse_proxy_uses_configured_origin_and_secure_cookie(self):
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_PUBLIC_URL": "https://console.example.invalid"}):
            client = web_server.create_app(self.config, token=self.token).test_client()
            response = client.post("/api/login", json={"token": self.token}, headers={"Origin": "https://console.example.invalid"})
            self.assertEqual(response.status_code, 200)
            self.assertIn("Secure", response.headers["Set-Cookie"])
            self.assertEqual(client.post("/api/login", json={"token": self.token}, headers={"Origin": "https://attacker.invalid"}).status_code, 403)

    def test_subscription_crud_preserves_credentials_and_hides_urls(self):
        self.login()
        self.assertEqual(self.add(download_proxy="http://user:password@proxy.invalid:7890").status_code, 201)
        snapshot = self.client.get("/api/state").get_data(as_text=True)
        for sensitive in ("private-url-token", "password", self.token, "controller-test-secret"):
            self.assertNotIn(sensitive, snapshot)
        self.assertIn("example.invalid", snapshot)
        self.assertEqual(self.add().status_code, 409)
        self.assertEqual(self.post("subscriptions", {"name": "demo", "editing": True, "user_agent": "custom-agent"}).status_code, 200)
        saved = manager.load_registry(self.config)["subscriptions"]["demo"]
        self.assertIn("private-url-token", saved["url"])
        self.assertIn("password", saved["download_proxy"])
        self.assertEqual(saved["user_agent"], "custom-agent")
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.post("subscriptions/action", {"name": "demo", "action": "remove"}).status_code, 200)
        self.assertIsNone(manager.load_registry(self.config)["active"])
        self.assertTrue(Path(self.registry["target_config"]).exists())

    def test_subscription_input_validation(self):
        self.login()
        for name in ("", "a/b", "a\nname", "a\tname", "a" * 121):
            self.assertEqual(self.add(name).status_code, 400)
        for url in ("", "file:///etc/passwd", "http://[", "https://example.invalid:99999", "https://bad host.invalid"):
            self.assertEqual(self.add(url=url).status_code, 400)
        self.assertEqual(self.post("subscriptions", {"name": "missing", "editing": True}).status_code, 404)
        self.assertEqual(self.post("subscriptions", {"name": "demo", "editing": "true"}).status_code, 400)
        self.assertEqual(self.post("subscriptions", []).status_code, 400)
        self.assertEqual(self.post("subscriptions/action", {"name": "demo", "action": "shell"}).status_code, 400)

    def test_removing_selected_does_not_switch_auto_updates_to_another_source(self):
        self.login()
        self.add("first")
        self.add("second")
        self.post("subscriptions/action", {"name": "first", "action": "remove"})
        self.assertIsNone(manager.load_registry(self.config)["active"])
        self.assertEqual(self.post("subscriptions/action", {"name": "second", "action": "select"}).status_code, 200)
        self.assertEqual(manager.load_registry(self.config)["active"], "second")

    def test_edit_and_schedule_respect_cli_timer_operation_lock(self):
        self.login()
        self.add()
        registry = manager.load_registry(self.config)
        before = self.config.read_bytes()
        with manager.operation_lock(registry):
            self.assertEqual(self.add("another").status_code, 409)
            self.assertEqual(self.post("schedule", {"interval": "6h", "enabled": True}).status_code, 409)
            self.assertEqual(self.post("subscriptions/action", {"name": "demo", "action": "update"}).status_code, 409)
        self.assertEqual(before, self.config.read_bytes())

    def test_schedule_persists_without_systemctl_in_container(self):
        self.login()
        self.add()
        with mock.patch.object(manager, "command_output") as command:
            self.assertEqual(self.post("schedule", {"interval": "6h", "enabled": True}).status_code, 200)
            command.assert_not_called()
        self.assertEqual(manager.update_schedule_settings(manager.load_registry(self.config)), (21600, True))
        self.assertTrue(self.client.get("/api/state").json["schedule"]["enabled"])
        self.assertEqual(self.post("schedule", {"interval": "0m", "enabled": True}).status_code, 400)
        self.assertEqual(self.post("schedule", {"interval": "6h", "enabled": "true"}).status_code, 400)

    def test_background_job_keeps_reads_responsive_and_blocks_duplicate_mutations(self):
        self.login()
        self.add("--help")
        started, release = threading.Event(), threading.Event()
        captured = []
        def run(command, **kwargs):
            captured.append(command)
            started.set()
            release.wait(timeout=5)
            return subprocess.CompletedProcess(command, 0)
        with mock.patch.object(web_server.subprocess, "run", side_effect=run):
            response = self.post("subscriptions/action", {"name": "--help", "action": "validate"})
            self.assertEqual(response.status_code, 202)
            self.assertTrue(started.wait(timeout=1))
            try:
                self.assertEqual(self.client.get("/api/state").status_code, 200)
                self.assertEqual(self.add("another").status_code, 409)
                self.assertEqual(self.post("subscriptions/action", {"name": "--help", "action": "update"}).status_code, 409)
                self.assertEqual(self.post("schedule", {"interval": "6h", "enabled": True}).status_code, 409)
            finally:
                release.set()
            self.wait_job()
        self.assertEqual(captured[0][-3:], ["--dry-run", "--", "--help"])
        self.assertEqual(self.service.jobs[0]["status"], "succeeded")

    def wait_job(self):
        deadline = time.monotonic() + 2
        while self.service.jobs[0]["status"] == "running" and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertNotEqual(self.service.jobs[0]["status"], "running")

    def test_job_failure_diagnostics_redact_subscription_and_controller_secrets(self):
        self.login()
        self.add()
        def fail(command, **kwargs):
            kwargs["stdout"].write(b'Error: https://example.invalid/sub?token=private-url-token controller-test-secret\n')
            return subprocess.CompletedProcess(command, 1)
        with mock.patch.object(web_server.subprocess, "run", side_effect=fail):
            self.post("subscriptions/action", {"name": "demo", "action": "update"})
            self.wait_job()
        diagnostic = self.client.get("/api/state").get_data(as_text=True)
        self.assertNotIn("private-url-token", diagnostic)
        self.assertNotIn("controller-test-secret", diagnostic)
        self.assertEqual(self.service.jobs[0]["status"], "failed")

    def test_configuration_error_shows_cause_instead_of_temporary_path(self):
        diagnostic = 'Error: Mihomo configuration validation failed:\ntime="fixture" level=error msg="proxy 0: unsupported proxy type"\nconfiguration file /tmp/private/.mihomo-candidate.yaml test failed'
        self.assertEqual(manager.sanitize_history_error(self.registry, diagnostic), "proxy 0: unsupported proxy type")

    def test_bootstrap_token_is_persistent_private_and_not_logged(self):
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_TOKEN": ""}), mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            first = web_server.access_token(self.config)
            self.assertEqual(first, web_server.access_token(self.config))
            self.assertEqual(len(first), 64)
            self.assertEqual((self.root / "web-token").stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.getvalue(), "")
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_TOKEN": self.token}):
            self.assertEqual(web_server.access_token(self.config), self.token)
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_TOKEN": "short"}):
            with self.assertRaises(manager.ManagerError):
                web_server.access_token(self.config)

    def test_update_reloads_registry_and_holds_lock_through_history(self):
        registry = manager.load_registry(self.config)
        registry["subscriptions"] = {"demo": {"url": "https://example.invalid/sub"}}
        manager.save_registry(self.config, registry)
        latest = manager.load_registry(self.config)
        latest["subscriptions"]["second"] = {"url": "https://another.invalid/sub"}
        manager.save_registry(self.config, latest)
        def download(_subscription):
            with self.assertRaises(manager.ConcurrentUpdateError):
                with manager.operation_lock(latest):
                    pass
            return b"proxies: [{name: fixture, type: direct}]\nrules: [MATCH,DIRECT]\n"
        original = manager.append_history
        def append(*args):
            with self.assertRaises(manager.ConcurrentUpdateError):
                with manager.operation_lock(latest):
                    pass
            return original(*args)
        with (mock.patch.object(manager, "download_profile", side_effect=download),
              mock.patch.object(manager, "validate_with_mihomo"),
              mock.patch.object(manager, "append_history", side_effect=append)):
            manager.update_profile(self.config, registry, "demo", dry_run=True)
        saved = manager.load_registry(self.config)
        self.assertIn("second", saved["subscriptions"])
        self.assertEqual(saved["history"][-1]["status"], "validated")


if __name__ == "__main__":
    unittest.main()
