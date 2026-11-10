"""Token-authenticated subscription UI, sharing the console's registry and locks."""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
import hmac
from importlib.metadata import version
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

import mihomo_console as manager

SESSION_SECONDS = 12 * 60 * 60
COOKIE = "mihomo_console_session"
ASSETS = Path(__file__).with_name("web")


class APIError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message, self.status = message, status


def access_token(config: Path) -> str:
    """Persist a random bootstrap secret; never print it during service startup."""
    configured = os.environ.get("MIHOMO_WEB_TOKEN", "").strip()
    if configured:
        if len(configured) < 24:
            raise manager.ManagerError("MIHOMO_WEB_TOKEN must contain at least 24 characters.")
        return configured
    path = config.parent / "web-token"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise manager.ManagerError("The web token file must not be a symbolic link.")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        token = path.read_text(encoding="utf-8").strip()
        if len(token) < 24:
            raise manager.ManagerError("The web token file is invalid; configure MIHOMO_WEB_TOKEN.")
        path.chmod(0o600)
        return token
    token = secrets.token_hex(32)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(token + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return token


class WebService:
    def __init__(self, config: Path, token: str):
        self.config = config
        self.token_hash = hashlib.sha256(token.encode()).digest()
        self.lock = threading.RLock()
        self.sessions: dict[str, dict[str, Any]] = {}
        self.attempts: dict[str, deque[float]] = {}
        self.global_attempts: deque[float] = deque(maxlen=100)
        self.jobs: deque[dict[str, Any]] = deque(maxlen=20)

    @staticmethod
    def session_key(value: str) -> str:
        return hashlib.sha256(value.encode()).hexdigest()

    def login(self, token: str, address: str) -> tuple[str, str]:
        now = time.monotonic()
        with self.lock:
            self.attempts = {ip: deque(t for t in times if now - t < 60)
                             for ip, times in self.attempts.items() if times and now - times[-1] < 60}
            while self.global_attempts and now - self.global_attempts[0] >= 60:
                self.global_attempts.popleft()
            if len(self.attempts.get(address, ())) >= 10 or len(self.global_attempts) >= 100:
                raise APIError("Too many login attempts. Try again in one minute.", 429)
            if not hmac.compare_digest(hashlib.sha256(token.encode()).digest(), self.token_hash):
                self.attempts.setdefault(address, deque(maxlen=10)).append(now)
                self.global_attempts.append(now)
                raise APIError("Invalid access token.", 401)
            self.attempts.pop(address, None)
            self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
            if len(self.sessions) >= 128:
                self.sessions.pop(next(iter(self.sessions)))
            cookie, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[self.session_key(cookie)] = {"csrf": csrf, "expires": now + SESSION_SECONDS}
            return cookie, csrf

    def session(self, cookie: str) -> dict[str, Any] | None:
        with self.lock:
            key = self.session_key(cookie)
            value = self.sessions.get(key)
            if value and value["expires"] > time.monotonic():
                return value.copy()
            self.sessions.pop(key, None)
            return None

    def idle(self) -> None:
        if any(job["status"] == "running" for job in self.jobs):
            raise APIError("An update is running. Wait for it to finish.", 409)

    def redact(self, value: object, registry: dict[str, Any]) -> str:
        text = str(value)
        for details in registry["subscriptions"].values():
            for key in ("url", "download_proxy"):
                if details.get(key):
                    text = text.replace(str(details[key]), "[redacted]")
        try:
            config = manager.read_yaml_mapping(Path(registry["target_config"]))
        except (manager.ManagerError, OSError):
            config = {}
        def redact_credentials(node):
            nonlocal text
            if isinstance(node, dict):
                for key, item in node.items():
                    if key in {"secret", "password", "uuid", "private-key", "token", "auth-str"} and isinstance(item, str) and item:
                        text = text.replace(item, "[redacted]")
                    else:
                        redact_credentials(item)
            elif isinstance(node, list):
                for item in node:
                    redact_credentials(item)
        redact_credentials(config)
        # Only expose a short diagnostic, using the existing URL redaction.
        return manager.sanitize_history_error(registry, text)

    def state(self) -> dict[str, Any]:
        registry = manager.load_registry(self.config)
        status = manager.collect_status(self.config, registry)
        subscriptions = []
        for name, details in registry["subscriptions"].items():
            try:
                source = urlsplit(str(details.get("url", ""))).hostname or ""
            except ValueError:
                source = ""
            subscriptions.append({
                "name": name, "source": source, "selected": name == registry.get("active"),
                "user_agent": details.get("user_agent", "clash.meta"),
                "has_download_proxy": bool(details.get("download_proxy")),
                "last_success": details.get("last_success"),
                "last_result": details.get("last_result", "no-record"),
                "last_error": self.redact(details["last_error"], registry) if details.get("last_error") else None,
            })
        with self.lock:
            jobs = [dict(job) for job in self.jobs]
        history = [{key: entry.get(key) for key in ("status", "finished_at", "duration_seconds", "rolled_back")}
                   | {"name": entry.get("subscription", ""), "error": self.redact(entry["error"], registry) if entry.get("error") else None}
                   for entry in reversed(registry["history"][-15:])]
        schedule_enabled = status["timer_enabled"] == "enabled"
        if registry.get("service_backend") == "container" and "enabled" in registry.get("update_schedule", {}):
            schedule_enabled = registry["update_schedule"]["enabled"]
        return {
            "subscriptions": subscriptions, "history": history, "jobs": jobs,
            "service": status["mihomo_service"], "summary": status["summary"],
            "active": registry.get("active"),
            "schedule": {"interval": status["update_interval"], "enabled": schedule_enabled,
                         "next_update": status["timer_next"]},
        }

    def save_subscription(self, data: dict[str, Any], *, editing: bool = False) -> None:
        name = data.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or not manager.NAME_RE.fullmatch(name):
            raise APIError("Use a subscription name of 1–120 characters, without slashes or control characters.")
        if any(ord(char) < 32 for char in name):
            raise APIError("The subscription name contains control characters.")
        with self.lock:
            self.idle()
            registry = manager.load_registry(self.config)
            with manager.operation_lock(registry):
                registry = manager.load_registry(self.config)
                exists = name in registry["subscriptions"]
                if editing != exists:
                    raise APIError("Subscription not found." if editing else "A subscription with this name already exists.", 404 if editing else 409)
                details = registry["subscriptions"].get(name, {}).copy()
                for key in ("url", "download_proxy", "user_agent"):
                    if key not in data:
                        continue
                    value = data[key]
                    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 32 for c in value):
                        raise APIError("Invalid subscription field.")
                    value = value.strip()
                    if key in {"url", "download_proxy"} and value:
                        try:
                            parsed = urlsplit(value)
                            if not parsed.hostname or any(char.isspace() for char in value):
                                raise ValueError()
                            parsed.port  # Reject malformed or out-of-range ports.
                            manager.validate_subscription_url(value)
                        except (ValueError, manager.ManagerError) as exc:
                            raise APIError("Enter a valid HTTP or HTTPS URL.") from exc
                    details[key] = value
                if not details.get("url"):
                    raise APIError("Enter a Clash/Mihomo subscription URL.")
                details.setdefault("user_agent", "clash.meta")
                if "url" in data:
                    # A changed source has not yet been checked or applied.
                    for key in ("last_success", "last_result", "last_error", "last_sha256"):
                        details.pop(key, None)
                registry["subscriptions"][name] = details
                if registry.get("active") is None:
                    registry["active"] = name
                manager.save_registry(self.config, registry)

    def change_subscription(self, name: str, action: str) -> None:
        with self.lock:
            self.idle()
            registry = manager.load_registry(self.config)
            with manager.operation_lock(registry):
                registry = manager.load_registry(self.config)
                if name not in registry["subscriptions"]:
                    raise APIError("Subscription not found.", 404)
                if action == "select":
                    registry["active"] = name
                else:
                    del registry["subscriptions"][name]
                    if registry.get("active") == name:
                        # Removing the selected source never starts updating a different one.
                        registry["active"] = None
                manager.save_registry(self.config, registry)

    def start_job(self, name: str, dry_run: bool) -> dict[str, Any]:
        with self.lock:
            self.idle()
            registry = manager.load_registry(self.config)
            if name not in registry["subscriptions"]:
                raise APIError("Subscription not found.", 404)
            # Check the shared CLI/timer lock before accepting work.
            with manager.operation_lock(registry):
                pass
            job = {"id": secrets.token_hex(12), "name": name, "action": "validate" if dry_run else "update",
                   "status": "running", "started_at": manager.now_iso(), "finished_at": None, "error": None}
            self.jobs.appendleft(job)
            threading.Thread(target=self.run_job, args=(job, dry_run), daemon=True, name="web-subscription-update").start()
            return dict(job)

    def run_job(self, job: dict[str, Any], dry_run: bool) -> None:
        command = [sys.executable, manager.__file__, "--lang", "en_US", "--manager-config", str(self.config), "update"]
        if dry_run:
            command.append("--dry-run")
        # End option parsing so a subscription name can never become a CLI option.
        command.extend(["--", job["name"]])
        try:
            # File-backed output avoids unbounded captured child output in memory.
            import tempfile
            with tempfile.TemporaryFile() as output:
                result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                        timeout=300, check=False, env={**os.environ, "PYTHONUNBUFFERED": "1"})
                output.seek(0, os.SEEK_END)
                output.seek(max(0, output.tell() - 4000))
                diagnostic = output.read().decode("utf-8", errors="replace")
            status = "succeeded" if result.returncode == 0 else "failed"
            error = self.redact(diagnostic, manager.load_registry(self.config)) if result.returncode else None
        except subprocess.TimeoutExpired:
            status, error = "failed", "Update timed out. Check the Mihomo status and recent results before retrying."
        except (OSError, manager.ManagerError):
            status, error = "failed", "Could not run the update. Check the console configuration and file permissions."
        with self.lock:
            job.update(status=status, error=error, finished_at=manager.now_iso())


