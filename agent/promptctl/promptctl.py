#!/usr/bin/env python3
"""Promptctl persistent-instruction manager for clean Claude/Codex environments.

Promptctl owns only a small import/config block. The instruction Markdown
is created once and then belongs to the user: reruns never replace its content,
and uninstall preserves it unless --remove-instructions is explicit.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional, Sequence

VERSION = "0.5.0"
CLIENTS = ("claude", "codex")
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
MODEL_KEY_RE = re.compile(
    r"""(?mx)
    ^[ \t]*
    (?:
        model_instructions_file
        | "model_instructions_file"
        | 'model_instructions_file'
    )
    [ \t]*(?:=|\.)
    """
)
CLAUDE_START = "<!-- script-toolbox-promptctl:start profile={name} -->"
CLAUDE_END = "<!-- script-toolbox-promptctl:end profile={name} -->"
CODEX_START = "# script-toolbox-promptctl:start profile={name}"
CODEX_END = "# script-toolbox-promptctl:end profile={name}"


class PromptctlError(RuntimeError):
    """A fail-closed configuration or filesystem conflict."""


@dataclass(frozen=True)
class Layout:
    client: str
    home: Path
    link_file: Path
    instruction_file: Path
    link_target: str


@dataclass(frozen=True)
class ManagedBlock:
    profile: str
    start: int
    end: int
    body: str


@dataclass(frozen=True)
class ClientPlan:
    operation: str
    layout: Layout
    link_before: Optional[str]
    link_after: Optional[str]
    instruction_action: str
    template_content: Optional[str] = None
    migration_source: Optional[Path] = None

    @property
    def link_changed(self) -> bool:
        return self.link_before != self.link_after


def normalize_name(name: str) -> str:
    raw = (name or "").strip()
    if raw.endswith(".md"):
        raw = raw[:-3]
    if not raw or raw in {".", ".."}:
        raise PromptctlError("--name cannot be empty, '.' or '..'")
    if "/" in raw or "\\" in raw or ".." in raw:
        raise PromptctlError("--name must be one safe filename, not a path")
    if not SAFE_NAME_RE.fullmatch(raw):
        raise PromptctlError(
            "--name accepts only ASCII letters, digits, dots, underscores, and hyphens"
        )
    return raw


def selected_clients(value: str) -> tuple[str, ...]:
    return CLIENTS if value == "all" else (value,)


def resolve_layout(client: str, home: Path, name: str) -> Layout:
    filename = f"{name}.md"
    if client == "claude":
        root = home / ".claude"
        return Layout(
            client=client,
            home=home,
            link_file=root / "CLAUDE.md",
            instruction_file=root / "instructions" / filename,
            link_target=f"@instructions/{filename}",
        )
    if client == "codex":
        root = home / ".codex"
        return Layout(
            client=client,
            home=home,
            link_file=root / "config.toml",
            instruction_file=root / "instructions" / filename,
            link_target=f"./instructions/{filename}",
        )
    raise PromptctlError(f"unsupported client: {client}")


def snippets_directory(home: Path) -> Path:
    return home / ".local" / "share" / "script-toolbox" / "snippets"


def resolve_snippet_path(home: Path, name: str) -> Path:
    return snippets_directory(home) / f"{normalize_name(name)}.md"


def _node_kind(path: Path) -> str:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return "missing"
    if stat.S_ISREG(mode):
        return "regular"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "special"


def _read_optional_regular(path: Path, label: str) -> Optional[str]:
    kind = _node_kind(path)
    if kind == "missing":
        return None
    if kind != "regular":
        raise PromptctlError(f"{label} is {kind}, not a regular file: {path}")
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            return handle.read()
    except UnicodeDecodeError as exc:
        raise PromptctlError(f"{label} is not valid UTF-8: {path}") from exc


def _validate_parent(path: Path) -> None:
    current = path.parent
    missing: list[Path] = []
    while not current.exists():
        missing.append(current)
        if current == current.parent:
            break
        current = current.parent
    if current.exists() and not current.is_dir():
        raise PromptctlError(f"parent path is not a directory: {current}")
    if current.is_symlink():
        raise PromptctlError(f"parent directory is a symlink: {current}")
    for candidate in reversed(missing):
        parent = candidate.parent
        if parent.exists() and parent.is_symlink():
            raise PromptctlError(f"parent directory is a symlink: {parent}")


def _newline(content: str) -> str:
    return "\r\n" if "\r\n" in content else "\n"


def _block_pattern(client: str) -> re.Pattern[str]:
    if client == "claude":
        start = r"<!-- script-toolbox-promptctl:start profile=(?P<profile>[A-Za-z0-9._-]+) -->"
        end = r"<!-- script-toolbox-promptctl:end profile=(?P=profile) -->"
    else:
        start = r"\# script-toolbox-promptctl:start profile=(?P<profile>[A-Za-z0-9._-]+)"
        end = r"\# script-toolbox-promptctl:end profile=(?P=profile)"
    return re.compile(
        rf"(?m)^{start}\r?\n(?P<body>[^\r\n]*)\r?\n^{end}(?:\r?\n)?"
    )


def _marker_tokens(client: str) -> tuple[str, str]:
    if client == "claude":
        return (
            "<!-- script-toolbox-promptctl:start profile=",
            "<!-- script-toolbox-promptctl:end profile=",
        )
    return (
        "# script-toolbox-promptctl:start profile=",
        "# script-toolbox-promptctl:end profile=",
    )


def _managed_blocks(content: str, client: str) -> list[ManagedBlock]:
    offset = 1 if content.startswith("\ufeff") else 0
    scanned = content[offset:]
    matches = list(_block_pattern(client).finditer(scanned))
    start_token, end_token = _marker_tokens(client)
    if content.count(start_token) != len(matches) or content.count(end_token) != len(matches):
        raise PromptctlError(
            f"{client} link file contains malformed script-toolbox-promptctl markers"
        )
    return [
        ManagedBlock(
            profile=match.group("profile"),
            start=match.start() + offset,
            end=match.end() + offset,
            body=match.group("body"),
        )
        for match in matches
    ]


def _block_lines(layout: Layout, name: str) -> tuple[str, str, str]:
    if layout.client == "claude":
        return (
            CLAUDE_START.format(name=name),
            layout.link_target,
            CLAUDE_END.format(name=name),
        )
    return (
        CODEX_START.format(name=name),
        f'model_instructions_file = "{layout.link_target}"',
        CODEX_END.format(name=name),
    )


def _expected_body(layout: Layout) -> str:
    if layout.client == "claude":
        return layout.link_target
    return f'model_instructions_file = "{layout.link_target}"'


def _validate_owned_block(
    content: str,
    layout: Layout,
    name: str,
) -> Optional[ManagedBlock]:
    blocks = _managed_blocks(content, layout.client)
    if len(blocks) > 1:
        raise PromptctlError(
            f"{layout.link_file} contains multiple script-toolbox-promptctl blocks"
        )
    if not blocks:
        return None
    block = blocks[0]
    if block.profile != name:
        raise PromptctlError(
            f"{layout.link_file} is already managed for profile {block.profile!r}; "
            "uninstall it before selecting another profile"
        )
    if block.body != _expected_body(layout):
        raise PromptctlError(
            f"{layout.link_file} managed block was edited; refusing to guess ownership"
        )
    if layout.client == "codex":
        outside = content[: block.start] + content[block.end :]
        if MODEL_KEY_RE.search(outside):
            raise PromptctlError(
                f"{layout.link_file} contains another model_instructions_file key"
            )
    return block


def _render_install(content: str, layout: Layout, name: str) -> tuple[str, bool]:
    block = _validate_owned_block(content, layout, name)
    if block is not None:
        return content, False

    newline = _newline(content)
    rendered = newline.join(_block_lines(layout, name)) + newline
    if layout.client == "claude":
        prefix = content
        if prefix and not prefix.endswith(("\n", "\r")):
            prefix += newline
        if prefix and not prefix.endswith((newline + newline)):
            prefix += newline
        return prefix + rendered, True

    if MODEL_KEY_RE.search(content):
        raise PromptctlError(
            f"{layout.link_file} already defines model_instructions_file outside "
            "script-toolbox-promptctl; use the advanced Codex tool or remove the conflict"
        )
    bom = "\ufeff" if content.startswith("\ufeff") else ""
    remainder = content[len(bom) :]
    separator = newline if remainder else ""
    return bom + rendered + separator + remainder, True


def _render_uninstall(content: str, layout: Layout, name: str) -> tuple[str, bool]:
    block = _validate_owned_block(content, layout, name)
    if block is None:
        return content, False
    before = content[: block.start]
    after = content[block.end :]
    newline = _newline(content)
    if layout.client == "codex" and not before.strip("\ufeff") and after.startswith(newline):
        after = after[len(newline) :]
    if layout.client == "claude" and before.endswith(newline + newline) and not after:
        before = before[: -len(newline)]
    return before + after, True


def _active_block(content: str, layout: Layout) -> Optional[ManagedBlock]:
    """Return the single valid Promptctl block, regardless of profile name."""
    blocks = _managed_blocks(content, layout.client)
    if len(blocks) > 1:
        raise PromptctlError(
            f"{layout.link_file} contains multiple script-toolbox-promptctl blocks"
        )
    if not blocks:
        return None
    block = blocks[0]
    active_layout = resolve_layout(layout.client, layout.home, block.profile)
    if block.body != _expected_body(active_layout):
        raise PromptctlError(
            f"{layout.link_file} managed block was edited; refusing to guess ownership"
        )
    if layout.client == "codex":
        outside = content[: block.start] + content[block.end :]
        if MODEL_KEY_RE.search(outside):
            raise PromptctlError(
                f"{layout.link_file} contains another model_instructions_file key"
            )
    return block


def _render_switch(content: str, layout: Layout, name: str) -> tuple[str, bool]:
    block = _active_block(content, layout)
    if block is None:
        return _render_install(content, layout, name)
    if block.profile == name:
        return content, False
    newline = _newline(content)
    rendered = newline.join(_block_lines(layout, name)) + newline
    return content[: block.start] + rendered + content[block.end :], True


def _default_template_path(client: str) -> Path:
    return Path(__file__).resolve().parent / "templates" / f"{client}-personal.md"


def _load_template(client: str, template: Optional[str]) -> str:
    path = Path(template).expanduser().resolve() if template else _default_template_path(client)
    content = _read_optional_regular(path, "template")
    if content is None:
        raise PromptctlError(f"template does not exist: {path}")
    return content


def _instruction_action(path: Path, remove: bool = False) -> str:
    kind = _node_kind(path)
    if kind == "missing":
        return "missing" if remove else "create"
    if kind != "regular":
        raise PromptctlError(f"instruction path is {kind}, not a regular file: {path}")
    return "remove" if remove else "preserve"


def plan_install(
    layout: Layout,
    name: str,
    template: Optional[str],
) -> ClientPlan:
    _validate_parent(layout.link_file)
    _validate_parent(layout.instruction_file)
    link_before = _read_optional_regular(layout.link_file, f"{layout.client} link file")
    source = link_before or ""
    link_after, _changed = _render_install(source, layout, name)
    instruction_action = _instruction_action(layout.instruction_file)
    template_content = (
        _load_template(layout.client, template) if instruction_action == "create" else None
    )
    return ClientPlan(
        operation="install",
        layout=layout,
        link_before=link_before,
        link_after=link_after,
        instruction_action=instruction_action,
        template_content=template_content,
    )


def _legacy_prompt_path(layout: Layout) -> Path:
    if layout.client == "claude":
        return layout.link_file
    return layout.home / ".codex" / "AGENTS.md"


def plan_migrate(layout: Layout, name: str) -> ClientPlan:
    """Move one unmanaged legacy prompt into Promptctl without rendering it."""
    source_path = _legacy_prompt_path(layout)
    _validate_parent(source_path)
    _validate_parent(layout.link_file)
    _validate_parent(layout.instruction_file)

    source_content = _read_optional_regular(
        source_path,
        f"{layout.client} legacy prompt",
    )
    if source_content is None:
        raise PromptctlError(
            f"legacy prompt does not exist for {layout.client}: {source_path}"
        )

    destination_kind = _node_kind(layout.instruction_file)
    if destination_kind != "missing":
        raise PromptctlError(
            f"migration destination is {destination_kind}; refusing to overwrite: "
            f"{layout.instruction_file}"
        )

    if layout.client == "claude":
        link_before = source_content
    else:
        link_before = _read_optional_regular(
            layout.link_file,
            f"{layout.client} link file",
        )

    existing_block = _active_block(link_before or "", layout)
    if existing_block is not None:
        raise PromptctlError(
            f"{layout.client} is already managed by Promptctl for profile "
            f"{existing_block.profile!r}"
        )

    # Claude's legacy prompt is also its binding file, so migration replaces it
    # with only the owned import block. Codex keeps the rest of config.toml and
    # adds the owned top-level key.
    render_source = "" if layout.client == "claude" else (link_before or "")
    link_after, _changed = _render_install(render_source, layout, name)
    return ClientPlan(
        operation="migrate",
        layout=layout,
        link_before=link_before,
        link_after=link_after,
        instruction_action="create",
        template_content=source_content,
        migration_source=source_path,
    )


def plan_uninstall(
    layout: Layout,
    name: str,
    remove_instructions: bool,
) -> ClientPlan:
    _validate_parent(layout.link_file)
    _validate_parent(layout.instruction_file)
    link_before = _read_optional_regular(layout.link_file, f"{layout.client} link file")
    if link_before is None:
        link_after = None
    else:
        link_after, _changed = _render_uninstall(link_before, layout, name)
    instruction_action = (
        _instruction_action(layout.instruction_file, remove=True)
        if remove_instructions
        else (
            "preserve"
            if _instruction_action(layout.instruction_file, remove=True) == "remove"
            else "missing"
        )
    )
    return ClientPlan(
        operation="uninstall",
        layout=layout,
        link_before=link_before,
        link_after=link_after,
        instruction_action=instruction_action,
    )


def plan_switch(layout: Layout, name: str) -> ClientPlan:
    _validate_parent(layout.link_file)
    _validate_parent(layout.instruction_file)
    if _node_kind(layout.instruction_file) != "regular":
        raise PromptctlError(
            f"prompt profile {name!r} does not exist for {layout.client}: "
            f"{layout.instruction_file}"
        )
    link_before = _read_optional_regular(layout.link_file, f"{layout.client} link file")
    link_after, _changed = _render_switch(link_before or "", layout, name)
    return ClientPlan(
        operation="switch",
        layout=layout,
        link_before=link_before,
        link_after=link_after,
        instruction_action="preserve",
    )


def _mkdir_private(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise PromptctlError(f"managed directory is not a regular directory: {path}")


def _atomic_write(path: Path, content: str) -> None:
    _mkdir_private(path.parent)
    existing_mode = 0o600
    if _node_kind(path) == "regular":
        existing_mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.promptctl-",
        dir=str(path.parent),
    )
    temporary = Path(temporary_name)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, existing_mode or 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            descriptor = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(str(temporary), str(path))
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _unique_backup(path: Path, timestamp: str) -> Path:
    candidate = path.with_name(f"{path.name}.bak_{timestamp}")
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.name}.bak_{timestamp}_{counter}")
        counter += 1
    return candidate


def _backup(path: Path, timestamp: str) -> Path:
    backup = _unique_backup(path, timestamp)
    shutil.copy2(path, backup)
    return backup


def _apply_plan(plan: ClientPlan, timestamp: str) -> list[tuple[str, Path]]:
    events: list[tuple[str, Path]] = []
    layout = plan.layout
    if plan.operation in {"install", "migrate"} and plan.instruction_action == "create":
        assert plan.template_content is not None
        _atomic_write(layout.instruction_file, plan.template_content)
        event = (
            "migrated legacy prompt into editable instructions"
            if plan.operation == "migrate"
            else "created editable instructions"
        )
        events.append((event, layout.instruction_file))

    if plan.link_changed:
        if plan.link_before is not None:
            backup = _backup(layout.link_file, timestamp)
            events.append(("backed up link file", backup))
        if plan.link_after is not None:
            _atomic_write(layout.link_file, plan.link_after)
            events.append(("updated link file", layout.link_file))

    if (
        plan.operation == "migrate"
        and plan.migration_source is not None
        and plan.migration_source != layout.link_file
    ):
        backup = _backup(plan.migration_source, timestamp)
        plan.migration_source.unlink()
        events.append(("backed up legacy prompt", backup))
        events.append(("removed legacy prompt after migration", plan.migration_source))

    if plan.operation == "uninstall" and plan.instruction_action == "remove":
        backup = _backup(layout.instruction_file, timestamp)
        layout.instruction_file.unlink()
        events.append(("backed up instructions", backup))
        events.append(("removed instructions", layout.instruction_file))
    return events


def _apply_plans_transactionally(
    plans: Sequence[ClientPlan], timestamp: str
) -> list[tuple[str, str, Path]]:
    """Apply a multi-client plan and restore pre-apply bytes after any failure."""
    snapshots: dict[Path, tuple[str, Optional[str], Optional[int]]] = {}
    for plan in plans:
        plan_paths = [plan.layout.link_file, plan.layout.instruction_file]
        if plan.migration_source is not None:
            plan_paths.append(plan.migration_source)
        for path in plan_paths:
            if path in snapshots:
                continue
            kind = _node_kind(path)
            content = (
                _read_optional_regular(path, "transaction input")
                if kind == "regular"
                else None
            )
            mode = stat.S_IMODE(path.stat().st_mode) if kind == "regular" else None
            snapshots[path] = (kind, content, mode)
    events: list[tuple[str, str, Path]] = []
    try:
        for plan in plans:
            for event, path in _apply_plan(plan, timestamp):
                events.append((plan.layout.client, event, path))
        return events
    except (PromptctlError, OSError):
        for path, (kind, content, mode) in reversed(list(snapshots.items())):
            current = _node_kind(path)
            if kind == "regular":
                assert content is not None
                _atomic_write(path, content)
                if mode is not None:
                    path.chmod(mode)
            elif kind == "missing" and current == "regular":
                path.unlink()
        raise


def _action_summary(plan: ClientPlan) -> dict[str, str]:
    if plan.link_changed:
        link_action = "create" if plan.link_before is None else "update"
        if plan.operation == "uninstall":
            link_action = "remove managed block"
    else:
        link_action = "unchanged"
    if plan.instruction_action == "create":
        instruction_action = (
            "copy legacy prompt verbatim (content hidden)"
            if plan.operation == "migrate"
            else "create editable template"
        )
    elif plan.instruction_action == "remove":
        instruction_action = "back up and remove"
    elif plan.instruction_action == "preserve":
        instruction_action = "preserve user content"
    else:
        instruction_action = "missing"
    summary = {
        "client": plan.layout.client,
        "link_file": str(plan.layout.link_file),
        "instruction_file": str(plan.layout.instruction_file),
        "link_action": link_action,
        "instruction_action": instruction_action,
    }
    if plan.migration_source is not None:
        summary["migration_source"] = str(plan.migration_source)
        summary["legacy_action"] = (
            "back up and replace with managed binding"
            if plan.migration_source == plan.layout.link_file
            else "back up and remove after successful migration"
        )
    return summary


def _print_plans(plans: Iterable[ClientPlan], preview: bool) -> None:
    if preview:
        print("[DRY RUN] no files were changed")
    for plan in plans:
        summary = _action_summary(plan)
        print(f"\n[{summary['client']}]")
        print(f"link file: {summary['link_file']}")
        print(f"editable instructions: {summary['instruction_file']}")
        if "migration_source" in summary:
            print(f"legacy prompt: {summary['migration_source']}")
            print(f"legacy action: {summary['legacy_action']}")
        print(f"link action: {summary['link_action']}")
        print(f"instructions action: {summary['instruction_action']}")


def _status(layout: Layout, name: str) -> dict[str, object]:
    result: dict[str, object] = {
        "client": layout.client,
        "link_file": str(layout.link_file),
        "instruction_file": str(layout.instruction_file),
        "link": "missing",
        "instructions": "missing",
        "installed": False,
    }
    try:
        link_content = _read_optional_regular(layout.link_file, f"{layout.client} link file")
        instruction_kind = _node_kind(layout.instruction_file)
        if instruction_kind == "regular":
            result["instructions"] = "editable"
        elif instruction_kind != "missing":
            result["instructions"] = f"conflict:{instruction_kind}"
        if link_content is not None:
            block = _validate_owned_block(link_content, layout, name)
            result["link"] = "installed" if block else "unmanaged"
        result["installed"] = (
            result["link"] == "installed" and result["instructions"] == "editable"
        )
    except PromptctlError as exc:
        result["link"] = "conflict"
        result["error"] = str(exc)
    return result


def _home_from_args(value: Optional[str]) -> Path:
    home = Path(value).expanduser() if value else Path.home()
    return home.resolve()


def command_install(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        plans = [
            plan_install(resolve_layout(client, home, name), name, args.template)
            for client in selected_clients(args.client)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    preview = args.dry_run or not args.yes
    _print_plans(plans, preview)
    if preview:
        if os.environ.get("PROMPTCTL_GUIDED") != "1":
            print("\nRun the same command with --yes after reviewing these paths.")
        return 0

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        for client, event, path in _apply_plans_transactionally(plans, timestamp):
            print(f"[{client}] {event}: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] apply failed: {exc}", file=sys.stderr)
        return 1

    print("\n[done] persistent-instruction links are configured")
    for plan in plans:
        print(f"editable {plan.layout.client} instructions: {plan.layout.instruction_file}")
    print("Edit these files directly, then start a new agent session.")
    return 0


def command_migrate(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.profile)
        home = _home_from_args(args.home)
        plans = [
            plan_migrate(resolve_layout(client, home, name), name)
            for client in selected_clients(args.target)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    preview = args.dry_run or not args.yes
    _print_plans(plans, preview)
    if preview:
        print("\n[preview] prompt contents were not displayed; re-run with --yes to migrate")
        return 0

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        for client, event, path in _apply_plans_transactionally(plans, timestamp):
            print(f"[{client}] {event}: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] migration failed: {exc}", file=sys.stderr)
        return 1

    print(f"\n[done] legacy prompts migrated to profile: {name}")
    print("Prompt contents were copied verbatim and were not displayed.")
    print("Start new Claude Code and Codex sessions to load the managed profile.")
    return 0


def command_uninstall(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        plans = [
            plan_uninstall(
                resolve_layout(client, home, name),
                name,
                args.remove_instructions,
            )
            for client in selected_clients(args.client)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    preview = args.dry_run or not args.yes
    _print_plans(plans, preview)
    if preview:
        if os.environ.get("PROMPTCTL_GUIDED") != "1":
            print("\nRun the same command with --yes after reviewing these paths.")
        return 0

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        for client, event, path in _apply_plans_transactionally(plans, timestamp):
            print(f"[{client}] {event}: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] apply failed: {exc}", file=sys.stderr)
        return 1

    print("\n[done] managed links were removed")
    if not args.remove_instructions:
        for plan in plans:
            if _node_kind(plan.layout.instruction_file) == "regular":
                print(f"preserved {plan.layout.client} instructions: {plan.layout.instruction_file}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        statuses = [
            _status(resolve_layout(client, home, name), name)
            for client in selected_clients(args.client)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(statuses, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        for status in statuses:
            print(f"[{status['client']}]")
            print(f"link file: {status['link_file']}")
            print(f"editable instructions: {status['instruction_file']}")
            print(f"link: {status['link']}")
            print(f"instructions: {status['instructions']}")
            print(f"installed: {'yes' if status['installed'] else 'no'}")
            if "error" in status:
                print(f"error: {status['error']}")
            print()
    return 1 if any(status.get("link") == "conflict" for status in statuses) else 0


def command_path(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        paths = {
            client: str(resolve_layout(client, home, name).instruction_file)
            for client in selected_clients(args.client)
        }
    except PromptctlError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(paths, ensure_ascii=False, sort_keys=True))
    elif len(paths) == 1:
        print(next(iter(paths.values())))
    else:
        for client, path in paths.items():
            print(f"{client}\t{path}")
    return 0


def _snippet_entries(home: Path) -> list[dict[str, str]]:
    directory = snippets_directory(home)
    kind = _node_kind(directory)
    if kind == "missing":
        return []
    if kind != "directory":
        raise PromptctlError(f"snippet library is {kind}, not a directory: {directory}")
    entries: list[dict[str, str]] = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.suffix != ".md":
            continue
        name = normalize_name(path.name)
        file_kind = _node_kind(path)
        if file_kind != "regular":
            raise PromptctlError(f"snippet is {file_kind}, not a regular file: {path}")
        entries.append({"name": name, "path": str(path), "state": "regular"})
    return entries


def command_snippet_list(args: argparse.Namespace) -> int:
    try:
        home = _home_from_args(args.home)
        entries = _snippet_entries(home)
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(entries, ensure_ascii=False, indent=2, sort_keys=True))
    elif not entries:
        print("(no snippets)")
    else:
        for entry in entries:
            print(f"{entry['name']}\t{entry['path']}")
    return 0


def command_snippet_path(args: argparse.Namespace) -> int:
    try:
        home = _home_from_args(args.home)
        path = resolve_snippet_path(home, args.name)
    except PromptctlError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    print(path)
    return 0


def command_snippet_create(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        path = resolve_snippet_path(home, name)
        _validate_parent(path)
        kind = _node_kind(path)
        if kind != "missing":
            raise PromptctlError(f"snippet already exists as {kind}: {path}")
        source = Path(args.source).expanduser().resolve() if args.source else None
        content = ""
        if source is not None:
            content = _read_optional_regular(source, "snippet source")
            if content is None:
                raise PromptctlError(f"snippet source does not exist: {source}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print(f"create snippet: {path}")
    if source is not None:
        print(f"source: {source} (content hidden)")
    else:
        print("initial content: empty")
    if not args.yes:
        print("\n[preview] re-run with --yes to create the snippet")
        return 0
    try:
        _atomic_write(path, content)
    except (PromptctlError, OSError) as exc:
        print(f"[error] create failed: {exc}", file=sys.stderr)
        return 1
    print(f"[done] created snippet '{name}': {path}")
    print("Edit the Markdown file directly; its content is never shown by list commands.")
    return 0


def command_snippet_delete(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        path = resolve_snippet_path(home, name)
        kind = _node_kind(path)
        if kind == "missing":
            print(f"[done] snippet '{name}' is already absent")
            return 0
        if kind != "regular":
            raise PromptctlError(f"snippet is {kind}, not a regular file: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print(f"back up and remove snippet: {path}")
    if not args.yes:
        print("\n[preview] re-run with --yes to delete the snippet")
        return 0
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        backup = _backup(path, timestamp)
        path.unlink()
    except OSError as exc:
        print(f"[error] delete failed: {exc}", file=sys.stderr)
        return 1
    print(f"[done] backed up snippet: {backup}")
    print(f"[done] removed snippet: {path}")
    return 0


def _clipboard_command() -> list[str]:
    candidates: list[list[str]]
    if sys.platform == "darwin":
        candidates = [["pbcopy"]]
    elif os.name == "nt":
        candidates = [["clip"]]
    else:
        candidates = [
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
            ["xsel", "--clipboard", "--input"],
        ]
    for command in candidates:
        if shutil.which(command[0]):
            return command
    raise PromptctlError("no supported clipboard command is available")


def command_snippet_copy(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        path = resolve_snippet_path(home, name)
        content = _read_optional_regular(path, "snippet")
        if content is None:
            raise PromptctlError(f"snippet does not exist: {path}")
        result = subprocess.run(
            _clipboard_command(),
            input=content,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            raise PromptctlError("clipboard command failed")
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    print(f"[done] copied snippet '{name}' to the clipboard (content hidden)")
    return 0


def _current_for_client(client: str, home: Path) -> dict[str, object]:
    layout = resolve_layout(client, home, "personal")
    result: dict[str, object] = {
        "client": client,
        "profile": None,
        "link_file": str(layout.link_file),
        "managed": False,
    }
    content = _read_optional_regular(layout.link_file, f"{client} link file")
    if content is None:
        return result
    block = _active_block(content, layout)
    if block is None:
        return result
    profile_layout = resolve_layout(client, home, block.profile)
    result.update(
        profile=block.profile,
        managed=True,
        instruction_file=str(profile_layout.instruction_file),
        instructions=_node_kind(profile_layout.instruction_file),
    )
    result["healthy"] = result["instructions"] == "regular"
    return result


def command_current(args: argparse.Namespace) -> int:
    try:
        home = _home_from_args(args.home)
        values = [
            _current_for_client(client, home)
            for client in selected_clients(args.target)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    payload: object = values[0] if len(values) == 1 else values
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        for value in values:
            print(f"[{value['client']}]")
            print(f"Profile: {value['profile'] or 'none'}")
            print(f"Managed: {'yes' if value['managed'] else 'no'}")
    return 0


def command_switch(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.profile)
        home = _home_from_args(args.home)
        plans = [
            plan_switch(resolve_layout(client, home, name), name)
            for client in selected_clients(args.target)
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    preview = args.command == "plan" or not args.yes
    _print_plans(plans, preview)
    if preview:
        print("\n[preview] re-run with apply --yes to switch the active profile")
        return 0
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        for client, event, path in _apply_plans_transactionally(plans, timestamp):
            print(f"[{client}] {event}: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] apply failed: {exc}", file=sys.stderr)
        return 1
    print(f"\n[done] active prompt profile: {name}")
    print("Start a new agent session to load the selected instructions.")
    return 0


def _profile_names(home: Path) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for client in CLIENTS:
        directory = resolve_layout(client, home, "personal").instruction_file.parent
        names: set[str] = set()
        if _node_kind(directory) == "directory":
            for path in directory.iterdir():
                if path.is_file() and not path.is_symlink() and path.suffix == ".md":
                    try:
                        names.add(normalize_name(path.name))
                    except PromptctlError:
                        continue
        elif _node_kind(directory) not in {"missing", "directory"}:
            raise PromptctlError(f"instructions path is not a directory: {directory}")
        result[client] = names
    return result


def command_profile_list(args: argparse.Namespace) -> int:
    try:
        home = _home_from_args(args.home)
        names_by_client = _profile_names(home)
        active = {
            client: _current_for_client(client, home)["profile"] for client in CLIENTS
        }
        names = sorted(set().union(*names_by_client.values()))
        profiles = [
            {
                "name": name,
                "clients": [client for client in CLIENTS if name in names_by_client[client]],
                "active_for": [client for client in CLIENTS if active[client] == name],
            }
            for name in names
        ]
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(profiles, ensure_ascii=False, indent=2, sort_keys=True))
    elif not profiles:
        print("(no prompt profiles)")
    else:
        for profile in profiles:
            clients = ",".join(profile["clients"])
            active_for = ",".join(profile["active_for"])
            suffix = f"\tactive: {active_for}" if active_for else ""
            print(f"{profile['name']}\t{clients}{suffix}")
    return 0


def command_profile_create(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        source_name = normalize_name(args.source) if args.source else None
        home = _home_from_args(args.home)
        clients = selected_clients(args.target)
        writes: list[tuple[Path, str]] = []
        for client in clients:
            destination = resolve_layout(client, home, name).instruction_file
            _validate_parent(destination)
            if _node_kind(destination) != "missing":
                raise PromptctlError(f"profile already exists for {client}: {destination}")
            if source_name:
                source = resolve_layout(client, home, source_name).instruction_file
                content = _read_optional_regular(source, f"source profile for {client}")
                if content is None:
                    raise PromptctlError(f"source profile does not exist for {client}: {source}")
            else:
                content = _load_template(client, None)
            writes.append((destination, content))
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    for path, _content in writes:
        print(f"create {path}")
    if not args.yes:
        print("\n[preview] re-run with --yes to create the profile")
        return 0
    created: list[Path] = []
    try:
        for path, content in writes:
            _atomic_write(path, content)
            created.append(path)
    except (PromptctlError, OSError) as exc:
        for path in reversed(created):
            if _node_kind(path) == "regular":
                path.unlink()
        print(f"[error] create failed: {exc}", file=sys.stderr)
        return 1
    print(f"[done] created prompt profile '{name}'")
    return 0


def command_profile_delete(args: argparse.Namespace) -> int:
    try:
        name = normalize_name(args.name)
        home = _home_from_args(args.home)
        clients = selected_clients(args.target)
        active = [_current_for_client(client, home) for client in clients]
        if any(value["profile"] == name for value in active):
            used = ", ".join(value["client"] for value in active if value["profile"] == name)
            raise PromptctlError(f"profile {name!r} is active for {used}; switch it first")
        paths = []
        for client in clients:
            path = resolve_layout(client, home, name).instruction_file
            kind = _node_kind(path)
            if kind == "regular":
                paths.append(path)
            elif kind != "missing":
                raise PromptctlError(f"profile path is {kind}, not a regular file: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
    if not paths:
        print(f"[done] prompt profile '{name}' is already absent")
        return 0
    for path in paths:
        print(f"back up and remove {path}")
    if not args.yes:
        print("\n[preview] re-run with --yes to delete the profile")
        return 0
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        for path in paths:
            backup = _backup(path, timestamp)
            path.unlink()
            print(f"backed up {path}: {backup}")
    except OSError as exc:
        print(f"[error] delete failed: {exc}", file=sys.stderr)
        return 1
    print(f"[done] deleted prompt profile '{name}'")
    return 0


def _add_common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("client", choices=(*CLIENTS, "all"))
    parser.add_argument(
        "--name",
        default="personal",
        help="editable instruction filename without .md (default: personal)",
    )
    parser.add_argument(
        "--home",
        help="override the target home directory (useful for sandboxes and tests)",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=os.environ.get("PROMPTCTL_PROG") or None,
        description=(
            "Configure lightweight, user-editable persistent instructions for "
            "Claude Code and Codex"
        ),
        epilog="""
