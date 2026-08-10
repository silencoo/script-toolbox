#!/usr/bin/env bash
# Install and safely manage the script-toolbox Claude Code status-line preset.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
COMMON_LIB="${SCRIPT_DIR}/../setup-lib.sh"
DOWNLOADED_LIB=""
DOWNLOADED_RENDERER=""
SCRIPT_TEMP=""
SETTINGS_TEMP=""
STATE_TEMP=""

cleanup() {
  [ -z "$DOWNLOADED_LIB" ] || rm -f "$DOWNLOADED_LIB"
  [ -z "$DOWNLOADED_RENDERER" ] || rm -f "$DOWNLOADED_RENDERER"
  [ -z "$SCRIPT_TEMP" ] || rm -f "$SCRIPT_TEMP"
  [ -z "$SETTINGS_TEMP" ] || rm -f "$SETTINGS_TEMP"
  [ -z "$STATE_TEMP" ] || rm -f "$STATE_TEMP"
}
trap cleanup EXIT HUP INT TERM

if [ -r "$COMMON_LIB" ]; then
  # shellcheck source=../setup-lib.sh
  . "$COMMON_LIB"
else
  command -v curl >/dev/null 2>&1 || {
    printf '%s\n' "curl is required" >&2
    exit 1
  }
  DOWNLOADED_LIB="$(mktemp)"
  curl -fsSL \
    https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/setup-lib.sh \
    > "$DOWNLOADED_LIB"
  # shellcheck source=../setup-lib.sh
  . "$DOWNLOADED_LIB"
fi

MANAGED_BY="agent/claude-code/statusline-setup.sh"
MANAGED_MARKER="# Managed by script-toolbox agentctl statusline."
SETTINGS_DIR="${HOME}/.claude"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
SCRIPTS_DIR="${SETTINGS_DIR}/scripts"
TARGET_SCRIPT="${SCRIPTS_DIR}/script-toolbox-statusline.py"
STATE_FILE="${SETTINGS_DIR}/.script-toolbox-statusline.json"
MANAGED_COMMAND="~/.claude/scripts/script-toolbox-statusline.py"
SOURCE_RENDERER="${SCRIPT_DIR}/statusline.py"
PUBLIC_COMMAND="${AGENTCTL_STATUSLINE_COMMAND:-$0}"

usage() {
  cat <<EOF
${C_BOLD}${PUBLIC_COMMAND}${C_RESET} — manage the Claude Code status-line preset

${C_BOLD}Usage:${C_RESET}
  ${PUBLIC_COMMAND} install [--yes] [--force]
  ${PUBLIC_COMMAND} status [--json]
  ${PUBLIC_COMMAND} uninstall [--yes]

${C_BOLD}Commands:${C_RESET}
  install      Preview or install/update the managed Python renderer and
               settings.json statusLine entry.
  status       Report managed, external, drifted, or not-installed state.
  uninstall    Restore the statusLine value saved at install time and remove
               only the managed renderer/state.

${C_BOLD}Options:${C_RESET}
  --yes, -y    Apply an install or uninstall plan. Without it, mutations are
               previewed only.
  --force      Preserve and replace an existing external statusLine setting.
               An unrelated file at the managed script path is never replaced.
  --json       Emit machine-readable status metadata; never emits commands or
               the saved external statusLine value.
  -h, --help   Show this help.

The preset uses event-driven refreshes; it does not set refreshInterval.
Python 3 and jq are required. Ownership is independent from provider setup.
EOF
}

require_jq_readonly() {
  command -v jq >/dev/null 2>&1 ||
    die "jq is required for status-line management"
}

require_settings_object() {
  [ -f "$SETTINGS_FILE" ] || return 0
  [ ! -L "$SETTINGS_FILE" ] ||
    die "refusing symlinked Claude settings: $SETTINGS_FILE"
  require_json_object "$SETTINGS_FILE"
}

