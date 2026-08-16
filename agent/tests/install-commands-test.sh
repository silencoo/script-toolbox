#!/usr/bin/env bash
# Isolated tests for standalone installation, updates, compatibility links, and recovery.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${AGENT_DIR}/.." && pwd)"
INSTALLER="${AGENT_DIR}/install-commands.sh"
TEST_ROOT="$(mktemp -d)"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

PREFIX="${TEST_ROOT}/bin"
RUNTIME="${TEST_ROOT}/runtime"

"$INSTALLER" --prefix "$PREFIX" --runtime "$RUNTIME" --release-id test-v1 \
  >"$TEST_ROOT/preview.out"
[ ! -e "$PREFIX" ] || fail "install preview created the prefix"
[ ! -e "$RUNTIME" ] || fail "install preview created the runtime"
grep -q '\[preview\] no files or links were changed' "$TEST_ROOT/preview.out" ||
  fail "install preview did not explain how to apply"
if "$INSTALLER" --prefix "$TEST_ROOT/unsafe/bin" --runtime "$TEST_ROOT" --yes \
  >"$TEST_ROOT/unsafe.out" 2>&1; then
  fail "installer accepted a runtime containing the command prefix"
fi

# Any failure after runtime replacement or an individual link update restores
# the complete pre-install state, including user-owned conflicts and manifest.
ATOMIC_PREFIX="${TEST_ROOT}/atomic-bin"
ATOMIC_RUNTIME="${TEST_ROOT}/atomic-runtime"
if SCRIPT_TOOLBOX_INSTALL_FAIL_AT=after-link-mcpctl \
  "$INSTALLER" --prefix "$ATOMIC_PREFIX" --runtime "$ATOMIC_RUNTIME" \
    --release-id atomic-fresh --yes >"$TEST_ROOT/atomic-fresh.out" 2>&1; then
  fail "fault-injected fresh install unexpectedly succeeded"
fi
[ ! -e "$ATOMIC_RUNTIME" ] || fail "failed fresh install left a runtime"
for name in agentctl mcpctl promptctl skillsctl; do
  [ ! -e "$ATOMIC_PREFIX/$name" ] && [ ! -L "$ATOMIC_PREFIX/$name" ] ||
    fail "failed fresh install left command $name"
done
[ ! -e "$ATOMIC_PREFIX/.script-toolbox-agent-commands" ] ||
  fail "failed fresh install left a manifest"

mkdir -p "$ATOMIC_PREFIX"
printf '%s\n' user-owned > "$ATOMIC_PREFIX/mcpctl"
cp "$ATOMIC_PREFIX/mcpctl" "$TEST_ROOT/atomic-mcpctl.before"
if SCRIPT_TOOLBOX_INSTALL_FAIL_AT=after-link-mcpctl \
  "$INSTALLER" --prefix "$ATOMIC_PREFIX" --runtime "$ATOMIC_RUNTIME" \
    --release-id atomic-conflict --force --yes \
      >"$TEST_ROOT/atomic-conflict.out" 2>&1; then
  fail "fault-injected forced install unexpectedly succeeded"
fi
cmp -s "$ATOMIC_PREFIX/mcpctl" "$TEST_ROOT/atomic-mcpctl.before" ||
  fail "failed forced install did not restore the user-owned command"
[ ! -e "$ATOMIC_PREFIX/agentctl" ] && [ ! -L "$ATOMIC_PREFIX/agentctl" ] ||
  fail "failed forced install left an earlier command link"
[ -z "$(find "$ATOMIC_PREFIX" -maxdepth 1 -name 'mcpctl.backup.*' -print -quit)" ] ||
  fail "failed forced install leaked a persistent command backup"
[ ! -e "$ATOMIC_RUNTIME" ] || fail "failed forced install left a runtime"
rm -f "$ATOMIC_PREFIX/mcpctl"

"$INSTALLER" --prefix "$ATOMIC_PREFIX" --runtime "$ATOMIC_RUNTIME" \
  --release-id atomic-v1 --yes >/dev/null 2>&1
