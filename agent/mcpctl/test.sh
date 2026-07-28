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

# No arguments open the guided menu. Listing is read-only and works with the
# same store used by explicit commands.
interactive_list="$(
  printf '4\n' |
    HOME="$TEST_HOME" MCPCTL_STORE="$STORE" "$MCPCTL" 2>/dev/null
)"
printf '%s' "$interactive_list" | grep -q '^frontend' ||
  fail "no-argument interactive menu did not list profiles"

# A missing store can be initialized from the menu before choosing another
# action.
INTERACTIVE_INIT_STORE="${TEST_ROOT}/interactive-init-store"
INTERACTIVE_INIT_HOME="${TEST_ROOT}/interactive-init-home"
mkdir -p "$INTERACTIVE_INIT_HOME"
printf '\n5\n' |
  HOME="$INTERACTIVE_INIT_HOME" \
    "$MCPCTL" interactive --store "$INTERACTIVE_INIT_STORE" \
      >"$TEST_ROOT/interactive-init.out" 2>&1 ||
  fail "interactive menu did not initialize a missing store"
[ -f "$INTERACTIVE_INIT_STORE/catalog.json" ] ||
  fail "interactive initialization omitted catalog.json"

# Applying from the menu always runs a visible plan first and asks for a
# separate confirmation. The reverse profile needs no required secret.
INTERACTIVE_APPLY_HOME="${TEST_ROOT}/interactive-apply-home"
mkdir -p "$INTERACTIVE_APPLY_HOME"
printf '1\n2\n5\ny\n' |
  HOME="$INTERACTIVE_APPLY_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-apply.out" 2>&1 ||
  fail "interactive profile apply failed"
grep -q '^Target:  codex$' "$TEST_ROOT/interactive-apply.out" ||
  fail "interactive apply did not print its plan"
grep -qF '# >>> agent/mcpctl >>>' \
  "$INTERACTIVE_APPLY_HOME/.codex/config.toml" ||
  fail "interactive apply did not write the owned Codex block"
jq -e '.targets.codex.profile == "reverse"' \
  "$INTERACTIVE_APPLY_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "interactive apply did not update managed state"

# Declining the final confirmation leaves target configuration untouched.
INTERACTIVE_CANCEL_HOME="${TEST_ROOT}/interactive-cancel-home"
mkdir -p "$INTERACTIVE_CANCEL_HOME"
printf '1\n2\n5\nn\n' |
  HOME="$INTERACTIVE_CANCEL_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-cancel.out" 2>&1 ||
  fail "interactive cancellation returned an error"
[ ! -e "$INTERACTIVE_CANCEL_HOME/.codex/config.toml" ] ||
  fail "interactive cancellation changed target configuration"

# A profile with a missing required secret stops after the preview instead of
# asking for a confirmation that cannot succeed.
INTERACTIVE_MISSING_HOME="${TEST_ROOT}/interactive-missing-home"
mkdir -p "$INTERACTIVE_MISSING_HOME"
if printf '1\n2\n2\n' |
  HOME="$INTERACTIVE_MISSING_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-missing.out" 2>&1; then
  fail "interactive apply accepted a profile with missing required secrets"
fi
grep -q 'required secrets are missing' "$TEST_ROOT/interactive-missing.out" ||
  fail "interactive missing-secret failure was not actionable"
[ ! -e "$INTERACTIVE_MISSING_HOME/.codex/config.toml" ] ||
  fail "interactive missing-secret failure changed target configuration"

if HOME="$TEST_HOME" "$MCPCTL" interactive --store "$STORE" \
  </dev/null >"$TEST_ROOT/interactive-eof.out" 2>&1; then
  fail "interactive mode accepted missing input"
fi
grep -q 'interactive input ended' "$TEST_ROOT/interactive-eof.out" ||
  fail "interactive EOF did not explain how to use explicit commands"

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
