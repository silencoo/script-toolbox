#!/usr/bin/env bash
# Isolated behavior tests for mcpctl. No network access or real user config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCPCTL="${SCRIPT_DIR}/mcpctl"
TEST_ROOT="$(mktemp -d)"
TEST_HOME="${TEST_ROOT}/home"
STORE="${TEST_ROOT}/store"
FAKE_BIN="${TEST_ROOT}/bin"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

mkdir -p "$TEST_HOME" "$FAKE_BIN"

HOME="$TEST_HOME" "$MCPCTL" init --store "$STORE" >/dev/null
[ -f "$STORE/catalog.json" ] || fail "init did not create catalog.json"
[ -f "$STORE/profiles/frontend.json" ] || fail "init did not create profiles"
if HOME="$TEST_HOME" "$MCPCTL" init --store "$STORE" >/dev/null 2>&1; then
  fail "init overwrote an existing store"
fi

profile_list="$(HOME="$TEST_HOME" "$MCPCTL" profile list --store "$STORE")"
printf '%s' "$profile_list" | grep -q '^frontend' ||
  fail "profile list omitted frontend"
printf '%s' "$profile_list" | grep -q '^reverse' ||
  fail "profile list omitted reverse"

claude_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show frontend \
    --target claude --store "$STORE"
)"
printf '%s' "$claude_profile" | grep -q '  brave$' ||
  fail "Claude frontend profile did not enable Brave"
! printf '%s' "$claude_profile" | grep -q '  exa$' ||
  fail "Claude frontend profile unexpectedly enabled Exa"

codex_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show frontend \
    --target codex --store "$STORE"
)"
printf '%s' "$codex_profile" | grep -q '  exa$' ||
  fail "Codex frontend profile did not enable Exa"
! printf '%s' "$codex_profile" | grep -q '  brave$' ||
  fail "Codex frontend profile unexpectedly enabled Brave"

override_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show frontend \
    --target codex --enable brave --disable exa --store "$STORE"
)"
printf '%s' "$override_profile" | grep -q '  brave$' ||
  fail "CLI enable override was not applied"
! printf '%s' "$override_profile" | grep -q '  exa$' ||
  fail "CLI disable did not win"

mkdir -p "$TEST_HOME/.claude"
printf '%s\n' \
  '{"theme":"dark","mcpServers":{"user-owned":{"command":"keep-me"}}}' \
  > "$TEST_HOME/.claude/settings.json"

plan_output="$(
  HOME="$TEST_HOME" BRAVE_API_KEY='never-print-this-secret' \
    "$MCPCTL" plan --target claude --profile frontend --store "$STORE"
)"
! printf '%s' "$plan_output" | grep -q 'never-print-this-secret' ||
  fail "plan printed a secret value"
printf '%s' "$plan_output" | grep -q 'env BRAVE_API_KEY (available)' ||
  fail "plan did not report the redacted secret source"

HOME="$TEST_HOME" BRAVE_API_KEY='test-brave' \
  "$MCPCTL" apply --target claude --profile frontend \
    --store "$STORE" >/dev/null

jq -e '
  .theme == "dark"
  and .mcpServers["user-owned"].command == "keep-me"
  and .mcpServers.brave.headers["X-Subscription-Token"] == "test-brave"
  and .mcpServers.brave._managed_by == "agent/mcpctl"
  and .mcpServers.context7.headers == null
  and .mcpServers["chrome-devtools"].command == "npx"
  and .mcpServers["chrome-devtools"].args ==
    ["-y", "chrome-devtools-mcp@1.6.0"]
' "$TEST_HOME/.claude/settings.json" >/dev/null ||
  fail "Claude frontend config was not rendered correctly"
[ "$(mode_of "$TEST_HOME/.claude/settings.json")" = "600" ] ||
  fail "Claude config mode is not 0600"

current_output="$(
  HOME="$TEST_HOME" "$MCPCTL" current --target claude --store "$STORE"
)"
printf '%s' "$current_output" | grep -q '^Profile: frontend$' ||
  fail "current did not report the applied profile"

