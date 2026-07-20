#!/usr/bin/env bash
# agent/test.sh — bash -n walker for every *.sh under agent/.
#
# Excludes test.sh itself. Exits 0 if everything parses, 1 otherwise.
# Mirrors the spirit of the repo's existing JavaScript syntax-check CI.
# Uses find (not globstar) so it works on macOS /bin/bash 3.2 as well as 4+.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

fail=0
checked=0
# -print0 / read -d '' handle paths with spaces or unusual characters.
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  [ "$base" = "test.sh" ] && continue
  checked=$((checked + 1))
  if bash -n "$f"; then
    printf '%s %s\n' "ok  :" "${f#"${SCRIPT_DIR}/"}"
  else
    printf '%s %s\n' "FAIL:" "${f#"${SCRIPT_DIR}/"}" >&2
    fail=1
  fi
done < <(find "$SCRIPT_DIR" -type f -name '*.sh' -print0)

echo
if [ "$fail" -eq 0 ]; then
  echo "all ${checked} scripts parse cleanly."
else
  echo "one or more scripts failed to parse." >&2
fi
exit "$fail"