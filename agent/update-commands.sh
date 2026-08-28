#!/usr/bin/env bash
# Update a standalone script-toolbox controller runtime from the upstream release branch.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_MARKER="${SCRIPT_DIR}/.script-toolbox-agent-runtime"
DEFAULT_REPOSITORY="silencoo/script-toolbox"
REPOSITORY="${SCRIPT_TOOLBOX_UPDATE_REPOSITORY:-$DEFAULT_REPOSITORY}"
CALLER="${SCRIPT_TOOLBOX_UPDATE_CALLER:-agentctl}"

# Windows may deny renaming the standalone runtime while Bash is still reading
# this updater from inside it. Re-exec the script body from Bash's in-memory
# command string before staging or replacing any runtime files. The original
# script handle is closed by exec, while $0 keeps path/default resolution
# identical. The guard makes the handoff single-shot.
if [ "${SCRIPT_TOOLBOX_UPDATE_IN_MEMORY:-0}" != 1 ]; then
  update_apply_requested=0
  for update_argument in "$@"; do
    case "$update_argument" in --yes|-y) update_apply_requested=1 ;; esac
  done
  update_platform="${SCRIPT_TOOLBOX_UPDATE_PLATFORM:-$(uname -s 2>/dev/null || true)}"
  case "$update_platform" in
    MINGW*|MSYS*|CYGWIN*|windows)
      if [ "$update_apply_requested" = 1 ]; then
        update_script_body="$(cat "$0")" || {
          printf '✗ could not prepare the Windows updater handoff\n' >&2
          exit 1
        }
        SCRIPT_TOOLBOX_UPDATE_IN_MEMORY=1 \
          exec bash -c "$update_script_body" "$0" "$@"
      fi
      ;;
  esac
fi
unset update_apply_requested update_argument update_platform update_script_body

# shellcheck source=ctl-lib.sh
. "${SCRIPT_DIR}/ctl-lib.sh"

APPLY=0
CHECK_ONLY=0
PREFIX="${HOME}/.local/bin"
RUNTIME_DIR="${HOME}/.local/share/script-toolbox/agent"
SOURCE_ROOT=""
RELEASE_ID=""

usage() {
  cat <<EOF
${CALLER} update — update the standalone controller suite

Usage:
  ${CALLER} update [--check]
  ${CALLER} update --yes

Options:
  --check                Check whether a newer upstream revision is available.
  --yes, -y              Download and install the latest revision.
  --prefix <directory>   Command directory (normally read from the installation).
  --runtime <directory>  Runtime directory (normally read from the installation).
  --source <directory>   Install from a local repository checkout instead of GitHub.
  --release-id <id>      Release identifier for a local source (development/testing).
  -h, --help             Show this help.

All four ctl entrypoints share one runtime and are updated together atomically.
EOF
}

marker_value() {
  local wanted="$1"
  [ -f "$RUNTIME_MARKER" ] && [ ! -L "$RUNTIME_MARKER" ] || return 0
  awk -F '=' -v wanted="$wanted" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' \
    "$RUNTIME_MARKER"
}

installed_prefix="$(marker_value prefix)"
installed_runtime="$(marker_value runtime)"
installed_kind="$(marker_value install_kind)"
current_release="$(marker_value release_id)"
[ -z "$installed_prefix" ] || PREFIX="$installed_prefix"
[ -z "$installed_runtime" ] || RUNTIME_DIR="$installed_runtime"
if [ -z "$current_release" ]; then
  current_release="$(git -C "${SCRIPT_DIR}/.." rev-parse HEAD 2>/dev/null || true)"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      shift
      ;;
    --yes|-y)
      APPLY=1
      shift
      ;;
    --prefix)
      [ $# -ge 2 ] || die "--prefix requires a directory"
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    --runtime)
      [ $# -ge 2 ] || die "--runtime requires a directory"
      RUNTIME_DIR="$2"
      shift 2
      ;;
    --runtime=*)
      RUNTIME_DIR="${1#*=}"
      shift
      ;;
    --source)
      [ $# -ge 2 ] || die "--source requires a directory"
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --source=*)
      SOURCE_ROOT="${1#*=}"
      shift
      ;;
    --release-id)
      [ $# -ge 2 ] || die "--release-id requires a value"
      RELEASE_ID="$2"
      shift 2
      ;;
    --release-id=*)
      RELEASE_ID="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown update option: $1 (use --help)"
      ;;
  esac
done

[ -n "$PREFIX" ] || die "update prefix cannot be empty"
[ -n "$RUNTIME_DIR" ] || die "update runtime cannot be empty"

