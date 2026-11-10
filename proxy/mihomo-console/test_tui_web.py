"""Explicit credential reveal, actual server settings and nonblocking TUI reads."""
import contextlib
import copy
import io
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest import mock

import mihomo_console as manager
from test_locale import make_console

TOKEN = "tui-fixture-token-" + "a" * 48
INFO = {"installed": True, "state": "active", "pid": "42", "address": "http://127.0.0.1:28743"}


class WebAccessTests(unittest.TestCase):
    def test_running_systemd_environment_supplies_actual_address_and_token(self):
        result = subprocess.CompletedProcess([], 0, "LoadState=loaded\nActiveState=active\nMainPID=42\n")
        environment = f"MIHOMO_WEB_PORT=29876\0MIHOMO_WEB_HOST=0.0.0.0\0MIHOMO_WEB_TOKEN={TOKEN}\0OTHER_SECRET=private\0".encode()
        with mock.patch.object(manager, "command_output", return_value=result), mock.patch.object(
            Path, "open", side_effect=lambda *args, **kwargs: io.BytesIO(environment)
        ), mock.patch.object(manager, "lan_ipv4_address", return_value="192.168.1.50"):
            status = manager.collect_web_ui_status({})
            self.assertEqual(status["address"], "http://192.168.1.50:29876")
            self.assertTrue(status["lan"])
            self.assertNotIn(TOKEN, repr(status))
            self.assertNotIn("OTHER_SECRET", repr(status))
            self.assertEqual(manager.read_web_ui_token(Path("/unused/manager.json"), {}), TOKEN)

    def test_file_token_is_reused_without_rotation_or_permission_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "manager.json"
            path = config.parent / "web-token"
            path.write_text(TOKEN + "\n")
            path.chmod(0o600)
            before = path.stat().st_mtime_ns
            with mock.patch.object(manager, "web_ui_runtime", return_value=({"LoadState": "loaded", "ActiveState": "active"}, {})):
                self.assertEqual(manager.read_web_ui_token(config, {}), TOKEN)
            self.assertEqual(path.stat().st_mtime_ns, before)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_stopped_missing_and_control_character_tokens_do_not_create_or_reveal(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "manager.json"
            for properties, environment in [
                ({"LoadState": "not-found"}, {}),
                ({"LoadState": "loaded", "ActiveState": "inactive"}, {}),
                ({"LoadState": "loaded", "ActiveState": "active"}, {}),
                ({"LoadState": "loaded", "ActiveState": "active"}, {"MIHOMO_WEB_TOKEN": TOKEN + "\x1b[2J"}),
            ]:
                with self.subTest(properties=properties), mock.patch.object(manager, "web_ui_runtime", return_value=(properties, environment)):
                    with self.assertRaises(manager.ManagerError) as error:
                        manager.read_web_ui_token(config, {})
                    self.assertNotIn(TOKEN, str(error.exception))
                    self.assertFalse((config.parent / "web-token").exists())

    def test_container_settings_and_environment_token_are_used(self):
        with mock.patch.dict(os.environ, {"MIHOMO_WEB_PORT": "29876", "MIHOMO_WEB_PUBLIC_URL": "https://console.example.invalid", "MIHOMO_WEB_TOKEN": TOKEN, "MIHOMO_WEB_ENABLED": "true"}), mock.patch.object(manager.socket, "create_connection"):
            status = manager.collect_web_ui_status({"service_backend": "container"})
            self.assertEqual(status["address"], "https://console.example.invalid")
            self.assertNotIn(TOKEN, repr(status))
            self.assertEqual(manager.read_web_ui_token(Path("/unused/manager.json"), {"service_backend": "container"}), TOKEN)

    def test_lan_address_prefers_host_interface_and_handles_unavailable_network_info(self):
        interfaces = '[{"ifname":"docker0","addr_info":[{"local":"172.17.0.1"}]},{"ifname":"eth0","addr_info":[{"local":"192.168.1.50"}]}]'
        with mock.patch.object(manager, "command_output", return_value=subprocess.CompletedProcess([], 0, interfaces)):
            self.assertEqual(manager.lan_ipv4_address(), "192.168.1.50")
        with mock.patch.object(manager, "command_output", side_effect=manager.ManagerError("unavailable")):
            self.assertIsNone(manager.lan_ipv4_address())
        with mock.patch.object(manager, "web_ui_runtime", return_value=({"LoadState": "loaded", "ActiveState": "active"}, {"MIHOMO_WEB_HOST": "0.0.0.0"})), mock.patch.object(manager, "lan_ipv4_address", return_value=None):
            self.assertEqual(manager.collect_web_ui_status({})["address"], "http://<server-ip>:28743")


class WebAccessSettingsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "web-access"
        self.registry = {"service_backend": "systemd", "lock_file": str(Path(directory.name) / "lock")}
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(manager, "DEFAULT_WEB_ACCESS_FILE", self.path))
        self.stack.enter_context(mock.patch.object(manager, "require_native_root"))
        self.stack.enter_context(mock.patch.object(manager.time, "sleep"))
        self.stack.enter_context(mock.patch("sys.stdout", new_callable=io.StringIO))
        self.command = self.stack.enter_context(mock.patch.object(manager, "command_output", side_effect=self.success))

    @staticmethod
    def success(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, "LoadState=loaded\nActiveState=active\n" if command[1] == "show" else "")

    def test_toggle_preserves_other_settings_and_restarts_only_web_service(self):
        other = self.path.with_name("web-environment")
        before = f"MIHOMO_WEB_TOKEN={TOKEN}\nMIHOMO_WEB_PORT=29876\n".encode()
        other.write_bytes(before)
        for lan, host in [(True, "0.0.0.0"), (False, "127.0.0.1")]:
            manager.configure_web_access(self.registry, lan=lan)
            self.assertEqual(self.path.read_text(), f"MIHOMO_WEB_HOST={host}\n")
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(other.read_bytes(), before)
        restarts = [call.args[0] for call in self.command.call_args_list if call.args[0][1] == "restart"]
        self.assertEqual(restarts, [["systemctl", "restart", manager.DEFAULT_WEB_SERVICE]] * 2)
        commands = [call.args[0][1] for call in self.command.call_args_list]
        self.assertEqual(commands, ["show", "reset-failed", "restart", "is-active"] * 2)

    def test_save_only_and_stopped_service_do_not_start_or_restart(self):
        manager.configure_web_access(self.registry, lan=True, restart=False)
        self.assertEqual(self.command.call_count, 1)
        self.command.reset_mock()
        self.command.side_effect = lambda command, **kwargs: subprocess.CompletedProcess(command, 0, "LoadState=loaded\nActiveState=inactive\n")
        manager.configure_web_access(self.registry, lan=False)
        self.assertEqual(self.command.call_count, 1)

    def test_stopped_service_status_reads_persisted_access(self):
        self.path.write_text("MIHOMO_WEB_HOST=0.0.0.0\n")
        self.command.side_effect = lambda command, **kwargs: subprocess.CompletedProcess(command, 0, "LoadState=loaded\nActiveState=inactive\n")
        with mock.patch.object(manager, "lan_ipv4_address", return_value="192.168.1.50"):
            status = manager.collect_web_ui_status(self.registry)
        self.assertTrue(status["lan"])
        self.assertEqual(status["address"], "http://192.168.1.50:28743")

    def test_delayed_startup_failure_and_failed_recovery_report_restored_settings(self):
        before = b"MIHOMO_WEB_HOST=127.0.0.1\n"
        self.path.write_bytes(before)
        self.command.side_effect = [self.success(["systemctl", "show"]), subprocess.CompletedProcess([], 0, ""),
                                    subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 1, ""),
                                    subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 1, TOKEN)]
        with self.assertRaises(manager.ManagerError) as error:
            manager.configure_web_access(self.registry, lan=True)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn(TOKEN, str(error.exception))

    def test_failed_restart_restores_previous_access_setting(self):
        for before in (None, b"MIHOMO_WEB_HOST=127.0.0.1\n"):
            if before is None:
                self.path.unlink(missing_ok=True)
            else:
                self.path.write_bytes(before)
            self.command.side_effect = [self.success(["systemctl", "show"]), subprocess.CompletedProcess([], 0, ""),
                                        subprocess.CompletedProcess([], 1, TOKEN), subprocess.CompletedProcess([], 0, ""),
                                        subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 0, "")]
            with self.assertRaises(manager.ManagerError) as error:
                manager.configure_web_access(self.registry, lan=True)
            self.assertNotIn(TOKEN, str(error.exception))
            self.assertEqual(self.path.read_bytes() if self.path.exists() else None, before)

    def test_missing_service_container_and_symlink_are_rejected_without_writes(self):
        self.command.side_effect = lambda command, **kwargs: subprocess.CompletedProcess(command, 0, "LoadState=not-found\n")
        with self.assertRaises(manager.ManagerError):
            manager.configure_web_access(self.registry, lan=True)
        self.assertFalse(self.path.exists())
        with self.assertRaises(manager.ManagerError):
            manager.configure_web_access({"service_backend": "container"}, lan=True)
        target = self.path.with_name("unchanged")
        target.write_text("unchanged")
        self.path.symlink_to(target)
        self.command.side_effect = self.success
        with self.assertRaises(manager.ManagerError):
            manager.configure_web_access(self.registry, lan=True)
        self.assertEqual(target.read_text(), "unchanged")

    def test_running_subscription_blocks_access_change_and_restart(self):
        with manager.operation_lock(self.registry), self.assertRaises(manager.ConcurrentUpdateError):
            manager.configure_web_access(self.registry, lan=True)
        self.command.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_explicit_start_resets_failed_service_and_preserves_access(self):
        self.path.write_bytes(b"MIHOMO_WEB_HOST=0.0.0.0\n")
        manager.restart_web_ui(self.registry)
        calls = [call.args[0] for call in self.command.call_args_list]
        self.assertEqual([call[1] for call in calls], ["show", "reset-failed", "restart", "is-active"])
        self.assertTrue(all(manager.DEFAULT_WEB_SERVICE in call for call in calls))
        self.assertEqual(self.path.read_bytes(), b"MIHOMO_WEB_HOST=0.0.0.0\n")
        self.command.reset_mock()
        with manager.operation_lock(self.registry), self.assertRaises(manager.ConcurrentUpdateError):
            manager.restart_web_ui(self.registry)
        self.command.assert_not_called()

    def test_explicit_start_failure_is_actionable_and_does_not_echo_systemd_output(self):
        self.command.side_effect = [self.success(["systemctl", "show"]), subprocess.CompletedProcess([], 0, ""),
                                    subprocess.CompletedProcess([], 1, TOKEN)]
        with self.assertRaises(manager.ManagerError) as error:
            manager.restart_web_ui(self.registry)
        self.assertIn("journalctl", str(error.exception))
        self.assertNotIn(TOKEN, str(error.exception))


