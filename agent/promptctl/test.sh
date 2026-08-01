#!/usr/bin/env bash
# Isolated behavior tests for the Promptctl Shell frontend.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPTCTL="${SCRIPT_DIR}/promptctl"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p \
  "$TEST_ROOT/menu-home" \
  "$TEST_ROOT/install-home" \
  "$TEST_ROOT/cancel-home" \
  "$TEST_ROOT/uninstall-home" \
  "$TEST_ROOT/eof-home"

bash -n "$PROMPTCTL" || fail "Shell frontend has invalid syntax"

help_output="$("$PROMPTCTL" --help)"
printf '%s' "$help_output" | grep -q '^  promptctl$' ||
  fail "help omitted the no-argument guided entrypoint"
command_help="$("$PROMPTCTL" install --help)"
printf '%s' "$command_help" | grep -q '^usage: promptctl install' ||
  fail "explicit help exposed the internal engine name"
[ "$("$PROMPTCTL" --version)" = "promptctl 0.3.0" ] ||
  fail "version output exposed the internal engine name"

# No arguments enter the Shell guide. The path action is read-only.
printf '3\n1\n\n' |
  HOME="$TEST_ROOT/menu-home" "$PROMPTCTL" \
    >"$TEST_ROOT/menu.out" 2>&1 ||
  fail "no-argument guide failed"
grep -q 'Promptctl guided Shell setup' "$TEST_ROOT/menu.out" ||
  fail "no-argument command did not enter the Shell guide"
grep -qF "$TEST_ROOT/menu-home/.claude/instructions/personal.md" \
  "$TEST_ROOT/menu.out" ||
  fail "guided path action omitted the Claude edit path"
grep -qF "$TEST_ROOT/menu-home/.codex/instructions/personal.md" \
  "$TEST_ROOT/menu.out" ||
  fail "guided path action omitted the Codex edit path"

# Install is previewed first and written only after a separate confirmation.
printf '1\n1\n\ny\n' |
  HOME="$TEST_ROOT/install-home" "$PROMPTCTL" \
    >"$TEST_ROOT/install.out" 2>&1 ||
  fail "guided install failed"
grep -qF '[DRY RUN] no files were changed' "$TEST_ROOT/install.out" ||
  fail "guided install did not show a preview"
! grep -q 'Run the same command with --yes' "$TEST_ROOT/install.out" ||
  fail "internal engine instructions leaked into the Shell guide"
grep -qF '[done] persistent-instruction links are configured' \
  "$TEST_ROOT/install.out" ||
  fail "guided install did not report completion"
[ -f "$TEST_ROOT/install-home/.claude/instructions/personal.md" ] ||
  fail "guided install omitted the Claude editable file"
[ -f "$TEST_ROOT/install-home/.codex/instructions/personal.md" ] ||
  fail "guided install omitted the Codex editable file"
grep -q 'script-toolbox-promptctl:start profile=personal' \
  "$TEST_ROOT/install-home/.claude/CLAUDE.md" ||
  fail "guided install omitted the Claude managed block"
grep -q 'script-toolbox-promptctl:start profile=personal' \
  "$TEST_ROOT/install-home/.codex/config.toml" ||
  fail "guided install omitted the Codex managed block"

# The confirmation defaults to no and a cancelled preview changes nothing.
printf '1\n3\n\n\n' |
  HOME="$TEST_ROOT/cancel-home" "$PROMPTCTL" \
    >"$TEST_ROOT/cancel.out" 2>&1 ||
  fail "guided cancellation returned an error"
grep -qF '[cancelled] no files were changed' "$TEST_ROOT/cancel.out" ||
  fail "guided cancellation was not reported"
[ ! -e "$TEST_ROOT/cancel-home/.codex" ] ||
  fail "guided cancellation changed Codex configuration"

# Explicit commands pass through the Shell entrypoint without opening a menu.
path_output="$(
  HOME="$TEST_ROOT/menu-home" "$PROMPTCTL" \
    path codex --home "$TEST_ROOT/menu-home"
)"
[ "$path_output" = "$TEST_ROOT/menu-home/.codex/instructions/personal.md" ] ||
  fail "explicit command passthrough returned the wrong path"

# Guided uninstall preserves the user-owned Markdown unless explicitly asked
# to remove it.
HOME="$TEST_ROOT/uninstall-home" "$PROMPTCTL" \
  install codex --home "$TEST_ROOT/uninstall-home" --yes >/dev/null ||
  fail "explicit install setup for uninstall test failed"
printf '4\n3\n\n\ny\n' |
  HOME="$TEST_ROOT/uninstall-home" "$PROMPTCTL" \
    >"$TEST_ROOT/uninstall.out" 2>&1 ||
  fail "guided uninstall failed"
[ -f "$TEST_ROOT/uninstall-home/.codex/instructions/personal.md" ] ||
  fail "guided uninstall removed the user-owned instruction file"
! grep -q 'script-toolbox-promptctl' \
  "$TEST_ROOT/uninstall-home/.codex/config.toml" ||
  fail "guided uninstall left its managed Codex block"

if HOME="$TEST_ROOT/eof-home" "$PROMPTCTL" \
  </dev/null >"$TEST_ROOT/eof.out" 2>&1; then
  fail "guided mode accepted missing input"
fi
grep -q 'interactive input ended' "$TEST_ROOT/eof.out" ||
  fail "guided EOF did not explain how to use explicit commands"

printf '%s\n' "ok  : promptctl Shell guide and command passthrough"
