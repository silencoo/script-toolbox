#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../tools/vnstat-traffic-firewall.sh
source "$SCRIPT_DIR/../tools/vnstat-traffic-firewall.sh"

[[ "$(to_mib '1024 KiB')" == "1.000000" ]]
[[ "$(to_mib '1 GiB')" == "1024.000000" ]]
[[ "$(to_mib '2 MiB')" == "2.000000" ]]
if to_mib '1 bananas' >/dev/null 2>&1; then exit 1; fi
[[ "$(to_mib '0 B')" == "0.000000" ]]
if to_mib 'invalid MiB' >/dev/null 2>&1; then exit 1; fi

# Actual --oneline layout: month RX/TX are fields 9/10, lifetime RX/TX 13/14.
vnstat() {
  printf '%s\n' "1;eth0;2026-09-12;1 MiB;1 MiB;2 MiB;0 kbit/s;2026-09;${MONTH_RX:-1 GiB};${MONTH_TX:-1 GiB};2 GiB;0 kbit/s;800 GiB;800 GiB;1600 GiB"
}
for check in rx tx max sum; do
  status=0
  output=$(main --interface eth0 --check "$check" --limit-gb 1024) || status=$?
  [[ "$status" == 0 ]]
  [[ "$output" == *'Traffic is within the configured threshold.'* ]]
  if [[ "$check" == sum ]]; then
    [[ "$output" == *'Check: sum = 2048.00 MiB'* ]]
  else
    [[ "$output" == *"Check: $check = 1024.00 MiB"* ]]
  fi
done
status=0
output=$(MONTH_RX='1025 GiB' main --interface eth0 --check rx --limit-gb 1024 2>&1) || status=$?
[[ "$status" == 2 ]]
[[ "$output" == *'Traffic threshold exceeded.'* ]]
for direction in rx tx; do
  status=0
  if [[ "$direction" == rx ]]; then
    output=$(MONTH_RX='1025 GiB' main --interface eth0 --check max --limit-gb 1024 2>&1) || status=$?
  else
    output=$(MONTH_TX='1025 GiB' main --interface eth0 --check max --limit-gb 1024 2>&1) || status=$?
  fi
  [[ "$status" == 2 ]]
  [[ "$output" == *'Check: max = 1049600.00 MiB'* ]]
done
output=$(MONTH_RX='0 B' MONTH_TX='0 B' main --interface eth0 --check sum --limit-gb 1024)
[[ "$output" == *'Check: sum = 0.00 MiB'* ]]

printf 'vnstat traffic firewall tests passed\n'
