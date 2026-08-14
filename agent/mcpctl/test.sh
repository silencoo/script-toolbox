#!/usr/bin/env bash
# Isolated behavior tests for mcpctl. No network access or real user config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCPCTL="${SCRIPT_DIR}/mcpctl"
TEST_ROOT="$(mktemp -d)"
TEST_HOME="${TEST_ROOT}/home"
STORE="${TEST_ROOT}/store"
FAKE_BIN="${TEST_ROOT}/bin"

# The suite owns all configuration paths. Caller-provided XDG roots would make
# HOME-based assertions inspect a different location from the controller.
unset XDG_CONFIG_HOME XDG_STATE_HOME

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

profile_menu_index() {
  HOME="$TEST_HOME" "$MCPCTL" profile list --store "$STORE" |
    awk -v wanted="$1" '$1 == wanted { found = NR } END { print found }'
}

server_toggle_index() {
  jq -r --arg target "$1" '
    .servers
    | to_entries
    | map(select(
        (((.value.supported_targets // []) | length) == 0)
        or (((.value.supported_targets // []) | index($target)) != null)
      ))
    | sort_by(.value.category // "other", .key)
    | .[].key
  ' "$STORE/catalog.json" |
    awk -v wanted="$2" '$1 == wanted { found = NR } END { print found }'
}

supported_server_count() {
  jq -r --arg target "$1" '
    [
      .servers
      | to_entries[]
      | select(
          (((.value.supported_targets // []) | length) == 0)
          or (((.value.supported_targets // []) | index($target)) != null)
        )
    ]
    | length
  ' "$STORE/catalog.json"
}

mkdir -p "$TEST_HOME" "$FAKE_BIN"

HOME="$TEST_HOME" "$MCPCTL" init --store "$STORE" >/dev/null
[ -f "$STORE/catalog.json" ] || fail "init did not create catalog.json"
[ -f "$STORE/profiles/daily.json" ] || fail "init did not create profiles"
if HOME="$TEST_HOME" "$MCPCTL" init --store "$STORE" >/dev/null 2>&1; then
  fail "init overwrote an existing store"
fi

profile_list="$(HOME="$TEST_HOME" "$MCPCTL" profile list --store "$STORE")"
printf '%s' "$profile_list" | grep -q '^daily' ||
  fail "profile list omitted daily"
for expected_profile in \
  daily daily-search off reverse-headless reverse-mobile reverse-native \
  reverse-web reverse-windows; do
  printf '%s' "$profile_list" | grep -q "^${expected_profile}" ||
    fail "profile list omitted ${expected_profile}"
done
[ "$(printf '%s\n' "$profile_list" | grep -c .)" = 8 ] ||
  fail "starter profile list was not reduced to eight task profiles"

server_list="$(HOME="$TEST_HOME" "$MCPCTL" server list --store "$STORE")"
for expected_server in \
  fetch github playwright playwright-headless chrome-devtools-cloak \
  playwright-cloak js-reverse js-reverse-isolated js-reverse-cloak radare2 \
  gdb lldb ghidra ghidra-headless idalib frida jadx apktool cutter x64dbg \
  burp anything-analyzer keenable tavily-keyless tavily-api tavily-oauth; do
  printf '%s' "$server_list" | grep -q "^${expected_server}" ||
    fail "server list omitted ${expected_server}"
done

codex_server_json="$(HOME="$TEST_HOME" "$MCPCTL" server list --target codex --json --store "$STORE")"
claude_server_json="$(HOME="$TEST_HOME" "$MCPCTL" server list --target claude --json --store "$STORE")"
printf '%s' "$codex_server_json" | jq -e '
  type == "array"
  and any(.[]; .name == "computer-use" and .category == "browser")
  and all(.[]; has("command") | not)
' >/dev/null || fail "targeted JSON server list omitted safe Codex display metadata"
printf '%s' "$claude_server_json" | jq -e '
  type == "array"
  and (any(.[]; .name == "computer-use") | not)
' >/dev/null || fail "targeted JSON server list ignored supported_targets"

jq -e '
  .servers.keenable.url == "https://api.keenable.ai/mcp"
  and .servers.keenable.auth.required == false
  and .servers.keenable.auth.header == "X-API-Key"
  and .servers["tavily-keyless"].headers["X-Tavily-Access-Mode"] == "keyless"
  and .servers["tavily-api"].auth.header == "Authorization"
  and .servers["tavily-api"].auth.required == true
  and (.servers["tavily-oauth"].auth == null)
  and (
    [
      .servers["tavily-keyless"].variant_group,
      .servers["tavily-api"].variant_group,
      .servers["tavily-oauth"].variant_group
    ]
    | unique
    | . == ["tavily-auth"]
  )
' "$STORE/catalog.json" >/dev/null ||
  fail "bundled search providers do not expose the expected auth modes"

# Effective HTTP definitions enforce transport and credential placement even
# when a catalog was edited without going through the importer.
UNSAFE_URL_STORE="${TEST_ROOT}/unsafe-url-store"
cp -R "$STORE" "$UNSAFE_URL_STORE"
jq '.servers.context7.url = "http://mcp.example.test/mcp"' \
  "$STORE/catalog.json" > "$UNSAFE_URL_STORE/catalog.json"
if HOME="$TEST_HOME" "$MCPCTL" plan --target codex --profile daily \
  --store "$UNSAFE_URL_STORE" >/dev/null 2>&1; then
  fail "plan accepted cleartext non-loopback HTTP"
fi
jq '.servers.context7.url = "https://mcp.example.test/mcp?key=plaintext"' \
  "$STORE/catalog.json" > "$UNSAFE_URL_STORE/catalog.json"
if HOME="$TEST_HOME" "$MCPCTL" plan --target codex --profile daily \
  --store "$UNSAFE_URL_STORE" >/dev/null 2>&1; then
  fail "plan accepted a credential query parameter"
fi
jq '.servers.context7.url = "http://127.0.0.1:8787/mcp"' \
  "$STORE/catalog.json" > "$UNSAFE_URL_STORE/catalog.json"
HOME="$TEST_HOME" "$MCPCTL" plan --target codex --profile daily \
  --store "$UNSAFE_URL_STORE" >/dev/null ||
  fail "plan rejected a loopback HTTP endpoint"

jq -e '
  .servers.gdb.command[1:] == [
    "uv", "gdb", "gdb-mcp==1.0.1", "gdb-mcp", "--"
  ]
  and .servers.gdb.host.install.type == "uv"
  and .servers.frida.command[1:] == [
    "npm", "frida", "frida-mcp@1.1.0", "frida-mcp", "--"
  ]
  and .servers.frida.host.install.type == "npm"
  and .servers["playwright-headless"].command == [
    "@mcpctl/adapters/mcp-package", "npm", "playwright-headless",
    "@playwright/mcp@0.0.78", "playwright-mcp", "--",
    "--headless", "--isolated"
  ]
  and .servers.ghidra.command[1] == "ghidra"
  and .servers["ghidra-headless"].command[1] == "ghidra-headless"
  and .servers.cutter.command[1] == "cutter"
  and .servers.x64dbg.command[1] == "x64dbg"
  and .servers.burp.command[1] == "burp"
  and .servers["anything-analyzer"].url == "http://127.0.0.1:23816/mcp"
  and .servers["anything-analyzer"].auth.required == true
  and .servers["anything-analyzer"].auth.env == "ANYTHING_ANALYZER_MCP_TOKEN"
  and .servers["anything-analyzer"].host.lifecycle == "external"
  and (
    [
      .servers["js-reverse"].variant_group,
      .servers["js-reverse-isolated"].variant_group,
      .servers["js-reverse-cloak"].variant_group
    ]
    | unique
    | . == ["js-reverse-runtime"]
  )
' "$STORE/catalog.json" >/dev/null ||
  fail "bundled reverse servers do not use the pinned commands and adapters"

# A store created by an older checkout can safely receive newly bundled
# entries. Existing same-name server definitions and profiles remain personal.
LEGACY_STORE="${TEST_ROOT}/legacy-store"
mkdir -p "$LEGACY_STORE/profiles"
jq '
  del(.servers.github, .servers.lldb)
  | del(.servers["chrome-devtools"].host, .servers.gdb.host)
  | .servers["chrome-devtools"].command =
      ["npx", "-y", "chrome-devtools-mcp@1.6.0"]
  | .servers.gdb.command = ["uvx", "gdb-mcp==1.0.1"]
  | .servers.context7.description = "Personal Context7 definition"
' "$STORE/catalog.json" > "$LEGACY_STORE/catalog.json"
jq '
  .description = "Personal daily profile"
' "$STORE/profiles/daily.json" > "$LEGACY_STORE/profiles/daily.json"
HOME="$TEST_HOME" "$MCPCTL" sync --store "$LEGACY_STORE" \
  >"$TEST_ROOT/sync.out"
jq -e '
  .servers.github != null
  and .servers.lldb != null
  and .servers.context7.description == "Personal Context7 definition"
  and .servers["chrome-devtools"].host.install.type == "npm"
  and .servers["chrome-devtools"].command[0] ==
    "@mcpctl/adapters/mcp-package"
  and .servers.gdb.host.install.type == "uv"
  and .servers.gdb.command[0] == "@mcpctl/adapters/mcp-package"
' "$LEGACY_STORE/catalog.json" >/dev/null ||
  fail "sync did not merge missing servers or migrate recognized host launchers"
jq -e '
  .description == "Personal daily profile"
' "$LEGACY_STORE/profiles/daily.json" >/dev/null ||
  fail "sync overwrote an existing same-name profile"
[ -f "$LEGACY_STORE/profiles/daily-search.json" ] ||
  fail "sync did not add missing bundled profiles"
grep -q 'Existing same-name servers and profiles were preserved' \
  "$TEST_ROOT/sync.out" ||
  fail "sync did not explain its preservation behavior"

# The same safe update is directly available from the guided menu and is
# idempotent after the first merge.
printf '7\n' |
  HOME="$TEST_HOME" "$MCPCTL" interactive --store "$LEGACY_STORE" \
    >"$TEST_ROOT/interactive-sync.out" 2>&1 ||
  fail "interactive starter sync failed"
grep -q 'already contains every bundled server and profile' \
  "$TEST_ROOT/interactive-sync.out" ||
  fail "interactive starter sync was not idempotent"

ghidra_definition="$(
  HOME="$TEST_HOME" "$MCPCTL" server show ghidra \
    --target codex --store "$STORE"
)"
printf '%s' "$ghidra_definition" |
  jq -e --arg adapter "$SCRIPT_DIR/adapters/mcp-host" \
    '.command[0] == $adapter and .command[1] == "ghidra"' >/dev/null ||
  fail "target server view did not expand the repository adapter path"

idalib_definition="$(
  HOME="$TEST_HOME" "$MCPCTL" server show idalib \
    --target codex --store "$STORE"
)"
printf '%s' "$idalib_definition" |
  jq -e '.command == ["idalib-mcp", "--stdio"]' >/dev/null ||
  fail "IDA headless server did not use the current stdio command"

# Browser host adapters preserve the pinned MCP package and pass a configurable
# local CloakBrowser CDP endpoint without writing human diagnostics to stdout.
printf '%s\n' \
  '#!/usr/bin/env sh' \
  ': > "$MCP_ADAPTER_CAPTURE"' \
  'printf "%s\n" "$@" > "$MCP_ADAPTER_CAPTURE"' \
  > "$FAKE_BIN/npx"
chmod +x "$FAKE_BIN/npx"
MCP_ADAPTER_CAPTURE="$TEST_ROOT/cloak-devtools.args" \
  CLOAKBROWSER_CDP_ENDPOINT="http://127.0.0.1:9333" \
  PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-host" \
    cloak-devtools chrome-devtools-mcp@test >/dev/null
diff -u - "$TEST_ROOT/cloak-devtools.args" <<'EOF' >/dev/null ||
-y
chrome-devtools-mcp@test
--browser-url=http://127.0.0.1:9333
--no-usage-statistics
--no-performance-crux
EOF
  fail "CloakBrowser DevTools adapter arguments are incorrect"

MCP_ADAPTER_CAPTURE="$TEST_ROOT/cloak-playwright.args" \
  CLOAKBROWSER_CDP_ENDPOINT="http://127.0.0.1:9444" \
  PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-host" \
    cloak-playwright @playwright/mcp@test >/dev/null
diff -u - "$TEST_ROOT/cloak-playwright.args" <<'EOF' >/dev/null ||
-y
@playwright/mcp@test
--cdp-endpoint
http://127.0.0.1:9444
EOF
  fail "CloakBrowser Playwright adapter arguments are incorrect"

mkdir -p "$TEST_ROOT/js-reverse-artifacts"
MCP_ADAPTER_CAPTURE="$TEST_ROOT/js-reverse.args" \
  JS_REVERSE_ALLOWED_ROOT="$TEST_ROOT/js-reverse-artifacts" \
  PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-host" \
    js-reverse js-reverse-mcp@test --isolated >/dev/null
diff -u - "$TEST_ROOT/js-reverse.args" <<EOF >/dev/null ||
-y
js-reverse-mcp@test
--allowedRoots
$TEST_ROOT/js-reverse-artifacts
--isolated
EOF
  fail "JavaScript reverse adapter arguments are incorrect"

if MCP_ADAPTER_CAPTURE="$TEST_ROOT/js-reverse-relative.args" \
  JS_REVERSE_ALLOWED_ROOT="relative/path" \
  PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-host" js-reverse \
    >"$TEST_ROOT/js-reverse-relative.out" \
    2>"$TEST_ROOT/js-reverse-relative.err"; then
  fail "JavaScript reverse adapter accepted a relative allowed root"
fi
[ ! -s "$TEST_ROOT/js-reverse-relative.out" ] ||
  fail "JavaScript reverse adapter wrote diagnostics to MCP stdout"

if PATH="$FAKE_BIN:/usr/bin:/bin" \
  "$SCRIPT_DIR/adapters/mcp-host" ghidra \
    >"$TEST_ROOT/ghidra-adapter.out" \
    2>"$TEST_ROOT/ghidra-adapter.err"; then
  fail "Ghidra adapter accepted a missing bridge path"
fi
[ ! -s "$TEST_ROOT/ghidra-adapter.out" ] ||
  fail "Ghidra adapter wrote diagnostics to MCP stdout"
grep -q 'set GHIDRA_MCP_BRIDGE' "$TEST_ROOT/ghidra-adapter.err" ||
  fail "Ghidra adapter missing-path error is not actionable"

mkdir -p "$TEST_ROOT/ghidra-install" "$TEST_ROOT/ghidra-projects"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  ': > "$MCP_ADAPTER_CAPTURE"' \
  'printf "%s\n" "$@" > "$MCP_ADAPTER_CAPTURE"' \
  > "$FAKE_BIN/uvx"
chmod +x "$FAKE_BIN/uvx"
MCP_ADAPTER_CAPTURE="$TEST_ROOT/ghidra-headless.args" \
  GHIDRA_INSTALL_DIR="$TEST_ROOT/ghidra-install" \
  GHIDRA_MCP_PROJECT_PATH="$TEST_ROOT/ghidra-projects" \
  PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-host" ghidra-headless >/dev/null
diff -u - "$TEST_ROOT/ghidra-headless.args" <<EOF >/dev/null ||
--from
pyghidra-mcp==0.2.3
pyghidra-mcp
--transport
stdio
--project-path
$TEST_ROOT/ghidra-projects
EOF
  fail "Headless Ghidra adapter arguments are incorrect"

for missing_adapter in cutter x64dbg; do
  if PATH="$FAKE_BIN:$PATH" \
    "$SCRIPT_DIR/adapters/mcp-host" "$missing_adapter" \
      >"$TEST_ROOT/${missing_adapter}-adapter.out" \
      2>"$TEST_ROOT/${missing_adapter}-adapter.err"; then
    fail "$missing_adapter adapter accepted missing host configuration"
  fi
  [ ! -s "$TEST_ROOT/${missing_adapter}-adapter.out" ] ||
    fail "$missing_adapter adapter wrote diagnostics to MCP stdout"
  grep -q 'set .*MCP' "$TEST_ROOT/${missing_adapter}-adapter.err" ||
    fail "$missing_adapter adapter missing-configuration error is not actionable"
done

# Package-backed MCPs can be installed into an isolated, mcpctl-owned root.
# The adapter prefers that executable, while uninstall moves only the owned
# directory into recoverable trash.
HOST_ROOT="${TEST_ROOT}/mcp-hosts"
HOST_TRASH="${TEST_ROOT}/mcp-host-trash"
FAKE_PACKAGE_ENTRY="${TEST_ROOT}/fake-owned-mcp"
cat > "$FAKE_PACKAGE_ENTRY" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' owned > "$MCP_PACKAGE_CAPTURE"
printf '%s\n' "$@" >> "$MCP_PACKAGE_CAPTURE"
EOF
chmod +x "$FAKE_PACKAGE_ENTRY"
cat > "$FAKE_BIN/npm" <<'EOF'
#!/usr/bin/env sh
set -eu
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then
    prefix="$2"
    shift 2
  else
    shift
  fi
done
[ -n "$prefix" ]
mkdir -p "$prefix/node_modules/.bin"
cp "$MCP_FAKE_ENTRY" "$prefix/node_modules/.bin/chrome-devtools-mcp"
chmod +x "$prefix/node_modules/.bin/chrome-devtools-mcp"
EOF
chmod +x "$FAKE_BIN/npm"

HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  MCPCTL_HOST_TRASH="$HOST_TRASH" PATH="$FAKE_BIN:$PATH" \
  "$MCPCTL" server install chrome-devtools --dry-run --store "$STORE" \
    >"$TEST_ROOT/host-install-plan.out"
[ ! -e "$HOST_ROOT/chrome-devtools" ] ||
  fail "server install --dry-run created an installation"

HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  MCPCTL_HOST_TRASH="$HOST_TRASH" MCP_FAKE_ENTRY="$FAKE_PACKAGE_ENTRY" \
  PATH="$FAKE_BIN:$PATH" \
  "$MCPCTL" server install chrome-devtools --store "$STORE" \
    >"$TEST_ROOT/host-install.out"
jq -e '
  .managed_by == "agent/mcpctl"
  and .server == "chrome-devtools"
  and .manager == "npm"
  and .package == "chrome-devtools-mcp@1.6.0"
' "$HOST_ROOT/chrome-devtools/manifest.json" >/dev/null ||
  fail "isolated package installation omitted its ownership manifest"
[ "$(mode_of "$HOST_ROOT/chrome-devtools/manifest.json")" = "600" ] ||
  fail "isolated package manifest mode is not 0600"

MCP_PACKAGE_CAPTURE="$TEST_ROOT/owned-package.args" \
  MCPCTL_HOST_ROOT="$HOST_ROOT" PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-package" npm chrome-devtools \
    chrome-devtools-mcp@1.6.0 chrome-devtools-mcp -- --headless
diff -u - "$TEST_ROOT/owned-package.args" <<'EOF' >/dev/null ||
owned
--headless
EOF
  fail "package adapter did not prefer the isolated executable"

host_status="$(
  HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" PATH="$FAKE_BIN:$PATH" \
    "$MCPCTL" server status chrome-devtools --store "$STORE"
)"
printf '%s' "$host_status" | grep -q $'^chrome-devtools\tclient\towned\t' ||
  fail "server status did not report the isolated package"

HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  MCPCTL_HOST_TRASH="$HOST_TRASH" \
  "$MCPCTL" server uninstall chrome-devtools --store "$STORE" \
    >"$TEST_ROOT/host-uninstall.out"
[ ! -e "$HOST_ROOT/chrome-devtools" ] ||
  fail "server uninstall left the owned installation active"
find "$HOST_TRASH" -name manifest.json -type f |
  grep -q . || fail "server uninstall did not preserve a recoverable copy"

# Private wheels live in the portable Store rather than an ephemeral source
# checkout. The catalog keeps a logical Store reference and a pinned digest;
# rendering resolves it for this machine, while install verifies it first.
mkdir -p "$STORE/artifacts"
ARTIFACT_NAME="private_mcp-1.0.0-py3-none-any.whl"
printf '%s\n' portable-wheel > "$STORE/artifacts/$ARTIFACT_NAME"
ARTIFACT_SHA="$(shasum -a 256 "$STORE/artifacts/$ARTIFACT_NAME" | awk '{print $1}')"
jq --arg artifact "$ARTIFACT_NAME" --arg sha "$ARTIFACT_SHA" '
  .servers["private-wheel"] = {
    category: "test",
    description: "Private portable wheel",
    transport: "stdio",
    command: [
      "@mcpctl/adapters/mcp-package", "uv", "private-wheel",
      ("@mcpctl-store/artifacts/" + $artifact), "private-mcp",
      "with:mcp<2", ("sha256:" + $sha), "--"
    ],
    host: {
      lifecycle: "client",
      install: {
        type: "uv",
        package: ("@mcpctl-store/artifacts/" + $artifact),
        bin: "private-mcp",
        sha256: $sha,
        with: ["mcp<2"]
      },
      platforms: ["darwin", "linux", "windows"]
    },
    supported_targets: ["claude", "codex", "opencode"]
  }
' "$STORE/catalog.json" > "$TEST_ROOT/catalog-with-artifact.json"
mv "$TEST_ROOT/catalog-with-artifact.json" "$STORE/catalog.json"
HOME="$TEST_HOME" "$MCPCTL" server show private-wheel --target codex \
  --store "$STORE" |
  jq -e --arg path "$STORE/artifacts/$ARTIFACT_NAME" \
    '.command[3] == $path' >/dev/null ||
  fail "portable artifact reference was not resolved for the active Store"
cp "$STORE/artifacts/$ARTIFACT_NAME" "$TEST_ROOT/private-wheel.good"
printf '%s\n' tampered > "$STORE/artifacts/$ARTIFACT_NAME"
if HOME="$TEST_HOME" "$MCPCTL" server doctor private-wheel --store "$STORE" \
  >"$TEST_ROOT/private-wheel-doctor.out" 2>&1; then
  fail "server doctor accepted a portable artifact with the wrong digest"
fi
grep -q 'artifact or its SHA-256 is invalid' "$TEST_ROOT/private-wheel-doctor.out" ||
  fail "server doctor did not explain the portable artifact failure"
mv "$TEST_ROOT/private-wheel.good" "$STORE/artifacts/$ARTIFACT_NAME"
cat > "$FAKE_BIN/uv" <<'EOF'
#!/usr/bin/env sh
set -eu
mkdir -p "$UV_TOOL_BIN_DIR" "$UV_TOOL_DIR/private-wheel/bin"
cp "$MCP_FAKE_ENTRY" "$UV_TOOL_DIR/private-wheel/bin/private-mcp"
chmod +x "$UV_TOOL_DIR/private-wheel/bin/private-mcp"
# Match uv's real behavior: its exposed executables are absolute symlinks into
# UV_TOOL_DIR. mcpctl must make them relocatable before renaming the staging
# directory into its final owned location.
ln -s "$UV_TOOL_DIR/private-wheel/bin/private-mcp" \
  "$UV_TOOL_BIN_DIR/private-mcp"
EOF
chmod +x "$FAKE_BIN/uv"
HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  MCP_FAKE_ENTRY="$FAKE_PACKAGE_ENTRY" PATH="$FAKE_BIN:$PATH" \
  "$MCPCTL" server install private-wheel --store "$STORE" >/dev/null
jq -e --arg artifact "$ARTIFACT_NAME" '
  .manager == "uv"
  and .package == ("@mcpctl-store/artifacts/" + $artifact)
  and .binary == "private-mcp"
  and (.sha256 | length) == 64
  and .with == ["mcp<2"]
' "$HOST_ROOT/private-wheel/manifest.json" >/dev/null ||
  fail "portable wheel installation lost its logical Store reference"
[ "$(readlink "$HOST_ROOT/private-wheel/bin/private-mcp")" = \
  "../tools/private-wheel/bin/private-mcp" ] ||
  fail "uv package installation retained a staging-directory symlink"
MCP_PACKAGE_CAPTURE="$TEST_ROOT/owned-private-wheel.args" \
  MCPCTL_HOST_ROOT="$HOST_ROOT" PATH="$FAKE_BIN:$PATH" \
  "$SCRIPT_DIR/adapters/mcp-package" uv private-wheel \
    "$STORE/artifacts/$ARTIFACT_NAME" private-mcp \
    "with:mcp<2" "sha256:$ARTIFACT_SHA" -- --stdio
diff -u - "$TEST_ROOT/owned-private-wheel.args" <<'EOF' >/dev/null ||
owned
--stdio
EOF
  fail "package adapter did not match the pinned portable ownership manifest"

mkdir -p "$HOST_ROOT/frida"
printf '%s\n' user-owned > "$HOST_ROOT/frida/keep.txt"
if HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  MCPCTL_HOST_TRASH="$HOST_TRASH" \
  "$MCPCTL" server uninstall frida --store "$STORE" \
    >"$TEST_ROOT/unowned-uninstall.out" 2>&1; then
  fail "server uninstall removed an unowned directory"
fi
[ -f "$HOST_ROOT/frida/keep.txt" ] ||
  fail "server uninstall damaged an unowned directory"
if HOME="$TEST_HOME" MCPCTL_HOST_ROOT="$HOST_ROOT" \
  "$MCPCTL" server install idalib --store "$STORE" \
    >"$TEST_ROOT/manual-install.out" 2>&1; then
  fail "server install pretended to install licensed IDA software"
fi
grep -q 'cannot install the host application' "$TEST_ROOT/manual-install.out" ||
  fail "manual host installation failure was not actionable"

# Enable/disable edits the exact managed selection for one client. Enabling a
# variant replaces the active sibling, and dry-run remains read-only.
LIFECYCLE_HOME="${TEST_ROOT}/lifecycle-home"
mkdir -p "$LIFECYCLE_HOME"
HOME="$LIFECYCLE_HOME" "$MCPCTL" apply --target claude --profile off \
  --store "$STORE" >/dev/null

# Config and applied-state updates form one locked transaction. A state-path
# failure discovered before commit, or a state write failure after the config
# swap, must leave the original config intact.
TRANSACTION_HOME="${TEST_ROOT}/transaction-home"
TRANSACTION_CONFIG="${TRANSACTION_HOME}/claude.json"
TRANSACTION_STATE="${TRANSACTION_HOME}/state/applied.json"
TRANSACTION_BIN="${TEST_ROOT}/transaction-bin"
REAL_MV="$(command -v mv)"
mkdir -p "$TRANSACTION_HOME" "$TRANSACTION_BIN"
printf '%s\n' '{"preserved":true}' > "$TRANSACTION_CONFIG"
cp "$TRANSACTION_CONFIG" "$TEST_ROOT/transaction-config.before"
printf '%s\n' '#!/usr/bin/env sh' \
  'if [ "${2:-}" = "${MCPCTL_FAIL_MV_TARGET:-}" ]; then exit 73; fi' \
  "exec '$REAL_MV' \"\$@\"" > "$TRANSACTION_BIN/mv"
chmod +x "$TRANSACTION_BIN/mv"
if HOME="$TRANSACTION_HOME" \
  MCPCTL_CLAUDE_CONFIG="$TRANSACTION_CONFIG" \
  MCPCTL_STATE_FILE="$TRANSACTION_STATE" \
  MCPCTL_FAIL_MV_TARGET="$TRANSACTION_STATE" \
  PATH="$TRANSACTION_BIN:$PATH" \
    "$MCPCTL" apply --target claude --profile off --store "$STORE" \
      >"$TEST_ROOT/transaction-failure.out" 2>&1; then
  fail "apply succeeded after its state commit was forced to fail"
fi
cmp -s "$TEST_ROOT/transaction-config.before" "$TRANSACTION_CONFIG" ||
  fail "failed state commit did not roll back target config"
[ ! -e "$TRANSACTION_STATE" ] ||
  fail "failed state commit left a partial state file"
[ ! -e "${TRANSACTION_STATE}.apply.lock" ] ||
  fail "failed state commit left its apply lock behind"

printf '%s\n' blocker > "$TRANSACTION_HOME/state-blocker"
if HOME="$TRANSACTION_HOME" \
  MCPCTL_CLAUDE_CONFIG="$TRANSACTION_CONFIG" \
  MCPCTL_STATE_FILE="$TRANSACTION_HOME/state-blocker/applied.json" \
    "$MCPCTL" apply --target claude --profile off --store "$STORE" \
      >"$TEST_ROOT/transaction-parent-failure.out" 2>&1; then
  fail "apply accepted a non-directory state parent"
fi
cmp -s "$TEST_ROOT/transaction-config.before" "$TRANSACTION_CONFIG" ||
  fail "invalid state parent changed target config"

HOME="$LIFECYCLE_HOME" "$MCPCTL" server enable playwright \
  --target claude --store "$STORE" >/dev/null
cp "$LIFECYCLE_HOME/.claude.json" "$TEST_ROOT/lifecycle.before"
HOME="$LIFECYCLE_HOME" "$MCPCTL" server enable chrome-devtools \
  --target claude --store "$STORE" --dry-run >/dev/null
cmp -s "$TEST_ROOT/lifecycle.before" "$LIFECYCLE_HOME/.claude.json" ||
  fail "server enable --dry-run changed the target config"
HOME="$LIFECYCLE_HOME" "$MCPCTL" server enable playwright-headless \
  --target claude --store "$STORE" >/dev/null
jq -e '
  .targets.claude.profile == "custom"
  and .targets.claude.selection_mode == "manual"
  and .targets.claude.base_profile == "off"
  and .targets.claude.servers == ["playwright-headless"]
' "$LIFECYCLE_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "server enable did not persist the exact custom selection"
jq -e '
  .mcpServers["playwright-headless"] != null
  and .mcpServers.playwright == null
' "$LIFECYCLE_HOME/.claude.json" >/dev/null ||
  fail "server enable did not switch mutually exclusive variants"
lifecycle_status="$(
  HOME="$LIFECYCLE_HOME" "$MCPCTL" server status playwright-headless \
    --store "$STORE"
)"
printf '%s' "$lifecycle_status" | grep -q $'\tclaude$' ||
  fail "server status omitted the enabled client"
HOME="$LIFECYCLE_HOME" "$MCPCTL" server disable playwright-headless \
  --target claude --store "$STORE" >/dev/null
jq -e '((.mcpServers // {}) | length) == 0' \
  "$LIFECYCLE_HOME/.claude.json" >/dev/null ||
  fail "server disable left a managed server enabled"
current_custom="$(
  HOME="$LIFECYCLE_HOME" "$MCPCTL" current --target claude --store "$STORE"
)"
printf '%s' "$current_custom" | grep -q '^Profile: custom (based on off)$' ||
  fail "current did not explain the custom selection base"

doctor_json="$(
  HOME="$LIFECYCLE_HOME" "$MCPCTL" server doctor --all --json --store "$STORE"
)"
printf '%s' "$doctor_json" | jq -e '
  .schema == 1
  and (.platform | type == "string")
  and (.servers | type == "array")
  and all(.servers[];
    (.name | type == "string")
    and (.ready | type == "boolean")
    and (.issues | type == "array")
  )
' >/dev/null || fail "server doctor --json did not emit bounded readiness metadata"

HOME="$LIFECYCLE_HOME" "$MCPCTL" server preflight playwright \
  --target claude --json --store "$STORE" |
  jq -e '.ready == true and .configuration == "renderable"' >/dev/null ||
  fail "server preflight rejected a renderable Secret-free server"
if HOME="$LIFECYCLE_HOME" "$MCPCTL" server preflight github \
  --target claude --json --store "$STORE" \
  >"$TEST_ROOT/preflight-missing.out" 2>&1; then
  fail "server preflight accepted a missing required Secret"
fi
grep -q "no secret 'github_mcp_pat'" "$TEST_ROOT/preflight-missing.out" ||
  fail "server preflight missing-Secret error was not actionable"

# Batch changes are rendered and written once. Saving turns the exact manual
# target selection into a portable named Profile, while --force updates only
# that target override and preserves other clients.
batch_selection_json="$(
  HOME="$LIFECYCLE_HOME" "$MCPCTL" server set --target claude \
    --enable playwright --enable js-reverse --store "$STORE" --json
)"
printf '%s' "$batch_selection_json" | jq -e '
  .target == "claude"
  and .selection_mode == "manual"
  and .profile == "custom"
  and .healthy == true
  and (.servers | sort) == ["js-reverse", "playwright"]
' >/dev/null || fail "server set --json did not return its final local state"
jq -e '
  .targets.claude.selection_mode == "manual"
  and (.targets.claude.servers | sort) == ["js-reverse", "playwright"]
' "$LIFECYCLE_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "server set did not persist one exact batch selection"
HOME="$LIFECYCLE_HOME" "$MCPCTL" profile save daily-test --target claude \
  --store "$STORE" >/dev/null
jq -e '
  .name == "daily-test"
  and .extends == ["off"]
  and (.target_overrides.claude.enable | sort) == ["js-reverse", "playwright"]
' "$STORE/profiles/daily-test.json" >/dev/null ||
  fail "profile save did not capture the current target selection"
jq '.target_overrides.codex = {enable:["fetch"],disable:[]}' \
  "$STORE/profiles/daily-test.json" > "$TEST_ROOT/daily-test.with-codex.json"
mv "$TEST_ROOT/daily-test.with-codex.json" "$STORE/profiles/daily-test.json"
chmod 600 "$STORE/profiles/daily-test.json"
HOME="$LIFECYCLE_HOME" "$MCPCTL" server set --target claude \
  --disable playwright --store "$STORE" >/dev/null
HOME="$LIFECYCLE_HOME" "$MCPCTL" profile save daily-test --target claude \
  --force --store "$STORE" >/dev/null
jq -e '
  .target_overrides.codex.enable == ["fetch"]
  and .target_overrides.claude.enable == ["js-reverse"]
' "$STORE/profiles/daily-test.json" >/dev/null ||
  fail "profile save --force did not preserve another target override"
HOME="$LIFECYCLE_HOME" "$MCPCTL" apply --target claude \
  --profile daily-test --store "$STORE" >/dev/null
jq -e '
  .targets.claude.profile == "daily-test"
  and ((.targets.claude.selection_mode // "profile") == "profile")
' "$LIFECYCLE_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "saved MCP Profile could not be reapplied as a named selection"

# No arguments open the guided menu. Listing is read-only and works with the
# same store used by explicit commands.
interactive_list="$(
  printf '4\n' |
    HOME="$TEST_HOME" MCPCTL_STORE="$STORE" "$MCPCTL" 2>/dev/null
)"
printf '%s' "$interactive_list" | grep -q '^daily' ||
  fail "no-argument interactive menu did not list profiles"

# A missing store can be initialized from the menu before choosing another
# action.
INTERACTIVE_INIT_STORE="${TEST_ROOT}/interactive-init-store"
INTERACTIVE_INIT_HOME="${TEST_ROOT}/interactive-init-home"
mkdir -p "$INTERACTIVE_INIT_HOME"
printf '\n9\n' |
  HOME="$INTERACTIVE_INIT_HOME" \
    "$MCPCTL" interactive --store "$INTERACTIVE_INIT_STORE" \
      >"$TEST_ROOT/interactive-init.out" 2>&1 ||
  fail "interactive menu did not initialize a missing store"
[ -f "$INTERACTIVE_INIT_STORE/catalog.json" ] ||
  fail "interactive initialization omitted catalog.json"

# Before initialization, the guide can choose and remember a different store
# instead of creating the default path.
INTERACTIVE_CHOSEN_HOME="${TEST_ROOT}/interactive-chosen-home"
INTERACTIVE_CHOSEN_STORE="${TEST_ROOT}/interactive-chosen-store"
INTERACTIVE_UNUSED_STORE="${TEST_ROOT}/interactive-unused-store"
INTERACTIVE_CHOSEN_PREFERENCES="${INTERACTIVE_CHOSEN_HOME}/.config/mcpctl/preferences.json"
mkdir -p "$INTERACTIVE_CHOSEN_HOME"
printf '3\n%s\n1\n9\n' "$INTERACTIVE_CHOSEN_STORE" |
  HOME="$INTERACTIVE_CHOSEN_HOME" \
    MCPCTL_PREFERENCES="$INTERACTIVE_CHOSEN_PREFERENCES" \
    "$MCPCTL" interactive --store "$INTERACTIVE_UNUSED_STORE" \
      >"$TEST_ROOT/interactive-chosen.out" 2>&1 ||
  fail "interactive store selection before initialization failed"
[ -f "$INTERACTIVE_CHOSEN_STORE/catalog.json" ] ||
  fail "interactive store selection did not initialize the chosen path"
[ ! -e "$INTERACTIVE_UNUSED_STORE" ] ||
  fail "interactive store selection initialized the abandoned path"
jq -e --arg store "$INTERACTIVE_CHOSEN_STORE" \
  '.store == $store' \
  "$INTERACTIVE_CHOSEN_PREFERENCES" >/dev/null ||
  fail "interactive store selection was not remembered"

# Applying from the menu always runs a visible plan first and asks for a
# separate confirmation. The reverse profile needs no required secret.
INTERACTIVE_APPLY_HOME="${TEST_ROOT}/interactive-apply-home"
mkdir -p "$INTERACTIVE_APPLY_HOME"
REVERSE_PROFILE_INDEX="$(profile_menu_index reverse-native)"
printf '1\n2\n%s\ny\n' "$REVERSE_PROFILE_INDEX" |
  HOME="$INTERACTIVE_APPLY_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-apply.out" 2>&1 ||
  fail "interactive profile apply failed"
grep -q '^Target:  codex$' "$TEST_ROOT/interactive-apply.out" ||
  fail "interactive apply did not print its plan"
grep -qF '# >>> agent/mcpctl >>>' \
  "$INTERACTIVE_APPLY_HOME/.codex/config.toml" ||
  fail "interactive apply did not write the owned Codex block"
jq -e '.targets.codex.profile == "reverse-native"' \
  "$INTERACTIVE_APPLY_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "interactive apply did not update managed state"

# Declining the final confirmation leaves target configuration untouched.
INTERACTIVE_CANCEL_HOME="${TEST_ROOT}/interactive-cancel-home"
mkdir -p "$INTERACTIVE_CANCEL_HOME"
printf '1\n2\n%s\nn\n' "$REVERSE_PROFILE_INDEX" |
  HOME="$INTERACTIVE_CANCEL_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-cancel.out" 2>&1 ||
  fail "interactive cancellation returned an error"
[ ! -e "$INTERACTIVE_CANCEL_HOME/.codex/config.toml" ] ||
  fail "interactive cancellation changed target configuration"

# A profile with a missing required Secret offers configuration choices and a
# cancellation path without touching the target.
INTERACTIVE_MISSING_HOME="${TEST_ROOT}/interactive-missing-home"
mkdir -p "$INTERACTIVE_MISSING_HOME"
DAILY_SEARCH_PROFILE_INDEX="$(profile_menu_index daily-search)"
printf '1\n2\n%s\n3\n' "$DAILY_SEARCH_PROFILE_INDEX" |
  HOME="$INTERACTIVE_MISSING_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-missing.out" 2>&1 ||
  fail "interactive missing-secret cancellation returned an error"
grep -q 'required Secrets remain missing' "$TEST_ROOT/interactive-missing.out" ||
  fail "interactive missing-secret cancellation was not actionable"
[ ! -e "$INTERACTIVE_MISSING_HOME/.codex/config.toml" ] ||
  fail "interactive missing-secret failure changed target configuration"

# Missing Secrets can be entered without echo for the current process. The
# value is inherited by apply but is never printed by the guide or plan.
INTERACTIVE_SESSION_HOME="${TEST_ROOT}/interactive-session-home"
mkdir -p "$INTERACTIVE_SESSION_HOME"
HOME="$TEST_HOME" "$MCPCTL" profile create github-test \
  --extends daily --enable github --description "GitHub test" \
  --store "$STORE" >/dev/null
GITHUB_PROFILE_INDEX="$(profile_menu_index github-test)"
printf '1\n2\n%s\n1\nsession-github-token\ny\n' "$GITHUB_PROFILE_INDEX" |
  HOME="$INTERACTIVE_SESSION_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-session.out" 2>&1 ||
  fail "interactive session Secret entry failed"
! grep -q 'session-github-token' "$TEST_ROOT/interactive-session.out" ||
  fail "interactive guide printed a session Secret"
grep -q 'Bearer session-github-token' \
  "$INTERACTIVE_SESSION_HOME/.codex/config.toml" ||
  fail "interactive session Secret did not reach the target renderer"

# The configuration center persists only paths, with mode 0600. Subsequent
# explicit commands use those preferences without receiving --store flags.
INTERACTIVE_CONFIG_HOME="${TEST_ROOT}/interactive-config-home"
INTERACTIVE_CONFIG_SECRETS="${INTERACTIVE_CONFIG_HOME}/custom-secrets.sops.json"
INTERACTIVE_CONFIG_SECRETS_INPUT="~/custom-secrets.sops.json"
INTERACTIVE_CONFIG_REMOTE="${TEST_ROOT}/private/remote-capability.json"
mkdir -p "$INTERACTIVE_CONFIG_HOME"
printf '8\n4\n%s\n6\n3\n%s\n4\n7\n9\n' \
  "$INTERACTIVE_CONFIG_SECRETS_INPUT" "$INTERACTIVE_CONFIG_REMOTE" |
  HOME="$INTERACTIVE_CONFIG_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-config.out" 2>&1 ||
  fail "interactive path configuration failed"
PREFERENCES_FILE="$INTERACTIVE_CONFIG_HOME/.config/mcpctl/preferences.json"
jq -e \
  --arg store "$STORE" \
  --arg secrets "$INTERACTIVE_CONFIG_SECRETS" \
  --arg remote "$INTERACTIVE_CONFIG_REMOTE" '
    .schema == 1
    and .store == $store
    and .secrets_file == $secrets
    and .remote_config == $remote
  ' "$PREFERENCES_FILE" >/dev/null ||
  fail "configuration center did not persist the selected paths"
[ "$(mode_of "$PREFERENCES_FILE")" = "600" ] ||
  fail "mcpctl preferences mode is not 0600"
HOME="$INTERACTIVE_CONFIG_HOME" "$MCPCTL" server list >/dev/null ||
  fail "explicit command did not load the saved store preference"
HOME="$INTERACTIVE_CONFIG_HOME" \
  GITHUB_MCP_PAT='status-must-not-print-this' \
  "$MCPCTL" secrets status >"$TEST_ROOT/secrets-status.out"
grep -q 'env GITHUB_MCP_PAT (available)' "$TEST_ROOT/secrets-status.out" ||
  fail "redacted Secret status omitted the available environment source"
! grep -q 'status-must-not-print-this' "$TEST_ROOT/secrets-status.out" ||
  fail "Secret status printed an environment value"
SECOND_STORE="${TEST_ROOT}/second-store"
HOME="$INTERACTIVE_CONFIG_HOME" "$MCPCTL" init --store "$SECOND_STORE" >/dev/null
HOME="$INTERACTIVE_CONFIG_HOME" "$MCPCTL" secrets status \
  --store "$SECOND_STORE" >"$TEST_ROOT/second-store-secrets.out"
grep -qF "Encrypted file: $SECOND_STORE/secrets.sops.json" \
  "$TEST_ROOT/second-store-secrets.out" ||
  fail "an explicit different store reused another store's Secret path"

# A public age recipient rule can be created from the same configuration
# center. No private identity is written to the store.
printf '8\n5\nage1testpublicrecipient\n7\n9\n' |
  HOME="$INTERACTIVE_CONFIG_HOME" "$MCPCTL" \
    >"$TEST_ROOT/interactive-age.out" 2>&1 ||
  fail "interactive age recipient configuration failed"
[ -f "$(dirname "$INTERACTIVE_CONFIG_SECRETS")/.sops.yaml" ] ||
  fail "configuration center did not create .sops.yaml"
grep -q 'age1testpublicrecipient' \
  "$(dirname "$INTERACTIVE_CONFIG_SECRETS")/.sops.yaml" ||
  fail "SOPS rule omitted the public age recipient"

# Creating and editing encrypted Secrets is delegated to SOPS. Exercise the
# menu with a fake binary and ensure decrypted values never reach its output.
SECRET_EDIT_STORE="${TEST_ROOT}/secret-edit-store"
SECRET_EDIT_HOME="${TEST_ROOT}/secret-edit-home"
SECRET_EDIT_FILE="${TEST_ROOT}/secret-edit/secrets.sops.json"
mkdir -p "$SECRET_EDIT_HOME"
HOME="$SECRET_EDIT_HOME" "$MCPCTL" init --store "$SECRET_EDIT_STORE" >/dev/null
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'case "$1" in' \
  '  encrypt)' \
  '    cat >/dev/null' \
  '    printf "%s\n" '\''{"schema":"ENC","secrets":"ENC","sops":{"mock":true}}'\''' \
  '    ;;' \
  '  edit)' \
  '    : > "$SOPS_EDIT_MARKER"' \
  '    ;;' \
  '  decrypt)' \
  '    printf "%s\n" '\''{"schema":1,"secrets":{"github_mcp_pat":"editor-secret"}}'\''' \
  '    ;;' \
  '  *) exit 2 ;;' \
  'esac' \
  > "$FAKE_BIN/sops-editor"
chmod +x "$FAKE_BIN/sops-editor"
printf '8\n4\n%s\n3\n7\n9\n' "$SECRET_EDIT_FILE" |
  HOME="$SECRET_EDIT_HOME" \
  MCPCTL_SOPS_BIN="$FAKE_BIN/sops-editor" \
  SOPS_EDIT_MARKER="$TEST_ROOT/sops-edited" \
    "$MCPCTL" interactive --store "$SECRET_EDIT_STORE" \
      >"$TEST_ROOT/interactive-secret-edit.out" 2>&1 ||
  fail "interactive encrypted Secret editor failed"
[ -f "$SECRET_EDIT_FILE" ] ||
  fail "interactive Secret editor did not create the encrypted file"
[ -f "$TEST_ROOT/sops-edited" ] ||
  fail "interactive Secret editor did not invoke SOPS edit"
[ "$(mode_of "$SECRET_EDIT_FILE")" = "600" ] ||
  fail "encrypted Secret file mode is not 0600"
! grep -q 'editor-secret' "$TEST_ROOT/interactive-secret-edit.out" ||
  fail "interactive Secret editor printed a decrypted value"

# The customizer can add an individual server without changing its base
# profile. The selected override remains visible in applied state.
INTERACTIVE_CUSTOM_HOME="${TEST_ROOT}/interactive-custom-home"
mkdir -p "$INTERACTIVE_CUSTOM_HOME"
OFF_PROFILE_INDEX="$(profile_menu_index off)"
LLDB_TOGGLE_INDEX="$(server_toggle_index codex lldb)"
DONE_TOGGLE_INDEX="$(($(supported_server_count codex) + 1))"
printf '5\n2\n%s\n%s\n%s\n1\ny\n' \
  "$OFF_PROFILE_INDEX" "$LLDB_TOGGLE_INDEX" "$DONE_TOGGLE_INDEX" |
  HOME="$INTERACTIVE_CUSTOM_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-custom.out" 2>&1 ||
  fail "interactive one-off server selection failed"
grep -qF '[mcp_servers.lldb]' \
  "$INTERACTIVE_CUSTOM_HOME/.codex/config.toml" ||
  fail "interactive customizer did not enable LLDB"
jq -e '
  .targets.codex.profile == "off"
  and .targets.codex.servers == ["lldb"]
' "$INTERACTIVE_CUSTOM_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "interactive one-off selection was not recorded"

# A customized selection can also be saved as a target-specific child profile.
# Exercise both an enable and a disable relative to the chosen base.
INTERACTIVE_SAVE_HOME="${TEST_ROOT}/interactive-save-home"
mkdir -p "$INTERACTIVE_SAVE_HOME"
DAILY_PROFILE_INDEX="$(profile_menu_index daily)"
CHROME_TOGGLE_INDEX="$(server_toggle_index codex chrome-devtools)"
printf '5\n2\n%s\n%s\n%s\n%s\n2\nmy-debug\ny\n' \
  "$DAILY_PROFILE_INDEX" \
  "$CHROME_TOGGLE_INDEX" \
  "$LLDB_TOGGLE_INDEX" \
  "$DONE_TOGGLE_INDEX" |
  HOME="$INTERACTIVE_SAVE_HOME" \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-save.out" 2>&1 ||
  fail "interactive saved server selection failed"
jq -e '
  .extends == ["daily"]
  and .target_overrides.codex.enable == ["lldb"]
  and .target_overrides.codex.disable == ["chrome-devtools"]
' "$STORE/profiles/my-debug.json" >/dev/null ||
  fail "interactive customizer did not save the expected child profile"
grep -qF '[mcp_servers.lldb]' \
  "$INTERACTIVE_SAVE_HOME/.codex/config.toml" ||
  fail "saved custom profile omitted LLDB"
! grep -qF '[mcp_servers.chrome-devtools]' \
  "$INTERACTIVE_SAVE_HOME/.codex/config.toml" ||
  fail "saved custom profile did not disable Chrome DevTools"

# The interactive server picker treats Tavily auth choices as variants of one
# service. Selecting API-key mode replaces an inherited keyless selection.
INTERACTIVE_TAVILY_HOME="${TEST_ROOT}/interactive-tavily-home"
mkdir -p "$INTERACTIVE_TAVILY_HOME"
HOME="$TEST_HOME" "$MCPCTL" profile create tavily-test \
  --extends off --enable tavily-keyless --description "Tavily test" \
  --store "$STORE" >/dev/null
TAVILY_KEYLESS_PROFILE_INDEX="$(profile_menu_index tavily-test)"
TAVILY_API_TOGGLE_INDEX="$(server_toggle_index claude tavily-api)"
CLAUDE_DONE_TOGGLE_INDEX="$(($(supported_server_count claude) + 1))"
printf '5\n1\n%s\n%s\n%s\n1\ny\n' \
  "$TAVILY_KEYLESS_PROFILE_INDEX" \
  "$TAVILY_API_TOGGLE_INDEX" \
  "$CLAUDE_DONE_TOGGLE_INDEX" |
  HOME="$INTERACTIVE_TAVILY_HOME" \
  TAVILY_API_KEY='interactive-tavily-key' \
    "$MCPCTL" interactive --store "$STORE" \
      >"$TEST_ROOT/interactive-tavily.out" 2>&1 ||
  fail "interactive Tavily variant switch failed"
jq -e '
  .mcpServers["tavily-api"].headers.Authorization ==
    "Bearer interactive-tavily-key"
  and (.mcpServers["tavily-keyless"] == null)
  and (.mcpServers["tavily-oauth"] == null)
' "$INTERACTIVE_TAVILY_HOME/.claude.json" >/dev/null ||
  fail "interactive Tavily switch left mutually exclusive modes enabled"

HOME="$TEST_HOME" "$MCPCTL" profile create cli-custom \
  --extends off --enable radare2 --enable lldb --disable lldb \
  --description "CLI custom profile" --store "$STORE" >/dev/null
jq -e '
  .extends == ["off"]
  and .enable == ["radare2"]
  and .disable == ["lldb"]
  and .target_overrides == {}
' "$STORE/profiles/cli-custom.json" >/dev/null ||
  fail "profile create did not normalize CLI enable/disable operations"
if HOME="$TEST_HOME" "$MCPCTL" profile create cli-custom \
  --extends off --store "$STORE" >/dev/null 2>&1; then
  fail "profile create overwrote an existing profile"
fi

if HOME="$TEST_HOME" "$MCPCTL" interactive --store "$STORE" \
  </dev/null >"$TEST_ROOT/interactive-eof.out" 2>&1; then
  fail "interactive mode accepted missing input"
fi
grep -q 'interactive input ended' "$TEST_ROOT/interactive-eof.out" ||
  fail "interactive EOF did not explain how to use explicit commands"

daily_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show daily \
    --target codex --store "$STORE"
)"
for expected_server in \
  context7 fetch chrome-devtools-cloak chrome-devtools; do
  printf '%s' "$daily_profile" | grep -q "  ${expected_server}$" ||
    fail "Daily profile omitted ${expected_server}"
done

daily_search_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show daily-search \
    --target codex --store "$STORE"
)"
for expected_server in brave exa; do
  printf '%s' "$daily_search_profile" | grep -q "  ${expected_server}$" ||
    fail "Daily search profile omitted ${expected_server}"
done

override_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show daily-search \
    --target codex --disable exa --store "$STORE"
)"
printf '%s' "$override_profile" | grep -q '  brave$' ||
  fail "CLI enable override was not applied"
! printf '%s' "$override_profile" | grep -q '  exa$' ||
  fail "CLI disable did not win"

reverse_native_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show reverse-native \
    --target codex --store "$STORE"
)"
for expected_server in ghidra idalib radare2 frida; do
  printf '%s' "$reverse_native_profile" | grep -q "  ${expected_server}$" ||
    fail "Native reverse profile omitted ${expected_server}"
