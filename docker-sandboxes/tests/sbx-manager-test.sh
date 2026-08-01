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
[ -f "$SHELL_KIT/files/home/.config/sbx-manager/enter-workspace.zsh" ] \
  || fail "default workspace entry helper is missing"
[ -s "$SHELL_KIT/files/home/.config/sbx-manager/zsh-shell.version" ] \
  || fail "default shell kit version marker is missing or empty"
[ -f "$SHELL_KIT/files/home/.config/starship.toml" ] \
  || fail "default Starship config is missing"
grep -Fq 'bat ca-certificates curl fd-find fzf git jq ripgrep zoxide zsh' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit is missing modern CLI packages"
grep -Fq 'LANG: "C.UTF-8"' "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not set a UTF-8 LANG"
grep -Fq 'LC_ALL: "C.UTF-8"' "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not set a UTF-8 LC_ALL"
grep -Fq 'eza_version=0.23.5' "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit is missing the pinned eza release"
grep -Fq 'https://github.com/silencoo/script-toolbox.git' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not fetch the agent helpers"
grep -Fq 'toolbox_store="$HOME/.local/share/sbx-manager/script-toolbox"' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not hide the sparse toolbox checkout"
grep -Fq 'git -C "$toolbox_store" sparse-checkout set agent' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not limit the toolbox checkout to agent/"
grep -Fq 'toolbox_agent=/home/agent/.local/share/sbx-manager/script-toolbox/agent' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not locate the sparse agent helpers"
grep -Fq 'for command_name in agentctl mcpctl promptctl skillsctl; do' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not install all agent controller links"
grep -Fq 'command_link="/usr/local/bin/$command_name"' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not expose agent commands globally"
grep -Fq 'Refusing to replace existing command: $command_link' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not preserve global command conflicts"
grep -Fq 'path: /home/agent/.config/sbx-manager/workspace' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not record the primary workspace"
grep -Fq 'description: Link the primary sbx workspace at ~/workspace' \
  "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not create the workspace alias"
grep -Fq 'rmdir -- "$HOME/workspace"' "$SHELL_KIT/spec.yaml" \
  || fail "default shell kit does not replace the image's empty workspace directory"
grep -Fq 'eval "$(zoxide init zsh)"' "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing zoxide initialization"
grep -Fq 'source "$HOME/.config/sbx-manager/enter-workspace.zsh"' \
  "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit does not load the workspace entry helper"
grep -Fq 'setopt print_eight_bit' "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit does not enable literal non-ASCII completion output"
grep -Fq 'source /usr/share/doc/fzf/examples/key-bindings.zsh' \
  "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing fzf key bindings"
grep -Fq "alias ll='eza " "$SHELL_KIT/files/home/.zshrc" \
  || fail "default shell kit is missing eza aliases"
grep -Fq 'format = "${env_var.IS_SANDBOX}$username' \
  "$SHELL_KIT/files/home/.config/starship.toml" \
  || fail "Starship sandbox marker is not using the named env-var syntax"
if grep -Fq '$env_var.IS_SANDBOX' \
  "$SHELL_KIT/files/home/.config/starship.toml"; then
  fail "Starship prompt still renders .IS_SANDBOX as literal text"
fi

# In the C locale zsh quotes every UTF-8 byte as $'\NNN'. The kit locale must
# make filename completion preserve the original Chinese characters.
utf8_filename='grok注册机_20260725.zip'
utf8_quoted="$(
  LANG=C.UTF-8 LC_ALL=C.UTF-8 zsh -f -c \
    'value="$1"; print -r -- "${(q)value}"' zsh "$utf8_filename"
)"
[ "$utf8_quoted" = "$utf8_filename" ] \
  || fail "UTF-8 locale did not preserve a Chinese filename in zsh"

# The zsh entry helper must not depend on the asynchronous kit startup command:
# it creates or refreshes ~/workspace itself and enters that logical path.
workspace_entry_case="$TEST_TMP_DIR/workspace-entry"
workspace_entry_home="$workspace_entry_case/home"
workspace_entry_target="$workspace_entry_case/original workspace"
workspace_entry_old="$workspace_entry_case/old workspace"
mkdir -p "$workspace_entry_home/.config/sbx-manager" \
  "$workspace_entry_target" "$workspace_entry_old"
printf '%s\n' "$workspace_entry_target" \
  > "$workspace_entry_home/.config/sbx-manager/workspace"
ln -s "$workspace_entry_old" "$workspace_entry_home/workspace"
HOME="$workspace_entry_home" zsh -f -c '
  cd "$1"
  source "$2"
  [[ "$PWD" == "$HOME/workspace" ]]
  [[ "$(readlink "$HOME/workspace")" == "$1" ]]
' zsh "$workspace_entry_target" \
  "$SHELL_KIT/files/home/.config/sbx-manager/enter-workspace.zsh" \
  || fail "workspace entry helper did not refresh and enter ~/workspace"

