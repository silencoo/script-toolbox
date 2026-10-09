"""Exercise native install sequencing in isolated paths without root or apt."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).parent


@unittest.skipUnless(sys.platform.startswith("linux"), "Native installer requires Linux")
class NativeInstallTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="mihomo-native-install-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.library = self.root / "lib"
        self.units = self.root / "units"
        self.units.mkdir()
        self.config = self.root / "config" / "manager.json"
        self.config.parent.mkdir()
        self.config.write_text('{"active":"keep-this-profile"}\n')
        self.events = self.root / "events.jsonl"
        self.environment = {
            **os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "NATIVE_TEST_ROOT": str(self.root), "NATIVE_TEST_NEEDS_DEPS": "1",
        }
        fake_python = r'''
import json, os
from pathlib import Path
import shutil, sys
root = Path(os.environ["NATIVE_TEST_ROOT"])
args = sys.argv[1:]
with (root / "events.jsonl").open("a") as stream:
    stream.write(json.dumps(["python", *args]) + "\n")
if args[:2] == ["-m", "venv"]:
    target = Path(args[2]) / "bin" / "python"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(__file__, target)
    target.chmod(0o755)
elif args[:2] == ["-m", "pip"]:
    (root / "dependencies-ready").touch()
elif args and args[0] == "-c" and "importlib.metadata" in args[1]:
    if os.environ.get("NATIVE_TEST_NEEDS_DEPS") == "1" and not (root / "dependencies-ready").exists():
        sys.exit(1)
elif args and args[0] == str(root / "bin" / "mihomo-console"):
    config = root / "config" / "manager.json"
    if "install" in args:
        config.write_text('{"active":"new-profile"}\n')
    if "install" in args or "configure-systemd-sandbox" in args:
        for unit in ["mihomo-subscription-update.service", "mihomo-console-web.service"]:
            folder = root / "units" / (unit + ".d")
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "paths.conf").write_text("[Service]\nReadWritePaths=\nReadWritePaths=" + str(config.parent) + "\n")
        (root / "units" / "mihomo-subscription-update.timer.d").mkdir(exist_ok=True)
'''
        self.stub("python3", fake_python)
        self.stub("systemctl", r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ["NATIVE_TEST_ROOT"])
args = sys.argv[1:]
with (root / "events.jsonl").open("a") as stream:
    stream.write(json.dumps(["systemctl", *args]) + "\n")
if args and args[0] == "show":
    print("running")
if args and args[0] == "is-active" and os.environ.get("NATIVE_TEST_START_FAIL") == "1":
    sys.exit(1)
''')
        self.stub("sleep", "pass\n")
        text = (SOURCE / "setup.sh").read_text()
        # Only this isolated test copy skips the root guard; every destination is
        # relocated, and service/package commands are stubs on its private PATH.
        text = text.replace("if ((EUID != 0)); then", "if false; then", 1)
        assignments = {
            "SOURCE_DIR": str(SOURCE), "MANAGER_BIN": str(self.bin / "mihomo-console"),
            "DOC_DIR": str(self.root / "docs"), "LIB_DIR": str(self.library),
            "SYSTEMD_DIR": str(self.units), "MANAGER_CONFIG": str(self.config),
        }
        lines = text.splitlines()
        for index, line in enumerate(lines):
            name = line.split("=", 1)[0]
            if name in assignments:
                lines[index] = name + "=" + shlex.quote(assignments[name])
        self.script = self.root / "setup.sh"
        self.script.write_text("\n".join(lines) + "\n")

    def stub(self, name, code):
        path = self.bin / name
        path.write_text("#!" + sys.executable + "\n" + code)
        path.chmod(0o755)

    def run_setup(self, *args, success=True):
        result = subprocess.run(["bash", str(self.script), *args], env=self.environment,
                                capture_output=True, text=True, timeout=30)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def calls(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def test_existing_install_starts_web_and_preserves_profile_and_timer(self):
        before = self.config.read_bytes()
        self.run_setup("--install-only")
        calls = self.calls()
        self.assertIn(["systemctl", "enable", "mihomo-console-web.service"], calls)
        self.assertIn(["systemctl", "restart", "mihomo-console-web.service"], calls)
        self.assertLess(calls.index(["systemctl", "reset-failed", "mihomo-console-web.service"]),
                        calls.index(["systemctl", "restart", "mihomo-console-web.service"]))
        self.assertEqual(self.config.read_bytes(), before)
        actions = [call for call in calls if call[0] == "systemctl" and call[1] in {"enable", "disable", "start", "stop", "restart"}]
        self.assertTrue(all(call[-1] == "mihomo-console-web.service" for call in actions))
        self.assertEqual((self.bin / "mihomo-console").read_text().splitlines()[0], "#!" + str(self.library / "venv/bin/python"))
        self.assertEqual((self.bin / "mihomo-subscription-manager").resolve(), self.bin / "mihomo-console")
        for filename in ["index.html", "app-icon.png", "favicon.ico", "favicon-32.png", "apple-touch-icon.png"]:
            self.assertTrue((self.library / "web" / filename).is_file())
        self.assertEqual((self.units / "mihomo-console-web.service").read_bytes(), (SOURCE / "mihomo-console-web.service").read_bytes())
        self.events.write_text("")
        self.run_setup("--install-only")
        self.assertFalse(any(call[1:3] in [["-m", "venv"], ["-m", "pip"]] for call in self.calls()))

    def test_no_start_does_not_enable_or_restart_services(self):
        self.run_setup("--install-only", "--no-start")
        self.assertFalse(any(call[0] == "systemctl" and call[1] in {"enable", "restart", "start"} for call in self.calls()))
        self.assertTrue((self.units / "mihomo-console-web.service").is_file())

    def test_lan_and_local_options_are_saved_before_web_service_start(self):
        for option, access in [("--web-lan", "--lan"), ("--web-local", "--local")]:
            self.events.write_text("")
            self.run_setup("--install-only", option)
            calls = self.calls()
            configured = next(index for index, call in enumerate(calls) if "web-access" in call)
            self.assertIn(access, calls[configured])
            self.assertIn("--no-restart", calls[configured])
            self.assertLess(configured, calls.index(["systemctl", "restart", "mihomo-console-web.service"]))
        self.events.write_text("")
        self.run_setup("--install-only")
        self.assertFalse(any("web-access" in call for call in self.calls()))
        unit = (self.units / "mihomo-console-web.service").read_text()
        self.assertLess(unit.index("EnvironmentFile=-/etc/default/mihomo-console-web\n"),
                        unit.index("EnvironmentFile=-/etc/default/mihomo-console-web-access\n"))

    def test_lan_option_with_no_start_saves_access_without_starting_service(self):
        self.run_setup("--install-only", "--web-lan", "--no-start")
        calls = self.calls()
        self.assertTrue(any("web-access" in call and "--lan" in call and "--no-restart" in call for call in calls))
        self.assertFalse(any(call[0] == "systemctl" and call[1] in {"enable", "restart", "start"} for call in calls))
        self.run_setup("--web-lan", "--web-local", success=False)

    def test_uninitialized_install_only_does_not_start_web(self):
        self.config.unlink()
        self.run_setup("--install-only")
        self.assertFalse(self.config.exists())
        self.assertFalse(any(call[0] == "systemctl" and call[1] in {"enable", "restart", "start"} for call in self.calls()))

    def test_fresh_install_starts_web_before_terminal_onboarding(self):
        self.config.unlink()
        self.run_setup()
        calls = self.calls()
        started = calls.index(["systemctl", "restart", "mihomo-console-web.service"])
        onboarded = next(index for index, call in enumerate(calls) if call[0] == "python" and "manager.onboard" in " ".join(call))
        self.assertLess(started, onboarded)

    def test_start_failure_is_reported_as_failed_install(self):
        self.environment["NATIVE_TEST_START_FAIL"] = "1"
        result = self.run_setup("--install-only", success=False)
        self.assertIn("Web UI startup failed", result.stderr)
        self.assertNotIn("Web UI started:", result.stdout)

    @unittest.skipUnless(shutil.which("systemd-analyze"), "systemd-analyze is unavailable")
    def test_web_service_passes_systemd_validation(self):
        unit = self.root / "mihomo-console-web.service"
        text = (SOURCE / unit.name).read_text()
        # The installed executable is not present on a development checkout.
        text = text.replace("/usr/local/lib/mihomo-console/venv/bin/python", sys.executable)
        unit.write_text(text)
        result = subprocess.run(["systemd-analyze", "verify", str(unit)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
