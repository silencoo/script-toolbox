#!/usr/bin/env python3
"""Container runtime for Mihomo Console.

The runtime owns the Mihomo child process, exposes a small status file for the
console, and replaces the systemd timer with an in-container update loop.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import os
import shutil
import signal
import socket
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, TextIO

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import mihomo_console as manager


DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MANAGER_DIR = DATA_DIR / "manager"
MIHOMO_HOME = DATA_DIR / "mihomo"
LOG_DIR = DATA_DIR / "logs"
MANAGER_CONFIG = MANAGER_DIR / "subscription-manager.json"
OVERLAY_FILE = MANAGER_DIR / "local-overrides.yaml"
TARGET_CONFIG = MIHOMO_HOME / "config.yaml"
BACKUP_DIR = MANAGER_DIR / "backups"
RUNTIME_DIR = Path("/run/mihomo-console")
RUNTIME_FILE = RUNTIME_DIR / "runtime.json"
LOCK_FILE = Path("/run/lock/mihomo-subscription-manager.lock")
MIHOMO_BINARY = Path("/usr/local/bin/mihomo")
SEEDED_DATA_DIR = Path("/usr/local/share/mihomo")
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 2


def env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise manager.ManagerError(f"{name} 必须是整数") from exc
    if value < minimum:
        raise manager.ManagerError(f"{name} 不能小于 {minimum}")
    return value


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def future_time(seconds: int) -> str:
    value = dt.datetime.now(dt.timezone.utc).astimezone() + dt.timedelta(seconds=seconds)
    return value.isoformat(timespec="seconds")


def rotate_log(path: Path) -> None:
    try:
        if not path.exists() or path.stat().st_size < MAX_LOG_BYTES:
            return
        oldest = path.with_name(f"{path.name}.{LOG_BACKUPS}")
        oldest.unlink(missing_ok=True)
        for index in range(LOG_BACKUPS - 1, 0, -1):
            source = path.with_name(f"{path.name}.{index}")
            if source.exists():
                source.replace(path.with_name(f"{path.name}.{index + 1}"))
        path.replace(path.with_name(f"{path.name}.1"))
    except OSError as exc:
        print(f"警告：无法轮换日志 {path}: {exc}", file=sys.stderr, flush=True)


def append_log(path: Path, text: str, lock: threading.Lock) -> None:
    if not text:
        return
    with lock:
        rotate_log(path)
        with path.open("a", encoding="utf-8", errors="replace") as handle:
            handle.write(text)
            if not text.endswith("\n"):
                handle.write("\n")
    print(text, end="" if text.endswith("\n") else "\n", flush=True)


def initial_overlay() -> dict[str, Any]:
    secret = os.environ.get("MIHOMO_SECRET", "").strip() or secrets.token_hex(32)
    origins = [
        item.strip()
        for item in os.environ.get("DASHBOARD_ORIGINS", "").split(",")
        if item.strip()
    ]
    overlay: dict[str, Any] = {
        "mixed-port": env_int("MIXED_PORT", 7890, minimum=1),
        "allow-lan": env_bool("ALLOW_LAN", True),
        "bind-address": "*",
        "external-controller": (
            f"0.0.0.0:{env_int('CONTROLLER_PORT', 9090, minimum=1)}"
        ),
        "secret": secret,
    }
    if origins:
        overlay["external-controller-cors"] = {
            "allow-origins": origins,
            "allow-private-network": True,
        }
    return overlay


def ensure_layout() -> dict[str, Any]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for path, mode in (
        (MANAGER_DIR, 0o700),
        (MIHOMO_HOME, 0o700),
        (LOG_DIR, 0o700),
        (BACKUP_DIR, 0o700),
        (RUNTIME_DIR, 0o700),
        (LOCK_FILE.parent, 0o755),
    ):
        path.mkdir(parents=True, exist_ok=True)
        try:
            path.chmod(mode)
        except OSError:
            pass

    if SEEDED_DATA_DIR.is_dir():
        for source in SEEDED_DATA_DIR.iterdir():
            destination = MIHOMO_HOME / source.name
            if source.is_file() and not destination.exists():
                shutil.copy2(source, destination)

    if not OVERLAY_FILE.exists():
        rendered = yaml.safe_dump(
            initial_overlay(), allow_unicode=True, sort_keys=False
        ).encode()
        manager.secure_atomic_write(OVERLAY_FILE, rendered, mode=0o600)

    registry: dict[str, Any]
    if MANAGER_CONFIG.exists():
        registry = manager.load_registry(MANAGER_CONFIG)
    else:
        registry = copy.deepcopy(manager.DEFAULTS)

    container_values = {
        "target_config": str(TARGET_CONFIG),
        "mihomo_home": str(MIHOMO_HOME),
        "mihomo_binary": str(MIHOMO_BINARY),
        "service_backend": "container",
        "runtime_file": str(RUNTIME_FILE),
        "container_log_dir": str(LOG_DIR),
        "overlay_file": str(OVERLAY_FILE),
        "backup_dir": str(BACKUP_DIR),
        "lock_file": str(LOCK_FILE),
    }
    changed = not MANAGER_CONFIG.exists()
    for key, value in container_values.items():
        if registry.get(key) != value:
            registry[key] = value
            changed = True
    if changed:
        manager.save_registry(MANAGER_CONFIG, registry)

    if not TARGET_CONFIG.exists():
        base = {
            "mode": "rule",
            "log-level": "info",
            "ipv6": False,
            "proxies": [],
            "proxy-groups": [],
            "rules": ["MATCH,DIRECT"],
        }
        overlay = manager.read_yaml_mapping(OVERLAY_FILE)
        rendered = yaml.safe_dump(
            manager.deep_merge(base, overlay), allow_unicode=True, sort_keys=False
        ).encode()
        manager.secure_atomic_write(TARGET_CONFIG, rendered, mode=0o600)

    return registry


class ContainerRuntime:
    def __init__(self) -> None:
        self.stop_event = threading.Event()
        self.restart_event = threading.Event()
        self.state_lock = threading.Lock()
        self.log_lock = threading.Lock()
        self.process: subprocess.Popen[str] | None = None
        self.generation = 0
        self.state: dict[str, Any] = {
            "supervisor_pid": os.getpid(),
            "mihomo_pid": None,
            "mihomo_state": "starting",
            "generation": 0,
            "updater_enabled": False,
            "updater_running": False,
            "next_update": None,
            "updated_at": utc_now(),
        }
        self.update_interval = env_int("UPDATE_INTERVAL_SECONDS", 3600)
        self.update_start_delay = env_int("UPDATE_START_DELAY_SECONDS", 600)

    def write_state(self, **changes: Any) -> None:
        with self.state_lock:
            self.state.update(changes)
            self.state["updated_at"] = utc_now()
            payload = (json.dumps(self.state, ensure_ascii=False, indent=2) + "\n").encode()
            manager.secure_atomic_write(RUNTIME_FILE, payload, mode=0o600)

    def request_stop(self, _signum: int, _frame: object) -> None:
        self.stop_event.set()

    def request_restart(self, _signum: int, _frame: object) -> None:
        self.restart_event.set()

    def pump_mihomo_output(self, stream: TextIO) -> None:
        try:
            for line in stream:
                append_log(LOG_DIR / "mihomo.log", line, self.log_lock)
        finally:
            stream.close()

    def start_mihomo(self) -> None:
        self.generation += 1
        command = [
            str(MIHOMO_BINARY),
            "-d",
            str(MIHOMO_HOME),
            "-f",
            str(TARGET_CONFIG),
        ]
        self.process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert self.process.stdout is not None
        threading.Thread(
            target=self.pump_mihomo_output,
            args=(self.process.stdout,),
            name=f"mihomo-log-{self.generation}",
            daemon=True,
        ).start()
        self.write_state(
            mihomo_pid=self.process.pid,
            mihomo_state="running",
            generation=self.generation,
            started_at=utc_now(),
            last_exit_code=None,
        )

    def stop_mihomo(self) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def run_update(self) -> None:
        try:
            registry = manager.load_registry(MANAGER_CONFIG)
            if not registry.get("active"):
                append_log(
                    LOG_DIR / "updater.log",
                    f"{utc_now()} 跳过自动更新：尚未选择当前订阅。\n",
                    self.log_lock,
                )
                return
            result = subprocess.run(
                [
                    sys.executable,
                    "/usr/local/sbin/mihomo-console",
                    "--manager-config",
                    str(MANAGER_CONFIG),
                    "update-active",
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=300,
                check=False,
            )
            append_log(LOG_DIR / "updater.log", result.stdout, self.log_lock)
            if result.returncode != 0:
                append_log(
                    LOG_DIR / "updater.log",
                    f"{utc_now()} 自动更新失败，退出码 {result.returncode}。\n",
                    self.log_lock,
                )
        except (OSError, subprocess.TimeoutExpired, manager.ManagerError) as exc:
            append_log(
                LOG_DIR / "updater.log",
                f"{utc_now()} 自动更新异常：{type(exc).__name__}。\n",
                self.log_lock,
            )

    def update_loop(self) -> None:
        if self.update_interval == 0:
            self.write_state(
                updater_enabled=False, updater_running=False, next_update=None
            )
            return

        delay = self.update_start_delay
        self.write_state(
            updater_enabled=True,
            updater_running=False,
            next_update=future_time(delay),
        )
        while not self.stop_event.wait(delay):
            self.write_state(updater_running=True, next_update=None)
            self.run_update()
            delay = self.update_interval
            self.write_state(
                updater_running=False,
                next_update=future_time(delay),
                last_update_finished=utc_now(),
            )

    def run(self) -> int:
        ensure_layout()
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)
        signal.signal(signal.SIGUSR1, self.request_restart)

        threading.Thread(target=self.update_loop, name="updater", daemon=True).start()
        restart_delay = 1.0
        try:
            self.start_mihomo()
            while not self.stop_event.is_set():
                if self.restart_event.is_set():
                    self.restart_event.clear()
                    self.write_state(mihomo_state="restarting")
                    self.stop_mihomo()
                    self.start_mihomo()
                    restart_delay = 1.0
                    continue

                assert self.process is not None
                exit_code = self.process.poll()
                if exit_code is not None:
                    self.write_state(
                        mihomo_pid=None,
                        mihomo_state="exited",
                        last_exit_code=exit_code,
                    )
                    if self.stop_event.wait(restart_delay):
                        break
                    restart_delay = min(restart_delay * 2, 30.0)
                    self.start_mihomo()
                    continue
                self.stop_event.wait(0.2)
        finally:
            self.write_state(mihomo_state="stopping", next_update=None)
            self.stop_mihomo()
            self.write_state(mihomo_pid=None, mihomo_state="stopped")
        return 0


def healthcheck() -> int:
    try:
        with RUNTIME_FILE.open("r", encoding="utf-8") as handle:
            state = json.load(handle)
        if state.get("mihomo_state") != "running" or not manager.process_is_alive(
            state.get("mihomo_pid")
        ):
            return 1
        port = env_int("CONTROLLER_PORT", 9090, minimum=1)
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return 0
    except (OSError, ValueError, json.JSONDecodeError, manager.ManagerError):
        return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Mihomo Console container runtime")
    parser.add_argument("command", nargs="?", choices=("run", "healthcheck"), default="run")
    args = parser.parse_args()
    if args.command == "healthcheck":
        return healthcheck()
    try:
        return ContainerRuntime().run()
    except (manager.ManagerError, OSError) as exc:
        print(f"容器启动失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
