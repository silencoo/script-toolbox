#!/usr/bin/env bash
# Update one Cloudflare A record from a detected public IPv4 address.
# License: MIT
set -euo pipefail

CF_API_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE_ID="${CF_ZONE_ID:-}"
CF_RECORD_NAME="${CF_RECORD_NAME:-}"
CF_RECORD_ID="${CF_RECORD_ID:-}"
CF_API_BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
CF_PROXIED="${CF_PROXIED:-false}"
CF_TTL="${CF_TTL:-300}"
CF_PROXY="${CF_PROXY:-}"
ALLOWED_PREFIXES="${ALLOWED_PREFIXES:-}"
INCLUDE_IFACES="${INCLUDE_IFACES:-^eth0$|^pppoe-|^en}"
EXCLUDE_IFACES="${EXCLUDE_IFACES:-^lo$|^docker|^br-|^veth}"
IP_OVERRIDE="${IP_OVERRIDE:-}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: cloudflare-ddns-ipv4.sh [--dry-run] [--ip IPV4]

Required environment variables for an update:
  CF_API_TOKEN     API token with DNS Write permission
  CF_ZONE_ID       Cloudflare zone identifier
  CF_RECORD_NAME   Full A-record name

Optional environment variables:
  CF_RECORD_ID       Existing record ID; auto-discovered when omitted
  CF_PROXIED         true or false (default: false)
  CF_TTL             1 for automatic, or 60-86400 (default: 300)
  CF_PROXY           curl proxy URL
  ALLOWED_PREFIXES   Comma-separated textual IPv4 prefixes; empty allows all
  INCLUDE_IFACES     Regex for eligible local interfaces
  EXCLUDE_IFACES     Regex for excluded local interfaces
  IP_OVERRIDE        Explicit candidate address, useful for controlled runs

--dry-run detects and validates an address without calling Cloudflare.
EOF
}

die() {
  printf '[ERR] %s\n' "$*" >&2
  exit 1
}