cp "$ATOMIC_PREFIX/.script-toolbox-agent-commands" "$TEST_ROOT/atomic-manifest.before"
if SCRIPT_TOOLBOX_INSTALL_FAIL_AT=after-manifest \
  "$INSTALLER" --prefix "$ATOMIC_PREFIX" --runtime "$ATOMIC_RUNTIME" \
    --release-id atomic-v2 --yes >"$TEST_ROOT/atomic-update.out" 2>&1; then
  fail "fault-injected update unexpectedly succeeded"
fi
grep -q '^release_id=atomic-v1$' "$ATOMIC_RUNTIME/.script-toolbox-agent-runtime" ||
  fail "failed update did not restore the prior runtime"
cmp -s "$ATOMIC_PREFIX/.script-toolbox-agent-commands" \
  "$TEST_ROOT/atomic-manifest.before" ||
  fail "failed update did not restore the prior manifest"
for name in agentctl mcpctl promptctl skillsctl; do
  [ -L "$ATOMIC_PREFIX/$name" ] || fail "failed update lost command $name"
done
"$ATOMIC_RUNTIME/install-commands.sh" --prefix "$ATOMIC_PREFIX" \
  --uninstall --yes >/dev/null

"$INSTALLER" --prefix "$PREFIX" --runtime "$RUNTIME" --release-id test-v1 --yes \
  >"$TEST_ROOT/install.out" 2>&1
