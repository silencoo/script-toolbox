#!/usr/bin/env python3
# Managed by script-toolbox agentctl statusline.
"""Fast Claude Code status line with model, context, session edits, and Git.

Claude Code passes one JSON payload on stdin. A typical rendered line places a
dirty marker after ``git:(main)``, followed by session edits, divergence,
context usage, and the active model.

The ``+/-`` values are Claude's current-session line-change counters. Git
branch, tracked-dirty state, and upstream divergence come from one bounded
``git status`` invocation. The transcript is tailed at most once, only to keep
proxy model aliases and older Claude Code payloads working.
"""

import json
import math
import os
import subprocess
import sys
import unicodedata


TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
DEFAULT_GIT_TIMEOUT_SECONDS = 0.5
EMPTY_CELL = "░"
PARTIAL_CELLS = ("", "▏", "▎", "▍", "▌", "▋", "▊", "▉")


def ansi(code):
    if os.environ.get("NO_COLOR"):
        return ""
    return "\033[{}m".format(code)


def basename(path):
    return os.path.basename(path.rstrip(os.sep)) or path


def integer(value, default=0):
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def mapping(value):
    return value if isinstance(value, dict) else {}


def display_text(value, limit=120):
    if not isinstance(value, str):
        return ""
    cleaned = "".join(
        character
        for character in value
        if not unicodedata.category(character).startswith("C")
    ).strip()
    return cleaned[:limit]


def git_timeout_seconds():
    try:
        timeout = float(
            os.environ.get(
                "SCRIPT_TOOLBOX_STATUSLINE_GIT_TIMEOUT_SECONDS",
                DEFAULT_GIT_TIMEOUT_SECONDS,
            )
        )
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_GIT_TIMEOUT_SECONDS
    if not math.isfinite(timeout):
        return DEFAULT_GIT_TIMEOUT_SECONDS
    return max(0.05, min(timeout, 2.0))