done

reverse_mobile_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show reverse-mobile \
    --target codex --store "$STORE"
)"
for expected_server in jadx apktool frida; do
  printf '%s' "$reverse_mobile_profile" | grep -q "  ${expected_server}$" ||
    fail "Mobile reverse profile omitted ${expected_server}"
done

reverse_headless_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show reverse-headless \
    --target codex --store "$STORE"
)"
for expected_server in \
  radare2 gdb lldb ghidra-headless playwright-headless; do
  printf '%s' "$reverse_headless_profile" | grep -q "  ${expected_server}$" ||
    fail "Headless reverse profile omitted ${expected_server}"
done
! printf '%s' "$reverse_headless_profile" | grep -q '  ghidra$' ||
  fail "Headless reverse profile unexpectedly enabled the Ghidra GUI bridge"

reverse_windows_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show reverse-windows \
    --target codex --store "$STORE"
)"
for expected_server in x64dbg frida; do
  printf '%s' "$reverse_windows_profile" | grep -q "  ${expected_server}$" ||
    fail "Windows reverse profile omitted ${expected_server}"
done

reverse_web_profile="$(
  HOME="$TEST_HOME" "$MCPCTL" profile show reverse-web \
    --target codex --store "$STORE"
)"
for expected_server in \
  context7 fetch chrome-devtools chrome-devtools-cloak js-reverse; do
  printf '%s' "$reverse_web_profile" | grep -q "  ${expected_server}$" ||
    fail "Web reverse profile omitted ${expected_server}"
