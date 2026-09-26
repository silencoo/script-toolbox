#!/usr/bin/env bash
# No-network installation tests: all package managers/CLIs run as fixtures.
set -euo pipefail
AGENT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
FAKE_BIN="${TEST_ROOT}/bin"
FAKE_INSTALL_LOG="${TEST_ROOT}/install.log"
TEST_HOME="${TEST_ROOT}/home"
export FAKE_BIN FAKE_INSTALL_LOG
mkdir -p "$FAKE_BIN" "$TEST_HOME"
: > "$FAKE_INSTALL_LOG"
for utility in bash dirname chmod cat mkdir; do
  ln -s "$(command -v "$utility")" "${FAKE_BIN}/${utility}"
done
cat > "$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in -p) printf '22.23.3\n' ;; *) printf 'v22.23.3\n' ;; esac
EOF
cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = --version ]; then printf '10.9.9\n'; exit 0; fi
printf 'npm %s\n' "$*" >> "$FAKE_INSTALL_LOG"
[ "${FAKE_NPM_FAIL:-0}" = 0 ] || { printf 'fixture download failed\n' >&2; exit 42; }
case "$*" in
  'install -g @openai/codex') cli=codex ;;
  'install -g opencode-ai') cli=opencode ;;
  'install -g --ignore-scripts @earendil-works/pi-coding-agent') cli=pi ;;
  'install -g @anthropic-ai/claude-code') cli=claude ;;
  *) printf 'unexpected npm invocation\n' >&2; exit 90 ;;
esac
cat > "$FAKE_BIN/$cli" <<'CLI'
#!/usr/bin/env bash
[ "${FAKE_VERSION_FAILURE:-0}" = 0 ] || { printf 'fixture broken binary\n' >&2; exit 1; }
printf 'fixture-version\n'
CLI
chmod +x "$FAKE_BIN/$cli"
EOF
cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_INSTALL_LOG"
[ "$*" = '-fsSL https://claude.ai/install.sh' ] || exit 91
[ "${FAKE_CURL_FAIL:-0}" = 0 ] || exit 22
cat <<'INSTALLER'
cat > "$FAKE_BIN/claude" <<'CLI'
#!/usr/bin/env bash
printf 'fixture-version\n'
CLI
chmod +x "$FAKE_BIN/claude"
INSTALLER
EOF
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/npm" "$FAKE_BIN/curl"

run() {
  HOME="$TEST_HOME" CODEX_HOME="$TEST_HOME/other-codex" PATH="$FAKE_BIN" \
    AGENTCTL_AGENT_ROOT="$AGENT_ROOT" "$AGENT_ROOT/agentctl/agentctl" install "$@"
}
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

for cli in claude codex opencode pi; do
  run "$cli" > "$TEST_ROOT/preview"
  grep -q '\[preview\]' "$TEST_ROOT/preview" || fail "missing preview for $cli"
  run "$cli" --yes --dry-run >/dev/null
done
[ ! -s "$FAKE_INSTALL_LOG" ] || fail "preview downloaded a package"
[ -z "$(ls -A "$TEST_HOME")" ] || fail "preview created configuration"

# Deliberately invalid configuration and credential bytes must not be parsed or
# rewritten by an install-only operation, even without a Provider Store.
for relative in .claude/settings.json .claude/.credentials.json \
  other-codex/config.toml other-codex/auth.json .config/opencode/opencode.json \
  .pi/agent/settings.json .pi/agent/auth.json; do
  mkdir -p "$(dirname "$TEST_HOME/$relative")"
  printf 'untouched fixture: %s\n' "$relative" > "$TEST_HOME/$relative"
done
cp -R "$TEST_HOME" "$TEST_ROOT/before"
for cli in claude codex opencode pi; do
  run "$cli" --yes > "$TEST_ROOT/applied"
  [ -x "$FAKE_BIN/$cli" ] || fail "$cli was not installed"
  grep -q 'ready: fixture-version' "$TEST_ROOT/applied" || fail "$cli was not verified"
done
grep -q '^curl -fsSL https://claude.ai/install.sh$' "$FAKE_INSTALL_LOG" || fail "Claude native install missing"
grep -q '^npm install -g @openai/codex$' "$FAKE_INSTALL_LOG" || fail "Codex package mismatch"
grep -q '^npm install -g opencode-ai$' "$FAKE_INSTALL_LOG" || fail "OpenCode package mismatch"
grep -q '^npm install -g --ignore-scripts @earendil-works/pi-coding-agent$' "$FAKE_INSTALL_LOG" || fail "Pi package mismatch"
diff -r "$TEST_ROOT/before" "$TEST_HOME" || fail "install changed client configuration"

cp "$FAKE_INSTALL_LOG" "$TEST_ROOT/log-before"
for cli in claude-code codex open-code pi; do run "$cli" --yes >/dev/null; done
cmp "$TEST_ROOT/log-before" "$FAKE_INSTALL_LOG" || fail "existing CLIs were reinstalled"

rm "$FAKE_BIN/claude"
FAKE_CURL_FAIL=1 run claude --yes > "$TEST_ROOT/fallback" 2>&1
grep -q '^npm install -g @anthropic-ai/claude-code$' "$FAKE_INSTALL_LOG" || fail "Claude npm fallback missing"
rm "$FAKE_BIN/codex"
if FAKE_NPM_FAIL=1 run codex --yes > "$TEST_ROOT/failure" 2>&1; then fail "download failure reported success"; fi
grep -q 'fixture download failed' "$TEST_ROOT/failure" || fail "download error lost"
if FAKE_VERSION_FAILURE=1 run codex --yes > "$TEST_ROOT/broken" 2>&1; then fail "broken CLI reported success"; fi
grep -q 'version check failed' "$TEST_ROOT/broken" || fail "broken CLI not diagnosed"
diff -r "$TEST_ROOT/before" "$TEST_HOME" || fail "failed install changed client configuration"

cp "$FAKE_INSTALL_LOG" "$TEST_ROOT/log-before"
for invalid in unknown --key --provider; do
  if run "$invalid" --yes > "$TEST_ROOT/invalid" 2>&1; then fail "invalid install argument accepted"; fi
done
cmp "$TEST_ROOT/log-before" "$FAKE_INSTALL_LOG" || fail "invalid input triggered installation"
printf 'ok  : install-only previews, four clients, retries, idempotency, and configuration preservation\n'