TEMP_ROOT=""
cleanup() {
  [ -z "$TEMP_ROOT" ] || rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

resolve_local_source() {
  local requested="$1"
  case "$requested" in
    /*) ;;
    *) requested="$(pwd)/$requested" ;;
  esac
  if [ -x "${requested}/agent/install-commands.sh" ]; then
    SOURCE_ROOT="$requested"
  elif [ -x "${requested}/install-commands.sh" ]; then
    SOURCE_ROOT="$(cd "${requested}/.." && pwd)"
  else
    die "local update source does not contain agent/install-commands.sh: $requested"
  fi
  if [ -z "$RELEASE_ID" ]; then
    RELEASE_ID="$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi
  [ -n "$RELEASE_ID" ] || RELEASE_ID="local"
}

fetch_latest_release() {
  command -v curl >/dev/null 2>&1 || die "curl is required for ctl update"
  require_node22 "ctl update"
  TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/script-toolbox-update.XXXXXX")"
  latest_json="${TEMP_ROOT}/latest.json"
  curl -fsSL --retry 2 \
    "https://api.github.com/repos/${REPOSITORY}/commits/main" \
    -o "$latest_json" || die "could not query the latest ${REPOSITORY} revision"
  RELEASE_ID="$(node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[a-f0-9]{40}$/.test(value.sha || "")) process.exit(1);
    process.stdout.write(value.sha);
  ' "$latest_json")" || die "GitHub returned an invalid revision"
}

if [ -n "$SOURCE_ROOT" ]; then
  resolve_local_source "$SOURCE_ROOT"
else
  fetch_latest_release
fi

current_label="${current_release:-unknown}"
printf 'Current: %s\n' "$current_label"
printf 'Latest:  %s\n' "$RELEASE_ID"

if [ -n "$current_release" ] && [ "$current_release" = "$RELEASE_ID" ]; then
  ok "the standalone ctl suite is already current"
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ] || [ "$APPLY" != 1 ]; then
  info "an update is available"
  [ "$CHECK_ONLY" = 1 ] || log "Run '${CALLER} update --yes' to install it."
  exit 0
fi

if [ -z "$SOURCE_ROOT" ]; then
  archive="${TEMP_ROOT}/source.tar.gz"
  archive_list="${TEMP_ROOT}/archive.list"
  extract_root="${TEMP_ROOT}/extract"
  mkdir -p "$extract_root"
  curl -fsSL --retry 2 \
    "https://github.com/${REPOSITORY}/archive/${RELEASE_ID}.tar.gz" \
    -o "$archive" || die "could not download ${REPOSITORY}@${RELEASE_ID}"
  tar -tzf "$archive" > "$archive_list" || die "downloaded update is not a valid tar archive"
  awk '
    /^\// { bad = 1 }
    /(^|\/)\.\.($|\/)/ { bad = 1 }
    END { exit bad ? 1 : 0 }
  ' "$archive_list" || die "downloaded update contains an unsafe path"
  tar -xzf "$archive" -C "$extract_root"
  set -- "$extract_root"/*
  [ "$#" -eq 1 ] && [ -d "$1" ] || die "downloaded update has an unexpected layout"
  SOURCE_ROOT="$1"
  [ -x "${SOURCE_ROOT}/agent/install-commands.sh" ] ||
    die "downloaded update does not contain the controller installer"
fi

update_platform="${SCRIPT_TOOLBOX_UPDATE_PLATFORM:-$(uname -s 2>/dev/null || true)}"
powershell_manifest="${PREFIX}/.script-toolbox-agent-powershell.json"
case "$update_platform" in
  MINGW*|MSYS*|CYGWIN*|windows)
    if [ "$installed_kind" = powershell ] ||
      [ "${SCRIPT_TOOLBOX_POWERSHELL_MANAGED:-0}" = 1 ] ||
      [ -f "$powershell_manifest" ]; then
      command -v cygpath >/dev/null 2>&1 ||
        die "cygpath is required to update the Windows command shims"
      command -v powershell.exe >/dev/null 2>&1 ||
        die "Windows PowerShell is required to update the native command shims"
      powershell_installer="${SOURCE_ROOT}/agent/install-commands.ps1"
      [ -f "$powershell_installer" ] ||
        die "downloaded update does not contain the Windows controller installer"
      prefix_windows="$(cygpath -w "$PREFIX")"
      runtime_windows="$(cygpath -w "$RUNTIME_DIR")"
      installer_windows="$(cygpath -w "$powershell_installer")"
      bash_windows="$(cygpath -w "$(command -v bash)")"
      powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass \
        -File "$installer_windows" \
        -Prefix "$prefix_windows" \
        -Runtime "$runtime_windows" \
        -BashPath "$bash_windows" \
        -ReleaseId "$RELEASE_ID" \
        --yes
    else
      "${SOURCE_ROOT}/agent/install-commands.sh" \
        --standalone \
        --prefix "$PREFIX" \
        --runtime "$RUNTIME_DIR" \
        --release-id "$RELEASE_ID" \
        --yes
    fi
    ;;
  *)
    "${SOURCE_ROOT}/agent/install-commands.sh" \
      --standalone \
      --prefix "$PREFIX" \
      --runtime "$RUNTIME_DIR" \
      --release-id "$RELEASE_ID" \
      --yes
    ;;
esac

ok "updated agentctl, mcpctl, promptctl, and skillsctl to ${RELEASE_ID}"
