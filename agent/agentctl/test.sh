#!/usr/bin/env bash
# Isolated routing and interaction tests for agentctl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTCTL="${SCRIPT_DIR}/agentctl"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
BACKEND_ROOT="${TEST_ROOT}/backends"
LOG_FILE="${TEST_ROOT}/backend.log"
TEST_HOME="${TEST_ROOT}/home"
FAKE_BIN="${TEST_ROOT}/bin"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

make_backend() {
  local client="$1" path="${BACKEND_ROOT}/${client}/setup.sh"
  mkdir -p "${BACKEND_ROOT}/${client}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'set -euo pipefail'
    printf '%s\n' 'client="$(basename "$(dirname "$0")")"'
    printf '%s\n' 'case "${1:-}" in'
    printf '%s\n' '  --list-providers) printf "%s-provider\n" "$client" ;;'
    printf '%s\n' '  --help) printf "usage: agentctl setup %s [options]\n" "$client" ;;'
    printf '%s\n' '  --uninstall) printf "uninstall %s\n" "$client" >> "$AGENTCTL_TEST_LOG" ;;'
    printf '%s\n' '  *)'
    printf '%s\n' '    printf "setup %s" "$client" >> "$AGENTCTL_TEST_LOG"'
    printf '%s\n' '    for argument in "$@"; do printf " <%s>" "$argument" >> "$AGENTCTL_TEST_LOG"; done'
    printf '%s\n' '    printf "\n" >> "$AGENTCTL_TEST_LOG"'
    printf '%s\n' '    ;;'
    printf '%s\n' 'esac'
  } > "$path"
  chmod +x "$path"
}

for client in claude-code codex opencode pi; do
  make_backend "$client"
done

{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf '%s\n' 'printf "statusline"'
  printf '%s\n' 'for argument in "$@"; do printf " <%s>" "$argument"; done'
  printf '%s\n' 'printf "\n"'
} > "$BACKEND_ROOT/claude-code/statusline-setup.sh"
chmod +x "$BACKEND_ROOT/claude-code/statusline-setup.sh"

mkdir -p "$TEST_HOME" "$FAKE_BIN"
: > "$LOG_FILE"
for command_name in claude codex opencode pi; do
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'printf "%s test-version\n" "$(basename "$0")"'
  } > "${FAKE_BIN}/${command_name}"
  chmod +x "${FAKE_BIN}/${command_name}"
done

run_agentctl() {
  HOME="$TEST_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" "$@"
}

bash -n "$AGENTCTL" || fail "agentctl has invalid Bash syntax"

help_output="$(run_agentctl --help)"
printf '%s' "$help_output" | grep -q '^  agentctl$' ||
  fail "help omitted the no-argument guide"
[ "$(AGENTCTL_AGENT_ROOT="$TEST_ROOT/missing" "$AGENTCTL" --version)" = \
  "agentctl 0.17.1" ] ||
  fail "metadata commands unnecessarily required the backend tree"
[ "$(run_agentctl --version)" = "agentctl 0.17.1" ] ||
  fail "version output is incorrect"

run_agentctl failover --help >/dev/null ||
  fail "failover command did not reach its controller"

[ "$(run_agentctl statusline install --yes --force)" = \
  "statusline <install> <--yes> <--force>" ] ||
  fail "statusline command did not reach the Claude preset manager"

provider_catalog="$(run_agentctl provider list --target claude --json)"
printf '%s' "$provider_catalog" | jq -e '
  any(.[]; .name == "deepseek" and .source == "builtin" and .status == "needs-key")
' >/dev/null || fail "unified Provider catalog omitted the DeepSeek built-in"

for removed_command in providers list-providers setup configure init; do
  if run_agentctl "$removed_command" claude >"$TEST_ROOT/removed-${removed_command}.out" 2>&1; then
    fail "removed Provider command '$removed_command' was still accepted"
  fi
  grep -q "unknown command '$removed_command'" "$TEST_ROOT/removed-${removed_command}.out" ||
    fail "removed Provider command '$removed_command' did not fail clearly"