is_ipv4() {
  local ip="$1" a b c d extra
  IFS=. read -r a b c d extra <<<"$ip"
  [[ -z "${extra:-}" && -n "${a:-}" && -n "${b:-}" && -n "${c:-}" && -n "${d:-}" ]] || return 1
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

ip2int() {
  local ip="$1" a b c d
  IFS=. read -r a b c d <<<"$ip"
  printf '%u\n' "$(( (10#$a << 24) + (10#$b << 16) + (10#$c << 8) + 10#$d ))"
}

is_public_ipv4() {
  local ip="$1" x cidr net bits n mask
  is_ipv4 "$ip" || return 1
  x=$(ip2int "$ip")
  for cidr in \
    0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
    169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 \
    192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 \
    224.0.0.0/4 240.0.0.0/4; do
    net=${cidr%/*}
    bits=${cidr#*/}
    n=$(ip2int "$net")
    mask=$(( 0xFFFFFFFF << (32 - bits) & 0xFFFFFFFF ))
    (( (x & mask) == (n & mask) )) && return 1
  done
  return 0
}

allowed_by_prefix() {
  local ip="$1" prefix
  [[ -z "$ALLOWED_PREFIXES" ]] && return 0
  IFS=, read -ra prefixes <<<"$ALLOWED_PREFIXES"
  for prefix in "${prefixes[@]}"; do
    prefix=${prefix//[[:space:]]/}
    [[ -n "$prefix" && "$ip" == "$prefix"* ]] && return 0
  done
  return 1
}

pick_candidate_ip() {
  local iface ip endpoint
  if [[ -n "$IP_OVERRIDE" ]]; then
    is_public_ipv4 "$IP_OVERRIDE" || return 1
    printf '%s\n' "$IP_OVERRIDE"
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    while IFS=, read -r iface ip; do
      [[ -n "$iface" && -n "$ip" ]] || continue
      [[ -n "$INCLUDE_IFACES" && ! "$iface" =~ $INCLUDE_IFACES ]] && continue
      [[ -n "$EXCLUDE_IFACES" && "$iface" =~ $EXCLUDE_IFACES ]] && continue
      if is_public_ipv4 "$ip"; then
        printf '%s\n' "$ip"
        return 0
      fi
    done < <(ip -o -4 addr show | awk '{split($4, address, "/"); print $2 "," address[1]}')
  fi

  command -v curl >/dev/null 2>&1 || return 1
  for endpoint in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
    ip=$(curl -fsS --max-time 8 "$endpoint" 2>/dev/null | tr -d '\r\n') || continue
    if is_public_ipv4 "$ip"; then
      printf '%s\n' "$ip"
      return 0
    fi
  done
  return 1
}

cf_api() {
  local method="$1" url="$2"
  shift 2
  local -a args=(-fsS -X "$method" -H "Authorization: Bearer ${CF_API_TOKEN}" -H 'Content-Type: application/json')
  [[ -n "$CF_PROXY" ]] && args+=(--proxy "$CF_PROXY")
  curl "${args[@]}" "$url" "$@"
}

validate_config() {
  local ttl_number
  [[ "$CF_PROXIED" == true || "$CF_PROXIED" == false ]] || die 'CF_PROXIED must be true or false'
  [[ "$CF_TTL" =~ ^[0-9]+$ ]] || die 'CF_TTL must be an integer'
  ttl_number=$((10#$CF_TTL))
  (( ttl_number == 1 || (ttl_number >= 60 && ttl_number <= 86400) )) || die 'CF_TTL must be 1 or between 60 and 86400'
  CF_TTL="$ttl_number"
}

main() {
  while (($#)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --ip) shift; (($#)) || die '--ip requires a value'; IP_OVERRIDE="$1" ;;
      -h|--help) usage; return 0 ;;
      *) die "unknown argument: $1" ;;
    esac
    shift
  done

  validate_config
  [[ -n "$CF_RECORD_NAME" ]] || die 'CF_RECORD_NAME is required'

  local new_ip
  new_ip=$(pick_candidate_ip) || die 'no usable public IPv4 address found'
  printf '[INFO] Candidate public IP: %s\n' "$new_ip"
  allowed_by_prefix "$new_ip" || {
    printf '[INFO] %s is outside ALLOWED_PREFIXES; no update performed.\n' "$new_ip"
    return 0
  }

  if (( DRY_RUN )); then
    printf '[DRY-RUN] Would update %s to %s (proxied=%s, ttl=%s).\n' \
      "$CF_RECORD_NAME" "$new_ip" "$CF_PROXIED" "$CF_TTL"
    return 0
  fi

  [[ -n "$CF_API_TOKEN" ]] || die 'CF_API_TOKEN is required'
  [[ -n "$CF_ZONE_ID" ]] || die 'CF_ZONE_ID is required'
  command -v curl >/dev/null 2>&1 || die 'curl is required'
  command -v jq >/dev/null 2>&1 || die 'jq is required'

  local record_response record_id current_ip encoded_name payload response error_message
  if [[ -n "$CF_RECORD_ID" ]]; then
    record_response=$(cf_api GET "${CF_API_BASE}/zones/${CF_ZONE_ID}/dns_records/${CF_RECORD_ID}")
  else
    encoded_name=$(jq -rn --arg value "$CF_RECORD_NAME" '$value | @uri')
    record_response=$(cf_api GET "${CF_API_BASE}/zones/${CF_ZONE_ID}/dns_records?type=A&name=${encoded_name}")
  fi

  if ! jq -e '.success == true' >/dev/null <<<"$record_response"; then
    error_message=$(jq -r '.errors[0].message // "record lookup failed"' <<<"$record_response")
    die "$error_message"
  fi

  if [[ -n "$CF_RECORD_ID" ]]; then
    record_id=$(jq -r '.result.id // empty' <<<"$record_response")
    current_ip=$(jq -r '.result.content // empty' <<<"$record_response")
  else
    record_id=$(jq -r '.result[0].id // empty' <<<"$record_response")
    current_ip=$(jq -r '.result[0].content // empty' <<<"$record_response")
  fi
  [[ -n "$record_id" ]] || die "A record not found: $CF_RECORD_NAME"

  if [[ "$current_ip" == "$new_ip" ]]; then
    printf '[INFO] Already current: %s -> %s\n' "$CF_RECORD_NAME" "$current_ip"
    return 0
  fi

  payload=$(jq -nc \
    --arg name "$CF_RECORD_NAME" \
    --arg content "$new_ip" \
    --argjson ttl "$CF_TTL" \
    --argjson proxied "$CF_PROXIED" \
    '{type:"A", name:$name, content:$content, ttl:$ttl, proxied:$proxied}')

  response=$(cf_api PATCH "${CF_API_BASE}/zones/${CF_ZONE_ID}/dns_records/${record_id}" --data "$payload")
  if jq -e '.success == true' >/dev/null <<<"$response"; then
    printf '[OK] Updated %s -> %s (proxied=%s, ttl=%s)\n' \
      "$CF_RECORD_NAME" "$new_ip" "$CF_PROXIED" "$CF_TTL"
  else
    error_message=$(jq -r '.errors[0].message // "update failed"' <<<"$response")
    die "$error_message"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
