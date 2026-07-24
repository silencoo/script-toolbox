#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/tests/fixtures"
SHELL_KIT="$ROOT_DIR/kits/zsh-shell"
TEST_TMP_DIR="$(mktemp -d /tmp/sbx-manager-test.XXXXXX)"
trap 'rm -rf -- "$TEST_TMP_DIR"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fqx "$expected" "$file" \
    || fail "expected '$expected' in $file"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fqx "$unexpected" "$file"; then
    fail "did not expect '$unexpected' in $file"
  fi
}

run_setup() {
  local name="$1"
  shift
  local case_dir="$TEST_TMP_DIR/$name"
  mkdir -p "$case_dir/home" "$case_dir/config"
  : > "$case_dir/log"

  PATH="$FIXTURE_DIR:$PATH" \
    HOME="$case_dir/home" \
    XDG_CONFIG_HOME="$case_dir/config" \
    NO_COLOR=1 \
    SBX_TEST_LOG="$case_dir/log" \
    SBX_TEST_POLICY_STATE="$case_dir/policy-state" \
    SBX_TEST_AUTH_STATE="$case_dir/auth-state" \
    "$ROOT_DIR/sbx-manager.sh" "$@" > "$case_dir/output" 2>&1
}

[ -f "$SHELL_KIT/spec.yaml" ] || fail "default shell kit spec is missing"
[ -f "$SHELL_KIT/files/home/.zshrc" ] || fail "default shell kit zshrc is missing"
[ -f "$SHELL_KIT/files/home/.config/starship.toml" ] \
  || fail "default Starship config is missing"
grep -Fq 'bat ca-certificates curl fd-find fzf git ripgrep zoxide zsh' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit is missing modern CLI packages"
grep -Fq 'eza_version=0.23.5' "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit is missing the pinned eza release"
grep -Fq 'eval "$(zoxide init zsh)"' "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing zoxide initialization"
grep -Fq 'source /usr/share/doc/fzf/examples/key-bindings.zsh' \
  "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing fzf key bindings"
grep -Fq "alias ll='eza " "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing eza aliases"

# A fresh setup must initialize the requested preset before diagnose/login.
# Otherwise the daemon opens its interactive first-use policy picker.
run_setup fresh setup open
fresh_log="$TEST_TMP_DIR/fresh/log"
[ "$(sed -n '1p' "$fresh_log")" = 'policy init allow-all' ] \
  || fail "fresh setup did not initialize policy first"
assert_contains "$fresh_log" 'diagnose --output json'
assert_contains "$fresh_log" 'login'
assert_not_contains "$fresh_log" 'policy inspect local-policy'
[ "$(cat "$TEST_TMP_DIR/fresh/policy-state")" = 'allow-all' ] \
  || fail "fresh setup did not retain the open preset"

# "not authenticated" must not be mistaken for "authenticated".
[ -e "$TEST_TMP_DIR/fresh/auth-state" ] \
  || fail "fresh unauthenticated setup did not call sbx login"

# Rerunning setup with the same preset must preserve existing custom rules and
# continue instead of asking for an unnecessary reset.
mkdir -p "$TEST_TMP_DIR/matching/home" "$TEST_TMP_DIR/matching/config"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/matching/policy-state"
: > "$TEST_TMP_DIR/matching/auth-state"
: > "$TEST_TMP_DIR/matching/log"
PATH="$FIXTURE_DIR:$PATH" \
  HOME="$TEST_TMP_DIR/matching/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/matching/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/matching/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/matching/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/matching/auth-state" \
  "$ROOT_DIR/sbx-manager.sh" --skip-login setup open \
  > "$TEST_TMP_DIR/matching/output" 2>&1
assert_not_contains "$TEST_TMP_DIR/matching/log" 'policy reset --force'
[ "$(grep -Fxc 'policy init allow-all' "$TEST_TMP_DIR/matching/log")" -eq 1 ] \
  || fail "matching setup should probe policy initialization only once"

# An existing policy is reset only after the caller has approved the
# destructive operation; --yes supplies that approval for this test.
mkdir -p "$TEST_TMP_DIR/existing/home" "$TEST_TMP_DIR/existing/config"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/existing/policy-state"
: > "$TEST_TMP_DIR/existing/auth-state"
: > "$TEST_TMP_DIR/existing/log"
PATH="$FIXTURE_DIR:$PATH" \
  HOME="$TEST_TMP_DIR/existing/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/existing/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/existing/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/existing/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/existing/auth-state" \
  "$ROOT_DIR/sbx-manager.sh" --yes --skip-login setup balanced \
  > "$TEST_TMP_DIR/existing/output" 2>&1

existing_log="$TEST_TMP_DIR/existing/log"
[ "$(sed -n '1p' "$existing_log")" = 'policy init balanced' ] \
  || fail "existing setup did not use policy init as its non-interactive probe"
assert_contains "$existing_log" 'policy reset --force'
[ "$(grep -Fxc 'policy init balanced' "$existing_log")" -eq 2 ] \
  || fail "existing setup should initialize once before and once after reset"
assert_not_contains "$existing_log" 'policy inspect local-policy'
[ "$(cat "$TEST_TMP_DIR/existing/policy-state")" = 'balanced' ] \
  || fail "existing setup did not apply the balanced preset"