# The official shell image may pre-create ~/workspace as an empty directory.
# It is safe to replace only when rmdir confirms that it contains no data.
empty_workspace_case="$TEST_TMP_DIR/empty-workspace-entry"
empty_workspace_home="$empty_workspace_case/home"
empty_workspace_target="$empty_workspace_case/target workspace"
mkdir -p "$empty_workspace_home/.config/sbx-manager" \
  "$empty_workspace_home/workspace" "$empty_workspace_target"
printf '%s\n' "$empty_workspace_target" \
  > "$empty_workspace_home/.config/sbx-manager/workspace"
HOME="$empty_workspace_home" zsh -f -c '
  cd "$1"
  source "$2"
  [[ -L "$HOME/workspace" ]]
  [[ "$PWD" == "$HOME/workspace" ]]
  [[ "$(readlink "$HOME/workspace")" == "$1" ]]
' zsh "$empty_workspace_target" \
  "$SHELL_KIT/files/home/.config/sbx-manager/enter-workspace.zsh" \
  || fail "workspace entry helper did not replace an empty ~/workspace directory"

# Bash 3.2 with nounset treats an empty array expansion as unbound. A manager
# with no command must remain read-only, guide a new user to setup when sbx is
# missing, and then show the normal help. Use a minimal PATH so the host's sbx
# installation cannot hide the first-run behavior.
first_run_bin="$TEST_TMP_DIR/first-run-bin"
mkdir -p "$first_run_bin"
ln -s "$(command -v cat)" "$first_run_bin/cat"
ln -s "$(command -v dirname)" "$first_run_bin/dirname"

PATH="$first_run_bin" NO_COLOR=1 /bin/bash "$ROOT_DIR/sbx-manager.sh" \
  > "$TEST_TMP_DIR/no-arguments-output" 2>&1
grep -Fq 'First-time setup' "$TEST_TMP_DIR/no-arguments-output" \
  || fail "no-argument invocation did not show first-run guidance"
grep -Fq './sbx-manager.sh setup balanced' \
  "$TEST_TMP_DIR/no-arguments-output" \
  || fail "no-argument invocation did not recommend setup"
grep -Fq 'Usage' "$TEST_TMP_DIR/no-arguments-output" \
  || fail "no-argument invocation did not show help"

PATH="$first_run_bin" NO_COLOR=1 /bin/bash "$ROOT_DIR/sbx-manager.sh" --yes \
  > "$TEST_TMP_DIR/global-options-only-output" 2>&1
grep -Fq './sbx-manager.sh setup balanced' \
  "$TEST_TMP_DIR/global-options-only-output" \
  || fail "global-options-only invocation did not recommend setup"
grep -Fq 'Usage' "$TEST_TMP_DIR/global-options-only-output" \
  || fail "global-options-only invocation did not show help"

if PATH="$first_run_bin" NO_COLOR=1 \
  /bin/bash "$ROOT_DIR/sbx-manager.sh" run shell . \
  > "$TEST_TMP_DIR/missing-sbx-output" 2>&1; then
  fail "sbx-dependent command succeeded without sbx"
fi
grep -Fq './sbx-manager.sh setup balanced' \
  "$TEST_TMP_DIR/missing-sbx-output" \
  || fail "missing-sbx error did not recommend setup"

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
assert_contains "$TEST_TMP_DIR/block-driver/log" \
  "run --name test-claude --kit $SHELL_KIT claude $TEST_TMP_DIR/block-driver/workspace"
if [ "$(uname -s)" = Linux ]; then
  assert_contains "$TEST_TMP_DIR/block-driver/log" 'daemon stop'
  assert_contains "$TEST_TMP_DIR/block-driver/log" 'daemon start --detach'
  if tail -n 1 "$TEST_TMP_DIR/block-driver/daemon.log" \
    | grep -Fq 'mkfs.ext4 not available'; then
    fail "block-volume repair did not replace the disabled daemon session"
  fi
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

# Omitting the agent makes the manager open a persistent shell workspace.
mkdir -p "$TEST_TMP_DIR/default-shell/home" \
  "$TEST_TMP_DIR/default-shell/config" \
  "$TEST_TMP_DIR/default-shell/workspace"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/default-shell/policy-state"
: > "$TEST_TMP_DIR/default-shell/auth-state"
: > "$TEST_TMP_DIR/default-shell/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/default-shell/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/default-shell/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/default-shell/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/default-shell/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/default-shell/auth-state" \
  "$ROOT_DIR/sbx-manager.sh" run \
    "$TEST_TMP_DIR/default-shell/workspace" \
  > "$TEST_TMP_DIR/default-shell/output" 2>&1
assert_contains "$TEST_TMP_DIR/default-shell/log" \
  "run --name shell-workspace --kit $SHELL_KIT shell $TEST_TMP_DIR/default-shell/workspace"

# The manager must derive Docker's stable default name itself. Otherwise a
# repeated path-only command cannot detect and refresh its existing sandbox.
mkdir -p "$TEST_TMP_DIR/generated-name/home" \
  "$TEST_TMP_DIR/generated-name/config" \
  "$TEST_TMP_DIR/generated-name/grok_reg"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/generated-name/policy-state"
