import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "promptctl.py"
spec = importlib.util.spec_from_file_location("script_toolbox_promptctl", MODULE_PATH)
promptctl = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = promptctl
spec.loader.exec_module(promptctl)


def run_cli(tmp_path, *arguments):
    return promptctl.main([*map(str, arguments), "--home", str(tmp_path)])


def test_normalize_name_accepts_filename_and_rejects_paths():
    assert promptctl.normalize_name("personal") == "personal"
    assert promptctl.normalize_name("team-rules.md") == "team-rules"

    for value in ("", ".", "..", "../rules", "nested/rules", r"nested\rules", "has space"):
        with pytest.raises(promptctl.PromptctlError):
            promptctl.normalize_name(value)


def test_install_defaults_to_preview_without_writes(tmp_path, capsys):
    assert run_cli(tmp_path, "install", "all") == 0

    output = capsys.readouterr().out
    assert "[DRY RUN]" in output
    assert str(tmp_path / ".claude" / "instructions" / "personal.md") in output
    assert str(tmp_path / ".codex" / "instructions" / "personal.md") in output
    assert not (tmp_path / ".claude").exists()
    assert not (tmp_path / ".codex").exists()


def test_claude_install_creates_link_and_never_overwrites_user_edits(tmp_path):
    assert run_cli(tmp_path, "install", "claude", "--yes") == 0

    memory = tmp_path / ".claude" / "CLAUDE.md"
    instructions = tmp_path / ".claude" / "instructions" / "personal.md"
    assert "@instructions/personal.md" in memory.read_text(encoding="utf-8")
    assert "script-toolbox-promptctl:start profile=personal" in memory.read_text(
        encoding="utf-8"
    )
    assert "This file belongs to you" in instructions.read_text(encoding="utf-8")

    edited = "# My Claude rules\n\nAlways explain risky changes first.\n"
    instructions.write_text(edited, encoding="utf-8")

    assert run_cli(tmp_path, "install", "claude", "--yes") == 0
    assert instructions.read_text(encoding="utf-8") == edited
    assert not list(instructions.parent.glob("personal.md.bak_*"))


def test_claude_existing_memory_round_trips_through_install_and_uninstall(tmp_path):
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    memory = claude_dir / "CLAUDE.md"
    original = "# Existing Claude memory\n"
    memory.write_text(original, encoding="utf-8")

    assert run_cli(tmp_path, "install", "claude", "--yes") == 0
    assert memory.read_text(encoding="utf-8").startswith(original + "\n")

    assert run_cli(tmp_path, "uninstall", "claude", "--yes") == 0
    assert memory.read_text(encoding="utf-8") == original
    assert (claude_dir / "instructions" / "personal.md").is_file()


def test_codex_install_prepends_owned_top_level_block_and_preserves_config(tmp_path):
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    original = 'model = "gpt-5.6"\n\n[profiles.work]\nmodel = "gpt-5.6-terra"\n'
    config.write_text(original, encoding="utf-8")

    assert run_cli(tmp_path, "install", "codex", "--yes") == 0

    content = config.read_text(encoding="utf-8")
    assert content.startswith("# script-toolbox-promptctl:start profile=personal\n")
    assert 'model_instructions_file = "./instructions/personal.md"' in content
    assert content.endswith(original)
    assert (codex_dir / "instructions" / "personal.md").is_file()

    assert run_cli(tmp_path, "status", "codex") == 0


def test_codex_bom_crlf_config_round_trips_exactly(tmp_path):
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    original = '\ufeffmodel = "gpt-5.6"\r\n\r\n[profiles.work]\r\nmodel = "other"\r\n'
    config.write_text(original, encoding="utf-8", newline="")

    assert run_cli(tmp_path, "install", "codex", "--yes") == 0
    with config.open("r", encoding="utf-8", newline="") as handle:
        installed = handle.read()
    assert installed.startswith(
        "\ufeff# script-toolbox-promptctl:start profile=personal\r\n"
    )
    assert "\r\nmodel_instructions_file" in installed
    assert run_cli(tmp_path, "status", "codex") == 0

    assert run_cli(tmp_path, "uninstall", "codex", "--yes") == 0
    with config.open("r", encoding="utf-8", newline="") as handle:
        assert handle.read() == original


