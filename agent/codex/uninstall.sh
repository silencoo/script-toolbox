#!/usr/bin/env bash
# agent/codex/uninstall.sh — remove everything this agent installed.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[33m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RESET=""
fi

printf '%s%s%s\n' "${C_BOLD}" "Uninstalling codex agent…" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"

"${SCRIPT_DIR}/setup.sh" --uninstall
"${SCRIPT_DIR}/mcp.sh"   --uninstall

echo
printf '%s%s%s\n' "${C_BOLD}" "Done. You may also want to manually:" "${C_RESET}"
cat <<EOF
  - Remove any stale OPENAI_API_KEY export lines from
      ${C_DIM}~/.zshrc${C_RESET} ${C_DIM}~/.bashrc${C_RESET} ${C_DIM}~/.zshenv${C_RESET} ${C_DIM}~/.bash_profile${C_RESET}

  - ${C_DIM}npm uninstall -g @openai/codex${C_RESET}
    Only do this if no other agent uses Codex CLI.

  - Optionally delete ${C_DIM}~/.codex/${C_RESET} entirely if no other tool writes there.
EOF