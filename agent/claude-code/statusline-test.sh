#!/usr/bin/env bash
# Isolated lifecycle, rendering, and subprocess-count tests for the status line.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGER="${SCRIPT_DIR}/statusline-setup.sh"
RENDERER="${SCRIPT_DIR}/statusline.py"
TEST_ROOT="$(mktemp -d)"
TEST_HOME="${TEST_ROOT}/home"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

for dependency in git jq python3; do
  command -v "$dependency" >/dev/null 2>&1 || {
    printf 'skip: Claude status-line tests require %s\n' "$dependency"
    exit 0
  }
done

bash -n "$MANAGER" || fail "status-line manager has invalid Bash syntax"
python3 -c '
import ast
import pathlib
import sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
' "$RENDERER" || fail "status-line renderer has invalid Python syntax"

# Mutation commands preview by default.
HOME="$TEST_HOME" "$MANAGER" install > "$TEST_ROOT/install-preview.out"
[ ! -e "$TEST_HOME/.claude" ] || fail "install preview changed HOME"
grep -q 'no files were changed' "$TEST_ROOT/install-preview.out" ||
  fail "install preview omitted its no-change guarantee"

HOME="$TEST_HOME" "$MANAGER" install --yes > "$TEST_ROOT/install.out"
SETTINGS="$TEST_HOME/.claude/settings.json"
STATE="$TEST_HOME/.claude/.script-toolbox-statusline.json"
INSTALLED_RENDERER="$TEST_HOME/.claude/scripts/script-toolbox-statusline.py"

jq -e '
  .statusLine == {
    "type": "command",
    "command": "~/.claude/scripts/script-toolbox-statusline.py"
  }
' "$SETTINGS" >/dev/null || fail "install did not configure Claude statusLine"
[ -x "$INSTALLED_RENDERER" ] || fail "installed renderer is not executable"
[ "$(mode_of "$INSTALLED_RENDERER")" = "700" ] ||
  fail "installed renderer is not mode 700"
[ "$(mode_of "$SETTINGS")" = "600" ] || fail "settings are not mode 600"
[ "$(mode_of "$STATE")" = "600" ] || fail "state is not mode 600"

status_json="$(HOME="$TEST_HOME" "$MANAGER" status --json)"
printf '%s' "$status_json" | jq -e '
  .status == "configured"
  and .settings_kind == "managed"
  and .state_valid == true
  and .script_owned == true
  and .script_executable == true
' >/dev/null || fail "status did not recognize the managed installation"

# Reinstall refreshes the renderer without losing the original restore point.
cp "$STATE" "$TEST_ROOT/state.before"
HOME="$TEST_HOME" "$MANAGER" install --yes > /dev/null
cmp -s "$STATE" "$TEST_ROOT/state.before" ||
  fail "idempotent install replaced the saved restore point"

# Build a repository that is dirty and one commit ahead of its configured
# upstream. A PATH wrapper proves the renderer launches Git exactly once.
REPO="$TEST_ROOT/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" symbolic-ref HEAD refs/heads/main
git -C "$REPO" config user.name statusline-test
git -C "$REPO" config user.email statusline@example.invalid
printf '%s\n' one > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm initial
git -C "$REPO" update-ref refs/heads/upstream HEAD
git -C "$REPO" config branch.main.remote .
git -C "$REPO" config branch.main.merge refs/heads/upstream
printf '%s\n' two >> "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm ahead
printf '%s\n' dirty >> "$REPO/file.txt"

TRANSCRIPT="$TEST_ROOT/session.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"model":"old-alias","usage":{"input_tokens":1}}}' \
  'not-json' \
  '{"type":"assistant","message":{"model":"MiniMax-M3","usage":{"input_tokens":250000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}' \
  > "$TRANSCRIPT"

