#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=../tools/cloudflare-ddns-ipv4.sh
source "$SCRIPT_DIR/../tools/cloudflare-ddns-ipv4.sh"

is_ipv4 1.2.3.4
! is_ipv4 999.2.3.4
! is_public_ipv4 10.0.0.1
! is_public_ipv4 198.51.100.10
is_public_ipv4 8.8.8.8

ALLOWED_PREFIXES="8.8.,1.1.1."
allowed_by_prefix 8.8.4.4
! allowed_by_prefix 9.9.9.9

output=$(CF_RECORD_NAME=dns.example.test IP_OVERRIDE=8.8.8.8 main --dry-run)
grep -q 'Would update dns.example.test to 8.8.8.8' <<<"$output"

printf 'cloudflare-ddns tests passed\n'