done

mkdir -p "$TEST_HOME/.codex/provider-keys"
cat > "$TEST_HOME/.codex/config.toml" <<'EOF'
# >>> agent/codex/setup.sh >>>
model = "gpt-test"
model_provider = "script_toolbox_openai"
# <<< agent/codex/setup.sh <<<

# >>> agent/codex/setup.sh >>>
[model_providers.script_toolbox_openai]
name = "OpenAI"
# <<< agent/codex/setup.sh <<<
EOF
printf '%s\n' 'STATUS-SECRET-MUST-NOT-APPEAR' \
  > "$TEST_HOME/.codex/provider-keys/script_toolbox_openai.key"
chmod 600 "$TEST_HOME/.codex/provider-keys/script_toolbox_openai.key"
printf '%s\n' "$TEST_HOME/.codex/provider-keys/script_toolbox_openai.key" \
  > "$TEST_HOME/.codex/.script-toolbox-provider-key"
chmod 600 "$TEST_HOME/.codex/.script-toolbox-provider-key"
printf '%s\n' \
  '{"auth_mode":"chatgpt","tokens":{"access_token":"PRESERVED-OFFICIAL-LOGIN-MUST-NOT-APPEAR"}}' \
  > "$TEST_HOME/.codex/auth.json"
chmod 600 "$TEST_HOME/.codex/auth.json"

status_json="$(run_agentctl status codex --json)"
printf '%s' "$status_json" | jq -e '
  .client == "codex"
  and .cli_installed == true
  and .provider_status == "configured"
  and .provider_source == "agentctl"
  and .provider == "script_toolbox_openai"
  and .model == "gpt-test"
  and .config_valid == true
  and .credential_exists == true
  and .credential_mode == "600"
  and .credential_private == true
  and .identity.status == "configured"
  and .identity.kind == "chatgpt"
  and .identity.account == "current"
  and .identity.credential_exists == true
  and .identity.credential_private == true
  and .inference.provider == "script_toolbox_openai"
  and .inference.model == "gpt-test"
  and .inference.source == "agentctl"
  and .official_login_preserved == true
  and .identity_inference_split == true
' >/dev/null || fail "Codex JSON status omitted provider or credential metadata"
case "$status_json" in
  *STATUS-SECRET-MUST-NOT-APPEAR*|*PRESERVED-OFFICIAL-LOGIN-MUST-NOT-APPEAR*)
    fail "status JSON exposed a credential value"
    ;;
esac

OFFICIAL_HOME="${TEST_ROOT}/official-home"
mkdir -p "$OFFICIAL_HOME/.codex"
printf '%s\n' 'model = "gpt-official"' > "$OFFICIAL_HOME/.codex/config.toml"
printf '%s\n' \
  '{"auth_mode":"chatgpt","tokens":{"access_token":"OFFICIAL-LOGIN-SECRET-MUST-NOT-APPEAR"}}' \
  > "$OFFICIAL_HOME/.codex/auth.json"
chmod 600 "$OFFICIAL_HOME/.codex/auth.json"
official_status="$(
  HOME="$OFFICIAL_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
    AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" status codex --json
)"
printf '%s' "$official_status" | jq -e '
  .provider_status == "configured"
  and .provider_source == "official-login"
  and .provider == "openai-chatgpt"
  and .model == "gpt-official"
  and .identity.status == "configured"
  and .identity.kind == "chatgpt"
  and .identity.account == "current"
  and .inference.provider == "openai-official"
  and .inference.model == "gpt-official"
  and .inference.source == "official-account"
  and .official_login_preserved == true
  and .identity_inference_split == false
  and .ownership_marker == false
  and .credential_kind == "official-auth"
  and .credential_exists == true
  and .credential_private == true
' >/dev/null || fail "Codex status did not recognize an official ChatGPT login"
case "$official_status" in
  *OFFICIAL-LOGIN-SECRET-MUST-NOT-APPEAR*)
    fail "Codex official-login status exposed a token"
    ;;