done

# Search provider modes render credentials only when their selected mode needs
# them. API keys stay in headers, while keyless and OAuth modes remain clean.
SEARCH_HOME="${TEST_ROOT}/search-home"
mkdir -p "$SEARCH_HOME"
env -u KEENABLE_API_KEY HOME="$SEARCH_HOME" \
  "$MCPCTL" apply --target claude --profile off --enable keenable \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers.keenable.url == "https://api.keenable.ai/mcp"
  and ((.mcpServers.keenable.headers // {}) | length == 0)
' "$SEARCH_HOME/.claude.json" >/dev/null ||
  fail "anonymous Keenable mode unexpectedly rendered a credential"

HOME="$SEARCH_HOME" KEENABLE_API_KEY='test-keenable-key' \
  "$MCPCTL" apply --target claude --profile off --enable keenable \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers.keenable.headers["X-API-Key"] == "test-keenable-key"
' "$SEARCH_HOME/.claude.json" >/dev/null ||
  fail "Keenable API-key mode did not render X-API-Key"

HOME="$SEARCH_HOME" \
  "$MCPCTL" apply --target claude --profile off --enable tavily-keyless \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers["tavily-keyless"].headers["X-Tavily-Access-Mode"] == "keyless"
  and (.mcpServers["tavily-api"] == null)
  and (.mcpServers["tavily-oauth"] == null)
' "$SEARCH_HOME/.claude.json" >/dev/null ||
  fail "Tavily keyless mode did not render its isolated access header"

cp "$SEARCH_HOME/.claude.json" "$TEST_ROOT/tavily-keyless.before"
if env -u TAVILY_API_KEY HOME="$SEARCH_HOME" \
  "$MCPCTL" apply --target claude --profile off --enable tavily-api \
    --store "$STORE" >"$TEST_ROOT/tavily-missing.out" 2>&1; then
  fail "Tavily API-key mode accepted a missing credential"
fi
cmp -s "$TEST_ROOT/tavily-keyless.before" "$SEARCH_HOME/.claude.json" ||
  fail "missing Tavily API key changed the target configuration"

HOME="$SEARCH_HOME" TAVILY_API_KEY='test-tavily-key' \
  "$MCPCTL" apply --target claude --profile off --enable tavily-api \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers["tavily-api"].headers.Authorization == "Bearer test-tavily-key"
  and (.mcpServers["tavily-api"].url | contains("test-tavily-key") | not)
  and (.mcpServers["tavily-keyless"] == null)
' "$SEARCH_HOME/.claude.json" >/dev/null ||
  fail "Tavily API-key mode did not keep its credential in Authorization"

HOME="$SEARCH_HOME" \
  "$MCPCTL" apply --target claude --profile off --enable tavily-oauth \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers["tavily-oauth"].url == "https://mcp.tavily.com/mcp/"
  and ((.mcpServers["tavily-oauth"].headers // {}) | length == 0)
  and (.mcpServers["tavily-api"] == null)
' "$SEARCH_HOME/.claude.json" >/dev/null ||
  fail "Tavily OAuth mode unexpectedly rendered a static credential"

CAPTURE_HOME="${TEST_ROOT}/capture-home"
mkdir -p "$CAPTURE_HOME"
if env -u ANYTHING_ANALYZER_MCP_TOKEN HOME="$CAPTURE_HOME" \
  "$MCPCTL" apply --target claude --profile off --enable anything-analyzer \
    --store "$STORE" >"$TEST_ROOT/capture-missing.out" 2>&1; then
  fail "Anything Analyzer accepted a missing MCP token"
fi
[ ! -e "$CAPTURE_HOME/.claude.json" ] ||
  fail "missing Anything Analyzer token changed the target configuration"

HOME="$CAPTURE_HOME" \
  ANYTHING_ANALYZER_MCP_TOKEN='test-anything-analyzer-token' \
  "$MCPCTL" apply --target claude --profile off --enable anything-analyzer \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers["anything-analyzer"].url ==
    "http://127.0.0.1:23816/mcp"
  and .mcpServers["anything-analyzer"].headers.Authorization ==
    "Bearer test-anything-analyzer-token"
  and (.mcpServers["anything-analyzer"].url |
    contains("test-anything-analyzer-token") | not)
' "$CAPTURE_HOME/.claude.json" >/dev/null ||
  fail "Anything Analyzer did not render a loopback URL and Bearer header"

mkdir -p "$TEST_HOME/.claude"
printf '%s\n' \
  '{"theme":"dark","mcpServers":{"user-owned":{"command":"keep-me"}}}' \
  > "$TEST_HOME/.claude.json"

plan_output="$(
  HOME="$TEST_HOME" \
    BRAVE_API_KEY='never-print-this-secret' \
    EXA_API_KEY='never-print-this-exa-secret' \
    "$MCPCTL" plan --target claude --profile daily-search --store "$STORE"
)"
! printf '%s' "$plan_output" | grep -q 'never-print-this-secret' ||
  fail "plan printed a secret value"
! printf '%s' "$plan_output" | grep -q 'never-print-this-exa-secret' ||
  fail "plan printed an Exa secret value"
printf '%s' "$plan_output" | grep -q 'env BRAVE_API_KEY (available)' ||
  fail "plan did not report the redacted secret source"

HOME="$TEST_HOME" BRAVE_API_KEY='test-brave' EXA_API_KEY='test-exa' \
  "$MCPCTL" apply --target claude --profile daily-search \
    --store "$STORE" >/dev/null

jq -e --arg package_adapter "$SCRIPT_DIR/adapters/mcp-package" '
  .theme == "dark"
  and .mcpServers["user-owned"].command == "keep-me"
  and .mcpServers.brave.headers["X-Subscription-Token"] == "test-brave"
  and .mcpServers.brave._managed_by == "agent/mcpctl"
  and .mcpServers.exa.headers.Authorization == "Bearer test-exa"
  and .mcpServers.context7.headers == null
  and .mcpServers.fetch.command == "uvx"
  and .mcpServers["chrome-devtools"].command == $package_adapter
  and .mcpServers["chrome-devtools"].args ==
    ["npm", "chrome-devtools", "chrome-devtools-mcp@1.6.0",
     "chrome-devtools-mcp", "--"]
' "$TEST_HOME/.claude.json" >/dev/null ||
  fail "Claude daily-search config was not rendered correctly"
[ "$(mode_of "$TEST_HOME/.claude.json")" = "600" ] ||
  fail "Claude config mode is not 0600"

current_output="$(
  HOME="$TEST_HOME" "$MCPCTL" current --target claude --store "$STORE"
)"
printf '%s' "$current_output" | grep -q '^Profile: daily-search$' ||
  fail "current did not report the applied profile"
current_json="$(
  HOME="$TEST_HOME" "$MCPCTL" current --target claude --store "$STORE" --json
)"
printf '%s' "$current_json" | jq -e '
  .target == "claude"
  and .selection_mode == "profile"
  and .profile == "daily-search"
  and .healthy == true
  and (.servers | length > 0)
' >/dev/null || fail "current --json omitted the active MCP selection"

github_plan="$(
  HOME="$TEST_HOME" GITHUB_MCP_PAT='never-print-github-secret' \
    "$MCPCTL" plan --target claude --profile daily --enable github --store "$STORE"
)"
! printf '%s' "$github_plan" | grep -q 'never-print-github-secret' ||
  fail "GitHub plan printed the PAT"
