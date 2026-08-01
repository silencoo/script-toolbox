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
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional, Sequence

VERSION = "0.2.0"
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
    if plan.operation == "install" and plan.instruction_action == "create":
        assert plan.template_content is not None
        _atomic_write(layout.instruction_file, plan.template_content)
        events.append(("created editable instructions", layout.instruction_file))

    if plan.link_changed:
        if plan.link_before is not None:
            backup = _backup(layout.link_file, timestamp)
            events.append(("backed up link file", backup))
        if plan.link_after is not None:
            _atomic_write(layout.link_file, plan.link_after)
            events.append(("updated link file", layout.link_file))

    if plan.operation == "uninstall" and plan.instruction_action == "remove":
        backup = _backup(layout.instruction_file, timestamp)
        layout.instruction_file.unlink()
        events.append(("backed up instructions", backup))
        events.append(("removed instructions", layout.instruction_file))
    return events


def _action_summary(plan: ClientPlan) -> dict[str, str]:
    if plan.link_changed:
        link_action = "create" if plan.link_before is None else "update"
        if plan.operation == "uninstall":
            link_action = "remove managed block"
    else:
        link_action = "unchanged"
    if plan.instruction_action == "create":
        instruction_action = "create editable template"
    elif plan.instruction_action == "remove":
        instruction_action = "back up and remove"
    elif plan.instruction_action == "preserve":
        instruction_action = "preserve user content"
    else:
        instruction_action = "missing"
    return {
        "client": plan.layout.client,
        "link_file": str(plan.layout.link_file),
        "instruction_file": str(plan.layout.instruction_file),
        "link_action": link_action,
        "instruction_action": instruction_action,
    }


def _print_plans(plans: Iterable[ClientPlan], preview: bool) -> None:
    if preview:
        print("[DRY RUN] no files were changed")
    for plan in plans:
        summary = _action_summary(plan)
        print(f"\n[{summary['client']}]")
        print(f"link file: {summary['link_file']}")
        print(f"editable instructions: {summary['instruction_file']}")
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
        for plan in plans:
            for event, path in _apply_plan(plan, timestamp):
                print(f"[{plan.layout.client}] {event}: {path}")
    except (PromptctlError, OSError) as exc:
        print(f"[error] apply failed: {exc}", file=sys.stderr)
        return 1

    print("\n[done] persistent-instruction links are configured")
    for plan in plans:
        print(f"editable {plan.layout.client} instructions: {plan.layout.instruction_file}")
    print("Edit these files directly, then start a new agent session.")
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
        for plan in plans:
            for event, path in _apply_plan(plan, timestamp):
                print(f"[{plan.layout.client}] {event}: {path}")
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

    status = subparsers.add_parser("status", help="inspect links and editable files")
    _add_common_arguments(status)
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=command_status)

    path = subparsers.add_parser("path", help="print editable instruction paths")
    _add_common_arguments(path)
    path.add_argument("--json", action="store_true")
    path.set_defaults(func=command_path)

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