esac

mkdir -p "$TEST_HOME/.config/opencode" "$TEST_HOME/.local/share/opencode"
printf '%s\n' '{"$schema":"https://opencode.ai/config.json","provider":{}}' \
  > "$TEST_HOME/.config/opencode/opencode.json"
printf '%s\n' \
  '{"google":{"type":"api","key":"OPENCODE-GOOGLE-SECRET-MUST-NOT-APPEAR"}}' \
  > "$TEST_HOME/.local/share/opencode/auth.json"
chmod 600 "$TEST_HOME/.local/share/opencode/auth.json"
native_opencode_status="$(run_agentctl status opencode --json)"
printf '%s' "$native_opencode_status" | jq -e '
  .provider_status == "configured"
  and .provider_source == "external-native-auth"
  and .provider == "google-gemini"
  and .model == null
  and .ownership_marker == false
  and .credential_kind == "native-auth"
  and .credential_exists == true
  and .credential_private == true
  and .inference.provider == "google-gemini"
  and .inference.source == "external-native-auth"
' >/dev/null || fail "OpenCode status did not recognize native Google auth"
case "$native_opencode_status" in
  *OPENCODE-GOOGLE-SECRET-MUST-NOT-APPEAR*)
    fail "OpenCode native-auth status exposed an API key"
    ;;
esac

mkdir -p "$TEST_HOME/.claude"
printf '%s\n' \
  '{"model":"claude-test","env":{"ANTHROPIC_API_KEY":"CLAUDE-EMBEDDED-SECRET"}}' \
  > "$TEST_HOME/.claude/settings.json"
chmod 600 "$TEST_HOME/.claude/settings.json"
external_claude_status="$(run_agentctl status claude --json)"
printf '%s' "$external_claude_status" | jq -e '
  .provider_status == "configured"
  and .provider_source == "external"
  and .provider == "anthropic"
  and .model == "claude-test"
  and .ownership_marker == false
  and .credential_exists == true
' >/dev/null || fail "Claude status did not recognize externally managed settings"
case "$external_claude_status" in
  *CLAUDE-EMBEDDED-SECRET*)
    fail "externally managed Claude status exposed a credential"
    ;;
esac
printf '%s\n' 'sk-state-value-that-is-not-a-provider' \
  > "$TEST_HOME/.claude/.script-toolbox-provider"
chmod 600 "$TEST_HOME/.claude/.script-toolbox-provider"
claude_status="$(run_agentctl status claude --json)"
printf '%s' "$claude_status" | jq -e '
  .provider_status == "incomplete"
  and .provider_source == "agentctl"
  and .provider == null
  and .credential_exists == true
  and .credential_private == true
' >/dev/null || fail "Claude status trusted a malformed provider marker"
case "$claude_status" in
  *CLAUDE-EMBEDDED-SECRET*|*sk-state-value-that-is-not-a-provider*)
    fail "Claude status exposed a credential or malformed state value"
    ;;
esac

all_status="$(run_agentctl status all --json)"
[ "$(printf '%s' "$all_status" | jq 'length')" = 4 ] ||
  fail "status all did not return all four clients"
case "$all_status" in
  *STATUS-SECRET-MUST-NOT-APPEAR*|*CLAUDE-EMBEDDED-SECRET*|*sk-state-value-that-is-not-a-provider*)
    fail "status all exposed a credential value"
    ;;
esac

# A broken CLI must not block aggregate status or the TUI forever. Version
# probing is bounded and the remaining configuration metadata is still usable.
cp "$FAKE_BIN/pi" "$FAKE_BIN/pi.fast"
printf '%s\n' '#!/usr/bin/env bash' 'sleep 30' > "$FAKE_BIN/pi"
chmod +x "$FAKE_BIN/pi"
version_probe_started="$(date +%s)"
bounded_status="$(run_agentctl status pi --json)"
version_probe_elapsed=$(( $(date +%s) - version_probe_started ))
[ "$version_probe_elapsed" -lt 8 ] ||
  fail "CLI version probe exceeded its bounded timeout"
