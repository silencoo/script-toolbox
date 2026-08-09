#!/usr/bin/env bash
# agent/claude-code/uninstall.sh — remove everything this agent installed.
#
# Calls the provider, MCP, and (when owned) status-line uninstallers in
# sequence, then prints manual cleanup hints the script itself cannot automate.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Minimal inlined logging (no shared lib).
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RESET=""
fi

printf '%s%s%s\n' "${C_BOLD}" "Uninstalling claude-code agent…" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"

"${SCRIPT_DIR}/setup.sh" --uninstall
"${SCRIPT_DIR}/mcp.sh"   --uninstall
if [ -e "${HOME}/.claude/.script-toolbox-statusline.json" ]; then
  "${SCRIPT_DIR}/statusline-setup.sh" uninstall --yes
fi

echo
printf '%s%s%s\n' "${C_BOLD}" "Done. You may also want to manually:" "${C_RESET}"
cat <<EOF
  - Remove any stale ANTHROPIC_* export lines from
      ${C_DIM}~/.zshrc${C_RESET} ${C_DIM}~/.bashrc${C_RESET} ${C_DIM}~/.zshenv${C_RESET} ${C_DIM}~/.bash_profile${C_RESET}
    (backup files like ${C_DIM}.bak.<timestamp>${C_RESET} were created if you used setup.sh
    before; safe to delete once you've confirmed nothing depends on them.)

  - ${C_DIM}npm uninstall -g @anthropic-ai/claude-code${C_RESET}
    Only do this if no other agent in this folder (or anywhere else) uses Claude Code.

  - Optionally delete ${C_DIM}~/.claude/${C_RESET} entirely if no other tool writes there.
EOF