printf '%s' "$github_plan" | grep -q 'env GITHUB_MCP_PAT (available)' ||
  fail "GitHub plan did not report its redacted PAT source"
HOME="$TEST_HOME" GITHUB_MCP_PAT='test-github-pat' \
  "$MCPCTL" apply --target claude --profile daily --enable github \
    --store "$STORE" >/dev/null
jq -e '
  .mcpServers.github.type == "http"
  and .mcpServers.github.url == "https://api.githubcopilot.com/mcp/"
  and .mcpServers.github.headers.Authorization == "Bearer test-github-pat"
  and .mcpServers.github._managed_by == "agent/mcpctl"
' "$TEST_HOME/.claude.json" >/dev/null ||
  fail "GitHub MCP config was not rendered correctly"

HOME="$TEST_HOME" \
  "$MCPCTL" apply --target claude --profile reverse-native \
    --store "$STORE" >/dev/null
jq -e '
  .theme == "dark"
  and .mcpServers["user-owned"].command == "keep-me"
  and .mcpServers.radare2.command == "r2pm"
  and .mcpServers.ghidra != null
  and .mcpServers.idalib != null
  and .mcpServers.frida != null
  and .mcpServers.context7 == null
  and .mcpServers.brave == null
  and .mcpServers["chrome-devtools"] == null
