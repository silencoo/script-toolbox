#!/usr/bin/env bash
# Install one coding-agent CLI independently of Provider/auth configuration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=setup-lib.sh
. "${SCRIPT_DIR}/setup-lib.sh"

usage() {
  cat <<'EOF'
agentctl install — install a coding-agent CLI, configure its Provider later

Usage:
  agentctl install <claude|codex|opencode|pi> [--yes] [--dry-run]

Without --yes, only the installation plan is shown. --dry-run always previews.
Existing commands are kept. No API key or Provider is required; agentctl does
not write Provider settings, credentials, status-line, MCP, or Skills bindings.
Downloads use the official Claude installer (npm fallback), @openai/codex,
opencode-ai, or @earendil-works/pi-coding-agent. npm installs may prepare Node.js
when needed. After installation, run the CLI to sign in or select a Provider
with agentctl provider use <name> --target <client> --yes.
EOF
}

CLIENT=""
APPLY=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --yes|-y) APPLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    claude|claude-code|codex|opencode|open-code|pi)
      [ -z "$CLIENT" ] || die "install accepts exactly one client"
      CLIENT="$1"
      ;;
    *) die "unknown install argument '$1'; use agentctl install --help" ;;
  esac
  shift
done
[ -n "$CLIENT" ] || die "install requires a client: claude, codex, opencode, or pi"
case "$CLIENT" in claude-code) CLIENT=claude ;; open-code) CLIENT=opencode ;; esac
case "$CLIENT" in
  claude) LABEL="Claude Code"; METHOD="official native installer (npm fallback)" ;;
  codex) LABEL="Codex"; METHOD="npm: @openai/codex" ;;
  opencode) LABEL="OpenCode"; METHOD="npm: opencode-ai" ;;
  pi) LABEL="Pi"; METHOD="npm: @earendil-works/pi-coding-agent (Node.js 22.19+)" ;;
esac

log "Install ${LABEL} CLI"
if command -v "$CLIENT" >/dev/null 2>&1; then
  info "Action: keep existing command at $(command -v "$CLIENT")"
else
  info "Action: download and install via $METHOD"
fi
info "Provider configuration: later; no key required for installation"
if [ "$APPLY" != 1 ] || [ "$DRY_RUN" = 1 ]; then
  log "[preview] no installation or configuration change; re-run with --yes to install"
  exit 0
fi

ensure_agent_cli "$CLIENT"
command -v "$CLIENT" >/dev/null 2>&1 || die "$CLIENT is not on PATH after installation"
VERSION="$("$CLIENT" --version 2>&1)" || die "$CLIENT is installed but its version check failed: $VERSION"
ok "${LABEL} ready: $VERSION"
log "Next: run '$CLIENT' to sign in, or configure a Provider with agentctl provider."
