#!/usr/bin/env bash
# Report calendar-month vnStat usage and optionally enforce a dedicated firewall chain.
set -euo pipefail

LIMIT_GB=1024
CHECK_TYPE=sum
INTERFACE=""
SSH_PORT=22
ENFORCE=0
DRY_RUN=0
CHAIN=TOOLBOX_VNSTAT_LIMIT

usage() {
  cat <<'EOF'
Usage: vnstat-traffic-firewall.sh [options]

Options:
  --limit-gb NUMBER        Monthly threshold in GiB (default: 1024)
  --check rx|tx|max|sum    Traffic value to compare (default: sum)
  --interface NAME         Interface; defaults to the IPv4 default route
  --ssh-port PORT          TCP port kept reachable when enforcing (default: 22)
  --enforce                Apply/remove the dedicated iptables chain
  --dry-run                Print firewall commands without executing them
  -h, --help               Show this help

Without --enforce the script is read-only. It never deletes vnStat data,
flushes unrelated iptables rules, or changes built-in chain policies.
EOF
}

die() {
  printf '[ERR] %s\n' "$*" >&2
  exit 1
}

to_mib() {
  local raw="$1"
  awk -v raw="$raw" 'BEGIN {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw)
    split(raw, part, /[[:space:]]+/)
    value = part[1] + 0
    unit = part[2]
    if (unit == "KiB") value /= 1024
    else if (unit == "GiB") value *= 1024
    else if (unit == "TiB") value *= 1024 * 1024
    else if (unit != "MiB") exit 2
    printf "%.6f\n", value
  }'
}

run_iptables() {
  if (( DRY_RUN )); then
    printf '[DRY-RUN]'
    printf ' %q' iptables "$@"
    printf '\n'
  else
    iptables "$@"
  fi
}

chain_exists() {
  iptables -nL "$CHAIN" >/dev/null 2>&1
}

jump_exists() {
  iptables -C INPUT -j "$CHAIN" >/dev/null 2>&1
}

remove_managed_chain() {
  if jump_exists; then
    run_iptables -D INPUT -j "$CHAIN"
  fi
  if chain_exists; then
    run_iptables -F "$CHAIN"
    run_iptables -X "$CHAIN"
  fi
}

apply_managed_chain() {
  chain_exists || run_iptables -N "$CHAIN"
  run_iptables -F "$CHAIN"
  run_iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  run_iptables -A "$CHAIN" -i lo -j ACCEPT
  run_iptables -A "$CHAIN" -p tcp --dport "$SSH_PORT" -j ACCEPT
  run_iptables -A "$CHAIN" -j REJECT
  jump_exists || run_iptables -I INPUT 1 -j "$CHAIN"
}

main() {
  while (($#)); do
    case "$1" in
      --limit-gb) shift; (($#)) || die '--limit-gb requires a value'; LIMIT_GB="$1" ;;
      --check) shift; (($#)) || die '--check requires a value'; CHECK_TYPE="$1" ;;
      --interface) shift; (($#)) || die '--interface requires a value'; INTERFACE="$1" ;;
      --ssh-port) shift; (($#)) || die '--ssh-port requires a value'; SSH_PORT="$1" ;;
      --enforce) ENFORCE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) usage; return 0 ;;
      *) die "unknown argument: $1" ;;
    esac
    shift
  done

  [[ "$LIMIT_GB" =~ ^[0-9]+([.][0-9]+)?$ ]] || die '--limit-gb must be a positive number'
  awk -v n="$LIMIT_GB" 'BEGIN { exit !(n > 0) }' || die '--limit-gb must be greater than zero'
  [[ "$CHECK_TYPE" =~ ^(rx|tx|max|sum)$ ]] || die '--check must be rx, tx, max, or sum'
  [[ "$SSH_PORT" =~ ^[0-9]+$ ]] && (( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || die 'invalid SSH port'
  command -v vnstat >/dev/null 2>&1 || die 'vnstat is required'

  if [[ -z "$INTERFACE" ]]; then
    command -v ip >/dev/null 2>&1 || die 'ip is required to detect the default interface'
    INTERFACE=$(ip route show default | awk 'NR == 1 {print $5}')
  fi
  [[ -n "$INTERFACE" ]] || die 'unable to determine an interface'

  local data current_date rx_raw tx_raw rx_mib tx_mib checked_mib limit_mib
  data=$(vnstat -i "$INTERFACE" --oneline)
  current_date=$(awk -F';' '{print $8}' <<<"$data")
  rx_raw=$(awk -F';' '{print $13}' <<<"$data")
  tx_raw=$(awk -F';' '{print $14}' <<<"$data")
  [[ -n "$rx_raw" && -n "$tx_raw" ]] || die 'vnstat returned an unsupported --oneline format'
  rx_mib=$(to_mib "$rx_raw") || die "unsupported receive unit: $rx_raw"
  tx_mib=$(to_mib "$tx_raw") || die "unsupported transmit unit: $tx_raw"

  case "$CHECK_TYPE" in
    rx) checked_mib="$rx_mib" ;;
    tx) checked_mib="$tx_mib" ;;
    max) checked_mib=$(awk -v rx="$rx_mib" -v tx="$tx_mib" 'BEGIN {print rx > tx ? rx : tx}') ;;
    sum) checked_mib=$(awk -v rx="$rx_mib" -v tx="$tx_mib" 'BEGIN {print rx + tx}') ;;
  esac
  limit_mib=$(awk -v gb="$LIMIT_GB" 'BEGIN {print gb * 1024}')

  printf 'Interface: %s\nPeriod: %s\nRX: %.2f MiB\nTX: %.2f MiB\nCheck: %s = %.2f MiB\nLimit: %.2f MiB\n' \
    "$INTERFACE" "${current_date:-current month}" "$rx_mib" "$tx_mib" \
    "$CHECK_TYPE" "$checked_mib" "$limit_mib"

  if awk -v used="$checked_mib" -v limit="$limit_mib" 'BEGIN {exit !(used > limit)}'; then
    printf '[WARN] Traffic threshold exceeded.\n' >&2
    if (( ENFORCE )); then
      (( EUID == 0 )) || die '--enforce requires root'
      command -v iptables >/dev/null 2>&1 || die 'iptables is required for --enforce'
      apply_managed_chain
      printf '[OK] Applied dedicated chain %s; existing firewall policy was preserved.\n' "$CHAIN"
    else
      printf '[INFO] Report only; use --enforce to apply the dedicated chain.\n' >&2
      return 2
    fi
  else
    printf '[OK] Traffic is within the configured threshold.\n'
    if (( ENFORCE )); then
      (( EUID == 0 )) || die '--enforce requires root'
      command -v iptables >/dev/null 2>&1 || die 'iptables is required for --enforce'
      remove_managed_chain
      printf '[OK] Removed any existing %s chain.\n' "$CHAIN"
    fi
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