' "$TEST_HOME/.claude.json" >/dev/null ||
  fail "Claude profile switch did not reconcile owned entries"

jq -e '
  .targets.claude.profile == "reverse-native"
  and ((.targets.claude.servers | sort) ==
    (["ghidra", "idalib", "radare2", "frida"] | sort))
' "$TEST_HOME/.local/state/mcpctl/applied.json" >/dev/null ||
  fail "applied state was not updated"

# Same-name entries created by a user or the old mcp.sh are not adopted
# silently. --force replaces only the conflicting name.
printf '%s\n' \
  '{"theme":"light","mcpServers":{"brave":{"url":"https://user.example/mcp"},"other":{"command":"keep"}}}' \
  > "$TEST_HOME/.claude.json"
if HOME="$TEST_HOME" BRAVE_API_KEY=test-brave EXA_API_KEY=test-exa \
  "$MCPCTL" apply --target claude --profile daily-search \
    --store "$STORE" >/dev/null 2>&1; then
  fail "unmanaged same-name Claude entry was replaced without --force"
fi
HOME="$TEST_HOME" BRAVE_API_KEY=test-brave EXA_API_KEY=test-exa \
  "$MCPCTL" apply --target claude --profile daily-search \
    --store "$STORE" --force >/dev/null
jq -e '
  .theme == "light"
  and .mcpServers.other.command == "keep"
  and .mcpServers.brave._managed_by == "agent/mcpctl"
