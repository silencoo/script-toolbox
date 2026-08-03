#!/usr/bin/env bash
# Shared terminal UI helpers for the repository-backed *ctl entrypoints.
#
# Keep this library dependency-free and Bash 3.2 compatible. The standalone
# provider setup.sh scripts intentionally use setup-lib.sh instead because they
# must also work when streamed from a Raw GitHub URL.

# shellcheck shell=bash

log()  { printf '%s\n' "$*"; }
info() { printf '▸ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

require_node22() {
  local purpose="$1" node_major
  command -v node >/dev/null 2>&1 ||
    die "Node.js 22 or newer is required for $purpose"
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  case "$node_major" in
    ""|*[!0-9]*) node_major=0 ;;
  esac
  [ "$node_major" -ge 22 ] ||
    die "Node.js 22 or newer is required for $purpose (found ${node_major})"
}

prompt_value() {
  local label="$1" default_value="${2:-}" input
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  if ! IFS= read -r input; then
    die "interactive input ended; use --help for non-interactive commands"
  fi
  PROMPT_REPLY="${input:-$default_value}"
}

prompt_secret_value() {
  local label="$1" input terminal_state=""
  printf '%s: ' "$label" >&2
  if [ -t 0 ]; then
    terminal_state="$(stty -g 2>/dev/null || true)"
    stty -echo 2>/dev/null || true
  fi
  if ! IFS= read -r input; then
    [ -z "$terminal_state" ] || stty "$terminal_state" 2>/dev/null || true
    printf '\n' >&2
    die "interactive input ended; use --help for non-interactive commands"
  fi
  [ -z "$terminal_state" ] || stty "$terminal_state" 2>/dev/null || true
  printf '\n' >&2
  SECRET_REPLY="$input"
}

choose_menu() {
  # Usage: choose_menu "Title" default-index "value|Label" ...
  # Result: MENU_VALUE.
  local title="$1" default_index="$2" entry index selected
  shift 2
  printf '\n%s\n' "$title" >&2
  index=1
  for entry in "$@"; do
    printf '  %d) %s\n' "$index" "${entry#*|}" >&2
    index=$((index + 1))
  done

  while true; do
    prompt_value "Choose" "$default_index"
    selected="$PROMPT_REPLY"
    case "$selected" in
      ""|*[!0-9]*)
        warn "enter a number from 1 to $#"
        continue
        ;;
    esac
    if [ "$selected" -lt 1 ] 2>/dev/null ||
       [ "$selected" -gt "$#" ] 2>/dev/null; then
      warn "enter a number from 1 to $#"
      continue
    fi

    index=1
    for entry in "$@"; do
      if [ "$index" -eq "$selected" ]; then
        MENU_VALUE="${entry%%|*}"
        return 0
      fi
      index=$((index + 1))
    done
  done
}

ask_yes_no() {
  local label="$1" default_answer="${2:-no}" answer
  while true; do
    if [ "$default_answer" = "yes" ]; then
      prompt_value "$label [Y/n]" ""
    else
      prompt_value "$label [y/N]" ""
    fi
    answer="$(printf '%s' "$PROMPT_REPLY" | tr '[:upper:]' '[:lower:]')"
    case "$answer" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      "")
        [ "$default_answer" = "yes" ] && return 0
        return 1
        ;;
      *) warn "please answer y or n" ;;
    esac
  done
}

run_agent_tui() {
  # Usage: run_agent_tui <bundle> <initial-section> [TUI options]
  local bundle="$1" section="$2"
  shift 2
  require_node22 "the agent TUI"
  [ -r "$bundle" ] ||
    die "agent TUI bundle not found: $bundle (run npm run build in agent/tui)"
  exec node "$bundle" --section "$section" "$@"
}

run_ctl_update() {
  # Usage: run_ctl_update <updater> <caller-name> [update options]
  local updater="$1" caller="$2"
  shift 2
  [ -x "$updater" ] ||
    die "controller updater not found or not executable: $updater"
  SCRIPT_TOOLBOX_UPDATE_CALLER="$caller" exec "$updater" "$@"
}
