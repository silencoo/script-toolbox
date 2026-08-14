#!/usr/bin/env bash
# Windows-host smoke test for the supported Git Bash controller contract.

set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    printf 'SKIP: windows-git-bash-smoke.sh requires a Windows Git Bash host\n'
    exit 0
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_BASE="$(mktemp -d)"
TEST_ROOT="${TEST_BASE}/Windows User 工具"
HOME_DIR="${TEST_ROOT}/home"
APPDATA_DIR="${TEST_ROOT}/App Data/Roaming"
LOCALAPPDATA_DIR="${TEST_ROOT}/App Data/Local"
STORE="${APPDATA_DIR}/mcpctl/store"
STATE="${TEST_ROOT}/state/applied.json"
CODEX_CONFIG="${TEST_ROOT}/client files/config.toml"

cleanup() { rm -rf "$TEST_BASE"; }
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

for command_name in bash cygpath node jq python; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required Windows test command is missing: $command_name"
done

mkdir -p "$HOME_DIR" "$APPDATA_DIR" "$LOCALAPPDATA_DIR" \
  "$(dirname "$STATE")" "$(dirname "$CODEX_CONFIG")"
export HOME="$HOME_DIR"
export USERPROFILE="$(cygpath -w "$HOME_DIR")"
export APPDATA="$(cygpath -w "$APPDATA_DIR")"
export LOCALAPPDATA="$(cygpath -w "$LOCALAPPDATA_DIR")"

[ "$(bash "$AGENT_DIR/agentctl/agentctl" --version)" = \
  "agentctl 0.17.1" ] || fail "agentctl did not launch through Git Bash"

provider_catalog="$(
  bash "$AGENT_DIR/agentctl/agentctl" provider list \
    --target claude \
    --store "${TEST_ROOT}/providers.json" \
    --secrets "${TEST_ROOT}/provider-secrets.json" \
    --state "${TEST_ROOT}/provider-state.json" \
    --json
)"
printf '%s' "$provider_catalog" | jq -e '
  type == "array" and any(.[]; .name == "deepseek")
' >/dev/null || fail "agentctl Provider catalog failed through Git Bash"

MCPCTL_CODEX_CONFIG="$CODEX_CONFIG" \
  MCPCTL_STATE_FILE="$STATE" \
  bash "$AGENT_DIR/mcpctl/mcpctl" init >/dev/null
[ -f "$STORE/catalog.json" ] ||
  fail "mcpctl did not use the Windows roaming AppData default"
MCPCTL_CODEX_CONFIG="$CODEX_CONFIG" \
  MCPCTL_STATE_FILE="$STATE" \
  bash "$AGENT_DIR/mcpctl/mcpctl" apply \
    --target codex --profile off >/dev/null

current="$(
  MCPCTL_CODEX_CONFIG="$CODEX_CONFIG" \
    MCPCTL_STATE_FILE="$STATE" \
    bash "$AGENT_DIR/mcpctl/mcpctl" current \
      --target codex --json
)"
printf '%s' "$current" | jq -e '
  .target == "codex"
  and .profile == "off"
  and .servers == []
  and .healthy == true
' >/dev/null || fail "mcpctl could not apply and inspect an isolated Windows target"

SKILLSCTL_CODEX_DIR="$(cygpath -w "${TEST_ROOT}/skill links")" \
  bash "$AGENT_DIR/skillsctl/skillsctl" init --yes >/dev/null
[ -f "$APPDATA_DIR/skillsctl/store/catalog.json" ] ||
  fail "skillsctl did not use the Windows roaming AppData default"
bash "$AGENT_DIR/skillsctl/skillsctl" --help >/dev/null ||
  fail "skillsctl frontend did not launch through Git Bash"
bash "$AGENT_DIR/promptctl/promptctl" --help >/dev/null ||
  fail "promptctl frontend did not launch through Git Bash"
node "$AGENT_DIR/tui/dist/toolbox-tui.mjs" --help >/dev/null ||
  fail "portable TUI bundle did not launch on Windows"

printf 'ok  : Windows Git Bash controllers, spaced paths, MCP apply, and TUI launch\n'