' "$TEST_HOME/.claude.json" >/dev/null ||
  fail "Claude --force changed unrelated configuration"

# Codex uses a bounded TOML block and preserves other tables while switching.
jq '.servers["plugin-default"] = {
  category: "test",
  description: "Plugin-provided MCP that must stay explicitly disabled",
  supported_targets: ["codex"],
  transport: "stdio",
  command: ["plugin-default-mcp"],
  suppress_when_disabled: true
}' "$STORE/catalog.json" > "$TEST_ROOT/catalog-with-suppression.json"
mv "$TEST_ROOT/catalog-with-suppression.json" "$STORE/catalog.json"
mkdir -p "$TEST_HOME/.codex"
printf '%s\n' \
  '[model]' \
  'name = "keep"' \
  '' \
  '[mcp_servers.user-owned]' \
  'url = "https://user.example/mcp"' \
  > "$TEST_HOME/.codex/config.toml"

HOME="$TEST_HOME" BRAVE_API_KEY='test-brave' EXA_API_KEY='test-exa' \
  "$MCPCTL" apply --target codex --profile daily-search \
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
grep -qF '[mcp_servers.brave]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex daily-search profile omitted Brave"
awk '
  $0 == "[mcp_servers.plugin-default]" { in_server = 1; next }
  in_server && /^\[/ { exit(found ? 0 : 1) }
  in_server && $0 == "enabled = false" { found = 1 }
  END { exit(found ? 0 : 1) }
' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex did not render an explicit disabled override"
HOME="$TEST_HOME" "$MCPCTL" current --target codex --store "$STORE" --json |
  jq -e '
    .healthy == true
    and (.servers | index("plugin-default") == null)
    and .suppressed_servers == ["plugin-default"]
    and .expected_suppressed_servers == ["plugin-default"]
  ' >/dev/null ||
  fail "Codex current state did not distinguish a suppressed server"

HOME="$TEST_HOME" \
  "$MCPCTL" server enable plugin-default \
  --target codex --store "$STORE" >/dev/null
HOME="$TEST_HOME" "$MCPCTL" current --target codex --store "$STORE" --json |
  jq -e '
    .healthy == true
    and (.servers | index("plugin-default") != null)
    and .suppressed_servers == []
  ' >/dev/null ||
  fail "Codex server enable did not lift the explicit suppression"
HOME="$TEST_HOME" \
  "$MCPCTL" server disable plugin-default \
  --target codex --store "$STORE" >/dev/null
HOME="$TEST_HOME" "$MCPCTL" current --target codex --store "$STORE" --json |
  jq -e '
    .healthy == true
    and (.servers | index("plugin-default") == null)
    and .suppressed_servers == ["plugin-default"]
  ' >/dev/null ||
  fail "Codex server disable did not restore the explicit suppression"
grep -qF '"Authorization" = "Bearer test-exa"' \
  "$TEST_HOME/.codex/config.toml" ||
  fail "Codex incremental switch rewrote an unchanged Secret-backed server"

# --force adopts a same-name Codex table without touching unrelated TOML.
printf '%s\n' \
  '[model]' \
  'name = "keep"' \
  '' \
  '[mcp_servers.exa]' \
  'url = "https://user.example/mcp"' \
  '' \
  '[mcp_servers.user-owned]' \
  'command = "keep"' \
  > "$TEST_HOME/.codex/config.toml"
if HOME="$TEST_HOME" BRAVE_API_KEY='test-brave' EXA_API_KEY='test-exa' \
  "$MCPCTL" apply --target codex --profile daily-search \
    --store "$STORE" >/dev/null 2>&1; then
  fail "unmanaged same-name Codex entry was replaced without --force"
fi
HOME="$TEST_HOME" BRAVE_API_KEY='test-brave' EXA_API_KEY='test-exa' \
  "$MCPCTL" apply --target codex --profile daily-search \
    --store "$STORE" --force >/dev/null
[ "$(grep -cF '[mcp_servers.exa]' "$TEST_HOME/.codex/config.toml")" = 1 ] ||
  fail "Codex --force did not leave exactly one managed same-name table"
grep -qF '[mcp_servers.user-owned]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex --force removed an unrelated MCP table"
! grep -qF 'https://user.example/mcp' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex --force left the unmanaged same-name table"

HOME="$TEST_HOME" \
  "$MCPCTL" apply --target codex --profile reverse-native \
    --store "$STORE" >/dev/null
grep -qF '[mcp_servers.user-owned]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex switch removed a user entry"
grep -qF '[mcp_servers.radare2]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex reverse profile omitted Radare2"
grep -qF '[mcp_servers.idalib]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex native reverse profile omitted IDALib"
! grep -qF '[mcp_servers.exa]' "$TEST_HOME/.codex/config.toml" ||
  fail "Codex switch left a stale managed Exa entry"
[ "$(mode_of "$TEST_HOME/.codex/config.toml")" = "600" ] ||
  fail "Codex config mode is not 0600"

# Missing required profile secrets fail before replacing the target.
cp "$TEST_HOME/.codex/config.toml" "$TEST_ROOT/codex.before"
if HOME="$TEST_HOME" \
  "$MCPCTL" apply --target codex --profile daily-search \
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
  "$MCPCTL" apply --target opencode --profile daily-search \
    --store "$STORE" >/dev/null
jq -e --arg package_adapter "$SCRIPT_DIR/adapters/mcp-package" '
  .theme == "system"
  and .mcp.user.command == ["keep"]
  and .mcp.brave.headers["X-Subscription-Token"] == "test-brave"
  and .mcp.exa.headers.Authorization == "Bearer test-exa"
  and .mcp["chrome-devtools"].type == "local"
  and .mcp["chrome-devtools"].command ==
    [$package_adapter, "npm", "chrome-devtools",
     "chrome-devtools-mcp@1.6.0", "chrome-devtools-mcp", "--"]
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
  "$MCPCTL" apply --target claude --profile daily-search \
    --store "$STORE" --force >/dev/null
jq -e '
  .mcpServers.brave.headers["X-Subscription-Token"] == "sops-brave"
  and .mcpServers.context7.headers.Authorization == "Bearer sops-context"
' "$TEST_HOME/.claude.json" >/dev/null ||
  fail "SOPS-backed secrets were not resolved"

# Import is read-only by default, writes static values only to the encrypted
# cache, and keeps each target's imported selection in one shared profile.
IMPORT_HOME="${TEST_ROOT}/import-home"
IMPORT_STORE="${TEST_ROOT}/import-store"
IMPORT_REMOTE="${TEST_ROOT}/import-remote.json"
mkdir -p "$IMPORT_HOME"
HOME="$IMPORT_HOME" "$MCPCTL" init --store "$IMPORT_STORE" >/dev/null
printf '%s\n' \
  '{"mcpServers":{"import-private":{"command":"node","args":["server.mjs","--token","IMPORT-ARG-SECRET"],"env":{"API_TOKEN":"IMPORT-CLAUDE-SECRET"}}}}' \
  > "$IMPORT_HOME/.claude.json"
node -e '
  const config = {
    schema: 1,
    endpoint: "https://backup.example.test",
    store_id: "abcdef0123456789abcdef0123456789",
    root_key: Buffer.alloc(32, 23).toString("base64url")
  };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
' > "$IMPORT_REMOTE"
chmod 600 "$IMPORT_REMOTE"

import_plan="$(
  HOME="$IMPORT_HOME" "$MCPCTL" import --target claude \
    --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE"
)"
! printf '%s' "$import_plan" |
  grep -qE 'IMPORT-(CLAUDE|ARG)-SECRET' ||
  fail "Claude import plan printed a Secret"