class WebTUITests(unittest.TestCase):
    def setUp(self):
        self.console = make_console()
        self.console.web_status = INFO.copy()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.release = threading.Event()
        self.addCleanup(self.cleanup)
        self.stack.enter_context(mock.patch.object(manager, "LANGUAGE", "en_US"))
        self.stack.enter_context(mock.patch.object(manager, "load_registry", return_value=copy.deepcopy(self.console.registry)))
        self.stack.enter_context(mock.patch.object(manager, "collect_status", return_value=self.console.status))
        self.stack.enter_context(mock.patch.object(manager, "collect_web_ui_status", return_value=INFO.copy()))
        self.reader = self.stack.enter_context(mock.patch.object(manager, "read_web_ui_token", return_value=TOKEN))
        self.console.refresh()
        self.wait_for(lambda: "status" in self.console._checked)

    def cleanup(self):
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
        self.fail("TUI background read did not finish")

    def reveal(self):
        self.console.handle_key(ord("w"))
        self.wait_for(lambda: "web" in self.console._checked)
        self.console.handle_key(ord("v"))
        self.wait_for(lambda: self.console.web_token == TOKEN)

    def test_web_page_does_not_read_token_until_explicit_reveal(self):
        self.console.handle_key(ord("8"))
        self.wait_for(lambda: "web" in self.console._checked)
        self.console.draw()
        self.assertIn("28743", self.console.screen.text)
        self.assertIn("Hidden; press v", self.console.screen.text)
        self.assertNotIn(TOKEN, self.console.screen.text)
        self.reader.assert_not_called()

    def test_lan_toggle_routes_to_settings_and_status_fits_both_languages(self):
        self.console.handle_key(ord("w"))
        self.wait_for(lambda: "web" in self.console._checked)
        with mock.patch.object(self.console, "run_external", side_effect=lambda title, action: action()), mock.patch.object(manager, "configure_web_access") as configure:
            self.console.handle_key(ord("o"))
            configure.assert_called_once_with(self.console.registry, lan=True)
            self.console.web_status["lan"] = True
            self.console.handle_key(ord("o"))
            self.assertEqual(configure.call_args.kwargs, {"lan": False})
        for language in ("en_US", "zh_CN"):
            manager.set_language(language)
            self.console.screen.height, self.console.screen.width = 18, 70
            self.console.web_status.update(lan=True, address="http://192.168.1.50:28743")
            self.console.draw()
            self.assertIn("http://192.168.1.50:28743", self.console.screen.text)
            self.assertIn(manager.tr("局域网"), self.console.screen.text)
            self.assertIn("o ", self.console.screen.text)
            self.assertNotIn(TOKEN, self.console.screen.text)

    def test_failed_service_shows_start_shortcut_and_k_routes_to_web_only(self):
        self.console.handle_key(ord("w"))
        self.wait_for(lambda: "web" in self.console._checked)
        self.console.web_status.update(state="failed", lan=True, address="http://192.168.1.50:28743")
        for language in ("en_US", "zh_CN"):
            manager.set_language(language)
            self.console.screen.height, self.console.screen.width = 18, 70
            self.console.draw()
            self.assertIn("k ", self.console.screen.text)
            self.assertIn("192.168.1.50:28743", self.console.screen.text)
        with mock.patch.object(self.console, "run_external", side_effect=lambda title, action: action()), mock.patch.object(manager, "restart_web_ui") as restart:
            self.console.handle_key(ord("k"))
            restart.assert_called_once_with(self.console.registry)

    def test_reveal_waits_for_service_status_to_finish_loading(self):
        def slow_status(*args):
            self.release.wait(2)
            return INFO.copy()
        with mock.patch.object(manager, "collect_web_ui_status", side_effect=slow_status):
            self.console.handle_key(ord("w"))
            self.console.handle_key(ord("v"))
            self.console.poll_refresh()
            self.reader.assert_not_called()
            self.release.set()
            self.wait_for(lambda: self.console.web_token == TOKEN)

    def test_reveal_wraps_entire_token_in_both_languages_at_minimum_size(self):
        self.reveal()
        for language in ("en_US", "zh_CN"):
            manager.set_language(language)
            self.console.screen.height, self.console.screen.width = 18, 70
            self.console.web_token = TOKEN * 5
            self.console.web_token_scroll = 0
            self.console.draw()
            first_page = [value for row, column, value in self.console.screen.calls if 10 <= row <= 14 and column == 3]
            self.console.handle_key(self.console.curses.KEY_DOWN)
            self.console.draw()
            last_line = next(value for row, column, value in self.console.screen.calls if row == 14 and column == 3)
            self.assertEqual("".join(first_page) + last_line, TOKEN * 5)

    def test_token_is_forgotten_on_hide_navigation_refresh_language_and_quit(self):
        for key in (ord("v"), 27, ord("1"), 9, ord("r"), ord("l"), ord("q")):
            with self.subTest(key=key):
                self.reveal()
                self.console.handle_key(key)
                self.assertIsNone(self.console.web_token)
                self.assertFalse(self.console.web_token_requested)
                self.console.draw()
                self.assertNotIn(TOKEN, self.console.screen.text)
        self.reveal()
        self.console.close()
        self.assertNotIn(TOKEN, self.console.screen.text)

    def test_auto_hide_and_late_reader_after_navigation(self):
        self.reveal()
        self.console.web_token_deadline = time.monotonic() - 1
        self.console.poll_refresh()
        self.assertIsNone(self.console.web_token)
        started = threading.Event()
        def slow(*args):
            started.set()
            self.release.wait(2)
            return TOKEN
        self.reader.side_effect = slow
        self.console.handle_key(ord("v"))
        self.wait_for(lambda: started.is_set())
        began = time.monotonic()
        self.console.handle_key(ord("1"))
        self.console.draw()
        self.assertLess(time.monotonic() - began, 0.5)
        self.release.set()
        self.wait_for(lambda: "web_token" not in self.console._pending)
        self.assertIsNone(self.console.web_token)
        self.assertNotIn(TOKEN, self.console.screen.text)

    def test_token_read_error_can_be_retried_without_exposing_token(self):
        self.reader.side_effect = manager.ManagerError("fixture unavailable")
        self.console.handle_key(ord("w"))
        self.wait_for(lambda: "web" in self.console._checked)
        self.console.handle_key(ord("v"))
        self.wait_for(lambda: "web_token" in self.console._errors)
        self.console.draw()
        self.assertIn("fixture unavailable", self.console.screen.text)
        self.assertNotIn(TOKEN, self.console.screen.text)
        self.reader.side_effect = None
        self.console.handle_key(ord("v"))
        self.wait_for(lambda: self.console.web_token == TOKEN)


