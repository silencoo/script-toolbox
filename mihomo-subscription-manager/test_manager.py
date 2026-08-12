#!/usr/bin/env python3

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("mihomo_subscription_manager.py")
SPEC = importlib.util.spec_from_file_location("mihomo_subscription_manager", MODULE_PATH)
assert SPEC and SPEC.loader
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


class ManagerTests(unittest.TestCase):
    @staticmethod
    def command_result(returncode=0, stdout=""):
        return subprocess.CompletedProcess([], returncode, stdout=stdout)

    def test_overlay_replaces_remote_controller_and_secret(self):
        remote = b"""
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 443
external-controller: 0.0.0.0:9090
secret: ""
dns:
  enable: true
  nameserver: [1.1.1.1]
"""
        overlay = {
            "external-controller": "127.0.0.1:9090",
            "secret": "local-secret",
            "dns": {"ipv6": False},
        }
        rendered = manager.yaml.safe_load(manager.render_profile(remote, overlay))
        self.assertEqual(rendered["external-controller"], "127.0.0.1:9090")
        self.assertEqual(rendered["secret"], "local-secret")
        self.assertTrue(rendered["dns"]["enable"])
        self.assertFalse(rendered["dns"]["ipv6"])

    def test_rejects_non_profile_payload(self):
        with self.assertRaises(manager.ManagerError):
            manager.render_profile(b"message: subscription expired\n", {})

    def test_secure_atomic_write_replaces_and_sets_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.yaml"
            manager.secure_atomic_write(path, b"first\n")
            manager.secure_atomic_write(path, b"second\n")
            self.assertEqual(path.read_bytes(), b"second\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_successful_update_installs_profile_and_records_metadata(self):
        remote = b"""
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 443
secret: remote-secret
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.yaml"
            target.write_text("proxies: []\n", encoding="utf-8")
            overlay = root / "overlay.yaml"
            overlay.write_text("secret: local-secret\n", encoding="utf-8")
            manager_config = root / "manager.json"
            registry = {
                **manager.DEFAULTS,
                "target_config": str(target),
                "overlay_file": str(overlay),
                "backup_dir": str(root / "backups"),
                "lock_file": str(root / "manager.lock"),
                "active": "primary",
                "subscriptions": {"primary": {"url": "https://example.invalid/sub"}},
            }
            manager.save_registry(manager_config, registry)

            with (
                mock.patch.object(manager, "download_profile", return_value=remote),
                mock.patch.object(manager, "validate_with_mihomo"),
                mock.patch.object(manager, "restart_mihomo"),
            ):
                changed = manager.update_profile(manager_config, registry, "primary")

            installed = manager.yaml.safe_load(target.read_text(encoding="utf-8"))
            saved = manager.load_registry(manager_config)
            self.assertTrue(changed)
            self.assertEqual(installed["secret"], "local-secret")
            self.assertIn("last_success", saved["subscriptions"]["primary"])
            self.assertEqual(len(list((root / "backups").iterdir())), 1)

    def test_failed_restart_rolls_back_old_profile(self):
        remote = b"""
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 443
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.yaml"
            old_data = b"proxies:\n  - name: old-node\n"
            target.write_bytes(old_data)
            manager_config = root / "manager.json"
            registry = {
                **manager.DEFAULTS,
                "target_config": str(target),
                "overlay_file": str(root / "missing-overlay.yaml"),
                "backup_dir": str(root / "backups"),
                "lock_file": str(root / "manager.lock"),
                "active": "primary",
                "subscriptions": {"primary": {"url": "https://example.invalid/sub"}},
            }
            manager.save_registry(manager_config, registry)

            restart_results = [manager.ManagerError("new config failed"), None]

            def fake_restart(_registry):
                result = restart_results.pop(0)
                if result:
                    raise result

            with (
                mock.patch.object(manager, "download_profile", return_value=remote),
                mock.patch.object(manager, "validate_with_mihomo"),
                mock.patch.object(manager, "restart_mihomo", side_effect=fake_restart),
            ):
                with self.assertRaises(manager.ManagerError):
                    manager.update_profile(manager_config, registry, "primary")

            self.assertEqual(target.read_bytes(), old_data)

    def test_dry_run_does_not_replace_or_record_profile(self):
        remote = b"""
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 443
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.yaml"
            old_data = b"proxies:\n  - name: old-node\n"
            target.write_bytes(old_data)
            manager_config = root / "manager.json"
            registry = {
                **manager.DEFAULTS,
                "target_config": str(target),
                "overlay_file": str(root / "missing-overlay.yaml"),
                "lock_file": str(root / "manager.lock"),
                "active": "primary",
                "subscriptions": {"primary": {"url": "https://example.invalid/sub"}},
            }
            manager.save_registry(manager_config, registry)

            with (
                mock.patch.object(manager, "download_profile", return_value=remote),
                mock.patch.object(manager, "validate_with_mihomo"),
                mock.patch.object(manager, "restart_mihomo") as restart,
            ):
                changed = manager.update_profile(
                    manager_config, registry, "primary", dry_run=True
                )

            self.assertFalse(changed)
            self.assertEqual(target.read_bytes(), old_data)
            self.assertNotIn("last_success", registry["subscriptions"]["primary"])
            restart.assert_not_called()

    def test_identical_profile_updates_active_subscription_without_restart(self):
        remote = b"""
proxies:
  - name: node-a
    type: ss
    server: example.invalid
    port: 443
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "config.yaml"
            target.write_bytes(manager.render_profile(remote, {}))
            manager_config = root / "manager.json"
            registry = {
                **manager.DEFAULTS,
                "target_config": str(target),
                "overlay_file": str(root / "missing-overlay.yaml"),
                "lock_file": str(root / "manager.lock"),
                "active": "old",
                "subscriptions": {
                    "old": {"url": "https://example.invalid/old"},
                    "primary": {"url": "https://example.invalid/sub"},
                },
            }
            manager.save_registry(manager_config, registry)

            with (
                mock.patch.object(manager, "download_profile", return_value=remote),
                mock.patch.object(manager, "validate_with_mihomo"),
                mock.patch.object(manager, "restart_mihomo") as restart,
            ):
                changed = manager.update_profile(manager_config, registry, "primary")

            self.assertFalse(changed)
            self.assertEqual(manager.load_registry(manager_config)["active"], "primary")
            restart.assert_not_called()

    def test_restart_requires_continuous_active_period(self):
        results = [
            self.command_result(),  # restart
            self.command_result(),  # active, but not yet stable
            self.command_result(3),  # briefly failed; stability timer must reset
            self.command_result(),
            self.command_result(),
            self.command_result(),  # continuously active for two seconds
        ]
        monotonic_values = [0, 0, 1, 2, 3, 4]
        with (
            mock.patch.object(manager, "command_output", side_effect=results) as command,
            mock.patch.object(manager.time, "monotonic", side_effect=monotonic_values),
            mock.patch.object(manager.time, "sleep"),
            mock.patch.object(manager, "SERVICE_STABILITY_SECONDS", 2),
        ):
            manager.restart_mihomo({"systemd_service": "mihomo.service"})

        self.assertEqual(command.call_count, 6)

    def test_restart_fails_when_service_never_stays_active(self):
        with (
            mock.patch.object(
                manager,
                "command_output",
                side_effect=[self.command_result(), self.command_result(3)],
            ),
            mock.patch.object(manager.time, "monotonic", side_effect=[0, 15]),
            mock.patch.object(manager.time, "sleep"),
        ):
            with self.assertRaisesRegex(manager.ManagerError, "连续 3 秒"):
                manager.restart_mihomo({"systemd_service": "mihomo.service"})

    def test_prune_backups_keeps_newest_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup_dir = root / "backups"
            backup_dir.mkdir()
            target = root / "config.yaml"
            backups = []
            for index in range(4):
                backup = backup_dir / f"config.yaml.{index}"
                backup.write_text(str(index), encoding="utf-8")
                os.utime(backup, (index, index))
                backups.append(backup)

            manager.prune_backups({"backup_dir": str(backup_dir), "backup_keep": 2}, target)

            self.assertEqual(
                {path.name for path in backup_dir.iterdir()},
                {backups[2].name, backups[3].name},
            )

    def test_concurrent_update_is_rejected_before_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            registry = {
                **manager.DEFAULTS,
                "lock_file": str(root / "manager.lock"),
                "subscriptions": {"primary": {"url": "https://example.invalid/sub"}},
            }
            with (
                mock.patch.object(manager.fcntl, "flock", side_effect=BlockingIOError),
                mock.patch.object(manager, "download_profile") as download,
            ):
                with self.assertRaisesRegex(manager.ManagerError, "另一个更新任务"):
                    manager.update_profile(root / "manager.json", registry, "primary")
            download.assert_not_called()

    def test_systemd_dropin_contains_custom_writable_paths(self):
        with tempfile.TemporaryDirectory(prefix="mihomo paths % ") as directory:
            root = Path(directory)
            registry = {
                **manager.DEFAULTS,
                "target_config": str(root / "config dir" / "config.yaml"),
                "mihomo_home": str(root / "mihomo home"),
                "overlay_file": str(root / "overrides" / "local.yaml"),
                "backup_dir": str(root / "backup dir"),
                "lock_file": str(root / "locks" / "manager.lock"),
            }
            rendered = manager.render_systemd_sandbox_dropin(
                root / "registry" / "manager.json", registry
            ).decode()

            self.assertIn("ReadWritePaths=\n", rendered)
            for expected in (
                root / "registry",
                root / "config dir",
                root / "mihomo home",
                root / "overrides",
                root / "backup dir",
                root / "locks",
            ):
                escaped = str(expected).replace("%", "%%")
                self.assertIn(f'ReadWritePaths="{escaped}"', rendered)

    def test_install_systemd_sandbox_writes_dropin_and_reloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "mihomo-home"
            home.mkdir()
            dropin = root / "systemd" / "paths.conf"
            registry = {
                **manager.DEFAULTS,
                "target_config": str(root / "config" / "config.yaml"),
                "mihomo_home": str(home),
                "overlay_file": str(root / "overlay" / "local.yaml"),
                "backup_dir": str(root / "backups"),
                "lock_file": str(root / "lock" / "manager.lock"),
            }
            with (
                mock.patch.object(manager.os, "geteuid", return_value=0),
                mock.patch.object(
                    manager, "command_output", return_value=self.command_result()
                ) as command,
            ):
                manager.install_systemd_sandbox(
                    root / "registry" / "manager.json", registry, dropin=dropin
                )

            self.assertTrue(dropin.exists())
            self.assertEqual(dropin.stat().st_mode & 0o777, 0o644)
            self.assertEqual((root / "backups").stat().st_mode & 0o777, 0o700)
            command.assert_called_once_with(["systemctl", "daemon-reload"], timeout=60)


if __name__ == "__main__":
    unittest.main()
