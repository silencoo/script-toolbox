#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="${SOURCE_DIR}/$(basename -- "${BASH_SOURCE[0]}")"
MANAGER_BIN="/usr/local/sbin/mihomo-console"
DOC_DIR="/usr/local/share/doc/mihomo-console"
SYSTEMD_DIR="/etc/systemd/system"
MANAGER_CONFIG="/etc/mihomo/subscription-manager.json"
ORIGINAL_ARGS=("$@")
INSTALL_ONLY=false
CORE_VERSION=latest
CONSOLE_LANG=auto
START_CORE=true

usage() {
  cat <<'EOF'
用法 / Usage:
  ./setup.sh                   安装完整应用 / Install the complete application
  ./setup.sh --install-only    仅更新 Console 和订阅刷新单元 / Console files only
  ./setup.sh --core-version v1.19.30  指定稳定版 / Select a stable core release
  ./setup.sh --no-start        新建主服务但不启动 / Do not start a new service
  ./setup.sh --lang zh_CN      中文 / Chinese (auto, zh_CN, en_US)
  ./setup.sh --help

已有内核、主服务和订阅配置将被保留。升级内核请使用 mihomo-console core update。
Existing cores, services and profiles are preserved. Use mihomo-console core update to upgrade.
EOF
}

die() { printf '%s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --install-only) INSTALL_ONLY=true ;;
    --no-start) START_CORE=false ;;
    --core-version)
      (($# >= 2)) || die 'Missing --core-version value'
      CORE_VERSION="$2"; shift
      [[ "$CORE_VERSION" == latest || "$CORE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'Invalid stable version'
      ;;
    --lang)
      (($# >= 2)) || die 'Missing --lang value'
      CONSOLE_LANG="$2"; shift
      case "$CONSOLE_LANG" in auto|zh_CN|en_US) ;; *) die 'Invalid --lang value' ;; esac
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == Linux ]] || die 'Requires Linux with systemd / 需要 Linux 和 systemd'
if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || die 'Requires root or sudo / 需要 root 或 sudo'
  exec sudo -- bash "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
fi
command -v systemctl >/dev/null 2>&1 || die 'systemctl not found / 找不到 systemctl'
systemctl show --property=SystemState --value >/dev/null || die 'systemd is not available / 无法连接 systemd'
for source in mihomo_console.py README.md mihomo-subscription-update.service mihomo-subscription-update.timer; do
  [[ -f "${SOURCE_DIR}/${source}" ]] || die "Missing source: ${source}"
done

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import yaml, ssl; assert ssl.create_default_context().get_ca_certs()' >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die 'Install Python 3, PyYAML and CA certificates first / 请先安装 Python 3、PyYAML 和 CA 证书'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-yaml ca-certificates
fi

install -m 0755 "${SOURCE_DIR}/mihomo_console.py" "$MANAGER_BIN"
ln -sfn "$MANAGER_BIN" /usr/local/sbin/mihomo-subscription-manager
install -d -m 0755 "$DOC_DIR"
install -m 0644 "${SOURCE_DIR}/README.md" "${DOC_DIR}/README.md"
install -m 0644 "${SOURCE_DIR}/mihomo-subscription-update.service" "$SYSTEMD_DIR/"
install -m 0644 "${SOURCE_DIR}/mihomo-subscription-update.timer" "$SYSTEMD_DIR/"
systemctl daemon-reload

if [[ "$INSTALL_ONLY" == true ]]; then
  if [[ -f "$MANAGER_CONFIG" ]]; then
    "$MANAGER_BIN" --lang "$CONSOLE_LANG" configure-systemd-sandbox
  fi
  printf '%s\n' 'Console updated; core, profiles and service state preserved / Console 已更新，内核、订阅和服务状态保留'
  exit 0
fi

INSTALL_ARGS=(--lang "$CONSOLE_LANG" install --version "$CORE_VERSION" --interactive)
if [[ "$START_CORE" == false ]]; then
  INSTALL_ARGS+=(--no-start)
fi
exec "$MANAGER_BIN" "${INSTALL_ARGS[@]}"