def test_codex_existing_instruction_key_fails_closed_without_writes(tmp_path, capsys):
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    original = 'model_instructions_file = "./existing.md"\nmodel = "gpt-5.6"\n'
    config.write_text(original, encoding="utf-8")

    assert run_cli(tmp_path, "install", "codex", "--yes") == 1

    error = capsys.readouterr().err
    assert "already defines model_instructions_file" in error
    assert config.read_text(encoding="utf-8") == original
    assert not (codex_dir / "instructions").exists()


def test_all_clients_preflight_before_any_write(tmp_path):
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    (codex_dir / "config.toml").write_text(
        'model_instructions_file = "./owned-elsewhere.md"\n',
        encoding="utf-8",
    )

    assert run_cli(tmp_path, "install", "all", "--yes") == 1
    assert not (tmp_path / ".claude").exists()
    assert not (codex_dir / "instructions").exists()


def test_custom_template_is_used_once_then_user_content_is_preserved(tmp_path):
    template = tmp_path / "template.md"
    template.write_text("# First template\n", encoding="utf-8")

    assert (
        run_cli(
            tmp_path,
            "install",
            "codex",
            "--template",
            template,
            "--yes",
        )
        == 0
    )
    instructions = tmp_path / ".codex" / "instructions" / "personal.md"
    assert instructions.read_text(encoding="utf-8") == "# First template\n"

    instructions.write_text("# User-owned edit\n", encoding="utf-8")
    template.write_text("# Replacement template\n", encoding="utf-8")
    assert (
        run_cli(
            tmp_path,
            "install",
            "codex",
            "--template",
            template,
            "--yes",
        )
        == 0
    )
    assert instructions.read_text(encoding="utf-8") == "# User-owned edit\n"


def test_uninstall_preserves_user_owned_instructions_by_default(tmp_path):
    assert run_cli(tmp_path, "install", "codex", "--yes") == 0
    config = tmp_path / ".codex" / "config.toml"
    instructions = tmp_path / ".codex" / "instructions" / "personal.md"
    edited = "# Keep this\n"
    instructions.write_text(edited, encoding="utf-8")

    assert run_cli(tmp_path, "uninstall", "codex", "--yes") == 0

    assert instructions.read_text(encoding="utf-8") == edited
    assert "script-toolbox-promptctl" not in config.read_text(encoding="utf-8")
    assert list(config.parent.glob("config.toml.bak_*"))