# Without approval, an existing policy must remain untouched.
mkdir -p "$TEST_TMP_DIR/cancelled/home" "$TEST_TMP_DIR/cancelled/config"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/cancelled/policy-state"
: > "$TEST_TMP_DIR/cancelled/auth-state"
: > "$TEST_TMP_DIR/cancelled/log"
if PATH="$FIXTURE_DIR:$PATH" \
  HOME="$TEST_TMP_DIR/cancelled/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/cancelled/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/cancelled/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/cancelled/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/cancelled/auth-state" \
  "$ROOT_DIR/sbx-manager.sh" --skip-login setup locked \
  > "$TEST_TMP_DIR/cancelled/output" 2>&1 < /dev/null; then
  fail "existing setup succeeded without reset approval"
fi
assert_not_contains "$TEST_TMP_DIR/cancelled/log" 'policy reset --force'
[ "$(cat "$TEST_TMP_DIR/cancelled/policy-state")" = 'allow-all' ] \
  || fail "cancelled setup changed the existing preset"

# A daemon that started without /usr/sbin in PATH disables the block volume
# driver and later returns an opaque 500. The run helper should repair that
# known state before executing sbx run.
mkdir -p "$TEST_TMP_DIR/block-driver/home" \
  "$TEST_TMP_DIR/block-driver/config" \
  "$TEST_TMP_DIR/block-driver/workspace"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/block-driver/policy-state"
: > "$TEST_TMP_DIR/block-driver/auth-state"
: > "$TEST_TMP_DIR/block-driver/log"
printf '%s\n' \
  '{"msg":"loggingkit started"}' \
  '{"error":"mkfs.ext4 not available, disabling block volume driver: skip plugin"}' \
  > "$TEST_TMP_DIR/block-driver/daemon.log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/block-driver/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/block-driver/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/block-driver/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/block-driver/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/block-driver/auth-state" \
  SBX_TEST_DAEMON_LOG="$TEST_TMP_DIR/block-driver/daemon.log" \
  "$ROOT_DIR/sbx-manager.sh" run claude \
    "$TEST_TMP_DIR/block-driver/workspace" --name test-claude \
  > "$TEST_TMP_DIR/block-driver/output" 2>&1
assert_contains "$TEST_TMP_DIR/block-driver/log" 'daemon stop'
assert_contains "$TEST_TMP_DIR/block-driver/log" 'daemon start --detach'
assert_contains "$TEST_TMP_DIR/block-driver/log" \
  "run --name test-claude --kit $SHELL_KIT claude $TEST_TMP_DIR/block-driver/workspace"
if tail -n 1 "$TEST_TMP_DIR/block-driver/daemon.log" \
  | grep -Fq 'mkfs.ext4 not available'; then
  fail "block-volume repair did not replace the disabled daemon session"
fi

# New sandboxes receive the productive zsh kit by default, but custom images
# can opt out when they do not use an apt-based official template.
mkdir -p "$TEST_TMP_DIR/no-shell-kit/home" \
  "$TEST_TMP_DIR/no-shell-kit/config" \
  "$TEST_TMP_DIR/no-shell-kit/workspace"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/no-shell-kit/policy-state"
: > "$TEST_TMP_DIR/no-shell-kit/auth-state"
: > "$TEST_TMP_DIR/no-shell-kit/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/no-shell-kit/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/no-shell-kit/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/no-shell-kit/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/no-shell-kit/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/no-shell-kit/auth-state" \
  "$ROOT_DIR/sbx-manager.sh" run shell \
    "$TEST_TMP_DIR/no-shell-kit/workspace" --name plain-shell \
    --no-shell-kit \
  > "$TEST_TMP_DIR/no-shell-kit/output" 2>&1
assert_contains "$TEST_TMP_DIR/no-shell-kit/log" \
  "run --name plain-shell shell $TEST_TMP_DIR/no-shell-kit/workspace"

# Passing the original agent/workspace again for an existing named sandbox
# must be rewritten to sbx's reattach-only syntax.
mkdir -p "$TEST_TMP_DIR/reattach/home" \
  "$TEST_TMP_DIR/reattach/config" \
  "$TEST_TMP_DIR/reattach/workspace"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/reattach/policy-state"
: > "$TEST_TMP_DIR/reattach/auth-state"
: > "$TEST_TMP_DIR/reattach/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/reattach/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/reattach/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/reattach/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/reattach/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/reattach/auth-state" \
  SBX_TEST_SANDBOX_NAMES='test-claude' \
  "$ROOT_DIR/sbx-manager.sh" run claude \
    "$TEST_TMP_DIR/reattach/workspace" --name test-claude \
    -- --resume session-123 \
  > "$TEST_TMP_DIR/reattach/output" 2>&1
assert_contains "$TEST_TMP_DIR/reattach/log" \
  'run --name test-claude -- --resume session-123'
if grep -Fq "run --name test-claude claude" "$TEST_TMP_DIR/reattach/log"; then
  fail "reattach command retained sandbox creation arguments"
fi

printf '%s\n' 'PASS: sbx-manager setup, run, and shell-kit flow'
