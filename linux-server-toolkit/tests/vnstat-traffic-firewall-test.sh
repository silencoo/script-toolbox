#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../tools/vnstat-traffic-firewall.sh
source "$SCRIPT_DIR/../tools/vnstat-traffic-firewall.sh"

[[ "$(to_mib '1024 KiB')" == "1.000000" ]]
[[ "$(to_mib '1 GiB')" == "1024.000000" ]]
[[ "$(to_mib '2 MiB')" == "2.000000" ]]
! to_mib '1 bananas' >/dev/null 2>&1

printf 'vnstat traffic firewall tests passed\n'