state_is_valid() {
  local state_mode=""
  [ -f "$STATE_FILE" ] && [ ! -L "$STATE_FILE" ] || return 1
  state_mode="$(file_mode "$STATE_FILE")"
  case "$state_mode" in
    ?00|??00) ;;
    *) return 1 ;;
  esac
  jq -e --arg managed_by "$MANAGED_BY" --arg command "$MANAGED_COMMAND" '
    type == "object"
    and .schema == 1
    and .managed_by == $managed_by
    and .command == $command
    and (.previous_status_line_present | type) == "boolean"
    and has("previous_status_line")
  ' "$STATE_FILE" >/dev/null 2>&1
}

script_is_owned() {
  [ -f "$TARGET_SCRIPT" ] && [ ! -L "$TARGET_SCRIPT" ] || return 1
  [ "$(sed -n '2p' "$TARGET_SCRIPT" 2>/dev/null)" = "$MANAGED_MARKER" ]
}

settings_has_statusline() {
  [ -f "$SETTINGS_FILE" ] || return 1
  jq -e 'has("statusLine")' "$SETTINGS_FILE" >/dev/null 2>&1
}

settings_uses_managed_command() {
  [ -f "$SETTINGS_FILE" ] || return 1
  jq -e --arg command "$MANAGED_COMMAND" '
    .statusLine == {"type": "command", "command": $command}
  ' "$SETTINGS_FILE" >/dev/null 2>&1
}

inspect_statusline() {
  require_jq_readonly
  require_settings_object

  STATUS_STATE_VALID=false
  STATUS_SCRIPT_OWNED=false
  STATUS_SCRIPT_EXECUTABLE=false
  STATUS_SETTINGS_KIND="absent"
  STATUS_VALUE="not-installed"

  if state_is_valid; then
    STATUS_STATE_VALID=true
  elif [ -e "$STATE_FILE" ]; then
    STATUS_VALUE="drifted"
  fi

  if script_is_owned; then
    STATUS_SCRIPT_OWNED=true
    [ -x "$TARGET_SCRIPT" ] && STATUS_SCRIPT_EXECUTABLE=true
  elif [ -e "$TARGET_SCRIPT" ]; then
    STATUS_VALUE="drifted"
  fi

  if settings_uses_managed_command; then
    STATUS_SETTINGS_KIND="managed"
  elif settings_has_statusline; then
    STATUS_SETTINGS_KIND="external"
  fi

  if [ "$STATUS_SETTINGS_KIND" = "managed" ] &&
     [ "$STATUS_STATE_VALID" = true ] &&
     [ "$STATUS_SCRIPT_OWNED" = true ] &&
     [ "$STATUS_SCRIPT_EXECUTABLE" = true ]; then
    STATUS_VALUE="configured"
  elif [ "$STATUS_SETTINGS_KIND" = "external" ] &&
       [ "$STATUS_STATE_VALID" = false ] &&
       [ "$STATUS_SCRIPT_OWNED" = false ] &&
       [ ! -e "$STATE_FILE" ] &&
       [ ! -e "$TARGET_SCRIPT" ]; then
    STATUS_VALUE="external"
  elif [ "$STATUS_SETTINGS_KIND" != "absent" ] ||
       [ "$STATUS_STATE_VALID" = true ] ||
       [ "$STATUS_SCRIPT_OWNED" = true ]; then
    STATUS_VALUE="drifted"
  fi
}

emit_status_human() {
  log "Claude Code status line"
  log "  Status      : $STATUS_VALUE"
  log "  Settings    : $SETTINGS_FILE ($STATUS_SETTINGS_KIND)"
  log "  Renderer    : $TARGET_SCRIPT ($([ "$STATUS_SCRIPT_OWNED" = true ] && printf managed || printf missing-or-external))"
  log "  State file  : $STATE_FILE ($([ "$STATUS_STATE_VALID" = true ] && printf valid || printf missing-or-invalid))"
}

emit_status_json() {
  jq -n \
    --arg status "$STATUS_VALUE" \
    --arg settings_file "$SETTINGS_FILE" \
    --arg settings_kind "$STATUS_SETTINGS_KIND" \
    --arg script_file "$TARGET_SCRIPT" \
    --arg state_file "$STATE_FILE" \
    --argjson state_valid "$STATUS_STATE_VALID" \
    --argjson script_owned "$STATUS_SCRIPT_OWNED" \
    --argjson script_executable "$STATUS_SCRIPT_EXECUTABLE" '
      {
        client: "claude",
        status: $status,
        settings_file: $settings_file,
        settings_kind: $settings_kind,
        script_file: $script_file,
        state_file: $state_file,
        state_valid: $state_valid,
        script_owned: $script_owned,
        script_executable: $script_executable
      }
    '
}

