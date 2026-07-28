#!/usr/bin/env bash
# Isolated routing and interaction tests for agentctl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTCTL="${SCRIPT_DIR}/agentctl"
TEST_ROOT="$(mktemp -d)"
TEST_ROOT="$(cd "$TEST_ROOT" && pwd -P)"
BACKEND_ROOT="${TEST_ROOT}/backends"
LOG_FILE="${TEST_ROOT}/backend.log"

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

run_agentctl() {
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" "$@"
}

bash -n "$AGENTCTL" || fail "agentctl has invalid Bash syntax"

help_output="$(run_agentctl --help)"
printf '%s' "$help_output" | grep -q '^  agentctl$' ||
  fail "help omitted the no-argument guide"
[ "$(AGENTCTL_AGENT_ROOT="$TEST_ROOT/missing" "$AGENTCTL" --version)" = \
  "agentctl 0.1.0" ] ||
  fail "metadata commands unnecessarily required the backend tree"
[ "$(run_agentctl --version)" = "agentctl 0.1.0" ] ||
  fail "version output is incorrect"

[ "$(run_agentctl providers claude)" = "claude-code-provider" ] ||
  fail "Claude alias did not resolve to claude-code"
[ "$(run_agentctl list-providers open-code)" = "opencode-provider" ] ||
  fail "OpenCode alias did not resolve"
[ "$(run_agentctl help codex)" = "usage: agentctl setup codex [options]" ] ||
  fail "client help did not reach the setup backend"

real_help="$("$AGENTCTL" help codex)"
printf '%s' "$real_help" |
  grep -qF "$AGENTCTL setup codex [options]" ||
  fail "real client help did not retain the public agentctl command"

run_agentctl setup codex --provider openai --model gpt-test >/dev/null
grep -qF 'setup codex <--provider> <openai> <--model> <gpt-test>' "$LOG_FILE" ||
  fail "setup options were not forwarded unchanged"

run_agentctl init pi --provider anthropic >/dev/null
grep -qF 'setup pi <--provider> <anthropic>' "$LOG_FILE" ||
  fail "init alias did not route to setup"

# No arguments enter the Shell guide. Read-only provider listing is delegated
# after the action and client selections.
printf '2\n4\n' |
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-providers.out" 2>&1 ||
  fail "no-argument provider guide failed"
grep -q 'Agentctl guided Shell setup' "$TEST_ROOT/interactive-providers.out" ||
  fail "no-argument command did not enter the guide"
grep -q 'pi-provider' "$TEST_ROOT/interactive-providers.out" ||
  fail "guided provider action selected the wrong backend"

# Guided setup delegates to the selected setup backend.
printf '1\n1\n' |
  AGENTCTL_AGENT_ROOT="$BACKEND_ROOT" \
    AGENTCTL_TEST_LOG="$LOG_FILE" \
    "$AGENTCTL" >"$TEST_ROOT/interactive-setup.out" 2>&1 ||
  fail "guided setup routing failed"
grep -q '^setup claude-code$' "$LOG_FILE" ||
  fail "guided setup did not invoke Claude Code"

# Provider uninstall always asks separately and defaults to cancellation.
line_count_before="$(wc -l < "$LOG_FILE" | tr -d ' ')"
printf '3\n2\n\n' |
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

printf '3\n2\ny\n' |
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
  AGENTCTL_TEST_LOG="$LOG_FILE" \
  "$AGENTCTL" </dev/null >"$TEST_ROOT/eof.out" 2>&1; then
  fail "guided mode accepted missing input"
fi
grep -q 'interactive input ended' "$TEST_ROOT/eof.out" ||
  fail "guided EOF was not actionable"

if run_agentctl providers unknown >"$TEST_ROOT/unknown.out" 2>&1; then
  fail "unknown client was accepted"
fi
grep -q "unsupported client 'unknown'" "$TEST_ROOT/unknown.out" ||
  fail "unknown client error was not actionable"

printf '%s\n' "ok  : agentctl guide, aliases, routing, and ownership boundary"