for name in agentctl mcpctl promptctl skillsctl; do
  [ -L "$PREFIX/$name" ] || fail "installer did not create $name"
  case "$(readlink "$PREFIX/$name")" in
    "$RUNTIME"/*) ;;
    *) fail "$name does not point into the standalone runtime" ;;
  esac
done
[ -f "$RUNTIME/.script-toolbox-agent-runtime" ] || fail "runtime marker is missing"
[ -f "$RUNTIME/platform-command.mjs" ] ||
  fail "standalone runtime omitted the cross-platform command launcher"
[ -f "$RUNTIME/platform-paths.mjs" ] ||
  fail "standalone runtime omitted the cross-platform path resolver"
[ -f "$RUNTIME/install-commands.ps1" ] ||
  fail "standalone runtime omitted the Windows PowerShell installer"
[ "$(mode_of "$PREFIX/.script-toolbox-agent-commands")" = "600" ] ||
  fail "command manifest is not mode 600"
[ "$(mode_of "$RUNTIME/.script-toolbox-agent-runtime")" = "600" ] ||
  fail "runtime marker is not mode 600"
[ ! -e "$RUNTIME/tui/node_modules" ] || fail "standalone runtime copied node_modules"
[ ! -e "$RUNTIME/tests" ] || fail "standalone runtime copied development tests"

[ "$("$PREFIX/agentctl" --version)" = "agentctl 0.17.4" ] ||
  fail "agentctl did not work through its standalone link"
[ -x "$RUNTIME/claude-code/statusline-setup.sh" ] ||
  fail "standalone runtime omitted the Claude status-line manager"
[ -x "$RUNTIME/claude-code/statusline.py" ] ||
  fail "standalone runtime omitted the Claude status-line renderer"
[ -f "$RUNTIME/agentctl/proxy-client.mjs" ] ||
  fail "standalone runtime omitted the proxy controller"
[ -f "$RUNTIME/agentctl/account-client.mjs" ] ||
  fail "standalone runtime omitted the Codex account controller"
[ -f "$RUNTIME/agentctl/provider-catalog.mjs" ] ||
  fail "standalone runtime omitted the unified Provider catalog"
[ -f "$RUNTIME/agentctl/failover-client.mjs" ] &&
[ -f "$RUNTIME/agentctl/failover-schema.mjs" ] &&
[ -f "$RUNTIME/proxy/circuit-breaker.mjs" ] ||
  fail "standalone runtime omitted failover/circuit modules"
[ -f "$RUNTIME/proxy/agentproxyd.mjs" ] ||
  fail "standalone runtime omitted the proxy daemon"
[ -f "$RUNTIME/agentctl/pricing-client.mjs" ] &&
[ -f "$RUNTIME/pricing/pricing.mjs" ] &&
[ -f "$RUNTIME/pricing/openai-gpt-5.6-2026-08-14.json" ] &&
[ -f "$RUNTIME/proxy/model-mapper.mjs" ] &&
[ -f "$RUNTIME/proxy/usage.mjs" ] ||
  fail "standalone runtime omitted pricing/model/usage modules"
"$PREFIX/agentctl" pricing --help >/dev/null ||
  fail "standalone pricing command failed"
"$PREFIX/agentctl" failover --help >/dev/null ||
  fail "standalone failover command failed"
"$PREFIX/agentctl" account --help >/dev/null ||
  fail "standalone Codex account command failed"
"$PREFIX/mcpctl" --help >/dev/null || fail "mcpctl standalone command failed"
"$PREFIX/promptctl" --help >/dev/null || fail "promptctl standalone command failed"
"$PREFIX/skillsctl" --help >/dev/null || fail "skillsctl standalone command failed"

# Every public controller exposes its own update entrypoint. They all inspect
# and replace the shared suite, avoiding mixed controller/runtime revisions.
for name in agentctl mcpctl promptctl skillsctl; do
  "$PREFIX/$name" update --check \
    --source "$REPO_ROOT" --release-id test-v2 >"$TEST_ROOT/update-$name.out"
  grep -q 'Latest:  test-v2' "$TEST_ROOT/update-$name.out" ||
    fail "$name update did not reach the shared updater"
done
"$PREFIX/skillsctl" update --yes \
  --source "$REPO_ROOT" --release-id test-v2 >"$TEST_ROOT/update-apply.out" 2>&1
grep -q '^release_id=test-v2$' "$RUNTIME/.script-toolbox-agent-runtime" ||
  fail "standalone update did not replace runtime metadata"

"$INSTALLER" --prefix "$PREFIX" --runtime "$RUNTIME" --release-id test-v2 --yes \
  >"$TEST_ROOT/reinstall.out" 2>&1
grep -q "keep     $PREFIX/agentctl" "$TEST_ROOT/reinstall.out" ||
  fail "standalone reinstall was not link-idempotent"

"$RUNTIME/install-commands.sh" --prefix "$PREFIX" --uninstall \
  >"$TEST_ROOT/uninstall-preview.out"
[ -L "$PREFIX/agentctl" ] || fail "uninstall preview removed a command"
[ -d "$RUNTIME" ] || fail "uninstall preview removed the runtime"
"$RUNTIME/install-commands.sh" --prefix "$PREFIX" --uninstall --yes >/dev/null
[ ! -e "$PREFIX/agentctl" ] || fail "uninstall left an owned command"
[ ! -e "$RUNTIME" ] || fail "uninstall left the standalone runtime"
[ ! -e "$PREFIX/.script-toolbox-agent-commands" ] || fail "uninstall left its manifest"

# An unowned command collision is refused. --force preserves it, and uninstall
# restores it byte-for-byte while removing the standalone runtime.
mkdir -p "$PREFIX"
printf '%s\n' 'user-owned-mcpctl' > "$PREFIX/mcpctl"
cp "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before"
if "$INSTALLER" --prefix "$PREFIX" --runtime "$RUNTIME" --release-id conflict --yes \
  >"$TEST_ROOT/conflict.out" 2>&1; then
  fail "installer replaced an unowned command without --force"
fi
cmp -s "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before" || fail "refused conflict was modified"

"$INSTALLER" --prefix "$PREFIX" --runtime "$RUNTIME" --release-id conflict \
  --force --yes >/dev/null 2>&1
[ -L "$PREFIX/mcpctl" ] || fail "--force did not install over the tracked backup"
"$RUNTIME/install-commands.sh" --prefix "$PREFIX" --uninstall --yes >/dev/null
[ -f "$PREFIX/mcpctl" ] && [ ! -L "$PREFIX/mcpctl" ] ||
  fail "uninstall did not restore the user-owned command"
cmp -s "$PREFIX/mcpctl" "$TEST_ROOT/mcpctl.before" || fail "restored command changed"

# An unowned runtime is likewise preserved only with --force, and uninstall
# restores the original directory after removing the verified managed runtime.
RUNTIME_PREFIX="${TEST_ROOT}/runtime-conflict-bin"
RUNTIME_CONFLICT="${TEST_ROOT}/runtime-conflict"
mkdir -p "$RUNTIME_CONFLICT"
printf '%s\n' 'user-owned-runtime' > "$RUNTIME_CONFLICT/sentinel"
if "$INSTALLER" --prefix "$RUNTIME_PREFIX" --runtime "$RUNTIME_CONFLICT" \
  --release-id conflict --yes >"$TEST_ROOT/runtime-conflict.out" 2>&1; then
  fail "installer replaced an unowned runtime without --force"
fi
[ -f "$RUNTIME_CONFLICT/sentinel" ] || fail "refused runtime conflict was modified"
"$INSTALLER" --prefix "$RUNTIME_PREFIX" --runtime "$RUNTIME_CONFLICT" \
  --release-id conflict --force --yes >/dev/null 2>&1
[ -f "$RUNTIME_CONFLICT/.script-toolbox-agent-runtime" ] ||
  fail "--force did not install over the tracked runtime backup"
"$RUNTIME_CONFLICT/install-commands.sh" --prefix "$RUNTIME_PREFIX" --uninstall --yes >/dev/null
[ -f "$RUNTIME_CONFLICT/sentinel" ] || fail "uninstall did not restore unowned runtime"

# Changed installed paths stop uninstall before any managed path is removed.
CHANGED_PREFIX="${TEST_ROOT}/changed-bin"
CHANGED_RUNTIME="${TEST_ROOT}/changed-runtime"
"$INSTALLER" --prefix "$CHANGED_PREFIX" --runtime "$CHANGED_RUNTIME" \
  --release-id changed --yes >/dev/null 2>&1
rm -f "$CHANGED_PREFIX/promptctl"
ln -s "$TEST_ROOT/unowned-target" "$CHANGED_PREFIX/promptctl"
if "$CHANGED_RUNTIME/install-commands.sh" --prefix "$CHANGED_PREFIX" --uninstall --yes \
  >"$TEST_ROOT/changed.out" 2>&1; then
  fail "uninstall accepted a changed command path"
fi
[ -L "$CHANGED_PREFIX/agentctl" ] || fail "failed uninstall partially removed commands"
[ -d "$CHANGED_RUNTIME" ] || fail "failed uninstall removed the runtime"
rm -f "$CHANGED_PREFIX/promptctl"
ln -s "$CHANGED_RUNTIME/promptctl/promptctl" "$CHANGED_PREFIX/promptctl"
"$CHANGED_RUNTIME/install-commands.sh" --prefix "$CHANGED_PREFIX" --uninstall --yes >/dev/null

# Repository-backed links remain available as an explicit development mode.
LINK_PREFIX="${TEST_ROOT}/link-bin"
"$INSTALLER" --link --prefix "$LINK_PREFIX" --yes >/dev/null 2>&1
[ "$(readlink "$LINK_PREFIX/agentctl")" = "$AGENT_DIR/agentctl/agentctl" ] ||
  fail "--link did not retain repository-backed compatibility"
"$INSTALLER" --link --prefix "$LINK_PREFIX" --uninstall --yes >/dev/null

# A v1 repository-link manifest from installer 0.1 migrates to standalone
# without --force and without losing its ownership record.
LEGACY_PREFIX="${TEST_ROOT}/legacy-bin"
LEGACY_RUNTIME="${TEST_ROOT}/legacy-runtime"
mkdir -p "$LEGACY_PREFIX"
for name in agentctl mcpctl promptctl skillsctl; do
  case "$name" in
    agentctl) legacy_target="$AGENT_DIR/agentctl/agentctl" ;;
    mcpctl) legacy_target="$AGENT_DIR/mcpctl/mcpctl" ;;
    promptctl) legacy_target="$AGENT_DIR/promptctl/promptctl" ;;
    skillsctl) legacy_target="$AGENT_DIR/skillsctl/skillsctl" ;;
  esac
  ln -s "$legacy_target" "$LEGACY_PREFIX/$name"
done
{
  printf '%s\n' '# script-toolbox-agent-commands v1'
  printf 'agentctl\t%s\t\n' "$AGENT_DIR/agentctl/agentctl"
  printf 'mcpctl\t%s\t\n' "$AGENT_DIR/mcpctl/mcpctl"
  printf 'promptctl\t%s\t\n' "$AGENT_DIR/promptctl/promptctl"
  printf 'skillsctl\t%s\t\n' "$AGENT_DIR/skillsctl/skillsctl"
} > "$LEGACY_PREFIX/.script-toolbox-agent-commands"
chmod 600 "$LEGACY_PREFIX/.script-toolbox-agent-commands"
"$INSTALLER" --prefix "$LEGACY_PREFIX" --runtime "$LEGACY_RUNTIME" \
  --release-id migrated --yes >/dev/null 2>&1
[ "$(readlink "$LEGACY_PREFIX/agentctl")" = "$LEGACY_RUNTIME/agentctl/agentctl" ] ||
  fail "v1 repository-link installation did not migrate to standalone"
"$LEGACY_RUNTIME/install-commands.sh" --prefix "$LEGACY_PREFIX" --uninstall --yes >/dev/null

# Git for Windows can copy a symlink target instead of creating a real link.
# Windows installs therefore use small Bash launchers, which preserve the
# runtime-relative BASH_SOURCE contract without requiring Developer Mode.
LAUNCHER_PREFIX="${TEST_ROOT}/launcher bin"
LAUNCHER_RUNTIME="${TEST_ROOT}/launcher runtime"
SCRIPT_TOOLBOX_INSTALL_COMMAND_STYLE=launcher \
  "$INSTALLER" --prefix "$LAUNCHER_PREFIX" --runtime "$LAUNCHER_RUNTIME" \
    --release-id launcher-v1 --yes >/dev/null 2>&1
for name in agentctl mcpctl promptctl skillsctl; do
  [ -f "$LAUNCHER_PREFIX/$name" ] && [ ! -L "$LAUNCHER_PREFIX/$name" ] ||
    fail "launcher install did not create a regular $name command"
  grep -q '^# script-toolbox-agent-command v1$' "$LAUNCHER_PREFIX/$name" ||
    fail "launcher install omitted the ownership marker for $name"
done
[ "$("$LAUNCHER_PREFIX/agentctl" --version)" = "agentctl 0.17.4" ] ||
  fail "agentctl did not work through a managed Bash launcher"
SCRIPT_TOOLBOX_INSTALL_COMMAND_STYLE=launcher \
  "$LAUNCHER_RUNTIME/install-commands.sh" --prefix "$LAUNCHER_PREFIX" \
    --uninstall --yes >/dev/null

# Installer 0.2's MSYS symlink emulation produced byte-identical regular
# copies. A matching v2 manifest lets 0.3 migrate those broken commands to
# launchers without --force.
MSYS_PREFIX="${TEST_ROOT}/legacy msys bin"
MSYS_RUNTIME="${TEST_ROOT}/legacy msys runtime"
SCRIPT_TOOLBOX_INSTALL_COMMAND_STYLE=symlink \
  "$INSTALLER" --prefix "$MSYS_PREFIX" --runtime "$MSYS_RUNTIME" \
    --release-id legacy-msys --yes >/dev/null 2>&1
for name in agentctl mcpctl promptctl skillsctl; do
  target="$(readlink "$MSYS_PREFIX/$name")"
  rm -f "$MSYS_PREFIX/$name"
  cp "$target" "$MSYS_PREFIX/$name"
  chmod +x "$MSYS_PREFIX/$name"
done
SCRIPT_TOOLBOX_INSTALL_COMMAND_STYLE=launcher \
  "$INSTALLER" --prefix "$MSYS_PREFIX" --runtime "$MSYS_RUNTIME" \
    --release-id migrated-msys --yes >"$TEST_ROOT/msys-migration.out" 2>&1
grep -q "refresh  $MSYS_PREFIX/agentctl" "$TEST_ROOT/msys-migration.out" ||
  fail "legacy MSYS command copy was not migrated without --force"
[ "$("$MSYS_PREFIX/agentctl" --version)" = "agentctl 0.17.4" ] ||
  fail "migrated MSYS launcher did not resolve the standalone runtime"
SCRIPT_TOOLBOX_INSTALL_COMMAND_STYLE=launcher \
  "$MSYS_RUNTIME/install-commands.sh" --prefix "$MSYS_PREFIX" \
    --uninstall --yes >/dev/null

printf '%s\n' "ok  : standalone install, shared updates, conflicts, and recovery"
