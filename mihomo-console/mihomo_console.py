#!/usr/bin/env python3
"""Mihomo Console: safely manage complete subscription profiles.

Remote profiles are treated as complete configurations. A small local YAML overlay
is merged on top so settings such as external-controller and secret survive every
subscription refresh. The same core powers unattended systemd updates, explicit
CLI commands, and the built-in terminal dashboard.
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
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

try:
    import yaml
except ImportError:
    print("缺少 PyYAML，请先运行：sudo apt install python3-yaml", file=sys.stderr)
    raise SystemExit(2)


DEFAULT_MANAGER_CONFIG = Path("/etc/mihomo/subscription-manager.json")
DEFAULT_UPDATER_SERVICE = "mihomo-subscription-update.service"
DEFAULT_UPDATER_TIMER = "mihomo-subscription-update.timer"
DEFAULT_SYSTEMD_DROPIN = (
    Path("/etc/systemd/system") / f"{DEFAULT_UPDATER_SERVICE}.d" / "paths.conf"
)
SERVICE_START_TIMEOUT_SECONDS = 15.0
SERVICE_STABILITY_SECONDS = 3.0
SERVICE_POLL_INTERVAL_SECONDS = 0.5
DEFAULTS: dict[str, Any] = {
    "target_config": "/etc/mihomo/config.yaml",
    "mihomo_home": "/etc/mihomo",
    "mihomo_binary": "/usr/local/bin/mihomo",
    "systemd_service": "mihomo.service",
    "overlay_file": "/etc/mihomo/local-overrides.yaml",
    "backup_dir": "/etc/mihomo/backups",
    "backup_keep": 8,
    "lock_file": "/run/lock/mihomo-subscription-manager.lock",
    "history_keep": 50,
    "history": [],
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


def elapsed_seconds(started: float) -> float:
    return round(max(0.0, time.monotonic() - started), 3)


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
    history = registry.get("history")
    if not isinstance(history, list):
        raise ManagerError("history 必须是 JSON 数组")
    registry["history"] = [item for item in history if isinstance(item, dict)]
    return registry


def profile_summary_from_mapping(profile: dict[str, Any]) -> dict[str, int]:
    """Return non-sensitive counts suitable for status and history displays."""

    def sequence_count(key: str) -> int:
        value = profile.get(key)
        return len(value) if isinstance(value, list) else 0

    providers = profile.get("proxy-providers")
    return {
        "proxies": sequence_count("proxies"),
        "providers": len(providers) if isinstance(providers, dict) else 0,
        "groups": sequence_count("proxy-groups"),
        "rules": sequence_count("rules"),
    }


def profile_summary_from_bytes(data: bytes) -> dict[str, int]:
    try:
        profile = ensure_mapping(yaml.safe_load(data.decode("utf-8-sig")), "配置")
    except (UnicodeDecodeError, yaml.YAMLError, ManagerError):
        return {"proxies": 0, "providers": 0, "groups": 0, "rules": 0}
    return profile_summary_from_mapping(profile)


def append_history(
    manager_config: Path,
    registry: dict[str, Any],
    event: dict[str, Any],
) -> None:
    """Persist a bounded, deliberately non-sensitive operation history."""

    history = [item for item in registry.get("history", []) if isinstance(item, dict)]
    history.append({key: value for key, value in event.items() if value not in (None, "")})
    keep = max(1, int(registry.get("history_keep", 50)))
    registry["history"] = history[-keep:]

    subscription_name = event.get("subscription")
    subscriptions = registry.get("subscriptions", {})
    if isinstance(subscription_name, str) and subscription_name in subscriptions:
        details = subscriptions[subscription_name]
        details["last_attempt"] = event.get("finished_at") or now_iso()
        details["last_result"] = event.get("status")
        if event.get("status") == "failed":
            details["last_error"] = str(event.get("error") or "未知错误")[:1000]
        else:
            details.pop("last_error", None)
    save_registry(manager_config, registry)


def sanitize_history_error(registry: dict[str, Any], error: object) -> str:
    """Keep a useful one-line error while removing known URLs and control bytes."""

    lines = [line.strip() for line in str(error).splitlines() if line.strip()]
    message = lines[-1] if lines else type(error).__name__
    for details in registry.get("subscriptions", {}).values():
        if not isinstance(details, dict):
            continue
        for key in ("url", "download_proxy"):
            sensitive = str(details.get(key) or "")
            if sensitive:
                message = message.replace(sensitive, "<redacted-url>")
    message = re.sub(r"https?://[^\s'\"]+", "<redacted-url>", message)
    message = "".join(character if character >= " " else " " for character in message)
    return message[:1000]


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

    deadline = time.monotonic() + SERVICE_START_TIMEOUT_SECONDS
    stable_since: float | None = None
    while True:
        active = command_output(["systemctl", "is-active", "--quiet", service], timeout=10)
        checked_at = time.monotonic()
        if active.returncode == 0:
            if stable_since is None:
                stable_since = checked_at
            if checked_at - stable_since >= SERVICE_STABILITY_SECONDS:
                return
        else:
            stable_since = None

        if checked_at >= deadline:
            break
        time.sleep(SERVICE_POLL_INTERVAL_SECONDS)
    raise ManagerError(
        f"{service} 重启后未能连续 {SERVICE_STABILITY_SECONDS:g} 秒保持 active 状态"
    )


def systemd_writable_paths(manager_config: Path, registry: dict[str, Any]) -> list[Path]:
    paths = [
        manager_config.parent,
        Path(str(registry["target_config"])).parent,
        Path(str(registry["mihomo_home"])),
        Path(str(registry["overlay_file"])).parent,
        Path(str(registry["backup_dir"])),
        Path(str(registry["lock_file"])).parent,
    ]
    normalized: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        if not path.is_absolute():
            raise ManagerError(f"systemd 沙箱要求使用绝对路径：{path}")
        path_text = os.path.normpath(str(path))
        if any(ord(character) < 32 or ord(character) == 127 for character in path_text):
            raise ManagerError(f"路径包含不允许的控制字符：{path!s}")
        if path_text not in seen:
            seen.add(path_text)
            normalized.append(Path(path_text))
    return normalized


def quote_systemd_path(path: Path) -> str:
    escaped = (
        str(path).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    )
    return f'"{escaped}"'


def render_systemd_sandbox_dropin(manager_config: Path, registry: dict[str, Any]) -> bytes:
    lines = [
        "# Generated by mihomo-console; do not edit manually.",
        "[Service]",
        "ReadWritePaths=",
    ]
    lines.extend(
        f"ReadWritePaths={quote_systemd_path(path)}"
        for path in systemd_writable_paths(manager_config, registry)
    )
    return ("\n".join(lines) + "\n").encode()


def install_systemd_sandbox(
    manager_config: Path,
    registry: dict[str, Any],
    *,
    dropin: Path = DEFAULT_SYSTEMD_DROPIN,
) -> None:
    if os.geteuid() != 0:
        raise ManagerError("配置 systemd 沙箱需要 root 权限")

    # Validate every configured path before creating any directories.
    systemd_writable_paths(manager_config, registry)
    target_parent = Path(str(registry["target_config"])).parent
    overlay_parent = Path(str(registry["overlay_file"])).parent
    backup_dir = Path(str(registry["backup_dir"]))
    lock_parent = Path(str(registry["lock_file"])).parent
    required_directories = (
        manager_config.parent,
        target_parent,
        overlay_parent,
        backup_dir,
        lock_parent,
    )
    for directory in required_directories:
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ManagerError(f"无法创建 systemd 所需目录 {directory}: {exc}") from exc
    try:
        os.chmod(backup_dir, 0o700)
    except OSError as exc:
        raise ManagerError(f"无法设置备份目录权限 {backup_dir}: {exc}") from exc

    mihomo_home = Path(str(registry["mihomo_home"]))
    if not mihomo_home.is_dir():
        raise ManagerError(f"Mihomo 工作目录不存在：{mihomo_home}")

    try:
        secure_atomic_write(
            dropin,
            render_systemd_sandbox_dropin(manager_config, registry),
            mode=0o644,
        )
    except OSError as exc:
        raise ManagerError(f"无法写入 systemd drop-in {dropin}: {exc}") from exc

    result = command_output(["systemctl", "daemon-reload"], timeout=60)
    if result.returncode != 0:
        raise ManagerError(f"systemctl daemon-reload 失败：{result.stdout.strip()[-2000:]}")
    print(f"已更新 systemd 沙箱写入路径：{dropin}")


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
    # copy2 preserves the source timestamp, while retention must reflect when the
    # backup was created. Give the backup its own creation ordering.
    os.utime(backup, None)
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


def _update_profile_impl(
    manager_config: Path,
    registry: dict[str, Any],
    name: str,
    *,
    dry_run: bool = False,
    result_details: dict[str, Any],
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
        result_details["summary"] = profile_summary_from_bytes(rendered)

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
            result_details["sha256"] = digest
            if dry_run:
                result_details["status"] = "validated"
                print(f"校验通过（dry-run，SHA-256: {digest[:12]}…），未替换配置。")
                return False

            if target.exists() and target.read_bytes() == rendered:
                result_details["status"] = "unchanged"
                print("生成结果与当前配置相同，无需重启 Mihomo。")
                registry["active"] = name
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
                result_details["rolled_back"] = True
                raise ManagerError(f"新配置启动失败，已成功回滚：{restart_error}") from restart_error

            result_details["status"] = "updated"
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


def update_profile(
    manager_config: Path,
    registry: dict[str, Any],
    name: str,
    *,
    dry_run: bool = False,
) -> bool:
    """Update one profile and persist a bounded, sanitized operation record."""

    started_at = now_iso()
    started = time.monotonic()
    details: dict[str, Any] = {}
    try:
        changed = _update_profile_impl(
            manager_config,
            registry,
            name,
            dry_run=dry_run,
            result_details=details,
        )
    except (ManagerError, OSError) as exc:
        # The update lock has been released by this point. Reload the latest state
        # before recording the failure so a concurrent invocation is never erased.
        if "另一个更新任务正在运行" not in str(exc):
            try:
                latest = load_registry(manager_config)
                append_history(
                    manager_config,
                    latest,
                    {
                        "kind": "update",
                        "subscription": name,
                        "status": "failed",
                        "dry_run": dry_run,
                        "started_at": started_at,
                        "finished_at": now_iso(),
                        "duration_seconds": elapsed_seconds(started),
                        "rolled_back": bool(details.get("rolled_back")),
                        "summary": details.get("summary"),
                        "sha256": details.get("sha256"),
                        "error": sanitize_history_error(latest, exc),
                    },
                )
                registry.clear()
                registry.update(latest)
            except (ManagerError, OSError, ValueError) as history_error:
                eprint(f"警告：无法记录更新失败历史：{history_error}")
        if isinstance(exc, ManagerError):
            raise
        raise ManagerError(f"更新失败：{exc}") from exc

    event = {
        "kind": "update",
        "subscription": name,
        "status": details.get("status") or ("updated" if changed else "unchanged"),
        "dry_run": dry_run,
        "started_at": started_at,
        "finished_at": now_iso(),
        "duration_seconds": elapsed_seconds(started),
        "summary": details.get("summary"),
        "sha256": details.get("sha256"),
    }
    append_history(manager_config, registry, event)
    return changed


def list_backup_paths(registry: dict[str, Any]) -> list[Path]:
    target = Path(str(registry["target_config"]))
    backup_dir = Path(str(registry["backup_dir"]))
    if not backup_dir.is_dir():
        return []
    return sorted(
        (path for path in backup_dir.glob(f"{target.name}.*") if path.is_file()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def backup_rows(registry: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in list_backup_paths(registry):
        stat = path.stat()
        rows.append(
            {
                "name": path.name,
                "path": str(path),
                "modified_at": dt.datetime.fromtimestamp(stat.st_mtime).astimezone().isoformat(
                    timespec="seconds"
                ),
                "size": stat.st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "summary": profile_summary_from_bytes(path.read_bytes()),
            }
        )
    return rows


def rollback_backup(
    manager_config: Path,
    registry: dict[str, Any],
    backup_name: str,
) -> None:
    """Validate and restore a named managed backup, with rollback-on-rollback failure."""

    candidates = {path.name: path for path in list_backup_paths(registry)}
    selected = candidates.get(backup_name)
    if selected is None:
        raise ManagerError(f"找不到受管理的备份：{backup_name}")

    target = Path(str(registry["target_config"]))
    if not target.exists():
        raise ManagerError(f"当前配置不存在，拒绝回滚：{target}")

    started_at = now_iso()
    started = time.monotonic()
    print(f"正在用 Mihomo 校验备份 {selected.name}……")
    validate_with_mihomo(registry, selected)
    safety_backup = make_backup(registry, target)
    assert safety_backup is not None
    try:
        restore_backup(target, selected)
        print("备份已原子恢复，正在重启 Mihomo……")
        restart_mihomo(registry)
    except (ManagerError, OSError) as exc:
        eprint("恢复的配置启动失败，正在还原回滚前配置……")
        try:
            restore_backup(target, safety_backup)
            restart_mihomo(registry)
        except (ManagerError, OSError) as recovery_error:
            raise ManagerError(
                f"备份恢复失败，且还原回滚前配置后仍无法启动。安全备份位于 {safety_backup}。\n"
                f"恢复错误：{recovery_error}"
            ) from recovery_error
        try:
            latest = load_registry(manager_config)
            append_history(
                manager_config,
                latest,
                {
                    "kind": "rollback",
                    "status": "failed",
                    "backup": selected.name,
                    "started_at": started_at,
                    "finished_at": now_iso(),
                    "duration_seconds": elapsed_seconds(started),
                    "error": sanitize_history_error(latest, exc),
                },
            )
            registry.clear()
            registry.update(latest)
        except (ManagerError, OSError, ValueError) as history_error:
            eprint(f"警告：无法记录回滚失败历史：{history_error}")
        raise ManagerError(f"备份启动失败，已恢复回滚前配置：{exc}") from exc

    append_history(
        manager_config,
        registry,
        {
            "kind": "rollback",
            "status": "restored",
            "backup": selected.name,
            "started_at": started_at,
            "finished_at": now_iso(),
            "duration_seconds": elapsed_seconds(started),
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "summary": profile_summary_from_bytes(target.read_bytes()),
        },
    )
    prune_backups(registry, target)
    print(f"已恢复备份 {selected.name}，Mihomo 运行正常。")


def command_text(command: list[str], *, timeout: int = 10) -> str:
    try:
        result = command_output(command, timeout=timeout)
    except ManagerError:
        return "unknown"
    output = result.stdout.strip()
    if output:
        return output.splitlines()[-1]
    return "active" if result.returncode == 0 else "unknown"


def collect_status(manager_config: Path, registry: dict[str, Any]) -> dict[str, Any]:
    target = Path(str(registry["target_config"]))
    config_data = b""
    try:
        if target.is_file():
            config_data = target.read_bytes()
    except OSError:
        pass
    active_name = registry.get("active")
    active_details = registry.get("subscriptions", {}).get(active_name, {})
    timer_next = command_text(
        [
            "systemctl",
            "show",
            DEFAULT_UPDATER_TIMER,
            "--property=NextElapseUSecRealtime",
            "--value",
        ]
    )
    return {
        "manager_config": str(manager_config),
        "target_config": str(target),
        "active_subscription": active_name or "未设置",
        "last_success": active_details.get("last_success") or "从未",
        "last_result": active_details.get("last_result") or "无记录",
        "last_error": active_details.get("last_error"),
        "mihomo_service": command_text(
            ["systemctl", "is-active", str(registry["systemd_service"])]
        ),
        "timer_enabled": command_text(
            ["systemctl", "is-enabled", DEFAULT_UPDATER_TIMER]
        ),
        "timer_active": command_text(["systemctl", "is-active", DEFAULT_UPDATER_TIMER]),
        "timer_next": timer_next if timer_next not in {"", "unknown", "n/a"} else "未知",
        "config_exists": bool(config_data),
        "config_sha256": hashlib.sha256(config_data).hexdigest() if config_data else None,
        "summary": profile_summary_from_bytes(config_data) if config_data else {},
        "subscriptions": len(registry.get("subscriptions", {})),
        "backups": len(list_backup_paths(registry)),
        "history": len(registry.get("history", [])),
    }


def print_status(manager_config: Path, registry: dict[str, Any]) -> None:
    status = collect_status(manager_config, registry)
    summary = status.get("summary", {})
    print("Mihomo Console")
    print(f"  Mihomo 服务:   {status['mihomo_service']}")
    print(f"  更新定时器:    {status['timer_active']} / {status['timer_enabled']}")
    print(f"  下次更新:      {status['timer_next']}")
    print(f"  当前订阅:      {status['active_subscription']}")
    print(f"  上次结果:      {status['last_result']}")
    print(f"  上次成功:      {status['last_success']}")
    print(f"  配置文件:      {status['target_config']}")
    if status.get("config_sha256"):
        print(f"  配置 SHA-256:  {status['config_sha256'][:12]}…")
    print(
        "  配置摘要:      "
        f"{summary.get('proxies', 0)} 节点 / {summary.get('providers', 0)} provider / "
        f"{summary.get('groups', 0)} 组 / {summary.get('rules', 0)} 规则"
    )
    if status.get("last_error"):
        print(f"  最近错误:      {status['last_error']}")


def print_history(registry: dict[str, Any], *, limit: int = 20) -> None:
    history = [item for item in registry.get("history", []) if isinstance(item, dict)]
    if not history:
        print("尚无更新或回滚历史。")
        return
    for event in reversed(history[-max(1, limit) :]):
        kind = "更新" if event.get("kind") == "update" else "回滚"
        target = event.get("subscription") or event.get("backup") or "-"
        duration = event.get("duration_seconds", "-")
        print(
            f"{event.get('finished_at', '-')}  {kind:<2}  "
            f"{event.get('status', 'unknown'):<10}  {target}  {duration}s"
        )
        if event.get("error"):
            print(f"  错误：{event['error']}")


def print_backups(registry: dict[str, Any]) -> None:
    rows = backup_rows(registry)
    if not rows:
        print("尚无备份。")
        return
    for row in rows:
        summary = row["summary"]
        print(
            f"{row['name']}  {row['modified_at']}  {row['size']} bytes  "
            f"{summary.get('proxies', 0)} 节点  {row['sha256'][:12]}…"
        )


def fetch_journal(unit: str, *, lines: int = 200) -> list[str]:
    try:
        result = command_output(
            [
                "journalctl",
                "--unit",
                unit,
                "--lines",
                str(max(1, lines)),
                "--no-pager",
                "--output=short-iso",
            ],
            timeout=20,
        )
    except ManagerError as exc:
        return [f"无法读取日志：{exc}"]
    output = result.stdout.strip()
    return output.splitlines() if output else ["暂无日志。"]


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
    print("初始化 Mihomo Console。直接回车可使用检测到的默认值。")
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
            "\nMihomo Console（简易菜单）\n"
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


def display_width(value: str) -> int:
    width = 0
    for character in value:
        if unicodedata.combining(character):
            continue
        width += 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
    return width


def truncate_display(value: str, width: int, *, ellipsis: str = "…") -> str:
    if width <= 0:
        return ""
    if display_width(value) <= width:
        return value
    target = max(0, width - display_width(ellipsis))
    result: list[str] = []
    used = 0
    for character in value:
        character_width = 0 if unicodedata.combining(character) else (
            2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
        )
        if used + character_width > target:
            break
        result.append(character)
        used += character_width
    return "".join(result) + ellipsis


def fit_display(value: str, width: int) -> str:
    fitted = truncate_display(value, width)
    return fitted + " " * max(0, width - display_width(fitted))


class ConsoleTUI:
    """Small dependency-free curses dashboard for SSH administration."""

    PAGES = ("概览", "订阅", "历史", "备份", "日志")

    def __init__(self, screen: Any, curses_module: Any, manager_config: Path):
        self.screen = screen
        self.curses = curses_module
        self.manager_config = manager_config
        self.page = 0
        self.subscription_index = 0
        self.backup_index = 0
        self.log_scroll = 0
        self.log_unit = DEFAULT_UPDATER_SERVICE
        self.message = "r 刷新 · Tab 切换页面 · ? 帮助 · q 退出"
        self.registry: dict[str, Any] = {}
        self.status: dict[str, Any] = {}
        self.backups: list[dict[str, Any]] = []
        self.logs: list[str] = []

    def refresh(self) -> None:
        self.registry = load_registry(self.manager_config)
        self.status = collect_status(self.manager_config, self.registry)
        self.backups = backup_rows(self.registry)
        self.logs = fetch_journal(self.log_unit)
        self.subscription_index = min(
            self.subscription_index,
            max(0, len(self.registry.get("subscriptions", {})) - 1),
        )
        self.backup_index = min(self.backup_index, max(0, len(self.backups) - 1))
        self.log_scroll = min(self.log_scroll, max(0, len(self.logs) - 1))

    def put(self, row: int, column: int, value: str, attr: int = 0) -> None:
        height, width = self.screen.getmaxyx()
        if row < 0 or row >= height or column < 0 or column >= width:
            return
        available = max(0, width - column - 1)
        try:
            self.screen.addstr(row, column, truncate_display(value, available), attr)
        except self.curses.error:
            pass

    def draw(self) -> None:
        self.screen.erase()
        height, width = self.screen.getmaxyx()
        if height < 18 or width < 70:
            self.put(0, 0, "终端过小：Mihomo Console 至少需要 70×18。")
            self.put(2, 0, f"当前大小：{width}×{height}，按 q 退出。")
            self.screen.refresh()
            return

        title_attr = self.curses.color_pair(1) | self.curses.A_BOLD
        good = self.status.get("mihomo_service") == "active"
        service_attr = self.curses.color_pair(2 if good else 3) | self.curses.A_BOLD
        self.put(0, 0, " MIHOMO CONSOLE ", title_attr)
        self.put(0, 19, "安全订阅与运行管理")
        service = f"mihomo {self.status.get('mihomo_service', 'unknown')}"
        self.put(0, max(1, width - display_width(service) - 2), service, service_attr)

        nav_column = 1
        for index, name in enumerate(self.PAGES):
            item = f" {index + 1} {name} "
            attr = self.curses.A_REVERSE | self.curses.A_BOLD if index == self.page else 0
            self.put(2, nav_column, item, attr)
            nav_column += display_width(item) + 2
        self.put(3, 0, "─" * max(1, width - 1), self.curses.color_pair(4))

        if self.page == 0:
            self.draw_dashboard(5)
        elif self.page == 1:
            self.draw_subscriptions(5)
        elif self.page == 2:
            self.draw_history(5)
        elif self.page == 3:
            self.draw_backups(5)
        else:
            self.draw_logs(5)

        self.put(height - 2, 0, "─" * max(1, width - 1), self.curses.color_pair(4))
        self.put(height - 1, 1, self.message, self.curses.A_DIM)
        self.screen.refresh()

    def draw_dashboard(self, start: int) -> None:
        summary = self.status.get("summary", {})
        rows = [
            ("当前订阅", str(self.status.get("active_subscription", "未设置"))),
            ("上次结果", str(self.status.get("last_result", "无记录"))),
            ("上次成功", str(self.status.get("last_success", "从未"))),
            (
                "自动更新",
                f"{self.status.get('timer_active', 'unknown')} / "
                f"{self.status.get('timer_enabled', 'unknown')}",
            ),
            ("下次运行", str(self.status.get("timer_next", "未知"))),
            (
                "配置摘要",
                f"{summary.get('proxies', 0)} 节点 · {summary.get('providers', 0)} provider · "
                f"{summary.get('groups', 0)} 组 · {summary.get('rules', 0)} 规则",
            ),
            ("备份/历史", f"{self.status.get('backups', 0)} / {self.status.get('history', 0)}"),
            ("配置文件", str(self.status.get("target_config", "-"))),
        ]
        self.put(start, 2, "运行概览", self.curses.A_BOLD)
        for offset, (label, value) in enumerate(rows, start=2):
            self.put(start + offset, 4, fit_display(label, 12), self.curses.color_pair(4))
            self.put(start + offset, 18, value)
        digest = self.status.get("config_sha256")
        if digest:
            self.put(start + 10, 4, fit_display("配置哈希", 12), self.curses.color_pair(4))
            self.put(start + 10, 18, f"{digest[:16]}…")
        error = self.status.get("last_error")
        if error:
            self.put(start + 12, 2, "最近错误", self.curses.color_pair(3) | self.curses.A_BOLD)
            self.put(start + 13, 4, str(error))
        self.message = "u 立即更新 · d Dry-run · r 刷新 · Tab 切换 · q 退出"

    def draw_subscriptions(self, start: int) -> None:
        subscriptions = list(self.registry.get("subscriptions", {}).items())
        self.put(start, 2, "订阅", self.curses.A_BOLD)
        self.put(start + 1, 2, "名称", self.curses.color_pair(4))
        self.put(start + 1, 30, "上次结果", self.curses.color_pair(4))
        self.put(start + 1, 44, "上次成功", self.curses.color_pair(4))
        if not subscriptions:
            self.put(start + 3, 4, "尚未配置订阅，按 a 添加。")
        for index, (name, details) in enumerate(subscriptions):
            marker = "*" if name == self.registry.get("active") else " "
            attr = self.curses.A_REVERSE if index == self.subscription_index else 0
            self.put(start + 2 + index, 2, fit_display(f"{marker} {name}", 26), attr)
            self.put(start + 2 + index, 30, fit_display(str(details.get("last_result") or "无记录"), 12), attr)
            self.put(start + 2 + index, 44, str(details.get("last_success") or "从未"), attr)
        self.message = "↑↓ 选择 · Enter 激活 · u 更新 · d Dry-run · a 添加/修改 · x 删除 · q 退出"

    def draw_history(self, start: int) -> None:
        history = [item for item in self.registry.get("history", []) if isinstance(item, dict)]
        self.put(start, 2, "最近操作（不记录 URL、Secret 或节点凭据）", self.curses.A_BOLD)
        if not history:
            self.put(start + 2, 4, "尚无历史；下一次 dry-run、更新或回滚后会出现在这里。")
        height, _ = self.screen.getmaxyx()
        available = max(1, height - start - 4)
        for offset, event in enumerate(reversed(history[-available:]), start=1):
            kind = "更新" if event.get("kind") == "update" else "回滚"
            target = event.get("subscription") or event.get("backup") or "-"
            status = str(event.get("status") or "unknown")
            attr = self.curses.color_pair(3 if status == "failed" else 2)
            self.put(
                start + offset,
                3,
                f"{event.get('finished_at', '-')}  {kind}  {status:<10}  {target}",
                attr,
            )
        self.message = "r 刷新 · Tab 切换 · q 退出"

    def draw_backups(self, start: int) -> None:
        self.put(start, 2, "配置备份", self.curses.A_BOLD)
        self.put(start + 1, 2, "备份", self.curses.color_pair(4))
        self.put(start + 1, 43, "大小", self.curses.color_pair(4))
        self.put(start + 1, 55, "节点", self.curses.color_pair(4))
        if not self.backups:
            self.put(start + 3, 4, "尚无备份；首次实际更新时会自动创建。")
        for index, row in enumerate(self.backups):
            attr = self.curses.A_REVERSE if index == self.backup_index else 0
            self.put(start + 2 + index, 2, fit_display(row["name"], 39), attr)
            self.put(start + 2 + index, 43, fit_display(str(row["size"]), 10), attr)
            self.put(start + 2 + index, 55, str(row["summary"].get("proxies", 0)), attr)
        self.message = "↑↓ 选择 · Enter 恢复所选备份 · r 刷新 · Tab 切换 · q 退出"

    def draw_logs(self, start: int) -> None:
        self.put(start, 2, f"日志 · {self.log_unit}", self.curses.A_BOLD)
        height, _ = self.screen.getmaxyx()
        available = max(1, height - start - 3)
        end = max(0, len(self.logs) - self.log_scroll)
        begin = max(0, end - available)
        for offset, line in enumerate(self.logs[begin:end], start=1):
            attr = self.curses.color_pair(3) if "error" in line.lower() else 0
            self.put(start + offset, 2, line, attr)
        self.message = "↑↓ 滚动 · t 切换更新/Mihomo 日志 · r 刷新 · Tab 切换 · q 退出"

    def selected_subscription(self) -> str | None:
        names = list(self.registry.get("subscriptions", {}))
        if not names:
            return None
        return names[min(self.subscription_index, len(names) - 1)]

    def run_external(self, title: str, action: Callable[[], None]) -> None:
        self.curses.def_prog_mode()
        self.curses.endwin()
        print(f"\n=== {title} ===\n")
        try:
            action()
            print("\n操作完成。")
        except ManagerError as exc:
            print(f"\n错误：{exc}", file=sys.stderr)
        except KeyboardInterrupt:
            print("\n已取消。", file=sys.stderr)
        try:
            input("\n按 Enter 返回 Mihomo Console……")
        except EOFError:
            pass
        self.curses.reset_prog_mode()
        self.screen.clear()
        self.refresh()

    def show_help(self) -> None:
        def help_text() -> None:
            print(
                "全局：1-5 切换页面，Tab/Shift-Tab 前后切换，r 刷新，q 退出。\n"
                "概览：u 更新当前订阅，d 仅下载并校验。\n"
                "订阅：方向键选择，Enter 激活，u 更新，d 校验，a 添加，x 删除。\n"
                "备份：方向键选择，Enter 校验并恢复；恢复失败会自动还原。\n"
                "日志：方向键滚动，t 在更新服务和 Mihomo 服务之间切换。\n\n"
                "TUI 不会显示订阅 URL、Secret 或节点凭据。"
            )

        self.run_external("快捷键", help_text)

    def handle_key(self, key: int) -> bool:
        if key in (ord("q"), ord("Q")):
            return False
        if key == ord("?"):
            self.show_help()
            return True
        if ord("1") <= key <= ord("5"):
            self.page = key - ord("1")
            self.log_scroll = 0
            return True
        if key in (9, self.curses.KEY_RIGHT):
            self.page = (self.page + 1) % len(self.PAGES)
            self.log_scroll = 0
            return True
        if key in (self.curses.KEY_BTAB, self.curses.KEY_LEFT):
            self.page = (self.page - 1) % len(self.PAGES)
            self.log_scroll = 0
            return True
        if key in (ord("r"), ord("R")):
            self.refresh()
            return True

        if self.page == 0 and key in (ord("u"), ord("d")):
            active = self.registry.get("active")
            if not active:
                self.message = "尚未设置当前订阅。"
                return True
            dry_run = key == ord("d")
            self.run_external(
                "校验当前订阅" if dry_run else "更新当前订阅",
                lambda: update_profile(
                    self.manager_config,
                    self.registry,
                    str(active),
                    dry_run=dry_run,
                ),
            )
            return True

        if self.page == 1:
            names = list(self.registry.get("subscriptions", {}))
            if key == self.curses.KEY_UP:
                self.subscription_index = max(0, self.subscription_index - 1)
            elif key == self.curses.KEY_DOWN:
                self.subscription_index = min(max(0, len(names) - 1), self.subscription_index + 1)
            elif key == ord("a"):
                self.run_external(
                    "添加或修改订阅",
                    lambda: add_subscription(self.manager_config, self.registry),
                )
            elif names and key in (10, 13, self.curses.KEY_ENTER):
                name = self.selected_subscription()
                assert name is not None
                self.run_external(
                    f"激活订阅 {name}",
                    lambda: activate(self.manager_config, self.registry, name),
                )
            elif names and key in (ord("u"), ord("d")):
                name = self.selected_subscription()
                assert name is not None
                dry_run = key == ord("d")
                self.run_external(
                    f"{'校验' if dry_run else '更新'}订阅 {name}",
                    lambda: update_profile(
                        self.manager_config,
                        self.registry,
                        name,
                        dry_run=dry_run,
                    ),
                )
            elif names and key == ord("x"):
                name = self.selected_subscription()
                assert name is not None
                self.run_external(
                    f"删除订阅 {name}",
                    lambda: remove_subscription(self.manager_config, self.registry, name),
                )
            return True

        if self.page == 3 and self.backups:
            if key == self.curses.KEY_UP:
                self.backup_index = max(0, self.backup_index - 1)
            elif key == self.curses.KEY_DOWN:
                self.backup_index = min(len(self.backups) - 1, self.backup_index + 1)
            elif key in (10, 13, self.curses.KEY_ENTER):
                name = self.backups[self.backup_index]["name"]

                def restore_selected() -> None:
                    if confirm(f"确认恢复备份 {name} 并重启 Mihomo 吗", False):
                        rollback_backup(self.manager_config, self.registry, name)
                    else:
                        print("已取消。")

                self.run_external(f"恢复备份 {name}", restore_selected)
            return True

        if self.page == 4:
            if key == self.curses.KEY_UP:
                self.log_scroll = min(max(0, len(self.logs) - 1), self.log_scroll + 1)
            elif key == self.curses.KEY_DOWN:
                self.log_scroll = max(0, self.log_scroll - 1)
            elif key == ord("t"):
                self.log_unit = (
                    str(self.registry["systemd_service"])
                    if self.log_unit == DEFAULT_UPDATER_SERVICE
                    else DEFAULT_UPDATER_SERVICE
                )
                self.log_scroll = 0
                self.logs = fetch_journal(self.log_unit)
            return True
        return True

    def run(self) -> None:
        self.screen.keypad(True)
        try:
            self.curses.curs_set(0)
        except self.curses.error:
            pass
        if self.curses.has_colors():
            self.curses.start_color()
            self.curses.use_default_colors()
            self.curses.init_pair(1, self.curses.COLOR_CYAN, -1)
            self.curses.init_pair(2, self.curses.COLOR_GREEN, -1)
            self.curses.init_pair(3, self.curses.COLOR_RED, -1)
            self.curses.init_pair(4, self.curses.COLOR_BLUE, -1)
        self.refresh()
        running = True
        while running:
            self.draw()
            running = self.handle_key(self.screen.getch())


def launch_tui(manager_config: Path) -> None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ManagerError("TUI 需要交互式终端；自动任务请使用明确的 CLI 子命令")
    try:
        import curses
    except ImportError as exc:
        raise ManagerError("当前 Python 缺少 curses 模块，无法启动 TUI") from exc
    try:
        curses.wrapper(
            lambda screen: ConsoleTUI(screen, curses, manager_config).run()
        )
    except (curses.error, OSError) as exc:
        raise ManagerError(f"无法启动 TUI：{exc}") from exc


def show_secret(registry: dict[str, Any]) -> None:
    overlay = read_yaml_mapping(Path(str(registry["overlay_file"])))
    secret = overlay.get("secret")
    if not secret:
        raise ManagerError("本地覆盖中没有设置 Secret")
    print(str(secret))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Mihomo Console：安全更新、诊断和恢复完整订阅配置"
    )
    parser.add_argument(
        "--manager-config",
        type=Path,
        default=DEFAULT_MANAGER_CONFIG,
        help=f"管理配置路径（默认：{DEFAULT_MANAGER_CONFIG}）",
    )
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help="初始化管理配置和本地覆盖")
    init_parser.add_argument("--force", action="store_true", help="覆盖已有管理配置")
    subparsers.add_parser("tui", help="进入终端控制台（默认）")
    subparsers.add_parser("menu", help="进入兼容的简易文本菜单")
    subparsers.add_parser("status", help="显示服务、定时器和当前配置摘要")
    subparsers.add_parser("list", help="列出订阅（不显示 URL）")
    history_parser = subparsers.add_parser("history", help="显示脱敏的更新与回滚历史")
    history_parser.add_argument("--limit", type=int, default=20, help="最多显示多少条（默认 20）")
    subparsers.add_parser("backups", help="列出受管理的配置备份")
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

    rollback_parser = subparsers.add_parser("rollback", help="校验并恢复一个配置备份")
    rollback_parser.add_argument("backup", help="backups 命令列出的备份文件名")
    rollback_parser.add_argument("--yes", action="store_true", help="跳过交互确认")

    subparsers.add_parser("configure-overlay", help="配置控制 API、Secret 和 CORS 覆盖")
    subparsers.add_parser(
        "configure-systemd-sandbox",
        help="按当前路径生成自动更新服务的 systemd 沙箱配置",
    )
    subparsers.add_parser("show-secret", help="显式输出当前 Secret")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    manager_config: Path = args.manager_config
    command = args.command or "tui"

    try:
        if command == "init":
            initialize(manager_config, force=args.force)
            return 0
        registry = load_registry(manager_config)
        if command == "tui":
            launch_tui(manager_config)
        elif command == "menu":
            interactive_menu(manager_config)
        elif command == "status":
            print_status(manager_config, registry)
        elif command == "list":
            list_subscriptions(registry)
        elif command == "history":
            print_history(registry, limit=max(1, args.limit))
        elif command == "backups":
            print_backups(registry)
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
        elif command == "rollback":
            if args.yes or confirm(
                f"确认恢复备份 {args.backup} 并重启 Mihomo 吗", False
            ):
                rollback_backup(manager_config, registry, args.backup)
            else:
                print("已取消。")
        elif command == "configure-overlay":
            configure_overlay(registry)
        elif command == "configure-systemd-sandbox":
            install_systemd_sandbox(manager_config, registry)
        elif command == "show-secret":
            show_secret(registry)
        else:
            parser.error(f"未知命令：{command}")
        return 0
    except KeyboardInterrupt:
        eprint("\n已取消。")
        return 130
    except (ManagerError, OSError) as exc:
        eprint(f"错误：{exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
