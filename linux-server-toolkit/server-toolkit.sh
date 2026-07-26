#!/bin/bash

# ==============================================================
# Linux Server Initialization Script v8.5 (Audit Hardened Edition)
#
# README (Quick Guide)
# - 适用系统: Debian 10+ / Ubuntu 20.04+
# - 运行方式: sudo ./init.sh
# - 核心功能: 初始化/换源/SSH/防火墙/Fail2ban/Swap/Docker/运行时管理
# - 交互模式: 按用途进入九个功能分区
#
# 环境变量:
# - NON_INTERACTIVE=1  非交互模式（自动使用默认值）
# - SSH_KEY_TARGET=root|none|用户名  SSH 公钥目标；非交互模式默认 root
# - SSH_PUBLIC_KEY="ssh-ed25519 ..."  非交互模式要追加到目标账户的 SSH 公钥
# - ALLOW_EXTERNAL=1   非交互模式允许外部下载
# - ALLOW_REMOTE_EXEC=1 非交互模式允许执行远程脚本（比外部下载更高风险）
# - ALLOW_DANGEROUS=1  非交互模式允许危险操作；未固定摘要的远程脚本还需要此开关
# - REMOTE_SCRIPT_SHA256=<sha256>  为本次远程脚本执行提供可信摘要
# - REMOTE_SCRIPT_CHECKSUM_FILE=/root/init-remote-scripts.sha256  每行格式: SHA256 URL
# - ALLOW_UNVERIFIED_REMOTE=1  仅允许代码中显式标注的“未固定摘要”调用点（不推荐）
# - ACTION_ROLLBACK_MODE=auto  动作失败后的文件回滚策略: auto/prompt/always/never
# - RESOURCE_CHECK_STRICT=1  资源告警返回非零；默认仅告警并返回成功
# - DRY_RUN=1          仅输出计划操作，不执行
# - INIT_PROFILE=docker-host  按预设 Profile 生成计划/执行
# - PROFILE_FILE=/path/profile.env  导入 Profile 文件
# - PLAN_ONLY=1        仅展示 Profile 执行计划
# - EXTERNAL_TRUST_MODE=standard  外部资源信任策略: strict/standard/permissive
#
# 使用示例:
# - NON_INTERACTIVE=1 ALLOW_EXTERNAL=1 ALLOW_REMOTE_EXEC=1 ALLOW_DANGEROUS=1 ./init.sh
# - NON_INTERACTIVE=1 ALLOW_EXTERNAL=1 DRY_RUN=1 ./init.sh
# - PLAN_ONLY=1 INIT_PROFILE=docker-host ./init.sh
# - PROFILE_FILE=/root/init-profile-docker-host.env ./init.sh
#
# 注意:
# - 本脚本会修改系统配置（/etc/ 等），请先备份重要数据
# - 若系统启用安全策略或自定义 SSH 端口，请谨慎操作
# - v8.5 不再安装全局 ERR trap；错误在动作边界捕获，并只回滚该动作新增的文件变更
# ==============================================================

set -euo pipefail  # 严格模式；可预期失败必须由调用点显式捕获

# --- 全局变量 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/init_script_$(date +%Y%m%d_%H%M%S)_$$.log"
BACKUP_DIR="/root/.init_script_backups"
BACKUP_RETENTION="${BACKUP_RETENTION:-20}"
OS_ID=""
OS_VERSION=""
APT_UPDATED=false  # apt-get update 标记
OPERATION_HISTORY=()  # 操作历史记录（用于回滚）
ROLLBACK_ENABLED="${ROLLBACK_ENABLED:-true}"  # true/false
ACTION_ROLLBACK_MODE="${ACTION_ROLLBACK_MODE:-auto}"  # auto/prompt/always/never
RESOURCE_CHECK_STRICT="${RESOURCE_CHECK_STRICT:-0}"  # 1=资源告警返回非零
NON_INTERACTIVE="${NON_INTERACTIVE:-0}"  # 1=非交互模式
SSH_KEY_TARGET="${SSH_KEY_TARGET:-}"      # root/none/现有用户名；留空时交互选择
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-}"      # 非交互模式可追加到目标账户的公钥
ALLOW_EXTERNAL="${ALLOW_EXTERNAL:-0}"    # 1=非交互模式允许外部资源
ALLOW_REMOTE_EXEC="${ALLOW_REMOTE_EXEC:-0}"  # 1=非交互模式允许执行远程脚本
ALLOW_DANGEROUS="${ALLOW_DANGEROUS:-0}"  # 1=非交互模式允许危险操作
DRY_RUN="${DRY_RUN:-0}"                  # 1=仅展示命令不执行
INIT_PROFILE="${INIT_PROFILE:-}"         # Profile 预设名称
PROFILE_FILE="${PROFILE_FILE:-}"         # Profile 文件路径
PLAN_ONLY="${PLAN_ONLY:-0}"              # 1=仅展示 Profile 计划
EXTERNAL_TRUST_MODE="${EXTERNAL_TRUST_MODE:-standard}"  # strict/standard/permissive
REMOTE_SCRIPT_SHA256="${REMOTE_SCRIPT_SHA256:-}"
REMOTE_SCRIPT_CHECKSUM_FILE="${REMOTE_SCRIPT_CHECKSUM_FILE:-/root/init-remote-scripts.sha256}"
ALLOW_UNVERIFIED_REMOTE="${ALLOW_UNVERIFIED_REMOTE:-0}"
DIR_TRANSACTION_DIR="${DIR_TRANSACTION_DIR:-/var/lib/init-script/transactions}"
TEMP_FILES=()                            # 临时文件清理列表
LAST_BACKUP_FILE=""                      # 最近一次备份文件路径
OPERATION_TARGETS=()
OPERATION_BACKUPS=()
OPERATION_DESCRIPTIONS=()
OPERATION_TYPES=()
LOG_READY=false
ACTIVE_CHILD_PID=""
ACTIVE_CHILD_IS_GROUP=false
SCRIPT_LOCK_FILE="${SCRIPT_LOCK_FILE:-/run/lock/init-script.lock}"

# --- 全局颜色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
PLAIN='\033[0m'
BOLD='\033[1m'

# --- 日志函数 ---
ensure_log_file() {
    if [ "$LOG_READY" = true ]; then
        return 0
    fi

    local log_dir old_umask
    log_dir="$(dirname "$LOG_FILE")"
    if [ ! -d "$log_dir" ] || [ ! -w "$log_dir" ]; then
        LOG_FILE="/tmp/init_script_$(date +%Y%m%d_%H%M%S)_$$.log"
    fi

    old_umask="$(umask)"
    umask 077
    if ! : >> "$LOG_FILE"; then
        umask "$old_umask"
        printf '%s\n' "无法创建日志文件: $LOG_FILE" >&2
        return 1
    fi
    chmod 600 "$LOG_FILE" 2>/dev/null || true
    umask "$old_umask"
    LOG_READY=true
}

log() {
    local level="$1" message timestamp
    shift
    message="$*"
    timestamp="$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || printf 'unknown-time')"
    if ensure_log_file; then
        printf '[%s] [%s] %s\n' "$timestamp" "$level" "$message" >> "$LOG_FILE" || \
            printf '[%s] [%s] %s\n' "$timestamp" "$level" "$message" >&2
    else
        printf '[%s] [%s] %s\n' "$timestamp" "$level" "$message" >&2
    fi
}

log_info() {
    printf '%b\n' "${BLUE}[Info]${PLAIN} $*"
    log "INFO" "$*"
}

log_success() {
    printf '%b\n' "${GREEN}[Success]${PLAIN} $*"
    log "SUCCESS" "$*"
}

log_warning() {
    printf '%b\n' "${YELLOW}[Warning]${PLAIN} $*" >&2
    log "WARNING" "$*"
}

log_error() {
    printf '%b\n' "${RED}[Error]${PLAIN} $*" >&2
    log "ERROR" "$*"
}

validate_runtime_modes() {
    case "$EXTERNAL_TRUST_MODE" in
        strict|standard|permissive) ;;
        *)
            log_error "无效的 EXTERNAL_TRUST_MODE: $EXTERNAL_TRUST_MODE"
            return 1
            ;;
    esac
    case "$ACTION_ROLLBACK_MODE" in
        auto|prompt|always|never) ;;
        *)
            log_error "无效的 ACTION_ROLLBACK_MODE: $ACTION_ROLLBACK_MODE"
            return 1
            ;;
    esac
    case "$ROLLBACK_ENABLED" in
        true|false) ;;
        *)
            log_error "无效的 ROLLBACK_ENABLED: $ROLLBACK_ENABLED（应为 true/false）"
            return 1
            ;;
    esac
    case "$RESOURCE_CHECK_STRICT" in
        0|1) ;;
        *)
            log_error "无效的 RESOURCE_CHECK_STRICT: $RESOURCE_CHECK_STRICT（应为 0/1）"
            return 1
            ;;
    esac
}

# --- 临时文件管理 ---
register_temp_file() {
    local file="${1:-}"
    [ -z "$file" ] && return 0

    case "$file" in
        /tmp/*|/var/tmp/*)
            TEMP_FILES+=("$file")
            ;;
        *)
            log_warning "拒绝登记非临时路径用于自动清理: $file"
            ;;
    esac
}

cleanup_temp_files() {
    local file
    # Bash 4.3 在 nounset 模式下展开空数组可能报 unbound variable。
    [ "${#TEMP_FILES[@]}" -eq 0 ] && return 0
    for file in "${TEMP_FILES[@]}"; do
        case "$file" in
            /tmp/*|/var/tmp/*)
                [ -e "$file" ] && rm -rf -- "$file" >/dev/null 2>&1 || true
                ;;
        esac
    done
}

# --- 通用命令执行（支持 DRY_RUN） ---
run_command() {
    local description="$1"
    shift
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] $description"
        return 0
    fi
    if "$@"; then
        return 0
    else
        local rc=$?
        log_error "$description 失败 (退出码: $rc)"
        return "$rc"
    fi
}

run_cmd() {
    local description="$1"
    shift
    local cmd="$*"
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] $description"
        return 0
    fi
    bash -o pipefail -c "$cmd"
}

shell_join() {
    local arg
    local quoted
    local output=()

    for arg in "$@"; do
        printf -v quoted '%q' "$arg"
        output+=("$quoted")
    done

    printf '%s' "${output[*]}"
}

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

write_shell_var() {
    local key="$1"
    local value="$2"
    printf 'export %s=' "$key"
    printf '%q' "$value"
    printf '\n'
}

external_url_host() {
    local url="$1"
    local without_scheme="${url#*://}"
    local host="${without_scheme%%/*}"
    host="${host%%:*}"
    printf '%s' "$host"
}

external_resource_trust_level() {
    local url="$1"
    local host
    host="$(external_url_host "$url")"

    case "$host" in
        download.docker.com|github.com|objects.githubusercontent.com|nodejs.org|go.dev|dl.google.com|packages.microsoft.com|packages.adoptium.net|downloads.rclone.org|starship.rs|astral.sh|getcomposer.org|composer.github.io|getcroc.schollz.com|archive.apache.org|services.gradle.org|downloads.gradle.org)
            printf 'official'
            ;;
        raw.githubusercontent.com|download.bt.cn|linuxmirrors.cn|resource.1panel.pro|resource.fit2cloud.com|www.aapanel.com|yabs.sh|run.NodeQuality.com|Check.Place|gitlab.com|check.unlock.media)
            printf 'remote-script'
            ;;
        api.github.com|deb.gierens.de|ip.sb|api.ip.sb|ipinfo.io|ifconfig.me)
            printf 'service'
            ;;
        mirrors.aliyun.com|pypi.tuna.tsinghua.edu.cn|registry.npmmirror.com|goproxy.cn|nuget.cdn.azure.cn|docker.1ms.run|docker.kejilion.pro|docker.m.daocloud.io|docker.m.ixdev.cn|docker.mirrors.ustc.edu.cn|dockerproxy.net|hub-mirror.c.163.com|hub.rat.dev|mirror.baidubce.com)
            printf 'mirror'
            ;;
        *)
            printf 'unknown'
            ;;
    esac
}

external_trust_advice() {
    local trust_level="$1"
    case "$trust_level" in
        official)
            printf '官方或项目主发布源，优先使用固定版本与校验文件。'
            ;;
        service)
            printf '外部查询服务，只用于读取信息；若在隐私敏感环境中请跳过。'
            ;;
        mirror)
            printf '第三方镜像源，可提升速度；生产环境建议确认维护方与同步策略。'
            ;;
        remote-script)
            printf '远程脚本源，脚本会先下载、记录 SHA256 并二次确认后执行。'
            ;;
        *)
            printf '未知来源，建议手动审阅 URL、脚本内容和 SHA256 后再继续。'
            ;;
    esac
}

external_trust_allows_url() {
    local url="$1"
    local trust_level
    trust_level="$(external_resource_trust_level "$url")"

    case "$EXTERNAL_TRUST_MODE" in
        strict)
            case "$trust_level" in
                official|service) return 0 ;;
                *) return 1 ;;
            esac
            ;;
        standard)
            case "$trust_level" in
                unknown) return 1 ;;
                *) return 0 ;;
            esac
            ;;
        permissive)
            return 0
            ;;
        *)
            # 配置值异常时失败关闭，避免拼写错误退化为 permissive。
            return 1
            ;;
    esac
}

# --- 下载工具（确认 + 可选校验） ---
fetch_file() {
    local url="$1"
    local dest="$2"
    local description="$3"
    local dest_dir dest_base tmp

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 下载 $description -> $dest"
        return 0
    fi

    dest_dir="$(dirname "$dest")"
    dest_base="$(basename "$dest")"
    if [ ! -d "$dest_dir" ]; then
        log_error "下载目标目录不存在: $dest_dir"
        return 1
    fi
    tmp="$(mktemp "$dest_dir/.${dest_base}.part.XXXXXX")" || return 1
    register_temp_file "$tmp"

    if ! curl -fsSL --retry 3 --connect-timeout 15 --max-time 600 \
        --speed-time 30 --speed-limit 1024 --proto '=https' --tlsv1.2 -o "$tmp" "$url"; then
        rm -f -- "$tmp"
        log_error "下载失败: $description"
        return 1
    fi
    chmod 600 "$tmp"
    if ! mv -f -- "$tmp" "$dest"; then
        rm -f -- "$tmp"
        log_error "无法安装下载文件: $dest"
        return 1
    fi
}

download_file() {
    local url="$1"
    local dest="$2"
    local description="$3"
    if ! confirm_external_resource "$url" "$description"; then
        return 1
    fi
    fetch_file "$url" "$dest" "$description" || return 1
}

download_and_verify_sha256() {
    local url="$1"
    local expected_sha="$2"
    local dest="$3"
    local description="$4"
    if ! confirm_external_resource "$url" "$description"; then
        return 1
    fi
    if [[ ! "$expected_sha" =~ ^[[:xdigit:]]{64}$ ]]; then
        log_error "$description 缺少有效的固定 SHA256"
        return 1
    fi
    fetch_file "$url" "$dest" "$description" || return 1
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 校验 $description 的固定 SHA256"
        return 0
    fi
    local actual_sha
    actual_sha="$(sha256sum "$dest" | awk '{print $1}')"
    if [ "$actual_sha" != "${expected_sha,,}" ]; then
        rm -f -- "$dest"
        log_error "$description SHA256 不匹配"
        return 1
    fi
}

download_and_verify_checksum_url() {
    local url="$1" checksum_url="$2" algorithm="$3" dest="$4" description="$5"
    local checksum_file="${dest}.checksum" expected actual pattern
    case "$algorithm" in
        sha256) pattern='^[[:xdigit:]]{64}$' ;;
        sha512) pattern='^[[:xdigit:]]{128}$' ;;
        *) log_error "不支持的摘要算法: $algorithm"; return 1 ;;
    esac
    confirm_external_resource "$url" "$description" || return 1
    fetch_file "$checksum_url" "$checksum_file" "$description 摘要" || return 1
    fetch_file "$url" "$dest" "$description" || { rm -f -- "$checksum_file"; return 1; }
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 使用 $algorithm 校验 $description"
        return 0
    fi
    expected="$(awk 'NR == 1 {print tolower($1)}' "$checksum_file")"
    if ! [[ "$expected" =~ $pattern ]]; then
        rm -f -- "$dest" "$checksum_file"
        log_error "$description 摘要文件格式无效"
        return 1
    fi
    actual="$("${algorithm}sum" "$dest" | awk '{print tolower($1)}')"
    rm -f -- "$checksum_file"
    if [ "$actual" != "$expected" ]; then
        rm -f -- "$dest"
        log_error "$description $algorithm 校验失败"
        return 1
    fi
    log_success "$description $algorithm 校验通过"
}

download_go_release() {
    local filename="$1" dest="$2" description="$3"
    local metadata_url="https://go.dev/dl/?mode=json&include=all" metadata expected url
    metadata="$(mktemp /tmp/init-go-metadata.XXXXXX.json)" || return 1
    register_temp_file "$metadata"
    fetch_file "$metadata_url" "$metadata" "Go 发布元数据" || return 1
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 从 Go 官方发布元数据读取 $filename 的 SHA256"
        return 0
    fi
    expected="$(jq -r --arg filename "$filename" \
        '.[] | .files[] | select(.filename == $filename) | .sha256' "$metadata" | head -n 1)"
    [[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || {
        log_error "Go 官方元数据中没有找到 $filename 的 SHA256"
        return 1
    }
    url="https://go.dev/dl/$filename"
    download_and_verify_sha256 "$url" "$expected" "$dest" "$description"
}

remote_script_expected_sha256() {
    local url="$1" checksum=""
    if [[ "$REMOTE_SCRIPT_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
        printf '%s' "${REMOTE_SCRIPT_SHA256,,}"
        return 0
    fi
    if [ -f "$REMOTE_SCRIPT_CHECKSUM_FILE" ] && \
       [ "$(stat -c '%u' "$REMOTE_SCRIPT_CHECKSUM_FILE" 2>/dev/null || printf 1)" = "0" ] && \
       [ $((8#$(stat -c '%a' "$REMOTE_SCRIPT_CHECKSUM_FILE" 2>/dev/null || printf 777) & 022)) -eq 0 ]; then
        checksum="$(awk -v wanted="$url" '$2 == wanted {print tolower($1); exit}' "$REMOTE_SCRIPT_CHECKSUM_FILE")"
    fi
    if [[ "$checksum" =~ ^[[:xdigit:]]{64}$ ]]; then
        printf '%s' "$checksum"
        return 0
    fi
    return 1
}

verify_gpg_fingerprint() {
    local key_file="$1" expected="${2//[[:space:]]/}" actual
    expected="${expected^^}"
    actual="$(gpg --show-keys --with-colons "$key_file" 2>/dev/null | awk -F: '$1 == "fpr" {print toupper($10); exit}')"
    [ -n "$actual" ] && [ "$actual" = "$expected" ]
}

confirm_remote_script_execution() {
    local url="$1"
    local description="$2"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        if [ "$ALLOW_EXTERNAL" = "1" ] && [ "$ALLOW_REMOTE_EXEC" = "1" ]; then
            if ! external_trust_allows_url "$url" && [ "$ALLOW_DANGEROUS" != "1" ]; then
                log_warning "[非交互] 远程脚本被外部信任策略拒绝: $url"
                log_warning "如确需越过当前策略，请显式设置 ALLOW_DANGEROUS=1"
                return 1
            fi
            log_warning "[非交互] 已允许执行远程脚本: $url"
            return 0
        fi
        log_warning "[非交互] 已拒绝执行远程脚本: $url"
        log_warning "如确需执行，请同时设置 ALLOW_EXTERNAL=1 ALLOW_REMOTE_EXEC=1"
        return 1
    fi

    if ! confirm_external_resource "$url" "$description"; then
        return 1
    fi

    confirm_dangerous_action "执行远程脚本: $description" \
        "脚本将先下载到私有临时文件，校验/记录 SHA256 后再执行。请确认来源可信。"
}

download_remote_script_with_policy() {
    local pin_policy="$1" url="$2" dest="$3" description="$4"
    local expected_sha="" script_sha=""

    case "$pin_policy" in
        required|allow-unverified) ;;
        *) log_error "未知远程脚本摘要策略: $pin_policy"; return 1 ;;
    esac

    if ! confirm_remote_script_execution "$url" "$description"; then
        return 1
    fi

    expected_sha="$(remote_script_expected_sha256 "$url" 2>/dev/null || true)"
    if [ -z "$expected_sha" ]; then
        if [ "$pin_policy" = "required" ]; then
            log_error "该调用点要求固定 SHA256，已拒绝远程脚本: $url"
            log_error "请通过 REMOTE_SCRIPT_SHA256 或 root-only 的 $REMOTE_SCRIPT_CHECKSUM_FILE 提供可信摘要"
            return 1
        fi
        if [ "$ALLOW_UNVERIFIED_REMOTE" != "1" ]; then
            log_error "该调用点允许显式例外，但未设置 ALLOW_UNVERIFIED_REMOTE=1: $url"
            return 1
        fi
        if [ "$NON_INTERACTIVE" = "1" ] && [ "$ALLOW_DANGEROUS" != "1" ]; then
            log_error "非交互执行未固定摘要的远程脚本还需要 ALLOW_DANGEROUS=1"
            return 1
        fi
        log_warning "正在执行代码中显式标注、但未固定摘要的远程脚本"
    fi

    if ! fetch_file "$url" "$dest" "$description"; then
        return 1
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过远程脚本权限设置: $dest"
        return 0
    fi

    chmod 700 "$dest" || { rm -f -- "$dest"; return 1; }
    script_sha="$(sha256sum "$dest" 2>/dev/null | awk '{print tolower($1)}')"
    if [[ ! "$script_sha" =~ ^[[:xdigit:]]{64}$ ]]; then
        rm -f -- "$dest"
        log_error "无法计算远程脚本 SHA256: $description"
        return 1
    fi
    if [ -n "$expected_sha" ] && [ "$script_sha" != "$expected_sha" ]; then
        rm -f -- "$dest"
        log_error "远程脚本 SHA256 不匹配: $description"
        return 1
    fi
    log_warning "远程脚本已下载: $dest"
    log_warning "远程脚本 SHA256: $script_sha"
}

download_remote_script() {
    download_remote_script_with_policy required "$@"
}

download_remote_script_unverified() {
    download_remote_script_with_policy allow-unverified "$@"
}

run_remote_script_with_policy() {
    local pin_policy="$1" url="$2" description="$3"
    shift 3
    local script_path status=0

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 执行远程脚本: ${description}（实际下载和执行均已阻止）"
        return 0
    fi

    script_path="$(mktemp /tmp/init_remote_script.XXXXXX)" || return 1
    register_temp_file "$script_path"
    if ! download_remote_script_with_policy "$pin_policy" "$url" "$script_path" "$description"; then
        return 1
    fi

    if bash "$script_path" "$@"; then
        return 0
    else
        status=$?
    fi
    log_error "执行 $description 失败 (退出码: $status)"
    return "$status"
}

run_remote_script() {
    run_remote_script_with_policy required "$@"
}

run_remote_script_unverified() {
    run_remote_script_with_policy allow-unverified "$@"
}

run_remote_script_as_user_with_policy() {
    local pin_policy="$1" url="$2" description="$3"
    shift 3
    local script_path status=0 target_user="${INSTALL_USER:-root}" target_home="${INSTALL_HOME:-/root}"

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 以用户 $target_user 执行远程脚本: ${description}（实际下载和执行均已阻止）"
        return 0
    fi

    script_path="$(mktemp /tmp/init_remote_script.XXXXXX)" || return 1
    register_temp_file "$script_path"
    if ! download_remote_script_with_policy "$pin_policy" "$url" "$script_path" "$description"; then
        return 1
    fi

    if [ "$target_user" = "root" ]; then
        if bash "$script_path" "$@"; then
            return 0
        else
            status=$?
        fi
    else
        # 由 root 打开已校验文件并通过 stdin 交给目标用户，避免 chown 后的校验-执行竞态。
        if sudo -H -u "$target_user" \
            env HOME="$target_home" USER="$target_user" LOGNAME="$target_user" \
            bash -s -- "$@" < "$script_path"; then
            return 0
        else
            status=$?
        fi
    fi
    log_error "以用户 $target_user 执行 $description 失败 (退出码: $status)"
    return "$status"
}

run_remote_script_as_user() {
    run_remote_script_as_user_with_policy required "$@"
}

run_remote_script_as_user_unverified() {
    run_remote_script_as_user_with_policy allow-unverified "$@"
}

# --- 原子文件写入与验证 ---
# 有些合法配置文件允许为空，因此默认校验器只表示“调用方未要求格式校验”。
validate_noop_candidate() {
    return 0
}

validate_nonempty_text_candidate() {
    local candidate="$1"
    [ -s "$candidate" ] || return 1
    LC_ALL=C grep -q '[^[:space:]]' "$candidate"
}

validate_json_candidate() {
    local candidate="$1"
    command -v jq > /dev/null 2>&1 || return 0
    jq empty "$candidate" > /dev/null 2>&1
}

validate_sshd_candidate() {
    local candidate="$1"
    sshd -t -f "$candidate" > /dev/null 2>&1
}

validate_systemd_candidate() {
    local candidate="$1" target="$2" verify_dir verify_file
    command -v systemd-analyze > /dev/null 2>&1 || return 0
    verify_dir="$(mktemp -d /tmp/init-systemd-verify.XXXXXX)" || return 1
    register_temp_file "$verify_dir"
    verify_file="$verify_dir/$(basename "$target")"
    cp -- "$candidate" "$verify_file"
    systemd-analyze verify "$verify_file" > /dev/null 2>&1
}

validate_systemd_calendar_value() {
    local value="$1"
    command -v systemd-analyze > /dev/null 2>&1 || return 0
    systemd-analyze calendar "$value" > /dev/null 2>&1
}

validate_systemd_duration_value() {
    local value="$1"
    [[ "$value" =~ ^[0-9]+([.][0-9]+)?(us|ms|s|min|m|h|d|w|month|y)$ ]]
}

atomic_install_file() {
    local target="$1" candidate="$2" description="${3:-配置文件}" mode="${4:-preserve}"
    local owner="${5:-preserve}" group="${6:-preserve}" validator="${7:-validate_noop_candidate}"
    local target_exists=false target_mode target_uid target_gid backup_recorded=false

    if [ "$DRY_RUN" = "1" ]; then
        rm -f -- "$candidate" 2>/dev/null || true
        log_info "[DRY RUN] 原子写入 $target ($description)"
        return 0
    fi
    if ! "$validator" "$candidate" "$target"; then
        rm -f -- "$candidate"
        log_error "$description 校验失败，未修改 $target"
        return 1
    fi

    if [ -e "$target" ]; then
        target_exists=true
        target_mode="$(stat -c '%a' "$target" 2>/dev/null || printf 600)"
        target_uid="$(stat -c '%u' "$target" 2>/dev/null || printf 0)"
        target_gid="$(stat -c '%g' "$target" 2>/dev/null || printf 0)"
        create_backup "$target" "$description" > /dev/null || return 1
        backup_recorded=true
    fi

    [ "$mode" = preserve ] && mode="${target_mode:-600}"
    [ "$owner" = preserve ] && owner="${target_uid:-0}"
    [ "$group" = preserve ] && group="${target_gid:-0}"
    if ! chmod "$mode" "$candidate" || ! chown "$owner:$group" "$candidate"; then
        rm -f -- "$candidate"
        [ "$backup_recorded" = true ] && discard_last_operation
        return 1
    fi
    if [ -d "$target" ]; then
        log_error "目标路径意外为目录: $target"
        rm -f -- "$candidate"
        [ "$backup_recorded" = true ] && discard_last_operation
        return 1
    fi
    if ! mv -f -- "$candidate" "$target"; then
        log_error "原子替换失败: $target"
        rm -f -- "$candidate"
        [ "$backup_recorded" = true ] && discard_last_operation
        return 1
    fi
    if [ "$target_exists" = false ]; then
        record_created_file "$target" "$description"
    fi
    log_info "已原子写入: $target"
}

write_file_atomic() {
    local target="$1" description="${2:-配置文件}" mode="${3:-preserve}"
    local owner="${4:-preserve}" group="${5:-preserve}" validator="${6:-validate_noop_candidate}"
    local target_dir target_base candidate

    if [ "$DRY_RUN" = "1" ]; then
        cat > /dev/null
        log_info "[DRY RUN] 原子写入 $target ($description)"
        return 0
    fi
    target_dir="$(dirname "$target")"
    target_base="$(basename "$target")"
    mkdir -p "$target_dir" || return 1
    candidate="$(mktemp "$target_dir/.${target_base}.init.XXXXXX")" || return 1
    if ! cat > "$candidate"; then
        rm -f -- "$candidate"
        return 1
    fi
    atomic_install_file "$target" "$candidate" "$description" "$mode" "$owner" "$group" "$validator"
}

directory_transaction_journal_path() {
    local target="$1" hash
    hash="$(printf '%s' "$target" | sha256sum | awk '{print substr($1,1,24)}')"
    printf '%s/%s.txn' "$DIR_TRANSACTION_DIR" "$hash"
}

write_directory_transaction_journal() {
    local target="$1" old="$2" staged="$3" journal tmp
    case "$DIR_TRANSACTION_DIR" in
        /*) ;;
        *) log_error "DIR_TRANSACTION_DIR 必须是绝对路径"; return 1 ;;
    esac
    mkdir -p "$DIR_TRANSACTION_DIR" || return 1
    chmod 700 "$DIR_TRANSACTION_DIR" 2>/dev/null || true
    journal="$(directory_transaction_journal_path "$target")"
    tmp="$(mktemp "$DIR_TRANSACTION_DIR/.txn.XXXXXX")" || return 1
    if ! printf '%s\n%s\n%s\n' "$target" "$old" "$staged" > "$tmp"; then
        rm -f -- "$tmp"
        return 1
    fi
    chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
    mv -f -- "$tmp" "$journal" || { rm -f -- "$tmp"; return 1; }
    sync -f "$DIR_TRANSACTION_DIR" 2>/dev/null || true
    printf '%s' "$journal"
}

recover_directory_transaction_journal() {
    local journal="$1" target="" old="" staged=""
    [ -f "$journal" ] || return 0
    {
        IFS= read -r target || true
        IFS= read -r old || true
        IFS= read -r staged || true
    } < "$journal"

    case "$target:$old:$staged" in
        /*:/*:/*) ;;
        *) log_error "目录事务日志格式无效，已保留: $journal"; return 1 ;;
    esac
    [ "$target" != "/" ] || { log_error "拒绝恢复根目录事务: $journal"; return 1; }

    if [ -e "$target" ]; then
        # live target 存在：事务已完成，或尚未开始移动；隐藏目录均可清理。
        [ -e "$old" ] && rm -rf -- "$old"
        [ -e "$staged" ] && rm -rf -- "$staged"
        rm -f -- "$journal"
        log_warning "已清理完成或未开始的目录事务: $target"
        return 0
    fi
    if [ -e "$old" ]; then
        if mv -T -- "$old" "$target"; then
            [ -e "$staged" ] && rm -rf -- "$staged"
            rm -f -- "$journal"
            log_warning "已从事务日志恢复目录: $target"
            return 0
        fi
        log_error "目录事务恢复失败: $target"
        return 1
    fi
    if [ -e "$staged" ]; then
        # old 意外丢失时，暂存目录是完整准备好的新版本；优先恢复 live 路径。
        if mv -T -- "$staged" "$target"; then
            rm -f -- "$journal"
            log_warning "旧目录缺失，已将完整暂存目录提升为 live target: $target"
            return 0
        fi
    fi
    log_error "目录事务无法自动恢复，已保留日志: $journal"
    return 1
}

recover_pending_directory_transactions() {
    local journal status=0
    [ "$DRY_RUN" = "1" ] && return 0
    [ -d "$DIR_TRANSACTION_DIR" ] || return 0
    while IFS= read -r -d '' journal; do
        recover_directory_transaction_journal "$journal" || status=1
    done < <(find "$DIR_TRANSACTION_DIR" -maxdepth 1 -type f -name '*.txn' -print0 2>/dev/null)
    return "$status"
}

atomic_exchange_paths() {
    local left="$1" right="$2"
    if mv --help 2>/dev/null | grep -q -- '--exchange'; then
        if mv --exchange --no-copy -T -- "$left" "$right" 2>/dev/null; then
            return 0
        fi
    fi
    if command -v python3 > /dev/null 2>&1; then
        python3 - "$left" "$right" <<'PY_RENAMEAT2'
import ctypes
import os
import sys

AT_FDCWD = -100
RENAME_EXCHANGE = 2
left = os.fsencode(sys.argv[1])
right = os.fsencode(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
try:
    renameat2 = libc.renameat2
except AttributeError:
    raise SystemExit(1)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(AT_FDCWD, left, AT_FDCWD, right, RENAME_EXCHANGE) != 0:
    raise SystemExit(1)
PY_RENAMEAT2
        return $?
    fi
    return 1
}

replace_directory_transactional() {
    local target="$1" staged="$2" description="${3:-目录安装}"
    local parent base prepared old journal=""

    [ -d "$staged" ] || { log_error "$description 的暂存目录不存在: $staged"; return 1; }
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 事务式替换目录 $target ($description)"
        return 0
    fi

    parent="$(dirname "$target")"
    base="$(basename "$target")"
    mkdir -p "$parent" || return 1
    if [ -e "$target" ] && [ ! -d "$target" ]; then
        log_error "目录安装目标不是目录: $target"
        return 1
    fi

    # 先把新版本完整移动/复制到目标同一文件系统的隐藏目录；此阶段不触碰 live target。
    prepared="$(mktemp -d "$parent/.${base}.init-stage.XXXXXX")" || return 1
    rmdir "$prepared" || return 1
    if ! mv -T -- "$staged" "$prepared"; then
        rm -rf -- "$prepared"
        log_error "$description 无法准备到目标文件系统"
        return 1
    fi

    if [ ! -e "$target" ]; then
        if ! mv -T -- "$prepared" "$target"; then
            rm -rf -- "$prepared"
            return 1
        fi
        log_info "$description 已安装到 $target"
        return 0
    fi

    # Linux/文件系统支持时，交换两个目录名，live target 在整个过程始终存在。
    if atomic_exchange_paths "$target" "$prepared"; then
        rm -rf -- "$prepared" || log_warning "旧目录清理失败: $prepared"
        log_info "$description 已通过原子目录交换安装到 $target"
        return 0
    fi

    # 不支持 RENAME_EXCHANGE 时使用可恢复的两步 rename；持久化日志可跨进程/重启恢复。
    old="$(mktemp -d "$parent/.${base}.init-previous.XXXXXX")" || { rm -rf -- "$prepared"; return 1; }
    rmdir "$old" || { rm -rf -- "$prepared" "$old"; return 1; }
    journal="$(write_directory_transaction_journal "$target" "$old" "$prepared")" || {
        rm -rf -- "$prepared" "$old"
        return 1
    }

    if ! mv -T -- "$target" "$old"; then
        rm -f -- "$journal"
        rm -rf -- "$prepared" "$old"
        return 1
    fi
    if ! mv -T -- "$prepared" "$target"; then
        mv -T -- "$old" "$target" 2>/dev/null || true
        rm -f -- "$journal"
        rm -rf -- "$prepared"
        return 1
    fi

    rm -rf -- "$old" || log_warning "旧目录清理失败: $old"
    rm -f -- "$journal"
    sync -f "$parent" 2>/dev/null || true
    log_info "$description 已通过可恢复事务安装到 $target"
}

# --- 文件块写入（支持更新/追加） ---
ensure_block_in_file() {
    local file="$1" marker_start="$2" marker_end="$3" content="$4"
    local description="${5:-配置块}" validator="${6:-validate_noop_candidate}"
    local target_dir candidate

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 写入配置块到 $file"
        return 0
    fi
    target_dir="$(dirname "$file")"
    mkdir -p "$target_dir" || return 1
    candidate="$(mktemp "$target_dir/.$(basename "$file").block.XXXXXX")" || return 1
    if [ -f "$file" ]; then
        awk -v start="$marker_start" -v end="$marker_end" '
            $0 == start { skip = 1; next }
            $0 == end && skip { skip = 0; next }
            !skip { print }
        ' "$file" > "$candidate" || { rm -f -- "$candidate"; return 1; }
    fi
    printf "\n%s\n%s\n%s\n" "$marker_start" "$content" "$marker_end" >> "$candidate"
    atomic_install_file "$file" "$candidate" "$description" preserve preserve preserve "$validator"
}

# --- 回滚预览 ---
preview_rollback() {
    local idx target backup operation_type
    if [ ${#OPERATION_TARGETS[@]} -eq 0 ]; then
        return 0
    fi
    log_warning "回滚预览 (展示前 5 行差异):"
    for (( idx=0; idx<${#OPERATION_TARGETS[@]}; idx++ )); do
        target="${OPERATION_TARGETS[$idx]}"
        backup="${OPERATION_BACKUPS[$idx]}"
        operation_type="${OPERATION_TYPES[$idx]}"
        if [ "$operation_type" = restore ] && [ -f "$backup" ] && [ -f "$target" ]; then
            log_warning "----- $target -----"
            diff -u "$backup" "$target" | head -n 5 || true
        elif [ "$operation_type" = remove ]; then
            log_warning "将删除本次新建文件: $target"
        fi
    done
}
# --- 错误处理 ---
error_exit() {
    log_error "$1"
    exit "${2:-1}"
}

# --- 进度显示函数 ---
show_progress() {
    local pid="$1"
    local message="$2"
    local spinner='-\|/'
    local i=0

    while kill -0 "$pid" 2>/dev/null; do
        i=$(( (i + 1) % 4 ))
        printf '%b' "\r${YELLOW}${message} ${spinner:$i:1}${PLAIN}"
        sleep 0.2
    done
}

# --- 执行命令并显示进度 ---
execute_with_progress() {
    local message="$1"
    shift
    local cmd="$*" pid status

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] $message: $cmd"
        return 0
    fi

    ensure_log_file || return 1
    if command -v setsid > /dev/null 2>&1; then
        setsid bash -o pipefail -c "$cmd" >> "$LOG_FILE" 2>&1 &
        ACTIVE_CHILD_IS_GROUP=true
    else
        bash -o pipefail -c "$cmd" >> "$LOG_FILE" 2>&1 &
        ACTIVE_CHILD_IS_GROUP=false
    fi
    pid=$!
    ACTIVE_CHILD_PID="$pid"
    show_progress "$pid" "$message"

    # wait 位于 if 条件中，本身不受 errexit 提前终止；这里显式保存子进程状态。
    if wait "$pid"; then
        ACTIVE_CHILD_PID=""
        printf '\r%b\n' "${GREEN}${message} ✓${PLAIN}"
        return 0
    else
        status=$?
    fi
    ACTIVE_CHILD_PID=""
    printf '\r%b\n' "${RED}${message} ✗${PLAIN}" >&2
    printf '%b\n' "${RED}执行失败，错误日志:${PLAIN}" >&2
    printf '%s\n' '----------------------------------------' >&2
    tail -n 10 "$LOG_FILE" >&2 || true
    printf '%s\n' '----------------------------------------' >&2
    return "$status"
}

execute_with_progress_argv() {
    local message="$1"
    shift
    local pid rc

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] $message"
        return 0
    fi

    ensure_log_file || return 1
    if command -v setsid > /dev/null 2>&1; then
        setsid "$@" >> "$LOG_FILE" 2>&1 &
        ACTIVE_CHILD_IS_GROUP=true
    else
        "$@" >> "$LOG_FILE" 2>&1 &
        ACTIVE_CHILD_IS_GROUP=false
    fi
    pid=$!
    ACTIVE_CHILD_PID="$pid"
    show_progress "$pid" "$message"
    if wait "$pid"; then
        ACTIVE_CHILD_PID=""
        printf '\r%b\n' "${GREEN}${message} ✓${PLAIN}"
        return 0
    else
        rc=$?
    fi
    ACTIVE_CHILD_PID=""
    printf '\r%b\n' "${RED}${message} ✗${PLAIN}" >&2
    tail -n 10 "$LOG_FILE" >&2 || true
    return "$rc"
}

# --- 操作确认函数 ---
confirm_action() {
    local message=$1
    local default=${2:-"n"}  # 默认值: n (否)
    local prompt=""
    local default_desc=""

    if [ "$NON_INTERACTIVE" = "1" ]; then
        if [ "$default" = "y" ]; then
            log_info "[非交互] ${message} 默认: Y"
            return 0
        fi
        log_info "[非交互] ${message} 默认: N"
        return 1
    fi

    if [ "$default" = "y" ]; then
        prompt="[Y/n]"
        default_desc="默认: Y"
    else
        prompt="[y/N]"
        default_desc="默认: N"
    fi
    
    printf '%b' "${YELLOW}${message} ${prompt}: ${PLAIN}"
    IFS= read -r confirm
    
    # Trim whitespace without interpreting quotes or backslashes.
    confirm=$(trim_whitespace "$confirm")
    
    if [ -z "$confirm" ]; then
        confirm=$default
        printf '%b\n' "\033[1A\033[K${YELLOW}${message} ${prompt}: ${GREEN}${default_desc} (自动选择)${PLAIN}"
    fi
    
    case "$confirm" in
        y|Y|yes|YES)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# --- 危险操作确认 ---
confirm_dangerous_action() {
    local action=$1
    local message=$2
    if [ "$NON_INTERACTIVE" = "1" ]; then
        if [ "$ALLOW_DANGEROUS" = "1" ]; then
            log_warning "[非交互] 已允许危险操作: $action"
            return 0
        fi
        log_warning "[非交互] 已拒绝危险操作: $action"
        return 1
    fi
    printf '%b\n' ""
    printf '%b\n' "${RED}╔════════════════════════════════════════╗${PLAIN}"
    printf '%b\n' "${RED}║  ⚠️  警告: 危险操作                    ║${PLAIN}"
    printf '%b\n' "${RED}╚════════════════════════════════════════╝${PLAIN}"
    printf '%b\n' "${YELLOW}操作: ${action}${PLAIN}"
    printf '%b\n' "${YELLOW}说明: ${message}${PLAIN}"
    printf '%b\n' ""
    read -r -p "${RED}确认执行此操作? (输入 'YES' 继续, 回车取消): ${PLAIN}" confirm
    if [ "$confirm" != "YES" ]; then
        printf '%b\n' "${YELLOW}默认操作: 取消${PLAIN}"
        log_warning "操作已取消"
        return 1
    fi
    return 0
}

# --- 外部资源访问确认 (安全检查) ---
confirm_external_resource() {
    local url="$1"
    local description="$2"
    local trust_level trust_advice
    trust_level="$(external_resource_trust_level "$url")"
    trust_advice="$(external_trust_advice "$trust_level")"

    if [ "$NON_INTERACTIVE" = "1" ]; then
        if [ "$ALLOW_EXTERNAL" = "1" ]; then
            if ! external_trust_allows_url "$url" && [ "$ALLOW_DANGEROUS" != "1" ]; then
                log_warning "[非交互] 外部资源被信任策略拒绝: $url (trust=$trust_level mode=$EXTERNAL_TRUST_MODE)"
                log_warning "如确需允许未知/远程脚本来源，请设置 EXTERNAL_TRUST_MODE=permissive 或 ALLOW_DANGEROUS=1"
                return 1
            fi
            log_info "[非交互] 已允许访问外部资源: $url"
            return 0
        fi
        log_warning "[非交互] 已拒绝访问外部资源: $url"
        return 1
    fi

    if ! external_trust_allows_url "$url"; then
        log_warning "外部资源未通过当前信任策略: trust=$trust_level mode=$EXTERNAL_TRUST_MODE"
        if ! confirm_dangerous_action "访问未受信任外部资源" "来源: ${url}；建议先手动审阅来源与校验方式。"; then
            return 1
        fi
    fi
    
    printf '%b\n' ""
    printf '%b\n' "${RED}╔════════════════════════════════════════╗${PLAIN}"
    printf '%b\n' "${RED}║  ⚠️  警告: 正在访问外部资源              ║${PLAIN}"
    printf '%b\n' "${RED}╚════════════════════════════════════════╝${PLAIN}"
    printf '%b\n' "${YELLOW}说明: ${description}${PLAIN}"
    printf '%b\n' "${YELLOW}地址: ${CYAN}${url}${PLAIN}"
    printf '%b\n' "${YELLOW}信任级别: ${trust_level} (${EXTERNAL_TRUST_MODE})${PLAIN}"
    printf '%b\n' "${YELLOW}建议: ${trust_advice}${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "此操作将从外部服务器下载脚本或配置。"
    printf '%b\n' "请仔细检查 URL 是否为您信任的来源。"
    printf '%b\n' ""
    
    read -r -p "确认继续访问? [y/N]: " confirm
    case "$confirm" in
        y|Y|yes|YES)
            log_info "用户已确认访问: $url"
            return 0
            ;;
        *)
            log_warning "用户取消了外部资源访问: $url"
            return 1
            ;;
    esac
}

# --- apt-get update 统一管理 ---
acquire_script_lock() {
    [ "$DRY_RUN" = "1" ] && return 0
    command -v flock > /dev/null 2>&1 || {
        log_warning "系统缺少 flock，无法阻止 init.sh 并发执行"
        return 0
    }
    mkdir -p "$(dirname "$SCRIPT_LOCK_FILE")" || return 1
    exec 9>"$SCRIPT_LOCK_FILE"
    if ! flock -n 9; then
        log_error "检测到另一个 init.sh 实例正在运行: $SCRIPT_LOCK_FILE"
        return 1
    fi
}

update_apt_once() {
    if [ "$APT_UPDATED" = false ]; then
        log_info "更新软件包列表..."
        if execute_with_progress_argv "更新软件包列表" \
            apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update; then
            APT_UPDATED=true
            log_success "软件包列表更新完成"
        else
            APT_UPDATED=false
            log_error "软件包列表更新失败；本次安装已中止，可稍后重试"
            return 1
        fi
    fi
}

# --- 安装验证函数 ---
verify_installation() {
    local runtime=$1
    local command=$2
    local expected_output=${3:-""}
    local version_flag=${4:-"--version"}
    
    log_info "验证 $runtime 安装..."
    
    # 检查命令是否存在
    if ! command -v "$command" > /dev/null 2>&1; then
        log_error "$runtime 安装验证失败: 命令 '$command' 不存在"
        return 1
    fi
    
    # 检查版本（如果提供了期望输出）
    if [ -n "$expected_output" ]; then
        local actual_output
        actual_output=$("$command" "$version_flag" 2>&1 | head -1)
        if [[ "$actual_output" != *"$expected_output"* ]] && [[ "$expected_output" != "any" ]]; then
            log_warning "版本可能不匹配: 期望包含 '$expected_output', 实际: '$actual_output'"
            # 不返回错误，因为版本可能略有不同
        else
            log_success "$runtime 版本验证通过: $actual_output"
        fi
    else
        local version_output
        version_output=$("$command" "$version_flag" 2>&1 | head -1)
        log_success "$runtime 安装验证通过: $version_output"
    fi
    
    return 0
}

# --- 批量安装包（优化版） ---
install_packages_batch() {
    local packages=("$@")
    local to_install=()
    
    # 更新包列表（如果需要）
    update_apt_once || return 1
    
    # 检查哪些包未安装
    log_info "检查已安装的包..."
    for package in "${packages[@]}"; do
        # 处理包名（可能包含版本号）
        local pkg_name="${package%%=*}"
        if ! dpkg-query -W -f='${Status}' "$pkg_name" 2>/dev/null | grep -q "install ok installed"; then
            to_install+=("$package")
        else
            log_info "已安装: $pkg_name"
        fi
    done
    
    # 批量安装
    if [ ${#to_install[@]} -gt 0 ]; then
        log_info "批量安装 ${#to_install[@]} 个包..."
        if execute_with_progress_argv "安装软件包" \
            apt-get -o DPkg::Lock::Timeout=120 -y install "${to_install[@]}"; then
            log_success "软件包安装完成"
            return 0
        else
            log_error "部分软件包安装失败"
            return 1
        fi
    else
        log_info "所有包已安装"
        return 0
    fi
}

# --- 记录操作（用于回滚） ---
record_operation() {
    local operation_type="$1" target_file="$2" backup_file="${3:-}" description="${4:-}"
    [ "$ROLLBACK_ENABLED" = true ] || return 0
    OPERATION_TYPES+=("$operation_type")
    OPERATION_TARGETS+=("$target_file")
    OPERATION_BACKUPS+=("$backup_file")
    OPERATION_DESCRIPTIONS+=("$description")
    OPERATION_HISTORY+=("$operation_type $target_file ${backup_file:+(backup: $backup_file)}")
}

record_created_file() {
    local target_file="$1" description="${2:-新建文件}"
    record_operation remove "$target_file" "" "$description"
    log_info "已记录本次新建文件: $target_file"
}

rollback_operation_at() {
    local idx="$1" operation_type target_file backup_file description
    operation_type="${OPERATION_TYPES[$idx]}"
    target_file="${OPERATION_TARGETS[$idx]}"
    backup_file="${OPERATION_BACKUPS[$idx]}"
    description="${OPERATION_DESCRIPTIONS[$idx]}"
    log_info "回滚: $target_file${description:+ ($description)}"
    case "$operation_type" in
        restore)
            [ -f "$backup_file" ] || { log_error "备份不存在: $backup_file"; return 1; }
            mkdir -p "$(dirname "$target_file")" || return 1
            cp -a -- "$backup_file" "$target_file"
            ;;
        remove)
            rm -f -- "$target_file"
            ;;
        *)
            log_error "未知回滚类型: $operation_type"
            return 1
            ;;
    esac
}

discard_last_operation() {
    local last=$(( ${#OPERATION_TARGETS[@]} - 1 ))
    [ "$last" -ge 0 ] || return 0
    if [ "$last" -eq 0 ]; then
        OPERATION_TYPES=()
        OPERATION_TARGETS=()
        OPERATION_BACKUPS=()
        OPERATION_DESCRIPTIONS=()
        OPERATION_HISTORY=()
    else
        unset 'OPERATION_TYPES[last]' 'OPERATION_TARGETS[last]' 'OPERATION_BACKUPS[last]' \
            'OPERATION_DESCRIPTIONS[last]' 'OPERATION_HISTORY[last]'
    fi
}

rollback_last_operation() {
    local last=$(( ${#OPERATION_TARGETS[@]} - 1 ))
    [ "$last" -ge 0 ] || return 0
    rollback_operation_at "$last" || return 1
    discard_last_operation
}

rollback_operations_from() {
    local start="${1:-0}" total idx rollback_count=0 failure_count=0
    local -a old_types old_targets old_backups old_descriptions old_history
    declare -A rolled_back=()

    total="${#OPERATION_TARGETS[@]}"
    [[ "$start" =~ ^[0-9]+$ ]] || return 1
    [ "$start" -le "$total" ] || start="$total"
    [ "$start" -lt "$total" ] || return 0

    old_types=("${OPERATION_TYPES[@]}")
    old_targets=("${OPERATION_TARGETS[@]}")
    old_backups=("${OPERATION_BACKUPS[@]}")
    old_descriptions=("${OPERATION_DESCRIPTIONS[@]}")
    old_history=("${OPERATION_HISTORY[@]}")

    for (( idx=total-1; idx>=start; idx-- )); do
        if rollback_operation_at "$idx"; then
            rolled_back["$idx"]=1
            rollback_count=$((rollback_count + 1))
        else
            failure_count=$((failure_count + 1))
        fi
    done

    OPERATION_TYPES=()
    OPERATION_TARGETS=()
    OPERATION_BACKUPS=()
    OPERATION_DESCRIPTIONS=()
    OPERATION_HISTORY=()
    for (( idx=0; idx<total; idx++ )); do
        if [ "$idx" -lt "$start" ] || [ "${rolled_back[$idx]:-0}" != "1" ]; then
            OPERATION_TYPES+=("${old_types[$idx]}")
            OPERATION_TARGETS+=("${old_targets[$idx]}")
            OPERATION_BACKUPS+=("${old_backups[$idx]}")
            OPERATION_DESCRIPTIONS+=("${old_descriptions[$idx]}")
            OPERATION_HISTORY+=("${old_history[$idx]}")
        fi
    done

    log_info "文件回滚结果: 成功 $rollback_count，失败 $failure_count"
    [ "$failure_count" -eq 0 ]
}

# --- 回滚函数 ---
rollback() {
    if [ "${#OPERATION_TARGETS[@]}" -eq 0 ]; then
        log_warning "没有可回滚的操作"
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过回滚操作"
        return 0
    fi

    log_warning "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_warning "开始回滚操作..."
    log_warning "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_warning "即将回滚以下操作:"
    local idx
    for (( idx=0; idx<${#OPERATION_TARGETS[@]}; idx++ )); do
        log_warning "  - ${OPERATION_TARGETS[$idx]} (${OPERATION_TYPES[$idx]})"
    done
    preview_rollback
    if ! confirm_action "确认继续回滚?" "n"; then
        log_warning "已取消回滚"
        return 1
    fi

    if rollback_operations_from 0; then
        log_success "回滚完成"
        return 0
    fi
    log_error "部分文件回滚失败；失败项已保留在回滚账本中"
    return 1
}

# --- 网络连接检查 ---
check_network() {
    local ipv4 ipv6 target url name result http_code time_total latency
    local -a targets=(
        "www.google.com|Google"
        "github.com|GitHub"
        "www.baidu.com|Baidu"
        "1.1.1.1|Cloudflare DNS"
    )

    log_info "=== 网络连接诊断 ==="
    ipv4="$(curl -fsS4 --connect-timeout 2 --max-time 5 --proto '=https' --tlsv1.2 \
        'https://api.ip.sb/ip' 2>/dev/null || printf 'N/A')"
    ipv6="$(curl -fsS6 --connect-timeout 2 --max-time 5 --proto '=https' --tlsv1.2 \
        'https://api.ip.sb/ip' 2>/dev/null || printf 'N/A')"
    printf '%b\n' "IPv4: ${GREEN}${ipv4}${PLAIN}"
    printf '%b\n' "IPv6: ${GREEN}${ipv6}${PLAIN}"

    printf '\n%s\n' '连通性测试:'
    printf '%-18s %-10s %-10s\n' '目标' '状态' '延迟'
    for target in "${targets[@]}"; do
        IFS='|' read -r url name <<< "$target"
        result="$(curl -o /dev/null -sS -w '%{http_code} %{time_total}' \
            --connect-timeout 2 --max-time 5 "https://${url}" 2>/dev/null)" || \
        result="$(curl -o /dev/null -sS -w '%{http_code} %{time_total}' \
            --connect-timeout 2 --max-time 5 "http://${url}" 2>/dev/null)" || result=""

        http_code=""
        time_total=""
        [ -n "$result" ] && read -r http_code time_total <<< "$result"
        if [[ "$http_code" =~ ^[0-9]{3}$ ]] && \
           [[ "$time_total" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
            latency="$(awk -v seconds="$time_total" 'BEGIN {printf "%.0f", seconds * 1000}')"
            if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 400 ]; then
                printf "%-18s ${GREEN}%-10s${PLAIN} %-10s\n" "$name" 'OK' "${latency}ms"
            else
                printf "%-18s ${RED}%-10s${PLAIN} %-10s\n" "$name" 'Fail' "HTTP $http_code"
            fi
        else
            printf "%-18s ${RED}%-10s${PLAIN} %-10s\n" "$name" 'Fail' 'Timeout'
        fi
    done
}

# --- 配置验证函数 ---
validate_config() {
    local config_file=$1
    local config_type=$2
    
    if [ ! -f "$config_file" ]; then
        log_error "配置文件不存在: $config_file"
        return 1
    fi
    
    case "$config_type" in
        ssh)
            log_info "验证 SSH 配置..."
            if sshd -t -f "$config_file" 2>/dev/null; then
                log_success "SSH 配置验证通过"
                return 0
            else
                log_error "SSH 配置验证失败"
                sshd -t -f "$config_file" 2>&1 | head -5
                return 1
            fi
            ;;
        nginx)
            log_info "验证 Nginx 配置..."
            if command -v nginx > /dev/null 2>&1; then
                if nginx -t -c "$config_file" 2>/dev/null; then
                    log_success "Nginx 配置验证通过"
                    return 0
                else
                    log_error "Nginx 配置验证失败"
                    nginx -t -c "$config_file" 2>&1 | head -5
                    return 1
                fi
            else
                log_warning "Nginx 未安装，跳过配置验证"
                return 0
            fi
            ;;
        docker)
            log_info "验证 Docker 配置..."
            if command -v docker > /dev/null 2>&1; then
                if docker info > /dev/null 2>&1; then
                    log_success "Docker 配置验证通过"
                    return 0
                else
                    log_error "Docker 配置验证失败"
                    return 1
                fi
            else
                log_warning "Docker 未安装，跳过配置验证"
                return 0
            fi
            ;;
        sysctl)
            log_info "验证 sysctl 配置..."
            if sysctl -p "$config_file" > /dev/null 2>&1; then
                log_success "sysctl 配置验证通过"
                return 0
            else
                log_warning "sysctl 配置验证有警告（可能包含未知参数）"
                return 0  # sysctl 警告不影响使用
            fi
            ;;
        *)
            log_warning "未知的配置类型: ${config_type}，跳过验证"
            return 0
            ;;
    esac
}

# --- 系统资源检查 ---
check_system_resources() {
    local min_disk_gb=5 min_memory_mb=512 warnings=0
    local available_disk available_memory cpu_cores

    log_info "检查系统资源..."
    available_disk="$(df -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/, "", $4); print $4}' || printf '0')"
    available_disk="${available_disk:-0}"
    if [[ "$available_disk" =~ ^[0-9]+$ ]] && [ "$available_disk" -lt "$min_disk_gb" ]; then
        log_error "磁盘空间不足: 建议至少 ${min_disk_gb}GB，当前可用 ${available_disk}GB"
        warnings=$((warnings + 1))
    else
        log_success "磁盘空间: ${available_disk}GB 可用"
    fi

    available_memory="$(free -m 2>/dev/null | awk 'NR==2 {print $7}' || printf '0')"
    available_memory="${available_memory:-0}"
    if [[ "$available_memory" =~ ^[0-9]+$ ]] && [ "$available_memory" -lt "$min_memory_mb" ]; then
        log_warning "可用内存较少: 建议至少 ${min_memory_mb}MB，当前可用 ${available_memory}MB"
        warnings=$((warnings + 1))
    else
        log_success "内存: ${available_memory}MB 可用"
    fi

    cpu_cores="$(nproc 2>/dev/null || printf '1')"
    if [[ "$cpu_cores" =~ ^[0-9]+$ ]] && [ "$cpu_cores" -lt 2 ]; then
        log_warning "CPU 核心数较少: 当前 $cpu_cores 核，某些编译操作可能较慢"
    else
        log_success "CPU: ${cpu_cores:-unknown} 核心"
    fi

    if [ "$warnings" -gt 0 ]; then
        log_warning "发现 $warnings 个资源告警"
        [ "$RESOURCE_CHECK_STRICT" = "1" ] && return 1
    fi
    return 0
}

# --- 基础检查 ---
check_root() {
    if [ $EUID -ne 0 ]; then
        printf '%b\n' "${RED}错误: 必须使用 root 用户运行此脚本！${PLAIN}"
        printf '%b\n' "${YELLOW}请使用 sudo 运行: sudo $0${PLAIN}"
        exit 1
    fi
}

check_os() {
    if [ ! -f /etc/os-release ]; then
        error_exit "无法检测操作系统类型"
    fi
    source /etc/os-release
    OS_ID="$ID"
    OS_VERSION="$VERSION_ID"
    
    if [[ "$OS_ID" != "debian" && "$OS_ID" != "ubuntu" ]]; then
        error_exit "此脚本仅支持 Debian 和 Ubuntu 系统"
    fi
    
    log_info "检测到系统: $OS_ID $OS_VERSION"
}

# --- 备份管理 ---
create_backup() {
    local file="$1"
    local description="${2:-}"
    local backup_name backup_path path_hash timestamp

    LAST_BACKUP_FILE=""
    if [ ! -f "$file" ]; then
        log_warning "备份跳过，文件不存在: $file" >&2
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 备份 $file" >&2
        return 0
    fi

    mkdir -p "$BACKUP_DIR" || return 1
    chmod 700 "$BACKUP_DIR" 2>/dev/null || true
    path_hash="$(printf '%s' "$file" | sha256sum | awk '{print substr($1,1,12)}')"
    timestamp="$(date +%Y%m%d_%H%M%S_%N)"
    backup_name="$(basename "$file").${path_hash}.${timestamp}.$$.XXXXXX"
    backup_path="$(mktemp -p "$BACKUP_DIR" "$backup_name")" || return 1
    if ! cp -a -- "$file" "$backup_path"; then
        rm -f -- "$backup_path"
        return 1
    fi
    LAST_BACKUP_FILE="$backup_path"
    log_info "已备份: $file -> $backup_path" >&2
    record_operation restore "$file" "$backup_path" "$description" >&2
    prune_backups_for_file "$file" "$path_hash"
    printf '%s\n' "$backup_path"
}

prune_backups_for_file() {
    local file="$1" path_hash="$2" keep="$BACKUP_RETENTION" count=0 backup
    [[ "$keep" =~ ^[0-9]+$ ]] || keep=20
    [ "$keep" -ge 1 ] || keep=1
    while IFS= read -r backup; do
        count=$((count + 1))
        [ "$count" -le "$keep" ] || rm -f -- "$backup" || true
    done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
        -name "$(basename "$file").${path_hash}.*" -print 2>/dev/null | sort -r)
}

# --- 输入验证函数 ---
validate_port() {
    local port="$1"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        return 1
    fi
    # 检查是否为保留端口
    if [ "$port" -lt 1024 ] && [ "$port" != 22 ]; then
        log_warning "端口 $port 是特权端口，需要 root 权限"
    fi
    return 0
}

# --- 检查服务状态 ---
check_service() {
    local service="$1"
    if systemctl is-active --quiet "$service" 2>/dev/null; then
        return 0
    elif service "$service" status > /dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

systemd_daemon_reload() {
    run_command "重新加载 systemd unit" systemctl daemon-reload
}

enable_and_restart_service() {
    local service_name="$1"
    systemd_daemon_reload || return 1
    run_command "启用 $service_name" systemctl enable "$service_name" || return 1
    run_command "重启 $service_name" systemctl restart "$service_name" || return 1
    if [ "$DRY_RUN" != "1" ] && ! systemctl is-active --quiet "$service_name"; then
        log_error "$service_name 未进入 active 状态"
        return 1
    fi
}

# --- 模块: 换源 (增强版) ---
function action_change_mirrors() {
    log_info "正在备份原配置并更换为阿里云源..."
    
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将重写 /etc/apt/sources.list"
        return 0
    fi
    
    source /etc/os-release
    
    # 检测架构
    local arch=$(dpkg --print-architecture)
    
    if [ "$ID" == "debian" ]; then
        # Debian 源配置
        local codename=$(lsb_release -cs)
        write_file_atomic /etc/apt/sources.list "APT Debian 镜像源" 644 0 0 << EOF || return 1
deb https://mirrors.aliyun.com/debian/ $codename main contrib non-free
deb https://mirrors.aliyun.com/debian/ $codename-updates main contrib non-free
deb https://mirrors.aliyun.com/debian-security/ $codename-security main contrib non-free
EOF
    elif [ "$ID" == "ubuntu" ]; then
        # Ubuntu 源配置
        local codename=$(lsb_release -cs)
        write_file_atomic /etc/apt/sources.list "APT Ubuntu 镜像源" 644 0 0 << EOF || return 1
deb https://mirrors.aliyun.com/ubuntu/ $codename main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ $codename-updates main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ $codename-security main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ $codename-backports main restricted universe multiverse
EOF
    else
        error_exit "不支持的操作系统: $ID"
    fi
    
    log_success "换源完成 (架构: $arch)"
}

# --- 模块: 安装基础工具 (增强版) ---
function action_install_essentials() {
    log_info "安装运维必备工具..."
    export DEBIAN_FRONTEND=noninteractive
    
    # 更新包列表（统一管理）
    # 基础工具
    local packages=(
        curl wget vim nano git unzip zip tar tmux mosh
        htop btop jq ca-certificates gnupg lsb-release
        iperf3 mtr nmap net-tools dnsutils tcpdump iputils-ping socat
        ufw fail2ban unattended-upgrades
        apt-transport-https
    )
    
    # 批量安装（优化版）
    install_packages_batch "${packages[@]}" || return 1

    # 单独尝试安装 software-properties-common (可能在某些极简系统上缺失)
    log_info "尝试安装 software-properties-common..."
    execute_with_progress_argv "安装 software-properties-common" \
        apt-get -o DPkg::Lock::Timeout=120 -y install software-properties-common || \
        log_warning "software-properties-common 安装失败 (非关键错误)"
    
    
    # 时区设置
    run_command "设置时区为 Asia/Shanghai" timedatectl set-timezone Asia/Shanghai || log_warning "时区设置失败"
    
    # 时间同步（优先使用 systemd-timesyncd）
    if systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
        run_command "启用 systemd-timesyncd" systemctl enable systemd-timesyncd || return 1
        run_command "重启 systemd-timesyncd" systemctl restart systemd-timesyncd || return 1
    else
        if command -v ntpdate > /dev/null 2>&1; then
            run_command "同步系统时间" ntpdate pool.ntp.org || log_warning "时间同步失败"
        fi
    fi
    
    log_success "基础环境安装完毕"
}

# --- 模块: 系统优化 (增强版) ---
function action_optimize_system() {
    log_info "系统内核优化..."
    
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将重写 /etc/sysctl.conf 并应用 sysctl -p"
        return 0
    fi
    
    # 检查 BBR 支持
    local bbr_available=false
    if modprobe tcp_bbr 2>/dev/null; then
        bbr_available=true
        log_info "检测到 BBR 支持"
    else
        log_warning "当前内核不支持 BBR，将使用其他拥塞控制算法"
    fi
    
    # 生成优化的 sysctl 配置
    local congestion_control="cubic"
    [ "$bbr_available" = true ] && congestion_control="bbr"
    write_file_atomic /etc/sysctl.d/99-init-optimization.conf "系统内核优化配置" 644 0 0 << EOF || return 1
# 文件系统优化
fs.file-max = 1000000
fs.inotify.max_user_watches = 524288

# 网络优化
net.core.default_qdisc = fq
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 262144
net.ipv4.tcp_max_syn_backlog = 262144
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 1200
net.ipv4.tcp_max_tw_buckets = 5000
net.ipv4.ip_local_port_range = 10000 65000

# 拥塞控制
net.ipv4.tcp_congestion_control = $congestion_control

# 内存优化
vm.swappiness = 10
vm.overcommit_memory = 1

# 路由转发
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1

# 安全设置
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
EOF
    
    run_command "应用 sysctl 配置" sysctl --system || log_warning "部分 sysctl 参数应用失败"
    
    # limits 配置
    local limits_block="* soft nofile 65535
* hard nofile 65535
* soft nproc 65535
* hard nproc 65535
root soft nofile 65535
root hard nofile 65535"
    ensure_block_in_file "/etc/security/limits.conf" "### INIT.SH LIMITS BEGIN" "### INIT.SH LIMITS END" "$limits_block"
    
    # Shell 别名
    local alias_block="alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'
alias ip='ip -c'
alias myip='curl -s ip.sb'
alias rm='rm -I'
alias grep='grep --color=auto'
alias df='df -h'
alias du='du -h'"
    ensure_block_in_file "$HOME/.bashrc" "### INIT.SH ALIASES BEGIN" "### INIT.SH ALIASES END" "$alias_block"
    
    log_success "系统内核优化完成"
}

# --- 模块: 防火墙配置 (新增) ---
function action_configure_firewall() {
    log_info "配置防火墙 (UFW)..."
    
    if ! command -v ufw > /dev/null 2>&1; then
        log_warning "UFW 未安装，跳过防火墙配置"
        return 1
    fi
    
    local ssh_port allow_web
    ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
    ssh_port="${ssh_port:-22}"
    validate_port "$ssh_port" || { log_error "无法确定有效 SSH 端口"; return 1; }

    run_command "设置 UFW 默认入站策略" ufw default deny incoming || return 1
    run_command "设置 UFW 默认出站策略" ufw default allow outgoing || return 1
    run_command "允许 SSH 端口 $ssh_port" ufw allow "$ssh_port/tcp" comment SSH || return 1
    log_info "已允许 SSH 端口: $ssh_port"
    
    # 询问是否允许常用端口
    read -r -p "是否允许 HTTP(80) 和 HTTPS(443) 端口? [y/n]: " allow_web
    case "$allow_web" in
        y|Y|yes|YES)
            run_command "允许 HTTP 端口" ufw allow 80/tcp comment HTTP || return 1
            run_command "允许 HTTPS 端口" ufw allow 443/tcp comment HTTPS || return 1
            log_success "已允许 HTTP/HTTPS 端口"
            ;;
    esac
    
    # 启用防火墙
    run_command "启用 UFW" ufw --force enable || return 1
    log_success "防火墙已启用"
    
    # 显示状态
    [ "$DRY_RUN" = "1" ] || ufw status numbered
}

# --- 模块: Fail2ban 配置 (新增) ---
function action_configure_fail2ban() {
    log_info "配置 Fail2ban..."
    
    if ! command -v fail2ban-client > /dev/null 2>&1; then
        log_info "Fail2ban 未安装，正在安装..."
        install_packages_batch "fail2ban"
        
        if ! command -v fail2ban-client > /dev/null 2>&1; then
             log_error "Fail2ban 安装失败"
             return 1
        fi
    fi
    
    # Detect SSH port
    local ssh_port
    ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
    ssh_port="${ssh_port:-22}"
    log_info "Fail2ban detecting SSH port: $ssh_port"

    # 创建本地配置
    write_file_atomic /etc/fail2ban/jail.d/sshd.local "Fail2ban SSH jail" 644 0 0 << EOF || return 1
[sshd]
enabled = true
port = $ssh_port
logpath = %(sshd_log)s
maxretry = 5
bantime = 3600
findtime = 600
EOF
    
    if enable_and_restart_service fail2ban; then
        log_success "Fail2ban 配置完成并已启动"
    else
        log_error "Fail2ban 启动失败"
        return 1
    fi
}

# --- 模块: 自动更新配置 (新增) ---
function action_configure_auto_updates() {
    log_info "配置自动安全更新..."
    
    if ! command -v unattended-upgrades > /dev/null 2>&1; then
        log_warning "unattended-upgrades 未安装，跳过配置"
        return
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 /etc/apt/apt.conf.d/50unattended-upgrades 和 /etc/apt/apt.conf.d/20auto-upgrades"
        return 0
    fi
    
    write_file_atomic /etc/apt/apt.conf.d/50unattended-upgrades "unattended-upgrades 安全来源" 644 0 0 << 'EOF' || return 1
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
    
    write_file_atomic /etc/apt/apt.conf.d/20auto-upgrades "APT 自动更新周期" 644 0 0 << 'EOF' || return 1
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
EOF
    
    log_success "自动安全更新已配置"
}

# --- 模块: Swap 配置 (新增) ---
function action_configure_swap() {
    log_info "配置 Swap 交换空间..."
    if [ "$DRY_RUN" = "1" ]; then
        dry_run_action_plan action_configure_swap
        return 0
    fi
    
    # 检测现有 Swap
    local existing_swap=$(swapon --show=NAME --noheadings 2>/dev/null | head -1)
    local swap_size=$(free -m | grep Swap | awk '{print $2}')
    
    if [ -n "$existing_swap" ] && [ "$swap_size" -gt 0 ]; then
        log_info "检测到现有 Swap: $existing_swap (大小: ${swap_size}MB)"
        log_warning "为避免中断现有工作负载，脚本不会自动关闭或替换已启用的 Swap"
        return 0
    fi
    
    # 获取内存大小（MB）
    local mem_total=$(free -m | grep Mem | awk '{print $2}')
    local recommended_swap=0
    
    # 根据内存大小推荐 Swap
    if [ "$mem_total" -lt 2048 ]; then
        recommended_swap=2048  # 2GB
    elif [ "$mem_total" -lt 4096 ]; then
        recommended_swap=2048  # 2GB
    elif [ "$mem_total" -lt 8192 ]; then
        recommended_swap=4096  # 4GB
    else
        recommended_swap=4096  # 4GB (最大推荐)
    fi
    
    log_info "系统内存: ${mem_total}MB"
    log_info "推荐 Swap 大小: ${recommended_swap}MB"
    
    read -r -p "请输入 Swap 大小 (MB，留空使用推荐值 ${recommended_swap}MB): " swap_input
    
    local swap_size_mb=${swap_input:-$recommended_swap}
    
    # 验证输入
    if [[ ! "$swap_size_mb" =~ ^[0-9]+$ ]] || [ "$swap_size_mb" -lt 512 ]; then
        log_error "Swap 大小无效，最小 512MB"
        return 1
    fi

    if [ "$swap_size_mb" -gt 16384 ]; then
        log_warning "Swap 大小超过 16GB，可能不必要"
    fi
    
    # 检查磁盘空间
    local available_space=$(df -m / | tail -1 | awk '{print $4}')
    if [ "$available_space" -lt "$swap_size_mb" ]; then
        log_error "磁盘空间不足！可用: ${available_space}MB，需要: ${swap_size_mb}MB"
        return 1
    fi
    
    # 创建 Swap 文件
    local swap_file="/swapfile" swap_candidate="/swapfile.init.$$" old_swap=""
    [ ! -e "$swap_candidate" ] || { log_error "临时 Swap 文件已存在: $swap_candidate"; return 1; }
    
    log_info "创建 ${swap_size_mb}MB Swap 文件（这可能需要几分钟）..."
    
    if ! dd if=/dev/zero of="$swap_candidate" bs=1M count="$swap_size_mb" status=progress; then
        rm -f -- "$swap_candidate"
        return 1
    fi
    chmod 600 "$swap_candidate" || { rm -f -- "$swap_candidate"; return 1; }
    
    # 格式化为 Swap
    log_info "格式化 Swap 文件..."
    ensure_log_file || return 1
    mkswap "$swap_candidate" >> "$LOG_FILE" 2>&1 || {
        log_error "Swap 格式化失败"
        rm -f -- "$swap_candidate"
        return 1
    }

    if [ -e "$swap_file" ]; then
        old_swap="/swapfile.previous.$$"
        mv -- "$swap_file" "$old_swap" || { rm -f -- "$swap_candidate"; return 1; }
    fi
    mv -- "$swap_candidate" "$swap_file" || {
        [ -n "$old_swap" ] && mv -- "$old_swap" "$swap_file"
        return 1
    }
    if ! swapon "$swap_file"; then
        log_error "启用 Swap 失败"
        rm -f -- "$swap_file"
        if [ -n "$old_swap" ]; then
            mv -- "$old_swap" "$swap_file"
            swapon "$swap_file" 2>/dev/null || true
        fi
        return 1
    fi
    [ -n "$old_swap" ] && rm -f -- "$old_swap"
    
    # 添加到 /etc/fstab（如果不存在）
    if ! grep -q "$swap_file" /etc/fstab 2>/dev/null; then
        ensure_block_in_file /etc/fstab "### INIT.SH SWAP BEGIN" "### INIT.SH SWAP END" \
            "$swap_file none swap sw 0 0" "Swap fstab 配置" || return 1
        log_success "已添加到 /etc/fstab，开机自动挂载"
    fi
    
    # 设置 swappiness（如果未设置）
    write_file_atomic /etc/sysctl.d/99-init-swap.conf "Swap swappiness" 644 0 0 <<'EOF' || return 1
vm.swappiness = 10
EOF
    run_command "应用 vm.swappiness=10" sysctl -w vm.swappiness=10 || return 1
    
    # 验证
    local final_swap=$(free -m | grep Swap | awk '{print $2}')
    if [ "$final_swap" -gt 0 ]; then
        log_success "Swap 配置完成！当前 Swap: ${final_swap}MB"
        log_info "Swap 文件位置: $swap_file"
    else
        log_error "Swap 配置失败"
        return 1
    fi
}

# --- 模块: Docker 安装 (新增) ---
function action_install_docker() {
    log_info "安装 Docker 和 Docker Compose..."
    
    # 检查是否已安装
    if command -v docker > /dev/null 2>&1; then
        local docker_version=$(docker --version)
        log_info "检测到已安装 Docker: $docker_version"
        read -r -p "是否重新安装 Docker? [y/n]: " reinstall
        case "$reinstall" in
            y|Y|yes|YES)
                log_info "卸载现有 Docker..."
                execute_with_progress_argv "卸载旧 Docker 包" \
                    apt-get -o DPkg::Lock::Timeout=120 -y remove docker docker-engine docker.io containerd runc || return 1
                ;;
            *)
                # 检查 Docker Compose
                if ! command -v docker-compose > /dev/null 2>&1 && ! docker compose version > /dev/null 2>&1; then
                    log_info "安装 Docker Compose..."
                    install_docker_compose
                else
                    log_success "Docker 和 Docker Compose 已安装"
                    return 0
                fi
                return 0
                ;;
        esac
    fi
    
    # 安装依赖
    log_info "安装 Docker 依赖包..."
    install_packages_batch "ca-certificates" "curl" "gnupg" "lsb-release" || return 1
    
    # 添加 Docker 官方 GPG 密钥
    log_info "添加 Docker 官方 GPG 密钥..."
    run_command "创建 APT keyring 目录" install -m 0755 -d /etc/apt/keyrings || return 1
    local docker_gpg_url="https://download.docker.com/linux/${OS_ID}/gpg"
    local docker_gpg_tmp="/tmp/docker.gpg.asc"
    if download_file "$docker_gpg_url" "$docker_gpg_tmp" "Docker GPG 密钥"; then
        if ! verify_gpg_fingerprint "$docker_gpg_tmp" "9DC858229FC7DD38854AE2D88D81803C0EBFCD88"; then
            log_error "Docker GPG 密钥指纹不匹配"
            return 1
        fi
        local docker_gpg_candidate
        docker_gpg_candidate="$(mktemp /etc/apt/keyrings/.docker.gpg.init.XXXXXX)" || return 1
        gpg --dearmor -o "$docker_gpg_candidate" --yes "$docker_gpg_tmp" || return 1
        atomic_install_file /etc/apt/keyrings/docker.gpg "$docker_gpg_candidate" \
            "Docker APT GPG key" 644 0 0 || return 1
    else
        log_warning "已跳过 Docker GPG 密钥下载"
        return 1
    fi
    
    # 添加 Docker 仓库
    log_info "添加 Docker 仓库..."
    local arch=$(dpkg --print-architecture)
    local codename=$(lsb_release -cs)
    if [ "$codename" == "trixie" ] || [ "$codename" == "sid" ]; then
        log_warning "Detected $codename, using bookworm for Docker repository"
        codename="bookworm"
    fi
    
    write_file_atomic /etc/apt/sources.list.d/docker.list "Docker APT repository" 644 0 0 <<EOF || return 1
deb [arch=$arch signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${OS_ID} ${codename} stable
EOF
    
    # 安装 Docker Engine
    log_info "安装 Docker Engine..."
    APT_UPDATED=false
    update_apt_once || return 1
    if ! execute_with_progress_argv "安装 Docker Engine" \
        apt-get -o DPkg::Lock::Timeout=120 -y install \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
        log_error "Docker 安装失败"
        return 1
    fi
    
    # 启动 Docker
    log_info "启动 Docker 服务..."
    run_command "启用 Docker" systemctl enable docker || return 1
    run_command "启动 Docker" systemctl start docker || return 1
    
    if check_service docker; then
        log_success "Docker 服务已启动"
    else
        log_error "Docker 服务启动失败"
        return 1
    fi
    
    # 安装 Docker Compose（如果使用独立版本）
    install_docker_compose || return 1
    
    # 配置 Docker（可选）
    read -r -p "是否配置 Docker（添加当前用户到 docker 组，配置镜像加速）? [y/n]: " config_docker
    case "$config_docker" in
        y|Y|yes|YES)
            configure_docker || return 1
            ;;
    esac
    
    # 验证安装
    if docker --version > /dev/null 2>&1; then
        local docker_ver=$(docker --version)
        log_success "Docker 安装完成: $docker_ver"
        
        # 测试运行
        if docker run --rm hello-world > /dev/null 2>&1; then
            log_success "Docker 测试运行成功"
        else
            log_warning "Docker 测试运行失败，但安装已完成"
        fi
    else
        log_error "Docker 安装验证失败"
        return 1
    fi
}

# --- Docker Compose 安装辅助函数 ---
function install_docker_compose() {
    # 检查是否已有 Compose V2 (plugin)
    if docker compose version > /dev/null 2>&1; then
        log_info "检测到 Docker Compose V2 (插件版本)"
        return 0
    fi
    
    # 检查是否已有独立版本
    if command -v docker-compose > /dev/null 2>&1; then
        log_info "检测到 Docker Compose (独立版本)"
        return 0
    fi
    
    log_error "未检测到 Docker Compose V2 插件；为避免未固定二进制下载，不再自动安装独立版本"
    log_error "请检查 docker-compose-plugin 包是否安装成功"
    return 1
}

# --- Docker 配置函数 ---
function configure_docker() {
    log_info "配置 Docker..."
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 /etc/docker/daemon.json 并重启 Docker"
        return 0
    fi
    
    # 配置镜像加速（国内服务器）
    read -r -p "是否配置 Docker 镜像加速（推荐国内服务器）? [y/n]: " use_mirror
    case "$use_mirror" in
        y|Y|yes|YES)
            log_info "配置 Docker 镜像加速..."
            write_file_atomic /etc/docker/daemon.json "Docker daemon 配置" 644 0 0 \
                validate_json_candidate << 'EOF' || return 1
{
  "registry-mirrors": [
    "https://docker.mirrors.ustc.edu.cn",
    "https://hub-mirror.c.163.com",
    "https://mirror.baidubce.com"
  ],
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2"
}
EOF
            ;;
        *)
            # 仅配置日志
            write_file_atomic /etc/docker/daemon.json "Docker daemon 配置" 644 0 0 \
                validate_json_candidate << 'EOF' || return 1
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2"
}
EOF
            ;;
    esac
    
    # 验证并重启 Docker
    if ! systemd_daemon_reload || ! systemctl restart docker || ! check_service docker; then
        log_error "Docker 配置应用失败，正在恢复上一份配置"
        rollback_last_operation || true
        systemctl restart docker 2>/dev/null || true
        return 1
    fi
    log_success "Docker 配置完成并已重启"
    
    # 显示配置信息
    if [ -f /etc/docker/daemon.json ]; then
        log_info "Docker 配置内容:"
        cat /etc/docker/daemon.json | jq . 2>/dev/null || cat /etc/docker/daemon.json
    fi
}

# ==============================================================
# Runtime 管理框架
# ==============================================================

# --- 辅助: 目标用户/目录解析 ---
get_user_home() {
    local user="$1"
    local home=""
    if command -v getent > /dev/null 2>&1; then
        home=$(getent passwd "$user" | cut -d: -f6 2>/dev/null || true)
    fi
    if [ -z "$home" ]; then
        if [ "$user" = "root" ]; then
            home="/root"
        else
            home="/home/$user"
        fi
    fi
    echo "$home"
}

detect_preferred_user() {
    local user=""
    if [ -n "${TARGET_USER:-}" ]; then
        user="$TARGET_USER"
    elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != "root" ]; then
        user="$SUDO_USER"
    elif [ -n "${SUDO_UID:-}" ]; then
        if command -v getent > /dev/null 2>&1; then
            user=$(getent passwd "$SUDO_UID" | cut -d: -f1 2>/dev/null || true)
        fi
    fi

    if [ -z "$user" ]; then
        user=$(logname 2>/dev/null || true)
        if [ "$user" = "root" ]; then
            user=""
        fi
    fi

    if [ -z "$user" ] && [ -n "${LOGNAME:-}" ] && [ "${LOGNAME}" != "root" ]; then
        user="$LOGNAME"
    fi
    if [ -z "$user" ] && [ -n "${USER:-}" ] && [ "${USER}" != "root" ]; then
        user="$USER"
    fi

    echo "$user"
}

# --- 辅助: 确定目标用户 (SUDO支持) ---
function determine_target_user() {
    # 如果已经确定过，不再询问
    if [ -n "${INSTALL_USER:-}" ]; then
        if [ -z "${INSTALL_HOME:-}" ]; then
            INSTALL_HOME="$(get_user_home "$INSTALL_USER")"
        fi
        return
    fi

    local target_user
    target_user="$(detect_preferred_user)"
    if [ -n "$target_user" ] && [ "$target_user" != "root" ]; then
        local target_home
        target_home="$(get_user_home "$target_user")"
        printf '%b\n' ""
        log_info "检测到当前用户: $target_user"
        # 询问是否安装到该用户目录
        if confirm_action "是否将用户级安装/配置写入到用户 $target_user 的目录下? (推荐用于开发)" "y"; then
             INSTALL_USER="$target_user"
             INSTALL_HOME="$target_home"
             log_info "将安装到用户: $INSTALL_USER ($INSTALL_HOME)"
             return
        fi
    fi

    INSTALL_USER="root"
    INSTALL_HOME="/root"
    log_info "将安装到用户: root (/root)"
}

function run_as_user() {
    local cmd="$1"
    if [ "$INSTALL_USER" == "root" ]; then
        bash -c "$cmd"
    else
        sudo -H -u "$INSTALL_USER" env HOME="$INSTALL_HOME" USER="$INSTALL_USER" LOGNAME="$INSTALL_USER" bash -c "$cmd"
    fi
}



# --- Runtime 管理器：通用安装接口 ---
function install_runtime() {
    local runtime=$1
    local version=${2:-""}
    local manager=${3:-"auto"}
    
    case "$runtime" in
        nodejs|node)
            install_nodejs "$version" "$manager"
            ;;
        python|py)
            install_python "$version" "$manager"
            ;;
        php)
            install_php "$version" "$manager"
            ;;
        java|jdk)
            install_java "$version" "$manager"
            ;;
        go|golang)
            install_go "$version" "$manager"
            ;;
        dotnet|net)
            install_dotnet "$version" "$manager"
            ;;
        *)
            log_error "不支持的 Runtime: $runtime"
            return 1
            ;;
    esac
}

# --- 检测 Runtime 是否已安装 ---
function check_runtime_installed() {
    local runtime=$1
    
    case "$runtime" in
        nodejs|node)
            command -v node > /dev/null 2>&1 && return 0 || return 1
            ;;
        python|py)
            command -v python3 > /dev/null 2>&1 && return 0 || return 1
            ;;
        php)
            command -v php > /dev/null 2>&1 && return 0 || return 1
            ;;
        java|jdk)
            command -v java > /dev/null 2>&1 && return 0 || return 1
            ;;
        go|golang)
            command -v go > /dev/null 2>&1 && return 0 || return 1
            ;;
        dotnet|net)
            command -v dotnet > /dev/null 2>&1 && return 0 || return 1
            ;;
        *)
            return 1
            ;;
    esac
}

# --- 获取 Runtime 版本 ---
function get_runtime_version() {
    local runtime=$1
    
    case "$runtime" in
        nodejs|node)
            node --version 2>/dev/null | sed 's/v//' || echo ""
            ;;
        python|py)
            python3 --version 2>/dev/null | awk '{print $2}' || echo ""
            ;;
        php)
            php --version 2>/dev/null | head -1 | awk '{print $2}' || echo ""
            ;;
        java|jdk)
            java -version 2>&1 | head -1 | awk -F'"' '{print $2}' || echo ""
            ;;
        go|golang)
            go version 2>/dev/null | awk '{print $3}' | sed 's/go//' || echo ""
            ;;
        dotnet|net)
            dotnet --version 2>/dev/null || echo ""
            ;;
        *)
            echo ""
            ;;
    esac
}

# ==============================================================
# Node.js 安装器 (使用 NVM)
# ==============================================================

# --- 模块: Node.js 安装 (重构) ---
function install_nodejs() {
    local version=${1:-"lts/*"}
    local manager=${2:-"nvm"}
    
    # 确定安装用户
    determine_target_user
    
    log_info "安装 Node.js (使用 $manager, 用户: $INSTALL_USER)..."
    
    # 检查是否已安装
    local is_installed=false
    if run_as_user "command -v node >/dev/null 2>&1"; then is_installed=true; fi
    
    if [ "$is_installed" = true ]; then
        local current_version
        if [ "$INSTALL_USER" == "root" ]; then
             current_version=$(node -v 2>/dev/null)
        else
             current_version=$(sudo -u "$INSTALL_USER" bash -c "export NVM_DIR=\"$INSTALL_HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; node -v" 2>/dev/null)
        fi
        
        log_info "检测到已安装 Node.js: $current_version"
        log_info "检测到已安装 Node.js: $current_version"
        if confirm_action "是否重新安装 Node.js?" "n"; then
            log_info "卸载现有 Node.js..."
            
            # NVM uninstall
            local uninstall_cmd="export NVM_DIR=\"$INSTALL_HOME/.nvm\"; if [ -s \"\$NVM_DIR/nvm.sh\" ]; then source \"\$NVM_DIR/nvm.sh\"; nvm uninstall node; fi"
            run_as_user "$uninstall_cmd" >> "$LOG_FILE" 2>&1
            
            # Apt remove (failsafe)
            apt-get remove -y nodejs npm 2>/dev/null || true
        else
            printf '%b\n' "${YELLOW}使用默认值: n (取消重装)${PLAIN}"
            log_info "保持现有 Node.js 安装"
            return 0
        fi
    fi
    
    # 安装依赖 (需要 Root 权限)
    log_info "安装 Node.js 依赖包..."
    update_apt_once
    install_packages_batch "curl" "wget" "git" "build-essential"
    
    # 安装 NVM
    local nvm_dir="$INSTALL_HOME/.nvm"
    local check_nvm_cmd="[ -s \"$nvm_dir/nvm.sh\" ]"
    
    if run_as_user "$check_nvm_cmd"; then
        log_info "检测到已安装 NVM"
    else
        log_info "安装 NVM..."
        local nvm_version="v0.40.4"
        local nvm_repo="https://github.com/nvm-sh/nvm.git"
        local install_nvm_cmd
        install_nvm_cmd=$(shell_join git clone --depth 1 --branch "$nvm_version" "$nvm_repo" "$nvm_dir")
        
        if confirm_external_resource "$nvm_repo" "克隆 NVM 官方仓库 (${nvm_version})"; then
            if [ "$DRY_RUN" = "1" ]; then
                log_info "[DRY RUN] 跳过 NVM 安装"
                return 0
            fi
            if run_as_user "$install_nvm_cmd" >> "$LOG_FILE" 2>&1; then
                log_success "NVM 安装脚本执行成功"
            
            # 手动配置 NVM 环境到 Shell 配置文件 (解决 .bashrc 不更新的问题)
            log_info "正在配置 NVM 环境变量..."
            
            # 定义 NVM 配置内容
            local nvm_config="
# NVM configuration (added by init script)
export NVM_DIR=\"$INSTALL_HOME/.nvm\"
[ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"
[ -s \"\$NVM_DIR/bash_completion\" ] && \. \"\$NVM_DIR/bash_completion\"
"
            
            local tmp_nvm_config="/tmp/nvm_config_block_$(date +%s)"
            echo "$nvm_config" > "$tmp_nvm_config"
            
            # 优先处理 .bashrc（交互式 bash shell 的标准配置文件）
            # 注意：.profile 主要用于登录 shell，交互式 bash 应该使用 .bashrc
            local bashrc_file="$INSTALL_HOME/.bashrc"
            local config_added=false
            
            log_info "检查 .bashrc 文件: $bashrc_file"
            
            # 确保 .bashrc 存在
            if [ ! -f "$bashrc_file" ]; then
                log_info ".bashrc 不存在，正在创建..."
                if [ "$INSTALL_USER" == "root" ]; then
                    touch "$bashrc_file"
                else
                    run_as_user "touch \"$bashrc_file\""
                    chown "$INSTALL_USER:$INSTALL_USER" "$bashrc_file" 2>/dev/null || true
                fi
                chmod 644 "$bashrc_file" 2>/dev/null || true
                log_success "已创建 .bashrc"
            else
                log_info ".bashrc 已存在"
            fi
            
            # 检查并写入 .bashrc
            # 检查并写入 .bashrc 和 .zshrc
            local config_targets=("$bashrc_file" "$INSTALL_HOME/.zshrc")
            
            for target_file in "${config_targets[@]}"; do
                # 只有当文件存在时才写入 (bashrc 已在前面自动创建)
                if [ -f "$target_file" ]; then
                    if ! grep -q "NVM_DIR" "$target_file"; then
                         log_info "正在向 $(basename "$target_file") 添加 NVM 配置..."
                         if [ "$INSTALL_USER" == "root" ]; then
                             cat "$tmp_nvm_config" >> "$target_file"
                         else
                             cat "$tmp_nvm_config" | sudo -u "$INSTALL_USER" tee -a "$target_file" > /dev/null
                             chown "$INSTALL_USER:$INSTALL_USER" "$target_file" 2>/dev/null || true
                         fi
                         chmod 644 "$target_file" 2>/dev/null || true
                         log_success "已添加 NVM 配置到 $(basename "$target_file")"
                         config_added=true
                    else
                         log_info "$(basename "$target_file") 中已存在 NVM 配置"
                         config_added=true
                    fi
                fi
            done
            
            if [ "$config_added" = false ]; then
                log_error "NVM 配置未能写入任何文件"
            fi
            
            # 如果 .bashrc 配置成功，不再写入其他文件
            # 但如果用户使用 zsh，也配置 .zshrc
            if [ "$config_added" = false ] || [ -n "${ZSH_VERSION:-}" ]; then
                local zshrc_file="$INSTALL_HOME/.zshrc"
                if [ -f "$zshrc_file" ] && ! grep -q "NVM_DIR" "$zshrc_file"; then
                    if [ "$INSTALL_USER" == "root" ]; then
                        cat "$tmp_nvm_config" >> "$zshrc_file"
                    else
                        cat "$tmp_nvm_config" | sudo -u "$INSTALL_USER" tee -a "$zshrc_file" > /dev/null
                        chown "$INSTALL_USER:$INSTALL_USER" "$zshrc_file" 2>/dev/null || true
                    fi
                    chmod 644 "$zshrc_file" 2>/dev/null || true
                    log_success "已添加 NVM 配置到 .zshrc"
                fi
            fi
            rm -f "$tmp_nvm_config"
            
            # 再次检查
            if ! run_as_user "$check_nvm_cmd"; then
                 # 尝试 source 一下再检查 (模拟加载)
                 local check_again="export NVM_DIR=\"$nvm_dir\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; command -v nvm >/dev/null"
                 if ! run_as_user "$check_again"; then
                    log_error "NVM 安装后无法检测到，请手动检查 $nvm_dir"
                    return 1
                 fi
            fi
            log_success "NVM 安装及配置完成"
            else
                log_error "NVM 安装失败"
                return 1
            fi
        else
            log_warning "已跳过 NVM 安装"
            return 1
        fi
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 /etc/fail2ban/jail.d/sshd.local 并重启 fail2ban"
        return 0
    fi
    
    # 版本选择
    if [ -z "$version" ] || [ "$version" == "lts/*" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}Node.js 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[lts]${PLAIN} 最新 LTS 版本 (推荐)"
        printf '%b\n' "${GREEN}[latest]${PLAIN} 最新版本"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本"
        printf '%b\n' ""
        read -r -p "请选择版本 [lts/latest/custom]: " version_choice
        
        case "$version_choice" in
            lts|LTS)
                version="lts/*"
                ;;
            latest|LATEST)
                version="node"
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 18.20.0): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$custom_version" =~ ^[0-9]+\.[0-9]+$ ]]; then
                    version="v${custom_version}"
                else
                    log_warning "版本格式无效 (示例: 18.20.0)，将使用 LTS 版本"
                    version="lts/*"
                fi
                ;;
            *)
                version="lts/*"
                ;;
        esac
    fi
    
    # 安装 Node.js
    log_info "正在安装 Node.js ${version}..."
    
    local node_install_cmd="export NVM_DIR=\"$nvm_dir\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; nvm install \"$version\"; nvm alias default \"$version\"; nvm use default"
    
    if run_as_user "$node_install_cmd" >> "$LOG_FILE" 2>&1; then
        
        # 验证安装
        local verify_cmd="export NVM_DIR=\"$nvm_dir\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; node --version"
        local installed_node=""
        if [ "$INSTALL_USER" == "root" ]; then
            installed_node=$(bash -c "$verify_cmd")
        else
            installed_node=$(sudo -u "$INSTALL_USER" bash -c "$verify_cmd")
        fi
        
        if [ -n "$installed_node" ]; then
            log_success "Node.js 安装完成: $installed_node"
            
            # 配置 npm
            if confirm_action "是否配置 npm（镜像源、全局工具）?" "y"; then
                log_info "配置 npm..."
                
                local nvm_env="export NVM_DIR=\"$nvm_dir\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && \. \"\$NVM_DIR/nvm.sh\"; nvm use default >/dev/null"
                
                # 配置镜像源
                if confirm_action "是否配置 npm 镜像源 (使用 npmmirror)?" "y"; then
                    run_as_user "$nvm_env; npm config set registry https://registry.npmmirror.com"
                    log_success "已设置 npm 镜像源: npmmirror"
                fi
                
                # 安装全局工具
                if confirm_action "是否安装常用全局工具 (yarn, pnpm, pm2)?" "y"; then
                    log_info "安装全局工具..."
                    run_as_user "$nvm_env; npm install -g yarn pnpm pm2"
                    log_success "全局工具安装完成"
                fi
            fi
            
            show_nvm_usage
        else
            log_error "Node.js 安装验证失败"
            return 1
        fi
    else
        log_error "Node.js 安装失败"
        return 1
    fi
}



# --- NVM 使用说明 ---
function show_nvm_usage() {
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "NVM 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看已安装版本:${PLAIN} nvm list"
    printf '%b\n' "  ${GREEN}安装其他版本:${PLAIN} nvm install <version>"
    printf '%b\n' "  ${GREEN}切换版本:${PLAIN} nvm use <version>"
    printf '%b\n' "  ${GREEN}设置默认版本:${PLAIN} nvm alias default <version>"
    printf '%b\n' "  ${GREEN}查看所有可用版本:${PLAIN} nvm list-remote"
    printf '%b\n' ""
    log_warning "注意: 新开终端需要运行 'source ~/.bashrc' 或重新登录"
}

# ==============================================================
# Python 安装器 (使用 pyenv)
# ==============================================================

# --- 模块: Python 安装 ---
function install_python() {
    local version=${1:-""}
    local manager=${2:-"pyenv"}
    
    # 确定安装用户
    determine_target_user
    
    log_info "安装 Python (使用 $manager, 用户: $INSTALL_USER)..."
    
    # 检查是否已安装
    local is_installed=false
    if run_as_user "command -v python3 >/dev/null 2>&1"; then is_installed=true; fi

    if [ "$is_installed" = true ]; then
        local current_version
        if [ "$INSTALL_USER" == "root" ]; then
             current_version=$(python3 --version 2>/dev/null | awk '{print $2}')
        else
             current_version=$(sudo -u "$INSTALL_USER" bash -c "python3 --version" 2>/dev/null | awk '{print $2}')
        fi
        
        log_info "检测到已安装 Python: $current_version"
        log_info "检测到已安装 Python: $current_version"
        if confirm_action "是否重新安装 Python?" "n"; then
            log_info "卸载现有 Python..."
            run_as_user "rm -rf \"$INSTALL_HOME/.pyenv\""
        else
            log_info "保持现有 Python 安装"
            return 0
        fi
    fi
    
    # 安装依赖
    log_info "安装 Python 编译依赖..."
    update_apt_once
    install_packages_batch "make" "build-essential" "libssl-dev" "zlib1g-dev" \
        "libbz2-dev" "libreadline-dev" "libsqlite3-dev" "wget" "curl" "llvm" \
        "libncurses5-dev" "libncursesw5-dev" "xz-utils" "tk-dev" "libffi-dev" \
        "liblzma-dev" "python3-openssl" "git"
    
    # 安装 pyenv
    local pyenv_dir="$INSTALL_HOME/.pyenv"
    local check_pyenv_cmd="[ -d \"$pyenv_dir\" ]"

    if run_as_user "$check_pyenv_cmd"; then
        log_info "检测到已安装 pyenv"
    else
        log_info "安装 pyenv..."
        local pyenv_repo="https://github.com/pyenv/pyenv.git"
        local install_pyenv_cmd
        install_pyenv_cmd=$(shell_join git clone --depth 1 "$pyenv_repo" "$pyenv_dir")
        if confirm_external_resource "$pyenv_repo" "克隆 pyenv 官方仓库"; then
            if [ "$DRY_RUN" = "1" ]; then
                log_info "[DRY RUN] 跳过 pyenv 安装"
                return 0
            fi
            if run_as_user "$install_pyenv_cmd" >> "$LOG_FILE" 2>&1; then
                 log_success "pyenv 安装成功"
            else
                 log_error "pyenv 安装失败"
                 return 1
            fi
        else
            log_warning "已跳过 pyenv 安装"
            return 1
        fi
        
        # Configure .bashrc
        local bashrc_file="$INSTALL_HOME/.bashrc"
        local pyenv_block="export PYENV_ROOT=\"$INSTALL_HOME/.pyenv\"
export PATH=\"\$PYENV_ROOT/bin:\$PATH\"
eval \"\$(pyenv init -)\""
        ensure_block_in_file "$bashrc_file" "### INIT.SH PYENV BEGIN" "### INIT.SH PYENV END" "$pyenv_block"
        log_success "pyenv 已添加到 $bashrc_file"
    fi
    
    # Env setup for subsequent commands
    local env_setup="export PYENV_ROOT=\"$INSTALL_HOME/.pyenv\"; export PATH=\"\$PYENV_ROOT/bin:\$PATH\"; eval \"\$(pyenv init -)\""

    # 版本选择
    if [ -z "$version" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}Python 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[3.11]${PLAIN} Python 3.11 (推荐)"
        printf '%b\n' "${GREEN}[3.12]${PLAIN} Python 3.12 (最新)"
        printf '%b\n' "${GREEN}[3.10]${PLAIN} Python 3.10"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本"
        printf '%b\n' ""
        read -r -p "请选择版本 [3.11/3.12/3.10/custom]: " version_choice
        
        case "$version_choice" in
            3.11|3.12|3.10)
                version="$version_choice"
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 3.9.18): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
                    version="$custom_version"
                else
                    log_warning "版本格式无效，使用 3.11"
                    version="3.11"
                fi
                ;;
            *)
                version="3.11"
                ;;
        esac
    fi
    
    # 安装 Python
    log_info "正在安装 Python ${version}（这可能需要 10-20 分钟）..."
    
    local install_python_cmd="$env_setup; pyenv install \"$version\"; pyenv global \"$version\""
    
    if run_as_user "$install_python_cmd" >> "$LOG_FILE" 2>&1; then
        
        # 验证
        local verify_cmd="$env_setup; python3 --version"
        local installed_python=""
        if [ "$INSTALL_USER" == "root" ]; then
            installed_python=$(bash -c "$verify_cmd")
        else
            installed_python=$(sudo -u "$INSTALL_USER" bash -c "$verify_cmd")
        fi
        
        if [ -n "$installed_python" ]; then
            log_success "Python 安装完成: $installed_python"
            
            # 配置 pip
            read -r -p "是否配置 pip（镜像源、升级 pip）? [y/n]: " config_pip
            case "$config_pip" in
                y|Y|yes|YES)
                    log_info "配置 pip..."
                    local pip_cmd="$env_setup; python3 -m pip install --upgrade pip"
                    run_as_user "$pip_cmd" >> "$LOG_FILE" 2>&1
                    
                    read -r -p "是否使用国内 pip 镜像源（推荐国内服务器）? [y/n]: " use_mirror
                    case "$use_mirror" in
                        y|Y|yes|YES)
                             local pip_conf_dir="$INSTALL_HOME/.pip"
                             local mkdir_cmd="mkdir -p \"$pip_conf_dir\""
                             run_as_user "$mkdir_cmd"
                             
                             local pip_conf_file="$pip_conf_dir/pip.conf"
                             local pip_content="[global]
index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = pypi.tuna.tsinghua.edu.cn"
                             
                             if [ "$DRY_RUN" = "1" ]; then
                                 log_info "[DRY RUN] 写入 pip 配置: $pip_conf_file"
                             else
                                 if [ "$INSTALL_USER" == "root" ]; then
                                     echo "$pip_content" > "$pip_conf_file"
                                 else
                                     echo "$pip_content" | sudo -u "$INSTALL_USER" tee "$pip_conf_file" > /dev/null
                                 fi
                             fi
                             log_success "已设置 pip 镜像源: 清华大学镜像"
                             ;;
                    esac
                    ;;
            esac
            
            show_pyenv_usage
        else
            log_error "Python 安装验证失败"
            return 1
        fi
    else
        log_error "Python 安装失败"
        return 1
    fi
}



# --- pyenv 使用说明 ---
function show_pyenv_usage() {
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "pyenv 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看已安装版本:${PLAIN} pyenv versions"
    printf '%b\n' "  ${GREEN}安装其他版本:${PLAIN} pyenv install <version>"
    printf '%b\n' "  ${GREEN}设置全局版本:${PLAIN} pyenv global <version>"
    printf '%b\n' "  ${GREEN}设置本地版本:${PLAIN} pyenv local <version>"
    printf '%b\n' "  ${GREEN}查看所有可用版本:${PLAIN} pyenv install --list"
    printf '%b\n' ""
    log_warning "注意: 新开终端需要运行 'source ~/.bashrc' 或重新登录"
}

# ==============================================================
# Go 安装器 (官方二进制包)
# ==============================================================

# --- 模块: Go 安装 ---
function install_go() {
    local version=${1:-""}
    local manager=${2:-"official"}
    
    log_info "安装 Go (使用官方二进制包)..."
    install_packages_batch curl jq tar || return 1
    
    # 检查是否已安装
    if check_runtime_installed "go"; then
        local current_version=$(get_runtime_version "go")
        log_info "检测到已安装 Go: $current_version"
        if ! confirm_action "是否重新安装 Go?" "n"; then
            log_info "保持现有 Go 安装"
            return 0
        fi
        
        log_info "新版本完成下载、校验和解压后才会替换现有 Go"
    fi
    
    # 检测系统架构
    local arch=$(uname -m)
    local go_arch=""
    case "$arch" in
        x86_64)
            go_arch="amd64"
            ;;
        aarch64|arm64)
            go_arch="arm64"
            ;;
        armv7l|armv6l)
            go_arch="armv6l"
            ;;
        *)
            log_error "不支持的架构: $arch"
            return 1
            ;;
    esac
    
    log_info "检测到系统架构: $arch (Go: $go_arch)"
    
    # 版本选择
    if [ -z "$version" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}Go 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[latest]${PLAIN} 最新稳定版本 (推荐)"
        printf '%b\n' "${GREEN}[1.21]${PLAIN} Go 1.21"
        printf '%b\n' "${GREEN}[1.22]${PLAIN} Go 1.22"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本 (例如: 1.21.5)"
        printf '%b\n' ""
        read -r -p "请选择版本 [latest/1.21/1.22/custom]: " version_choice
        
        case "$version_choice" in
            latest|LATEST)
                # 获取最新稳定版本
                log_info "查询最新 Go 版本..."
                local go_version_url="https://go.dev/VERSION?m=text"
                if confirm_external_resource "$go_version_url" "查询最新 Go 版本"; then
                    if [ "$DRY_RUN" = "1" ]; then
                        log_info "[DRY RUN] 跳过在线版本查询，使用默认版本 go1.22.0"
                        version="go1.22.0"
                    else
                        version=$(curl -s "$go_version_url" 2>/dev/null | head -1)
                        if [ -z "$version" ] || [[ "$version" != go* ]]; then
                            log_warning "无法获取最新版本，使用默认版本 go1.22.0"
                            version="go1.22.0"
                        fi
                    fi
                else
                    log_warning "已跳过在线版本查询，使用默认版本 go1.22.0"
                    version="go1.22.0"
                fi
                log_info "将安装: $version"
                ;;
            1.21)
                version="go1.21.13"  # 1.21 系列最新
                ;;
            1.22)
                version="go1.22.0"   # 1.22 系列最新
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 1.21.5): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
                    version="go${custom_version}"
                else
                    log_warning "版本格式无效，使用默认版本 go1.22.0"
                    version="go1.22.0"
                fi
                ;;
            *)
                log_warning "无效选择，使用默认版本 go1.22.0"
                version="go1.22.0"
                ;;
        esac
    else
        if [[ "$version" != go* ]]; then
            version="go${version}"
        fi
    fi
    
    log_info "准备安装 Go 版本: $version"
    
    # 下载 Go
    local go_filename="${version}.linux-${go_arch}.tar.gz"
    local go_url="https://go.dev/dl/${go_filename}"
    local download_dir="/tmp"
    local go_tarball="${download_dir}/go-${version}.tar.gz"
    
    log_info "下载 Go (这可能需要几分钟)..."
    log_info "下载地址: $go_url"
    
    if ! download_go_release "$go_filename" "$go_tarball" "Go ${version}"; then
        log_error "Go 下载失败，请检查网络连接"
        return 1
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 Go 解压与安装"
        return 0
    fi
    
    # 检查文件是否下载成功
    if [ ! -f "$go_tarball" ] || [ ! -s "$go_tarball" ]; then
        log_error "Go 下载文件无效"
        return 1
    fi
    
    log_success "Go 下载完成"
    
    local go_stage
    go_stage="$(mktemp -d /tmp/init-go.XXXXXX)" || return 1
    register_temp_file "$go_stage"
    log_info "在私有目录解压 Go..."
    if ! tar -C "$go_stage" -xzf "$go_tarball"; then
        log_error "Go 解压失败"
        rm -f "$go_tarball"
        return 1
    fi
    if [ ! -x "$go_stage/go/bin/go" ]; then
        log_error "Go 归档结构无效"
        return 1
    fi
    replace_directory_transactional /usr/local/go "$go_stage/go" "Go ${version}" || return 1
    
    # 清理下载文件
    rm -f -- "$go_tarball"
    
    # 配置环境变量
    log_info "配置 Go 环境变量..."
    
    # 检查 ~/.bashrc 和 ~/.zshrc 并配置
    local go_config_content="
# Go configuration (added by init script)
export GOROOT=/usr/local/go
export PATH=\$GOROOT/bin:\$PATH
"
    local shell_configs=("$HOME/.bashrc" "$HOME/.zshrc")
    
    for rc_file in "${shell_configs[@]}"; do
        ensure_block_in_file "$rc_file" "### INIT.SH GO BEGIN" "### INIT.SH GO END" "$go_config_content"
        log_success "Go 环境变量已写入 $rc_file"
    done
    
    # 设置当前会话的环境变量
    export GOROOT=/usr/local/go
    export PATH=$GOROOT/bin:$PATH
    
    # 验证安装
    if verify_installation "Go" "go" "$version"; then
        local installed_go=$(go version)
        log_success "Go 安装完成: $installed_go"
        
        # 配置 Go（可选）
        read -r -p "是否配置 Go（GOPROXY、GOPATH、常用工具）? [y/n]: " config_go
        case "$config_go" in
            y|Y|yes|YES)
                configure_go
                ;;
        esac
        
        show_go_usage
    else
        log_error "Go 安装验证失败，请检查环境变量"
        return 1
    fi
}

# --- Go 配置函数 ---
function configure_go() {
    log_info "配置 Go..."
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 Go 配置"
        return 0
    fi
    
    # 配置 GOPROXY（国内镜像）
    read -r -p "是否配置 Go 代理（推荐国内服务器）? [y/n]: " use_proxy
    case "$use_proxy" in
        y|Y|yes|YES)
            log_info "配置 Go 代理..."
            go env -w GOPROXY=https://goproxy.cn,direct
            log_success "已设置 Go 代理: https://goproxy.cn"
            ;;
    esac
    
    # 配置 GOPATH（可选，Go 1.11+ 使用 modules，GOPATH 不是必须的）
    read -r -p "是否配置 GOPATH（留空使用默认 ~/go）? [y/n]: " config_gopath
    case "$config_gopath" in
        y|Y|yes|YES)
            read -r -p "请输入 GOPATH 路径 (留空使用 ~/go): " gopath_path
            if [ -z "$gopath_path" ]; then
                gopath_path="$HOME/go"
            fi
            mkdir -p "$gopath_path"
            go env -w GOPATH="$gopath_path"
            
            # 添加到 PATH（如果不在默认位置）
            if [ "$gopath_path" != "$HOME/go" ]; then
                ensure_block_in_file "$HOME/.bashrc" "### INIT.SH GOPATH BEGIN" "### INIT.SH GOPATH END" "export PATH=\$GOPATH/bin:\$PATH"
            fi
            
            log_success "已设置 GOPATH: $gopath_path"
            ;;
    esac
    
    # 配置 Go 私有模块（可选）
    read -r -p "是否配置 Go 私有模块（GitLab/GitHub Enterprise）? [y/n]: " config_private
    case "$config_private" in
        y|Y|yes|YES)
            read -r -p "请输入私有模块域名 (例如: gitlab.com,github.com): " private_domain
            if [ -n "$private_domain" ]; then
                go env -w GOPRIVATE="$private_domain"
                log_success "已设置私有模块: $private_domain"
            fi
            ;;
    esac
    
    # 安装常用工具（可选）
    read -r -p "是否安装常用 Go 工具? [y/n]: " install_tools
    case "$install_tools" in
        y|Y|yes|YES)
            log_info "安装常用 Go 工具..."
            
            # gopls (Go 语言服务器)
            read -r -p "安装 gopls (Go 语言服务器)? [y/n]: " install_gopls
            case "$install_gopls" in
                y|Y|yes|YES)
                    go install golang.org/x/tools/gopls@latest >> "$LOG_FILE" 2>&1 && \
                        log_success "gopls 安装完成" || log_warning "gopls 安装失败"
                    ;;
            esac
            
            # golangci-lint (代码检查工具)
            read -r -p "安装 golangci-lint (代码检查工具)? [y/n]: " install_lint
            case "$install_lint" in
                y|Y|yes|YES)
                    run_cmd "安装 golangci-lint" "go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest >> \"$LOG_FILE\" 2>&1" && \
                        log_success "golangci-lint 安装完成" || log_warning "golangci-lint 安装失败"
                    ;;
            esac
            
            # air (热重载工具)
            read -r -p "安装 air (热重载工具)? [y/n]: " install_air
            case "$install_air" in
                y|Y|yes|YES)
                    go install github.com/cosmtrek/air@latest >> "$LOG_FILE" 2>&1 && \
                        log_success "air 安装完成" || log_warning "air 安装失败"
                    ;;
            esac
            ;;
    esac
    
    # 显示配置
    log_info "当前 Go 配置:"
    go env | grep -E "GOROOT|GOPATH|GOPROXY|GOPRIVATE" || go env
    
    log_success "Go 配置完成"
}

# --- Go 使用说明 ---
function show_go_usage() {
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "Go 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看版本:${PLAIN} go version"
    printf '%b\n' "  ${GREEN}查看环境变量:${PLAIN} go env"
    printf '%b\n' "  ${GREEN}初始化模块:${PLAIN} go mod init <module-name>"
    printf '%b\n' "  ${GREEN}下载依赖:${PLAIN} go mod download"
    printf '%b\n' "  ${GREEN}构建项目:${PLAIN} go build"
    printf '%b\n' "  ${GREEN}运行项目:${PLAIN} go run main.go"
    printf '%b\n' "  ${GREEN}安装工具:${PLAIN} go install <package>@latest"
    printf '%b\n' ""
    log_warning "注意: 新开终端需要运行 'source ~/.bashrc' 或重新登录"
}

# ==============================================================
# PHP 安装器 (使用 ondrej PPA)
# ==============================================================

# --- 模块: PHP 安装 ---
function install_php() {
    local version=${1:-""}
    local manager=${2:-"ppa"}
    
    log_info "安装 PHP (使用 ondrej PPA)..."
    
    # 检查是否已安装
    if check_runtime_installed "php"; then
        local current_version=$(get_runtime_version "php")
        log_info "检测到已安装 PHP: $current_version"
        if ! confirm_action "是否重新安装 PHP?" "n"; then
            log_info "保持现有 PHP 安装"
            return 0
        fi
        
        # 危险操作确认
        if confirm_dangerous_action "卸载 PHP" "这将删除所有已安装的 PHP 版本和扩展"; then
            log_info "卸载现有 PHP..."
            apt-get remove -y 'php*' 2>/dev/null || true
        else
            return 0
        fi
    fi
    
    # 安装依赖
    log_info "安装 PHP 依赖包..."
    update_apt_once
    install_packages_batch "software-properties-common" "apt-transport-https" "lsb-release" "ca-certificates"
    
    # 添加 ondrej PPA
    log_info "添加 ondrej PHP PPA..."
    if ! add-apt-repository -y ppa:ondrej/php >> "$LOG_FILE" 2>&1; then
        log_error "添加 PPA 失败"
        return 1
    fi
    
    # 添加 PPA 后需要更新
    APT_UPDATED=false
    update_apt_once
    
    # 版本选择
    if [ -z "$version" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}PHP 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[8.2]${PLAIN} PHP 8.2 (推荐)"
        printf '%b\n' "${GREEN}[8.1]${PLAIN} PHP 8.1"
        printf '%b\n' "${GREEN}[8.0]${PLAIN} PHP 8.0"
        printf '%b\n' "${GREEN}[7.4]${PLAIN} PHP 7.4 (旧版)"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本"
        printf '%b\n' ""
        read -r -p "请选择版本 [8.2/8.1/8.0/7.4/custom]: " version_choice
        
        case "$version_choice" in
            8.2|8.1|8.0|7.4)
                version="$version_choice"
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 8.3): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+\.[0-9]+$ ]]; then
                    version="$custom_version"
                else
                    log_warning "版本格式无效，使用 8.2"
                    version="8.2"
                fi
                ;;
            *)
                version="8.2"
                ;;
        esac
    fi
    
    log_info "准备安装 PHP $version..."
    
    # 安装 PHP 核心和常用扩展
    local php_packages=(
        "php${version}"
        "php${version}-cli"
        "php${version}-common"
        "php${version}-fpm"
        "php${version}-mysql"
        "php${version}-xml"
        "php${version}-mbstring"
        "php${version}-curl"
        "php${version}-zip"
        "php${version}-gd"
        "php${version}-redis"
        "php${version}-opcache"
    )
    
    log_info "安装 PHP $version 及常用扩展..."
    install_packages_batch "${php_packages[@]}"
    
    # 验证安装
    if verify_installation "PHP" "php" "$version"; then
        local installed_php=$(php --version | head -1)
        log_success "PHP 安装完成: $installed_php"
        
        # 配置 PHP（可选）
        read -r -p "是否配置 PHP（时区、内存限制、Composer）? [y/n]: " config_php
        case "$config_php" in
            y|Y|yes|YES)
                configure_php "$version"
                ;;
        esac
        
        show_php_usage "$version"
    else
        log_error "PHP 安装验证失败"
        return 1
    fi
}

# --- PHP 配置函数 ---
function configure_php() {
    local version=$1
    
    log_info "配置 PHP $version..."
    
    # 配置时区
    local php_ini="/etc/php/${version}/cli/php.ini"
    local php_fpm_ini="/etc/php/${version}/fpm/php.ini"
    
    if [ -f "$php_ini" ]; then
        create_backup "$php_ini" "PHP CLI 配置" >/dev/null
        sed -i 's/;date.timezone =/date.timezone = Asia\/Shanghai/' "$php_ini"
        log_success "已设置时区: Asia/Shanghai"
    fi
    
    if [ -f "$php_fpm_ini" ]; then
        create_backup "$php_fpm_ini" "PHP-FPM 配置" >/dev/null
        sed -i 's/;date.timezone =/date.timezone = Asia\/Shanghai/' "$php_fpm_ini"
    fi
    
    # 配置内存限制
    read -r -p "是否调整 PHP 内存限制 (默认 128M)? [y/n]: " config_memory
    case "$config_memory" in
        y|Y|yes|YES)
            read -r -p "请输入内存限制 (例如: 256M, 512M): " memory_limit
            if [[ ! "$memory_limit" =~ ^[1-9][0-9]*[KMG]$ ]]; then
                log_warning "内存限制格式无效，应类似 256M、1G"
                return 1
            fi
            if [ -n "$memory_limit" ]; then
                if [ -f "$php_ini" ]; then
                    sed -i "s/memory_limit = .*/memory_limit = $memory_limit/" "$php_ini"
                fi
                if [ -f "$php_fpm_ini" ]; then
                    sed -i "s/memory_limit = .*/memory_limit = $memory_limit/" "$php_fpm_ini"
                fi
                log_success "已设置内存限制: $memory_limit"
            fi
            ;;
    esac
    
    # 安装 Composer
    read -r -p "是否安装 Composer (PHP 包管理器)? [y/n]: " install_composer
    case "$install_composer" in
        y|Y|yes|YES)
            install_composer_tool
            ;;
    esac
    
    log_success "PHP 配置完成"
}

# --- Composer 安装 ---
function install_composer_tool() {
    log_info "安装 Composer..."
    
    if command -v composer > /dev/null 2>&1; then
        log_info "检测到已安装 Composer"
        return 0
    fi
    
    # 下载 Composer 安装脚本
    local composer_setup="/tmp/composer-setup.php"
    local composer_url="https://getcomposer.org/installer"
    if ! download_file "$composer_url" "$composer_setup" "Composer 安装脚本"; then
        log_error "Composer 下载失败"
        return 1
    fi
    
    # 验证安装脚本
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 Composer 安装"
        return 0
    fi
    local composer_sig="/tmp/composer-setup.sig"
    local composer_sig_url="https://composer.github.io/installer.sig"
    if ! download_file "$composer_sig_url" "$composer_sig" "Composer 安装签名"; then
        log_error "Composer 签名下载失败"
        return 1
    fi
    local expected_signature
    expected_signature=$(tr -d '\r\n' < "$composer_sig")
    local actual_signature=$(php -r "echo hash_file('sha384', '$composer_setup');")
    
    if [ "$expected_signature" != "$actual_signature" ]; then
        log_error "Composer 安装脚本签名验证失败"
        rm -f "$composer_setup" "$composer_sig"
        return 1
    fi
    
    # 安装 Composer
    php "$composer_setup" --install-dir=/usr/local/bin --filename=composer >> "$LOG_FILE" 2>&1 || {
        log_error "Composer 安装失败"
        rm -f "$composer_setup" "$composer_sig"
        return 1
    }
    
    rm -f "$composer_setup" "$composer_sig"
    
    # 配置 Composer 镜像（可选）
    read -r -p "是否配置 Composer 国内镜像（推荐国内服务器）? [y/n]: " use_mirror
    case "$use_mirror" in
        y|Y|yes|YES)
            composer config -g repo.packagist composer https://mirrors.aliyun.com/composer/
            log_success "已设置 Composer 镜像: 阿里云"
            ;;
    esac
    
    if command -v composer > /dev/null 2>&1; then
        local composer_version=$(composer --version)
        log_success "Composer 安装完成: $composer_version"
    else
        log_error "Composer 安装验证失败"
        return 1
    fi
}

# --- PHP 使用说明 ---
function show_php_usage() {
    local version=$1
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "PHP 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看版本:${PLAIN} php -v"
    printf '%b\n' "  ${GREEN}查看已安装扩展:${PLAIN} php -m"
    printf '%b\n' "  ${GREEN}查看 PHP 配置:${PLAIN} php -i"
    printf '%b\n' "  ${GREEN}PHP-FPM 配置文件:${PLAIN} /etc/php/${version}/fpm/php.ini"
    printf '%b\n' "  ${GREEN}CLI 配置文件:${PLAIN} /etc/php/${version}/cli/php.ini"
    printf '%b\n' "  ${GREEN}启动 PHP-FPM:${PLAIN} systemctl start php${version}-fpm"
    printf '%b\n' "  ${GREEN}安装扩展:${PLAIN} apt-get install php${version}-<extension>"
    printf '%b\n' ""
    if command -v composer > /dev/null 2>&1; then
        printf '%b\n' "  ${GREEN}Composer 版本:${PLAIN} composer --version"
        printf '%b\n' "  ${GREEN}创建项目:${PLAIN} composer create-project <package>"
        printf '%b\n' ""
    fi
}

# ==============================================================
# Java 安装器 (使用 Adoptium Temurin)
# ==============================================================

# --- 模块: Java 安装 ---
function install_java() {
    local version=${1:-""}
    local manager=${2:-"adoptium"}
    
    log_info "安装 Java (使用 Adoptium Temurin)..."
    
    # 检查是否已安装
    if check_runtime_installed "java"; then
        local current_version=$(get_runtime_version "java")
        log_info "检测到已安装 Java: $current_version"
        if ! confirm_action "是否重新安装 Java?" "n"; then
            log_info "保持现有 Java 安装"
            return 0
        fi
        
        # 危险操作确认
        if confirm_dangerous_action "卸载 Java" "这将删除所有已安装的 Java 版本"; then
            log_info "卸载现有 Java..."
            apt-get remove -y 'openjdk-*' 2>/dev/null || true
            if [ -d "/usr/lib/jvm" ]; then
                rm -rf /usr/lib/jvm/*
            fi
        else
            return 0
        fi
    fi
    
    # 安装依赖
    log_info "安装 Java 依赖包..."
    update_apt_once
    install_packages_batch "wget" "apt-transport-https" "ca-certificates" "gnupg"
    
    # 添加 Adoptium GPG 密钥
    log_info "添加 Adoptium GPG 密钥..."
    mkdir -p /etc/apt/keyrings
    local adoptium_key_url="https://packages.adoptium.net/artifactory/api/gpg/key/public"
    if ! download_file "$adoptium_key_url" "/etc/apt/keyrings/adoptium.asc" "Adoptium GPG 密钥"; then
        log_error "Adoptium GPG 密钥下载失败"
        return 1
    fi
    
    # 添加 Adoptium 仓库
    log_info "添加 Adoptium 仓库..."
    echo "deb [signed-by=/etc/apt/keyrings/adoptium.asc] https://packages.adoptium.net/artifactory/deb $(awk -F= '/^VERSION_CODENAME/{print$2}' /etc/os-release) main" | \
        tee /etc/apt/sources.list.d/adoptium.list >> "$LOG_FILE" 2>&1
    
    # 添加仓库后需要更新
    APT_UPDATED=false
    update_apt_once
    
    # 版本选择
    if [ -z "$version" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}Java 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[17]${PLAIN} Java 17 LTS (推荐)"
        printf '%b\n' "${GREEN}[21]${PLAIN} Java 21 LTS (最新)"
        printf '%b\n' "${GREEN}[11]${PLAIN} Java 11 LTS"
        printf '%b\n' "${GREEN}[8]${PLAIN} Java 8"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本"
        printf '%b\n' ""
        read -r -p "请选择版本 [17/21/11/8/custom]: " version_choice
        
        case "$version_choice" in
            17|21|11|8)
                version="$version_choice"
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 20): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+$ ]]; then
                    version="$custom_version"
                else
                    log_warning "版本格式无效，使用 17"
                    version="17"
                fi
                ;;
            *)
                version="17"
                ;;
        esac
    fi
    
    log_info "准备安装 Java $version..."
    
    # 安装 Java
    local java_package="temurin-${version}-jdk"
    log_info "安装 $java_package..."
    
    if execute_with_progress "安装 Java $version" "apt-get install -y $java_package"; then
        # 设置 JAVA_HOME
        local java_home=$(update-alternatives --list java 2>/dev/null | head -1 | sed 's|/bin/java||')
        if [ -z "$java_home" ]; then
            java_home="/usr/lib/jvm/temurin-${version}-jdk-amd64"
        fi
        
        # 配置环境变量
        local java_block="export JAVA_HOME=${java_home}
export PATH=\$JAVA_HOME/bin:\$PATH"
        ensure_block_in_file "$HOME/.bashrc" "### INIT.SH JAVA BEGIN" "### INIT.SH JAVA END" "$java_block"
        log_success "Java 环境变量已添加到 ~/.bashrc"
        
        export JAVA_HOME="$java_home"
        export PATH="$JAVA_HOME/bin:$PATH"
        
        # 验证安装
        if verify_installation "Java" "java" "$version"; then
            local installed_java=$(java -version 2>&1 | head -1)
            log_success "Java 安装完成: $installed_java"
            
            # 配置 Java（可选）
            read -r -p "是否配置 Java（Maven、Gradle）? [y/n]: " config_java
            case "$config_java" in
                y|Y|yes|YES)
                    configure_java
                    ;;
            esac
            
            show_java_usage
        else
            log_error "Java 安装验证失败"
            return 1
        fi
    else
        log_error "Java 安装失败"
        return 1
    fi
}

# --- Java 配置函数 ---
function configure_java() {
    log_info "配置 Java..."
    
    # 安装 Maven
    read -r -p "是否安装 Maven? [y/n]: " install_maven
    case "$install_maven" in
        y|Y|yes|YES)
            install_maven_tool
            ;;
    esac
    
    # 安装 Gradle
    read -r -p "是否安装 Gradle? [y/n]: " install_gradle
    case "$install_gradle" in
        y|Y|yes|YES)
            install_gradle_tool
            ;;
    esac
    
    log_success "Java 配置完成"
}

# --- Maven 安装 ---
function install_maven_tool() {
    log_info "安装 Maven..."
    
    if command -v mvn > /dev/null 2>&1; then
        log_info "检测到已安装 Maven"
        return 0
    fi
    
    local maven_version="3.9.6"
    local maven_url="https://archive.apache.org/dist/maven/maven-3/${maven_version}/binaries/apache-maven-${maven_version}-bin.tar.gz"
    local maven_sha_url="${maven_url}.sha512"
    local maven_dir="/opt/maven"
    local maven_tar="/tmp/maven.tar.gz"
    
    log_info "下载 Maven ${maven_version}..."
    if ! download_and_verify_checksum_url "$maven_url" "$maven_sha_url" sha512 "$maven_tar" "Maven ${maven_version}"; then
        log_error "Maven 下载失败"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 Maven 解压与安装"
        return 0
    fi
    
    local maven_stage
    maven_stage="$(mktemp -d /tmp/init-maven.XXXXXX)" || return 1
    register_temp_file "$maven_stage"
    mkdir -p "$maven_stage/maven"
    tar -xzf "$maven_tar" -C "$maven_stage/maven" --strip-components=1 || return 1
    [ -x "$maven_stage/maven/bin/mvn" ] || { log_error "Maven 归档结构无效"; return 1; }
    replace_directory_transactional "$maven_dir" "$maven_stage/maven" "Maven ${maven_version}" || return 1
    rm -f -- "$maven_tar"
    
    # 配置环境变量
    local maven_block="export MAVEN_HOME=${maven_dir}
export PATH=\$MAVEN_HOME/bin:\$PATH"
    ensure_block_in_file "$HOME/.bashrc" "### INIT.SH MAVEN BEGIN" "### INIT.SH MAVEN END" "$maven_block"
    
    export MAVEN_HOME="$maven_dir"
    export PATH="$MAVEN_HOME/bin:$PATH"
    
    if command -v mvn > /dev/null 2>&1; then
        local maven_ver=$(mvn --version | head -1)
        log_success "Maven 安装完成: $maven_ver"
    else
        log_error "Maven 安装验证失败"
        return 1
    fi
}

# --- Gradle 安装 ---
function install_gradle_tool() {
    log_info "安装 Gradle..."
    
    if command -v gradle > /dev/null 2>&1; then
        log_info "检测到已安装 Gradle"
        return 0
    fi
    
    local gradle_version="8.5"
    local gradle_url="https://services.gradle.org/distributions/gradle-${gradle_version}-bin.zip"
    local gradle_sha_url="${gradle_url}.sha256"
    local gradle_dir="/opt/gradle"
    local gradle_zip="/tmp/gradle.zip"
    
    log_info "下载 Gradle ${gradle_version}..."
    install_packages_batch unzip || return 1
    if ! download_and_verify_checksum_url "$gradle_url" "$gradle_sha_url" sha256 "$gradle_zip" "Gradle ${gradle_version}"; then
        log_error "Gradle 下载失败"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 Gradle 解压与安装"
        return 0
    fi
    
    local gradle_stage
    gradle_stage="$(mktemp -d /tmp/init-gradle.XXXXXX)" || return 1
    register_temp_file "$gradle_stage"
    unzip -q "$gradle_zip" -d "$gradle_stage" || return 1
    [ -x "$gradle_stage/gradle-${gradle_version}/bin/gradle" ] || { log_error "Gradle 归档结构无效"; return 1; }
    mkdir -p "$gradle_dir"
    replace_directory_transactional "$gradle_dir/gradle" "$gradle_stage/gradle-${gradle_version}" \
        "Gradle ${gradle_version}" || return 1
    rm -f -- "$gradle_zip"
    
    # 配置环境变量
    local gradle_block="export GRADLE_HOME=${gradle_dir}/gradle
export PATH=\$GRADLE_HOME/bin:\$PATH"
    ensure_block_in_file "$HOME/.bashrc" "### INIT.SH GRADLE BEGIN" "### INIT.SH GRADLE END" "$gradle_block"
    
    export GRADLE_HOME="$gradle_dir/gradle"
    export PATH="$GRADLE_HOME/bin:$PATH"
    
    if command -v gradle > /dev/null 2>&1; then
        local gradle_ver=$(gradle --version | head -1)
        log_success "Gradle 安装完成: $gradle_ver"
    else
        log_error "Gradle 安装验证失败"
        return 1
    fi
}

# --- Java 使用说明 ---
function show_java_usage() {
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info "Java 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看版本:${PLAIN} java -version"
    printf '%b\n' "  ${GREEN}查看编译器版本:${PLAIN} javac -version"
    printf '%b\n' "  ${GREEN}查看 JAVA_HOME:${PLAIN} echo \$JAVA_HOME"
    printf '%b\n' "  ${GREEN}编译 Java 文件:${PLAIN} javac Main.java"
    printf '%b\n' "  ${GREEN}运行 Java 程序:${PLAIN} java Main"
    printf '%b\n' ""
    if command -v mvn > /dev/null 2>&1; then
        printf '%b\n' "  ${GREEN}Maven 版本:${PLAIN} mvn --version"
        printf '%b\n' "  ${GREEN}创建 Maven 项目:${PLAIN} mvn archetype:generate"
        printf '%b\n' ""
    fi
    if command -v gradle > /dev/null 2>&1; then
        printf '%b\n' "  ${GREEN}Gradle 版本:${PLAIN} gradle --version"
        printf '%b\n' "  ${GREEN}初始化 Gradle 项目:${PLAIN} gradle init"
        printf '%b\n' ""
    fi
    log_warning "注意: 新开终端需要运行 'source ~/.bashrc' 或重新登录"
}

# ==============================================================
# .NET 安装器 (官方脚本)
# ==============================================================

# --- 模块: .NET 安装 ---
function install_dotnet() {
    local version=${1:-""}
    local manager=${2:-"official"}
    
    log_info "安装 .NET (使用官方安装脚本)..."
    
    # 检查是否已安装
    if check_runtime_installed "dotnet"; then
        local current_version=$(get_runtime_version "dotnet")
        log_info "检测到已安装 .NET: $current_version"
        if ! confirm_action "是否重新安装 .NET?" "n"; then
            log_info "保持现有 .NET 安装"
            return 0
        fi
        
        # 危险操作确认
        if confirm_dangerous_action "卸载 .NET" "这将删除所有已安装的 .NET SDK 和运行时"; then
            log_info "卸载现有 .NET..."
            apt-get remove -y 'dotnet*' 2>/dev/null || true
            rm -rf /usr/share/dotnet
            rm -rf /etc/dotnet
        else
            return 0
        fi
    fi
    
    # 安装依赖
    log_info "安装 .NET 依赖包..."
    update_apt_once
    install_packages_batch "wget" "apt-transport-https"
    
    # 版本选择
    if [ -z "$version" ]; then
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}.NET 版本选择:${PLAIN}"
        printf '%b\n' "${GREEN}[8.0]${PLAIN} .NET 8.0 (最新 LTS)"
        printf '%b\n' "${GREEN}[7.0]${PLAIN} .NET 7.0"
        printf '%b\n' "${GREEN}[6.0]${PLAIN} .NET 6.0 LTS"
        printf '%b\n' "${GREEN}[latest]${PLAIN} 最新版本"
        printf '%b\n' "${GREEN}[custom]${PLAIN} 自定义版本"
        printf '%b\n' ""
        read -r -p "请选择版本 [8.0/7.0/6.0/latest/custom]: " version_choice
        
        case "$version_choice" in
            8.0|7.0|6.0)
                version="$version_choice"
                ;;
            latest|LATEST)
                version="8.0"  # 默认最新 LTS
                ;;
            custom|CUSTOM)
                read -r -p "请输入版本号 (例如: 8.0): " custom_version
                if [[ "$custom_version" =~ ^[0-9]+\.[0-9]+$ ]]; then
                    version="$custom_version"
                else
                    log_warning "版本格式无效，使用 8.0"
                    version="8.0"
                fi
                ;;
            *)
                version="8.0"
                ;;
        esac
    fi
    
    log_info "准备安装 .NET $version..."
    
    # 添加 Microsoft 仓库
    log_info "添加 Microsoft 仓库..."
    local microsoft_repo_pkg="/tmp/packages-microsoft-prod.deb"
    local microsoft_repo_url="https://packages.microsoft.com/config/${OS_ID}/$(lsb_release -rs)/packages-microsoft-prod.deb"
    if ! download_file "$microsoft_repo_url" "$microsoft_repo_pkg" "Microsoft apt 仓库配置包"; then
        log_error "下载 Microsoft 仓库配置失败"
        return 1
    fi
    
    dpkg -i "$microsoft_repo_pkg" >> "$LOG_FILE" 2>&1
    rm -f "$microsoft_repo_pkg"
    update_apt_once
    
    # 安装 .NET SDK
    log_info "安装 .NET SDK $version..."
    if execute_with_progress "安装 .NET SDK $version" "apt-get install -y dotnet-sdk-${version}"; then
        # 验证安装
        if verify_installation ".NET" "dotnet" "$version"; then
            local installed_dotnet=$(dotnet --version)
            log_success ".NET 安装完成: $installed_dotnet"
            
            # 配置 .NET（可选）
            read -r -p "是否配置 .NET（NuGet 源）? [y/n]: " config_dotnet
            case "$config_dotnet" in
                y|Y|yes|YES)
                    configure_dotnet
                    ;;
            esac
            
            show_dotnet_usage
        else
            log_error ".NET 安装验证失败"
            return 1
        fi
    else
        log_error ".NET 安装失败"
        return 1
    fi
}

# --- .NET 配置函数 ---
function configure_dotnet() {
    log_info "配置 .NET..."
    
    # 配置 NuGet 源（可选）
    read -r -p "是否配置 NuGet 国内镜像（推荐国内服务器）? [y/n]: " use_mirror
    case "$use_mirror" in
        y|Y|yes|YES)
            log_info "配置 NuGet 镜像..."
            dotnet nuget add source https://nuget.cdn.azure.cn/v3/index.json -n azure-china >> "$LOG_FILE" 2>&1
            log_success "已添加 NuGet 镜像: Azure China"
            ;;
    esac
    
    # 显示已配置的源
    log_info "当前 NuGet 源:"
    dotnet nuget list source
    
    log_success ".NET 配置完成"
}

# --- .NET 使用说明 ---
function show_dotnet_usage() {
    printf '%b\n' ""
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log_info ".NET 使用说明:"
    log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf '%b\n' "  ${GREEN}查看版本:${PLAIN} dotnet --version"
    printf '%b\n' "  ${GREEN}查看已安装 SDK:${PLAIN} dotnet --list-sdks"
    printf '%b\n' "  ${GREEN}查看已安装运行时:${PLAIN} dotnet --list-runtimes"
    printf '%b\n' "  ${GREEN}创建新项目:${PLAIN} dotnet new <template>"
    printf '%b\n' "  ${GREEN}构建项目:${PLAIN} dotnet build"
    printf '%b\n' "  ${GREEN}运行项目:${PLAIN} dotnet run"
    printf '%b\n' "  ${GREEN}发布项目:${PLAIN} dotnet publish"
    printf '%b\n' "  ${GREEN}安装 NuGet 包:${PLAIN} dotnet add package <package>"
    printf '%b\n' ""
}

# ==============================================================
# Runtime 安装菜单
# ==============================================================

# --- 模块: Runtime 安装菜单 (新增) ---
function action_install_runtime() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#            Runtime 安装管理器                #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}请选择要安装的 Runtime:${PLAIN}"
        printf '%b\n' ""
        printf '%b\n' "${GREEN}[1]${PLAIN} Node.js (使用 nvm)"
        printf '%b\n' "${GREEN}[2]${PLAIN} Python (使用 pyenv)"
        printf '%b\n' "${GREEN}[3]${PLAIN} PHP (使用 ondrej PPA)"
        printf '%b\n' "${GREEN}[4]${PLAIN} Java (使用 Adoptium)"
        printf '%b\n' "${GREEN}[5]${PLAIN} Go (官方二进制包)"
        printf '%b\n' "${GREEN}[6]${PLAIN} .NET (官方安装)"
        printf '%b\n' "${GREEN}[7]${PLAIN} 批量安装（选择多个）"
        printf '%b\n' "${GREEN}[0]${PLAIN} 返回主菜单"
        printf '%b\n' ""
        read -r -p "请输入 [0-7]: " choice

        case "$choice" in
            1) run_menu_action install_nodejs ;;
            2) run_menu_action install_python ;;
            3) run_menu_action install_php ;;
            4) run_menu_action install_java ;;
            5) run_menu_action install_go ;;
            6) run_menu_action install_dotnet ;;
            7) run_menu_action install_runtime_batch ;;
            0) return 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 批量安装 Runtime ---
function install_runtime_batch() {
    clear
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#            批量安装 Runtime                   #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}请选择要安装的 Runtime（可多选，用空格分隔）:${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "${GREEN}[1]${PLAIN} Node.js"
    printf '%b\n' "${GREEN}[2]${PLAIN} Python"
    printf '%b\n' "${GREEN}[3]${PLAIN} PHP"
    printf '%b\n' "${GREEN}[4]${PLAIN} Java"
    printf '%b\n' "${GREEN}[5]${PLAIN} Go"
    printf '%b\n' "${GREEN}[6]${PLAIN} .NET"
    printf '%b\n' ""
    read -r -p "请输入选择 (例如: 1 2): " selections
    
    local runtimes=()
    for sel in $selections; do
        case "$sel" in
            1) runtimes+=("nodejs") ;;
            2) runtimes+=("python") ;;
            3) runtimes+=("php") ;;
            4) runtimes+=("java") ;;
            5) runtimes+=("go") ;;
            6) runtimes+=("dotnet") ;;
        esac
    done
    
    if [ ${#runtimes[@]} -eq 0 ]; then
        log_warning "未选择任何 Runtime"
        return
    fi
    
    printf '%b\n' ""
    log_info "将安装以下 Runtime: ${runtimes[*]}"
    read -r -p "确认安装? [y/n]: " confirm
    case "$confirm" in
        y|Y|yes|YES)
            for runtime in "${runtimes[@]}"; do
                printf '%b\n' ""
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                if ! invoke_action install_runtime "$runtime"; then
                    log_warning "Runtime 安装失败或被取消: $runtime"
                fi
                printf '%b\n' ""
            done
            log_success "批量安装完成！"
            ;;
        *)
            log_info "已取消"
            ;;
    esac
}

# --- 兼容性：保留旧函数名 ---
function action_install_nvm_node() {
    install_nodejs
}

# ==============================================================
# SSH 安全配置
# ==============================================================

# --- 模块: SSH 安全配置（事务式） ---
validate_authorized_keys_candidate() {
    local candidate="$1" line trimmed tmp valid_count=0
    [ -s "$candidate" ] || return 1
    command -v ssh-keygen > /dev/null 2>&1 || {
        log_error "缺少 ssh-keygen，无法校验 authorized_keys"
        return 1
    }
    tmp="$(mktemp /tmp/init-authorized-key.XXXXXX)" || return 1
    chmod 600 "$tmp"
    while IFS= read -r line || [ -n "$line" ]; do
        trimmed="$(trim_whitespace "$line")"
        [ -z "$trimmed" ] && continue
        case "$trimmed" in \#*) continue ;; esac
        printf '%s\n' "$line" > "$tmp"
        if ! ssh-keygen -l -f "$tmp" > /dev/null 2>&1; then
            rm -f -- "$tmp"
            return 1
        fi
        valid_count=$((valid_count + 1))
    done < "$candidate"
    rm -f -- "$tmp"
    [ "$valid_count" -gt 0 ]
}

authorized_keys_has_valid_key() {
    local key_file="${1:-/root/.ssh/authorized_keys}"
    [ -s "$key_file" ] && validate_authorized_keys_candidate "$key_file"
}

authorized_keys_is_usable_for_user() {
    local target_user="$1" target_home="$2"
    local ssh_dir="$target_home/.ssh" key_file="$target_home/.ssh/authorized_keys"
    local uid key_uid dir_uid home_uid key_mode dir_mode home_mode

    authorized_keys_has_valid_key "$key_file" || return 1
    uid="$(id -u "$target_user")" || return 1
    key_uid="$(stat -c '%u' "$key_file" 2>/dev/null)" || return 1
    dir_uid="$(stat -c '%u' "$ssh_dir" 2>/dev/null)" || return 1
    home_uid="$(stat -c '%u' "$target_home" 2>/dev/null)" || return 1
    key_mode="$(stat -c '%a' "$key_file" 2>/dev/null)" || return 1
    dir_mode="$(stat -c '%a' "$ssh_dir" 2>/dev/null)" || return 1
    home_mode="$(stat -c '%a' "$target_home" 2>/dev/null)" || return 1

    if [ "$key_uid" -ne "$uid" ] || [ "$dir_uid" -ne "$uid" ]; then
        log_warning "$target_user 的 .ssh/authorized_keys 所有者不正确"
        return 1
    fi
    if [ "$home_uid" -ne "$uid" ] && [ "$home_uid" -ne 0 ]; then
        log_warning "$target_user 的主目录所有者既不是该用户也不是 root"
        return 1
    fi
    if [ $((8#$key_mode & 022)) -ne 0 ] || \
       [ $((8#$dir_mode & 022)) -ne 0 ] || \
       [ $((8#$home_mode & 022)) -ne 0 ]; then
        log_warning "$target_user 的主目录、.ssh 或 authorized_keys 可被组/其他用户写入"
        return 1
    fi
}

install_authorized_key() {
    local target_user="$1" target_home="$2" public_key="$3"
    local ssh_dir key_file key_type key_blob uid gid candidate
    read -r key_type key_blob _ <<< "$public_key"
    case "$key_type" in
        ssh-ed25519|ssh-rsa|ecdsa-sha2-*) ;;
        *) log_error "不支持或无效的 SSH 公钥类型"; return 1 ;;
    esac
    [ -n "$key_blob" ] || return 1

    ssh_dir="$target_home/.ssh"
    key_file="$ssh_dir/authorized_keys"
    uid="$(id -u "$target_user")" || return 1
    gid="$(id -g "$target_user")" || return 1
    run_command "创建 $target_user 的 SSH 目录" install -d -m 700 -o "$uid" -g "$gid" "$ssh_dir" || return 1
    if [ -f "$key_file" ] && awk -v type="$key_type" -v blob="$key_blob" '$1 == type && $2 == blob {found=1} END {exit !found}' "$key_file"; then
        log_info "SSH 公钥已存在，跳过追加"
        return 0
    fi
    candidate="$(mktemp "$ssh_dir/.authorized_keys.init.XXXXXX")" || return 1
    [ -f "$key_file" ] && cp -- "$key_file" "$candidate"
    printf '%s\n' "$public_key" >> "$candidate"
    atomic_install_file "$key_file" "$candidate" "SSH authorized_keys" 600 "$uid" "$gid" validate_authorized_keys_candidate
}

validate_ssh_key_target_user() {
    local target_user="$1" require_non_root="${2:-false}"
    local uid target_home login_shell

    if ! id "$target_user" > /dev/null 2>&1; then
        log_error "SSH 密钥目标用户不存在: $target_user"
        return 1
    fi
    uid="$(id -u "$target_user")" || return 1
    if [ "$require_non_root" = true ] && [ "$uid" -eq 0 ]; then
        log_error "普通用户选项不能使用 UID 0 账户: $target_user"
        return 1
    fi

    target_home="$(get_user_home "$target_user")"
    case "$target_home" in
        /*) ;;
        *)
            log_error "用户 $target_user 的主目录不是绝对路径: $target_home"
            return 1
            ;;
    esac
    if [ "$target_home" = "/" ] || [ ! -d "$target_home" ]; then
        log_error "用户 $target_user 的主目录不可用于 SSH 密钥: $target_home"
        return 1
    fi

    login_shell="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f7 || true)"
    case "$login_shell" in
        */nologin|*/false)
            log_error "用户 $target_user 使用不可登录 Shell: $login_shell"
            return 1
            ;;
    esac
}

user_has_sudo_access() {
    local target_user="$1"

    if id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|wheel'; then
        return 0
    fi
    command -v sudo > /dev/null 2>&1 && sudo -n -l -U "$target_user" > /dev/null 2>&1
}

select_ssh_key_target() {
    local target_spec="${SSH_KEY_TARGET:-}" choice="" preferred_user="" require_non_root=false
    SSH_SELECTED_USER=""
    SSH_SELECTED_HOME=""

    if [ -z "$target_spec" ] && [ "$NON_INTERACTIVE" = "1" ]; then
        target_spec="root"
        log_info "[非交互] SSH 密钥目标默认使用 root；可通过 SSH_KEY_TARGET 覆盖"
    fi

    if [ -z "$target_spec" ]; then
        preferred_user="$(detect_preferred_user)"
        if [ -n "$preferred_user" ] && id "$preferred_user" > /dev/null 2>&1 && \
           [ "$(id -u "$preferred_user")" -ne 0 ]; then
            printf '%b\n' "${CYAN}SSH 公钥目标账户:${PLAIN}"
            printf '%b\n' "  1) root"
            printf '%b\n' "  2) 已有普通用户 ${CYAN}[建议: $preferred_user]${PLAIN}"
            printf '%b\n' "  3) 不处理 authorized_keys，仅配置 SSH 服务"
            read -r -p "请选择 [1-3，默认 2]: " choice || return 1
            choice="${choice:-2}"
        else
            printf '%b\n' "${CYAN}SSH 公钥目标账户:${PLAIN}"
            printf '%b\n' "  1) root"
            printf '%b\n' "  2) 已有普通用户"
            printf '%b\n' "  3) 不处理 authorized_keys，仅配置 SSH 服务"
            read -r -p "请选择 [1-3，默认 1]: " choice || return 1
            choice="${choice:-1}"
        fi

        case "$choice" in
            1)
                target_spec="root"
                ;;
            2)
                read -r -p "请输入已有普通用户名${preferred_user:+ [默认 $preferred_user]}: " target_spec || return 1
                target_spec="${target_spec:-$preferred_user}"
                [ -n "$target_spec" ] || {
                    log_error "普通用户名不能为空"
                    return 1
                }
                require_non_root=true
                ;;
            3)
                target_spec="none"
                ;;
            *)
                log_error "无效的 SSH 公钥目标选项: $choice"
                return 1
                ;;
        esac
    fi

    case "${target_spec,,}" in
        none|skip)
            log_info "已选择不处理任何用户的 authorized_keys"
            return 0
            ;;
        root)
            target_spec="root"
            ;;
        *)
            require_non_root=true
            ;;
    esac

    validate_ssh_key_target_user "$target_spec" "$require_non_root" || return 1
    SSH_SELECTED_USER="$target_spec"
    SSH_SELECTED_HOME="$(get_user_home "$target_spec")"
    log_info "SSH 公钥目标账户: $SSH_SELECTED_USER ($SSH_SELECTED_HOME)"
}

set_sshd_directive_in_file() {
    local config_file="$1" key="$2" value="$3" tmp
    tmp="$(mktemp "$(dirname "$config_file")/.sshd-edit.XXXXXX")" || return 1
    if ! awk -v key="$key" -v value="$value" '
        BEGIN { done=0; in_match=0; key_l=tolower(key) }
        {
            probe=$0
            sub(/^[[:space:]]*/, "", probe)
            split(probe, fields, /[[:space:]]+/)
            token=fields[1]
            sub(/^#/, "", token)
            if (tolower(token) == "match" && !in_match) {
                if (!done) print key " " value
                done=1
                in_match=1
                print
                next
            }
            if (!in_match && tolower(token) == key_l) {
                if (!done) print key " " value
                done=1
                next
            }
            print
        }
        END { if (!done) print key " " value }
    ' "$config_file" > "$tmp"; then
        rm -f -- "$tmp"
        return 1
    fi
    mv -f -- "$tmp" "$config_file"
}

reload_ssh_service() {
    if command -v systemctl > /dev/null 2>&1; then
        if systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null; then
            return 0
        fi
    fi
    service ssh reload 2>/dev/null || service sshd reload 2>/dev/null
}

function action_configure_ssh_transactional() {
    local config_file="/etc/ssh/sshd_config" candidate current_port ssh_port user_key
    local has_key=false target_has_sudo=false disable_password="n" root_login_change="none" port_changed=false

    if [ "$DRY_RUN" = "1" ]; then
        dry_run_action_plan action_configure_ssh
        return 0
    fi
    [ -f "$config_file" ] || { log_error "SSH 配置不存在: $config_file"; return 1; }
    command -v sshd > /dev/null 2>&1 || { log_error "未找到 sshd"; return 1; }

    candidate="$(mktemp "$(dirname "$config_file")/.sshd_config.init.XXXXXX")" || return 1
    cp -- "$config_file" "$candidate" || { rm -f -- "$candidate"; return 1; }
    current_port="$(sshd -T -f "$candidate" 2>/dev/null | awk '$1 == "port" {print $2; exit}')"
    current_port="${current_port:-22}"
    if [ "$NON_INTERACTIVE" = "1" ]; then
        ssh_port="$current_port"
        log_info "[非交互] 保持当前 SSH 端口: $ssh_port"
    else
        read -r -p "请输入新的 SSH 端口 [当前 ${current_port}，留空保持]: " ssh_port || {
            rm -f -- "$candidate"
            return 1
        }
    fi
    ssh_port="${ssh_port:-$current_port}"
    validate_port "$ssh_port" || { rm -f -- "$candidate"; log_error "SSH 端口无效"; return 1; }
    if [ "$ssh_port" != "$current_port" ]; then
        if ss -H -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$ssh_port$"; then
            rm -f -- "$candidate"
            log_error "端口 $ssh_port 已被占用"
            return 1
        fi
        port_changed=true
    fi

    if ! select_ssh_key_target; then
        rm -f -- "$candidate"
        return 1
    fi
    if [ -n "$SSH_SELECTED_USER" ]; then
        if authorized_keys_is_usable_for_user "$SSH_SELECTED_USER" "$SSH_SELECTED_HOME"; then
            has_key=true
            log_success "检测到 $SSH_SELECTED_USER 已配置可用的 SSH 公钥"
        fi
        if [ "$NON_INTERACTIVE" = "1" ]; then
            user_key="$SSH_PUBLIC_KEY"
            if [ -n "$user_key" ]; then
                log_info "[非交互] 将验证并追加 SSH_PUBLIC_KEY 到 $SSH_SELECTED_USER"
            else
                log_info "[非交互] 未提供 SSH_PUBLIC_KEY，仅检查现有 authorized_keys"
            fi
        else
            read -r -p "粘贴要追加到 $SSH_SELECTED_USER 的 SSH 公钥 [留空跳过]: " user_key || {
                rm -f -- "$candidate"
                return 1
            }
        fi
        if [ -n "$user_key" ]; then
            install_authorized_key "$SSH_SELECTED_USER" "$SSH_SELECTED_HOME" "$user_key" || {
                rm -f -- "$candidate"
                return 1
            }
            if authorized_keys_is_usable_for_user "$SSH_SELECTED_USER" "$SSH_SELECTED_HOME"; then
                has_key=true
            else
                log_warning "公钥已写入，但目录所有权或权限不满足安全校验"
            fi
        fi
        if [ "$has_key" = true ] && [ "$SSH_SELECTED_USER" != "root" ] && \
           user_has_sudo_access "$SSH_SELECTED_USER"; then
            target_has_sudo=true
            log_success "已确认 $SSH_SELECTED_USER 具备 sudo 管理权限"
        fi
    fi

    set_sshd_directive_in_file "$candidate" Port "$ssh_port" || { rm -f -- "$candidate"; return 1; }
    set_sshd_directive_in_file "$candidate" PermitEmptyPasswords no || { rm -f -- "$candidate"; return 1; }
    set_sshd_directive_in_file "$candidate" X11Forwarding no || { rm -f -- "$candidate"; return 1; }
    set_sshd_directive_in_file "$candidate" MaxAuthTries 3 || { rm -f -- "$candidate"; return 1; }
    if [ "$has_key" = true ]; then
        set_sshd_directive_in_file "$candidate" PubkeyAuthentication yes || { rm -f -- "$candidate"; return 1; }
        if [ "$SSH_SELECTED_USER" = "root" ]; then
            if confirm_action "是否禁用 root 密码登录（保留 root 公钥登录）?" "y"; then
                root_login_change="prohibit-password"
                set_sshd_directive_in_file "$candidate" PermitRootLogin prohibit-password || {
                    rm -f -- "$candidate"
                    return 1
                }
            fi
        elif [ "$target_has_sudo" = true ]; then
            if confirm_action "是否禁用 root SSH 登录（使用 $SSH_SELECTED_USER + sudo 管理）?" "n"; then
                root_login_change="disabled"
                set_sshd_directive_in_file "$candidate" PermitRootLogin no || {
                    rm -f -- "$candidate"
                    return 1
                }
            fi
        else
            log_warning "$SSH_SELECTED_USER 没有可确认的 sudo 权限，不提供禁用 root SSH 登录选项"
        fi

        if [ "$SSH_SELECTED_USER" = "root" ] || [ "$target_has_sudo" = true ]; then
            if confirm_action "是否禁用所有 SSH 密码认证?" "n"; then
                disable_password="y"
                set_sshd_directive_in_file "$candidate" PasswordAuthentication no || {
                    rm -f -- "$candidate"
                    return 1
                }
                set_sshd_directive_in_file "$candidate" KbdInteractiveAuthentication no || {
                    rm -f -- "$candidate"
                    return 1
                }
            fi
        else
            log_warning "缺少已验证的公钥管理账户，不提供禁用所有 SSH 密码认证选项"
        fi
    elif [ -n "$SSH_SELECTED_USER" ]; then
        log_warning "未检测到 $SSH_SELECTED_USER 的有效公钥，不提供禁用登录方式的选项"
    else
        log_info "未选择 SSH 密钥目标，不修改 PubkeyAuthentication、密码认证或 root 登录策略"
    fi

    if [ "$disable_password" = "y" ]; then
        if [ "$SSH_SELECTED_USER" != "root" ] && [ "$target_has_sudo" != true ]; then
            log_error "安全校验失败：禁用密码认证前必须有可用的公钥管理账户"
            rm -f -- "$candidate"
            return 1
        fi
        if [ "$SSH_SELECTED_USER" = "root" ] && [ "$root_login_change" = "disabled" ]; then
            log_error "安全校验失败：不能同时禁用唯一公钥管理账户和密码认证"
            rm -f -- "$candidate"
            return 1
        fi
    fi

    if ! validate_sshd_candidate "$candidate" "$config_file"; then
        sshd -t -f "$candidate" 2>&1 | head -n 10 >&2 || true
        rm -f -- "$candidate"
        return 1
    fi
    if [ "$port_changed" = true ] && command -v ufw > /dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
        run_command "在 UFW 中预先放行新 SSH 端口 $ssh_port" ufw allow "$ssh_port/tcp" comment SSH || return 1
    fi
    atomic_install_file "$config_file" "$candidate" "SSH 安全配置" preserve 0 0 validate_sshd_candidate || return 1

    if ! reload_ssh_service; then
        log_error "SSH reload 失败，正在恢复上一份配置"
        rollback_last_operation || true
        reload_ssh_service || true
        return 1
    fi
    if ! sshd -T > /dev/null 2>&1; then
        log_error "SSH reload 后有效配置检查失败，正在恢复"
        rollback_last_operation || true
        reload_ssh_service || true
        return 1
    fi
    log_success "SSH 配置已安全应用；端口: ${ssh_port}，密钥账户: ${SSH_SELECTED_USER:-未处理}，禁用密码: ${disable_password}，root 登录调整: $root_login_change"
}

# 公开入口固定指向事务式实现。
action_configure_ssh() {
    action_configure_ssh_transactional "$@"
}

# ==============================================================
# 服务器测试脚本
# ==============================================================

# --- 模块: 运行测试脚本 ---
function action_run_test_scripts() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#           服务器测试脚本选择                  #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' ""
        printf '%b\n' "${YELLOW}请选择要运行的测试脚本:${PLAIN}"
        printf '%b\n' ""
        printf '%b\n' "${GREEN}[1]${PLAIN} NodeQuality - 节点质量检测"
        printf '%b\n' "${GREEN}[2]${PLAIN} Yabs - Yet Another Benchmark Script (性能测试)"
        printf '%b\n' "${GREEN}[3]${PLAIN} RegionRestrictionCheck - 流媒体解锁检测"
        printf '%b\n' "${GREEN}[4]${PLAIN} IP质量体检脚本 - IP 质量检测"
        printf '%b\n' "${GREEN}[5]${PLAIN} 融合怪测评脚本 - 综合性能测试"
        printf '%b\n' "${GREEN}[0]${PLAIN} 返回主菜单"
        printf '%b\n' ""
        read -r -p "请输入 [0-5]: " choice

        case "$choice" in
            1)
                log_info "运行 NodeQuality 节点质量检测..."
                if confirm_action "确认运行 NodeQuality?" "y"; then
                    run_remote_script_unverified 'https://run.NodeQuality.com' \
                        'NodeQuality 节点质量检测' || log_warning "已跳过 NodeQuality 脚本"
                fi
                ;;
            2)
                log_info "运行 Yabs 性能测试..."
                if confirm_action "确认运行 Yabs?" "y"; then
                    run_remote_script_unverified 'https://yabs.sh' \
                        'Yabs 性能测试' || log_warning "已跳过 Yabs 测试"
                fi
                ;;
            3)
                log_info "运行 RegionRestrictionCheck 流媒体解锁检测..."
                if confirm_action "确认运行 RegionRestrictionCheck?" "y"; then
                    run_remote_script_unverified 'https://check.unlock.media' \
                        'RegionRestrictionCheck' || log_warning "已跳过 RegionRestrictionCheck"
                fi
                ;;
            4)
                log_info "运行 IP质量体检脚本..."
                if confirm_action "确认运行 IP质量体检脚本?" "y"; then
                    run_remote_script_unverified 'https://Check.Place' \
                        'IP 质量检测脚本' '-I' || log_warning "已跳过 IP 质量检测脚本"
                fi
                ;;
            5)
                log_info "运行融合怪测评脚本..."
                if confirm_action "确认运行融合怪测评脚本?" "y"; then
                    local script_path='/tmp/ecs.sh'
                    local ecs_url='https://gitlab.com/spiritysdx/za/-/raw/main/ecs.sh'
                    if download_remote_script_unverified "$ecs_url" "$script_path" '融合怪测评脚本'; then
                        bash "$script_path" || log_warning "融合怪测评脚本执行失败"
                        rm -f -- "$script_path"
                    else
                        log_warning "已跳过融合怪测评脚本"
                    fi
                fi
                ;;
            0) return 0 ;;
            *) menu_invalid_choice; continue ;;
        esac
        menu_pause
    done
}

# --- 模块: DD 重装脚本 (新增) ---
function action_dd_reinstall() {
    clear
    printf '%b\n' "${RED}################################################${PLAIN}"
    printf '%b\n' "${RED}#            ⚠️  危险警告: DD 系统重装            #${PLAIN}"
    printf '%b\n' "${RED}################################################${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "${RED}此操作将【擦除所有数据】并重装操作系统！${PLAIN}"
    printf '%b\n' "${RED}此操作不可逆！请确保你已备份所有重要数据！${PLAIN}"
    printf '%b\n' "${YELLOW}脚本来源: https://github.com/bin456789/reinstall${PLAIN}"
    printf '%b\n' ""
    
    # 强制确认
    read -r -p "请输入 'install' 以确认执行 DD 重装 (输入其他取消): " confirm_dd
    if [ "$confirm_dd" != "install" ]; then
        log_info "操作已取消"
        return
    fi
    
    log_info "正在下载 DD 脚本..."
    local dd_script="/root/reinstall.sh"
    local dd_url="https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh"
    if ! download_remote_script "$dd_url" "$dd_script" "DD 重装脚本"; then
        log_error "DD 脚本下载失败，请检查网络"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 跳过 DD 脚本执行"
        return 0
    fi
    log_success "DD 脚本下载成功"
    
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}请选择重装目标系统:${PLAIN}"
    printf '%b\n' "${GREEN}[1]${PLAIN} Debian 12 (Bookworm)"
    printf '%b\n' "${GREEN}[2]${PLAIN} Debian 11 (Bullseye)"
    printf '%b\n' "${GREEN}[3]${PLAIN} Ubuntu 22.04 (Jammy)"
    printf '%b\n' "${GREEN}[4]${PLAIN} Ubuntu 20.04 (Focal)"
    printf '%b\n' "${GREEN}[5]${PLAIN} CentOS 7"
    printf '%b\n' "${GREEN}[6]${PLAIN} Alpine Linux"
    printf '%b\n' "${GREEN}[7]${PLAIN} Windows 11 (需要大内存)"
    printf '%b\n' "${GREEN}[8]${PLAIN} 自定义命令 (手动输入参数)"
    printf '%b\n' "${GREEN}[0]${PLAIN} 取消"
    printf '%b\n' ""
    
    read -r -p "请输入选择 [0-8]: " dd_choice
    
    local dd_args=()
    case "$dd_choice" in
        1) dd_args=(debian 12) ;;
        2) dd_args=(debian 11) ;;
        3) dd_args=(ubuntu 22.04) ;;
        4) dd_args=(ubuntu 20.04) ;;
        5) dd_args=(centos 7) ;;
        6) dd_args=(alpine) ;;
        7) dd_args=(windows 11) ;;
        8)
            read -r -p "请输入完整参数 (例如: debian 12 --password mypassword): " custom_args
            read -r -a dd_args <<< "$custom_args"
            ;;
        0) return ;;
        *) log_error "无效选择"; return ;;
    esac

    local cmd
    cmd=$(shell_join bash "$dd_script" "${dd_args[@]}")
    
    printf '%b\n' ""
    printf '%b\n' "${RED}即将执行: $cmd${PLAIN}"
    printf '%b\n' "${RED}系统将在安装开始后重启，SSH 将断开连接。${PLAIN}"
    printf '%b\n' "${YELLOW}默认密码通常为: 123@@@ (具体请参考脚本说明)${PLAIN}"
    
    if confirm_dangerous_action "执行 DD 重装" "系统将被重置"; then
        log_info "开始执行 DD 重装..."
        run_cmd "执行 DD 重装" "$cmd"
    fi
}

# --- 模块: 1Panel 安装 (新增) ---
function action_install_1panel() {
    log_info "安装 1Panel 面板..."
    local url="https://resource.1panel.pro/v2/quick_start.sh"
    printf '%b\n' "${YELLOW}脚本来源: ${url}${PLAIN}"
    
    if confirm_action "确认安装 1Panel?" "y"; then
        run_remote_script "$url" "1Panel 官方安装脚本"
    fi
}

# --- 模块: 炫酷 MOTD (新增) ---
function action_configure_motd() {
    log_info "配置炫酷 MOTD (登录欢迎信息)..."
    
    # 安装必要工具
    update_apt_once
    install_packages_batch "lsb-release" "bc" "figlet" "lolcat"
    
    # 创建 MOTD 脚本
    cat > /usr/local/bin/cool-motd.sh << 'EOF'
#!/bin/bash

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
PLAIN='\033[0m'
BOLD='\033[1m'

# 获取系统信息
os_info=$(lsb_release -ds 2>/dev/null || cat /etc/*release 2>/dev/null | head -n1 || uname -om)
kernel_info=$(uname -r)
uptime_info=$(uptime -p | sed 's/up //')
load_info=$(cat /proc/loadavg | awk '{print $1, $2, $3}')
cpu_info=$(grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | sed 's/^[ \t]*//')
mem_total=$(free -h | awk '/Mem:/ {print $2}')
mem_used=$(free -h | awk '/Mem:/ {print $3}')
disk_total=$(df -h / | awk 'NR==2 {print $2}')
disk_used=$(df -h / | awk 'NR==2 {print $3}')
disk_usage=$(df -h / | awk 'NR==2 {print $5}')
ip_v4=$(curl -4 -s ifconfig.me || curl -4 -s ip.sb)
ip_v6=$(curl -6 -s ifconfig.me || curl -6 -s ip.sb)

# 清屏
clear

# 显示 Banner (如果有 figlet 和 lolcat)
if command -v figlet >/dev/null && command -v lolcat >/dev/null; then
    hostname | figlet | lolcat
else
    printf '%b\n' "${BLUE}${BOLD}$(hostname)${PLAIN}"
fi

printf '%b\n' "${CYAN}==============================================================${PLAIN}"
printf '%b\n' " ${BOLD}OS      :${PLAIN} $os_info"
printf '%b\n' " ${BOLD}Kernel  :${PLAIN} $kernel_info"
printf '%b\n' " ${BOLD}Uptime  :${PLAIN} $uptime_info"
printf '%b\n' " ${BOLD}Load    :${PLAIN} $load_info"
printf '%b\n' " ${BOLD}CPU     :${PLAIN} $cpu_info"
printf '%b\n' " ${BOLD}Memory  :${PLAIN} $mem_used / $mem_total"
printf '%b\n' " ${BOLD}Disk    :${PLAIN} $disk_used / $disk_total ($disk_usage)"
if [ -n "$ip_v4" ]; then
    printf '%b\n' " ${BOLD}IPv4    :${PLAIN} $ip_v4"
fi
if [ -n "$ip_v6" ]; then
    printf '%b\n' " ${BOLD}IPv6    :${PLAIN} $ip_v6"
fi
printf '%b\n' "${CYAN}==============================================================${PLAIN}"
printf '%b\n' ""
EOF

    chmod +x /usr/local/bin/cool-motd.sh
    
    # 添加到 profile (所有用户登录时显示)
    if [ -d /etc/profile.d ]; then
        echo "/usr/local/bin/cool-motd.sh" > /etc/profile.d/99-cool-motd.sh
        log_success "MOTD 已配置 (通过 /etc/profile.d)"
    else
        # 备用方案：添加到 .bashrc 和 .zshrc
        local config_files=("$HOME/.bashrc" "$HOME/.zshrc")
        for rc_file in "${config_files[@]}"; do
            if [ -f "$rc_file" ]; then
                if ! grep -q "cool-motd.sh" "$rc_file"; then
                    echo "/usr/local/bin/cool-motd.sh" >> "$rc_file"
                    log_success "MOTD 已添加到 $rc_file"
                else
                    log_info "MOTD 已存在于 $rc_file"
                fi
            fi
        done
    fi
    
    # 禁用默认 MOTD (可选，视系统而定)
    chmod -x /etc/update-motd.d/* 2>/dev/null || true
    
    # 立即展示效果
    /usr/local/bin/cool-motd.sh
}



# --- 模块: 系统工具箱 (新增) ---
# --- 模块: Docker Manager (Ported from kejilion.sh) ---

save_iptables_rules() {
    mkdir -p /etc/iptables
    touch /etc/iptables/rules.v4
    iptables-save > /etc/iptables/rules.v4
    if ! crontab -l 2>/dev/null | grep -q "iptables-restore"; then
         (crontab -l 2>/dev/null; echo "@reboot iptables-restore < /etc/iptables/rules.v4") | crontab -
    fi
}

check_docker_app_ip() {
    local docker_name="$1"
    echo "------------------------"
    echo "访问地址:"
    local ipv4=$(curl -s4m 5 https://api.ip.sb/ip || echo "")
    local docker_port=$(docker port "$docker_name" 2>/dev/null | head -n 1 | awk -F':' '{print $NF}')
    
    if [ -n "$ipv4" ] && [ -n "$docker_port" ]; then
        echo "http://$ipv4:${docker_port}"
    fi
}

clear_container_rules() {
    local container_name_or_id=$1
    local allowed_ip=$2
    local container_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_name_or_id")
    if [ -z "$container_ip" ]; then return 1; fi
    
    apt-get install -y iptables
    
    iptables -D DOCKER-USER -p tcp -d "$container_ip" -j DROP 2>/dev/null || true
    iptables -D DOCKER-USER -p tcp -s "$allowed_ip" -d "$container_ip" -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -p tcp -s 127.0.0.0/8 -d "$container_ip" -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -p udp -d "$container_ip" -j DROP 2>/dev/null || true
    iptables -D DOCKER-USER -p udp -s "$allowed_ip" -d "$container_ip" -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -p udp -s 127.0.0.0/8 -d "$container_ip" -j ACCEPT 2>/dev/null || true
    
    echo "已清除该容器的访问规则"
    save_iptables_rules
}

block_container_port() {
    local container_name_or_id=$1
    local allowed_ip=$2
    local container_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_name_or_id")
    if [ -z "$container_ip" ]; then return 1; fi
    
    apt-get install -y iptables
    
    iptables -I DOCKER-USER -p tcp -d "$container_ip" -j DROP
    iptables -I DOCKER-USER -p tcp -s "$allowed_ip" -d "$container_ip" -j ACCEPT
    iptables -I DOCKER-USER -p tcp -s 127.0.0.0/8 -d "$container_ip" -j ACCEPT
    iptables -I DOCKER-USER -p udp -d "$container_ip" -j DROP
    iptables -I DOCKER-USER -p udp -s "$allowed_ip" -d "$container_ip" -j ACCEPT
    iptables -I DOCKER-USER -p udp -s 127.0.0.0/8 -d "$container_ip" -j ACCEPT
    
    echo "已限制IP访问该服务"
    save_iptables_rules
}

detect_country_code() {
    local country="" geo=""
    country="$(curl -fsS --connect-timeout 2 --max-time 5 --proto '=https' --tlsv1.2 \
        'https://ipinfo.io/country' 2>/dev/null | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]' || true)"
    if [[ "$country" =~ ^[A-Z]{2}$ ]]; then
        printf '%s' "$country"
        return 0
    fi

    geo="$(curl -fsS --connect-timeout 2 --max-time 5 --proto '=https' --tlsv1.2 \
        'https://api.ip.sb/geoip' 2>/dev/null || true)"
    if command -v jq > /dev/null 2>&1; then
        country="$(printf '%s' "$geo" | jq -r '.country_code // empty' 2>/dev/null | tr '[:lower:]' '[:upper:]')"
    else
        country="$(printf '%s' "$geo" | sed -n 's/.*"country_code"[[:space:]]*:[[:space:]]*"\([A-Za-z][A-Za-z]\)".*/\1/p' | tr '[:lower:]' '[:upper:]')"
    fi
    [[ "$country" =~ ^[A-Z]{2}$ ]] || return 1
    printf '%s' "$country"
}

install_add_docker_cn() {
    local country=""
    country="$(detect_country_code 2>/dev/null || true)"
    if [ "$country" = "CN" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            log_info "[DRY RUN] 将写入 /etc/docker/daemon.json (国内镜像)"
            return 0
        fi
        write_file_atomic /etc/docker/daemon.json "Docker 国内镜像配置" 644 0 0 \
            validate_json_candidate <<'EOF' || return 1
{
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://docker.m.ixdev.cn",
    "https://hub.rat.dev",
    "https://dockerproxy.net",
    "https://docker.m.daocloud.io",
    "https://docker.kejilion.pro"
  ]
}
EOF
        log_info "已配置国内 Docker 镜像源"
    elif [ -z "$country" ]; then
        log_warning "无法在超时内判断国家/地区，已跳过自动写入国内 Docker 镜像"
    else
        log_info "检测到国家/地区代码 $country，不写入国内 Docker 镜像"
    fi
    enable_and_restart_service docker
}

linuxmirrors_install_docker() {
    log_info "已改用 Docker 官方 apt 仓库安装流程"
    action_install_docker
}

action_install_add_docker() {
    log_info "正在通过 Docker 官方 apt 仓库安装 Docker 环境..."
    linuxmirrors_install_docker
}

docker_tato() {
    local container_count=$(docker ps -a -q 2>/dev/null | wc -l)
    local image_count=$(docker images -q 2>/dev/null | wc -l)
    local network_count=$(docker network ls -q 2>/dev/null | wc -l)
    local volume_count=$(docker volume ls -q 2>/dev/null | wc -l)

    if command -v docker > /dev/null; then
        printf '%b\n' "${CYAN}------------------------${PLAIN}"
        printf '%b\n' "${GREEN}Docker 环境已安装${PLAIN}  容器: ${GREEN}$container_count${PLAIN}  镜像: ${GREEN}$image_count${PLAIN}  网络: ${GREEN}$network_count${PLAIN}  卷: ${GREEN}$volume_count${PLAIN}"
    else
        printf '%b\n' "${YELLOW}Docker 未安装${PLAIN}"
    fi
}

is_valid_ipv4() {
    local ip="$1" a b c d octet
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    IFS='.' read -r a b c d <<< "$ip"
    for octet in "$a" "$b" "$c" "$d"; do
        [ "$octet" -ge 0 ] 2>/dev/null && [ "$octet" -le 255 ] 2>/dev/null || return 1
    done
}

get_public_ipv4() {
    local ip=""
    ip="$(curl -fsS4 --connect-timeout 2 --max-time 5 --proto '=https' --tlsv1.2 \
        'https://api.ip.sb/ip' 2>/dev/null | tr -d '[:space:]' || true)"
    is_valid_ipv4 "$ip" || return 1
    printf '%s' "$ip"
}

prompt_allowed_ipv4() {
    local value="" detected=""
    detected="$(get_public_ipv4 2>/dev/null || true)"
    read -r -e -p "允许访问的来源 IPv4${detected:+ [默认 $detected]}: " value
    value="${value:-$detected}"
    is_valid_ipv4 "$value" || { log_error "无效 IPv4: ${value:-empty}"; return 1; }
    printf '%s' "$value"
}

submenu_docker_container() {
    local sub_choice dockername choice container_id container_info container_name network_info line
    local network_name ip_address docker_name allowed_ip
    local -a ids docker_args

    while true; do
        clear
        echo "Docker 容器列表"
        docker ps -a --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}" || true
        echo ""
        printf '%b\n' "${CYAN}容器操作${PLAIN}"
        echo "------------------------"
        echo "1. 创建新的容器"
        echo "------------------------"
        echo "2. 启动指定容器             6. 启动所有容器"
        echo "3. 停止指定容器             7. 停止所有容器"
        echo "4. 删除指定容器             8. 删除所有容器"
        echo "5. 重启指定容器             9. 重启所有容器"
        echo "------------------------"
        echo "11. 进入指定容器           12. 查看容器日志"
        echo "13. 查看容器网络           14. 查看容器占用"
        echo "------------------------"
        echo "15. 清除容器 IP 限制       16. 限制容器仅允许指定 IPv4"
        echo "------------------------"
        echo "0. 返回上一级"
        echo "------------------------"
        read -r -e -p "请输入你的选择: " sub_choice
        case "$sub_choice" in
            1)
                docker_args=()
                read -r -e -a docker_args -p "请输入 docker 子命令及参数（例如 run -d --name web nginx:latest）: "
                if [ "${#docker_args[@]}" -eq 0 ]; then
                    log_warning "命令不能为空"
                elif confirm_dangerous_action "执行 Docker 命令" "docker $(shell_join "${docker_args[@]}")"; then
                    docker "${docker_args[@]}"
                fi
                ;;
            2|3|4|5|11|12)
                read -r -e -p "请输入容器名或 ID: " dockername
                [ -n "$dockername" ] || { log_warning "容器名不能为空"; menu_pause; continue; }
                case "$sub_choice" in
                    2) docker start "$dockername" ;;
                    3) docker stop "$dockername" ;;
                    4)
                        if confirm_dangerous_action "删除容器 $dockername" "将强制删除该容器"; then
                            docker rm -f "$dockername"
                        fi
                        ;;
                    5) docker restart "$dockername" ;;
                    11) docker exec -it "$dockername" /bin/sh ;;
                    12) docker logs "$dockername" ;;
                esac
                ;;
            6)
                mapfile -t ids < <(docker ps -a -q)
                [ "${#ids[@]}" -gt 0 ] && docker start "${ids[@]}" || log_info "没有可启动的容器"
                ;;
            7)
                mapfile -t ids < <(docker ps -q)
                [ "${#ids[@]}" -gt 0 ] && docker stop "${ids[@]}" || log_info "没有运行中的容器"
                ;;
            8)
                mapfile -t ids < <(docker ps -a -q)
                if [ "${#ids[@]}" -eq 0 ]; then
                    log_info "没有容器"
                elif confirm_dangerous_action "删除全部容器" "将强制删除 ${#ids[@]} 个容器"; then
                    docker rm -f "${ids[@]}"
                fi
                ;;
            9)
                mapfile -t ids < <(docker ps -q)
                [ "${#ids[@]}" -gt 0 ] && docker restart "${ids[@]}" || log_info "没有运行中的容器"
                ;;
            13)
                printf '%-25s %-25s %-25s\n' "容器名称" "网络名称" "IP地址"
                while IFS= read -r container_id; do
                    [ -n "$container_id" ] || continue
                    container_info="$(docker inspect --format '{{ .Name }}{{ range $network, $config := .NetworkSettings.Networks }} {{ $network }} {{ $config.IPAddress }}{{ end }}' "$container_id" 2>/dev/null || true)"
                    container_name="$(printf '%s\n' "$container_info" | awk '{print $1}' | sed 's#^/##')"
                    network_info="$(printf '%s\n' "$container_info" | cut -d' ' -f2-)"
                    while IFS= read -r line; do
                        network_name="$(printf '%s\n' "$line" | awk '{print $1}')"
                        ip_address="$(printf '%s\n' "$line" | awk '{print $2}')"
                        [ -n "$network_name" ] && printf '%-25s %-25s %-25s\n' "$container_name" "$network_name" "$ip_address"
                    done <<< "$network_info"
                done < <(docker ps -q)
                ;;
            14) docker stats --no-stream ;;
            15|16)
                read -r -e -p "请输入容器名或 ID: " docker_name
                allowed_ip="$(prompt_allowed_ipv4)" || { menu_pause; continue; }
                if [ "$sub_choice" = "15" ]; then
                    clear_container_rules "$docker_name" "$allowed_ip"
                else
                    block_container_port "$docker_name" "$allowed_ip"
                fi
                check_docker_app_ip "$docker_name"
                ;;
            0) return 0 ;;
            *) menu_invalid_choice; continue ;;
        esac
        menu_pause
    done
}

submenu_docker_image() {
    local sub_choice imagenames
    local -a ids
    while true; do
        clear
        echo "Docker 镜像列表"
        docker image ls || true
        echo ""
        printf '%b\n' "${CYAN}镜像操作${PLAIN}"
        echo "------------------------"
        echo "1. 拉取镜像"
        echo "2. 更新镜像"
        echo "3. 删除镜像"
        echo "4. 删除所有镜像"
        echo "------------------------"
        echo "0. 返回上一级"
        echo "------------------------"
        read -r -e -p "请输入你的选择: " sub_choice
        case "$sub_choice" in
            1|2)
                read -r -e -p "请输入镜像名: " imagenames
                [ -n "$imagenames" ] && docker pull "$imagenames" || log_warning "镜像名不能为空"
                ;;
            3)
                read -r -e -p "请输入镜像名或 ID: " imagenames
                if [ -n "$imagenames" ] && confirm_dangerous_action "删除镜像 $imagenames" "将强制删除该镜像"; then
                    docker rmi -f "$imagenames"
                fi
                ;;
            4)
                mapfile -t ids < <(docker images -q | sort -u)
                if [ "${#ids[@]}" -eq 0 ]; then
                    log_info "没有镜像"
                elif confirm_dangerous_action "删除全部镜像" "将强制删除 ${#ids[@]} 个镜像"; then
                    docker rmi -f "${ids[@]}"
                fi
                ;;
            0) return 0 ;;
            *) menu_invalid_choice; continue ;;
        esac
        menu_pause
    done
}

submenu_docker_network() {
    local sub_choice name net con
    while true; do
        clear
        echo "Docker 网络列表"
        docker network ls || true
        echo ""
        printf '%b\n' "${CYAN}网络操作${PLAIN}"
        echo "------------------------"
        echo "1. 创建网络"
        echo "2. 加入网络"
        echo "3. 退出网络"
        echo "4. 删除网络"
        echo "------------------------"
        echo "0. 返回上一级"
        echo "------------------------"
        read -r -e -p "请输入你的选择: " sub_choice
        case "$sub_choice" in
            1)
                read -r -e -p "网络名: " name
                [ -n "$name" ] && docker network create "$name" || log_warning "网络名不能为空"
                ;;
            2|3)
                read -r -e -p "网络名: " net
                read -r -e -p "容器名: " con
                if [ -z "$net" ] || [ -z "$con" ]; then
                    log_warning "网络名和容器名不能为空"
                elif [ "$sub_choice" = "2" ]; then
                    docker network connect "$net" "$con"
                else
                    docker network disconnect "$net" "$con"
                fi
                ;;
            4)
                read -r -e -p "网络名: " net
                if [ -n "$net" ] && confirm_dangerous_action "删除 Docker 网络 $net" "使用中的网络可能删除失败"; then
                    docker network rm "$net"
                fi
                ;;
            0) return 0 ;;
            *) menu_invalid_choice; continue ;;
        esac
        menu_pause
    done
}

submenu_docker_manager() {
    while true; do
      clear
      printf '%b\n' "${CYAN}=================================================${PLAIN}"
      printf '%b\n' "${CYAN}           Docker 管理器 (by kejilion.sh)${PLAIN}"
      printf '%b\n' "${CYAN}=================================================${PLAIN}"
      docker_tato
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      printf '%b\n' "${GREEN}1.${PLAIN}   安装/更新 Docker 环境 ${YELLOW}★${PLAIN}"
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      printf '%b\n' "${GREEN}2.${PLAIN}   查看 Docker 全局状态 ${YELLOW}★${PLAIN}"
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      printf '%b\n' "${GREEN}3.${PLAIN}   Docker 容器管理 ${YELLOW}★${PLAIN}"
      printf '%b\n' "${GREEN}4.${PLAIN}   Docker 镜像管理"
      printf '%b\n' "${GREEN}5.${PLAIN}   Docker 网络管理"
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      printf '%b\n' "${GREEN}8.${PLAIN}   更换 Docker 源 (国内加速)"
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      printf '%b\n' "${GREEN}0.${PLAIN}   返回主菜单"
      printf '%b\n' "${CYAN}------------------------${PLAIN}"
      read -e -p "请输入你的选择: " sub_choice

      case $sub_choice in
          1)
            clear
            action_install_add_docker
            read -r -p "按 Enter 继续..."
            ;;
          2)
              clear
              docker info
              read -r -p "按 Enter 继续..."
              ;;
          3) submenu_docker_container ;;
          4) submenu_docker_image ;;
          5) submenu_docker_network ;;
          8)
              install_add_docker_cn
              read -r -p "按 Enter 继续..."
              ;;
          0) break ;;
          *) echo "无效输入"; sleep 1 ;;
      esac
    done
}

submenu_app_market() {
    while true; do
        clear
        printf '%b\n' "${CYAN}=================================================${PLAIN}"
        printf '%b\n' "${CYAN}           应用市场 (精选)                         ${PLAIN}"
        printf '%b\n' "${CYAN}=================================================${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 1Panel 面板 (现代化管理面板)"
        printf '%b\n' "${GREEN}2.${PLAIN} aaPanel (宝塔国际版)"
        printf '%b\n' "${GREEN}3.${PLAIN} 宝塔面板 (官方版)"
        printf '%b\n' "${CYAN}-------------------------------------------------${PLAIN}"
        printf '%b\n' "${GREEN}4.${PLAIN} Nginx Proxy Manager (反向代理面板)"
        printf '%b\n' "${GREEN}5.${PLAIN} Portainer (Docker 管理面板)"
        printf '%b\n' "${GREEN}6.${PLAIN} Uptime Kuma (监控工具)"
        printf '%b\n' "${CYAN}-------------------------------------------------${PLAIN}"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回主菜单"
        printf '%b\n' "${CYAN}-------------------------------------------------${PLAIN}"
        read -r -p "请输入选择: " app_choice
        
        case "$app_choice" in
            1)
                local url="https://resource.1panel.pro/v2/quick_start.sh"
                run_remote_script "$url" "1Panel 官方安装脚本"
                ;;
            2)
                local url="https://www.aapanel.com/script/install_6.0_en.sh"
                local script_path="/tmp/install_6.0_en.sh"
                if download_remote_script "$url" "$script_path" "aaPanel 安装脚本"; then
                    run_cmd "执行 aaPanel 安装脚本" "bash \"$script_path\" aapanel"
                    run_cmd "清理 aaPanel 脚本" "rm -f \"$script_path\""
                fi
                ;;
            3)
                local url="https://download.bt.cn/install/install_panel.sh"
                local script_path="/tmp/install_panel.sh"
                if download_remote_script "$url" "$script_path" "宝塔面板安装脚本"; then
                    run_cmd "执行宝塔安装脚本" "bash \"$script_path\" ed8484bec"
                    run_cmd "清理宝塔脚本" "rm -f \"$script_path\""
                fi
                ;;
            4)
                if confirm_action "将会使用 Docker 运行 Nginx Proxy Manager (端口 81, 80, 443)，确认?" "y"; then
                    install_docker_if_needed
                    mkdir -p /opt/npm
                    docker run -d \
                      --name=npm \
                      -p 81:81 \
                      -p 80:80 \
                      -p 443:443 \
                      -v /opt/npm/data:/data \
                      -v /opt/npm/letsencrypt:/etc/letsencrypt \
                      --restart=always \
                      jc21/nginx-proxy-manager:latest
                    log_success "NPM 已启动: http://IP:81"
                fi
                ;;
            5)
                if confirm_action "将会使用 Docker 运行 Portainer (端口 9000)，确认?" "y"; then
                    install_docker_if_needed
                    docker run -d -p 9000:9000 --name=portainer --restart=always -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:latest
                    log_success "Portainer 已启动: http://IP:9000"
                fi
                ;;
            6)
                 if confirm_action "将会使用 Docker 运行 Uptime Kuma (端口 3001)，确认?" "y"; then
                    install_docker_if_needed
                    docker run -d --restart=always -p 3001:3001 -v uptime-kuma:/app/data --name uptime-kuma louislam/uptime-kuma:1
                    log_success "Uptime Kuma 已启动: http://IP:3001"
                 fi
                 ;;
            0) break ;;
            *) echo "无效选项" ;;
        esac
        if [ "$app_choice" != "0" ]; then read -r -p "按 Enter 继续..."; fi
    done
}

install_docker_if_needed() {
    if ! command -v docker > /dev/null; then
        log_info "Docker 未安装，正在调起安装程序..."
        action_install_add_docker
    fi
}

# --- CloudDrive2 (CD2) 安装向导 ---
function cd2_get_compose_cmd() {
    if docker compose version > /dev/null 2>&1; then
        echo "docker compose"
        return 0
    fi
    if command -v docker-compose > /dev/null 2>&1; then
        echo "docker-compose"
        return 0
    fi
    return 1
}

function action_cd2_mount_helper() {
    printf '%b\n' ""
    printf '%b\n' "${CYAN}CloudDrive2 挂载共享设置${PLAIN}"
    printf '%b\n' "------------------------"
    printf '%b\n' "${GREEN}1.${PLAIN} Docker 为 systemd 服务 (写入 MountFlags=shared)"
    printf '%b\n' "${GREEN}2.${PLAIN} 临时 make-shared (重启后需重做)"
    printf '%b\n' "${GREEN}0.${PLAIN} 返回"
    printf '%b\n' "------------------------"
    read -r -p "请输入选择 [0-2]: " mount_choice

    case "$mount_choice" in
        1)
            if confirm_action "将写入 Docker systemd override 并重启 Docker，确认?" "y"; then
                run_cmd "创建 Docker systemd override 目录" "mkdir -p /etc/systemd/system/docker.service.d"
                if [ "$DRY_RUN" = "1" ]; then
                    log_info "[DRY RUN] 将写入 /etc/systemd/system/docker.service.d/clear_mount_propagation_flags.conf"
                else
                    write_file_atomic /etc/systemd/system/docker.service.d/clear_mount_propagation_flags.conf \
                        "Docker systemd override" 644 0 0 <<'EOF' || return 1
[Service]
MountFlags=shared
EOF
                fi
                run_cmd "重新加载 systemd" "systemctl daemon-reload"
                run_cmd "重启 Docker 服务" "systemctl restart docker.service"
                log_success "已设置 MountFlags=shared"
            fi
            ;;
        2)
            read -e -p "请输入需要共享挂载的路径 (例如云盘挂载父路径): " target_path
            if [ -z "$target_path" ]; then
                log_warning "路径不能为空"
                return 1
            fi
            local mount_point
            mount_point=$(df -P "$target_path" 2>/dev/null | tail -1 | awk '{ print $6 }')
            if [ -z "$mount_point" ]; then
                log_error "无法解析挂载点，请检查路径: $target_path"
                return 1
            fi
            run_command "设置共享挂载" mount --make-shared "$mount_point"
            log_warning "提示: make-shared 仅当前运行周期生效，重启后需要重新设置"
            ;;
        0) return ;;
        *) echo "无效输入"; return ;;
    esac
}

function action_setup_cd2_docker_compose() {
    log_info "准备使用 Docker Compose 部署 CloudDrive2..."
    install_docker_if_needed
    install_docker_compose
    if [ ! -e /dev/fuse ]; then
        log_warning "未检测到 /dev/fuse，CloudDrive2 可能无法正常挂载"
    fi

    local base_dir="/opt/docker/clouddrive2"
    local input=""
    read -e -p "部署目录 (默认: $base_dir): " input
    if [ -n "$input" ]; then base_dir="$input"; fi

    local compose_file="${base_dir}/docker-compose.yml"
    if [ -f "$compose_file" ]; then
        log_info "检测到已存在的 Compose 文件: $compose_file"
        log_info "将跳过生成示例文件"
    else
        local cloud_dir="${base_dir}/cloud"
        local config_dir="${base_dir}/config"
        local media_dir="${base_dir}/media"

        read -e -p "云盘挂载目录 (默认: $cloud_dir): " input
        if [ -n "$input" ]; then cloud_dir="$input"; fi

        read -e -p "配置目录 (默认: $config_dir): " input
        if [ -n "$input" ]; then config_dir="$input"; fi

        local use_media=""
        read -r -p "是否映射额外媒体目录? [y/N]: " use_media
        if [[ "$use_media" =~ ^[yY] ]]; then
            read -e -p "媒体目录 (默认: $media_dir): " input
            if [ -n "$input" ]; then media_dir="$input"; fi
        else
            media_dir=""
        fi

        local tz_default="Asia/Shanghai"
        local tz=""
        read -e -p "时区 TZ (默认: $tz_default): " tz
        if [ -z "$tz" ]; then tz="$tz_default"; fi

        run_command "创建部署目录" mkdir -p "$base_dir"
        run_command "创建 CloudDrive2 目录" mkdir -p "$cloud_dir" "$config_dir"
        if [ -n "$media_dir" ]; then
            run_command "创建媒体目录" mkdir -p "$media_dir"
        fi

        if [ "$DRY_RUN" = "1" ]; then
            log_info "[DRY RUN] 将写入 $compose_file"
        else
            cat > "$compose_file" <<EOF
version: "2.1"
services:
  clouddrive2:
    image: cloudnas/clouddrive2
    container_name: clouddrive2
    environment:
      - TZ=${tz}
      - CLOUDDRIVE_HOME=/Config
    volumes:
      - ${cloud_dir}:/CloudNAS:shared
      - ${config_dir}:/Config
EOF
            if [ -n "$media_dir" ]; then
                cat >> "$compose_file" <<EOF
      - ${media_dir}:/media:shared
EOF
            fi
            cat >> "$compose_file" <<'EOF'
    devices:
      - /dev/fuse:/dev/fuse
    restart: unless-stopped
    pid: "host"
    privileged: true
    network_mode: "host"
EOF
        fi

        log_success "Docker Compose 示例配置已生成: $compose_file"
        log_info "部署目录: $base_dir"
        log_info "配置目录: $config_dir"
        log_info "云盘挂载目录: $cloud_dir"
        if [ -n "$media_dir" ]; then
            log_info "媒体目录: $media_dir"
        fi
    fi

    log_info "提示: Docker Compose 模式需要共享挂载设置 (MountFlags 或 make-shared)"

    if confirm_action "是否现在配置挂载共享 (MountFlags/make-shared)?" "y"; then
        action_cd2_mount_helper
    fi

    local compose_cmd=""
    if compose_cmd=$(cd2_get_compose_cmd); then
        if confirm_action "是否立即启动 CloudDrive2 (docker compose up -d)?" "y"; then
            run_cmd "启动 CloudDrive2" "$compose_cmd -f \"$compose_file\" up -d"
            log_success "CloudDrive2 已启动"
        fi
    else
        log_warning "未检测到 Docker Compose，请先安装后再启动"
    fi
}

function action_setup_cd2_native() {
    local script_path="${SCRIPT_DIR}/install_cd2.sh"
    if [ ! -f "$script_path" ]; then
        log_error "未找到安装脚本: $script_path"
        return 1
    fi

    local base_dir="/opt"
    local input=""
    read -e -p "安装目录 (默认: ${base_dir}，将创建 clouddrive2 目录): " input
    if [ -n "$input" ]; then base_dir="$input"; fi

    log_info "将执行原生安装脚本: $script_path"
    printf '%b\n' "${YELLOW}说明: 该脚本会更新 apt 并从 GitHub 下载 CloudDrive2${PLAIN}"

    if confirm_action "继续执行原生安装脚本?" "n"; then
        run_command "创建安装目录" mkdir -p "$base_dir"
        run_cmd "执行 CloudDrive2 原生安装脚本" "cd \"$base_dir\" && bash \"$script_path\""
        log_success "原生安装脚本执行完成"
        log_info "可使用: tmux attach -t clouddrive2 查看运行状态"
    else
        log_warning "已取消原生安装"
    fi
}

function action_setup_cd2() {
    while true; do
        clear
        printf '%b\n' "${CYAN}=================================================${PLAIN}"
        printf '%b\n' "${CYAN}           CloudDrive2 (CD2) 安装向导            ${PLAIN}"
        printf '%b\n' "${CYAN}=================================================${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} Docker Compose 安装 (推荐)"
        printf '%b\n' "${GREEN}2.${PLAIN} 原生安装 (install_cd2.sh)"
        printf '%b\n' "${GREEN}3.${PLAIN} 挂载共享设置 (MountFlags/make-shared)"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回主菜单"
        printf '%b\n' "${CYAN}-------------------------------------------------${PLAIN}"
        read -r -p "请输入选择: " cd2_choice

        case "$cd2_choice" in
            1) action_setup_cd2_docker_compose ;;
            2) action_setup_cd2_native ;;
            3) action_cd2_mount_helper ;;
            0) break ;;
            *) echo "无效选项"; sleep 1 ;;
        esac
        if [ "$cd2_choice" != "0" ]; then read -r -p "按 Enter 继续..."; fi
    done
}

action_show_system_info() {
    log_info "系统信息:"
    uname -a || true
    printf '%s\n' '--------------------------------'
    if [ -f /etc/os-release ]; then
        grep '^PRETTY_NAME=' /etc/os-release || true
    fi
    printf '%s\n' '--------------------------------'
    free -h || true
    printf '%s\n' '--------------------------------'
    df -h / || true
}

action_enable_bbr() {
    local current=""
    current="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)"
    if [ "$current" = "bbr" ]; then
        log_info "BBR 已启用"
        return 0
    fi
    if [ "$DRY_RUN" != "1" ] && ! modprobe tcp_bbr 2>/dev/null; then
        log_error "当前内核未提供 tcp_bbr 模块"
        return 1
    fi
    write_file_atomic /etc/sysctl.d/99-init-bbr.conf "BBR 拥塞控制" 644 0 0 \
        validate_nonempty_text_candidate <<'EOF' || return 1
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
    run_command "应用 BBR sysctl 配置" sysctl --system || return 1
    if [ "$DRY_RUN" != "1" ]; then
        current="$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || true)"
        [ "$current" = "bbr" ] || { log_error "BBR 配置未生效"; return 1; }
    fi
    log_success "BBR 已启用"
}

function action_toolbox() {
    local tool_choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              系统工具箱                      #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' ""
        printf '%b\n' "${GREEN}[1]${PLAIN} DD 系统重装 (危险)"
        printf '%b\n' "${GREEN}[2]${PLAIN} 1Panel 面板 (快捷)"
        printf '%b\n' "${GREEN}[3]${PLAIN} 配置炫酷 MOTD (登录欢迎信息)"
        printf '%b\n' "${GREEN}[4]${PLAIN} 清理系统 (移除无用包/缓存)"
        printf '%b\n' "${GREEN}[5]${PLAIN} 查看系统信息"
        printf '%b\n' "${GREEN}[6]${PLAIN} 开启 BBR (如果未开启)"
        printf '%b\n' "${GREEN}[7]${PLAIN} 清理痕迹/历史记录 (危险)"
        printf '%b\n' "${GREEN}[8]${PLAIN} 服务健康检查 (SSH/UFW/Fail2ban/Docker)"
        printf '%b\n' "${GREEN}[9]${PLAIN} 性能优化预设 (sysctl)"
        printf '%b\n' "${GREEN}[10]${PLAIN} 磁盘工具 (挂载/SMART/Trim)"
        printf '%b\n' "${GREEN}[11]${PLAIN} 用户管理 (新建用户/SSH/Sudo/禁用Root)"
        printf '%b\n' "${GREEN}[12]${PLAIN} 备份/恢复 (restic/borg)"
        printf '%b\n' "${GREEN}[13]${PLAIN} 监控/告警基础"
        printf '%b\n' "${GREEN}[14]${PLAIN} 证书/反向代理"
        printf '%b\n' "${GREEN}[15]${PLAIN} 安全审计"
        printf '%b\n' "${GREEN}[16]${PLAIN} Docker Compose 项目备份"
        printf '%b\n' "${GREEN}[17]${PLAIN} 模块状态总览"
        printf '%b\n' "${GREEN}[18]${PLAIN} 脚本自检/ShellCheck"
        printf '%b\n' "${GREEN}[19]${PLAIN} 运维增强中心 (Profile/报告/安全基线)"
        printf '%b\n' "${GREEN}[0]${PLAIN} 返回主菜单"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-19]: " tool_choice

        case "$tool_choice" in
            1) run_menu_action action_dd_reinstall ;;
            2) run_menu_action action_install_1panel ;;
            3) run_menu_action action_configure_motd ;;
            4) run_menu_action cleanup ;;
            5) run_menu_action action_show_system_info ;;
            6) run_menu_action action_enable_bbr ;;
            7) run_menu_action action_clean_traces ;;
            8) run_menu_action action_service_health ;;
            9) run_menu_action action_sysctl_presets ;;
            10) run_menu_action action_disk_tools ;;
            11) run_menu_action action_user_manager ;;
            12) run_menu_flow action_backup_restore ;;
            13) run_menu_flow action_monitoring_alerts ;;
            14) run_menu_flow action_reverse_proxy_cert ;;
            15) run_menu_flow action_security_audit ;;
            16) run_menu_flow action_docker_compose_backup ;;
            17) run_menu_flow action_module_status_overview ;;
            18) run_menu_flow action_script_quality ;;
            19) run_menu_flow action_ops_enhancements ;;
            0) return 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 服务健康检查 ---
function action_service_health() {
    log_info "服务健康检查..."
    local services=("ssh" "sshd" "ufw" "fail2ban" "docker")
    printf "%-12s %-10s %-10s\n" "服务" "状态" "开机启动"
    for svc in "${services[@]}"; do
        local active="inactive"
        local enabled="disabled"
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            active="active"
        fi
        if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
            enabled="enabled"
        fi
        printf "%-12s %-10s %-10s\n" "$svc" "$active" "$enabled"
    done
    printf '%b\n' ""
    if command -v ufw > /dev/null 2>&1; then
        ufw status numbered || true
    fi
    printf '%b\n' ""
    if command -v ss > /dev/null 2>&1; then
        log_info "监听端口:"
        ss -tulpn | head -n 30 || true
    fi
}

# --- 模块: sysctl 性能预设 ---
function action_sysctl_presets() {
    log_info "sysctl 性能预设..."
    printf '%b\n' "${GREEN}[1]${PLAIN} 保守 (conservative)"
    printf '%b\n' "${GREEN}[2]${PLAIN} 标准 (standard)"
    printf '%b\n' "${GREEN}[3]${PLAIN} 激进 (aggressive)"
    read -r -p "请选择 [1-3]: " preset_choice
    local preset_file="/etc/sysctl.d/99-init-presets.conf"
    local content=""

    case "$preset_choice" in
        1)
            content="net.core.somaxconn = 4096
net.ipv4.tcp_fin_timeout = 60
net.ipv4.tcp_keepalive_time = 1200
vm.swappiness = 10"
            ;;
        2)
            content="net.core.somaxconn = 65535
net.core.netdev_max_backlog = 262144
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_tw_reuse = 1
vm.swappiness = 10"
            ;;
        3)
            content="net.core.somaxconn = 65535
net.core.netdev_max_backlog = 262144
net.ipv4.tcp_max_syn_backlog = 262144
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
vm.swappiness = 10"
            ;;
        *)
            log_warning "无效选择"
            return 1
            ;;
    esac

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 $preset_file 并执行 sysctl --system"
        return 0
    fi
    create_backup "$preset_file" >/dev/null
    mkdir -p /etc/sysctl.d
    printf "%s\n" "$content" > "$preset_file"
    sysctl --system > /dev/null 2>&1 || log_warning "sysctl 应用失败"
    log_success "sysctl 预设已应用: $preset_file"
}

# --- 模块: 磁盘工具 ---
function action_disk_tools() {
    log_info "磁盘详细报告..."
    printf '%b\n' "------------------------------------------------"
    printf '%b\n' "磁盘概览 (按容量排序):"
    lsblk -dn -o NAME,SIZE,TYPE,MODEL,ROTA | awk '$3=="disk"{print $0}' | sort -k2 -h || true
    printf '%b\n' ""

    printf '%b\n' "文件系统与挂载:"
    lsblk -f || true
    printf '%b\n' ""
    df -h || true
    printf '%b\n' ""

    if confirm_action "是否收集 IO 统计? (需要 sysstat)" "y"; then
        if ! command -v iostat > /dev/null 2>&1; then
            log_info "安装 sysstat..."
            update_apt_once
            install_packages_batch "sysstat"
        fi
        if [ "$DRY_RUN" = "1" ]; then
            log_info "[DRY RUN] 将执行 iostat -dx 1 3"
        else
            iostat -dx 1 3 || true
        fi
        printf '%b\n' ""
    fi

    if confirm_action "是否收集 SMART/NVMe 统计? (smartctl/nvme-cli)" "y"; then
        if ! command -v smartctl > /dev/null 2>&1; then
            log_info "安装 smartmontools..."
            update_apt_once
            install_packages_batch "smartmontools"
        fi
        if ! command -v nvme > /dev/null 2>&1; then
            log_info "安装 nvme-cli..."
            update_apt_once
            install_packages_batch "nvme-cli"
        fi

        for disk in $(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}'); do
            local dev="/dev/${disk}"
            printf '%b\n' ""
            printf '%b\n' "==== ${dev} ===="

            if echo "$disk" | grep -q "^nvme"; then
                if command -v nvme > /dev/null 2>&1; then
                    if [ "$DRY_RUN" = "1" ]; then
                        log_info "[DRY RUN] nvme smart-log $dev"
                    else
                        nvme smart-log "$dev" || true
                    fi
                fi
            fi

            if command -v smartctl > /dev/null 2>&1; then
                if [ "$DRY_RUN" = "1" ]; then
                    log_info "[DRY RUN] smartctl -a $dev"
                else
                    smartctl -a "$dev" || true
                fi
            fi
        done
    fi

    if command -v fstrim > /dev/null 2>&1; then
        if confirm_action "是否执行 fstrim (SSD Trim)?" "n"; then
            if [ "$DRY_RUN" = "1" ]; then
                log_info "[DRY RUN] 将执行 fstrim -av"
            else
                fstrim -av || log_warning "fstrim 执行失败"
            fi
        fi
    fi
}

# --- 模块: 备份/恢复 (restic/borg) ---
install_backup_tools() {
    log_info "安装备份工具 (restic/borgbackup)..."
    update_apt_once
    install_packages_batch "restic" "borgbackup" "openssl"
}

configure_restic_local_backup() {
    install_backup_tools || return 1

    local config_dir="/root/.config/init-script"
    local env_file="${config_dir}/restic.env"
    local password_file="${config_dir}/restic.password"
    local files_from="/etc/init-restic-paths.txt"
    local exclude_file="/etc/init-restic-excludes.txt"
    local backup_script="/usr/local/sbin/init-restic-backup"
    local repo default_paths
    local backend backend_choice
    local aws_access_key="" aws_secret_key="" b2_account_id="" b2_account_key=""

    printf '%b\n' "${YELLOW}请选择 restic 仓库后端:${PLAIN}"
    printf '%b\n' "${GREEN}1.${PLAIN} 本地目录"
    printf '%b\n' "${GREEN}2.${PLAIN} SFTP (user@host:/path)"
    printf '%b\n' "${GREEN}3.${PLAIN} S3 兼容存储"
    printf '%b\n' "${GREEN}4.${PLAIN} Backblaze B2"
    printf '%b\n' "${GREEN}5.${PLAIN} 自定义 restic repository 字符串"
    read -r -p "请选择 [1-5，默认 1]: " backend_choice
    backend_choice="${backend_choice:-1}"

    case "$backend_choice" in
        1)
            backend="local"
            read -r -p "Restic 仓库路径 [默认 /backup/restic]: " repo
            repo="${repo:-/backup/restic}"
            ;;
        2)
            backend="sftp"
            read -r -p "SFTP 仓库 (例如 user@example.com:/srv/restic): " repo
            repo="sftp:${repo}"
            ;;
        3)
            backend="s3"
            local s3_endpoint s3_bucket s3_path
            read -r -p "S3 endpoint (例如 s3.amazonaws.com 或 minio.example.com): " s3_endpoint
            read -r -p "S3 bucket: " s3_bucket
            read -r -p "S3 路径 [默认 init-backup]: " s3_path
            s3_path="${s3_path:-init-backup}"
            read -r -p "AWS_ACCESS_KEY_ID: " aws_access_key
            read -r -s -p "AWS_SECRET_ACCESS_KEY: " aws_secret_key
            echo
            repo="s3:${s3_endpoint}/${s3_bucket}/${s3_path}"
            ;;
        4)
            backend="b2"
            local b2_bucket b2_path
            read -r -p "B2 bucket: " b2_bucket
            read -r -p "B2 路径 [默认 init-backup]: " b2_path
            b2_path="${b2_path:-init-backup}"
            read -r -p "B2_ACCOUNT_ID: " b2_account_id
            read -r -s -p "B2_ACCOUNT_KEY: " b2_account_key
            echo
            repo="b2:${b2_bucket}:${b2_path}"
            ;;
        5)
            backend="custom"
            read -r -p "Restic repository 字符串: " repo
            ;;
        *)
            log_warning "无效选择"
            return 1
            ;;
    esac

    if [ -z "$repo" ] || [[ "$repo" == "sftp:" ]]; then
        log_warning "Restic 仓库不能为空"
        return 1
    fi

    read -r -p "备份路径（空格分隔，默认 /etc /root /home）: " default_paths
    default_paths="${default_paths:-/etc /root /home}"

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将配置 restic 仓库 ($backend): $repo"
        return 0
    fi

    mkdir -p "$config_dir"
    if [ "$backend" = "local" ]; then
        mkdir -p "$repo"
    fi
    chmod 700 "$config_dir"

    if [ ! -f "$password_file" ]; then
        local password=""
        read -r -s -p "Restic 密码（留空自动生成）: " password
        echo
        if [ -z "$password" ]; then
            password="$(openssl rand -base64 32 2>/dev/null || date +%s%N)"
            log_warning "已自动生成 restic 密码，保存在 $password_file"
        fi
        printf "%s\n" "$password" > "$password_file"
        chmod 600 "$password_file"
    fi

    : > "$files_from"
    local path
    for path in $default_paths; do
        printf "%s\n" "$path" >> "$files_from"
    done

    cat > "$exclude_file" <<'EOF'
/proc
/sys
/dev
/run
/tmp
/var/tmp
/var/cache
/var/lib/docker/overlay2
*/node_modules
*/.cache
EOF

    {
        write_shell_var RESTIC_REPOSITORY "$repo"
        write_shell_var RESTIC_PASSWORD_FILE "$password_file"
        write_shell_var RESTIC_FILES_FROM "$files_from"
        write_shell_var RESTIC_EXCLUDE_FILE "$exclude_file"
        write_shell_var INIT_RESTIC_BACKEND "$backend"
        [ -n "$aws_access_key" ] && write_shell_var AWS_ACCESS_KEY_ID "$aws_access_key"
        [ -n "$aws_secret_key" ] && write_shell_var AWS_SECRET_ACCESS_KEY "$aws_secret_key"
        [ -n "$b2_account_id" ] && write_shell_var B2_ACCOUNT_ID "$b2_account_id"
        [ -n "$b2_account_key" ] && write_shell_var B2_ACCOUNT_KEY "$b2_account_key"
    } > "$env_file"
    chmod 600 "$env_file"
    # shellcheck disable=SC1090
    source "$env_file"

    local need_init=true
    if restic -r "$repo" snapshots > /dev/null 2>&1; then
        need_init=false
        log_info "检测到现有 restic 仓库，跳过初始化"
    elif [ "$backend" = "local" ] && [ -f "$repo/config" ]; then
        log_error "本地 restic 仓库已存在但无法读取，请检查密码或仓库状态: $repo"
        return 1
    fi
    if [ "$need_init" = true ]; then
        if ! restic -r "$repo" init >> "$LOG_FILE" 2>&1; then
            log_error "Restic 仓库初始化失败"
            return 1
        fi
    fi

    write_file_atomic "$backup_script" "Restic backup executable" 700 0 0 <<'EOF' || return 1
#!/bin/bash
set -euo pipefail

ENV_FILE="/root/.config/init-script/restic.env"
LOG_FILE="/var/log/init-restic-backup.log"

if [ ! -f "$ENV_FILE" ]; then
    echo "restic env file not found: $ENV_FILE" >&2
    exit 1
fi

set -a
source "$ENV_FILE"
set +a

{
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') restic backup start ====="
    restic backup --files-from "$RESTIC_FILES_FROM" --exclude-file "$RESTIC_EXCLUDE_FILE"
    restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
    restic check --read-data-subset=1/20
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') restic backup done ====="
} >> "$LOG_FILE" 2>&1
EOF
    write_file_atomic /etc/systemd/system/init-restic-backup.service \
        "Restic backup service" 644 0 0 validate_systemd_candidate <<'EOF' || return 1
[Unit]
Description=Init Script Restic Backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/init-restic-backup
EOF

    write_file_atomic /etc/systemd/system/init-restic-backup.timer \
        "Restic backup timer" 644 0 0 validate_systemd_candidate <<'EOF' || return 1
[Unit]
Description=Run Init Script Restic Backup Daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
EOF

    systemd_daemon_reload || return 1
    if ! systemctl enable --now init-restic-backup.timer; then
        log_error "Restic 备份定时器启用失败"
        return 1
    fi
    log_success "Restic 备份已配置 ($backend)，每天 03:30 附近执行"
    log_info "手动备份: systemctl start init-restic-backup.service"
    log_info "查看日志: tail -n 100 /var/log/init-restic-backup.log"
}

run_restic_backup_now() {
    if [ ! -x /usr/local/sbin/init-restic-backup ]; then
        log_warning "尚未配置 restic 备份，请先配置本地 restic 备份"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将执行 /usr/local/sbin/init-restic-backup"
        return 0
    fi
    if ! /usr/local/sbin/init-restic-backup; then
        log_error "备份执行失败，请查看 /var/log/init-restic-backup.log"
        return 1
    fi
    log_success "备份执行完成"
}

list_restic_snapshots() {
    local env_file="/root/.config/init-script/restic.env"
    if [ ! -f "$env_file" ]; then
        log_warning "尚未配置 restic 备份"
        return 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    restic snapshots
}

preview_restic_snapshot() {
    local env_file="/root/.config/init-script/restic.env"
    local snapshot
    if [ ! -f "$env_file" ]; then
        log_warning "尚未配置 restic 备份"
        return 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    restic snapshots || true
    read -r -p "要预览的 snapshot ID [默认 latest]: " snapshot
    snapshot="${snapshot:-latest}"
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] restic stats $snapshot && restic ls $snapshot"
        return 0
    fi
    log_info "快照统计:"
    restic stats "$snapshot" || true
    printf '%b\n' ""
    log_info "快照文件预览 (前 200 行):"
    restic ls "$snapshot" | sed -n '1,200p' || true
}

restore_restic_snapshot() {
    local env_file="/root/.config/init-script/restic.env"
    local snapshot target
    if [ ! -f "$env_file" ]; then
        log_warning "尚未配置 restic 备份"
        return 1
    fi
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    restic snapshots || true
    read -r -p "要恢复的 snapshot ID [默认 latest]: " snapshot
    snapshot="${snapshot:-latest}"
    if confirm_action "是否先预览该快照内容?" "y"; then
        log_info "快照统计:"
        restic stats "$snapshot" || true
        printf '%b\n' ""
        log_info "快照文件预览 (前 200 行):"
        restic ls "$snapshot" | sed -n '1,200p' || true
        printf '%b\n' ""
    fi
    read -r -p "恢复目标目录 [默认 /restore/restic]: " target
    target="${target:-/restore/restic}"
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] restic restore $snapshot --target $target"
        return 0
    fi
    mkdir -p "$target"
    if ! restic restore "$snapshot" --target "$target"; then
        log_error "恢复失败"
        return 1
    fi
    log_success "恢复完成: $target"
}

run_restic_restore_drill() {
    local env_file="/root/.config/init-script/restic.env"
    local snapshot drill_dir drill_paths path
    local include_args=()

    if [ ! -f "$env_file" ]; then
        log_warning "尚未配置 restic 备份"
        return 1
    fi

    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a

    restic snapshots || true
    read -r -p "演练 snapshot ID [默认 latest]: " snapshot
    snapshot="${snapshot:-latest}"
    read -r -p "演练检查路径（空格分隔，默认 /etc/hostname /etc/ssh/sshd_config）: " drill_paths
    drill_paths="${drill_paths:-/etc/hostname /etc/ssh/sshd_config}"
    read -r -p "演练恢复目录 [默认 /var/tmp/init-restic-drill]: " drill_dir
    drill_dir="${drill_dir:-/var/tmp/init-restic-drill}"

    log_info "检查快照内关键路径..."
    for path in $drill_paths; do
        restic ls "$snapshot" "$path" > /dev/null 2>&1 && \
            printf "%-40s ${GREEN}%s${PLAIN}\n" "$path" "present" || \
            printf "%-40s ${YELLOW}%s${PLAIN}\n" "$path" "missing"
        include_args+=(--include "$path")
    done

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将恢复快照 $snapshot 的关键路径到 $drill_dir"
        return 0
    fi

    mkdir -p "$drill_dir"
    if ! restic restore "$snapshot" --target "$drill_dir" "${include_args[@]}"; then
        log_error "恢复演练失败"
        return 1
    fi

    log_success "恢复演练完成: $drill_dir"
    log_info "建议检查恢复目录后手动清理: rm -rf \"$drill_dir\""
}

function action_backup_restore() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              备份 / 恢复                     #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 安装备份工具 (restic/borgbackup)"
        printf '%b\n' "${GREEN}2.${PLAIN} 配置本地 restic 定时备份"
        printf '%b\n' "${GREEN}3.${PLAIN} 立即执行 restic 备份"
        printf '%b\n' "${GREEN}4.${PLAIN} 查看 restic 快照"
        printf '%b\n' "${GREEN}5.${PLAIN} 预览 restic 快照"
        printf '%b\n' "${GREEN}6.${PLAIN} 恢复 restic 快照"
        printf '%b\n' "${GREEN}7.${PLAIN} restic 恢复演练"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-7]: " choice
        case "$choice" in
            1) run_menu_action install_backup_tools ;;
            2) run_menu_action configure_restic_local_backup ;;
            3) run_menu_action run_restic_backup_now ;;
            4) run_menu_action list_restic_snapshots ;;
            5) run_menu_action preview_restic_snapshot ;;
            6) run_menu_action restore_restic_snapshot ;;
            7) run_menu_action run_restic_restore_drill ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 监控/告警基础 ---
configure_journald_persistent() {
    log_info "配置 journald 持久化与日志容量限制..."
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 /etc/systemd/journald.conf.d/99-init.conf"
        return 0
    fi
    mkdir -p /etc/systemd/journald.conf.d /var/log/journal
    write_file_atomic /etc/systemd/journald.conf.d/99-init.conf \
        "journald 持久化配置" 644 0 0 <<'EOF' || return 1
[Journal]
Storage=persistent
Compress=yes
SystemMaxUse=1G
RuntimeMaxUse=256M
MaxRetentionSec=1month
EOF
    systemctl restart systemd-journald || log_warning "systemd-journald 重启失败"
    log_success "journald 已配置为持久化"
}

install_node_exporter() {
    log_info "安装 prometheus-node-exporter..."
    update_apt_once
    if ! install_packages_batch "prometheus-node-exporter"; then
        log_error "prometheus-node-exporter 安装失败"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将启用 prometheus-node-exporter"
        return 0
    fi
    systemctl enable --now prometheus-node-exporter
    log_success "node_exporter 已启动，默认监听 9100"
    if command -v ufw > /dev/null 2>&1 && confirm_action "是否通过 UFW 放行 9100 端口? (建议只对监控端 IP 放行)" "n"; then
        local cidr
        read -r -p "允许来源 CIDR [默认 any]: " cidr
        if [ -n "$cidr" ]; then
            ufw allow from "$cidr" to any port 9100 proto tcp
        else
            ufw allow 9100/tcp
        fi
    fi
}

install_health_check_timer() {
    local script_path="/usr/local/sbin/init-health-check"
    log_info "安装本机健康检查定时器..."
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将创建健康检查脚本和 systemd timer"
        return 0
    fi

    write_file_atomic "$script_path" "本机健康检查 executable" 700 0 0 <<'EOF' || return 1
#!/bin/bash
set -euo pipefail

LOG_FILE="/var/log/init-health-check.log"
WARNINGS=0

log_warn() {
    WARNINGS=$((WARNINGS + 1))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN $*" | tee -a "$LOG_FILE"
    logger -t init-health-check "WARN $*"
}

disk_pct=$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ "${disk_pct:-0}" -ge 85 ]; then
    log_warn "root disk usage is ${disk_pct}%"
fi

mem_avail=$(free -m | awk '/^Mem:/ {print $7}')
if [ "${mem_avail:-0}" -le 128 ]; then
    log_warn "available memory is ${mem_avail}MB"
fi

load_1=$(awk '{print $1}' /proc/loadavg)
cores=$(nproc 2>/dev/null || echo 1)
awk -v load="$load_1" -v cores="$cores" 'BEGIN { exit !(load > cores * 2) }' && \
    log_warn "1-minute load ${load_1} is higher than 2x CPU cores (${cores})"

failed_units=$(systemctl --failed --no-legend 2>/dev/null | wc -l | tr -d ' ')
if [ "${failed_units:-0}" -gt 0 ]; then
    log_warn "systemd has ${failed_units} failed unit(s)"
fi

if [ "$WARNINGS" -eq 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] OK health check passed" >> "$LOG_FILE"
fi
EOF
    write_file_atomic /etc/systemd/system/init-health-check.service \
        "本机健康检查 service" 644 0 0 validate_systemd_candidate <<'EOF' || return 1
[Unit]
Description=Init Script Local Health Check

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/init-health-check
EOF

    write_file_atomic /etc/systemd/system/init-health-check.timer \
        "本机健康检查 timer" 644 0 0 validate_systemd_candidate <<'EOF' || return 1
[Unit]
Description=Run Init Script Local Health Check Hourly

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF
    systemd_daemon_reload || return 1
    if ! systemctl enable --now init-health-check.timer; then
        log_error "健康检查定时器启用失败"
        return 1
    fi
    log_success "健康检查定时器已启用"
    log_info "查看日志: tail -n 100 /var/log/init-health-check.log"
}

show_monitoring_status() {
    log_info "监控/日志状态..."
    systemctl is-active systemd-journald >/dev/null 2>&1 && echo "journald: active" || echo "journald: inactive"
    systemctl is-active prometheus-node-exporter >/dev/null 2>&1 && echo "node_exporter: active" || echo "node_exporter: inactive"
    systemctl list-timers init-health-check.timer --no-pager 2>/dev/null || true
    if [ -f /var/log/init-health-check.log ]; then
        printf '%b\n' ""
        tail -n 20 /var/log/init-health-check.log
    fi
}

function action_monitoring_alerts() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              监控 / 告警基础                 #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 配置 journald 持久化"
        printf '%b\n' "${GREEN}2.${PLAIN} 安装 node_exporter"
        printf '%b\n' "${GREEN}3.${PLAIN} 安装本机健康检查定时器"
        printf '%b\n' "${GREEN}4.${PLAIN} 查看监控状态"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-4]: " choice
        case "$choice" in
            1) run_menu_action configure_journald_persistent ;;
            2) run_menu_action install_node_exporter ;;
            3) run_menu_action install_health_check_timer ;;
            4) run_menu_action show_monitoring_status ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 证书/反向代理 ---
configure_caddy_reverse_proxy() {
    local domain upstream site_file
    update_apt_once
    if ! install_packages_batch "caddy"; then
        log_error "Caddy 安装失败，当前系统源可能未提供 caddy，可改用 Nginx + Certbot"
        return 1
    fi
    read -r -p "域名 (例如 app.example.com): " domain
    read -r -p "后端地址 [默认 127.0.0.1:3000]: " upstream
    upstream="${upstream:-127.0.0.1:3000}"
    if [ -z "$domain" ]; then
        log_warning "域名不能为空"
        return 1
    fi
    site_file="/etc/caddy/conf.d/${domain}.caddy"

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 Caddy 反代配置: $site_file"
        return 0
    fi
    mkdir -p /etc/caddy/conf.d
    [ -f /etc/caddy/Caddyfile ] || touch /etc/caddy/Caddyfile
    if [ -f /etc/caddy/Caddyfile ] && ! grep -q "conf.d/\\*.caddy" /etc/caddy/Caddyfile; then
        printf "\nimport /etc/caddy/conf.d/*.caddy\n" >> /etc/caddy/Caddyfile
    fi
    write_file_atomic "$site_file" "Caddy 反向代理站点" 644 0 0 <<EOF || return 1
$domain {
    encode gzip zstd
    reverse_proxy $upstream
}
EOF
    if ! caddy validate --config /etc/caddy/Caddyfile; then
        log_error "Caddy 配置验证失败"
        return 1
    fi
    if ! systemctl enable --now caddy; then
        log_error "Caddy 服务启动失败"
        return 1
    fi
    if ! systemctl reload caddy; then
        systemctl restart caddy || return 1
    fi
    log_success "Caddy 反向代理已配置: https://$domain -> $upstream"
}

configure_nginx_certbot_proxy() {
    local domain upstream site_file
    update_apt_once
    if ! install_packages_batch "nginx" "certbot" "python3-certbot-nginx"; then
        log_error "Nginx/Certbot 安装失败"
        return 1
    fi
    read -r -p "域名 (例如 app.example.com): " domain
    read -r -p "后端地址 [默认 http://127.0.0.1:3000]: " upstream
    upstream="${upstream:-http://127.0.0.1:3000}"
    if [ -z "$domain" ]; then
        log_warning "域名不能为空"
        return 1
    fi
    site_file="/etc/nginx/sites-available/${domain}.conf"
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 Nginx 反代配置并可选申请证书: $site_file"
        return 0
    fi
    write_file_atomic "$site_file" "Nginx 反向代理站点" 644 0 0 <<EOF || return 1
server {
    listen 80;
    listen [::]:80;
    server_name $domain;

    location / {
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass $upstream;
    }
}
EOF
    ln -sf "$site_file" "/etc/nginx/sites-enabled/${domain}.conf"
    if ! nginx -t; then
        log_error "Nginx 配置验证失败"
        return 1
    fi
    if ! systemctl enable --now nginx; then
        log_error "Nginx 服务启动失败"
        return 1
    fi
    systemctl reload nginx || systemctl restart nginx
    if confirm_action "是否使用 certbot 申请/配置 HTTPS 证书?" "y"; then
        certbot --nginx -d "$domain" || return 1
    fi
    log_success "Nginx 反向代理已配置: $domain -> $upstream"
}

function action_reverse_proxy_cert() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              证书 / 反向代理                 #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} Caddy 自动 HTTPS 反代 (推荐)"
        printf '%b\n' "${GREEN}2.${PLAIN} Nginx + Certbot 反代"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-2]: " choice
        case "$choice" in
            1) run_menu_action configure_caddy_reverse_proxy ;;
            2) run_menu_action configure_nginx_certbot_proxy ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 安全审计 ---
install_security_audit_tools() {
    update_apt_once
    install_packages_batch "lynis" "debsums"
}

run_lynis_quick_audit() {
    update_apt_once
    if ! install_packages_batch "lynis"; then
        log_error "Lynis 安装失败"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将执行 lynis audit system --quick"
        return 0
    fi
    lynis audit system --quick
    log_info "Lynis 报告通常位于 /var/log/lynis-report.dat"
}

run_debsums_audit() {
    update_apt_once
    if ! install_packages_batch "debsums"; then
        log_error "debsums 安装失败"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将执行 debsums -s"
        return 0
    fi
    debsums -s || log_warning "发现包文件校验差异，请审阅输出"
}

function action_security_audit() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              安全审计                         #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 安装 Lynis / debsums"
        printf '%b\n' "${GREEN}2.${PLAIN} 运行 Lynis 快速审计"
        printf '%b\n' "${GREEN}3.${PLAIN} 检查 Debian 包文件校验 (debsums)"
        printf '%b\n' "${GREEN}4.${PLAIN} SSH 配置审计"
        printf '%b\n' "${GREEN}5.${PLAIN} 端口暴露扫描"
        printf '%b\n' "${GREEN}6.${PLAIN} Docker 安全基线"
        printf '%b\n' "${GREEN}7.${PLAIN} 外部资源信任清单"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-7]: " choice
        case "$choice" in
            1) run_menu_action install_security_audit_tools ;;
            2) run_menu_action run_lynis_quick_audit ;;
            3) run_menu_action run_debsums_audit ;;
            4) run_menu_action action_ssh_config_audit ;;
            5) run_menu_action action_port_exposure_scan ;;
            6) run_menu_action action_docker_security_baseline ;;
            7) run_menu_action action_external_trust_inventory ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: Docker Compose 项目备份 ---
docker_compose_cmd() {
    if docker compose version > /dev/null 2>&1; then
        echo "docker compose"
    elif command -v docker-compose > /dev/null 2>&1; then
        echo "docker-compose"
    else
        return 1
    fi
}

run_docker_compose_backup_once() {
    local project_dir backup_root compose_cmd timestamp project_name backup_dir compose_file volumes
    read -r -p "Compose 项目目录 [默认当前目录]: " project_dir
    project_dir="${project_dir:-$(pwd)}"
    read -r -p "备份根目录 [默认 /var/backups/docker-compose]: " backup_root
    backup_root="${backup_root:-/var/backups/docker-compose}"

    if [ ! -d "$project_dir" ]; then
        log_error "项目目录不存在: $project_dir"
        return 1
    fi
    if ! compose_cmd="$(docker_compose_cmd)"; then
        log_error "未检测到 docker compose 或 docker-compose"
        return 1
    fi

    compose_file=""
    for candidate in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
        if [ -f "$project_dir/$candidate" ]; then
            compose_file="$candidate"
            break
        fi
    done
    if [ -z "$compose_file" ]; then
        log_error "未找到 compose.yaml / docker-compose.yml"
        return 1
    fi

    timestamp="$(date +%Y%m%d_%H%M%S)"
    project_name="$(basename "$project_dir")"
    backup_dir="${backup_root}/${project_name}_${timestamp}"

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将备份 $project_dir 到 $backup_dir"
        return 0
    fi

    mkdir -p "$backup_dir"
    tar -C "$project_dir" -czf "$backup_dir/project-files.tar.gz" \
        "$compose_file" .env 2>/dev/null || tar -C "$project_dir" -czf "$backup_dir/project-files.tar.gz" "$compose_file"
    (cd "$project_dir" && $compose_cmd config) > "$backup_dir/compose.resolved.yaml" 2>/dev/null || true

    volumes="$(cd "$project_dir" && $compose_cmd config --volumes 2>/dev/null || true)"
    if [ -n "$volumes" ]; then
        mkdir -p "$backup_dir/volumes"
        if confirm_action "是否备份 Compose 命名卷? (可能需要拉取 busybox 镜像)" "y"; then
            local volume
            while IFS= read -r volume; do
                [ -z "$volume" ] && continue
                log_info "备份 volume: $volume"
                docker run --rm \
                    -v "${volume}:/volume:ro" \
                    -v "${backup_dir}/volumes:/backup" \
                    busybox tar -czf "/backup/${volume}.tar.gz" -C /volume . >> "$LOG_FILE" 2>&1 || \
                    log_warning "volume 备份失败: $volume"
            done <<< "$volumes"
        fi
    fi

    log_success "Docker Compose 项目备份完成: $backup_dir"
}

install_docker_compose_backup_timer() {
    local project_dir backup_root schedule include_volumes compose_cmd compose_file project_name timer_id
    local script_path service_path timer_path

    read -r -p "Compose 项目目录 [默认当前目录]: " project_dir
    project_dir="${project_dir:-$(pwd)}"
    read -r -p "备份根目录 [默认 /var/backups/docker-compose]: " backup_root
    backup_root="${backup_root:-/var/backups/docker-compose}"
    read -r -p "执行时间 (systemd OnCalendar，默认 *-*-* 04:10:00): " schedule
    schedule="${schedule:-*-*-* 04:10:00}"
    if ! validate_systemd_calendar_value "$schedule"; then
        log_error "无效的 systemd OnCalendar 表达式: $schedule"
        return 1
    fi
    if confirm_action "定时备份时是否包含 Compose 命名卷?" "y"; then
        include_volumes="1"
    else
        include_volumes="0"
    fi

    if [ ! -d "$project_dir" ]; then
        log_error "项目目录不存在: $project_dir"
        return 1
    fi
    if ! compose_cmd="$(docker_compose_cmd)"; then
        log_error "未检测到 docker compose 或 docker-compose"
        return 1
    fi

    compose_file=""
    for candidate in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
        if [ -f "$project_dir/$candidate" ]; then
            compose_file="$candidate"
            break
        fi
    done
    if [ -z "$compose_file" ]; then
        log_error "未找到 compose.yaml / docker-compose.yml"
        return 1
    fi

    project_name="$(basename "$project_dir")"
    timer_id="$(printf '%s' "$project_name" | tr -cd 'A-Za-z0-9_.-' | cut -c1-48)"
    [ -n "$timer_id" ] || timer_id="compose"
    script_path="/usr/local/sbin/init-compose-backup-${timer_id}"
    service_path="/etc/systemd/system/init-compose-backup-${timer_id}.service"
    timer_path="/etc/systemd/system/init-compose-backup-${timer_id}.timer"

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将创建 Compose 备份定时器: init-compose-backup-${timer_id}.timer"
        return 0
    fi

    write_file_atomic "$script_path" "Compose backup executable" 700 0 0 <<EOF || return 1
#!/bin/bash
set -euo pipefail

PROJECT_DIR=$(printf '%q' "$project_dir")
BACKUP_ROOT=$(printf '%q' "$backup_root")
COMPOSE_CMD=$(printf '%q' "$compose_cmd")
COMPOSE_FILE=$(printf '%q' "$compose_file")
INCLUDE_VOLUMES=$(printf '%q' "$include_volumes")
LOG_FILE="/var/log/init-compose-backup-${timer_id}.log"

timestamp="\$(date +%Y%m%d_%H%M%S)"
project_name="\$(basename "\$PROJECT_DIR")"
backup_dir="\${BACKUP_ROOT}/\${project_name}_\${timestamp}"

mkdir -p "\$backup_dir"
{
    echo "===== \$(date '+%Y-%m-%d %H:%M:%S') compose backup start ====="
    tar -C "\$PROJECT_DIR" -czf "\$backup_dir/project-files.tar.gz" "\$COMPOSE_FILE" .env 2>/dev/null || \
        tar -C "\$PROJECT_DIR" -czf "\$backup_dir/project-files.tar.gz" "\$COMPOSE_FILE"
    (cd "\$PROJECT_DIR" && \$COMPOSE_CMD config) > "\$backup_dir/compose.resolved.yaml" 2>/dev/null || true
    if [ "\$INCLUDE_VOLUMES" = "1" ]; then
        volumes="\$(cd "\$PROJECT_DIR" && \$COMPOSE_CMD config --volumes 2>/dev/null || true)"
        if [ -n "\$volumes" ]; then
            mkdir -p "\$backup_dir/volumes"
            while IFS= read -r volume; do
                [ -z "\$volume" ] && continue
                docker run --rm -v "\${volume}:/volume:ro" -v "\$backup_dir/volumes:/backup" \
                    busybox tar -czf "/backup/\${volume}.tar.gz" -C /volume . || true
            done <<< "\$volumes"
        fi
    fi
    echo "backup_dir=\$backup_dir"
    echo "===== \$(date '+%Y-%m-%d %H:%M:%S') compose backup done ====="
} >> "\$LOG_FILE" 2>&1
EOF
    write_file_atomic "$service_path" "Compose backup service" 644 0 0 \
        validate_systemd_candidate <<EOF || return 1
[Unit]
Description=Docker Compose Backup ($project_name)
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=$script_path
EOF

    write_file_atomic "$timer_path" "Compose backup timer" 644 0 0 \
        validate_systemd_candidate <<EOF || return 1
[Unit]
Description=Run Docker Compose Backup ($project_name)

[Timer]
OnCalendar=$schedule
Persistent=true
RandomizedDelaySec=20m

[Install]
WantedBy=timers.target
EOF

    systemd_daemon_reload || return 1
    if ! systemctl enable --now "init-compose-backup-${timer_id}.timer"; then
        log_error "Compose 备份定时器启用失败"
        return 1
    fi
    log_success "Compose 定时备份已启用: init-compose-backup-${timer_id}.timer"
    log_info "手动执行: systemctl start init-compose-backup-${timer_id}.service"
    log_info "查看日志: tail -n 100 /var/log/init-compose-backup-${timer_id}.log"
}

list_docker_compose_backup_timers() {
    systemctl list-timers 'init-compose-backup-*.timer' --no-pager 2>/dev/null || true
    printf '%b\n' ""
    systemctl list-unit-files 'init-compose-backup-*.timer' --no-pager 2>/dev/null || true
}

action_docker_security_baseline() {
    local scan_dir compose_files ps_file
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              Docker 安全基线                 #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"

    if ! command -v docker > /dev/null 2>&1; then
        log_warning "未检测到 docker 命令"
        return 1
    fi

    printf '%b\n' "${BOLD}运行中容器风险:${PLAIN}"
    ps_file="$(mktemp /tmp/init-docker-ps.XXXXXX)"
    register_temp_file "$ps_file"
    if ! docker ps -q > "$ps_file" 2>/dev/null || [ ! -s "$ps_file" ]; then
        log_info "没有运行中的容器，或 Docker daemon 不可用"
    else
        while IFS= read -r container_id; do
            local name privileged network_mode binds ports restart_policy user risk
            name="$(docker inspect --format '{{.Name}}' "$container_id" 2>/dev/null | sed 's#^/##')"
            privileged="$(docker inspect --format '{{.HostConfig.Privileged}}' "$container_id" 2>/dev/null || true)"
            network_mode="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container_id" 2>/dev/null || true)"
            binds="$(docker inspect --format '{{json .HostConfig.Binds}}' "$container_id" 2>/dev/null || true)"
            ports="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container_id" 2>/dev/null || true)"
            restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container_id" 2>/dev/null || true)"
            user="$(docker inspect --format '{{.Config.User}}' "$container_id" 2>/dev/null || true)"
            risk="OK"

            [ "$privileged" = "true" ] && risk="CHECK privileged=true"
            [ "$network_mode" = "host" ] && risk="CHECK network=host"
            printf '%s' "$binds" | grep -q '/var/run/docker.sock' && risk="CHECK docker.sock mounted"
            [ -z "$restart_policy" ] || [ "$restart_policy" = "no" ] && risk="${risk}; restart=no"
            [ -z "$user" ] && user="root/default"

            printf "%-28s privileged=%-5s network=%-10s restart=%-10s user=%-14s %s\n" \
                "$name" "$privileged" "$network_mode" "$restart_policy" "$user" "$risk"
            printf "  ports: %s\n" "$ports"
            printf "  binds: %s\n" "$binds" | sed 's/\\n/ /g'
        done < "$ps_file"
    fi

    printf '%b\n' ""
    read -r -p "扫描 Compose 文件目录 [默认当前目录]: " scan_dir
    scan_dir="${scan_dir:-$(pwd)}"
    if [ ! -d "$scan_dir" ]; then
        log_warning "目录不存在: $scan_dir"
        return 0
    fi

    printf '%b\n' "${BOLD}Compose 文件风险线索:${PLAIN}"
    compose_files="$(find "$scan_dir" -maxdepth 5 -type f \( -name 'compose.yaml' -o -name 'compose.yml' -o -name 'docker-compose.yml' -o -name 'docker-compose.yaml' \) 2>/dev/null || true)"
    if [ -z "$compose_files" ]; then
        log_info "未发现 Compose 文件"
        return 0
    fi
    while IFS= read -r compose_file; do
        [ -z "$compose_file" ] && continue
        printf '%b\n' "${CYAN}$compose_file${PLAIN}"
        grep -nE 'privileged:[[:space:]]*true|network_mode:[[:space:]]*host|/var/run/docker.sock|^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+' "$compose_file" 2>/dev/null || \
            echo "  未发现 privileged/host network/docker.sock/显式端口映射线索"
    done <<< "$compose_files"
}

action_docker_image_update_check() {
    local images image local_id local_digests remote_summary remote_digest status

    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              Docker 镜像更新检查             #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"

    if ! command -v docker > /dev/null 2>&1; then
        log_warning "未检测到 docker 命令"
        return 1
    fi

    images="$(docker ps --format '{{.Image}}' 2>/dev/null | sort -u || true)"
    if [ -z "$images" ]; then
        log_info "没有运行中的容器镜像，或 Docker daemon 不可用"
        return 0
    fi

    printf '%b\n' "${YELLOW}说明:${PLAIN} 此检查只读取远端 manifest 摘要，不会执行 docker pull。私有仓库可能需要先 docker login。"
    printf '%b\n' ""
    while IFS= read -r image; do
        [ -z "$image" ] && continue
        case "$image" in
            *@sha256:*|localhost/*|127.0.0.1:*/*)
                printf '%b\n' "${CYAN}$image${PLAIN}"
                echo "  跳过: digest 固定镜像或本地仓库镜像"
                continue
                ;;
        esac

        local_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null | sed 's/^sha256://')"
        local_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null | sed -n '1,5p' || true)"
        remote_summary=""
        remote_digest=""

        if docker buildx version > /dev/null 2>&1; then
            remote_summary="$(docker buildx imagetools inspect "$image" 2>/dev/null | sed -n '1,40p' || true)"
            remote_digest="$(printf '%s\n' "$remote_summary" | awk '/Digest:/ {print $2; exit}')"
        else
            remote_summary="$(docker manifest inspect "$image" 2>/dev/null | sed -n '1,40p' || true)"
            remote_digest="$(printf '%s\n' "$remote_summary" | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
        fi

        status="review"
        if [ -n "$remote_digest" ] && printf '%s\n' "$local_digests" | grep -q "$remote_digest"; then
            status="likely-current"
        elif [ -z "$remote_digest" ]; then
            status="remote-unavailable"
        fi

        printf '%b\n' "${CYAN}$image${PLAIN}"
        printf "  local-id: %s\n" "${local_id:-unknown}"
        printf "  local-digests:\n%s\n" "${local_digests:-  none}"
        printf "  remote-digest: %s\n" "${remote_digest:-unknown}"
        printf "  status: %s\n" "$status"
        if [ "$status" = "review" ]; then
            echo "  建议: 在维护窗口内对对应 Compose 项目执行 docker compose pull && docker compose up -d"
        fi
        printf '%b\n' ""
    done <<< "$images"
}

function action_docker_compose_backup() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#           Docker Compose 项目备份             #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 立即备份 Compose 项目"
        printf '%b\n' "${GREEN}2.${PLAIN} 配置 Compose 项目定时备份"
        printf '%b\n' "${GREEN}3.${PLAIN} 查看 Compose 备份定时器"
        printf '%b\n' "${GREEN}4.${PLAIN} Docker 安全基线检查"
        printf '%b\n' "${GREEN}5.${PLAIN} Docker 镜像更新检查"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-5]: " choice
        case "$choice" in
            1) run_menu_action run_docker_compose_backup_once ;;
            2) run_menu_action install_docker_compose_backup_timer ;;
            3) run_menu_action list_docker_compose_backup_timers ;;
            4) run_menu_action action_docker_security_baseline ;;
            5) run_menu_action action_docker_image_update_check ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 状态总览 / 脚本自检 ---
print_command_status() {
    local name="$1"
    local cmd="$2"
    if command -v "$cmd" > /dev/null 2>&1; then
        printf "%-28s ${GREEN}%-12s${PLAIN} %s\n" "$name" "installed" "$(command -v "$cmd")"
    else
        printf "%-28s ${YELLOW}%-12s${PLAIN}\n" "$name" "missing"
    fi
}

print_systemd_status() {
    local name="$1"
    local unit="$2"
    local active="n/a"
    local enabled="n/a"

    if command -v systemctl > /dev/null 2>&1; then
        active="$(systemctl is-active "$unit" 2>/dev/null || true)"
        enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
    fi

    printf "%-32s active=%-12s enabled=%-12s\n" "$name" "$active" "$enabled"
}

function action_module_status_overview() {
    clear
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              模块状态总览                    #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' ""

    printf '%b\n' "${BOLD}核心命令:${PLAIN}"
    print_command_status "Docker" "docker"
    print_command_status "Docker Compose v1" "docker-compose"
    if docker compose version > /dev/null 2>&1; then
        printf "%-28s ${GREEN}%-12s${PLAIN}\n" "Docker Compose v2" "available"
    else
        printf "%-28s ${YELLOW}%-12s${PLAIN}\n" "Docker Compose v2" "missing"
    fi
    print_command_status "Restic" "restic"
    print_command_status "BorgBackup" "borg"
    print_command_status "Caddy" "caddy"
    print_command_status "Nginx" "nginx"
    print_command_status "Certbot" "certbot"
    print_command_status "Lynis" "lynis"
    print_command_status "ShellCheck" "shellcheck"
    print_command_status "ss" "ss"
    print_command_status "sshd" "sshd"
    print_command_status "unattended-upgrades" "unattended-upgrades"
    printf '%b\n' ""

    printf '%b\n' "${BOLD}服务 / 定时器:${PLAIN}"
    print_systemd_status "Docker" "docker.service"
    print_systemd_status "Restic 备份定时器" "init-restic-backup.timer"
    print_systemd_status "健康检查定时器" "init-health-check.timer"
    print_systemd_status "维护检查定时器" "init-maintenance-check.timer"
    print_systemd_status "node_exporter" "prometheus-node-exporter.service"
    print_systemd_status "Caddy" "caddy.service"
    print_systemd_status "Nginx" "nginx.service"
    printf '%b\n' ""

    if command -v systemctl > /dev/null 2>&1; then
        printf '%b\n' "${BOLD}Compose 备份定时器:${PLAIN}"
        systemctl list-timers 'init-compose-backup-*.timer' --no-pager 2>/dev/null || true
        printf '%b\n' ""
    fi

    printf '%b\n' "${BOLD}配置文件:${PLAIN}"
    [ -f /root/.config/init-script/restic.env ] && echo "restic: /root/.config/init-script/restic.env" || echo "restic: 未配置"
    [ -f /etc/systemd/journald.conf.d/99-init.conf ] && echo "journald: 已配置持久化" || echo "journald: 未检测到 init 配置"
    [ -f /etc/apt/apt.conf.d/52unattended-maintenance-window ] && echo "maintenance: 已配置自动更新维护窗口" || echo "maintenance: 未检测到"
    [ -d /etc/caddy/conf.d ] && echo "caddy sites: /etc/caddy/conf.d" || echo "caddy sites: 未检测到"
    [ -d /var/backups/docker-compose ] && echo "compose backups: /var/backups/docker-compose" || echo "compose backups: 未检测到默认目录"
    menu_pause
}

run_script_static_self_check() {
    local script_path
    script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    log_info "执行 bash 语法检查..."
    bash -n "$script_path"
    log_success "bash -n 通过"

    log_info "检查新增模块函数..."
    local fn
    local required_functions=(
        action_backup_restore
        action_monitoring_alerts
        action_reverse_proxy_cert
        action_security_audit
        action_docker_compose_backup
        action_module_status_overview
        action_script_quality
        action_profile_plan_apply
        profile_module_catalog
        profile_module_impact
        validate_profile_modules
        action_ops_enhancements
        generate_system_change_report
        action_port_exposure_scan
        action_ssh_config_audit
        action_external_trust_inventory
        action_configure_maintenance_window
        action_docker_security_baseline
        action_docker_image_update_check
        run_restic_restore_drill
        configure_restic_local_backup
        preview_restic_snapshot
        install_docker_compose_backup_timer
        select_ssh_key_target
        authorized_keys_is_usable_for_user
        run_command
        write_file_atomic
        atomic_install_file
        invoke_action
        run_safety_tests
    )
    for fn in "${required_functions[@]}"; do
        if declare -F "$fn" > /dev/null 2>&1; then
            printf "%-36s ${GREEN}%s${PLAIN}\n" "$fn" "OK"
        else
            printf "%-36s ${RED}%s${PLAIN}\n" "$fn" "MISSING"
            return 1
        fi
    done

    log_info "检查九个主菜单分区..."
    local menu_fn
    local menu_functions=(
        show_quick_start_menu
        show_security_menu
        show_system_menu
        show_docker_app_menu
        show_dev_menu
        show_storage_menu
        show_diagnostics_menu
        show_script_ops_menu
        show_advanced_menu
    )
    for menu_fn in "${menu_functions[@]}"; do
        if declare -F "$menu_fn" > /dev/null 2>&1; then
            printf "%-36s ${GREEN}%s${PLAIN}\n" "$menu_fn" "OK"
        else
            printf "%-36s ${RED}%s${PLAIN}\n" "$menu_fn" "MISSING"
            return 1
        fi
    done

    log_info "扫描直接远程脚本执行模式..."
    local remote_pattern='curl .*\| *(bash|sh)|bash <\(|wget -O -|wget https?://|wget -q'
    local remote_hits=""
    if command -v rg > /dev/null 2>&1; then
        remote_hits="$(rg -n "$remote_pattern" "$script_path" 2>/dev/null | grep -Ev 'remote_pattern=|未发现 curl\|bash' || true)"
    else
        remote_hits="$(grep -En "$remote_pattern" "$script_path" 2>/dev/null | grep -Ev 'remote_pattern=|未发现 curl\|bash' || true)"
    fi
    if [ -n "$remote_hits" ]; then
        printf '%s\n' "$remote_hits"
        log_warning "发现可能的直接远程执行/下载模式，请审阅上方输出"
    else
        log_success "未发现 curl|bash / bash <(curl) / 直接 wget URL 模式"
    fi
}

run_shellcheck_scan() {
    local script_path
    script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    if ! command -v shellcheck > /dev/null 2>&1; then
        log_warning "ShellCheck 未安装"
        if confirm_action "是否尝试通过 apt 安装 shellcheck?" "n"; then
            update_apt_once
            install_packages_batch "shellcheck" || return 1
        else
            return 1
        fi
    fi
    shellcheck "$script_path"
}

run_safety_tests() {
    local test_script="$SCRIPT_DIR/tests/test_init_safety.sh"
    if [ ! -x "$test_script" ]; then
        log_error "安全回归测试不存在或不可执行: $test_script"
        return 1
    fi
    "$test_script"
}

function action_script_quality() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              脚本自检 / ShellCheck           #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 静态自检 (bash -n / 函数 / 菜单分区 / 远程执行扫描)"
        printf '%b\n' "${GREEN}2.${PLAIN} 运行 ShellCheck"
        printf '%b\n' "${GREEN}3.${PLAIN} 运行安全/故障注入回归测试"
        printf '%b\n' "${GREEN}4.${PLAIN} 查看模块状态总览"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-4]: " choice
        case "$choice" in
            1) run_menu_action run_script_static_self_check ;;
            2) run_menu_action run_shellcheck_scan ;;
            3) run_menu_action run_safety_tests ;;
            4) action_module_status_overview ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: Profile / Plan / 报告 / 安全基线增强 ---
profile_presets() {
    printf '%s\n' "minimal" "docker-host" "dev-box" "secure-server"
}

profile_modules_for_preset() {
    local profile="$1"
    case "$profile" in
        minimal)
            printf '%s\n' "essentials ssh firewall fail2ban auto_updates swap module_status report"
            ;;
        docker-host)
            printf '%s\n' "essentials ssh firewall fail2ban auto_updates docker reverse_proxy compose_backup monitoring backup_restore docker_security docker_image_check port_exposure report"
            ;;
        dev-box)
            printf '%s\n' "essentials runtime terminal network_tools rclone croc module_status report"
            ;;
        secure-server)
            printf '%s\n' "essentials ssh firewall fail2ban auto_updates security_audit ssh_audit port_exposure external_trust maintenance_window report"
            ;;
        *)
            return 1
            ;;
    esac
}

profile_description() {
    local profile="$1"
    case "$profile" in
        minimal) printf '最小服务器基线：基础工具、SSH、防火墙、Fail2ban、自动安全更新、Swap。' ;;
        docker-host) printf 'Docker 应用主机：Docker、反代、Compose 备份、监控、备份与安全基线。' ;;
        dev-box) printf '开发机：语言运行时、终端环境、网络工具、rclone、croc。' ;;
        secure-server) printf '安全服务器基线：主动配置 SSH/UFW/Fail2ban/自动更新与维护窗口，并附带只读审计报告。' ;;
        *) printf '自定义 Profile。' ;;
    esac
}

profile_module_description() {
    local module="$1"
    case "$module" in
        essentials) printf '安装基础工具包' ;;
        ssh) printf 'SSH 安全配置' ;;
        firewall) printf 'UFW 防火墙配置' ;;
        fail2ban) printf 'Fail2ban 防暴力破解' ;;
        auto_updates) printf 'unattended-upgrades 自动安全更新' ;;
        swap) printf 'Swap 交换空间配置' ;;
        docker) printf 'Docker Engine + Compose 官方 apt 安装' ;;
        reverse_proxy) printf 'Caddy 或 Nginx+Certbot 反向代理/证书' ;;
        compose_backup) printf 'Docker Compose 项目备份' ;;
        monitoring) printf 'journald/node_exporter/健康检查定时器' ;;
        backup_restore) printf 'restic/borg 备份恢复' ;;
        security_audit) printf 'Lynis/debsums 安全审计' ;;
        runtime) printf 'Node/Python/PHP/Java/Go/.NET Runtime 管理器' ;;
        terminal) printf 'Zsh/Starship/Neovim/Eza 终端环境' ;;
        network_tools) printf 'mtr/httpie/nmap 等网络工具' ;;
        rclone) printf 'rclone 预编译二进制安装' ;;
        croc) printf 'croc 文件传输工具' ;;
        module_status) printf '模块状态总览' ;;
        script_quality) printf '脚本自检 / ShellCheck' ;;
        report) printf '生成系统变更报告' ;;
        port_exposure) printf '端口暴露扫描' ;;
        ssh_audit) printf 'SSH 配置审计' ;;
        external_trust) printf '外部资源信任清单' ;;
        maintenance_window) printf '自动更新维护窗口' ;;
        restic_drill) printf 'restic 恢复演练' ;;
        docker_security) printf 'Docker 安全基线检查' ;;
        docker_image_check) printf 'Docker 镜像更新检查' ;;
        *) printf '未知模块' ;;
    esac
}

profile_module_impact() {
    local module="$1"
    case "$module" in
        essentials) printf 'apt 包: curl/wget/git/vim/tmux 等；不改核心配置。' ;;
        ssh) printf '文件: /etc/ssh/sshd_config 与所选账户 authorized_keys；服务: ssh/sshd；可能改变 SSH 端口/登录方式。' ;;
        firewall) printf '服务: ufw；规则: SSH 端口与常用入站策略。' ;;
        fail2ban) printf '文件: /etc/fail2ban/jail.d/sshd.local；服务: fail2ban。' ;;
        auto_updates) printf '文件: /etc/apt/apt.conf.d/20auto-upgrades, 50unattended-upgrades。' ;;
        swap) printf '文件: /swapfile, /etc/fstab；内核参数: vm.swappiness。' ;;
        docker) printf '仓库: download.docker.com apt；包: docker-ce/docker compose；服务: docker。' ;;
        reverse_proxy) printf '包/服务: caddy 或 nginx+certbot；文件: /etc/caddy 或 /etc/nginx。' ;;
        compose_backup) printf '文件: /usr/local/sbin/init-compose-backup-*；timer: init-compose-backup-*.timer。' ;;
        monitoring) printf '文件: journald 配置、健康检查脚本；服务/timer: node_exporter/init-health-check。' ;;
        backup_restore) printf '工具: restic/borg；文件: /root/.config/init-script/restic.env；timer: init-restic-backup。' ;;
        security_audit) printf '包: lynis/debsums；输出: /var/log/lynis-report.dat。' ;;
        runtime) printf '按选择安装语言运行时；可能修改用户 shell 配置。' ;;
        terminal) printf '包/工具: zsh/starship/neovim/eza；文件: ~/.zshrc, ~/.bashrc。' ;;
        network_tools) printf 'apt 包: mtr/httpie/nmap/jq/dig 等诊断工具。' ;;
        rclone) printf '下载 rclone 预编译包并安装到 /usr/bin/rclone。' ;;
        croc) printf '优先 apt 安装 croc，必要时使用官方安装脚本。' ;;
        module_status) printf '只读检查命令、服务、配置文件状态。' ;;
        script_quality) printf '只读 bash -n/函数/菜单分区/远程执行模式扫描，可选安装 shellcheck。' ;;
        report) printf '写入 /root/init-report-*.txt，汇总系统、端口、服务、Docker、外部资源。' ;;
        port_exposure) printf '只读 ss/ufw/docker/Nginx/Caddy 端口暴露检查。' ;;
        ssh_audit) printf '只读 sshd -T、authorized_keys 权限和 UFW SSH 端口匹配检查。' ;;
        external_trust) printf '只读扫描脚本中的 URL，并按 official/mirror/service/remote-script/unknown 分类。' ;;
        maintenance_window) printf '文件: apt-daily-upgrade.timer override 和 unattended maintenance 配置。' ;;
        restic_drill) printf '从 restic snapshot 恢复关键路径到 /var/tmp/init-restic-drill。' ;;
        docker_security) printf '只读 docker inspect 与 Compose 文件风险线索扫描。' ;;
        docker_image_check) printf '只读检查运行中容器镜像的本地摘要与远端 manifest 摘要。' ;;
        *) printf '未知影响，请先审阅模块。' ;;
    esac
}

profile_module_catalog() {
    local module
    for module in \
        essentials ssh firewall fail2ban auto_updates swap docker reverse_proxy compose_backup \
        monitoring backup_restore security_audit runtime terminal network_tools rclone croc \
        module_status script_quality report port_exposure ssh_audit external_trust \
        maintenance_window restic_drill docker_security docker_image_check; do
        printf "  %-20s %s\n" "$module" "$(profile_module_description "$module")"
    done
}

is_profile_module_known() {
    local module="$1"
    case "$module" in
        essentials|ssh|firewall|fail2ban|auto_updates|swap|docker|reverse_proxy|compose_backup|monitoring|backup_restore|security_audit|runtime|terminal|network_tools|rclone|croc|module_status|script_quality|report|port_exposure|ssh_audit|external_trust|maintenance_window|restic_drill|docker_security|docker_image_check)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

validate_profile_modules() {
    local modules="$1"
    local module ok=0
    for module in $modules; do
        if ! is_profile_module_known "$module"; then
            log_warning "未知 Profile 模块: $module"
            ok=1
        fi
    done
    return "$ok"
}

show_profile_plan() {
    local profile_name="$1"
    local modules="$2"
    local idx=1 module

    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              Profile 执行计划                #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${BOLD}Profile:${PLAIN} $profile_name"
    printf '%b\n' "${BOLD}说明:${PLAIN} $(profile_description "$profile_name")"
    printf '%b\n' "${BOLD}模式:${PLAIN} DRY_RUN=$DRY_RUN PLAN_ONLY=$PLAN_ONLY EXTERNAL_TRUST_MODE=$EXTERNAL_TRUST_MODE"
    printf '%b\n' ""
    for module in $modules; do
        printf "%2d. %-20s %s\n" "$idx" "$module" "$(profile_module_description "$module")"
        printf "    impact: %s\n" "$(profile_module_impact "$module")"
        idx=$((idx + 1))
    done
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}提示:${PLAIN} 计划中包含交互式模块时，Apply 阶段会继续询问必要参数。"
}

write_profile_file() {
    local profile_name="$1"
    local modules="$2"
    local output_file="$3"
    local safe_profile_name safe_modules safe_trust_mode

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将写入 Profile 文件: $output_file"
        return 0
    fi

    safe_profile_name="${profile_name//\\/\\\\}"
    safe_profile_name="${safe_profile_name//\"/\\\"}"
    safe_modules="${modules//\\/\\\\}"
    safe_modules="${safe_modules//\"/\\\"}"
    safe_trust_mode="${EXTERNAL_TRUST_MODE//\\/\\\\}"
    safe_trust_mode="${safe_trust_mode//\"/\\\"}"

    mkdir -p "$(dirname "$output_file")"
    {
        printf '# init.sh profile generated at %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
        printf 'PROFILE_NAME="%s"\n' "$safe_profile_name"
        printf 'PROFILE_MODULES="%s"\n' "$safe_modules"
        printf 'EXTERNAL_TRUST_MODE="%s"\n' "$safe_trust_mode"
    } > "$output_file"
    chmod 600 "$output_file"
    log_success "Profile 已导出: $output_file"
}

load_profile_file() {
    local input_file="$1"
    local line key value
    PROFILE_LOADED_NAME="custom"
    PROFILE_LOADED_MODULES=""

    if [ ! -f "$input_file" ]; then
        log_error "Profile 文件不存在: $input_file"
        return 1
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        line="$(trim_whitespace "$line")"
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac
        line="${line#export }"
        key="${line%%=*}"
        value="${line#*=}"
        key="$(trim_whitespace "$key")"
        value="$(trim_whitespace "$value")"
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        case "$key" in
            PROFILE_NAME) PROFILE_LOADED_NAME="$value" ;;
            PROFILE_MODULES) PROFILE_LOADED_MODULES="$value" ;;
            EXTERNAL_TRUST_MODE) EXTERNAL_TRUST_MODE="$value" ;;
        esac
    done < "$input_file"

    if [ -z "$PROFILE_LOADED_MODULES" ]; then
        log_error "Profile 文件缺少 PROFILE_MODULES"
        return 1
    fi
}

run_profile_module() {
    local module="$1"
    case "$module" in
        essentials) invoke_action action_install_essentials ;;
        ssh) invoke_action action_configure_ssh ;;
        firewall) invoke_action action_configure_firewall ;;
        fail2ban) invoke_action action_configure_fail2ban ;;
        auto_updates) invoke_action action_configure_auto_updates ;;
        swap) invoke_action action_configure_swap ;;
        docker) invoke_action action_install_docker ;;
        reverse_proxy) invoke_action action_reverse_proxy_cert ;;
        compose_backup) invoke_action action_docker_compose_backup ;;
        monitoring) invoke_action action_monitoring_alerts ;;
        backup_restore) invoke_action action_backup_restore ;;
        security_audit) invoke_action action_security_audit ;;
        runtime) invoke_action action_install_runtime ;;
        terminal) invoke_action action_install_terminal_tools ;;
        network_tools) invoke_action action_install_network_http_tools ;;
        rclone) invoke_action action_install_rclone ;;
        croc) invoke_action action_install_croc ;;
        module_status) invoke_action action_module_status_overview ;;
        script_quality) invoke_action action_script_quality ;;
        report) invoke_action generate_system_change_report ;;
        port_exposure) invoke_action action_port_exposure_scan ;;
        ssh_audit) invoke_action action_ssh_config_audit ;;
        external_trust) invoke_action action_external_trust_inventory ;;
        maintenance_window) invoke_action action_configure_maintenance_window ;;
        restic_drill) invoke_action run_restic_restore_drill ;;
        docker_security) invoke_action action_docker_security_baseline ;;
        docker_image_check) invoke_action action_docker_image_update_check ;;
        *)
            log_warning "未知 Profile 模块: $module"
            return 1
            ;;
    esac
}

apply_profile_modules() {
    local profile_name="$1"
    local modules="$2"
    local module status=0

    validate_profile_modules "$modules" || return 1
    show_profile_plan "$profile_name" "$modules"
    if [ "$PLAN_ONLY" = "1" ]; then
        log_info "PLAN_ONLY=1，仅展示计划，不执行"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "DRY_RUN=1，逐项展示动作计划，不调用任何模块实现"
        for module in $modules; do
            run_profile_module "$module" || return 1
        done
        return 0
    fi
    if ! confirm_action "确认按上述计划执行 Profile?" "n"; then
        log_warning "已取消 Profile 执行"
        return 1
    fi

    for module in $modules; do
        log_info "Profile 模块开始: $module - $(profile_module_description "$module")"
        run_profile_module "$module" || status=$?
        if [ "$status" -ne 0 ]; then
            log_warning "Profile 模块失败或被取消: $module (status=$status)"
            if ! confirm_action "是否继续执行后续模块?" "n"; then
                return "$status"
            fi
            status=0
        fi
    done
    log_success "Profile 执行完成: $profile_name"
}

choose_profile_preset() {
    local profile
    printf '%b\n' "${GREEN}可用 Profile:${PLAIN}"
    for profile in $(profile_presets); do
        printf "  %-14s %s\n" "$profile" "$(profile_description "$profile")"
    done
    read -r -p "请输入 Profile 名称: " profile
    if ! profile_modules_for_preset "$profile" >/dev/null 2>&1; then
        log_error "未知 Profile: $profile"
        return 1
    fi
    PROFILE_LOADED_NAME="$profile"
    PROFILE_LOADED_MODULES="$(profile_modules_for_preset "$profile")"
}

action_profile_plan_apply() {
    local choice output_file input_file custom_name custom_modules
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#           Profile / Plan / Apply             #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} 查看内置 Profile"
        printf '%b\n' "${GREEN}2.${PLAIN} 选择 Profile 并查看计划"
        printf '%b\n' "${GREEN}3.${PLAIN} 选择 Profile 并执行"
        printf '%b\n' "${GREEN}4.${PLAIN} 导出内置 Profile 到文件"
        printf '%b\n' "${GREEN}5.${PLAIN} 导入 Profile 文件并查看计划"
        printf '%b\n' "${GREEN}6.${PLAIN} 导入 Profile 文件并执行"
        printf '%b\n' "${GREEN}7.${PLAIN} 创建自定义 Profile"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-7]: " choice
        case "$choice" in
            1)
                profile_presets | while IFS= read -r p; do
                    printf "%-14s %s\n" "$p" "$(profile_description "$p")"
                    printf "  modules: %s\n" "$(profile_modules_for_preset "$p")"
                done
                menu_pause
                ;;
            2)
                choose_profile_preset || { menu_pause; continue; }
                show_profile_plan "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
                menu_pause
                ;;
            3)
                choose_profile_preset || { menu_pause; continue; }
                apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
                menu_pause
                ;;
            4)
                choose_profile_preset || { menu_pause; continue; }
                read -r -p "导出路径 [默认 /root/init-profile-${PROFILE_LOADED_NAME}.env]: " output_file
                output_file="${output_file:-/root/init-profile-${PROFILE_LOADED_NAME}.env}"
                write_profile_file "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES" "$output_file"
                menu_pause
                ;;
            5)
                read -r -p "Profile 文件路径: " input_file
                load_profile_file "$input_file" || { menu_pause; continue; }
                show_profile_plan "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
                menu_pause
                ;;
            6)
                read -r -p "Profile 文件路径: " input_file
                load_profile_file "$input_file" || { menu_pause; continue; }
                apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
                menu_pause
                ;;
            7)
                printf '%b\n' "${GREEN}可用模块:${PLAIN}"
                profile_module_catalog
                read -r -p "自定义 Profile 名称 [默认 custom]: " custom_name
                custom_name="${custom_name:-custom}"
                read -r -p "模块列表（空格分隔）: " custom_modules
                if [ -z "$custom_modules" ]; then
                    log_warning "模块列表不能为空"
                    menu_pause
                    continue
                fi
                validate_profile_modules "$custom_modules" || { menu_pause; continue; }
                show_profile_plan "$custom_name" "$custom_modules"
                if confirm_action "是否导出该 Profile?" "y"; then
                    read -r -p "导出路径 [默认 /root/init-profile-${custom_name}.env]: " output_file
                    output_file="${output_file:-/root/init-profile-${custom_name}.env}"
                    write_profile_file "$custom_name" "$custom_modules" "$output_file"
                fi
                if confirm_action "是否立即执行该 Profile?" "n"; then
                    apply_profile_modules "$custom_name" "$custom_modules"
                fi
                menu_pause
                ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

report_section() {
    printf '\n## %s\n' "$1"
}

report_run() {
    printf '\n$'
    printf ' %q' "$@"
    printf '\n'
    "$@" 2>&1 || true
}

generate_system_change_report() {
    local report_file="${1:-/root/init-report-$(date +%Y%m%d_%H%M%S).txt}"
    local entry

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将生成系统变更报告: $report_file"
        return 0
    fi

    mkdir -p "$(dirname "$report_file")"
    {
        printf '# init.sh 系统变更报告\n'
        printf '生成时间: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
        printf '脚本版本: v8.5\n'
        printf '日志文件: %s\n' "$LOG_FILE"
        printf 'DRY_RUN=%s NON_INTERACTIVE=%s EXTERNAL_TRUST_MODE=%s\n' "$DRY_RUN" "$NON_INTERACTIVE" "$EXTERNAL_TRUST_MODE"

        report_section "系统信息"
        [ -f /etc/os-release ] && cat /etc/os-release
        report_run uname -a
        report_run uptime
        report_run df -h
        report_run free -h

        report_section "网络与端口"
        if command -v ss > /dev/null 2>&1; then
            report_run ss -tulpen
        fi
        if command -v ufw > /dev/null 2>&1; then
            report_run ufw status verbose
        fi

        report_section "服务与定时器"
        if command -v systemctl > /dev/null 2>&1; then
            report_run systemctl list-units --type=service --state=running --no-pager
            report_run systemctl list-timers --all --no-pager
        fi

        report_section "Docker"
        if command -v docker > /dev/null 2>&1 && docker info > /dev/null 2>&1; then
            report_run docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
            report_run docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'
        elif command -v docker > /dev/null 2>&1; then
            printf 'docker: installed, daemon unavailable or permission denied\n'
        else
            printf 'docker: not installed\n'
        fi

        report_section "手动安装包摘要"
        if command -v apt-mark > /dev/null 2>&1; then
            apt-mark showmanual 2>/dev/null | sed -n '1,200p'
        fi

        report_section "脚本配置文件"
        for path in \
            /root/.config/init-script/restic.env \
            /etc/systemd/journald.conf.d/99-init.conf \
            /etc/apt/apt.conf.d/20auto-upgrades \
            /etc/apt/apt.conf.d/52unattended-maintenance-window \
            /etc/caddy/conf.d; do
            [ -e "$path" ] && printf 'present: %s\n' "$path" || printf 'missing: %s\n' "$path"
        done

        report_section "本次会话可回滚操作"
        if [ ${#OPERATION_HISTORY[@]} -eq 0 ]; then
            printf '无\n'
        else
            for entry in "${OPERATION_HISTORY[@]}"; do
                printf '%s\n' "$entry"
            done
        fi

        report_section "外部资源清单"
        list_external_resource_inventory

        report_section "远程脚本 SHA256 记录"
        if [ -f "$LOG_FILE" ]; then
            grep -E '远程脚本已下载|远程脚本 SHA256' "$LOG_FILE" 2>/dev/null || printf '本次日志未记录远程脚本 SHA256。\n'
        else
            printf '日志文件不存在: %s\n' "$LOG_FILE"
        fi
    } > "$report_file"
    chmod 600 "$report_file"
    log_success "系统变更报告已生成: $report_file"
}

action_port_exposure_scan() {
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              端口暴露扫描                    #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"

    printf '%b\n' "${BOLD}监听端口:${PLAIN}"
    if command -v ss > /dev/null 2>&1; then
        ss -tulpen || true
    elif command -v netstat > /dev/null 2>&1; then
        netstat -tulpen || true
    else
        log_warning "未检测到 ss/netstat"
    fi

    printf '%b\n' "\n${BOLD}UFW:${PLAIN}"
    if command -v ufw > /dev/null 2>&1; then
        ufw status verbose || true
    else
        echo "ufw: missing"
    fi

    printf '%b\n' "\n${BOLD}Docker 端口映射:${PLAIN}"
    if command -v docker > /dev/null 2>&1; then
        docker ps --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}' || true
    else
        echo "docker: missing"
    fi

    printf '%b\n' "\n${BOLD}反向代理监听线索:${PLAIN}"
    grep -RInE 'listen[[:space:]]+[0-9]+|reverse_proxy|proxy_pass' /etc/nginx /etc/caddy 2>/dev/null || echo "未发现 Nginx/Caddy 配置线索或目录不存在"
}

action_ssh_config_audit() {
    local effective port permit_root password_auth pubkey_auth kbd_auth empty_password
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              SSH 配置审计                    #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"

    if command -v sshd > /dev/null 2>&1; then
        effective="$(sshd -T 2>/dev/null || true)"
    else
        effective=""
    fi

    if [ -n "$effective" ]; then
        port="$(printf '%s\n' "$effective" | awk '$1=="port"{print $2; exit}')"
        permit_root="$(printf '%s\n' "$effective" | awk '$1=="permitrootlogin"{print $2; exit}')"
        password_auth="$(printf '%s\n' "$effective" | awk '$1=="passwordauthentication"{print $2; exit}')"
        pubkey_auth="$(printf '%s\n' "$effective" | awk '$1=="pubkeyauthentication"{print $2; exit}')"
        kbd_auth="$(printf '%s\n' "$effective" | awk '$1=="kbdinteractiveauthentication"{print $2; exit}')"
        empty_password="$(printf '%s\n' "$effective" | awk '$1=="permitemptypasswords"{print $2; exit}')"
    else
        port="$(grep -Ei '^[[:space:]]*Port[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
        permit_root="$(grep -Ei '^[[:space:]]*PermitRootLogin[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
        password_auth="$(grep -Ei '^[[:space:]]*PasswordAuthentication[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
        pubkey_auth="$(grep -Ei '^[[:space:]]*PubkeyAuthentication[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
        kbd_auth="$(grep -Ei '^[[:space:]]*KbdInteractiveAuthentication[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
        empty_password="$(grep -Ei '^[[:space:]]*PermitEmptyPasswords[[:space:]]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1)"
    fi

    printf "%-28s %s\n" "Port" "${port:-22/default}"
    printf "%-28s %s\n" "PermitRootLogin" "${permit_root:-default}"
    printf "%-28s %s\n" "PasswordAuthentication" "${password_auth:-default}"
    printf "%-28s %s\n" "PubkeyAuthentication" "${pubkey_auth:-default}"
    printf "%-28s %s\n" "KbdInteractiveAuthentication" "${kbd_auth:-default}"
    printf "%-28s %s\n" "PermitEmptyPasswords" "${empty_password:-default}"

    printf '%b\n' "\n${BOLD}建议:${PLAIN}"
    [ "${password_auth,,}" = "no" ] && echo "  - 密码登录已禁用" || echo "  - 建议禁用 PasswordAuthentication"
    [ "${permit_root,,}" = "no" ] && echo "  - root SSH 登录已禁用" || echo "  - 建议禁用 PermitRootLogin"
    [ "${pubkey_auth,,}" = "yes" ] || [ -z "$pubkey_auth" ] && echo "  - 公钥登录可用" || echo "  - 建议启用 PubkeyAuthentication"
    [ "${empty_password,,}" = "no" ] || [ -z "$empty_password" ] && echo "  - 空密码登录未开启" || echo "  - 必须禁用 PermitEmptyPasswords"

    printf '%b\n' "\n${BOLD}authorized_keys 权限:${PLAIN}"
    find /root /home -maxdepth 3 -name authorized_keys -type f -exec stat -c '%a %U:%G %n' {} \; 2>/dev/null || true

    printf '%b\n' "\n${BOLD}防火墙端口匹配:${PLAIN}"
    if command -v ufw > /dev/null 2>&1; then
        ufw status numbered | grep -E "${port:-22}|OpenSSH" || true
    else
        echo "ufw: missing"
    fi
}

list_external_resource_inventory() {
    local script_path url trust host
    script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    if command -v rg > /dev/null 2>&1; then
        rg -o "https?://[^\"' )]+" "$script_path" 2>/dev/null | sort -u | while IFS= read -r url; do
            case "$url" in *'$'*|*'{'*|*'}'*|*,direct*|http://127.0.0.1*|http://1.2.3.4*|http://IP*) continue ;; esac
            host="$(external_url_host "$url")"
            trust="$(external_resource_trust_level "$url")"
            printf "%-16s %-32s %s\n" "$trust" "$host" "$url"
        done
    else
        grep -Eo "https?://[^\"' )]+" "$script_path" 2>/dev/null | sort -u | while IFS= read -r url; do
            case "$url" in *'$'*|*'{'*|*'}'*|*,direct*|http://127.0.0.1*|http://1.2.3.4*|http://IP*) continue ;; esac
            host="$(external_url_host "$url")"
            trust="$(external_resource_trust_level "$url")"
            printf "%-16s %-32s %s\n" "$trust" "$host" "$url"
        done
    fi
}

action_external_trust_inventory() {
    local script_path
    script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#              外部资源信任清单                #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${BOLD}当前策略:${PLAIN} $EXTERNAL_TRUST_MODE"
    printf '%b\n' "${YELLOW}strict:${PLAIN} 仅官方/信息服务通过；${YELLOW}standard:${PLAIN} 未知来源需危险确认；${YELLOW}permissive:${PLAIN} 仅提示。"
    printf '%b\n' ""
    list_external_resource_inventory
    printf '%b\n' "\n${BOLD}远程脚本执行入口:${PLAIN}"
    if command -v rg > /dev/null 2>&1; then
        rg -n "run_remote_script|download_remote_script|run_remote_script_as_user" "$script_path" 2>/dev/null || true
    else
        grep -En "run_remote_script|download_remote_script|run_remote_script_as_user" "$script_path" 2>/dev/null || true
    fi
}

action_configure_maintenance_window() {
    local schedule randomized_delay reboot_time auto_reboot
    log_info "配置自动更新维护窗口..."
    read -r -p "维护窗口 OnCalendar [默认 Sun *-*-* 04:10:00]: " schedule
    schedule="${schedule:-Sun *-*-* 04:10:00}"
    read -r -p "随机延迟 [默认 30m]: " randomized_delay
    randomized_delay="${randomized_delay:-30m}"
    read -r -p "自动重启时间 [默认 04:45]: " reboot_time
    reboot_time="${reboot_time:-04:45}"
    validate_systemd_calendar_value "$schedule" || { log_error "无效的 OnCalendar: $schedule"; return 1; }
    validate_systemd_duration_value "$randomized_delay" || { log_error "无效的随机延迟: $randomized_delay"; return 1; }
    [[ "$reboot_time" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || {
        log_error "无效的自动重启时间: $reboot_time"
        return 1
    }
    if confirm_action "安全更新后是否允许自动重启?" "n"; then
        auto_reboot="true"
    else
        auto_reboot="false"
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将配置 apt-daily-upgrade.timer: $schedule ($randomized_delay)"
        log_info "[DRY RUN] Automatic-Reboot=$auto_reboot Automatic-Reboot-Time=$reboot_time"
        log_info "[DRY RUN] 将创建 init-maintenance-check.timer，记录 apt 更新、重启提醒和 Docker 镜像线索"
        return 0
    fi

    update_apt_once
    install_packages_batch "unattended-upgrades" || return 1
    mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d
    write_file_atomic /etc/systemd/system/apt-daily-upgrade.timer.d/override.conf \
        "APT 安全更新 timer override" 644 0 0 <<EOF || return 1
[Timer]
OnCalendar=
OnCalendar=$schedule
RandomizedDelaySec=$randomized_delay
Persistent=true
EOF
    write_file_atomic /etc/apt/apt.conf.d/52unattended-maintenance-window \
        "unattended-upgrades 维护窗口" 644 0 0 <<EOF || return 1
Unattended-Upgrade::Automatic-Reboot "$auto_reboot";
Unattended-Upgrade::Automatic-Reboot-Time "$reboot_time";
EOF
    write_file_atomic /usr/local/sbin/init-maintenance-check \
        "维护检查 executable" 700 0 0 <<'EOF' || return 1
#!/bin/bash
set -euo pipefail

LOG_FILE="/var/log/init-maintenance-check.log"
{
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') maintenance check ====="
    echo "[apt upgradable]"
    apt list --upgradable 2>/dev/null || true
    echo
    echo "[reboot required]"
    if [ -f /var/run/reboot-required ]; then
        cat /var/run/reboot-required
        [ -f /var/run/reboot-required.pkgs ] && cat /var/run/reboot-required.pkgs
    else
        echo "no"
    fi
    echo
    echo "[autoremove / old kernel cleanup preview]"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get -s autoremove 2>/dev/null | sed -n '1,120p' || true
    else
        echo "apt-get: missing"
    fi
    echo
    echo "[docker images in use]"
    if command -v docker >/dev/null 2>&1; then
        docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || true
        echo
        echo "提示: Compose 项目建议在维护窗口内执行 docker compose pull && docker compose up -d。"
    else
        echo "docker: missing"
    fi
} >> "$LOG_FILE" 2>&1
EOF
    write_file_atomic /etc/systemd/system/init-maintenance-check.service \
        "维护检查 service" 644 0 0 validate_systemd_candidate <<'EOF' || return 1
[Unit]
Description=Init Script Maintenance Check
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/init-maintenance-check
EOF
    write_file_atomic /etc/systemd/system/init-maintenance-check.timer \
        "维护检查 timer" 644 0 0 validate_systemd_candidate <<EOF || return 1
[Unit]
Description=Run Init Script Maintenance Check

[Timer]
OnCalendar=$schedule
RandomizedDelaySec=$randomized_delay
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemd_daemon_reload || return 1
    run_command "启用 apt-daily-upgrade.timer" systemctl enable --now apt-daily-upgrade.timer || return 1
    run_command "启用 init-maintenance-check.timer" systemctl enable --now init-maintenance-check.timer || return 1
    log_success "自动更新维护窗口已配置"
    log_info "查看: systemctl list-timers apt-daily-upgrade.timer"
    log_info "维护检查日志: tail -n 100 /var/log/init-maintenance-check.log"
}

action_ops_enhancements() {
    local choice
    while true; do
        clear
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${CYAN}#              运维增强中心                    #${PLAIN}"
        printf '%b\n' "${CYAN}################################################${PLAIN}"
        printf '%b\n' "${GREEN}1.${PLAIN} Profile / Plan / Apply"
        printf '%b\n' "${GREEN}2.${PLAIN} 生成系统变更报告"
        printf '%b\n' "${GREEN}3.${PLAIN} 端口暴露扫描"
        printf '%b\n' "${GREEN}4.${PLAIN} SSH 配置审计"
        printf '%b\n' "${GREEN}5.${PLAIN} 外部资源信任清单"
        printf '%b\n' "${GREEN}6.${PLAIN} 自动更新维护窗口"
        printf '%b\n' "${GREEN}7.${PLAIN} Docker 安全基线"
        printf '%b\n' "${GREEN}8.${PLAIN} Docker 镜像更新检查"
        printf '%b\n' "${GREEN}9.${PLAIN} restic 恢复演练"
        printf '%b\n' "${GREEN}0.${PLAIN} 返回"
        printf '%b\n' ""
        read -r -p "请输入选择 [0-9]: " choice
        case "$choice" in
            1) run_menu_flow action_profile_plan_apply ;;
            2) run_menu_action generate_system_change_report ;;
            3) run_menu_action action_port_exposure_scan ;;
            4) run_menu_action action_ssh_config_audit ;;
            5) run_menu_action action_external_trust_inventory ;;
            6) run_menu_action action_configure_maintenance_window ;;
            7) run_menu_action action_docker_security_baseline ;;
            8) run_menu_action action_docker_image_update_check ;;
            9) run_menu_action run_restic_restore_drill ;;
            0) return ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 模块: 用户管理 ---
function action_user_manager() {
    log_info "用户管理..."
    read -r -p "请输入新用户名: " new_user
    if [ -z "$new_user" ]; then
        log_warning "用户名不能为空"
        return 1
    fi
    if id "$new_user" > /dev/null 2>&1; then
        log_warning "用户已存在: $new_user"
        return 1
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将创建用户 $new_user 并配置 sudo/SSH"
        return 0
    fi

    adduser --disabled-password --gecos "" "$new_user" || return 1

    read -r -p "是否为该用户设置 SSH 公钥? [y/n]: " add_key
    case "$add_key" in
        y|Y|yes|YES)
            read -r -p "请输入公钥内容: " pubkey
            if [ -n "$pubkey" ]; then
                install_authorized_key "$new_user" "/home/$new_user" "$pubkey" || return 1
                log_success "已验证并添加公钥"
            fi
            ;;
    esac

    if confirm_action "是否为该用户设置密码并授予 sudo 权限?" "n"; then
        if passwd "$new_user"; then
            usermod -aG sudo "$new_user" || return 1
            log_success "已为 $new_user 授予 sudo 权限"
        else
            log_error "密码设置失败，未授予 sudo 权限"
            return 1
        fi
    fi

    if confirm_action "是否禁用 root SSH 登录?" "n"; then
        local ssh_candidate
        ssh_candidate="$(mktemp /etc/ssh/.sshd_config.user-manager.XXXXXX)" || return 1
        cp /etc/ssh/sshd_config "$ssh_candidate" || return 1
        set_sshd_directive_in_file "$ssh_candidate" PermitRootLogin no || return 1
        atomic_install_file /etc/ssh/sshd_config "$ssh_candidate" \
            "禁用 root SSH 登录" preserve 0 0 validate_sshd_candidate || return 1
        if ! reload_ssh_service; then
            rollback_last_operation || true
            reload_ssh_service || true
            return 1
        fi
        log_success "已禁用 root SSH 登录"
    fi
}
# --- 模块: 清理痕迹/历史记录 (危险) ---
function action_clean_traces() {
    if ! confirm_dangerous_action "清理痕迹/历史记录" "将清空 shell 历史与部分系统日志，可能影响审计与排障"; then
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log_info "[DRY RUN] 将清理 history 和系统日志"
        return 0
    fi

    local files=(
        "$HOME/.bash_history"
        "$HOME/.zsh_history"
        "/root/.bash_history"
        "/root/.zsh_history"
        "/var/log/auth.log"
        "/var/log/syslog"
        "/var/log/kern.log"
        "/var/log/messages"
        "/var/log/wtmp"
        "/var/log/btmp"
        "/var/log/lastlog"
        "/var/log/apt/history.log"
        "/var/log/apt/term.log"
        "/var/log/dpkg.log"
    )

    for f in "${files[@]}"; do
        if [ -f "$f" ]; then
            : > "$f" 2>/dev/null || true
        fi
    done

    if command -v journalctl > /dev/null 2>&1; then
        journalctl --rotate > /dev/null 2>&1 || true
        journalctl --vacuum-time=1s > /dev/null 2>&1 || true
    fi

    log_success "清理完成（history 与部分日志已清空）"
}

# --- 任务流 ---
function task_init_no_mirror() {
    log_info "开始初始化流程（不换源）..."
    invoke_action action_install_essentials || return 1
    invoke_action action_optimize_system || return 1
    invoke_action action_configure_swap || return 1
    invoke_action action_configure_ssh || return 1
    invoke_action action_configure_firewall || return 1
    invoke_action action_configure_fail2ban || return 1
    invoke_action action_configure_auto_updates || return 1
    invoke_action cleanup || return 1
}

function task_init_with_mirror() {
    log_info "开始初始化流程（换源）..."
    invoke_action action_change_mirrors || return 1
    invoke_action action_install_essentials || return 1
    invoke_action action_optimize_system || return 1
    invoke_action action_configure_swap || return 1
    invoke_action action_configure_ssh || return 1
    invoke_action action_configure_firewall || return 1
    invoke_action action_configure_fail2ban || return 1
    invoke_action action_configure_auto_updates || return 1
    invoke_action cleanup || return 1
}

# --- 自定义初始化 (批量选择模块) ---
function task_custom_init() {
    clear
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#           自定义初始化 - 选择模块            #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}请选择要安装/配置的模块（可多选，用空格分隔，如: 1 3 5）${PLAIN}"
    printf '%b\n' ""
    
    # 定义模块列表
    declare -A modules
    modules[1]="换源 (更换为阿里云镜像源)"
    modules[2]="安装基础工具 (curl, wget, vim, git 等)"
    modules[3]="系统优化 (内核参数、limits、BBR 等)"
    modules[4]="Swap 配置 (交换空间)"
    modules[5]="SSH 安全配置 (端口、密钥、禁用密码)"
    modules[6]="防火墙配置 (UFW)"
    modules[7]="Fail2ban 配置 (防暴力破解)"
    modules[8]="自动安全更新 (unattended-upgrades)"
    modules[9]="Docker 安装 (Docker Engine + Compose)"
    modules[10]="Runtime 安装 (Node.js/Python/PHP/Java/Go/.NET)"
    modules[11]="备份工具 (restic/borgbackup)"
    modules[12]="监控/日志基础 (journald 持久化 + 健康检查)"
    modules[13]="安全审计工具 (Lynis/debsums)"
    
    # 显示模块列表
    for i in {1..13}; do
        local status=""
        printf '%b\n' "${GREEN}[$i]${PLAIN} ${modules[$i]}"
    done
    printf '%b\n' ""
    printf '%b\n' "${GREEN}[a]${PLAIN} 全选"
    printf '%b\n' "${GREEN}[0]${PLAIN} 返回主菜单"
    printf '%b\n' ""
    
    read -r -p "请输入选择 (例如: 1 3 5 或 a): " selections
    
    # 处理全选
    if [[ "$selections" == "a" || "$selections" == "A" ]]; then
        selections="1 2 3 4 5 6 7 8 9 10 11 12 13"
    fi
    
    # 验证输入
    if [[ -z "$selections" ]]; then
        log_warning "未选择任何模块，返回主菜单"
        return
    fi
    
    # 解析选择
    local selected_modules=()
    for sel in $selections; do
        if [[ "$sel" =~ ^([1-9]|1[0-3])$ ]]; then
            selected_modules+=("$sel")
        elif [[ "$sel" != "0" ]]; then
            log_warning "无效选择: ${sel}，已忽略"
        fi
    done
    
    if [ ${#selected_modules[@]} -eq 0 ]; then
        log_warning "没有有效的模块选择，返回主菜单"
        return
    fi
    
    # 显示确认
    clear
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#           确认选择的模块                      #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}已选择以下模块:${PLAIN}"
    for sel in "${selected_modules[@]}"; do
        printf '%b\n' "  ${GREEN}✓${PLAIN} ${modules[$sel]}"
    done
    printf '%b\n' ""
    read -r -p "确认执行? [y/n]: " confirm
    case "$confirm" in
        y|Y|yes|YES)
            ;;
        *)
            log_info "已取消，返回主菜单"
            return
            ;;
    esac
    
    # 执行选中的模块
    log_info "开始执行自定义初始化..."
    printf '%b\n' ""
    
    local has_mirror=false
    local has_essentials=false
    
    # 按顺序执行选中的模块
    for sel in "${selected_modules[@]}"; do
        case "$sel" in
            1)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_change_mirrors || return 1
                has_mirror=true
                printf '%b\n' ""
                ;;
            2)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                # 如果没换源，先更新一次
                if [ "$has_mirror" = false ]; then
                    update_apt_once || return 1
                fi
                invoke_action action_install_essentials || return 1
                has_essentials=true
                printf '%b\n' ""
                ;;
            3)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_optimize_system || return 1
                printf '%b\n' ""
                ;;
            4)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_configure_swap || return 1
                printf '%b\n' ""
                ;;
            5)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_configure_ssh || return 1
                printf '%b\n' ""
                ;;
            6)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_configure_firewall || return 1
                printf '%b\n' ""
                ;;
            7)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_configure_fail2ban || return 1
                printf '%b\n' ""
                ;;
            8)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_configure_auto_updates || return 1
                printf '%b\n' ""
                ;;
            9)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_install_docker || return 1
                printf '%b\n' ""
                ;;
            10)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action action_install_runtime || return 1
                printf '%b\n' ""
                ;;
            11)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action install_backup_tools || return 1
                printf '%b\n' ""
                ;;
            12)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action configure_journald_persistent || return 1
                invoke_action install_health_check_timer || return 1
                printf '%b\n' ""
                ;;
            13)
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                log_info "执行: ${modules[$sel]}"
                log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                invoke_action install_security_audit_tools || return 1
                printf '%b\n' ""
                ;;
        esac
    done
    
    # 询问是否清理
    printf '%b\n' ""
    read -r -p "是否执行清理 (移除无用包)? [y/n]: " do_cleanup
    case "$do_cleanup" in
        y|Y|yes|YES)
            invoke_action cleanup || return 1
            ;;
        *)
            log_info "跳过清理"
            ;;
    esac
    
    log_success "自定义初始化完成！"
    log_info "日志文件: $LOG_FILE"
    log_info "备份目录: $BACKUP_DIR"
    
    printf '%b\n' ""
    read -r -p "按 Enter 键返回主菜单..."
}

function cleanup() {
    log_info "清理系统..."
    apt-get autoremove -y >> "$LOG_FILE" 2>&1
    apt-get clean >> "$LOG_FILE" 2>&1
    log_success "所有任务完成！"
    log_info "日志文件: $LOG_FILE"
    log_info "备份目录: $BACKUP_DIR"
}

function action_install_croc() {
    log_info "正在安装 croc (文件传输工具)..."

    update_apt_once
    if run_cmd "尝试通过 apt 安装 croc" "apt-get install -y croc"; then
        log_success "croc 安装成功"
        log_info "使用方法: croc send [file]"
        return 0
    fi

    log_warning "apt 源中未能安装 croc，准备回退到官方安装脚本"
    if run_remote_script_unverified "https://getcroc.schollz.com" "croc 官方安装脚本"; then
        log_success "croc 安装成功"
        log_info "使用方法: croc send [file]"
    else
        log_error "croc 安装失败"
        return 1
    fi
}

function action_install_rclone() {
    log_info "正在安装 rclone (预编译二进制)..."

    if command -v rclone > /dev/null 2>&1; then
        local rclone_ver
        rclone_ver=$(rclone --version 2>/dev/null | head -n 1)
        log_info "检测到已安装 rclone: $rclone_ver"
        if ! confirm_action "是否重新安装 rclone?" "n"; then
            return 0
        fi
    fi

    local arch
    arch=$(uname -m)
    if [ "$arch" != "x86_64" ] && [ "$arch" != "amd64" ]; then
        log_warning "当前架构为 ${arch}，默认下载 amd64 版本可能无法运行"
        if ! confirm_action "仍然继续下载 amd64 版本?" "n"; then
            return 1
        fi
    fi

    update_apt_once
    run_cmd "安装依赖" "apt-get install -y unzip curl"

    local base_url="https://downloads.rclone.org"
    local version_file="/tmp/rclone-version.txt"
    local checksums_path="/tmp/rclone-SHA256SUMS"
    local temp_dir="/tmp/rclone-install.$$"

    if ! confirm_external_resource "$base_url" "下载 rclone 版本信息、预编译包和 SHA256 校验文件"; then
        log_warning "已跳过 rclone 下载"
        return 1
    fi

    if ! fetch_file "$base_url/version.txt" "$version_file" "rclone 版本信息"; then
        log_error "无法获取 rclone 最新版本信息"
        return 1
    fi

    local rclone_version
    rclone_version=$(awk '{print $NF}' "$version_file" | head -1)
    if [[ ! "$rclone_version" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
        log_error "无法解析 rclone 版本: $rclone_version"
        return 1
    fi

    local zip_name="rclone-${rclone_version}-linux-amd64.zip"
    local zip_path="/tmp/${zip_name}"
    local url="${base_url}/${rclone_version}/${zip_name}"
    local checksums_url="${base_url}/${rclone_version}/SHA256SUMS"

    if ! fetch_file "$url" "$zip_path" "rclone ${rclone_version} 预编译包"; then
        log_warning "已跳过 rclone 下载"
        return 1
    fi
    if ! fetch_file "$checksums_url" "$checksums_path" "rclone ${rclone_version} SHA256SUMS"; then
        log_error "无法下载 rclone 校验文件"
        return 1
    fi

    if [ "$DRY_RUN" != "1" ]; then
        local expected_sha
        local actual_sha
        expected_sha=$(awk -v file="$zip_name" '$2 == file {print $1}' "$checksums_path")
        actual_sha=$(sha256sum "$zip_path" | awk '{print $1}')
        if [ -z "$expected_sha" ] || [ "$expected_sha" != "$actual_sha" ]; then
            log_error "rclone SHA256 校验失败"
            log_error "期望: ${expected_sha:-N/A}"
            log_error "实际: $actual_sha"
            return 1
        fi
        log_success "rclone SHA256 校验通过: $actual_sha"
    fi

    register_temp_file "$temp_dir"
    run_cmd "创建临时目录" "mkdir -p \"$temp_dir\""
    run_cmd "解压 rclone" "unzip -o \"$zip_path\" -d \"$temp_dir\""

    local rclone_dir
    rclone_dir=$(find "$temp_dir" -maxdepth 1 -type d -name "rclone-*-linux-amd64" | head -1)
    if [ -z "$rclone_dir" ]; then
        log_error "无法找到解压目录 (rclone-*-linux-amd64)"
        return 1
    fi

    run_cmd "安装 rclone 二进制" "cp \"$rclone_dir/rclone\" /usr/bin/"
    run_cmd "设置 rclone 权限" "chown root:root /usr/bin/rclone && chmod 755 /usr/bin/rclone"

    run_cmd "创建 manpage 目录" "mkdir -p /usr/local/share/man/man1"
    run_cmd "安装 rclone manpage" "cp \"$rclone_dir/rclone.1\" /usr/local/share/man/man1/"
    if command -v mandb > /dev/null 2>&1; then
        run_cmd "更新 man 索引" "mandb"
    else
        log_warning "mandb 未安装，已跳过 man 索引更新"
    fi

    log_success "rclone 安装完成"
    log_info "下一步: 运行 rclone config 进行配置"
}


function action_install_terminal_tools() {
    log_info "开始初始化终极终端环境..."
    determine_target_user
    local user_home="$INSTALL_HOME"
    if [ -z "$user_home" ]; then
        user_home="$HOME"
    fi
    log_info "用户级配置目标: $INSTALL_USER ($user_home)"
    
    # Update & Install deps
    log_info "更新系统并安装基础依赖..."
    update_apt_once
    run_cmd "安装基础依赖" "apt-get install -y git curl wget unzip tar build-essential zsh tmux ripgrep fd-find \
        p7zip-full p7zip-rar unrar xz-utils bzip2 zstd lz4 pigz \
        fzf jq yq btop ncdu duf git-delta"
    if ! run_cmd "安装 tldr" "apt-get install -y tldr"; then
        log_warning "tldr 安装失败，尝试安装 tealdeer 作为替代..."
        run_cmd "安装 tealdeer" "apt-get install -y tealdeer"
    fi
    
    # Eza
    log_info "安装 Eza (现代版 ls)..."
    mkdir -p /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/gierens.gpg ]; then
        local eza_key_url="https://raw.githubusercontent.com/eza-community/eza/main/deb.asc"
        local eza_key_tmp="/tmp/eza-deb.asc"
        if download_file "$eza_key_url" "$eza_key_tmp" "eza 仓库密钥"; then
            run_cmd "导入 eza GPG 密钥" "gpg --dearmor -o /etc/apt/keyrings/gierens.gpg --yes \"$eza_key_tmp\""
            run_cmd "写入 eza 源" "echo \"deb [signed-by=/etc/apt/keyrings/gierens.gpg] http://deb.gierens.de stable main\" | tee /etc/apt/sources.list.d/gierens.list"
            run_cmd "更新 eza 源权限" "chmod 644 /etc/apt/keyrings/gierens.gpg /etc/apt/sources.list.d/gierens.list"
            run_cmd "更新软件包列表" "apt-get update"
        else
            log_warning "已跳过 eza 仓库配置"
        fi
    fi
    run_cmd "安装 eza" "apt-get install -y eza"
    
    # Bat
    log_info "安装 Bat (现代版 cat)..."
    run_cmd "安装 bat" "apt-get install -y bat"
    run_as_user "mkdir -p \"$user_home/.local/bin\""
    run_as_user "ln -sf /usr/bin/batcat \"$user_home/.local/bin/bat\""
    
    # Zoxide
    log_info "安装 Zoxide (智能 cd)..."
    if command -v zoxide > /dev/null 2>&1; then
        log_info "zoxide 已安装"
    elif run_cmd "尝试通过 apt 安装 zoxide" "apt-get install -y zoxide"; then
        log_success "zoxide 安装成功"
    else
        log_warning "apt 源中未能安装 zoxide，准备回退到官方安装脚本"
        run_remote_script_as_user_unverified "https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh" "zoxide 官方安装脚本" || log_warning "已跳过 zoxide 安装"
    fi
    
    # Starship
    log_info "安装 Starship (终端提示符)..."
    if command -v starship > /dev/null 2>&1; then
        log_info "starship 已安装"
    elif run_cmd "尝试通过 apt 安装 starship" "apt-get install -y starship"; then
        log_success "starship 安装成功"
    else
        log_warning "apt 源中未能安装 starship，准备回退到官方安装脚本"
        run_remote_script_as_user_unverified "https://starship.rs/install.sh" "starship 官方安装脚本" "-y" || log_warning "已跳过 starship 安装"
    fi
    
    # Neovim
    log_info "安装最新版 Neovim..."
    local nvim_version="v0.10.4"
    local nvim_tar="/tmp/nvim-linux-x86_64-${nvim_version}.tar.gz"
    local nvim_url="https://github.com/neovim/neovim/releases/download/${nvim_version}/nvim-linux-x86_64.tar.gz"
    local nvim_sha256="95aaa8e89473f5421114f2787c13ae0ec6e11ebbd1a13a1bd6fcf63420f8073f"
    if download_and_verify_sha256 "$nvim_url" "$nvim_sha256" "$nvim_tar" "Neovim ${nvim_version}"; then
        if [ "$DRY_RUN" = "1" ]; then
            log_info "[DRY RUN] 解压并安装 Neovim"
            return 0
        fi
        local nvim_stage nvim_source
        nvim_stage="$(mktemp -d /tmp/init-neovim.XXXXXX)" || return 1
        register_temp_file "$nvim_stage"
        tar -C "$nvim_stage" -xzf "$nvim_tar" || return 1
        if [ -x "$nvim_stage/nvim-linux-x86_64/bin/nvim" ]; then
            nvim_source="$nvim_stage/nvim-linux-x86_64"
        elif [ -x "$nvim_stage/nvim-linux64/bin/nvim" ]; then
            nvim_source="$nvim_stage/nvim-linux64"
        else
            log_error "Neovim 归档结构无效"
            return 1
        fi
        replace_directory_transactional /opt/nvim "$nvim_source" "Neovim ${nvim_version}" || return 1
        
        # Link
        ln -sf /opt/nvim/bin/nvim /usr/local/bin/nvim
        rm -f -- "$nvim_tar"
        log_success "Neovim 安装成功"
    else
        log_warning "已跳过 Neovim 安装"
    fi
    
    # uv
    log_info "安装 uv (Python 包管理器)..."
    run_remote_script_as_user_unverified "https://astral.sh/uv/install.sh" "uv 官方安装脚本" || log_warning "已跳过 uv 安装"
    
    # Oh My Zsh
    log_info "安装 Oh My Zsh..."
    if [ -d "$user_home/.oh-my-zsh" ]; then
        log_info "Oh My Zsh 已存在，跳过安装。"
    else
        run_remote_script_as_user_unverified "https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh" "Oh My Zsh 官方安装脚本" "--unattended" || log_warning "已跳过 Oh My Zsh 安装"
    fi
    
    # Plugins
    log_info "下载 Zsh 插件..."
    local zsh_custom="${ZSH_CUSTOM:-$user_home/.oh-my-zsh/custom}"
    run_as_user "mkdir -p \"$zsh_custom/plugins\""
    if [ ! -d "$zsh_custom/plugins/zsh-autosuggestions" ]; then
        run_as_user "git clone https://github.com/zsh-users/zsh-autosuggestions \"$zsh_custom/plugins/zsh-autosuggestions\""
    fi
    if [ ! -d "$zsh_custom/plugins/zsh-syntax-highlighting" ]; then
        run_as_user "git clone https://github.com/zsh-users/zsh-syntax-highlighting.git \"$zsh_custom/plugins/zsh-syntax-highlighting\""
    fi
    
    # .zshrc
    log_info "生成配置文件 .zshrc ..."
    local zshrc_file="$user_home/.zshrc"
    local zsh_marker_start="### INIT.SH ZSHRC BEGIN"
    local zsh_marker_end="### INIT.SH ZSHRC END"
    local zshrc_block
    zshrc_block=$(cat << 'EOF'
# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# 主题设置为 vercel (或者你可以留空，因为我们会用 starship)
ZSH_THEME=""

# 启用插件
plugins=(
    git
    extract
    zsh-autosuggestions
    zsh-syntax-highlighting
)

source $ZSH/oh-my-zsh.sh

# User configuration
export PATH=$HOME/.local/bin:$PATH
export EDITOR='nvim'

# 初始化 Starship (提示符)
eval "$(starship init zsh)"

# 初始化 Zoxide (智能跳转)
eval "$(zoxide init zsh)"

# 常用别名 (Aliases)
alias vim="nvim"
alias ls="eza --icons"
alias ll="eza --icons -l"
alias la="eza --icons -la"
alias tree="eza --icons --tree"
alias cat="bat"
alias ip="ip -c"

# UV 补全
eval "$(uv generate-shell-completion zsh)"
EOF
)
    if [ -f "$zshrc_file" ]; then
        create_backup "$zshrc_file" >/dev/null
    fi
    ensure_block_in_file "$zshrc_file" "$zsh_marker_start" "$zsh_marker_end" "$zshrc_block"

    # --- Compatibility Migration (Auto-detect & Sync) ---
    log_info "正在迁移现有配置到 .zshrc ..."
    
    # 1. MOTD Migration
    # If cool-motd is executable, ensure it runs in zshrc
    if [ -x "/usr/local/bin/cool-motd.sh" ]; then
        if ! grep -q "cool-motd.sh" "$zshrc_file"; then
             echo "" >> "$zshrc_file"
             echo "# MOTD" >> "$zshrc_file"
             echo "/usr/local/bin/cool-motd.sh" >> "$zshrc_file"
             log_info "已迁移 MOTD 配置到 .zshrc"
        fi
    fi

    # 2. Go Environment Migration
    # consistently checks if Go is installed in standard location
    if [ -d "/usr/local/go/bin" ]; then
        if ! grep -q "GOROOT=" "$zshrc_file"; then
            cat >> "$zshrc_file" << 'GO_EOF'

# Go configuration
export GOROOT=/usr/local/go
export PATH=$GOROOT/bin:$PATH
GO_EOF
            log_info "已迁移 Go 环境变量到 .zshrc"
        fi
    fi

    # 3. NVM Migration
    # If NVM dir exists, verify it is sourced
    if [ -d "$user_home/.nvm" ]; then
         if ! grep -q "NVM_DIR" "$zshrc_file"; then
            cat >> "$zshrc_file" << 'NVM_EOF'

# NVM configuration
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
NVM_EOF
            log_info "已迁移 NVM 配置到 .zshrc"
         fi
    fi

    # Change Shell
    if [ "$INSTALL_USER" != "root" ]; then
        chown "$INSTALL_USER:$INSTALL_USER" "$zshrc_file" 2>/dev/null || true
    fi

    log_info "切换默认 Shell 到 Zsh..."
    if command -v zsh > /dev/null 2>&1; then
        chsh -s "$(command -v zsh)" "$INSTALL_USER"
    else
        log_error "未找到 zsh 可执行文件，无法切换默认 Shell"
    fi
    
    log_success "终端环境初始化完成！请断开 SSH 并重新连接以应用更改。"
}

function action_toggle_zsh_icons() {
    if [ "$EUID" -eq 0 ]; then
        determine_target_user
    else
        INSTALL_USER="${INSTALL_USER:-$USER}"
        INSTALL_HOME="${INSTALL_HOME:-$HOME}"
    fi

    local zshrc_file="$INSTALL_HOME/.zshrc"
    if [ ! -f "$zshrc_file" ]; then
        log_error "未找到 ${zshrc_file}，请先执行选项 17 初始化终端环境。"
        return
    fi
    
    run_zsh_cmd() {
        local cmd="$1"
        if [ "$EUID" -eq 0 ] && [ "$INSTALL_USER" != "root" ]; then
            sudo -H -u "$INSTALL_USER" env HOME="$INSTALL_HOME" USER="$INSTALL_USER" LOGNAME="$INSTALL_USER" bash -c "$cmd"
        else
            bash -c "$cmd"
        fi
    }

    log_info "正在切换 Zsh 图标显示设置..."
    
    # Check if icons are enabled (look for --icons)
    if run_zsh_cmd "grep -q \"alias ls=\\\"eza --icons\\\"\" \"$zshrc_file\""; then
        run_zsh_cmd "sed -i 's/alias ls=\"eza --icons\"/alias ls=\"eza\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias ll=\"eza --icons -l\"/alias ll=\"eza -l\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias la=\"eza --icons -la\"/alias la=\"eza -la\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias tree=\"eza --icons --tree\"/alias tree=\"eza --tree\"/g' \"$zshrc_file\""
        log_success "已禁用图标 (兼容模式)。乱码问题应已解决。"
    elif run_zsh_cmd "grep -q \"alias ls=\\\"eza\\\"\" \"$zshrc_file\""; then
        run_zsh_cmd "sed -i 's/alias ls=\"eza\"/alias ls=\"eza --icons\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias ll=\"eza -l\"/alias ll=\"eza --icons -l\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias la=\"eza -la\"/alias la=\"eza --icons -la\"/g' \"$zshrc_file\""
        run_zsh_cmd "sed -i 's/alias tree=\"eza --tree\"/alias tree=\"eza --icons --tree\"/g' \"$zshrc_file\""
        log_success "已启用图标 (丰富模式)。请确保终端支持 Nerd Fonts。"
    else
        log_warning "无法自动匹配别名配置，请手动检查 .zshrc。"
        return
    fi
    
    log_info "请断开 SSH 并重新连接，或运行 'source $zshrc_file' 以生效。"
}

function action_install_network_http_tools() {
    log_info "安装网络/HTTP 工具集..."
    update_apt_once
    install_packages_batch \
        "mtr-tiny" "traceroute" "dnsutils" "iproute2" "iputils-ping" \
        "netcat-openbsd" "socat" "iperf3" "nmap" "tcpdump" "iftop" "nethogs"

    if ! apt-get install -y httpie >> "$LOG_FILE" 2>&1; then
        log_warning "httpie 安装失败，尝试安装 xh..."
        apt-get install -y xh >> "$LOG_FILE" 2>&1 || log_warning "xh 安装失败"
    fi
    if ! apt-get install -y dog >> "$LOG_FILE" 2>&1; then
        log_warning "dog 安装失败（某些发行版包名不同），已跳过"
    fi

    log_success "网络/HTTP 工具集安装完成"
}


# --- 菜单 ---

menu_header() {
    local title="$1"
    local subtitle="${2:-}"
    clear
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${CYAN}#  Linux 运维一键脚本 v8.5                    #${PLAIN}"
    printf '%b\n' "${CYAN}################################################${PLAIN}"
    printf '%b\n' "${BOLD}${title}${PLAIN}"
    if [ -n "$subtitle" ]; then
        printf '%b\n' "${YELLOW}${subtitle}${PLAIN}"
    fi
    printf '%b\n' ""
}

menu_pause() {
    local _
    printf '%b\n' ""
    read -r -p "按 Enter 键继续..." _
}

menu_invalid_choice() {
    printf '%b\n' "${RED}输入错误${PLAIN}"
    sleep 1
}

dry_run_action_plan() {
    local action="${1:-unknown}"
    case "$action" in
        action_install_essentials) log_info "[DRY RUN] 计划: 安装基础工具、设置时区与时间同步" ;;
        action_configure_ssh) log_info "[DRY RUN] 计划: 选择并验证 SSH 密钥账户，生成并校验 SSH 候选配置，必要时放行新端口后 reload" ;;
        action_configure_firewall) log_info "[DRY RUN] 计划: 保留现有 UFW 规则，补充 SSH/可选 Web 规则并启用" ;;
        action_configure_fail2ban) log_info "[DRY RUN] 计划: 写入 Fail2ban SSH jail 并启用服务" ;;
        action_configure_auto_updates) log_info "[DRY RUN] 计划: 原子写入 unattended-upgrades 配置" ;;
        action_configure_swap) log_info "[DRY RUN] 计划: 配置 swapfile、fstab 与 swappiness" ;;
        action_install_docker) log_info "[DRY RUN] 计划: 配置 Docker 官方仓库、安装并启动 Docker" ;;
        task_init_no_mirror|task_init_with_mirror|task_custom_init) log_info "[DRY RUN] 计划: 初始化组合动作；未执行任何子模块" ;;
        *) log_info "[DRY RUN] 计划调用动作: ${action}（已阻止实际执行）" ;;
    esac
}

handle_action_failure() {
    local action="$1" status="$2" operation_start="$3"
    local operation_total mode
    operation_total="${#OPERATION_TARGETS[@]}"

    if [ "$operation_total" -le "$operation_start" ]; then
        log_warning "动作失败或被取消: $action (status=$status)；没有新增的可回滚文件变更"
        return 0
    fi
    if [ "$ROLLBACK_ENABLED" != "true" ]; then
        log_warning "动作失败: $action；文件回滚已禁用，变更保留在回滚账本中"
        return 0
    fi

    mode="$ACTION_ROLLBACK_MODE"
    if [ "$mode" = "auto" ]; then
        if [ "$NON_INTERACTIVE" = "1" ]; then
            mode="always"
        else
            mode="prompt"
        fi
    elif [ "$mode" = "prompt" ] && [ "$NON_INTERACTIVE" = "1" ]; then
        log_warning "非交互模式无法提示，ACTION_ROLLBACK_MODE=prompt 按 always 处理"
        mode="always"
    fi

    case "$mode" in
        always)
            log_warning "动作失败，自动回滚该动作新增的文件变更: $action"
            rollback_operations_from "$operation_start" || \
                log_error "动作 $action 的部分文件变更回滚失败；失败项仍保留在账本中"
            ;;
        prompt)
            if confirm_action "动作 $action 失败，是否回滚该动作新增的文件变更?" "y"; then
                rollback_operations_from "$operation_start" || \
                    log_error "动作 $action 的部分文件变更回滚失败；失败项仍保留在账本中"
            else
                log_warning "已保留动作 $action 的文件变更，可稍后从回滚菜单处理"
            fi
            ;;
        never)
            log_warning "ACTION_ROLLBACK_MODE=never：已保留动作 $action 的文件变更"
            ;;
    esac
}

invoke_action() {
    local action="${1:-}" status=0 operation_start had_errexit=false
    [ -n "$action" ] || return 1
    if [ "$DRY_RUN" = "1" ]; then
        dry_run_action_plan "$action"
        return 0
    fi

    operation_start="${#OPERATION_TARGETS[@]}"
    case "$-" in *e*) had_errexit=true; set +e ;; esac
    "$@"
    status=$?
    if [ "$status" -ne 0 ]; then
        handle_action_failure "$action" "$status" "$operation_start"
    fi
    [ "$had_errexit" = true ] && set -e
    return "$status"
}

invoke_root_action() {
    if [ "$DRY_RUN" = "1" ]; then
        dry_run_action_plan "${1:-unknown}"
        return 0
    fi
    check_root
    invoke_action "$@"
}

run_menu_action() {
    local status=0
    invoke_action "$@" || status=$?
    if [ "$status" -ne 0 ]; then
        log_warning "操作返回状态: $status"
    fi
    menu_pause
    # 菜单层已经展示失败；不要让 set -e 因菜单动作失败而退出整个脚本。
    return 0
}

run_menu_flow() {
    local status=0
    invoke_action "$@" || status=$?
    if [ "$status" -ne 0 ]; then
        log_warning "操作返回状态: $status"
    fi
    return 0
}

show_recommended_modules() {
    menu_header "推荐模块组合" "按服务器用途选择，避免一上来全装。"
    printf '%b\n' "${GREEN}新 VPS 基线:${PLAIN}"
    printf '%b\n' "  1) 基础工具"
    printf '%b\n' "  2) SSH 安全配置"
    printf '%b\n' "  3) UFW 防火墙 + Fail2ban"
    printf '%b\n' "  4) 自动安全更新"
    printf '%b\n' "  5) Swap + 系统资源检查"
    printf '%b\n' "  6) 可导出的 minimal Profile"
    printf '%b\n' ""
    printf '%b\n' "${GREEN}Docker / 应用主机:${PLAIN}"
    printf '%b\n' "  Docker 官方 apt 安装、Docker 管理器、应用市场、证书/反代、Compose 项目备份、Docker 安全基线、镜像更新检查、服务健康检查"
    printf '%b\n' ""
    printf '%b\n' "${GREEN}开发机:${PLAIN}"
    printf '%b\n' "  Runtime 管理器、终端环境、网络/HTTP 工具集"
    printf '%b\n' ""
    printf '%b\n' "${GREEN}存储 / 媒体机:${PLAIN}"
    printf '%b\n' "  备份/恢复、rclone、CloudDrive2、磁盘工具、共享挂载辅助"
    printf '%b\n' ""
    printf '%b\n' "${GREEN}运维基线增强:${PLAIN}"
    printf '%b\n' "  Profile/Plan/Apply、系统变更报告、端口暴露扫描、SSH 审计、外部资源信任清单、维护窗口、过期内核清理预览、备份恢复演练"
    printf '%b\n' ""
    printf '%b\n' "${YELLOW}谨慎使用:${PLAIN}"
    printf '%b\n' "  DD 重装、清理痕迹、第三方面板安装脚本、服务器测评脚本"
    printf '%b\n' ""
    printf '%b\n' "${CYAN}建议:${PLAIN} 先走“快速开始 -> 自定义初始化”，再按用途进入对应功能分区补模块。"
    menu_pause
}

show_quick_start_menu() {
    local choice
    while true; do
        menu_header "快速开始" "选择初始化工作流；单项配置请进入对应功能分区。"
        printf '%b\n' "${GREEN}1.${PLAIN} 标准初始化（不换源）"
        printf '%b\n' "${GREEN}2.${PLAIN} 国内镜像初始化（阿里源）"
        printf '%b\n' "${GREEN}3.${PLAIN} 自定义初始化（批量选择模块）${CYAN} [推荐]${PLAIN}"
        printf '%b\n' "${GREEN}4.${PLAIN} Profile / Plan / Apply"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action task_init_no_mirror ;;
            2) run_menu_action task_init_with_mirror ;;
            3) run_menu_flow task_custom_init ;;
            4) run_menu_flow action_profile_plan_apply ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_security_menu() {
    local choice
    while true; do
        menu_header "安全与访问" "账号、SSH、防火墙、防暴力破解集中在这里。"
        printf '%b\n' "${GREEN}1.${PLAIN} SSH 安全配置（端口 / 选择密钥账户 / 禁用密码）"
        printf '%b\n' "${GREEN}2.${PLAIN} 用户管理（新建用户 / SSH / sudo / 禁用 root）"
        printf '%b\n' "${GREEN}3.${PLAIN} UFW 防火墙"
        printf '%b\n' "${GREEN}4.${PLAIN} Fail2ban"
        printf '%b\n' "${GREEN}5.${PLAIN} 自动安全更新"
        printf '%b\n' "${GREEN}6.${PLAIN} 安全审计 (Lynis/debsums)"
        printf '%b\n' "${GREEN}7.${PLAIN} SSH 配置审计"
        printf '%b\n' "${GREEN}8.${PLAIN} 端口暴露扫描"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action action_configure_ssh ;;
            2) run_menu_action action_user_manager ;;
            3) run_menu_action action_configure_firewall ;;
            4) run_menu_action action_configure_fail2ban ;;
            5) run_menu_action action_configure_auto_updates ;;
            6) run_menu_flow action_security_audit ;;
            7) run_menu_action action_ssh_config_audit ;;
            8) run_menu_action action_port_exposure_scan ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_system_menu() {
    local choice
    while true; do
        menu_header "系统与维护" "基础软件、系统参数、Swap、更新、清理和回滚。"
        printf '%b\n' "${GREEN}1.${PLAIN} 安装基础工具"
        printf '%b\n' "${GREEN}2.${PLAIN} 系统优化"
        printf '%b\n' "${GREEN}3.${PLAIN} Swap 配置"
        printf '%b\n' "${GREEN}4.${PLAIN} 性能优化预设（sysctl）"
        printf '%b\n' "${GREEN}5.${PLAIN} 自动更新维护窗口"
        printf '%b\n' "${GREEN}6.${PLAIN} 清理无用包"
        printf '%b\n' "${GREEN}7.${PLAIN} 回滚已备份配置"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action action_install_essentials ;;
            2) run_menu_action action_optimize_system ;;
            3) run_menu_action action_configure_swap ;;
            4) run_menu_action action_sysctl_presets ;;
            5) run_menu_action action_configure_maintenance_window ;;
            6) run_menu_action cleanup ;;
            7) run_menu_action rollback ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_docker_app_menu() {
    local choice
    while true; do
        menu_header "Docker 与应用" "容器运行环境、应用市场、面板、反向代理与备份。"
        printf '%b\n' "${GREEN}1.${PLAIN} 安装 Docker Engine + Compose（官方 apt 仓库）"
        printf '%b\n' "${GREEN}2.${PLAIN} Docker 管理器"
        printf '%b\n' "${GREEN}3.${PLAIN} 应用市场（1Panel / aaPanel / NPM / Portainer）"
        printf '%b\n' "${GREEN}4.${PLAIN} 证书 / 反向代理"
        printf '%b\n' "${GREEN}5.${PLAIN} Docker Compose 项目备份"
        printf '%b\n' "${GREEN}6.${PLAIN} Docker 安全基线"
        printf '%b\n' "${GREEN}7.${PLAIN} Docker 镜像更新检查"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action action_install_docker ;;
            2) run_menu_flow submenu_docker_manager ;;
            3) run_menu_flow submenu_app_market ;;
            4) run_menu_flow action_reverse_proxy_cert ;;
            5) run_menu_flow action_docker_compose_backup ;;
            6) run_menu_action action_docker_security_baseline ;;
            7) run_menu_action action_docker_image_update_check ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_dev_menu() {
    local choice
    while true; do
        menu_header "开发与终端" "语言运行时、Shell 环境和常用开发工具。"
        printf '%b\n' "${GREEN}1.${PLAIN} Runtime 安装管理器（Node/Python/PHP/Java/Go/.NET）"
        printf '%b\n' "${GREEN}2.${PLAIN} 终端环境（Zsh / Starship / Neovim / Eza）"
        printf '%b\n' "${GREEN}3.${PLAIN} 切换 Zsh 图标显示"
        printf '%b\n' "${GREEN}4.${PLAIN} 网络/HTTP 工具集"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_flow action_install_runtime ;;
            2) run_menu_action action_install_terminal_tools ;;
            3) run_menu_action action_toggle_zsh_icons ;;
            4) run_menu_action action_install_network_http_tools ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_diagnostics_menu() {
    local choice
    while true; do
        menu_header "诊断与测试" "先诊断本机，再运行外部测评脚本。"
        printf '%b\n' "${GREEN}1.${PLAIN} 系统资源检查"
        printf '%b\n' "${GREEN}2.${PLAIN} 网络连接检查"
        printf '%b\n' "${GREEN}3.${PLAIN} 服务健康检查"
        printf '%b\n' "${GREEN}4.${PLAIN} 监控 / 告警基础"
        printf '%b\n' "${GREEN}5.${PLAIN} 服务器测评脚本（远程脚本需二次确认）"
        printf '%b\n' "${GREEN}6.${PLAIN} 模块状态总览"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action check_system_resources ;;
            2) run_menu_action check_network ;;
            3) run_menu_action action_service_health ;;
            4) run_menu_flow action_monitoring_alerts ;;
            5) run_menu_flow action_run_test_scripts ;;
            6) action_module_status_overview ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_storage_menu() {
    local choice
    while true; do
        menu_header "存储与备份" "磁盘、云盘、备份恢复、文件传输和同步工具。"
        printf '%b\n' "${GREEN}1.${PLAIN} 磁盘工具（挂载 / SMART / Trim）"
        printf '%b\n' "${GREEN}2.${PLAIN} CloudDrive2 安装向导"
        printf '%b\n' "${GREEN}3.${PLAIN} CloudDrive2 共享挂载辅助"
        printf '%b\n' "${GREEN}4.${PLAIN} 备份 / 恢复 (restic/borg)"
        printf '%b\n' "${GREEN}5.${PLAIN} rclone"
        printf '%b\n' "${GREEN}6.${PLAIN} croc 文件传输"
        printf '%b\n' "${GREEN}7.${PLAIN} restic 恢复演练"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action action_disk_tools ;;
            2) run_menu_flow action_setup_cd2 ;;
            3) run_menu_action action_cd2_mount_helper ;;
            4) run_menu_flow action_backup_restore ;;
            5) run_menu_action action_install_rclone ;;
            6) run_menu_action action_install_croc ;;
            7) run_menu_action run_restic_restore_drill ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_script_ops_menu() {
    local choice
    while true; do
        menu_header "脚本与运维" "脚本质量、信任边界、变更记录和日常运维入口。"
        printf '%b\n' "${GREEN}1.${PLAIN} 脚本自检 / ShellCheck"
        printf '%b\n' "${GREEN}2.${PLAIN} 外部资源信任清单"
        printf '%b\n' "${GREEN}3.${PLAIN} 生成系统变更报告"
        printf '%b\n' "${GREEN}4.${PLAIN} 运维增强中心"
        printf '%b\n' "${GREEN}5.${PLAIN} 推荐模块说明"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_flow action_script_quality ;;
            2) run_menu_action action_external_trust_inventory ;;
            3) run_menu_action generate_system_change_report ;;
            4) run_menu_flow action_ops_enhancements ;;
            5) show_recommended_modules ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_advanced_menu() {
    local choice
    while true; do
        menu_header "高级 / 高风险" "这里的操作可能破坏系统、清空日志或执行第三方脚本。"
        printf '%b\n' "${RED}1.${PLAIN} DD 重装系统"
        printf '%b\n' "${RED}2.${PLAIN} 清理痕迹 / 历史记录"
        printf '%b\n' "${GREEN}3.${PLAIN} 系统工具箱（含危险操作）"
        printf '%b\n' "${GREEN}b.${PLAIN} 返回主菜单"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) run_menu_action action_dd_reinstall ;;
            2) run_menu_action action_clean_traces ;;
            3) run_menu_flow action_toolbox ;;
            b|B) return ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

show_menu() {
    local choice
    while true; do
        menu_header "主菜单" "按用途进入九个功能分区。"
        printf '%b\n' "${GREEN}1.${PLAIN} 快速开始 ${CYAN}[新机器先看这里]${PLAIN}"
        printf '%b\n' "${GREEN}2.${PLAIN} 安全与访问"
        printf '%b\n' "${GREEN}3.${PLAIN} 系统与维护"
        printf '%b\n' "${GREEN}4.${PLAIN} Docker 与应用"
        printf '%b\n' "${GREEN}5.${PLAIN} 开发与终端"
        printf '%b\n' "${GREEN}6.${PLAIN} 存储与备份"
        printf '%b\n' "${GREEN}7.${PLAIN} 诊断与测试"
        printf '%b\n' "${GREEN}8.${PLAIN} 脚本与运维"
        printf '%b\n' "${RED}9.${PLAIN} 高级 / 高风险"
        printf '%b\n' "${GREEN}0.${PLAIN} 退出"
        printf '%b\n' ""
        read -r -p "请选择: " choice
        case "$choice" in
            1) show_quick_start_menu ;;
            2) show_security_menu ;;
            3) show_system_menu ;;
            4) show_docker_app_menu ;;
            5) show_dev_menu ;;
            6) show_storage_menu ;;
            7) show_diagnostics_menu ;;
            8) show_script_ops_menu ;;
            9) show_advanced_menu ;;
            0) exit 0 ;;
            *) menu_invalid_choice ;;
        esac
    done
}

# --- 退出与信号处理 ---
handle_exit() {
    local exit_code=$?
    trap - EXIT
    set +e
    recover_pending_directory_transactions || true
    cleanup_temp_files
    return "$exit_code"
}

handle_signal() {
    local signal_name="$1" exit_code=143
    [ "$signal_name" = "INT" ] && exit_code=130
    trap - INT TERM EXIT
    set +e
    log_warning "收到 ${signal_name}，正在终止活动子进程并清理临时文件"
    if [ -n "$ACTIVE_CHILD_PID" ] && kill -0 "$ACTIVE_CHILD_PID" 2>/dev/null; then
        if [ "$ACTIVE_CHILD_IS_GROUP" = true ]; then
            kill -TERM -- "-$ACTIVE_CHILD_PID" 2>/dev/null || true
        else
            kill -TERM "$ACTIVE_CHILD_PID" 2>/dev/null || true
            pkill -TERM -P "$ACTIVE_CHILD_PID" 2>/dev/null || true
        fi
        wait "$ACTIVE_CHILD_PID" 2>/dev/null || true
    fi
    recover_pending_directory_transactions || true
    cleanup_temp_files
    log_warning "操作已中断；文件备份保留在 ${BACKUP_DIR}，请结合日志检查未记录的外部状态变更"
    exit "$exit_code"
}

# --- 主程序 ---
main() {
    if [ "$DRY_RUN" = "1" ]; then
        LOG_FILE="/tmp/init_script_dry_run_$(date +%Y%m%d_%H%M%S)_$$.log"
        LOG_READY=false
    fi
    validate_runtime_modes || exit 2

    if [ "$PLAN_ONLY" = "1" ] && { [ -n "$PROFILE_FILE" ] || [ -n "$INIT_PROFILE" ]; }; then
        if [ ! -w "$(dirname "$LOG_FILE")" ]; then
            LOG_FILE="/tmp/init_script_plan_$(date +%Y%m%d_%H%M%S)_$$.log"
        fi
        log_info "Profile PLAN_ONLY 模式，不执行系统变更"
        if [ -n "$PROFILE_FILE" ]; then
            load_profile_file "$PROFILE_FILE"
            apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
            exit 0
        fi
        PROFILE_LOADED_NAME="$INIT_PROFILE"
        if ! PROFILE_LOADED_MODULES="$(profile_modules_for_preset "$INIT_PROFILE")"; then
            log_error "未知 Profile: $INIT_PROFILE"
            exit 1
        fi
        apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
        exit 0
    fi

    check_root
    check_os
    ensure_log_file || exit 1
    acquire_script_lock || exit 1
    trap 'handle_signal INT' INT
    trap 'handle_signal TERM' TERM
    trap handle_exit EXIT

    # 上次若在目录两步 rename 中断，先恢复 live target，再开始新操作。
    recover_pending_directory_transactions || exit 1
    if [ "$DRY_RUN" != "1" ]; then
        mkdir -p "$BACKUP_DIR"
        chmod 700 "$BACKUP_DIR" 2>/dev/null || true
    fi

    log_info "脚本开始执行，日志文件: $LOG_FILE"

    # 启动时不主动探测资源/网络；诊断菜单可按需执行。
    printf '%b\n' ""

    if [ -n "$PROFILE_FILE" ]; then
        log_info "导入 Profile 文件: $PROFILE_FILE"
        load_profile_file "$PROFILE_FILE"
        apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
        exit 0
    fi

    if [ -n "$INIT_PROFILE" ]; then
        log_info "使用内置 Profile: $INIT_PROFILE"
        PROFILE_LOADED_NAME="$INIT_PROFILE"
        if ! PROFILE_LOADED_MODULES="$(profile_modules_for_preset "$INIT_PROFILE")"; then
            log_error "未知 Profile: $INIT_PROFILE"
            exit 1
        fi
        apply_profile_modules "$PROFILE_LOADED_NAME" "$PROFILE_LOADED_MODULES"
        exit 0
    fi

    show_menu
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
