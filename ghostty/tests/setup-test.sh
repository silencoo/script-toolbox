#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_TMP_DIR="$(mktemp -d /tmp/ghostty-setup-test.XXXXXX)"
trap 'rm -rf -- "$TEST_TMP_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

CONFIG_FILE="$TEST_TMP_DIR/home/.config/ghostty/config.ghostty"
mkdir -p "$(dirname "$CONFIG_FILE")"

cat > "$CONFIG_FILE" <<'EOF_CONFIG'
font-size = 14
shell-integration-features = cursor

# >>> script-toolbox Ghostty shell integration >>>
shell-integration-features = title
# <<< script-toolbox Ghostty shell integration <<<
EOF_CONFIG

HOME="$TEST_TMP_DIR/home" \
  "$ROOT_DIR/setup.sh" --config-only --no-validate \
  > "$TEST_TMP_DIR/first-output" 2>&1

grep -Fqx 'font-size = 14' "$CONFIG_FILE" \
  || fail "existing Ghostty settings were not preserved"
grep -Fqx \
  'shell-integration-features = cursor,no-sudo,title,ssh-env,ssh-terminfo,path' \
  "$CONFIG_FILE" \
  || fail "managed shell integration features were not written"
[ "$(grep -c '^shell-integration-features[[:space:]]*=' "$CONFIG_FILE")" -eq 1 ] \
  || fail "duplicate shell-integration-features settings remain"
[ "$(grep -c '^# >>> script-toolbox Ghostty shell integration >>>$' "$CONFIG_FILE")" -eq 1 ] \
  || fail "managed block start marker is not unique"

backup_count="$(find "$(dirname "$CONFIG_FILE")" \
  -type f -name 'config.ghostty.bak.*' | wc -l | tr -d ' ')"
[ "$backup_count" -eq 1 ] || fail "the changed configuration was not backed up"

first_checksum="$(cksum "$CONFIG_FILE")"
HOME="$TEST_TMP_DIR/home" \
  "$ROOT_DIR/setup.sh" --config-only --no-validate \
  > "$TEST_TMP_DIR/second-output" 2>&1
second_checksum="$(cksum "$CONFIG_FILE")"
[ "$first_checksum" = "$second_checksum" ] \
  || fail "a second setup changed an already-current configuration"

backup_count="$(find "$(dirname "$CONFIG_FILE")" \
  -type f -name 'config.ghostty.bak.*' | wc -l | tr -d ' ')"
[ "$backup_count" -eq 1 ] \
  || fail "an idempotent setup created an unnecessary backup"

HOME="$TEST_TMP_DIR/empty-home" \
  "$ROOT_DIR/setup.sh" --config-only --no-validate \
  > "$TEST_TMP_DIR/empty-output" 2>&1
[ -f "$TEST_TMP_DIR/empty-home/.config/ghostty/config.ghostty" ] \
  || fail "setup did not create the XDG Ghostty configuration"

"$ROOT_DIR/setup.sh" --help > "$TEST_TMP_DIR/help-output"
grep -Fq -- '--config-only' "$TEST_TMP_DIR/help-output" \
  || fail "help output is missing --config-only"

printf '%s\n' 'PASS: Ghostty configuration setup'
