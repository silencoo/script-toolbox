#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONFIG_PATH="/etc/sing-box/config.json"
CERT_PATH="/etc/sing-box/cert.crt"
KEY_PATH="/etc/sing-box/private.key"
LINK_PATH="/root/sing-box-node.txt"
CLIENT_CONFIG_PATH="/root/sing-box-client.json"
BBR_SYSCTL_PATH="${BBR_SYSCTL_PATH:-/etc/sysctl.d/99-sing-box-bbr.conf}"
INSTALLER_URL="${SING_BOX_INSTALLER_URL:-https://sing-box.app/install.sh}"
MIN_SING_BOX_VERSION="1.12.0"

SERVICE_NAME="sing-box"
LISTEN_ADDR="::"
PORT="443"
SNI="www.apple.com"
USER_NAME="default"
NODE_NAME=""
SERVER_HOST=""
PASSWORD=""
SKIP_INSTALL=0
SKIP_BBR=0
ASSUME_YES=0

tmp_config=""
tmp_validation_config=""
tmp_cert=""
tmp_key=""
tmp_link=""
tmp_client_config=""
CONFIG_BACKUP_PATH=""
CERT_BACKUP_PATH=""
KEY_BACKUP_PATH=""
CONFIG_EXISTED=0
CERT_EXISTED=0
KEY_EXISTED=0
CONFIG_TRANSACTION_ACTIVE=0

usage() {
  cat <<'EOF'
Usage:
  ./install-node.sh [options]

Options:
  --name NAME         Node display name used after # in the share link.
  --host HOST         Public IPv4/domain used by clients to connect.
  --port PORT         Server listen port. Default: 443.
  --password PASS     AnyTLS password. Default: auto-generate.
  --sni DOMAIN        TLS SNI and self-signed certificate CN. Default: www.apple.com.
  --user USER         AnyTLS user name in sing-box config. Default: default.
  --link-file PATH    File path for the generated share link. Default: /root/sing-box-node.txt.
  --client-file PATH  File path for the generated client config. Default: /root/sing-box-client.json.
  --skip-install      Skip the official sing-box deb installer.
  --skip-bbr          Do not check or enable BBR congestion control.
  -y, --yes           Non-interactive mode. Use detected/default values.
  -h, --help          Show this help.

Examples:
  ./install-node.sh
  ./install-node.sh --name de-1 --host 1.2.3.4 --port 443
  ./install-node.sh -y --name hk-1 --host hk.example.com --password 'change-me'
EOF
}

log() {
  printf '[sing-box-node] %s\n' "$*"
}

die() {
  printf '[sing-box-node] ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local path
  for path in \
    "${tmp_config}" \
    "${tmp_validation_config}" \
    "${tmp_cert}" \
    "${tmp_key}" \
    "${tmp_link}" \
    "${tmp_client_config}"
  do
    if [[ -n "${path}" && -f "${path}" ]]; then
      rm -f "${path}"
    fi
  done
}
trap cleanup EXIT

handle_error() {
  local status=$?
  trap - ERR
  set +e
  if (( CONFIG_TRANSACTION_ACTIVE )); then
    log "An unexpected error occurred; restoring the previous sing-box files."
    restore_backups
    CONFIG_TRANSACTION_ACTIVE=0
  fi
  exit "${status}"
}
trap handle_error ERR

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "Run this script as root."
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

is_tty() {
  [[ -t 0 && -t 1 ]]
}

is_ipv4() {
  local ip="$1"
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1

  local IFS=.
  local -a parts
  read -r -a parts <<<"${ip}"
  local part
  for part in "${parts[@]}"; do
    [[ "${part}" =~ ^[0-9]+$ ]] || return 1
    (( part >= 0 && part <= 255 )) || return 1
  done
}

detect_public_ipv4() {
  local url value
  for url in \
    "https://api.ipify.org" \
    "https://ifconfig.me/ip" \
    "https://icanhazip.com"
  do
    value="$(curl -4fsS --max-time 5 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv4 "${value}"; then
      printf '%s\n' "${value}"
      return 0
    fi
  done
  return 1
}

