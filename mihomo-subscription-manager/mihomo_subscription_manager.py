#!/usr/bin/env python3
"""Manage complete Mihomo subscription profiles safely.

Remote profiles are treated as complete configurations. A small local YAML overlay
is merged on top so settings such as external-controller and secret survive every
subscription refresh.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import fcntl
import getpass
import gzip
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("缺少 PyYAML，请先运行：sudo apt install python3-yaml", file=sys.stderr)
    raise SystemExit(2)


DEFAULT_MANAGER_CONFIG = Path("/etc/mihomo/subscription-manager.json")
DEFAULTS: dict[str, Any] = {
    "target_config": "/etc/mihomo/config.yaml",
    "mihomo_home": "/etc/mihomo",
    "mihomo_binary": "/usr/local/bin/mihomo",
    "systemd_service": "mihomo.service",
    "overlay_file": "/etc/mihomo/local-overrides.yaml",
    "backup_dir": "/etc/mihomo/backups",
    "backup_keep": 8,
    "lock_file": "/run/lock/mihomo-subscription-manager.lock",
    "active": None,
    "subscriptions": {},
}
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
NAME_RE = re.compile(r"^[^/\x00\r\n]+$")


class ManagerError(RuntimeError):
    pass


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def ask(prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default not in (None, "") else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value if value else (default or "")


def confirm(prompt: str, default: bool = False) -> bool:
    hint = "Y/n" if default else "y/N"
    value = input(f"{prompt} [{hint}]: ").strip().lower()
    if not value:
        return default
    return value in {"y", "yes", "是"}


def ensure_mapping(value: Any, description: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ManagerError(f"{description}的顶层必须是 YAML/JSON 映射")
    return value


def read_yaml_mapping(path: Path, *, missing_ok: bool = False) -> dict[str, Any]:
    if missing_ok and not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            return ensure_mapping(yaml.safe_load(handle), str(path))
    except OSError as exc:
        raise ManagerError(f"无法读取 {path}: {exc.strerror or exc}") from exc
    except yaml.YAMLError as exc:
        raise ManagerError(f"{path} 不是有效 YAML: {exc}") from exc


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge mappings recursively; scalars and lists in overlay replace the base."""
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def render_profile(remote_bytes: bytes, overlay: dict[str, Any]) -> bytes:
    try:
        remote_text = remote_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ManagerError("订阅返回内容不是 UTF-8 文本") from exc

    try:
        remote = ensure_mapping(yaml.safe_load(remote_text), "订阅配置")
    except yaml.YAMLError as exc:
        raise ManagerError(f"订阅返回内容不是有效 YAML: {exc}") from exc

    proxies = remote.get("proxies")
    providers = remote.get("proxy-providers")
    if not (isinstance(proxies, list) and proxies) and not (
        isinstance(providers, dict) and providers
    ):
        raise ManagerError("订阅配置既没有非空 proxies，也没有 proxy-providers；拒绝覆盖")

    merged = deep_merge(remote, overlay)
    rendered = yaml.safe_dump(
        merged,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
        width=4096,
    )
    return rendered.encode("utf-8")