: > "$TEST_TMP_DIR/generated-name/auth-state"
: > "$TEST_TMP_DIR/generated-name/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/generated-name/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/generated-name/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/generated-name/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/generated-name/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/generated-name/auth-state" \
  SBX_TEST_SANDBOX_NAMES='shell-grok-reg' \
  SBX_TEST_SHELL_KIT_CURRENT=0 \
  "$ROOT_DIR/sbx-manager.sh" run "$TEST_TMP_DIR/generated-name/grok_reg" \
  > "$TEST_TMP_DIR/generated-name/output" 2>&1
assert_contains "$TEST_TMP_DIR/generated-name/log" \
  "kit add shell-grok-reg $SHELL_KIT"
assert_contains "$TEST_TMP_DIR/generated-name/log" \
  'run --name shell-grok-reg'

# Relative paths are resolved for naming, while the original workspace
# argument remains untouched for sbx.
mkdir -p "$TEST_TMP_DIR/relative-name/home" \
  "$TEST_TMP_DIR/relative-name/config" \
  "$TEST_TMP_DIR/relative-name/Project_Name"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/relative-name/policy-state"
: > "$TEST_TMP_DIR/relative-name/auth-state"
: > "$TEST_TMP_DIR/relative-name/log"
(
  cd "$TEST_TMP_DIR/relative-name/Project_Name"
  PATH="$FIXTURE_DIR:/usr/bin:/bin" \
    HOME="$TEST_TMP_DIR/relative-name/home" \
    XDG_CONFIG_HOME="$TEST_TMP_DIR/relative-name/config" \
    NO_COLOR=1 \
    SBX_TEST_LOG="$TEST_TMP_DIR/relative-name/log" \
    SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/relative-name/policy-state" \
    SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/relative-name/auth-state" \
    "$ROOT_DIR/sbx-manager.sh" run . \
    > "$TEST_TMP_DIR/relative-name/output" 2>&1
)
assert_contains "$TEST_TMP_DIR/relative-name/log" \
  "run --name shell-project-name --kit $SHELL_KIT shell ."

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

# Existing named sandboxes predate the current kit marker. Reattaching must
# apply the current kit once instead of silently keeping stale dotfiles.
mkdir -p "$TEST_TMP_DIR/stale-kit/home" "$TEST_TMP_DIR/stale-kit/config"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/stale-kit/policy-state"
: > "$TEST_TMP_DIR/stale-kit/auth-state"
: > "$TEST_TMP_DIR/stale-kit/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/stale-kit/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/stale-kit/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/stale-kit/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/stale-kit/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/stale-kit/auth-state" \
  SBX_TEST_SANDBOX_NAMES='stale-shell' \
  SBX_TEST_SHELL_KIT_CURRENT=0 \
  "$ROOT_DIR/sbx-manager.sh" run --name stale-shell \
  > "$TEST_TMP_DIR/stale-kit/output" 2>&1
assert_contains "$TEST_TMP_DIR/stale-kit/log" \
  "kit add stale-shell $SHELL_KIT"
assert_contains "$TEST_TMP_DIR/stale-kit/log" 'run --name stale-shell'

# The opt-out flag also prevents an existing custom sandbox from being
# modified during reattach.
mkdir -p "$TEST_TMP_DIR/no-refresh/home" "$TEST_TMP_DIR/no-refresh/config"
printf '%s\n' 'allow-all' > "$TEST_TMP_DIR/no-refresh/policy-state"
: > "$TEST_TMP_DIR/no-refresh/auth-state"
: > "$TEST_TMP_DIR/no-refresh/log"
PATH="$FIXTURE_DIR:/usr/bin:/bin" \
  HOME="$TEST_TMP_DIR/no-refresh/home" \
  XDG_CONFIG_HOME="$TEST_TMP_DIR/no-refresh/config" \
  NO_COLOR=1 \
  SBX_TEST_LOG="$TEST_TMP_DIR/no-refresh/log" \
  SBX_TEST_POLICY_STATE="$TEST_TMP_DIR/no-refresh/policy-state" \
  SBX_TEST_AUTH_STATE="$TEST_TMP_DIR/no-refresh/auth-state" \
  SBX_TEST_SANDBOX_NAMES='custom-shell' \
  SBX_TEST_SHELL_KIT_CURRENT=0 \
  "$ROOT_DIR/sbx-manager.sh" run --name custom-shell --no-shell-kit \
  > "$TEST_TMP_DIR/no-refresh/output" 2>&1
assert_contains "$TEST_TMP_DIR/no-refresh/log" 'run --name custom-shell'
if grep -Fq 'kit add custom-shell' "$TEST_TMP_DIR/no-refresh/log"; then
  fail "--no-shell-kit unexpectedly refreshed an existing sandbox"
fi

printf '%s\n' 'PASS: sbx-manager setup, run, and shell-kit flow'