Examples:
  %(prog)s install codex
  %(prog)s migrate --target all --profile personal
  %(prog)s profile create work --from personal --yes
  %(prog)s plan --target codex --profile work
  %(prog)s apply --target codex --profile work --yes
  %(prog)s current --target codex
  %(prog)s install all --yes
  %(prog)s status all
  %(prog)s path claude
  %(prog)s uninstall codex --yes
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    install = subparsers.add_parser("install", help="preview or configure links")
    _add_common_arguments(install)
    install.add_argument(
        "--template",
        help="initial Markdown template; used only when the instruction file is missing",
    )
    install.add_argument("--dry-run", action="store_true", help="force preview")
    install.add_argument("--yes", action="store_true", help="apply the previewed changes")
    install.set_defaults(func=command_install)

    migrate = subparsers.add_parser(
        "migrate",
        help="blind-copy existing CLAUDE.md/AGENTS.md prompts into a managed profile",
    )
    migrate.add_argument("--target", required=True, choices=(*CLIENTS, "all"))
    migrate.add_argument("--profile", default="personal")
    migrate.add_argument("--home")
    migrate.add_argument("--dry-run", action="store_true", help="force preview")
    migrate.add_argument("--yes", action="store_true", help="apply the previewed changes")
    migrate.set_defaults(func=command_migrate)

    status = subparsers.add_parser("status", help="inspect links and editable files")
    _add_common_arguments(status)
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=command_status)

    path = subparsers.add_parser("path", help="print editable instruction paths")
    _add_common_arguments(path)
    path.add_argument("--json", action="store_true")
    path.set_defaults(func=command_path)

    snippet = subparsers.add_parser(
        "snippet",
        help="manage reusable prompts that are never injected automatically",
    )
    snippet_subparsers = snippet.add_subparsers(dest="snippet_command", required=True)

    snippet_list = snippet_subparsers.add_parser("list", help="list snippet metadata")
    snippet_list.add_argument("--home")
    snippet_list.add_argument("--json", action="store_true")
    snippet_list.set_defaults(func=command_snippet_list)

    snippet_path = snippet_subparsers.add_parser("path", help="print one snippet path")
    snippet_path.add_argument("name")
    snippet_path.add_argument("--home")
    snippet_path.set_defaults(func=command_snippet_path)

    snippet_create = snippet_subparsers.add_parser(
        "create", help="create an empty snippet or blind-copy a source file"
    )
    snippet_create.add_argument("name")
    snippet_create.add_argument("--from", dest="source")
    snippet_create.add_argument("--home")
    snippet_create.add_argument("--yes", action="store_true")
    snippet_create.set_defaults(func=command_snippet_create)

    snippet_copy = snippet_subparsers.add_parser(
        "copy", help="copy one snippet to the clipboard without displaying it"
    )
    snippet_copy.add_argument("name")
    snippet_copy.add_argument("--home")
    snippet_copy.set_defaults(func=command_snippet_copy)

    snippet_delete = snippet_subparsers.add_parser(
        "delete", help="back up and delete one snippet"
    )
    snippet_delete.add_argument("name")
    snippet_delete.add_argument("--home")
    snippet_delete.add_argument("--yes", action="store_true")
    snippet_delete.set_defaults(func=command_snippet_delete)

    uninstall = subparsers.add_parser(
        "uninstall",
        help="remove owned links while preserving user instructions by default",
    )
    _add_common_arguments(uninstall)
    uninstall.add_argument(
        "--remove-instructions",
        action="store_true",
        help="also back up and remove the user-owned instruction file",
    )
    uninstall.add_argument("--dry-run", action="store_true", help="force preview")
    uninstall.add_argument("--yes", action="store_true", help="apply the previewed changes")
    uninstall.set_defaults(func=command_uninstall)

    for command in ("plan", "apply"):
        switch = subparsers.add_parser(
            command,
            help=("preview" if command == "plan" else "apply") + " a prompt profile switch",
        )
        switch.add_argument("--target", required=True, choices=(*CLIENTS, "all"))
        switch.add_argument("--profile", required=True)
        switch.add_argument("--home")
        switch.add_argument("--yes", action="store_true")
        switch.set_defaults(func=command_switch)

    current = subparsers.add_parser("current", help="show the active prompt profile")
    current.add_argument("--target", required=True, choices=(*CLIENTS, "all"))
    current.add_argument("--home")
    current.add_argument("--json", action="store_true")
    current.set_defaults(func=command_current)

    profile = subparsers.add_parser("profile", help="manage editable prompt profiles")
    profile_subparsers = profile.add_subparsers(dest="profile_command", required=True)

    profile_list = profile_subparsers.add_parser("list", help="list prompt profiles")
    profile_list.add_argument("--home")
    profile_list.add_argument("--json", action="store_true")
    profile_list.set_defaults(func=command_profile_list)

    profile_create = profile_subparsers.add_parser("create", help="create or clone a profile")
    profile_create.add_argument("name")
    profile_create.add_argument("--from", dest="source")
    profile_create.add_argument("--target", default="all", choices=(*CLIENTS, "all"))
    profile_create.add_argument("--home")
    profile_create.add_argument("--yes", action="store_true")
    profile_create.set_defaults(func=command_profile_create)

    profile_delete = profile_subparsers.add_parser("delete", help="back up and delete a profile")
    profile_delete.add_argument("name")
    profile_delete.add_argument("--target", default="all", choices=(*CLIENTS, "all"))
    profile_delete.add_argument("--home")
    profile_delete.add_argument("--yes", action="store_true")
    profile_delete.set_defaults(func=command_profile_delete)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        print(
            "[error] promptctl.py is the non-interactive engine; "
            "run agent/promptctl/promptctl for guided setup",
            file=sys.stderr,
        )
        return 2
    args = build_parser().parse_args(arguments)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