sanitize_name() {
  printf '%s' "$1" \
    | tr -c 'A-Za-z0-9._-' '-' \
    | sed -E 's/-+/-/g; s/^-//; s/-$//'
}

default_node_name() {
  local base
  if [[ -n "${SERVER_HOST}" ]]; then
    base="$(sanitize_name "${SERVER_HOST//./-}")"
    if [[ -n "${base}" ]]; then
      printf 'node-%s\n' "${base}"
      return 0
    fi
  fi

  base="$(hostname -s 2>/dev/null || true)"
  base="$(sanitize_name "${base}")"
  if [[ -n "${base}" ]]; then
    printf '%s\n' "${base}"
  else
    printf 'sing-box-node\n'
  fi
}

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local input

  if (( ASSUME_YES )) || ! is_tty; then
    printf '%s\n' "${default_value}"
    return 0
  fi

  if [[ -n "${default_value}" ]]; then
    read -r -p "${prompt} [${default_value}]: " input
    printf '%s\n' "${input:-${default_value}}"
  else
    read -r -p "${prompt}: " input
    printf '%s\n' "${input}"
  fi
}

generate_password() {
  openssl rand -hex 24
}

validate_port() {
  [[ "${PORT}" =~ ^[0-9]+$ ]] || die "Invalid port: ${PORT}"
  (( PORT >= 1 && PORT <= 65535 )) || die "Port out of range: ${PORT}"
}

validate_host() {
  [[ -n "${SERVER_HOST}" ]] || die "Server host is required. Pass --host or run interactively."
  case "${SERVER_HOST}" in
    *[[:space:]]*)
      die "Server host must not contain spaces."
      ;;
    *\"*|*\'*|*/*|*\\*|*\?*|*#*|*%*|*@*|*\[*|*\]*)
      die "Server host contains unsupported URI characters."
      ;;
  esac
}

normalize_server_host() {
  if [[ "${SERVER_HOST}" == \[*\] ]]; then
    SERVER_HOST="${SERVER_HOST:1:${#SERVER_HOST}-2}"
  elif [[ "${SERVER_HOST}" == \[* || "${SERVER_HOST}" == *\] ]]; then
    die "Server host has mismatched IPv6 brackets."
  fi
}

validate_sni() {
  [[ "${SNI}" =~ ^[A-Za-z0-9.-]+$ ]] || die "Invalid SNI: ${SNI}"
}