def test_explicit_instruction_removal_backs_up_user_content(tmp_path):
    assert run_cli(tmp_path, "install", "claude", "--yes") == 0
    instructions = tmp_path / ".claude" / "instructions" / "personal.md"
    edited = "# Important user rules\n"
    instructions.write_text(edited, encoding="utf-8")

    assert (
        run_cli(
            tmp_path,
            "uninstall",
            "claude",
            "--remove-instructions",
            "--yes",
        )
        == 0
    )

    assert not instructions.exists()
    backups = list(instructions.parent.glob("personal.md.bak_*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == edited


def test_status_json_reports_link_and_editable_file(tmp_path, capsys):
    assert run_cli(tmp_path, "install", "all", "--yes") == 0
    capsys.readouterr()

    assert run_cli(tmp_path, "status", "all", "--json") == 0
    payload = json.loads(capsys.readouterr().out)

    assert [item["client"] for item in payload] == ["claude", "codex"]
    assert all(item["installed"] is True for item in payload)
    assert all(item["instructions"] == "editable" for item in payload)


def test_path_prints_stable_edit_locations(tmp_path, capsys):
    assert run_cli(tmp_path, "path", "all") == 0
    lines = capsys.readouterr().out.splitlines()

    assert lines == [
        f"claude\t{tmp_path / '.claude' / 'instructions' / 'personal.md'}",
        f"codex\t{tmp_path / '.codex' / 'instructions' / 'personal.md'}",
    ]


def test_malformed_owned_markers_fail_closed(tmp_path, capsys):
    claude_dir = tmp_path / ".claude"
    claude_dir.mkdir()
    memory = claude_dir / "CLAUDE.md"
    original = "<!-- script-toolbox-promptctl:start profile=personal -->\n"
    memory.write_text(original, encoding="utf-8")

    assert run_cli(tmp_path, "install", "claude", "--yes") == 1
    assert "malformed" in capsys.readouterr().err
    assert memory.read_text(encoding="utf-8") == original
    assert not (claude_dir / "instructions").exists()


def test_existing_profile_must_be_uninstalled_before_switching(tmp_path, capsys):
    assert run_cli(tmp_path, "install", "codex", "--name", "first", "--yes") == 0
    capsys.readouterr()

    assert run_cli(tmp_path, "install", "codex", "--name", "second", "--yes") == 1
    assert "already managed for profile 'first'" in capsys.readouterr().err
    assert not (tmp_path / ".codex" / "instructions" / "second.md").exists()


def test_profile_clone_switch_current_and_delete_lifecycle(tmp_path, capsys):
    assert run_cli(tmp_path, "install", "all", "--yes") == 0
    claude_personal = tmp_path / ".claude" / "instructions" / "personal.md"
    codex_personal = tmp_path / ".codex" / "instructions" / "personal.md"
    claude_personal.write_text("# Claude personal\n", encoding="utf-8")
    codex_personal.write_text("# Codex personal\n", encoding="utf-8")
    capsys.readouterr()

    assert run_cli(tmp_path, "profile", "create", "work", "--from", "personal") == 0
    assert not (tmp_path / ".claude" / "instructions" / "work.md").exists()
    assert run_cli(
        tmp_path, "profile", "create", "work", "--from", "personal", "--yes"
    ) == 0
    assert (tmp_path / ".claude" / "instructions" / "work.md").read_text(
        encoding="utf-8"
    ) == "# Claude personal\n"
    assert (tmp_path / ".codex" / "instructions" / "work.md").read_text(
        encoding="utf-8"
    ) == "# Codex personal\n"
    capsys.readouterr()

    assert run_cli(tmp_path, "plan", "--target", "all", "--profile", "work") == 0
    assert "profile=personal" in (tmp_path / ".codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    assert run_cli(
        tmp_path, "apply", "--target", "all", "--profile", "work", "--yes"
    ) == 0
    capsys.readouterr()

    assert run_cli(tmp_path, "current", "--target", "all", "--json") == 0
    current = json.loads(capsys.readouterr().out)
    assert [item["profile"] for item in current] == ["work", "work"]
    assert all(item["healthy"] is True for item in current)

    assert run_cli(tmp_path, "profile", "delete", "work", "--yes") == 1
    assert "is active" in capsys.readouterr().err
    assert run_cli(
        tmp_path, "apply", "--target", "all", "--profile", "personal", "--yes"
    ) == 0
    assert run_cli(tmp_path, "profile", "delete", "work", "--yes") == 0
    assert not (tmp_path / ".claude" / "instructions" / "work.md").exists()
    assert list((tmp_path / ".claude" / "instructions").glob("work.md.bak_*"))


def test_all_client_switch_restores_first_client_when_second_write_fails(
    tmp_path, capsys, monkeypatch
):
    assert run_cli(tmp_path, "install", "all", "--yes") == 0
    assert run_cli(
        tmp_path, "profile", "create", "work", "--from", "personal", "--yes"
    ) == 0
    claude_link = tmp_path / ".claude" / "CLAUDE.md"
    codex_link = tmp_path / ".codex" / "config.toml"
    claude_before = claude_link.read_text(encoding="utf-8")
    codex_before = codex_link.read_text(encoding="utf-8")
    original_apply = promptctl._apply_plan

    def fail_codex(plan, timestamp):
        if plan.layout.client == "codex":
            raise OSError("simulated second-client failure")
        return original_apply(plan, timestamp)

    monkeypatch.setattr(promptctl, "_apply_plan", fail_codex)
    capsys.readouterr()
    assert run_cli(
        tmp_path, "apply", "--target", "all", "--profile", "work", "--yes"
    ) == 1
    assert "simulated second-client failure" in capsys.readouterr().err
    assert claude_link.read_text(encoding="utf-8") == claude_before
    assert codex_link.read_text(encoding="utf-8") == codex_before


def test_explicit_dry_run_wins_over_yes(tmp_path):
    assert run_cli(tmp_path, "install", "claude", "--dry-run", "--yes") == 0
    assert not (tmp_path / ".claude").exists()


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unavailable")
def test_instruction_symlink_is_rejected_without_touching_target(tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("# Outside\n", encoding="utf-8")
    instructions_dir = tmp_path / ".codex" / "instructions"
    instructions_dir.mkdir(parents=True)
    link = instructions_dir / "personal.md"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    assert run_cli(tmp_path, "install", "codex", "--yes") == 1
    assert outside.read_text(encoding="utf-8") == "# Outside\n"
    assert not (tmp_path / ".codex" / "config.toml").exists()


def test_engine_without_arguments_points_to_shell_frontend(capsys):
    assert promptctl.main([]) == 2
    assert "agent/promptctl/promptctl" in capsys.readouterr().err