printf '%s' "$bounded_status" | jq -e \
  '.client == "pi" and .cli_installed == true and .cli_version == null' \
  >/dev/null || fail "timed-out CLI version probe corrupted status metadata"
mv "$FAKE_BIN/pi.fast" "$FAKE_BIN/pi"

# A corrupted ownership marker is not trusted as a path or echoed back.
printf '%s\n' 'CORRUPTED-STATE-SECRET-MUST-STAY-HIDDEN' \
  > "$TEST_HOME/.codex/.script-toolbox-provider-key"
invalid_status="$(run_agentctl status codex --json)"
printf '%s' "$invalid_status" |
  jq -e '.credential_path_valid == false and .provider_status == "incomplete"' \
  >/dev/null || fail "status trusted an invalid credential path"
case "$invalid_status" in
  *CORRUPTED-STATE-SECRET-MUST-STAY-HIDDEN*)
    fail "status echoed an invalid ownership-state value"
    ;;
esac
printf '%s\n' "$TEST_HOME/.codex/provider-keys/script_toolbox_openai.key" \
  > "$TEST_HOME/.codex/.script-toolbox-provider-key"

# No arguments enter the Shell guide. The first action reads the unified
# catalog after the client selection.
printf '1\n4\n' |
  HOME="$TEST_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-providers.out" 2>&1 ||
  fail "no-argument provider guide failed"
grep -q 'Agentctl guided Shell setup' "$TEST_ROOT/interactive-providers.out" ||
  fail "no-argument command did not enter the guide"
grep -q 'deepseek' "$TEST_ROOT/interactive-providers.out" ||
  fail "guided Provider action omitted the unified catalog"

# Guided status is read-only and uses the same status implementation.
printf '2\n2\n' |
  HOME="$TEST_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-status.out" 2>&1 ||
  fail "guided status failed"
grep -q 'Inference   : configured (script_toolbox_openai)' \
  "$TEST_ROOT/interactive-status.out" ||
  fail "guided status omitted the configured Codex provider"

# Provider uninstall always asks separately and defaults to cancellation.
line_count_before="$(wc -l < "$LOG_FILE" | tr -d ' ')"
printf '4\n2\n\n' |
  HOME="$TEST_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-cancel.out" 2>&1 ||
  fail "guided uninstall cancellation returned an error"
line_count_after="$(wc -l < "$LOG_FILE" | tr -d ' ')"
[ "$line_count_after" = "$line_count_before" ] ||
  fail "cancelled uninstall invoked a backend"
grep -qF '[cancelled] no provider configuration was changed' \
  "$TEST_ROOT/interactive-cancel.out" ||
  fail "guided uninstall cancellation was not reported"

printf '4\n2\ny\n' |
  HOME="$TEST_HOME" \
    PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-uninstall.out" 2>&1 ||
  fail "guided uninstall failed"
grep -q '^uninstall codex$' "$LOG_FILE" ||
  fail "guided uninstall did not call provider-only --uninstall"

run_agentctl uninstall opencode --yes
grep -q '^uninstall opencode$' "$LOG_FILE" ||
  fail "explicit confirmed uninstall did not reach its backend"

if AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
  HOME="$TEST_HOME" \
  PATH="${FAKE_BIN}:${PATH}" \
  AGENTCTL_TEST_LOG="$LOG_FILE" \
  "$AGENTCTL" </dev/null >"$TEST_ROOT/eof.out" 2>&1; then
  fail "guided mode accepted missing input"
fi
grep -q 'interactive input ended' "$TEST_ROOT/eof.out" ||
  fail "guided EOF was not actionable"

if run_agentctl provider list --target unknown >"$TEST_ROOT/unknown.out" 2>&1; then
  fail "unknown client was accepted"
fi
grep -q "target.*must be one of" "$TEST_ROOT/unknown.out" ||
  fail "unknown client error was not actionable"

printf '%s\n' "ok  : agentctl guide, status, routing, and ownership boundary"
