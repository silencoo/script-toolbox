#!/usr/bin/env bash
# Isolated tests for the reversible PATH command-link installer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLER="${AGENT_DIR}/install-commands.sh"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

PREFIX="${TEST_ROOT}/bin"
"$INSTALLER" --prefix "$PREFIX" >"$TEST_ROOT/preview.out"
[ ! -e "$PREFIX" ] || fail "install preview created the prefix"
grep -q '\[preview\] no links were changed' "$TEST_ROOT/preview.out" ||
  fail "install preview did not explain how to apply"

"$INSTALLER" --prefix "$PREFIX" --yes >"$TEST_ROOT/install.out" 2>&1
for name in agentctl mcpctl promptctl skillsctl; do
  [ -L "$PREFIX/$name" ] || fail "installer did not create $name"
done
[ "$(mode_of "$PREFIX/.script-toolbox-agent-commands")" = "600" ] ||
  fail "command manifest is not mode 600"
[ "$("$PREFIX/agentctl" --version)" = "agentctl 0.3.1" ] ||
  fail "agentctl did not work through its installed symlink"
"$PREFIX/mcpctl" --help >/dev/null ||
  fail "mcpctl did not work through its installed symlink"
"$PREFIX/promptctl" --help >/dev/null ||
  fail "promptctl did not work through its installed symlink"
"$PREFIX/skillsctl" --help >/dev/null ||
  fail "skillsctl did not work through its installed symlink"

"$INSTALLER" --prefix "$PREFIX" --yes >"$TEST_ROOT/reinstall.out" 2>&1
grep -q "keep     $PREFIX/agentctl" "$TEST_ROOT/reinstall.out" ||
  fail "reinstall was not idempotent"

"$INSTALLER" --prefix "$PREFIX" --uninstall >"$TEST_ROOT/uninstall-preview.out"
[ -L "$PREFIX/agentctl" ] || fail "uninstall preview removed a command"
"$INSTALLER" --prefix "$PREFIX" --uninstall --yes >/dev/null
[ ! -e "$PREFIX/agentctl" ] ||
  fail "uninstall left an owned command"
[ ! -e "$PREFIX/.script-toolbox-agent-commands" ] ||
  fail "uninstall left its manifest"

# An unowned collision is refused by default. --force preserves it as a
# tracked backup, and uninstall restores it byte-for-byte.
mkdir -p "$PREFIX"
printf '%s\n' 'user-owned-mcpctl' > "$PREFIX/mcpctl"
cp "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before"
if "$INSTALLER" --prefix "$PREFIX" --yes >"$TEST_ROOT/conflict.out" 2>&1; then
  fail "installer replaced an unowned command without --force"
fi
cmp -s "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before" ||
  fail "refused conflict was modified"

"$INSTALLER" --prefix "$PREFIX" --force --yes >/dev/null 2>&1
[ -L "$PREFIX/mcpctl" ] || fail "--force did not install over the tracked backup"
"$INSTALLER" --prefix "$PREFIX" --uninstall --yes >/dev/null
[ -f "$PREFIX/mcpctl" ] && [ ! -L "$PREFIX/mcpctl" ] ||
  fail "uninstall did not restore the user-owned command"
cmp -s "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before" ||
  fail "restored command differs from the original"

# If one installed path changes later, uninstall fails before removing any
# other link and retains the manifest for an explicit recovery.
CHANGED_PREFIX="${TEST_ROOT}/changed-bin"
"$INSTALLER" --prefix "$CHANGED_PREFIX" --yes >/dev/null 2>&1
rm -f "$CHANGED_PREFIX/promptctl"
ln -s "$TEST_ROOT/unowned-target" "$CHANGED_PREFIX/promptctl"
if "$INSTALLER" --prefix "$CHANGED_PREFIX" --uninstall --yes \
  >"$TEST_ROOT/changed.out" 2>&1; then
  fail "uninstall accepted a changed command path"
fi
[ -L "$CHANGED_PREFIX/agentctl" ] ||
  fail "failed uninstall partially removed other commands"
[ -f "$CHANGED_PREFIX/.script-toolbox-agent-commands" ] ||
  fail "failed uninstall removed its recovery manifest"
rm -f "$CHANGED_PREFIX/promptctl"
ln -s "${AGENT_DIR}/promptctl/promptctl" "$CHANGED_PREFIX/promptctl"
"$INSTALLER" --prefix "$CHANGED_PREFIX" --uninstall --yes >/dev/null

printf '%s\n' "ok  : reversible command install, conflicts, and recovery"
