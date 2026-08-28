#!/usr/bin/env bash

set -Eeuo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="${SOURCE_DIR}/$(basename -- "${BASH_SOURCE[0]}")"
MANAGER_SOURCE="${SOURCE_DIR}/mihomo_console.py"
SERVICE_SOURCE="${SOURCE_DIR}/mihomo-subscription-update.service"
TIMER_SOURCE="${SOURCE_DIR}/mihomo-subscription-update.timer"
README_SOURCE="${SOURCE_DIR}/README.md"

MANAGER_BIN="/usr/local/sbin/mihomo-console"
LEGACY_MANAGER_BIN="/usr/local/sbin/mihomo-subscription-manager"
DOC_DIR="/usr/local/share/doc/mihomo-console"
SYSTEMD_DIR="/etc/systemd/system"
MANAGER_CONFIG="/etc/mihomo/subscription-manager.json"

INSTALL_ONLY=false

say() {
  printf '%s\n' "$*"
}

warn() {
  printf '警告：%s\n' "$*" >&2
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：
  ./setup.sh                 安装并进入初始化向导
  ./setup.sh --install-only  只安装程序和 systemd 单元
  ./setup.sh --help          显示帮助

脚本不会覆盖已有的 subscription-manager.json，也不会未经确认就应用
订阅配置或启用定时更新。安装后运行 sudo mihomo-console 进入 TUI。
EOF
}

confirm() {
  local prompt="$1"
  local default="${2:-no}"
  local hint="y/N"
  local answer

  if [[ "$default" == "yes" ]]; then
    hint="Y/n"
  fi

  while true; do
    read -r -p "${prompt} [${hint}]: " answer
    answer="${answer,,}"
    if [[ -z "$answer" ]]; then
      [[ "$default" == "yes" ]]
      return
    fi
    case "$answer" in
      y|yes|是) return 0 ;;
      n|no|否) return 1 ;;
      *) say "请输入 y 或 n。" ;;
    esac
  done
}

require_sources() {
  local source_path
  for source_path in \
    "$MANAGER_SOURCE" \
    "$SERVICE_SOURCE" \
    "$TIMER_SOURCE" \
    "$README_SOURCE"; do
    [[ -f "$source_path" ]] || die "缺少安装文件：${source_path}"
  done
}

ensure_python_yaml() {
  if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
    return
  fi

  command -v apt-get >/dev/null 2>&1 || die \
    "缺少 Python 3/PyYAML，且未找到 apt-get；请先安装 Python 3 和 PyYAML。"

  say "正在安装 Python 3 和 PyYAML……"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-yaml
}

install_files() {
  say "正在安装 Mihomo Console……"
  install -m 0755 "$MANAGER_SOURCE" "$MANAGER_BIN"
  ln -sfn "$MANAGER_BIN" "$LEGACY_MANAGER_BIN"
  install -d -m 0755 "$DOC_DIR"
  install -m 0644 "$README_SOURCE" "${DOC_DIR}/README.md"
  install -m 0644 "$SERVICE_SOURCE" "${SYSTEMD_DIR}/mihomo-subscription-update.service"
  install -m 0644 "$TIMER_SOURCE" "${SYSTEMD_DIR}/mihomo-subscription-update.timer"
  systemctl daemon-reload
  say "Mihomo Console 和 systemd 更新单元安装完成。"
}

configure_systemd_sandbox() {
  [[ -f "$MANAGER_CONFIG" ]] || return 0
  "$MANAGER_BIN" configure-systemd-sandbox
}

has_active_subscription() {
  python3 - "$MANAGER_CONFIG" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    registry = json.load(handle)

active = registry.get("active")
subscriptions = registry.get("subscriptions") or {}
raise SystemExit(0 if active and active in subscriptions else 1)
PY
}

has_any_subscription() {
  python3 - "$MANAGER_CONFIG" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    registry = json.load(handle)

raise SystemExit(0 if registry.get("subscriptions") else 1)
PY
}

run_setup_wizard() {
  local dry_run_passed=false

  if [[ ! -t 0 ]]; then
    warn "当前不是交互式终端，已跳过初始化向导。稍后运行：sudo ${MANAGER_BIN}"
    return
  fi

  if [[ -f "$MANAGER_CONFIG" ]]; then
    say "检测到已有 ${MANAGER_CONFIG}，将保留现有配置。"
  elif confirm "现在初始化 Mihomo Console 吗" yes; then
    "$MANAGER_BIN" init
    configure_systemd_sandbox
  else
    warn "尚未初始化；timer 不应在配置完成前启用。"
    return
  fi

  if ! has_any_subscription; then
    if confirm "现在添加第一个订阅吗" yes; then
      "$MANAGER_BIN" add
    fi
  elif confirm "要添加或修改订阅吗" no; then
    "$MANAGER_BIN" add
  fi

  "$MANAGER_BIN" list

  if ! has_active_subscription; then
    warn "尚未配置当前订阅，已跳过校验、应用和 timer 设置。"
    return
  fi

  if confirm "现在下载并校验当前订阅（dry-run）吗" yes; then
    "$MANAGER_BIN" update-active --dry-run
    dry_run_passed=true
  fi

  if [[ "$dry_run_passed" == true ]] && confirm \
    "校验已通过，要立即备份并更新 /etc/mihomo/config.yaml 吗" no; then
    "$MANAGER_BIN" update-active
  fi

  if [[ "$dry_run_passed" == true ]]; then
    if confirm "启用每小时自动更新 timer 吗" yes; then
      systemctl enable --now mihomo-subscription-update.timer
      systemctl list-timers mihomo-subscription-update.timer --no-pager
    else
      say "timer 未启用；之后可运行："
      say "  sudo systemctl enable --now mihomo-subscription-update.timer"
    fi
  else
    warn "尚未成功完成 dry-run，因此没有询问是否启用 timer。"
  fi
}

while (($#)); do
  case "$1" in
    --install-only)
      INSTALL_ONLY=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "未知参数：$1"
      ;;
  esac
  shift
done

if ((EUID != 0)); then
  command -v sudo >/dev/null 2>&1 || die "需要 root 权限，且系统中未找到 sudo。"
  if [[ "$INSTALL_ONLY" == true ]]; then
    exec sudo -- bash "$SCRIPT_PATH" --install-only
  fi
  exec sudo -- bash "$SCRIPT_PATH"
fi

require_sources
ensure_python_yaml
install_files

# 兼容已有配置以及 --install-only：根据实际的配置、覆盖、备份和锁路径
# 生成 ReadWritePaths，而不是只允许默认的 /etc/mihomo 和 /run/lock。
configure_systemd_sandbox

if [[ "$INSTALL_ONLY" == true ]]; then
  say "已按 --install-only 完成安装，没有修改订阅配置或 timer 状态。"
  exit 0
fi

run_setup_wizard
say "setup 完成。"