validate_node_name() {
  [[ "${NODE_NAME}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Invalid node name. Use 1-64 chars: A-Z a-z 0-9 . _ -"
}

validate_user_name() {
  [[ "${USER_NAME}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "Invalid user name. Use 1-64 chars: A-Z a-z 0-9 . _ -"
}

validate_password() {
  [[ -n "${PASSWORD}" ]] || die "Password is required."
  [[ "${PASSWORD}" =~ ^[A-Za-z0-9._~+=:-]{8,128}$ ]] || die "Invalid password. Use 8-128 URI-safe chars: A-Z a-z 0-9 . _ ~ + = : -"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name)
        [[ $# -ge 2 ]] || die "--name requires a value"
        NODE_NAME="$2"
        shift 2
        ;;
      --host)
        [[ $# -ge 2 ]] || die "--host requires a value"
        SERVER_HOST="$2"
        shift 2
        ;;
      --port)
        [[ $# -ge 2 ]] || die "--port requires a value"
        PORT="$2"
        shift 2
        ;;
      --password)
        [[ $# -ge 2 ]] || die "--password requires a value"
        PASSWORD="$2"
        shift 2
        ;;
      --sni)
        [[ $# -ge 2 ]] || die "--sni requires a value"
        SNI="$2"
        shift 2
        ;;
      --user)
        [[ $# -ge 2 ]] || die "--user requires a value"
        USER_NAME="$2"
        shift 2
        ;;
      --link-file)
        [[ $# -ge 2 ]] || die "--link-file requires a value"
        LINK_PATH="$2"
        shift 2
        ;;
      --client-file)
        [[ $# -ge 2 ]] || die "--client-file requires a value"
        CLIENT_CONFIG_PATH="$2"
        shift 2
        ;;
      --skip-install)
        SKIP_INSTALL=1
        shift
        ;;
      --skip-bbr)
        SKIP_BBR=1
        shift
        ;;
      -y|--yes)
        ASSUME_YES=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
  done
}

resolve_inputs() {
  local detected_host default_name generated_password

  if [[ -z "${SERVER_HOST}" ]]; then
    detected_host="$(detect_public_ipv4 || true)"
    SERVER_HOST="$(prompt_with_default "Public server host/IP" "${detected_host}")"
  fi

  normalize_server_host
  validate_host

  if [[ -z "${NODE_NAME}" ]]; then
    default_name="$(default_node_name)"
    NODE_NAME="$(prompt_with_default "Node name" "${default_name}")"
  fi

  if [[ -z "${PASSWORD}" ]]; then
    generated_password="$(generate_password)"
    PASSWORD="$(prompt_with_default "AnyTLS password" "${generated_password}")"
  fi

  PORT="$(prompt_with_default "Listen port" "${PORT}")"
  SNI="$(prompt_with_default "TLS SNI" "${SNI}")"

  validate_port
  validate_sni
  validate_node_name
  validate_user_name
  validate_password
}

install_sing_box() {
  if (( SKIP_INSTALL )); then
    log "Skipping sing-box installer."
    return 0
  fi

  log "Installing sing-box with the official universal installer."
  curl -fsSL "${INSTALLER_URL}" | bash
}

version_at_least() {
  local current="${1%%[-+]*}"
  local required="${2%%[-+]*}"
  local IFS=.
  local -a current_parts required_parts
  local index current_part required_part

  read -r -a current_parts <<<"${current}"
  read -r -a required_parts <<<"${required}"
  for index in 0 1 2; do
    current_part="${current_parts[${index}]:-0}"
    required_part="${required_parts[${index}]:-0}"
    [[ "${current_part}" =~ ^[0-9]+$ && "${required_part}" =~ ^[0-9]+$ ]] || return 1
    if (( 10#${current_part} > 10#${required_part} )); then
      return 0
    fi
    if (( 10#${current_part} < 10#${required_part} )); then
      return 1
    fi
  done
  return 0
}

check_sing_box_version() {
  local version_line version

  need_cmd sing-box
  version_line="$(sing-box version 2>/dev/null | sed -n '1p')"
  version="${version_line#sing-box version }"
  if [[ -z "${version}" || "${version}" == "${version_line}" ]]; then
    die "Unable to determine the installed sing-box version."
  fi
  if ! version_at_least "${version}" "${MIN_SING_BOX_VERSION}"; then
    die "sing-box ${MIN_SING_BOX_VERSION}+ is required for AnyTLS; found ${version}."
  fi
  log "Using sing-box ${version}."
}

sysctl_value() {
  sysctl -n "$1" 2>/dev/null || true
}

congestion_control_available() {
  local algorithms
  algorithms="$(sysctl_value net.ipv4.tcp_available_congestion_control)"
  [[ " ${algorithms} " == *" bbr "* ]]
}

configure_bbr() {
  local current_control current_qdisc original_control original_qdisc config_dir tmp_bbr_config

  if (( SKIP_BBR )); then
    log "Skipping BBR check."
    return 0
  fi

  if ! command -v sysctl >/dev/null 2>&1; then
    log "WARNING: sysctl is unavailable; cannot check or enable BBR."
    return 1
  fi

  current_control="$(sysctl_value net.ipv4.tcp_congestion_control)"
  current_qdisc="$(sysctl_value net.core.default_qdisc)"
  original_control="${current_control}"
  original_qdisc="${current_qdisc}"
  if [[ "${current_control}" == "bbr" && "${current_qdisc}" == "fq" ]]; then
    log "BBR is already enabled (qdisc: fq)."
    return 0
  fi

  if ! congestion_control_available; then
    if command -v modprobe >/dev/null 2>&1; then
      modprobe tcp_bbr >/dev/null 2>&1 || true
    fi
    if ! congestion_control_available; then
      log "WARNING: This kernel does not expose tcp_bbr; leaving congestion control unchanged (${current_control:-unknown})."
      return 1
    fi
  fi

  if command -v modprobe >/dev/null 2>&1; then
    modprobe sch_fq >/dev/null 2>&1 || true
  fi

  if ! sysctl -q -w net.ipv4.tcp_congestion_control=bbr; then
    log "WARNING: Failed to enable BBR."
    return 1
  fi
  if ! sysctl -q -w net.core.default_qdisc=fq; then
    if [[ -n "${original_control}" ]]; then
      sysctl -q -w "net.ipv4.tcp_congestion_control=${original_control}" >/dev/null 2>&1 || true
    fi
    log "WARNING: Failed to set the default qdisc to fq; restored the previous congestion control where possible."
    return 1
  fi

  current_control="$(sysctl_value net.ipv4.tcp_congestion_control)"
  current_qdisc="$(sysctl_value net.core.default_qdisc)"
  if [[ "${current_control}" != "bbr" || "${current_qdisc}" != "fq" ]]; then
    if [[ -n "${original_control}" ]]; then
      sysctl -q -w "net.ipv4.tcp_congestion_control=${original_control}" >/dev/null 2>&1 || true
    fi
    if [[ -n "${original_qdisc}" ]]; then
      sysctl -q -w "net.core.default_qdisc=${original_qdisc}" >/dev/null 2>&1 || true
    fi
    log "WARNING: BBR verification failed (congestion control: ${current_control:-unknown}, qdisc: ${current_qdisc:-unknown})."
    return 1
  fi

  config_dir="$(dirname "${BBR_SYSCTL_PATH}")"
  if ! mkdir -p "${config_dir}"; then
    log "WARNING: BBR is active for this boot, but ${config_dir} could not be created for persistence."
    return 1
  fi
  if ! tmp_bbr_config="$(mktemp "${BBR_SYSCTL_PATH}.tmp.XXXXXX")"; then
    log "WARNING: BBR is active for this boot, but a temporary sysctl file could not be created."
    return 1
  fi
  if ! printf '%s\n' \
    'net.core.default_qdisc = fq' \
    'net.ipv4.tcp_congestion_control = bbr' >"${tmp_bbr_config}"; then
    rm -f "${tmp_bbr_config}"
    log "WARNING: BBR is active for this boot, but its persistent configuration could not be written."
    return 1
  fi
  if ! chmod 644 "${tmp_bbr_config}"; then
    rm -f "${tmp_bbr_config}"
    log "WARNING: BBR is active for this boot, but its persistent configuration permissions could not be set."
    return 1
  fi
  if ! mv "${tmp_bbr_config}" "${BBR_SYSCTL_PATH}"; then
    rm -f "${tmp_bbr_config}"
    log "WARNING: BBR is active for this boot, but ${BBR_SYSCTL_PATH} could not be installed."
    return 1
  fi

  log "BBR enabled and persisted in ${BBR_SYSCTL_PATH} (qdisc: fq)."
}

backup_existing_files() {
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S).$$"

  if [[ -f "${CONFIG_PATH}" ]]; then
    CONFIG_EXISTED=1
    CONFIG_BACKUP_PATH="${CONFIG_PATH}.bak.${timestamp}"
    cp -a "${CONFIG_PATH}" "${CONFIG_BACKUP_PATH}"
    log "Backed up existing config to ${CONFIG_BACKUP_PATH}"
  fi

  if [[ -f "${CERT_PATH}" ]]; then
    CERT_EXISTED=1
    CERT_BACKUP_PATH="${CERT_PATH}.bak.${timestamp}"
    cp -a "${CERT_PATH}" "${CERT_BACKUP_PATH}"
  fi

  if [[ -f "${KEY_PATH}" ]]; then
    KEY_EXISTED=1
    KEY_BACKUP_PATH="${KEY_PATH}.bak.${timestamp}"
    cp -a "${KEY_PATH}" "${KEY_BACKUP_PATH}"
  fi
}

restore_backups() {
  if (( CONFIG_EXISTED )) && [[ -f "${CONFIG_BACKUP_PATH}" ]]; then
    cp -a "${CONFIG_BACKUP_PATH}" "${CONFIG_PATH}"
    log "Restored previous config from ${CONFIG_BACKUP_PATH}"
  elif (( ! CONFIG_EXISTED )); then
    rm -f "${CONFIG_PATH}"
  fi

  if (( CERT_EXISTED )) && [[ -f "${CERT_BACKUP_PATH}" ]]; then
    cp -a "${CERT_BACKUP_PATH}" "${CERT_PATH}"
  elif (( ! CERT_EXISTED )); then
    rm -f "${CERT_PATH}"
  fi

  if (( KEY_EXISTED )) && [[ -f "${KEY_BACKUP_PATH}" ]]; then
    cp -a "${KEY_BACKUP_PATH}" "${KEY_PATH}"
  elif (( ! KEY_EXISTED )); then
    rm -f "${KEY_PATH}"
  fi
}

write_server_config() {
  local output_path="$1"
  local certificate_path="$2"
  local key_path="$3"

  cat >"${output_path}" <<EOF
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "anytls",
      "tag": "anytls-in",
      "listen": "${LISTEN_ADDR}",
      "listen_port": ${PORT},
      "users": [
        {
          "name": "${USER_NAME}",
          "password": "${PASSWORD}"
        }
      ],
      "tls": {
        "enabled": true,
        "certificate_path": "${certificate_path}",
        "key_path": "${key_path}"
      }
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    }
  ]
}
EOF
}

write_config() {
  local service_group

  mkdir -p "$(dirname "${CONFIG_PATH}")" "$(dirname "${CERT_PATH}")" "$(dirname "${KEY_PATH}")"
  tmp_config="$(mktemp "${CONFIG_PATH}.tmp.XXXXXX")"
  tmp_validation_config="$(mktemp "${CONFIG_PATH}.validate.XXXXXX")"
  tmp_cert="$(mktemp "${CERT_PATH}.tmp.XXXXXX")"
  tmp_key="$(mktemp "${KEY_PATH}.tmp.XXXXXX")"

  log "Generating a staged self-signed certificate for SNI ${SNI}."
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "${tmp_key}" \
    -out "${tmp_cert}" \
    -subj "/CN=${SNI}"

  write_server_config "${tmp_validation_config}" "${tmp_cert}" "${tmp_key}"
  log "Checking staged sing-box config before replacing existing files."
  sing-box check -c "${tmp_validation_config}"
  rm -f "${tmp_validation_config}"
  tmp_validation_config=""

  write_server_config "${tmp_config}" "${CERT_PATH}" "${KEY_PATH}"
  backup_existing_files
  CONFIG_TRANSACTION_ACTIVE=1

  mv "${tmp_key}" "${KEY_PATH}"
  tmp_key=""
  mv "${tmp_cert}" "${CERT_PATH}"
  tmp_cert=""

  mv "${tmp_config}" "${CONFIG_PATH}"
  tmp_config=""

  service_group="$(id -gn sing-box 2>/dev/null || true)"
  if [[ -n "${service_group}" ]]; then
    chown root:"${service_group}" "${CONFIG_PATH}" "${KEY_PATH}" "${CERT_PATH}" || true
    chmod 640 "${CONFIG_PATH}" "${KEY_PATH}"
    chmod 644 "${CERT_PATH}"
  else
    chown root:root "${CONFIG_PATH}" "${KEY_PATH}" "${CERT_PATH}" || true
    chmod 600 "${CONFIG_PATH}" "${KEY_PATH}"
    chmod 644 "${CERT_PATH}"
  fi
}

check_config() {
  log "Checking sing-box config."
  if ! sing-box check -c "${CONFIG_PATH}"; then
    restore_backups
    CONFIG_TRANSACTION_ACTIVE=0
    die "sing-box config check failed."
  fi
}

restart_service() {
  need_cmd systemctl
  log "Enabling and restarting ${SERVICE_NAME}."
  if ! systemctl enable "${SERVICE_NAME}"; then
    restore_backups
    CONFIG_TRANSACTION_ACTIVE=0
    die "Failed to enable ${SERVICE_NAME}."
  fi
  if ! systemctl restart "${SERVICE_NAME}"; then
    systemctl status --no-pager "${SERVICE_NAME}" || true
    restore_backups
    CONFIG_TRANSACTION_ACTIVE=0
    if (( CONFIG_EXISTED )); then
      log "Trying to restart ${SERVICE_NAME} with the restored config."
      systemctl restart "${SERVICE_NAME}" || true
    fi
    die "Failed to restart ${SERVICE_NAME}."
  fi

  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    systemctl status --no-pager "${SERVICE_NAME}" || true
    restore_backups
    CONFIG_TRANSACTION_ACTIVE=0
    if (( CONFIG_EXISTED )); then
      log "Trying to restart ${SERVICE_NAME} with the restored config."
      systemctl restart "${SERVICE_NAME}" || true
    fi
    die "${SERVICE_NAME} is not active after restart."
  fi
  CONFIG_TRANSACTION_ACTIVE=0
}

uri_host() {
  if [[ "${SERVER_HOST}" == *:* && "${SERVER_HOST}" != \[*\] ]]; then
    printf '[%s]\n' "${SERVER_HOST}"
  else
    printf '%s\n' "${SERVER_HOST}"
  fi
}

write_link() {
  local host_for_uri node_link
  host_for_uri="$(uri_host)"
  node_link="anytls://${PASSWORD}@${host_for_uri}:${PORT}?sni=${SNI}&insecure=1#${NODE_NAME}"

  mkdir -p "$(dirname "${LINK_PATH}")"
  tmp_link="$(mktemp "${LINK_PATH}.tmp.XXXXXX")"
  printf '%s\n' "${node_link}" >"${tmp_link}"
  chmod 600 "${tmp_link}"
  mv "${tmp_link}" "${LINK_PATH}"
  tmp_link=""

  log "Node link saved to ${LINK_PATH}"
  printf '\n%s\n\n' "${node_link}"
}

write_client_config() {
  mkdir -p "$(dirname "${CLIENT_CONFIG_PATH}")"
  tmp_client_config="$(mktemp "${CLIENT_CONFIG_PATH}.tmp.XXXXXX")"

  cat >"${tmp_client_config}" <<EOF
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "dns-remote",
        "type": "https",
        "server": "1.1.1.1",
        "detour": "anytls-out"
      },
      {
        "tag": "dns-local",
        "type": "udp",
        "server": "223.5.5.5"
      }
    ],
    "rules": [
      {
        "rule_set": "geosite-cn",
        "server": "dns-local"
      },
      {
        "type": "default",
        "server": "dns-remote"
      }
    ]
  },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 2080
    }
  ],
  "outbounds": [
    {
      "type": "anytls",
      "tag": "anytls-out",
      "server": "${SERVER_HOST}",
      "server_port": ${PORT},
      "password": "${PASSWORD}",
      "tls": {
        "enabled": true,
        "server_name": "${SNI}",
        "insecure": true
      }
    },
    {
      "type": "direct",
      "tag": "direct"
    }
  ],
  "route": {
    "rule_set": [
      {
        "tag": "geosite-cn",
        "type": "remote",
        "format": "binary",
        "url": "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
        "download_detour": "anytls-out"
      },
      {
        "tag": "geoip-cn",
        "type": "remote",
        "format": "binary",
        "url": "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
        "download_detour": "anytls-out"
      }
    ],
    "rules": [
      {
        "inbound": "mixed-in",
        "action": "sniff"
      },
      {
        "protocol": "dns",
        "action": "hijack-dns"
      },
      {
        "ip_is_private": true,
        "outbound": "direct"
      },
      {
        "rule_set": [
          "geosite-cn",
          "geoip-cn"
        ],
        "outbound": "direct"
      }
    ],
    "auto_detect_interface": true,
    "final": "anytls-out",
    "default_domain_resolver": "dns-local"
  },
  "experimental": {
    "cache_file": {
      "enabled": true
    }
  }
}
EOF

  chmod 600 "${tmp_client_config}"
  mv "${tmp_client_config}" "${CLIENT_CONFIG_PATH}"
  tmp_client_config=""
  log "Client config saved to ${CLIENT_CONFIG_PATH}"
}

main() {
  parse_args "$@"

  require_root
  need_cmd curl
  need_cmd openssl
  need_cmd sed
  need_cmd tr

  resolve_inputs
  install_sing_box
  check_sing_box_version
  if ! configure_bbr; then
    log "WARNING: BBR setup was unavailable or incomplete; continuing sing-box installation."
  fi
  write_config
  check_config
  restart_service
  write_link
  write_client_config
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