resolve_renderer_source() {
  if [ -f "$SOURCE_RENDERER" ] && [ ! -L "$SOURCE_RENDERER" ] &&
     [ "$(sed -n '2p' "$SOURCE_RENDERER" 2>/dev/null)" = "$MANAGED_MARKER" ]; then
    return 0
  fi

  command -v curl >/dev/null 2>&1 ||
    die "renderer source is unavailable and curl is not installed"
  DOWNLOADED_RENDERER="$(mktemp)"
  curl -fsSL \
    https://raw.githubusercontent.com/silencoo/script-toolbox/main/agent/claude-code/statusline.py \
    > "$DOWNLOADED_RENDERER" ||
    die "could not download the Claude status-line renderer"
  [ "$(sed -n '2p' "$DOWNLOADED_RENDERER" 2>/dev/null)" = "$MANAGED_MARKER" ] ||
    die "downloaded status-line renderer is missing its ownership marker"
  SOURCE_RENDERER="$DOWNLOADED_RENDERER"
}

run_status() {
  local json_output=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json_output=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) die "status accepts only --json" ;;
    esac
  done
  inspect_statusline
  if [ "$json_output" = 1 ]; then
    emit_status_json
  else
    emit_status_human
  fi
}

run_install() {
  local apply=0 force=0 if_missing=0
  local state_source="settings"

  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) apply=1; shift ;;
      --force) force=1; shift ;;
      --if-missing) if_missing=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) die "unknown install option: $1 (use --help)" ;;
    esac
  done

  require_jq_readonly
  require_settings_object

  if [ "$if_missing" = 1 ] && settings_has_statusline &&
     ! settings_uses_managed_command; then
    ok "kept the existing Claude Code status line"
    return 0
  fi

  if [ -e "$STATE_FILE" ] && ! state_is_valid; then
    die "status-line ownership state is invalid: $STATE_FILE"
  fi
  if [ -e "$TARGET_SCRIPT" ] && ! script_is_owned; then
    die "refusing to replace an unrelated file at $TARGET_SCRIPT"
  fi

  if settings_has_statusline && ! settings_uses_managed_command; then
    [ "$force" = 1 ] ||
      die "Claude settings already contain an external statusLine; re-run with --force to preserve and replace it"
    state_source="settings"
  elif state_is_valid && settings_uses_managed_command; then
    state_source="state"
  elif state_is_valid; then
    [ "$force" = 1 ] ||
      die "managed status-line state has drifted; inspect status, then use --force to adopt the current setting"
    if ! settings_has_statusline && script_is_owned; then
      # A settings manager may rewrite the JSON object and drop statusLine.
      # Keep the original private restore point while repairing our setting.
      state_source="state"
    else
      state_source="settings"
    fi
  fi

  command -v python3 >/dev/null 2>&1 ||
    die "Python 3 is required by the Claude status-line preset"
  resolve_renderer_source
  python3 -c '