def secure_atomic_write(
    path: Path,
    data: bytes,
    *,
    mode: int = 0o600,
    preserve_owner_from: Path | None = None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    owner: tuple[int, int] | None = None
    source = preserve_owner_from if preserve_owner_from and preserve_owner_from.exists() else path
    if source.exists():
        stat = source.stat()
        owner = (stat.st_uid, stat.st_gid)

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if owner is not None and os.geteuid() == 0:
            os.chown(temporary, owner[0], owner[1])
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def fsync_directory(path: Path) -> None:
    directory_fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def save_registry(path: Path, registry: dict[str, Any]) -> None:
    payload = (json.dumps(registry, ensure_ascii=False, indent=2) + "\n").encode()
    secure_atomic_write(path, payload, mode=0o600)


def load_registry(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            loaded = ensure_mapping(json.load(handle), str(path))
    except FileNotFoundError as exc:
        raise ManagerError(f"尚未初始化：请先运行 sudo {Path(sys.argv[0]).name} init") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(f"无法读取管理配置 {path}: {exc}") from exc

    registry = copy.deepcopy(DEFAULTS)
    registry.update(loaded)
    registry["subscriptions"] = ensure_mapping(registry.get("subscriptions"), "subscriptions")
    return registry


def validate_subscription_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ManagerError("订阅地址必须是有效的 http:// 或 https:// URL")


def download_profile(subscription: dict[str, Any]) -> bytes:
    url = str(subscription.get("url", ""))
    validate_subscription_url(url)
    user_agent = str(subscription.get("user_agent") or "clash.meta")
    proxy_url = str(subscription.get("download_proxy") or "").strip()

    handlers: list[Any] = []
    if proxy_url:
        validate_subscription_url(proxy_url)
        handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/yaml, text/yaml, text/plain, */*",
            "Accept-Encoding": "gzip",
        },
    )

    try:
        with opener.open(request, timeout=60) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_DOWNLOAD_BYTES:
                raise ManagerError("订阅响应超过 20 MiB，已拒绝")
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise ManagerError("订阅响应超过 20 MiB，已拒绝")
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                try:
                    data = gzip.decompress(data)
                except gzip.BadGzipFile as exc:
                    raise ManagerError("订阅服务器返回了无效的 gzip 内容") from exc
    except urllib.error.HTTPError as exc:
        raise ManagerError(f"下载失败：HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        reason_name = type(reason).__name__ if reason is not None else "网络错误"
        raise ManagerError(f"下载失败：{reason_name}") from exc
    except (OSError, ValueError) as exc:
        raise ManagerError(f"下载失败：{type(exc).__name__}") from exc

    if not data.strip():
        raise ManagerError("订阅返回了空内容")
    return data


def command_output(command: list[str], *, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ManagerError(f"找不到命令：{command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ManagerError(f"命令执行超时：{command[0]}") from exc


def validate_with_mihomo(registry: dict[str, Any], candidate: Path) -> None:
    result = command_output(
        [
            str(registry["mihomo_binary"]),
            "-t",
            "-d",
            str(registry["mihomo_home"]),
            "-f",
            str(candidate),
        ],
        timeout=90,
    )
    if result.returncode != 0:
        details = result.stdout.strip()[-3000:]
        raise ManagerError(f"Mihomo 配置校验失败：\n{details}")


def restart_mihomo(registry: dict[str, Any]) -> None:
    service = str(registry["systemd_service"])
    result = command_output(["systemctl", "restart", service], timeout=60)
    if result.returncode != 0:
        raise ManagerError(f"systemctl restart {service} 失败：{result.stdout.strip()[-2000:]}")

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        active = command_output(["systemctl", "is-active", "--quiet", service], timeout=10)
        if active.returncode == 0:
            return
        time.sleep(0.5)
    raise ManagerError(f"{service} 重启后未进入 active 状态")


def make_backup(registry: dict[str, Any], target: Path) -> Path | None:
    if not target.exists():
        return None
    backup_dir = Path(str(registry["backup_dir"]))
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup_dir, 0o700)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = backup_dir / f"{target.name}.{stamp}"
    shutil.copy2(target, backup)
    os.chmod(backup, 0o600)
    return backup


def prune_backups(registry: dict[str, Any], target: Path) -> None:
    backup_dir = Path(str(registry["backup_dir"]))
    if not backup_dir.exists():
        return
    keep = max(1, int(registry.get("backup_keep", 8)))
    backups = sorted(
        backup_dir.glob(f"{target.name}.*"), key=lambda item: item.stat().st_mtime, reverse=True
    )
    for old in backups[keep:]:
        old.unlink()


def restore_backup(target: Path, backup: Path) -> None:
    secure_atomic_write(target, backup.read_bytes(), mode=0o600, preserve_owner_from=target)


def update_profile(
    manager_config: Path,
    registry: dict[str, Any],
    name: str,
    *,
    dry_run: bool = False,
) -> bool:
    subscriptions = registry["subscriptions"]
    if name not in subscriptions:
        raise ManagerError(f"找不到订阅：{name}")

    lock_path = Path(str(registry["lock_file"]))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ManagerError("另一个更新任务正在运行") from exc

        print(f"正在下载订阅“{name}”……")
        remote_bytes = download_profile(subscriptions[name])
        overlay_path = Path(str(registry["overlay_file"]))
        overlay = read_yaml_mapping(overlay_path, missing_ok=True)
        rendered = render_profile(remote_bytes, overlay)

        target = Path(str(registry["target_config"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, candidate_name = tempfile.mkstemp(prefix=".mihomo-candidate.", suffix=".yaml", dir=target.parent)
        candidate = Path(candidate_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(candidate, 0o600)

            print("正在用 Mihomo 校验候选配置……")
            validate_with_mihomo(registry, candidate)
            digest = hashlib.sha256(rendered).hexdigest()
            if dry_run:
                print(f"校验通过（dry-run，SHA-256: {digest[:12]}…），未替换配置。")
                return False

            if target.exists() and target.read_bytes() == rendered:
                print("生成结果与当前配置相同，无需重启 Mihomo。")
                subscriptions[name]["last_success"] = now_iso()
                subscriptions[name]["last_sha256"] = digest
                save_registry(manager_config, registry)
                return False

            backup = make_backup(registry, target)
            old_owner = target if target.exists() else None
            if old_owner and os.geteuid() == 0:
                stat = old_owner.stat()
                os.chown(candidate, stat.st_uid, stat.st_gid)
            os.replace(candidate, target)
            os.chmod(target, 0o600)
            fsync_directory(target.parent)

            try:
                print("配置已原子替换，正在重启 Mihomo……")
                restart_mihomo(registry)
            except ManagerError as restart_error:
                if backup is None:
                    raise ManagerError(f"{restart_error}；没有旧配置可回滚") from restart_error
                eprint("重启失败，正在恢复上一份配置……")
                restore_backup(target, backup)
                try:
                    restart_mihomo(registry)
                except ManagerError as rollback_error:
                    raise ManagerError(
                        f"新配置启动失败，且回滚后重启也失败。原备份位于 {backup}。\n"
                        f"回滚错误：{rollback_error}"
                    ) from rollback_error
                raise ManagerError(f"新配置启动失败，已成功回滚：{restart_error}") from restart_error

            registry["active"] = name
            subscriptions[name]["last_success"] = now_iso()
            subscriptions[name]["last_sha256"] = digest
            save_registry(manager_config, registry)
            prune_backups(registry, target)
            print(f"更新成功，当前订阅为“{name}”。")
            return True
        finally:
            if candidate.exists():
                candidate.unlink()


def configure_overlay(registry: dict[str, Any], *, initial: bool = False) -> str | None:
    path = Path(str(registry["overlay_file"]))
    overlay = read_yaml_mapping(path, missing_ok=True)
    current_controller = str(overlay.get("external-controller") or "127.0.0.1:9090")
    controller = ask("external-controller 监听地址", current_controller)

    if controller.startswith("0.0.0.0:") or controller.startswith("[::]:"):
        print("提示：控制 API 将暴露到局域网；请同时限制防火墙并使用强 Secret。")

    current_secret = str(overlay.get("secret") or "")
    generated: str | None = None
    if initial or not current_secret:
        if confirm("要手动输入 Secret 吗（否则自动生成 64 位随机值）", False):
            first = getpass.getpass("输入 Secret: ")
            second = getpass.getpass("再次输入 Secret: ")
            if not first or first != second:
                raise ManagerError("Secret 为空或两次输入不一致")
            current_secret = first
        else:
            current_secret = secrets.token_hex(32)
            generated = current_secret
    elif confirm("要轮换现有 Secret 吗", False):
        current_secret = secrets.token_hex(32)
        generated = current_secret

    existing_cors = overlay.get("external-controller-cors")
    existing_origins: list[str] = []
    if isinstance(existing_cors, dict) and isinstance(existing_cors.get("allow-origins"), list):
        existing_origins = [str(item) for item in existing_cors["allow-origins"]]
    origins_text = ask(
        "允许的 Zashboard Origin（逗号分隔；例如 http://192.168.1.10:3000）",
        ",".join(existing_origins),
    )
    origins = [item.strip() for item in origins_text.split(",") if item.strip()]

    overlay["external-controller"] = controller
    overlay["secret"] = current_secret
    if origins:
        overlay["external-controller-cors"] = {
            "allow-origins": origins,
            "allow-private-network": True,
        }
    else:
        overlay.pop("external-controller-cors", None)

    rendered = yaml.safe_dump(overlay, allow_unicode=True, sort_keys=False).encode()
    secure_atomic_write(path, rendered, mode=0o600)
    print(f"本地覆盖已保存到 {path}（权限 0600）。")
    return generated


def initialize(manager_config: Path, *, force: bool = False) -> None:
    if manager_config.exists() and not force:
        raise ManagerError(f"{manager_config} 已存在；如需覆盖请使用 init --force")

    registry = copy.deepcopy(DEFAULTS)
    print("初始化 Mihomo 订阅管理器。直接回车可使用检测到的默认值。")
    registry["target_config"] = ask("Mihomo 主配置路径", str(DEFAULTS["target_config"]))
    registry["mihomo_home"] = ask("Mihomo 工作目录", str(DEFAULTS["mihomo_home"]))
    registry["mihomo_binary"] = ask("Mihomo 可执行文件", str(DEFAULTS["mihomo_binary"]))
    registry["systemd_service"] = ask("systemd 服务名", str(DEFAULTS["systemd_service"]))
    registry["overlay_file"] = ask("本地覆盖 YAML 路径", str(DEFAULTS["overlay_file"]))
    registry["backup_dir"] = ask("备份目录", str(DEFAULTS["backup_dir"]))
    save_registry(manager_config, registry)
    generated = configure_overlay(registry, initial=True)
    print(f"管理配置已保存到 {manager_config}（权限 0600）。")
    if generated:
        print("已自动生成 Secret。为避免出现在终端历史中，这里不直接显示；可显式运行 show-secret 查看。")


def add_subscription(manager_config: Path, registry: dict[str, Any]) -> None:
    name = ask("订阅名称")
    if not name or not NAME_RE.fullmatch(name):
        raise ManagerError("订阅名称不能为空，且不能包含 /、换行或 NUL")
    if name in registry["subscriptions"] and not confirm("同名订阅已存在，覆盖吗", False):
        return
    url = getpass.getpass("订阅 URL（隐藏输入）: ").strip()
    validate_subscription_url(url)
    user_agent = ask("下载 User-Agent", "clash.meta")
    proxy_url = ask("下载代理 URL（可留空；例如 http://127.0.0.1:7890）")
    if proxy_url:
        validate_subscription_url(proxy_url)
    registry["subscriptions"][name] = {
        "url": url,
        "user_agent": user_agent,
        "download_proxy": proxy_url or None,
    }
    if registry.get("active") is None or confirm("设为当前订阅吗", True):
        registry["active"] = name
    save_registry(manager_config, registry)
    print(f"已保存订阅“{name}”；URL 仅保存在权限 0600 的管理配置中。")


def list_subscriptions(registry: dict[str, Any]) -> None:
    subscriptions = registry["subscriptions"]
    if not subscriptions:
        print("尚未配置订阅。")
        return
    active = registry.get("active")
    for name, details in subscriptions.items():
        marker = "*" if name == active else " "
        last = details.get("last_success") or "从未成功更新"
        proxy = "，使用下载代理" if details.get("download_proxy") else ""
        print(f"{marker} {name} — {last}{proxy}")


def activate(manager_config: Path, registry: dict[str, Any], name: str) -> None:
    if name not in registry["subscriptions"]:
        raise ManagerError(f"找不到订阅：{name}")
    registry["active"] = name
    save_registry(manager_config, registry)
    print(f"当前订阅已切换为“{name}”。运行 update-active 才会下载并应用。")


def remove_subscription(manager_config: Path, registry: dict[str, Any], name: str) -> None:
    if name not in registry["subscriptions"]:
        raise ManagerError(f"找不到订阅：{name}")
    if not confirm(f"确认删除订阅“{name}”吗（不会删除当前 Mihomo 配置）", False):
        return
    del registry["subscriptions"][name]
    if registry.get("active") == name:
        registry["active"] = next(iter(registry["subscriptions"]), None)
    save_registry(manager_config, registry)
    print(f"已删除订阅“{name}”。")


def choose_subscription(registry: dict[str, Any], prompt: str) -> str:
    names = list(registry["subscriptions"])
    if not names:
        raise ManagerError("尚未配置订阅")
    list_subscriptions(registry)
    default = str(registry.get("active") or names[0])
    name = ask(prompt, default)
    if name not in registry["subscriptions"]:
        raise ManagerError(f"找不到订阅：{name}")
    return name


def interactive_menu(manager_config: Path) -> None:
    while True:
        registry = load_registry(manager_config)
        print(
            "\nMihomo 订阅管理器\n"
            "  1. 查看订阅\n"
            "  2. 添加/修改订阅\n"
            "  3. 选择当前订阅\n"
            "  4. 更新当前订阅\n"
            "  5. 校验当前订阅（不应用）\n"
            "  6. 删除订阅\n"
            "  7. 配置本地控制器覆盖\n"
            "  8. 显示 Secret\n"
            "  0. 退出"
        )
        choice = ask("请选择")
        try:
            if choice == "0":
                return
            if choice == "1":
                list_subscriptions(registry)
            elif choice == "2":
                add_subscription(manager_config, registry)
            elif choice == "3":
                activate(manager_config, registry, choose_subscription(registry, "设为当前的订阅"))
            elif choice in {"4", "5"}:
                active = registry.get("active")
                if not active:
                    raise ManagerError("尚未选择当前订阅")
                update_profile(manager_config, registry, str(active), dry_run=choice == "5")
            elif choice == "6":
                remove_subscription(manager_config, registry, choose_subscription(registry, "要删除的订阅"))
            elif choice == "7":
                configure_overlay(registry)
            elif choice == "8":
                show_secret(registry)
            else:
                print("无效选项。")
        except ManagerError as exc:
            eprint(f"错误：{exc}")


def show_secret(registry: dict[str, Any]) -> None:
    overlay = read_yaml_mapping(Path(str(registry["overlay_file"])))
    secret = overlay.get("secret")
    if not secret:
        raise ManagerError("本地覆盖中没有设置 Secret")
    print(str(secret))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="安全更新完整 Mihomo 订阅配置")
    parser.add_argument(
        "--manager-config",
        type=Path,
        default=DEFAULT_MANAGER_CONFIG,
        help=f"管理配置路径（默认：{DEFAULT_MANAGER_CONFIG}）",
    )
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="初始化管理配置和本地覆盖")
    init_parser.add_argument("--force", action="store_true", help="覆盖已有管理配置")
    subparsers.add_parser("menu", help="进入交互菜单")
    subparsers.add_parser("list", help="列出订阅（不显示 URL）")
    subparsers.add_parser("add", help="交互式添加或修改订阅")

    activate_parser = subparsers.add_parser("activate", help="选择当前订阅，但不立即应用")
    activate_parser.add_argument("name")
    remove_parser = subparsers.add_parser("remove", help="删除一个订阅")
    remove_parser.add_argument("name")

    update_parser = subparsers.add_parser("update", help="下载并应用指定订阅")
    update_parser.add_argument("name")
    update_parser.add_argument("--dry-run", action="store_true", help="仅下载和校验")
    update_active_parser = subparsers.add_parser("update-active", help="下载并应用当前订阅")
    update_active_parser.add_argument("--dry-run", action="store_true", help="仅下载和校验")

    subparsers.add_parser("configure-overlay", help="配置控制 API、Secret 和 CORS 覆盖")
    subparsers.add_parser("show-secret", help="显式输出当前 Secret")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    manager_config: Path = args.manager_config
    command = args.command or "menu"

    try:
        if command == "init":
            initialize(manager_config, force=args.force)
            return 0
        registry = load_registry(manager_config)
        if command == "menu":
            interactive_menu(manager_config)
        elif command == "list":
            list_subscriptions(registry)
        elif command == "add":
            add_subscription(manager_config, registry)
        elif command == "activate":
            activate(manager_config, registry, args.name)
        elif command == "remove":
            remove_subscription(manager_config, registry, args.name)
        elif command == "update":
            update_profile(manager_config, registry, args.name, dry_run=args.dry_run)
        elif command == "update-active":
            active = registry.get("active")
            if not active:
                raise ManagerError("尚未选择当前订阅")
            update_profile(manager_config, registry, str(active), dry_run=args.dry_run)
        elif command == "configure-overlay":
            configure_overlay(registry)
        elif command == "show-secret":
            show_secret(registry)
        else:
            parser.error(f"未知命令：{command}")
        return 0
    except KeyboardInterrupt:
        eprint("\n已取消。")
        return 130
    except ManagerError as exc:
        eprint(f"错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