PAYLOAD="$TEST_ROOT/payload.json"
jq -n \
  --arg cwd "$REPO" \
  --arg transcript "$TRANSCRIPT" '
    {
      cwd: "/wrong/cwd",
      workspace: {current_dir: $cwd},
      transcript_path: $transcript,
      model: {id: "claude-opus-4-8", display_name: "Opus"},
      cost: {total_lines_added: 12, total_lines_removed: 3},
      context_window: {
        total_input_tokens: 50000,
        context_window_size: 200000,
        used_percentage: 25
      }
    }
  ' > "$PAYLOAD"

REAL_GIT="$(command -v git)"
FAKE_BIN="$TEST_ROOT/bin"
GIT_LOG="$TEST_ROOT/git.log"
mkdir -p "$FAKE_BIN"
{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'printf "%s\n" call >> "$STATUSLINE_GIT_LOG"'
  printf '%s\n' 'exec "$STATUSLINE_REAL_GIT" "$@"'
} > "$FAKE_BIN/git"
chmod +x "$FAKE_BIN/git"
: > "$GIT_LOG"

NO_COLOR=1 SCRIPT_TOOLBOX_STATUSLINE_GIT_TIMEOUT_SECONDS=2 \
  STATUSLINE_REAL_GIT="$REAL_GIT" STATUSLINE_GIT_LOG="$GIT_LOG" \
  PATH="${FAKE_BIN}:${PATH}" \
  python3 "$RENDERER" < "$PAYLOAD" > "$TEST_ROOT/render.out"
git_calls="$(wc -l < "$GIT_LOG" | tr -d ' ')"
[ "$git_calls" = 1 ] ||
  fail "renderer made $git_calls Git subprocesses (expected exactly one): $(sed -n '1p' "$TEST_ROOT/render.out")"
grep -qF '➤ repo git:(main) * +12 -3 ⇡1' "$TEST_ROOT/render.out" ||
  fail "renderer omitted Git, dirty, edit, or divergence metadata: $(sed -n '1p' "$TEST_ROOT/render.out")"
grep -qF '██▌░░░░░░░ 50k/200k (25%) [MiniMax-M3]' \
  "$TEST_ROOT/render.out" ||
  fail "renderer omitted the precise context bar or transcript model alias"
! grep -qF 'ctx:' "$TEST_ROOT/render.out" ||
  fail "renderer retained the obsolete ctx label"

# Old payloads can still use the same transcript read for both model and usage.
jq -n --arg cwd "$TEST_ROOT" --arg transcript "$TRANSCRIPT" '
  {
    cwd: $cwd,
    transcript_path: $transcript,
    model: {id: "claude-opus-4-8"}
  }
' | NO_COLOR=1 python3 "$RENDERER" > "$TEST_ROOT/legacy.out"
grep -qF '250k/1.0M (25%) [MiniMax-M3]' "$TEST_ROOT/legacy.out" ||
  fail "legacy payload fallback did not reuse the transcript result"

# Uninstall previews, then removes only owned files and the managed setting.
HOME="$TEST_HOME" "$MANAGER" uninstall > "$TEST_ROOT/uninstall-preview.out"
[ -e "$INSTALLED_RENDERER" ] || fail "uninstall preview removed the renderer"
HOME="$TEST_HOME" "$MANAGER" uninstall --yes > /dev/null
jq -e 'has("statusLine") | not' "$SETTINGS" >/dev/null ||
  fail "uninstall did not remove a newly added statusLine"
[ ! -e "$INSTALLED_RENDERER" ] || fail "uninstall left the managed renderer"
[ ! -e "$STATE" ] || fail "uninstall left ownership state"

# Automatic setup mode preserves an external status line. Explicit --force
# stores it privately and uninstall restores it without emitting its command.
jq '.theme = "dark" | .statusLine = {
  "type": "command",
  "command": "external-secret-status-command"
}' "$SETTINGS" > "$TEST_ROOT/external-settings.json"
mv "$TEST_ROOT/external-settings.json" "$SETTINGS"
chmod 600 "$SETTINGS"
cp "$SETTINGS" "$TEST_ROOT/external.before"
HOME="$TEST_HOME" "$MANAGER" install --yes --if-missing \
  > "$TEST_ROOT/if-missing.out"