[ ! -f "$IMPORT_STORE/profiles/imported.json" ] ||
  fail "Claude import plan changed the store"

import_apply="$(
  HOME="$IMPORT_HOME" "$MCPCTL" import --target claude --write \
    --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE"
)"
! printf '%s' "$import_apply" |
  grep -qE 'IMPORT-(CLAUDE|ARG)-SECRET' ||
  fail "Claude import output printed a Secret"
! grep -qE 'IMPORT-(CLAUDE|ARG)-SECRET' "$IMPORT_STORE/catalog.json" ||
  fail "Claude import wrote a Secret to the plaintext catalog"
jq -e '
  .target_overrides.claude.enable == ["import-private"]
  and .managed_by == "agent/mcpctl/import"
' "$IMPORT_STORE/profiles/imported.json" >/dev/null ||
  fail "Claude import did not create the imported target profile"
node "$SCRIPT_DIR/remote-client.mjs" secrets \
  --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE" |
  jq -e '
    ([.secrets[]] | sort) ==
      ["IMPORT-ARG-SECRET", "IMPORT-CLAUDE-SECRET"]
  ' >/dev/null ||
  fail "Claude import did not encrypt the extracted Secret"
import_secret_status="$(
  HOME="$IMPORT_HOME" "$MCPCTL" secrets status \
    --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE"
)"
printf '%s' "$import_secret_status" |
  grep -q 'encrypted remote cache present' ||
  fail "Secret status omitted imported encrypted references"