def last_assistant(path):
    """Return the last assistant message after one bounded tail read."""
    if not isinstance(path, str) or not path:
        return None
    try:
        with open(path, "rb") as transcript:
            transcript.seek(0, os.SEEK_END)
            size = transcript.tell()
            start = max(0, size - TRANSCRIPT_TAIL_BYTES)
            transcript.seek(start)
            tail = transcript.read()
    except OSError:
        return None

    if start:
        newline = tail.find(b"\n")
        if newline < 0:
            return None
        tail = tail[newline + 1 :]

    for raw_line in reversed(tail.splitlines()):
        if not raw_line.strip():
            continue
        try:
            obj = json.loads(raw_line.decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(obj, dict) or obj.get("type") != "assistant":
            continue
        message = obj.get("message")
        if isinstance(message, dict):
            return message
    return None


def git_segment(cwd, edit_stats):
    """Return branch, dirty flag, session edits, and divergence using one Git call."""
    env = os.environ.copy()
    env.update(
        {
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    try:
        result = subprocess.run(
            [
                "git",
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=no",
                "--ignore-submodules=dirty",
                "--no-renames",
            ],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=True,
            timeout=git_timeout_seconds(),
            env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return ""

    branch = ""
    oid = ""
    ahead = 0
    behind = 0
    dirty = False
    for line in result.stdout.splitlines():
        if line.startswith("# branch.head "):
            branch = line.split(" ", 2)[2]
        elif line.startswith("# branch.oid "):
            oid = line.split(" ", 2)[2]
        elif line.startswith("# branch.ab "):
            values = line.split()
            if len(values) == 4:
                ahead = integer(values[2].lstrip("+"))
                behind = integer(values[3].lstrip("-"))
        elif line.startswith(("1 ", "2 ", "u ")):
            dirty = True

    if not branch:
        return ""
    if branch == "(detached)":
        branch = oid[:7] if oid and oid != "(initial)" else "detached"
    branch = display_text(branch) or "unknown"

    blue = ansi("1;34")
    red = ansi("31")
    green = ansi("1;32")
    yellow = ansi("1;33")
    magenta = ansi("1;35")
    cyan = ansi("1;36")
    reset = ansi("0")

    parts = [" {}git:({}{}{}{}){}".format(blue, reset, red, branch, blue, reset)]
    if dirty:
        parts.append(" {}*{}".format(yellow, reset))
    if edit_stats is not None:
        added, removed = edit_stats
        if added or removed:
            parts.append(
                " {}+{}{} {}-{}{}".format(
                    green, added, reset, red, removed, reset
                )
            )
    if ahead:
        parts.append(" {}⇡{}{}".format(cyan, ahead, reset))
    if behind:
        parts.append(" {}⇣{}{}".format(magenta, behind, reset))
    return "".join(parts)


def fmt_tokens(value):
    value = max(0, integer(value))
    if value >= 1_000_000:
        return "{:.1f}M".format(value / 1_000_000)
    if value >= 1_000:
        return "{}k".format(round(value / 1000))
    return str(value)


def context_values(payload, assistant):
    context = mapping(payload.get("context_window"))
    current = mapping(context.get("current_usage"))
    legacy_usage = mapping((assistant or {}).get("usage"))

    tokens = None
    if current and any(
        name in current
        for name in (
            "input_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        )
    ):
        tokens = sum(
            integer(current.get(name))
            for name in (
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )
    if tokens is None:
        tokens = context.get("total_input_tokens")
    if tokens is None and legacy_usage:
        tokens = sum(
            integer(legacy_usage.get(name))
            for name in (
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )

    context_size = integer(context.get("context_window_size"))
    if context_size <= 0:
        model = str(
            (assistant or {}).get("model")
            or mapping(payload.get("model")).get("id")
            or ""
        ).lower()
        context_size = (
            1_000_000
            if "opus" in model or "minimax" in model or "1m" in model
            else 200_000
        )

    used_percentage = context.get("used_percentage")
    if isinstance(used_percentage, bool):
        used_percentage = None
    try:
        percentage = float(used_percentage)
    except (TypeError, ValueError, OverflowError):
        percentage = (
            max(0, integer(tokens)) / context_size * 100
            if tokens is not None
            else 0
        )
    if not math.isfinite(percentage):
        percentage = 0
    percentage = max(0.0, min(percentage, 100.0))
    return max(0, integer(tokens)), context_size, percentage


def context_segment(payload, assistant):
    tokens, context_size, percentage = context_values(payload, assistant)
    display_percentage = int(percentage)

    green = ansi("1;32")
    yellow = ansi("1;33")
    red = ansi("1;31")
    reset = ansi("0")
    color = green if percentage < 50 else (yellow if percentage < 80 else red)

    # Ten cells with eighth-cell precision: 9% is ▉░░░░░░░░░ and
    # 25% is ██▌░░░░░░░. Empty cells are explicit ░ glyphs.
    eighths = max(0, min(80, round(percentage / 100 * 80)))
    full_cells, fraction = divmod(eighths, 8)
    partial = PARTIAL_CELLS[fraction]
    rest = 10 - full_cells - (1 if fraction else 0)
    bar = ("█" * full_cells) + partial + (EMPTY_CELL * rest)

    return " {}{}{} {}{}/{} ({}%){}".format(
        color,
        bar,
        reset,
        color,
        fmt_tokens(tokens),
        fmt_tokens(context_size),
        display_percentage,
        reset,
    )


def session_edit_stats(payload):
    cost = mapping(payload.get("cost"))
    if "total_lines_added" not in cost and "total_lines_removed" not in cost:
        return None
    return (
        max(0, integer(cost.get("total_lines_added"))),
        max(0, integer(cost.get("total_lines_removed"))),
    )


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    workspace = mapping(payload.get("workspace"))
    cwd = workspace.get("current_dir") or payload.get("cwd") or os.getcwd()
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()

    # One transcript tail read supplies both the proxy model alias and legacy
    # context fallback. Modern Claude payloads provide context directly.
    assistant = last_assistant(payload.get("transcript_path"))

    green = ansi("1;32")
    cyan = ansi("36")
    white = ansi("1;37")
    reset = ansi("0")

    model_payload = mapping(payload.get("model"))
    model_id = display_text(
        (assistant or {}).get("model")
        or model_payload.get("id")
        or model_payload.get("display_name")
        or ""
    )
    model_segment = " [{}{}{}]".format(white, model_id, reset) if model_id else ""

    print(
        "{}{}{} {}{}{}{}{}{}".format(
            green,
            "➤",
            reset,
            cyan,
            display_text(basename(cwd)) or "?",
            reset,
            git_segment(cwd, session_edit_stats(payload)),
            context_segment(payload, assistant),
            model_segment,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