cmp -s "$SETTINGS" "$TEST_ROOT/external.before" ||
  fail "if-missing mode changed an external status line"
[ ! -e "$STATE" ] || fail "if-missing mode claimed external ownership"

HOME="$TEST_HOME" "$MANAGER" install --force --yes > "$TEST_ROOT/force.out"
! grep -q 'external-secret-status-command' "$TEST_ROOT/force.out" ||
  fail "force install emitted the saved external command"
forced_status="$(HOME="$TEST_HOME" "$MANAGER" status --json)"
case "$forced_status" in
  *external-secret-status-command*) fail "status JSON emitted the saved command" ;;
esac

# Repair a managed statusLine key removed by an external settings rewrite
# without losing the private pre-install restore point.
jq 'del(.statusLine)' "$SETTINGS" > "$TEST_ROOT/removed-statusline.json"
mv "$TEST_ROOT/removed-statusline.json" "$SETTINGS"
chmod 600 "$SETTINGS"
HOME="$TEST_HOME" "$MANAGER" install --force --yes > "$TEST_ROOT/repair.out"
! grep -q 'external-secret-status-command' "$TEST_ROOT/repair.out" ||
  fail "drift repair emitted the saved external command"
jq -e --arg command '~/.claude/scripts/script-toolbox-statusline.py' '
  .statusLine == {"type": "command", "command": $command}
' "$SETTINGS" >/dev/null || fail "drift repair did not restore the managed setting"
jq -e '
  .previous_status_line_present == true
  and .previous_status_line.command == "external-secret-status-command"
' "$STATE" >/dev/null || fail "drift repair lost the private external restore point"

HOME="$TEST_HOME" "$MANAGER" uninstall --yes > "$TEST_ROOT/restore.out"
jq -e '
  .theme == "dark"
  and .statusLine.command == "external-secret-status-command"
' "$SETTINGS" >/dev/null || fail "uninstall did not restore the external setting"
! grep -q 'external-secret-status-command' "$TEST_ROOT/restore.out" ||
  fail "uninstall emitted the restored external command"

# A post-install user edit blocks uninstall instead of being overwritten.
HOME="$TEST_HOME" "$MANAGER" install --force --yes > /dev/null
jq '.statusLine.command = "user-edited-after-install"' "$SETTINGS" \
  > "$TEST_ROOT/drifted-settings.json"
mv "$TEST_ROOT/drifted-settings.json" "$SETTINGS"
chmod 600 "$SETTINGS"
if HOME="$TEST_HOME" "$MANAGER" uninstall --yes \
  > "$TEST_ROOT/drift-uninstall.out" 2>&1; then
  fail "uninstall overwrote a statusLine changed after installation"
fi
jq -e '.statusLine.command == "user-edited-after-install"' "$SETTINGS" \
  >/dev/null || fail "refused drift uninstall changed settings"
[ -e "$STATE" ] && [ -e "$INSTALLED_RENDERER" ] ||
  fail "refused drift uninstall partially removed owned files"

# Restore the owned command shape so cleanup can safely replay the original.
jq '.statusLine = {
  "type": "command",
  "command": "~/.claude/scripts/script-toolbox-statusline.py"
}' "$SETTINGS" > "$TEST_ROOT/managed-settings.json"
mv "$TEST_ROOT/managed-settings.json" "$SETTINGS"
chmod 600 "$SETTINGS"
HOME="$TEST_HOME" "$MANAGER" uninstall --yes > /dev/null
jq -e '.statusLine.command == "external-secret-status-command"' "$SETTINGS" \
  >/dev/null || fail "final cleanup did not replay the external restore point"

printf '%s\n' "ok  : Claude status-line lifecycle, rendering, and one-Git-call budget"