! printf '%s' "$import_secret_status" |
  grep -qE 'IMPORT-(CLAUDE|ARG)-SECRET' ||
  fail "Secret status printed an imported Secret"

HOME="$IMPORT_HOME" "$MCPCTL" apply --target claude --profile imported \
  --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE" \
  --force >/dev/null
jq -e '
  .mcpServers["import-private"].command == "node"
  and .mcpServers["import-private"].args ==
    ["server.mjs", "--token", "IMPORT-ARG-SECRET"]
  and .mcpServers["import-private"].env.API_TOKEN == "IMPORT-CLAUDE-SECRET"
' "$IMPORT_HOME/.claude.json" >/dev/null ||
  fail "Claude imported profile did not round-trip its command environment"

printf '%s\n' \
  '#!/usr/bin/env sh' \
  'if [ "$1 $2 $3" = "mcp list --json" ]; then' \
  '  printf "%s\n" "[{\"name\":\"codex-private\",\"enabled\":true,\"startup_timeout_sec\":20,\"tool_timeout_sec\":45,\"transport\":{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"codex-server.mjs\"],\"cwd\":\"/tmp\",\"env\":{\"CODEX_TOKEN\":\"IMPORT-CODEX-SECRET\"},\"env_vars\":[\"PASSTHROUGH\"]}},{\"name\":\"codex-remote\",\"enabled\":true,\"transport\":{\"type\":\"streamable_http\",\"url\":\"https://mcp.example.test/mcp\",\"bearer_token_env_var\":null,\"http_headers\":{\"Authorization\":\"Bearer IMPORT-CODEX-HEADER\"},\"env_http_headers\":{}}}]"' \
  '  exit 0' \
  'fi' \
  'exit 2' \
  > "$FAKE_BIN/codex"
chmod +x "$FAKE_BIN/codex"

codex_import="$(
  HOME="$IMPORT_HOME" MCPCTL_CODEX_BIN="$FAKE_BIN/codex" \
    "$MCPCTL" import --target codex --write \
      --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE"
)"
! printf '%s' "$codex_import" |
  grep -qE 'IMPORT-CODEX-(SECRET|HEADER)' ||
  fail "Codex import output printed a Secret"
! grep -qE 'IMPORT-CODEX-(SECRET|HEADER)' "$IMPORT_STORE/catalog.json" ||
  fail "Codex import wrote a Secret to the plaintext catalog"
jq -e '
  .target_overrides.claude.enable == ["import-private"]
  and .target_overrides.codex.enable == ["codex-private", "codex-remote"]
' "$IMPORT_STORE/profiles/imported.json" >/dev/null ||
  fail "Codex import did not preserve both target selections"

HOME="$IMPORT_HOME" "$MCPCTL" apply --target codex --profile imported \
  --store "$IMPORT_STORE" --remote-config "$IMPORT_REMOTE" >/dev/null
grep -qF '[mcp_servers.codex-private.env]' \
  "$IMPORT_HOME/.codex/config.toml" ||
  fail "Codex imported stdio environment table was not rendered"
grep -qF '"CODEX_TOKEN" = "IMPORT-CODEX-SECRET"' \
  "$IMPORT_HOME/.codex/config.toml" ||
  fail "Codex imported stdio Secret was not restored"
grep -qF '[mcp_servers.codex-remote.http_headers]' \
  "$IMPORT_HOME/.codex/config.toml" ||
  fail "Codex imported HTTP Header table was not rendered"
grep -qF '"Authorization" = "Bearer IMPORT-CODEX-HEADER"' \
  "$IMPORT_HOME/.codex/config.toml" ||
  fail "Codex imported HTTP Secret was not restored"

# Malformed target config fails closed.
printf '%s\n' '{invalid-json' > "$TEST_HOME/.claude.json"
cp "$TEST_HOME/.claude.json" "$TEST_ROOT/claude.before"
if HOME="$TEST_HOME" "$MCPCTL" apply --target claude --profile off \
  --store "$STORE" >/dev/null 2>&1; then
  fail "malformed Claude JSON was accepted"
fi
cmp -s "$TEST_ROOT/claude.before" "$TEST_HOME/.claude.json" ||
  fail "malformed Claude JSON changed after a failed apply"

# Hand-written profiles fail closed when they enable two variants from the
# same provider group; the guided picker prevents this state automatically.
printf '%s\n' \
  '{"schema":1,"name":"variant-conflict","extends":["off"],"enable":["tavily-keyless","tavily-api"],"disable":[],"target_overrides":{}}' \
  > "$STORE/profiles/variant-conflict.json"
if HOME="$TEST_HOME" TAVILY_API_KEY='conflict-test-key' \
  "$MCPCTL" profile show variant-conflict --target codex --store "$STORE" \
    >"$TEST_ROOT/variant-conflict.out" 2>&1; then
  fail "mutually exclusive Tavily modes were accepted"
fi
grep -q "mutually exclusive variants in group 'tavily-auth'" \
  "$TEST_ROOT/variant-conflict.out" ||
  fail "Tavily variant conflict did not explain how to repair the profile"

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
node --test "$SCRIPT_DIR/import-client.test.mjs" ||
  fail "safe local MCP import tests failed"
node --test "$SCRIPT_DIR/remote-client.test.mjs" ||
  fail "encrypted remote backup and restore tests failed"

printf 'ok  : mcpctl profiles, safe import, ownership, Secrets, and remote restore\n'