import ast
import pathlib
import sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
' "$SOURCE_RENDERER" || die "the bundled status-line renderer has invalid Python syntax"

  log "[preview] Claude Code status-line install"
  info "Renderer          : $TARGET_SCRIPT"
  info "Configuration     : $SETTINGS_FILE"
  info "Ownership state   : $STATE_FILE"
  if settings_has_statusline && ! settings_uses_managed_command; then
    info "Existing setting  : preserve privately, then replace"
  elif settings_uses_managed_command; then
    info "Existing setting  : refresh managed renderer"
  else
    info "Existing setting  : none"
  fi
  info "Refresh policy    : Claude event-driven updates (no refreshInterval)"

  if [ "$apply" != 1 ]; then
    log "[preview] no files were changed; re-run with --yes to apply"
    return 0
  fi

  mkdir -p "$SCRIPTS_DIR"
  SCRIPT_TEMP="$(make_temp_near "$TARGET_SCRIPT")"
  SETTINGS_TEMP="$(make_temp_near "$SETTINGS_FILE")"
  STATE_TEMP="$(make_temp_near "$STATE_FILE")"

  cp "$SOURCE_RENDERER" "$SCRIPT_TEMP"
  chmod 700 "$SCRIPT_TEMP"

  if [ "$state_source" = "state" ]; then
    jq --arg managed_by "$MANAGED_BY" --arg command "$MANAGED_COMMAND" '
      {
        schema: 1,
        managed_by: $managed_by,
        command: $command,
        previous_status_line_present: .previous_status_line_present,
        previous_status_line: .previous_status_line
      }
    ' "$STATE_FILE" > "$STATE_TEMP"
  elif [ -f "$SETTINGS_FILE" ]; then
    jq --arg managed_by "$MANAGED_BY" --arg command "$MANAGED_COMMAND" '
      {
        schema: 1,
        managed_by: $managed_by,
        command: $command,
        previous_status_line_present: has("statusLine"),
        previous_status_line: .statusLine
      }
    ' "$SETTINGS_FILE" > "$STATE_TEMP"
  else
    jq -n --arg managed_by "$MANAGED_BY" --arg command "$MANAGED_COMMAND" '
      {
        schema: 1,
        managed_by: $managed_by,
        command: $command,
        previous_status_line_present: false,
        previous_status_line: null
      }
    ' > "$STATE_TEMP"
  fi

  if [ -f "$SETTINGS_FILE" ]; then
    jq --arg command "$MANAGED_COMMAND" '
      .statusLine = {"type": "command", "command": $command}
    ' "$SETTINGS_FILE" > "$SETTINGS_TEMP"
  else
    jq -n --arg command "$MANAGED_COMMAND" '
      {statusLine: {"type": "command", "command": $command}}
    ' > "$SETTINGS_TEMP"
  fi

  replace_file "$SCRIPT_TEMP" "$TARGET_SCRIPT" 700
  SCRIPT_TEMP=""
  replace_file "$STATE_TEMP" "$STATE_FILE" 600
  STATE_TEMP=""
  replace_file "$SETTINGS_TEMP" "$SETTINGS_FILE" 600
  SETTINGS_TEMP=""
  ok "installed the Claude Code status-line preset"
}

run_uninstall() {
  local apply=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) apply=1; shift ;;
      -h|--help) usage; return 0 ;;
      *) die "uninstall accepts only --yes" ;;
    esac
  done

  require_jq_readonly
  require_settings_object
  state_is_valid ||
    die "no valid $MANAGED_BY ownership state; refusing to remove user configuration"
  settings_uses_managed_command ||
    die "Claude statusLine changed after installation; refusing to overwrite the current setting"
  if [ -e "$TARGET_SCRIPT" ] && ! script_is_owned; then
    die "renderer ownership changed at $TARGET_SCRIPT; refusing to remove it"
  fi

  log "[preview] Claude Code status-line uninstall"
  info "Configuration     : restore the previously saved statusLine value"
  info "Renderer          : remove $TARGET_SCRIPT"
  info "Ownership state   : remove $STATE_FILE"
  if [ "$apply" != 1 ]; then
    log "[preview] no files were changed; re-run with --yes to apply"
    return 0
  fi

  SETTINGS_TEMP="$(make_temp_near "$SETTINGS_FILE")"
  jq --slurpfile state "$STATE_FILE" '
    if $state[0].previous_status_line_present == false
    then del(.statusLine)
    else .statusLine = $state[0].previous_status_line
    end
  ' "$SETTINGS_FILE" > "$SETTINGS_TEMP"
  replace_file "$SETTINGS_TEMP" "$SETTINGS_FILE" 600
  SETTINGS_TEMP=""
  [ ! -e "$TARGET_SCRIPT" ] || rm -f "$TARGET_SCRIPT"
  rm -f "$STATE_FILE"
  ok "removed the managed status line and restored the previous setting"
}

case "${1:-}" in
  install)
    shift
    run_install "$@"
    ;;
  status)
    shift
    run_status "$@"
    ;;
  uninstall|remove)
    shift
    run_uninstall "$@"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    die "unknown status-line command '$1'; use --help"
    ;;
esac
