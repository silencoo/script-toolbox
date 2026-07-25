#!/usr/bin/env bash
# agent/pi/uninstall.sh — remove only the Pi configuration owned by this kit.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RESET=""
fi

printf '%s%s%s\n' "${C_BOLD}" "Uninstalling pi agent…" "${C_RESET}"
printf '%s\n' "--------------------------------------------------------------"

"${SCRIPT_DIR}/setup.sh" --uninstall

echo
printf '%s%s%s\n' "${C_BOLD}" "Done. You may also want to manually:" "${C_RESET}"
cat <<EOF
  - ${C_DIM}npm uninstall -g @earendil-works/pi-coding-agent${C_RESET}
    Only do this if you no longer use the Pi CLI.

  - Optionally delete ${C_DIM}~/.pi/agent/${C_RESET} if no other Pi settings,
    sessions, packages, skills, or extensions are stored there.
EOF
