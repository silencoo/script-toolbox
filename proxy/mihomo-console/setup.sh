#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="${SOURCE_DIR}/$(basename -- "${BASH_SOURCE[0]}")"
MANAGER_BIN="/usr/local/sbin/mihomo-console"
DOC_DIR="/usr/local/share/doc/mihomo-console"
LIB_DIR="/usr/local/lib/mihomo-console"
WEB_PYTHON="${LIB_DIR}/venv/bin/python"
WEB_SERVICE="mihomo-console-web.service"
SYSTEMD_DIR="/etc/systemd/system"
MANAGER_CONFIG="/etc/mihomo/subscription-manager.json"
ORIGINAL_ARGS=("$@")
INSTALL_ONLY=false
CORE_VERSION=latest
CONSOLE_LANG=auto
START_CORE=true
WEB_ACCESS=""

usage() {
  cat <<'EOF'
用法 / Usage:
  ./setup.sh                   安装完整应用 / Install the complete application
  ./setup.sh --install-only    更新 Console 并启动 Web UI / Update Console and start Web UI
  ./setup.sh --core-version v1.19.30  指定稳定版 / Select a stable core release
  ./setup.sh --no-start        安装服务但不启动 / Install services without starting them
  ./setup.sh --lang zh_CN      中文 / Chinese (auto, zh_CN, en_US)
  ./setup.sh --web-lan         Web UI 开放到局域网 / Open Web UI to LAN
  ./setup.sh --web-local       Web UI 仅本机访问 / Keep Web UI local only
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
    --web-lan|--web-local)
      [[ -z "$WEB_ACCESS" ]] || die 'Choose only one Web UI access option / 只能选择一个 Web UI 访问选项'
      if [[ "$1" == --web-lan ]]; then WEB_ACCESS=--lan; else WEB_ACCESS=--local; fi
      ;;
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
for source in mihomo_console.py web_server.py requirements.txt web/index.html web/app.js web/styles.css web/favicon.svg web/favicon.ico web/favicon-32.png web/app-icon.png web/apple-touch-icon.png README.md mihomo-console-web.service mihomo-subscription-update.service mihomo-subscription-update.timer; do
  [[ -f "${SOURCE_DIR}/${source}" ]] || die "Missing source: ${source}"
done

if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import yaml, ssl, ensurepip; assert ssl.create_default_context().get_ca_certs()' >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die 'Install Python 3 and requirements.txt dependencies first / 请先安装 Python 3 和 requirements.txt 依赖'
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-yaml python3-venv ca-certificates
fi
python3 -c 'import sys; assert sys.version_info >= (3, 9)' || die 'Web UI requires Python 3.9 or newer / Web UI 需要 Python 3.9 或更新版本'

install -d -m 0755 "$LIB_DIR"
if [[ ! -x "$WEB_PYTHON" ]]; then
  python3 -m venv "${LIB_DIR}/venv"
fi
if ! "$WEB_PYTHON" -c 'from importlib.metadata import version; import yaml, flask, waitress, ssl; assert ssl.create_default_context().get_ca_certs(); assert (6, 0) <= tuple(map(int, version("PyYAML").split(".")[:2])) < (7,); assert (3, 1) <= tuple(map(int, version("Flask").split(".")[:2])) < (4,); assert (3, 0, 2) <= tuple(map(int, version("waitress").split("."))) < (4,)' >/dev/null 2>&1; then
  "$WEB_PYTHON" -m pip install --disable-pip-version-check -r "${SOURCE_DIR}/requirements.txt"
fi

install -m 0755 "${SOURCE_DIR}/mihomo_console.py" "$MANAGER_BIN"
# Keep the installed CLI, timer and Web UI on the same permanent dependencies.
sed -i "1c\\#!${WEB_PYTHON}" "$MANAGER_BIN"
install -d -m 0755 "$LIB_DIR/web"
install -m 0644 "${SOURCE_DIR}/mihomo_console.py" "${SOURCE_DIR}/web_server.py" "${SOURCE_DIR}/requirements.txt" "$LIB_DIR/"
install -m 0644 "${SOURCE_DIR}/web/index.html" "${SOURCE_DIR}/web/app.js" "${SOURCE_DIR}/web/styles.css" "${SOURCE_DIR}/web/favicon.svg" \
  "${SOURCE_DIR}/web/favicon.ico" "${SOURCE_DIR}/web/favicon-32.png" "${SOURCE_DIR}/web/app-icon.png" "${SOURCE_DIR}/web/apple-touch-icon.png" "$LIB_DIR/web/"
ln -sfn "$MANAGER_BIN" "${MANAGER_BIN%/*}/mihomo-subscription-manager"
install -d -m 0755 "$DOC_DIR"
install -m 0644 "${SOURCE_DIR}/README.md" "${DOC_DIR}/README.md"
install -m 0644 "${SOURCE_DIR}/mihomo-subscription-update.service" "$SYSTEMD_DIR/"
install -m 0644 "${SOURCE_DIR}/mihomo-subscription-update.timer" "$SYSTEMD_DIR/"
install -m 0644 "${SOURCE_DIR}/${WEB_SERVICE}" "$SYSTEMD_DIR/"
systemctl daemon-reload

configure_web_service() {
  [[ -f "$MANAGER_CONFIG" ]] || return 0
  if [[ -n "$WEB_ACCESS" ]]; then
    "$MANAGER_BIN" --lang "$CONSOLE_LANG" --manager-config "$MANAGER_CONFIG" web-access "$WEB_ACCESS" --no-restart
  fi
  if [[ "$START_CORE" == true ]]; then
    systemctl enable "$WEB_SERVICE"
    # Intentional reinstalls can otherwise exhaust the unit's crash-loop limit.
    systemctl reset-failed "$WEB_SERVICE"
    systemctl restart "$WEB_SERVICE"
    # Catch immediate startup failures instead of reporting a successful install.
    sleep 2
    systemctl is-active --quiet "$WEB_SERVICE" || die 'Web UI startup failed; check journalctl -u mihomo-console-web.service / Web UI 启动失败，请查看服务日志'
    printf '%s\n' 'Web UI started: http://localhost:28743 (default) / Web UI 已启动（默认地址）' \
      'Web UI address and token: sudo mihomo-console → w → v / TUI 查看地址和令牌；o 切换局域网访问'
  fi
}

if [[ "$INSTALL_ONLY" == true ]]; then
  if [[ -f "$MANAGER_CONFIG" ]]; then
    "$MANAGER_BIN" --lang "$CONSOLE_LANG" --manager-config "$MANAGER_CONFIG" configure-systemd-sandbox
    configure_web_service
  fi
  printf '%s\n' 'Console updated; existing core, profiles and subscription timer preserved / Console 已更新，已有内核、订阅和定时器保留'
  exit 0
fi

INSTALL_ARGS=(--lang "$CONSOLE_LANG" --manager-config "$MANAGER_CONFIG" install --version "$CORE_VERSION")
if [[ "$START_CORE" == false ]]; then
  INSTALL_ARGS+=(--no-start)
fi
"$MANAGER_BIN" "${INSTALL_ARGS[@]}"
configure_web_service
# Start the Web UI before onboarding opens the long-running terminal interface.
exec "$WEB_PYTHON" -c 'from pathlib import Path; import sys; sys.path.insert(0, sys.argv[1]); import mihomo_console as manager; manager.set_language(sys.argv[2]); manager.onboard(Path(sys.argv[3]))' "$LIB_DIR" "$CONSOLE_LANG" "$MANAGER_CONFIG"
