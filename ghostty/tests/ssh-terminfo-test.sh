#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP_DIR="$(mktemp -d /tmp/ghostty-ssh-terminfo-test.XXXXXX)"
trap 'rm -rf -- "$TEST_TMP_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

FAKE_BIN="$TEST_TMP_DIR/bin"
TEST_HOME="$TEST_TMP_DIR/home"
REMOTE_HOME="$TEST_TMP_DIR/remote-home"
TEST_LOG="$TEST_TMP_DIR/commands.log"
mkdir -p "$FAKE_BIN" "$TEST_HOME" "$REMOTE_HOME"

cat > "$FAKE_BIN/infocmp" <<'EOF_INFOCMP'
#!/usr/bin/env bash
printf '%s\n' 'xterm-ghostty|ghostty|Ghostty,'
printf '%s\n' '  colors#256,'
EOF_INFOCMP

cat > "$FAKE_BIN/tic" <<'EOF_TIC'
#!/usr/bin/env bash
output_dir=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      output_dir="$1"
      ;;
  esac
  shift
done
cat >/dev/null
if [ -n "$output_dir" ]; then
  mkdir -p "$output_dir"
  : > "$output_dir/xterm-ghostty.compiled"
fi
printf 'tic\n' >> "$TEST_LOG"
EOF_TIC

cat > "$FAKE_BIN/sudo" <<'EOF_SUDO'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >> "$TEST_LOG"
exec "$@"
EOF_SUDO

cat > "$FAKE_BIN/ssh" <<'EOF_SSH'
#!/usr/bin/env bash
if [ "${1:-}" = '-t' ]; then
  shift
fi
destination="$1"
shift
printf 'ssh %s\n' "$destination" >> "$TEST_LOG"
HOME="$REMOTE_HOME" bash -c "$1"
EOF_SSH

chmod +x \
  "$FAKE_BIN/infocmp" \
  "$FAKE_BIN/tic" \
  "$FAKE_BIN/sudo" \
  "$FAKE_BIN/ssh"

PATH="$FAKE_BIN:/usr/bin:/bin" \
HOME="$TEST_HOME" \
TERM=xterm-ghostty \
TEST_LOG="$TEST_LOG" \
  "$ROOT_DIR/ssh-terminfo.sh" > "$TEST_TMP_DIR/user-output"

[ -f "$TEST_HOME/.terminfo/xterm-ghostty.compiled" ] \
  || fail "the per-user terminfo entry was not compiled"
grep -Fq 'Current TERM: xterm-ghostty' "$TEST_TMP_DIR/user-output" \
  || fail "the current TERM value was not reported"
grep -Fq 'was installed in' "$TEST_TMP_DIR/user-output" \
  || fail "the per-user installation was not confirmed"

PATH="$FAKE_BIN:/usr/bin:/bin" \
HOME="$TEST_HOME" \
TERM=xterm-ghostty \
TEST_LOG="$TEST_LOG" \
  "$ROOT_DIR/ssh-terminfo.sh" --system > "$TEST_TMP_DIR/system-output"

grep -Fq 'sudo tic -x -' "$TEST_LOG" \
  || fail "the system installation did not use sudo tic"
grep -Fq 'sudo infocmp -x xterm-ghostty' "$TEST_LOG" \
  || fail "the system installation was not verified through sudo"
grep -Fq 'is available system-wide' "$TEST_TMP_DIR/system-output" \
  || fail "the system installation was not confirmed"

PATH="$FAKE_BIN:/usr/bin:/bin" \
HOME="$TEST_HOME" \
REMOTE_HOME="$REMOTE_HOME" \
TERM=xterm-ghostty \
TEST_LOG="$TEST_LOG" \
  "$ROOT_DIR/ssh-terminfo.sh" server.example.com \
  > "$TEST_TMP_DIR/remote-user-output"

[ -f "$REMOTE_HOME/.terminfo/xterm-ghostty.compiled" ] \
  || fail "the remote per-user terminfo entry was not compiled"
grep -Fq 'ssh server.example.com' "$TEST_LOG" \
  || fail "the requested SSH destination was not used"
grep -Fq 'Remote TERM: xterm-ghostty' "$TEST_TMP_DIR/remote-user-output" \
  || fail "the remote TERM value was not reported"

PATH="$FAKE_BIN:/usr/bin:/bin" \
HOME="$TEST_HOME" \
REMOTE_HOME="$REMOTE_HOME" \
TERM=xterm-ghostty \
TEST_LOG="$TEST_LOG" \
  "$ROOT_DIR/ssh-terminfo.sh" --system server.example.com \
  > "$TEST_TMP_DIR/remote-system-output"

grep -Fq 'was installed system-wide' "$TEST_TMP_DIR/remote-system-output" \
  || fail "the remote system installation was not confirmed"

"$ROOT_DIR/ssh-terminfo.sh" --help > "$TEST_TMP_DIR/help-output"
grep -Fq -- '--system' "$TEST_TMP_DIR/help-output" \
  || fail "help output is missing --system"
grep -Fq 'user@host' "$TEST_TMP_DIR/help-output" \
  || fail "help output is missing the SSH destination"

printf '%s\n' 'PASS: Ghostty SSH terminfo setup'