HOME="$TEST_HOME" \
  "$MCPCTL" apply --target claude --profile reverse \
    --store "$STORE" >/dev/null
jq -e '
  .theme == "dark"
  and .mcpServers["user-owned"].command == "keep-me"
  and .mcpServers.context7._managed_by == "agent/mcpctl"
  and .mcpServers.brave == null
  and .mcpServers["chrome-devtools"] == null
' "$TEST_HOME/.claude/settings.json" >/dev/null ||
  fail "Claude profile switch did not reconcile owned entries"

jq -e '
  .targets.claude.profile == "reverse"
  and .targets.claude.servers == ["context7"]
' "$TEST_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "applied state was not updated"

# Same-name entries created by a user or the old mcp.sh are not adopted
# silently. --force replaces only the conflicting name.
printf '%s\n' \
  '{"theme":"light","mcpServers":{"brave":{"url":"https://user.example/mcp"},"other":{"command":"keep"}}}' \
  > "$TEST_HOME/.claude/settings.json"
if HOME="$TEST_HOME" BRAVE_API_KEY=test-brave \
  "$MCPCTL" apply --target claude --profile frontend \
    --store "$STORE" >/dev/null 2>&1; then
  fail "unmanaged same-name Claude entry was replaced without --force"
fi
HOME="$TEST_HOME" BRAVE_API_KEY=test-brave \
  "$MCPCTL" apply --target claude --profile frontend \
    --store "$STORE" --force >/dev/null
jq -e '
  .theme == "light"
  and .mcpServers.other.command == "keep"
  and .mcpServers.brave._managed_by == "agent/mcpctl"
' "$TEST_HOME/.claude/settings.json" >/dev/null ||
  fail "Claude --force changed unrelated configuration"

# Codex uses a bounded TOML block and preserves other tables while switching.
mkdir -p "$TEST_HOME/.codex"
printf '%s\n' \
  '[model]' \
  'name = "keep"' \
  '' \
  '[mcp_servers.user-owned]' \
  'url = "https://user.example/mcp"' \
  > "$TEST_HOME/.codex/config.toml"

HOME="$TEST_HOME" EXA_API_KEY='test-exa' \
  "$MCPCTL" apply --target codex --profile frontend \
    --store "$STORE" >/dev/null
grep -qF '# >>> agent/mcpctl >>>' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex managed marker missing"
grep -qF '[mcp_servers.user-owned]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex user entry was removed"
grep -qF '[mcp_servers.exa]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex target override did not enable Exa"
grep -qF '"Authorization" = "Bearer test-exa"' \
  "$TEST_HOME/.codex/config.toml" ||
  fail "Codex Exa secret was not rendered"
! grep -qF '[mcp_servers.brave]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex target override unexpectedly enabled Brave"

HOME="$TEST_HOME" \
  "$MCPCTL" apply --target codex --profile reverse \
    --store "$STORE" >/dev/null
grep -qF '[mcp_servers.user-owned]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex switch removed a user entry"
grep -qF '[mcp_servers.context7]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex reverse profile omitted Context7"
! grep -qF '[mcp_servers.exa]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex switch left a stale managed Exa entry"
[ "$(mode_of "$TEST_HOME/.codex/config.toml")" = "600" ] ||
  fail "Codex config mode is not 0600"

# Missing required profile secrets fail before replacing the target.
cp "$TEST_HOME/.codex/config.toml" "$TEST_ROOT/codex.before"
if HOME="$TEST_HOME" \
  "$MCPCTL" apply --target codex --profile research \
    --store "$STORE" >/dev/null 2>&1; then
  fail "profile with missing required secrets was applied"
fi
cmp -s "$TEST_ROOT/codex.before" "$TEST_HOME/.codex/config.toml" ||
  fail "Codex config changed after secret resolution failed"

