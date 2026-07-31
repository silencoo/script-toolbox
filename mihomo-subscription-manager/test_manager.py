#!/usr/bin/env python3

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