@unittest.skipUnless(sys.platform.startswith("linux"), "PTY interaction requires Linux")
class WebTerminalTests(unittest.TestCase):
    def test_real_terminal_reveals_the_token_accepted_by_the_running_web_ui(self):
        import fcntl
        import json
        import pty
        import select
        import struct
        import termios
        from waitress import create_server
        import web_server
        from test_web import WebTests
        fixture = WebTests("test_minimal_login_assets_and_security_headers")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        before = fixture.config.read_bytes()
        server = create_server(web_server.create_app(fixture.config, token=TOKEN), host="127.0.0.1", port=0)
        self.addCleanup(server.close)
        threading.Thread(target=server.run, daemon=True).start()
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 18, 70, 0, 0))
        process = subprocess.Popen([sys.executable, manager.__file__, "--lang", "en_US", "--manager-config", str(fixture.config)],
            stdin=slave, stdout=slave, stderr=slave,
            env={**os.environ, "TERM": "xterm-256color", "LC_ALL": "C.UTF-8", "MIHOMO_WEB_PORT": str(server.effective_port),
                 "MIHOMO_WEB_TOKEN": TOKEN, "MIHOMO_WEB_PUBLIC_URL": "", "MIHOMO_WEB_ENABLED": "true"})
        os.close(slave)
        def stop():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        self.addCleanup(stop)
        def expect(text):
            output = bytearray()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if select.select([master], [], [], .1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
                    rendered = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output).replace(b"\r", b"").replace(b"\n", b"")
                    if text.encode() in rendered:
                        return bytes(output)
            self.fail("Expected terminal text did not appear: " + ("fixture token" if text == TOKEN else text))
        expect("Runtime overview")
        os.write(master, b"w")
        output = expect("http://127.0.0.1:" + str(server.effective_port))
        self.assertNotIn(TOKEN.encode(), output)
        os.write(master, b"v")
        expect(TOKEN)
        # The revealed value must authenticate against the actual fixture server.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(f"http://127.0.0.1:{server.effective_port}/api/login",
            data=json.dumps({"token": TOKEN}).encode(), headers={"Content-Type": "application/json"})
        with opener.open(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
        os.write(master, b"v")
        expect("Hidden; press v")
        os.write(master, b"l")
        expect("已隐藏；按 v 显示")
        os.write(master, b"q")
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(fixture.config.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