def create_app(config: Path, *, token: str | None = None) -> Flask:
    if tuple(int(part) for part in version("Flask").split(".")[:2]) < (3, 1):
        raise manager.ManagerError("The web UI requires Flask 3.1 or later; install requirements.txt in a virtual environment.")
    config = Path(config)
    service = WebService(config, token or access_token(config))
    app = Flask(__name__, static_folder=None)
    app.config.update(MAX_CONTENT_LENGTH=64 * 1024)
    public_url = os.environ.get("MIHOMO_WEB_PUBLIC_URL", "").strip().rstrip("/")
    if public_url:
        parsed = urlsplit(public_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise manager.ManagerError("MIHOMO_WEB_PUBLIC_URL must be an HTTPS origin without a path.")
    hosts = os.environ.get("MIHOMO_WEB_TRUSTED_HOSTS", "")
    if hosts:
        app.config["TRUSTED_HOSTS"] = [host.strip() for host in hosts.split(",") if host.strip()]
    app.extensions["mihomo_web"] = service
    secure_cookie = bool(public_url) or os.environ.get("MIHOMO_WEB_SECURE_COOKIE", "").lower() in {"1", "true", "yes"}

    @app.before_request
    def authorize():
        if not request.path.startswith("/api/"):
            return None
        if request.method not in {"GET", "HEAD"}:
            if not request.is_json:
                raise APIError("Send an application/json request.", 415)
            origin = request.headers.get("Origin")
            if origin and origin != (public_url or request.host_url.rstrip("/")):
                raise APIError("Cross-origin requests are not allowed.", 403)
            if request.headers.get("Sec-Fetch-Site") == "cross-site":
                raise APIError("Cross-origin requests are not allowed.", 403)
        if request.path == "/api/login" and request.method == "POST":
            return None
        session = service.session(request.cookies.get(COOKIE, ""))
        if not session:
            raise APIError("Your session has expired. Log in again.", 401)
        g.session = session
        if request.method not in {"GET", "HEAD"} and not hmac.compare_digest(request.headers.get("X-CSRF-Token", "").encode(), session["csrf"].encode()):
            raise APIError("Refresh the page before retrying this action.", 403)

    @app.after_request
    def headers(response):
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        })
        return response

    @app.errorhandler(APIError)
    def api_error(error):
        response = jsonify(error=error.message)
        response.status_code = error.status
        if error.status == 429:
            response.headers["Retry-After"] = "60"
        return response

    @app.errorhandler(manager.ConcurrentUpdateError)
    def concurrent_error(_error):
        return jsonify(error="Another console or scheduled update is running. Try again when it finishes."), 409

    @app.errorhandler(manager.ManagerError)
    def manager_error(error):
        # Validation errors contain no raw submitted URL; never return OS paths.
        return jsonify(error=manager.sanitize_history_error({"subscriptions": {}}, error)), 400

    @app.errorhandler(OSError)
    def filesystem_error(_error):
        return jsonify(error="Could not access console files. Check the service permissions."), 500

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.name), error.code

    def body() -> dict[str, Any]:
        data = request.get_json()
        if not isinstance(data, dict):
            raise APIError("Expected a JSON object.")
        return data

    @app.get("/")
    def index():
        return send_from_directory(ASSETS, "index.html")

    @app.get("/assets/<path:name>")
    def asset(name):
        if name not in {"app.js", "styles.css", "favicon.svg", "favicon.ico", "favicon-32.png",
                        "app-icon.png", "apple-touch-icon.png"}:
            raise APIError("Not found.", 404)
        return send_from_directory(ASSETS, name)

    @app.post("/api/login")
    def login():
        token_value = body().get("token", "")
        if not isinstance(token_value, str):
            raise APIError("Invalid access token.", 401)
        cookie, csrf = service.login(token_value, request.remote_addr or "unknown")
        # A new login invalidates this browser's previous session.
        with service.lock:
            service.sessions.pop(service.session_key(request.cookies.get(COOKIE, "")), None)
        response = jsonify(csrf=csrf)
        response.set_cookie(COOKIE, cookie, max_age=SESSION_SECONDS, httponly=True,
                            secure=secure_cookie or request.is_secure, samesite="Strict", path="/")
        return response

    @app.get("/api/session")
    def session():
        return jsonify(csrf=g.session["csrf"])

    @app.post("/api/logout")
    def logout():
        with service.lock:
            service.sessions.pop(service.session_key(request.cookies.get(COOKIE, "")), None)
        response = jsonify(ok=True)
        response.delete_cookie(COOKIE, path="/", httponly=True, samesite="Strict", secure=secure_cookie or request.is_secure)
        return response

    @app.get("/api/state")
    def state():
        return jsonify(service.state())

    @app.post("/api/subscriptions")
    def save_subscription():
        data = body()
        editing = data.get("editing", False)
        if not isinstance(editing, bool):
            raise APIError("Invalid edit flag.")
        service.save_subscription(data, editing=editing)
        return jsonify(ok=True), 200 if editing else 201

    @app.post("/api/subscriptions/action")
    def subscription_action():
        data = body()
        name, action = data.get("name"), data.get("action")
        if not isinstance(name, str) or action not in {"select", "remove", "validate", "update"}:
            raise APIError("Invalid subscription action.")
        if action in {"validate", "update"}:
            return jsonify(job=service.start_job(name, action == "validate")), 202
        service.change_subscription(name, action)
        return jsonify(ok=True)

    @app.post("/api/schedule")
    def schedule():
        data = body()
        interval, enabled = data.get("interval"), data.get("enabled")
        if not isinstance(interval, str) or not isinstance(enabled, bool):
            raise APIError("Enter an interval and choose whether automatic updates are enabled.")
        manager.parse_update_interval(interval)
        with service.lock:
            service.idle()
            registry = manager.load_registry(config)
            manager.configure_update_schedule(config, registry, interval, enabled=enabled)
        return jsonify(ok=True)

    return app


def make_server(config: Path, host: str = "127.0.0.1", port: int = 28743):
    if tuple(int(part) for part in version("waitress").split(".")[:3]) < (3, 0, 2):
        raise manager.ManagerError("The web UI requires Waitress 3.0.2 or later; install requirements.txt in a virtual environment.")
    from waitress import create_server
    return create_server(create_app(config), host=host, port=port, threads=4,
                         max_request_body_size=64 * 1024, max_request_header_size=16 * 1024,
                         channel_timeout=30, connection_limit=64, clear_untrusted_proxy_headers=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Mihomo Console web UI")
    parser.add_argument("--manager-config", type=Path, default=manager.DEFAULT_MANAGER_CONFIG)
    parser.add_argument("--host", default=os.environ.get("MIHOMO_WEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("MIHOMO_WEB_PORT", "28743"))
    args = parser.parse_args()
    manager.load_registry(args.manager_config)
    server = make_server(args.manager_config, args.host, args.port)
    print(f"Mihomo Console: http://{args.host}:{args.port}", flush=True)
    print("Retrieve the login token with: mihomo-console web-token", flush=True)
    try:
        server.run()
    finally:
        server.close()


if __name__ == "__main__":
    main()
