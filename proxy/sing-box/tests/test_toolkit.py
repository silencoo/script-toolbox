from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "generate-client-config.py"
INSTALLER = ROOT / "install-node.sh"

SPEC = importlib.util.spec_from_file_location("generate_client_config", GENERATOR)
assert SPEC and SPEC.loader
generator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = generator
SPEC.loader.exec_module(generator)


class NodeParsingTests(unittest.TestCase):
    def test_parses_encoded_password_and_ipv6(self) -> None:
        node = generator.parse_node_link(
            "anytls://pa%40ss@[2001:db8::1]:8443?sni=example.com&insecure=false#jp%201",
            7,
        )
        self.assertEqual(node.password, "pa@ss")
        self.assertEqual(node.server, "2001:db8::1")
        self.assertEqual(node.server_port, 8443)
        self.assertEqual(node.tag, "jp-1")
        self.assertFalse(node.insecure)

    def test_rejects_unknown_boolean_value(self) -> None:
        with self.assertRaisesRegex(generator.ComposeError, "line 3: invalid boolean"):
            generator.parse_node_link(
                "anytls://password@example.com:443?insecure=treu#node",
                3,
            )

    def test_reserved_and_duplicate_tags_become_unique(self) -> None:
        nodes = [
            generator.parse_node_link("anytls://password@a.example:443#direct", 1),
            generator.parse_node_link("anytls://password@b.example:443#direct", 2),
        ]
        generator.make_unique_tags(nodes, generator.RESERVED_TAGS)
        self.assertEqual([node.tag for node in nodes], ["direct-node", "direct-node-2"])


class GeneratorIntegrationTests(unittest.TestCase):
    def run_generator(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(GENERATOR), *arguments],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def write_nodes(self, directory: Path) -> Path:
        nodes = directory / "nodes.txt"
        nodes.write_text(
            "anytls://password@1.2.3.4:443?sni=example.com&insecure=1#jp-1\n",
            encoding="utf-8",
        )
        return nodes

    def test_generated_files_are_private_and_cache_rule_sets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            nodes = self.write_nodes(directory)
            simple = directory / "simple.json"
            grouped = directory / "grouped.json"

            result = self.run_generator(
                "--nodes",
                str(nodes),
                "--simple-out",
                str(simple),
                "--grouped-out",
                str(grouped),
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            for output in (simple, grouped):
                mode = stat.S_IMODE(output.stat().st_mode)
                self.assertEqual(mode, stat.S_IRUSR | stat.S_IWUSR)
                config = json.loads(output.read_text(encoding="utf-8"))
                self.assertTrue(config["experimental"]["cache_file"]["enabled"])

    def test_no_cache_option_omits_cache_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            nodes = self.write_nodes(directory)
            output = directory / "client.json"
            result = self.run_generator(
                "--nodes",
                str(nodes),
                "--emit",
                "simple",
                "--simple-out",
                str(output),
                "--no-cache",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("experimental", json.loads(output.read_text(encoding="utf-8")))

    def test_refuses_to_overwrite_node_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            nodes = self.write_nodes(Path(temporary_directory))
            result = self.run_generator(
                "--nodes",
                str(nodes),
                "--emit",
                "simple",
                "--simple-out",
                str(nodes),
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("must not overwrite", result.stderr)
            self.assertTrue(nodes.read_text(encoding="utf-8").startswith("anytls://"))

    @unittest.skipIf(os.name == "nt", "symlink behavior differs on Windows")
    def test_atomic_write_replaces_symlink_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            nodes = self.write_nodes(directory)
            target = directory / "target.txt"
            target.write_text("keep-me\n", encoding="utf-8")
            output = directory / "client.json"
            output.symlink_to(target)

            result = self.run_generator(
                "--nodes",
                str(nodes),
                "--emit",
                "simple",
                "--simple-out",
                str(output),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(output.is_symlink())
            self.assertEqual(target.read_text(encoding="utf-8"), "keep-me\n")


class InstallerHelperTests(unittest.TestCase):
    def test_version_and_ipv6_helpers_on_bash_3_compatible_code(self) -> None:
        command = f"""
          source {INSTALLER!s}
          version_at_least 1.12.0 1.12.0
          version_at_least 1.13.16 1.12.0
          ! version_at_least 1.11.11 1.12.0
          SERVER_HOST='[2001:db8::1]'
          normalize_server_host
          [[ "$SERVER_HOST" == '2001:db8::1' ]]
        """
        result = subprocess.run(
            ["bash", "-c", command],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