# OpenCode receives its native local/HTTP shapes.
mkdir -p "$TEST_HOME/.config/opencode"
printf '%s\n' '{"theme":"system","mcp":{"user":{"type":"local","command":["keep"]}}}' \
  > "$TEST_HOME/.config/opencode/opencode.json"
HOME="$TEST_HOME" BRAVE_API_KEY=test-brave EXA_API_KEY=test-exa \
  "$MCPCTL" apply --target opencode --profile research \
    --enable chrome-devtools --store "$STORE" >/dev/null
jq -e '
  .theme == "system"
  and .mcp.user.command == ["keep"]
  and .mcp.brave.headers["X-Subscription-Token"] == "test-brave"
  and .mcp.exa.headers.Authorization == "Bearer test-exa"
  and .mcp["chrome-devtools"].type == "local"
  and .mcp["chrome-devtools"].command ==
    ["npx", "-y", "chrome-devtools-mcp@1.6.0"]
' "$TEST_HOME/.config/opencode/opencode.json" >/dev/null ||
  fail "OpenCode profile was not rendered correctly"

HOME="$TEST_HOME" \
  "$MCPCTL" apply --target opencode --profile off \
    --store "$STORE" >/dev/null
jq -e '
  .theme == "system"
  and .mcp.user.command == ["keep"]
  and .mcp.brave == null
  and .mcp.exa == null
  and .mcp.context7 == null
  and .mcp["chrome-devtools"] == null
' "$TEST_HOME/.config/opencode/opencode.json" >/dev/null ||
  fail "empty off profile did not remove all owned OpenCode entries"

# Exercise the encrypted-backend boundary without requiring SOPS in CI.
printf '%s\n' 'ciphertext-placeholder' > "$STORE/secrets.sops.json"
cat > "$FAKE_BIN/sops" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' '{"schema":1,"secrets":{"brave_api_key":"sops-brave","exa_api_key":"sops-exa","context7_api_key":"sops-context"}}'
EOF
chmod +x "$FAKE_BIN/sops"
HOME="$TEST_HOME" MCPCTL_SOPS_BIN="$FAKE_BIN/sops" \
  "$MCPCTL" apply --target claude --profile frontend \
    --store "$STORE" --force >/dev/null
jq -e '
  .mcpServers.brave.headers["X-Subscription-Token"] == "sops-brave"
  and .mcpServers.context7.headers.Authorization == "Bearer sops-context"
' "$TEST_HOME/.claude/settings.json" >/dev/null ||
  fail "SOPS-backed secrets were not resolved"

# Malformed target config fails closed.
printf '%s\n' '{invalid-json' > "$TEST_HOME/.claude/settings.json"
cp "$TEST_HOME/.claude/settings.json" "$TEST_ROOT/claude.before"
if HOME="$TEST_HOME" "$MCPCTL" apply --target claude --profile off \
  --store "$STORE" >/dev/null 2>&1; then
  fail "malformed Claude JSON was accepted"
fi
cmp -s "$TEST_ROOT/claude.before" "$TEST_HOME/.claude/settings.json" ||
  fail "malformed Claude JSON changed after a failed apply"

# Inheritance cycles fail before touching a target.
printf '%s\n' \
  '{"schema":1,"name":"cycle-a","extends":["cycle-b"],"enable":[],"disable":[],"target_overrides":{}}' \
  > "$STORE/profiles/cycle-a.json"
printf '%s\n' \
  '{"schema":1,"name":"cycle-b","extends":["cycle-a"],"enable":[],"disable":[],"target_overrides":{}}' \
  > "$STORE/profiles/cycle-b.json"
if HOME="$TEST_HOME" "$MCPCTL" profile show cycle-a \
  --target codex --store "$STORE" >/dev/null 2>&1; then
  fail "profile inheritance cycle was accepted"
fi

command -v node >/dev/null 2>&1 ||
  fail "Node.js is required to test encrypted remote backup"
node --test "$SCRIPT_DIR/remote-client.test.mjs" ||
  fail "encrypted remote backup and restore tests failed"

printf 'ok  : mcpctl profiles, ownership, local secrets, and encrypted remote restore\n'
