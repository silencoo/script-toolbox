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
import signal
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

# Keep translations embedded so installing this single script remains sufficient.
EN_MESSAGES: dict[str, str] = {
    "{description}的顶层必须是 YAML/JSON 映射": "{description} must be a YAML/JSON mapping at the top level",
    "无法读取 {path}: {value2}": "Cannot read {path}: {value2}",
    "{path} 不是有效 YAML: {exc}": "{path} is not valid YAML: {exc}",
    "订阅返回内容不是 UTF-8 文本": "The subscription response is not UTF-8 text",
    "订阅配置": "Subscription profile",
    "订阅返回内容不是有效 YAML: {exc}": "The subscription response is not valid YAML: {exc}",
    "订阅配置既没有非空 proxies，也没有 proxy-providers；拒绝覆盖": "The subscription has neither non-empty proxies nor proxy-providers; refusing to replace the configuration",
    "尚未初始化：请先运行 sudo {value1} init": "Not initialized: run sudo {value1} init first",
    "无法读取管理配置 {path}: {exc}": "Cannot read manager configuration {path}: {exc}",
    "history 必须是 JSON 数组": "history must be a JSON array",
    "配置": "Configuration",
    "未知错误": "Unknown error",
    "订阅地址必须是有效的 http:// 或 https:// URL": "The subscription address must be a valid http:// or https:// URL",
    "订阅响应超过 20 MiB，已拒绝": "The subscription response exceeds 20 MiB; rejected",
    "订阅服务器返回了无效的 gzip 内容": "The subscription server returned invalid gzip content",
    "下载失败：HTTP {value1}": "Download failed: HTTP {value1}",
    "网络错误": "Network error",
    "下载失败：{reason_name}": "Download failed: {reason_name}",
    "下载失败：{value1}": "Download failed: {value1}",
    "订阅返回了空内容": "The subscription response is empty",
    "找不到命令：{value1}": "Command not found: {value1}",
    "命令执行超时：{value1}": "Command timed out: {value1}",
    "Mihomo 配置校验失败：\n{details}": "Mihomo configuration validation failed:\n{details}",
    "systemctl restart {service} 失败：{value2}": "systemctl restart {service} failed: {value2}",
    "{service} 重启后未能连续 {SERVICE_STABILITY_SECONDS:g} 秒保持运行状态": "{service} did not stay active for {SERVICE_STABILITY_SECONDS:g} consecutive seconds after restarting",
    "容器监督进程未运行，无法重启 Mihomo": "The container supervisor is not running; cannot restart Mihomo",
    "无法通知容器监督进程重启 Mihomo：{exc}": "Cannot notify the container supervisor to restart Mihomo: {exc}",
    "容器内 Mihomo 重启后未能连续 {SERVICE_STABILITY_SECONDS:g} 秒保持运行状态": "Mihomo did not stay running for {SERVICE_STABILITY_SECONDS:g} consecutive seconds after restarting in the container",
    "systemd 沙箱要求使用绝对路径：{path}": "The systemd sandbox requires absolute paths: {path}",
    "路径包含不允许的控制字符：{path!s}": "Path contains disallowed control characters: {path!s}",
    "配置 systemd 沙箱需要 root 权限": "Configuring the systemd sandbox requires root privileges",
    "无法创建 systemd 所需目录 {directory}: {exc}": "Cannot create directory required by systemd {directory}: {exc}",
    "无法设置备份目录权限 {backup_dir}: {exc}": "Cannot set backup directory permissions for {backup_dir}: {exc}",
    "Mihomo 工作目录不存在：{mihomo_home}": "Mihomo home directory does not exist: {mihomo_home}",
    "无法写入 systemd drop-in {dropin}: {exc}": "Cannot write systemd drop-in {dropin}: {exc}",
    "systemctl daemon-reload 失败：{value1}": "systemctl daemon-reload failed: {value1}",
    "已更新 systemd 沙箱写入路径：{dropin}": "Updated systemd sandbox writable paths: {dropin}",
    "找不到订阅：{name}": "Subscription not found: {name}",
    "另一个更新任务正在运行": "Another update is already running",
    "正在下载订阅“{name}”……": "Downloading subscription \"{name}\"…",
    "正在用 Mihomo 校验候选配置……": "Validating the candidate configuration with Mihomo…",
    "校验通过（仅校验，SHA-256: {value1}…），未替换配置。": "Validation passed (dry-run, SHA-256: {value1}…); configuration was not replaced.",
    "生成结果与当前配置相同，无需重启 Mihomo。": "The generated configuration is unchanged; no Mihomo restart is needed.",
    "配置已原子替换，正在重启 Mihomo……": "Configuration replaced atomically; restarting Mihomo…",
    "{restart_error}；没有旧配置可回滚": "{restart_error}; no previous configuration is available for rollback",
    "重启失败，正在恢复上一份配置……": "Restart failed; restoring the previous configuration…",
    "新配置启动失败，且回滚后重启也失败。原备份位于 {backup}。\n回滚错误：{rollback_error}": "The new configuration failed to start, and restarting after rollback also failed. Original backup: {backup}.\nRollback error: {rollback_error}",
    "新配置启动失败，已成功回滚：{restart_error}": "The new configuration failed to start; rollback succeeded: {restart_error}",
    "更新成功，当前订阅为“{name}”。": "Update succeeded; the active subscription is \"{name}\".",
    "警告：无法记录更新失败历史：{history_error}": "Warning: cannot record update failure history: {history_error}",
    "更新失败：{exc}": "Update failed: {exc}",
    "找不到受管理的备份：{backup_name}": "Managed backup not found: {backup_name}",
    "当前配置不存在，拒绝回滚：{target}": "The current configuration does not exist; refusing rollback: {target}",
    "正在用 Mihomo 校验备份 {value1}……": "Validating backup {value1} with Mihomo…",
    "备份已原子恢复，正在重启 Mihomo……": "Backup restored atomically; restarting Mihomo…",
    "恢复的配置启动失败，正在还原回滚前配置……": "The restored configuration failed to start; recovering the pre-rollback configuration…",
    "备份恢复失败，且还原回滚前配置后仍无法启动。安全备份位于 {safety_backup}。\n恢复错误：{recovery_error}": "The backup failed to start, and recovering the pre-rollback configuration also failed. Safety backup: {safety_backup}.\nRecovery error: {recovery_error}",
    "警告：无法记录回滚失败历史：{history_error}": "Warning: cannot record rollback failure history: {history_error}",
    "备份启动失败，已恢复回滚前配置：{exc}": "The backup failed to start; the pre-rollback configuration was recovered: {exc}",
    "已恢复备份 {value1}，Mihomo 运行正常。": "Restored backup {value1}; Mihomo is running normally.",
    "  Mihomo 服务:   {value1}": "  Mihomo service: {value1}",
    "  更新定时器:    {value1} / {value2}": "  Update timer:   {value1} / {value2}",
    "  下次更新:      {value1}": "  Next update:    {value1}",
    "未知": "Unknown",
    "  当前订阅:      {value1}": "  Subscription:   {value1}",
    "未设置": "Not set",
    "  上次结果:      {value1}": "  Last result:    {value1}",
    "  上次成功:      {value1}": "  Last success:   {value1}",
    "从未": "Never",
    "  配置文件:      {value1}": "  Config file:    {value1}",
    "  配置 SHA-256:  {value1}…": "  Config SHA-256: {value1}…",
    "  配置摘要:      {value1} 节点 / {value2} 节点提供器 / {value3} 组 / {value4} 规则": "  Summary:        {value1} proxies / {value2} providers / {value3} groups / {value4} rules",
    "  最近错误:      {value1}": "  Recent error:   {value1}",
    "尚无更新或回滚历史。": "No update or rollback history yet.",
    "更新": "Update",
    "回滚": "Rollback",
    "  错误：{value1}": "  Error: {value1}",
    "尚无备份。": "No backups yet.",
    "{value1}  {value2}  {value3} 字节  {value4} 节点  {value5}…": "{value1}  {value2}  {value3} bytes  {value4} proxies  {value5}…",
    "暂无日志。": "No logs yet.",
    "无法读取日志：{exc}": "Cannot read logs: {exc}",
    "external-controller 监听地址": "external-controller listen address",
    "提示：控制 API 将暴露到局域网；请同时限制防火墙并使用强 Secret。": "Note: the control API will be exposed to the LAN; restrict firewall access and use a strong secret.",
    "要手动输入 Secret 吗（否则自动生成 64 位随机值）": "Enter a secret manually (otherwise generate a random 64-character value)",
    "输入 Secret: ": "Enter secret: ",
    "再次输入 Secret: ": "Enter secret again: ",
    "Secret 为空或两次输入不一致": "The secret is empty or the two entries do not match",
    "要轮换现有 Secret 吗": "Rotate the existing secret",
    "允许的 Dashboard Origin（逗号分隔；例如 http://192.168.1.10:3000）": "Allowed dashboard origins (comma-separated; e.g. http://192.168.1.10:3000)",
    "本地覆盖已保存到 {path}（权限 0600）。": "Local overrides saved to {path} (mode 0600).",
    "{manager_config} 已存在；如需覆盖请使用 init --force": "{manager_config} already exists; use init --force to overwrite it",
    "初始化 Mihomo Console。直接回车可使用检测到的默认值。": "Initialize Mihomo Console. Press Enter to accept the detected defaults.",
    "Mihomo 主配置路径": "Mihomo configuration path",
    "Mihomo 工作目录": "Mihomo home directory",
    "Mihomo 可执行文件": "Mihomo executable",
    "systemd 服务名": "systemd service name",
    "本地覆盖 YAML 路径": "Local overrides YAML path",
    "备份目录": "Backup directory",
    "管理配置已保存到 {manager_config}（权限 0600）。": "Manager configuration saved to {manager_config} (mode 0600).",
    "已自动生成 Secret。为避免出现在终端历史中，这里不直接显示；可显式运行 show-secret 查看。": "A secret was generated. It is hidden from terminal output; run show-secret explicitly to view it.",
    "订阅名称": "Subscription name",
    "订阅名称不能为空，且不能包含 /、换行或 NUL": "The subscription name cannot be empty or contain /, newlines, or NUL",
    "同名订阅已存在，覆盖吗": "A subscription with this name already exists; overwrite it",
    "订阅 URL（隐藏输入）: ": "Subscription URL (hidden input): ",
    "下载 User-Agent": "Download User-Agent",
    "下载代理 URL（可留空；例如 http://127.0.0.1:7890）": "Download proxy URL (optional; e.g. http://127.0.0.1:7890)",
    "设为当前订阅吗": "Set as the active subscription",
    "已保存订阅“{name}”；URL 仅保存在权限 0600 的管理配置中。": "Saved subscription \"{name}\"; its URL is stored only in the manager configuration with mode 0600.",
    "尚未配置订阅。": "No subscriptions configured.",
    "从未成功更新": "Never updated successfully",
    "，使用下载代理": ", using a download proxy",
    "当前订阅已切换为“{name}”。运行 update-active 才会下载并应用。": "The active subscription is now \"{name}\". Run update-active to download and apply it.",
    "确认删除订阅“{name}”吗（不会删除当前 Mihomo 配置）": "Delete subscription \"{name}\" (the current Mihomo configuration will be kept)",
    "已删除订阅“{name}”。": "Deleted subscription \"{name}\".",
    "尚未配置订阅": "No subscriptions configured",
    "\nMihomo Console（简易菜单）\n  1. 查看订阅\n  2. 添加/修改订阅\n  3. 选择当前订阅\n  4. 更新当前订阅\n  5. 校验当前订阅（不应用）\n  6. 删除订阅\n  7. 配置本地控制器覆盖\n  8. 显示 Secret\n  0. 退出": "\nMihomo Console (simple menu)\n  1. List subscriptions\n  2. Add/edit subscription\n  3. Select active subscription\n  4. Update active subscription\n  5. Validate active subscription (without applying)\n  6. Delete subscription\n  7. Configure local controller overrides\n  8. Show secret\n  0. Quit",
    "请选择": "Choose an option",
    "设为当前的订阅": "Subscription to activate",
    "尚未选择当前订阅": "No active subscription selected",
    "要删除的订阅": "Subscription to delete",
    "无效选项。": "Invalid option.",
    "错误：{exc}": "Error: {exc}",
    "概览": "Overview",
    "订阅": "Profiles",
    "历史": "History",
    "备份": "Backups",
    "日志": "Logs",
    "r 刷新 · Tab 切换页面 · ? 帮助 · q 退出": "r Refresh · Tab Pages · ? Help · q Quit",
    "终端过小：Mihomo Console 至少需要 70×18。": "Terminal too small: Mihomo Console requires at least 70×18.",
    "当前大小：{width}×{height}，按 q 退出。": "Current size: {width}×{height}. Press q to quit.",
    "安全订阅与运行管理": "Subscription & runtime management",
    "l 中文 / English · ? 帮助 · q 退出": "l English / 中文 · ? Help · q Quit",
    "当前订阅": "Subscription",
    "上次结果": "Last result",
    "上次成功": "Last success",
    "自动更新": "Auto update",
    "下次运行": "Next run",
    "配置摘要": "Summary",
    "{value1} 节点 · {value2} 节点提供器 · {value3} 组 · {value4} 规则": "{value1} proxies · {value2} providers · {value3} groups · {value4} rules",
    "备份/历史": "Backups/history",
    "配置文件": "Config file",
    "运行概览": "Runtime overview",
    "配置哈希": "Config hash",
    "最近错误": "Recent error",
    "u 更新 · d 仅校验 · r 刷新 · Tab 切换": "u Update · d Validate only · r Refresh · Tab Pages",
    "名称": "Name",
    "尚未配置订阅，按 a 添加。": "No subscriptions configured. Press a to add one.",
    "↑↓ 选择 · Enter 激活 · u 更新 · d 校验 · a 编辑 · x 删除": "↑↓ Select · Enter Activate · u Update · d Validate · a Edit · x Delete",
    "最近操作（不记录 URL、Secret 或节点凭据）": "Recent operations (URLs, secrets and credentials are excluded)",
    "尚无历史；下一次校验、更新或回滚后会出现在这里。": "No history yet; validate, update or restore a backup to add an entry.",
    "r 刷新 · Tab 切换 · q 退出": "r Refresh · Tab Pages · q Quit",
    "配置备份": "Configuration backups",
    "大小": "Size",
    "节点": "Proxies",
    "尚无备份；首次实际更新时会自动创建。": "No backups yet; the first applied update creates one automatically.",
    "↑↓ 选择 · Enter 恢复 · r 刷新 · Tab 切换": "↑↓ Select · Enter Restore · r Refresh · Tab Pages",
    "日志 · {value1}": "Logs · {value1}",
    "↑↓ 滚动 · t 切换日志 · r 刷新 · Tab 切换": "↑↓ Scroll · t Switch logs · r Refresh · Tab Pages",
    "\n操作完成。": "\nOperation completed.",
    "\n错误：{exc}": "\nError: {exc}",
    "\n已取消。": "\nCancelled.",
    "\n按 Enter 返回 Mihomo Console……": "\nPress Enter to return to Mihomo Console…",
    "全局：1-5 切换页面，Tab/Shift-Tab 前后切换，r 刷新，l 切换语言，q 退出。\n概览：u 更新当前订阅，d 仅下载并校验。\n订阅：方向键选择，Enter 激活，u 更新，d 校验，a 添加，x 删除。\n备份：方向键选择，Enter 校验并恢复；恢复失败会自动还原。\n日志：方向键滚动，t 在更新服务和 Mihomo 服务之间切换。\n\nTUI 不会显示订阅 URL、Secret 或节点凭据。": "Global: 1-5 select pages, Tab/Shift-Tab cycle pages, r refreshes, l switches language, q quits.\nOverview: u updates the active subscription; d downloads and validates only.\nProfiles: arrows select, Enter activates, u updates, d validates, a adds, x deletes.\nBackups: arrows select; Enter validates and restores, with automatic recovery on failure.\nLogs: arrows scroll; t switches between updater and Mihomo service logs.\n\nThe TUI does not display subscription URLs, secrets or proxy credentials.",
    "快捷键": "Keyboard shortcuts",
    "尚未设置当前订阅。": "No active subscription is set.",
    "校验当前订阅": "Validate active subscription",
    "更新当前订阅": "Update active subscription",
    "添加或修改订阅": "Add or edit subscription",
    "激活订阅 {name}": "Activate subscription {name}",
    "校验订阅 {name}": "Validate subscription {name}",
    "更新订阅 {name}": "Update subscription {name}",
    "删除订阅 {name}": "Delete subscription {name}",
    "确认恢复备份 {name} 并重启 Mihomo 吗": "Restore backup {name} and restart Mihomo",
    "已取消。": "Cancelled.",
    "恢复备份 {name}": "Restore backup {name}",
    "TUI 需要交互式终端；自动任务请使用明确的 CLI 子命令": "The TUI requires an interactive terminal; use explicit CLI subcommands for automated tasks",
    "当前 Python 缺少 curses 模块，无法启动 TUI": "This Python installation lacks curses; cannot start the TUI",
    "无法启动 TUI：{exc}": "Cannot start the TUI: {exc}",
    "本地覆盖中没有设置 Secret": "No secret is configured in the local overrides",
    "Mihomo Console：安全更新、诊断和恢复完整订阅配置": "Mihomo Console: safely update, diagnose and restore complete subscription profiles",
    "管理配置路径（默认：{DEFAULT_MANAGER_CONFIG}）": "Manager configuration path (default: {DEFAULT_MANAGER_CONFIG})",
    "初始化管理配置和本地覆盖": "Initialize manager configuration and local overrides",
    "覆盖已有管理配置": "Overwrite existing manager configuration",
    "进入终端控制台（默认）": "Open the terminal console (default)",
    "进入兼容的简易文本菜单": "Open the simple text menu",
    "显示服务、定时器和当前配置摘要": "Show service, timer and configuration summary",
    "列出订阅（不显示 URL）": "List subscriptions without showing URLs",
    "显示脱敏的更新与回滚历史": "Show sanitized update and rollback history",
    "最多显示多少条（默认 20）": "Maximum number of entries (default: 20)",
    "列出受管理的配置备份": "List managed configuration backups",
    "交互式添加或修改订阅": "Interactively add or edit a subscription",
    "选择当前订阅，但不立即应用": "Select the active subscription without applying it",
    "删除一个订阅": "Delete a subscription",
    "下载并应用指定订阅": "Download and apply the selected subscription",
    "仅下载和校验": "Download and validate only",
    "下载并应用当前订阅": "Download and apply the active subscription",
    "校验并恢复一个配置备份": "Validate and restore a configuration backup",
    "backups 命令列出的备份文件名": "Backup filename from the backups command",
    "跳过交互确认": "Skip interactive confirmation",
    "配置控制 API、Secret 和 CORS 覆盖": "Configure control API, secret and CORS overrides",
    "按当前路径生成自动更新服务的 systemd 沙箱配置": "Generate the updater systemd sandbox configuration for the current paths",
    "显式输出当前 Secret": "Explicitly print the current secret",
    "确认恢复备份 {value1} 并重启 Mihomo 吗": "Restore backup {value1} and restart Mihomo",
    "未知命令：{command}": "Unknown command: {command}",
    "缺少 PyYAML，请先运行：sudo apt install python3-yaml": "PyYAML is required; run: sudo apt install python3-yaml",
    "运行中": "Active",
    "未运行": "Inactive",
    "启动中": "Starting",
    "停止中": "Stopping",
    "重新加载中": "Reloading",
    "等待中": "Waiting",
    "已停止": "Stopped",
    "已启用": "Enabled",
    "已禁用": "Disabled",
    "临时启用": "Enabled (runtime)",
    "已屏蔽": "Masked",
    "临时屏蔽": "Masked (runtime)",
    "静态单元": "Static",
    "间接启用": "Indirect",
    "已生成": "Generated",
    "失败": "Failed",
    "已更新": "Updated",
    "无变化": "Unchanged",
    "校验通过": "Validated",
    "已恢复": "Restored",
    "无记录": "No record",
    "界面语言：auto 跟随环境，zh_CN 中文，en_US 英文": "Interface language: auto follows the environment, zh_CN Chinese, en_US English",
    "显示帮助并退出": "Show this help message and exit",
    "命令与参数": "Commands and arguments",
    "选项": "Options",
    "用法：": "Usage: "
}


def resolve_language(requested: str = "auto", environ: dict[str, str] | None = None) -> str:
    """CLI > app environment > LC_ALL > LC_MESSAGES > LANG; C falls back to Chinese."""
    environment = os.environ if environ is None else environ
    selected = requested
    if selected == "auto":
        selected = environment.get("MIHOMO_CONSOLE_LANG", "auto")
    if not selected or selected == "auto":
        selected = next(
            (environment[key] for key in ("LC_ALL", "LC_MESSAGES", "LANG") if environment.get(key)),
            "C",
        )
    language = selected.lower().replace("-", "_").split(".")[0].split("@")[0]
    return "en_US" if language == "en" or language.startswith("en_") else "zh_CN"


LANGUAGE = resolve_language()


def set_language(requested: str) -> None:
    global LANGUAGE
    LANGUAGE = resolve_language(requested)


def tr(message: str, **values: Any) -> str:
    template = EN_MESSAGES.get(message, message) if LANGUAGE == "en_US" else message
    return template.format(**values) if values else template


# Only presentation translates these stable systemd/runtime/history values.
STATE_MESSAGES = {
    "active": "运行中", "running": "运行中", "inactive": "未运行",
    "activating": "启动中", "starting": "启动中", "deactivating": "停止中",
    "reloading": "重新加载中", "waiting": "等待中", "stopped": "已停止",
    "enabled": "已启用", "disabled": "已禁用", "enabled-runtime": "临时启用",
    "masked": "已屏蔽", "masked-runtime": "临时屏蔽", "static": "静态单元",
    "indirect": "间接启用", "generated": "已生成", "failed": "失败",
    "updated": "已更新", "unchanged": "无变化", "validated": "校验通过",
    "restored": "已恢复", "no-record": "无记录", "unknown": "未知",
}


def format_state(value: object) -> str:
    code = str(value or "unknown")
    return tr(STATE_MESSAGES[code]) if code in STATE_MESSAGES else code


try:
    import yaml
except ImportError:
    print(tr("缺少 PyYAML，请先运行：sudo apt install python3-yaml"), file=sys.stderr)
    raise SystemExit(2)


class MihomoSafeLoader(yaml.SafeLoader):
    """Safe YAML loader that preserves numeric-looking REALITY short IDs."""


def _construct_mihomo_mapping(
    loader: MihomoSafeLoader,
    node: yaml.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping = yaml.SafeLoader.construct_mapping(loader, node, deep=deep)
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if (
            key == "short-id"
            and isinstance(value_node, yaml.ScalarNode)
            and value_node.tag == "tag:yaml.org,2002:int"
        ):
            mapping[key] = value_node.value
    return mapping


MihomoSafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_mihomo_mapping,
)


class _QuotedString(str):
    """A string that must remain a YAML string for Mihomo's Go YAML parser."""


class MihomoSafeDumper(yaml.SafeDumper):
    pass


MihomoSafeDumper.add_representer(
    _QuotedString,
    lambda dumper, value: dumper.represent_scalar(
        "tag:yaml.org,2002:str",
        str(value),
        style='"',
    ),
)


DEFAULT_MANAGER_CONFIG = Path(
    os.environ.get("MIHOMO_MANAGER_CONFIG", "/etc/mihomo/subscription-manager.json")
)
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
    "service_backend": "systemd",
    "systemd_service": "mihomo.service",
    "runtime_file": "/run/mihomo-console/runtime.json",
    "container_log_dir": "/data/logs",
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


class ConcurrentUpdateError(ManagerError):
    """Lock contention is identified independently of the display language."""


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
        raise ManagerError(tr("{description}的顶层必须是 YAML/JSON 映射", description=description))
    return value


def read_yaml_mapping(path: Path, *, missing_ok: bool = False) -> dict[str, Any]:
    if missing_ok and not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as handle:
            return ensure_mapping(yaml.load(handle, Loader=MihomoSafeLoader), str(path))
    except OSError as exc:
        raise ManagerError(tr("无法读取 {path}: {value2}", path=path, value2=exc.strerror or exc)) from exc
    except yaml.YAMLError as exc:
        raise ManagerError(tr("{path} 不是有效 YAML: {exc}", path=path, exc=exc)) from exc


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge mappings recursively; scalars and lists in overlay replace the base."""
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def normalize_mihomo_compatibility(profile: dict[str, Any]) -> None:
    """Apply lossless compatibility fixes required by current Mihomo releases."""

    legacy_fingerprint = profile.pop("global-client-fingerprint", None)
    proxies = profile.get("proxies")
    if not isinstance(proxies, list):
        return

    fingerprint_proxy_types = {"vmess", "vless", "trojan", "anytls"}
    for proxy in proxies:
        if not isinstance(proxy, dict):
            continue

        proxy_type = str(proxy.get("type", "")).lower()
        reality_options = proxy.get("reality-opts")
        uses_tls = (
            proxy.get("tls") is True
            or proxy_type in {"trojan", "anytls"}
            or isinstance(reality_options, dict)
        )
        if (
            isinstance(legacy_fingerprint, str)
            and legacy_fingerprint
            and proxy_type in fingerprint_proxy_types
            and uses_tls
            and "client-fingerprint" not in proxy
            and not isinstance(proxy.get("ech-opts"), dict)
        ):
            proxy["client-fingerprint"] = legacy_fingerprint

        if isinstance(reality_options, dict):
            short_id = reality_options.get("short-id")
            if isinstance(short_id, str):
                reality_options["short-id"] = _QuotedString(short_id)


def render_profile(remote_bytes: bytes, overlay: dict[str, Any]) -> bytes:
    try:
        remote_text = remote_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ManagerError(tr("订阅返回内容不是 UTF-8 文本")) from exc

    try:
        remote = ensure_mapping(
            yaml.load(remote_text, Loader=MihomoSafeLoader),
            tr("订阅配置"),
        )
    except yaml.YAMLError as exc:
        raise ManagerError(tr("订阅返回内容不是有效 YAML: {exc}", exc=exc)) from exc

    proxies = remote.get("proxies")
    providers = remote.get("proxy-providers")
    if not (isinstance(proxies, list) and proxies) and not (
        isinstance(providers, dict) and providers
    ):
        raise ManagerError(tr("订阅配置既没有非空 proxies，也没有 proxy-providers；拒绝覆盖"))

    merged = deep_merge(remote, overlay)
    normalize_mihomo_compatibility(merged)
    rendered = yaml.dump(
        merged,
        Dumper=MihomoSafeDumper,
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
        raise ManagerError(tr("尚未初始化：请先运行 sudo {value1} init", value1=Path(sys.argv[0]).name)) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ManagerError(tr("无法读取管理配置 {path}: {exc}", path=path, exc=exc)) from exc

    registry = copy.deepcopy(DEFAULTS)
    registry.update(loaded)
    registry["subscriptions"] = ensure_mapping(registry.get("subscriptions"), "subscriptions")
    history = registry.get("history")
    if not isinstance(history, list):
        raise ManagerError(tr("history 必须是 JSON 数组"))
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
        profile = ensure_mapping(yaml.safe_load(data.decode("utf-8-sig")), tr("配置"))
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
            details["last_error"] = str(event.get("error") or tr("未知错误"))[:1000]
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
        raise ManagerError(tr("订阅地址必须是有效的 http:// 或 https:// URL"))


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
                raise ManagerError(tr("订阅响应超过 20 MiB，已拒绝"))
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise ManagerError(tr("订阅响应超过 20 MiB，已拒绝"))
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                try:
                    data = gzip.decompress(data)
                except gzip.BadGzipFile as exc:
                    raise ManagerError(tr("订阅服务器返回了无效的 gzip 内容")) from exc
    except urllib.error.HTTPError as exc:
        raise ManagerError(tr("下载失败：HTTP {value1}", value1=exc.code)) from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        reason_name = type(reason).__name__ if reason is not None else tr("网络错误")
        raise ManagerError(tr("下载失败：{reason_name}", reason_name=reason_name)) from exc
    except (OSError, ValueError) as exc:
        raise ManagerError(tr("下载失败：{value1}", value1=type(exc).__name__)) from exc

    if not data.strip():
        raise ManagerError(tr("订阅返回了空内容"))
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
        raise ManagerError(tr("找不到命令：{value1}", value1=command[0])) from exc
    except subprocess.TimeoutExpired as exc:
        raise ManagerError(tr("命令执行超时：{value1}", value1=command[0])) from exc


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
        raise ManagerError(tr("Mihomo 配置校验失败：\n{details}", details=details))


def restart_mihomo(registry: dict[str, Any]) -> None:
    if str(registry.get("service_backend") or "systemd") == "container":
        restart_container_mihomo(registry)
        return

    service = str(registry["systemd_service"])
    result = command_output(["systemctl", "restart", service], timeout=60)
    if result.returncode != 0:
        raise ManagerError(tr("systemctl restart {service} 失败：{value2}", service=service, value2=result.stdout.strip()[-2000:]))

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
        tr("{service} 重启后未能连续 {SERVICE_STABILITY_SECONDS:g} 秒保持运行状态", service=service, SERVICE_STABILITY_SECONDS=SERVICE_STABILITY_SECONDS)
    )


def process_is_alive(pid: object) -> bool:
    try:
        value = int(pid)
        if value <= 0:
            return False
        os.kill(value, 0)
        return True
    except (TypeError, ValueError, ProcessLookupError, PermissionError):
        return False


def read_container_runtime(registry: dict[str, Any]) -> dict[str, Any]:
    path = Path(str(registry.get("runtime_file") or DEFAULTS["runtime_file"]))
    try:
        with path.open("r", encoding="utf-8") as handle:
            return ensure_mapping(json.load(handle), str(path))
    except (FileNotFoundError, OSError, json.JSONDecodeError, ManagerError):
        return {}


def container_mihomo_is_active(registry: dict[str, Any]) -> bool:
    runtime = read_container_runtime(registry)
    return runtime.get("mihomo_state") == "running" and process_is_alive(
        runtime.get("mihomo_pid")
    )


def restart_container_mihomo(registry: dict[str, Any]) -> None:
    runtime = read_container_runtime(registry)
    supervisor_pid = runtime.get("supervisor_pid")
    if not process_is_alive(supervisor_pid):
        raise ManagerError(tr("容器监督进程未运行，无法重启 Mihomo"))

    previous_generation = int(runtime.get("generation") or 0)
    try:
        os.kill(int(supervisor_pid), signal.SIGUSR1)
    except (OSError, TypeError, ValueError) as exc:
        raise ManagerError(tr("无法通知容器监督进程重启 Mihomo：{exc}", exc=exc)) from exc

    deadline = time.monotonic() + SERVICE_START_TIMEOUT_SECONDS
    stable_since: float | None = None
    stable_generation: int | None = None
    while True:
        current = read_container_runtime(registry)
        checked_at = time.monotonic()
        current_generation = int(current.get("generation") or 0)
        restarted = current_generation > previous_generation
        active = current.get("mihomo_state") == "running" and process_is_alive(
            current.get("mihomo_pid")
        )
        if restarted and active:
            if stable_since is None or stable_generation != current_generation:
                stable_since = checked_at
                stable_generation = current_generation
            if checked_at - stable_since >= SERVICE_STABILITY_SECONDS:
                return
        else:
            stable_since = None
            stable_generation = None

        if checked_at >= deadline:
            break
        time.sleep(SERVICE_POLL_INTERVAL_SECONDS)
    raise ManagerError(
        tr("容器内 Mihomo 重启后未能连续 {SERVICE_STABILITY_SECONDS:g} 秒保持运行状态", SERVICE_STABILITY_SECONDS=SERVICE_STABILITY_SECONDS)
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
            raise ManagerError(tr("systemd 沙箱要求使用绝对路径：{path}", path=path))
        path_text = os.path.normpath(str(path))
        if any(ord(character) < 32 or ord(character) == 127 for character in path_text):
            raise ManagerError(tr("路径包含不允许的控制字符：{path!s}", path=path))
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
        raise ManagerError(tr("配置 systemd 沙箱需要 root 权限"))

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
            raise ManagerError(tr("无法创建 systemd 所需目录 {directory}: {exc}", directory=directory, exc=exc)) from exc
    try:
        os.chmod(backup_dir, 0o700)
    except OSError as exc:
        raise ManagerError(tr("无法设置备份目录权限 {backup_dir}: {exc}", backup_dir=backup_dir, exc=exc)) from exc

    mihomo_home = Path(str(registry["mihomo_home"]))
    if not mihomo_home.is_dir():
        raise ManagerError(tr("Mihomo 工作目录不存在：{mihomo_home}", mihomo_home=mihomo_home))

    try:
        secure_atomic_write(
            dropin,
            render_systemd_sandbox_dropin(manager_config, registry),
            mode=0o644,
        )
    except OSError as exc:
        raise ManagerError(tr("无法写入 systemd drop-in {dropin}: {exc}", dropin=dropin, exc=exc)) from exc

    result = command_output(["systemctl", "daemon-reload"], timeout=60)
    if result.returncode != 0:
        raise ManagerError(tr("systemctl daemon-reload 失败：{value1}", value1=result.stdout.strip()[-2000:]))
    print(tr("已更新 systemd 沙箱写入路径：{dropin}", dropin=dropin))


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
        raise ManagerError(tr("找不到订阅：{name}", name=name))

    lock_path = Path(str(registry["lock_file"]))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ConcurrentUpdateError(tr("另一个更新任务正在运行")) from exc

        print(tr("正在下载订阅“{name}”……", name=name))
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

            print(tr("正在用 Mihomo 校验候选配置……"))
            validate_with_mihomo(registry, candidate)
            digest = hashlib.sha256(rendered).hexdigest()
            result_details["sha256"] = digest
            if dry_run:
                result_details["status"] = "validated"
                print(tr("校验通过（仅校验，SHA-256: {value1}…），未替换配置。", value1=digest[:12]))
                return False

            if target.exists() and target.read_bytes() == rendered:
                result_details["status"] = "unchanged"
                print(tr("生成结果与当前配置相同，无需重启 Mihomo。"))
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
                print(tr("配置已原子替换，正在重启 Mihomo……"))
                restart_mihomo(registry)
            except ManagerError as restart_error:
                if backup is None:
                    raise ManagerError(tr("{restart_error}；没有旧配置可回滚", restart_error=restart_error)) from restart_error
                eprint(tr("重启失败，正在恢复上一份配置……"))
                restore_backup(target, backup)
                try:
                    restart_mihomo(registry)
                except ManagerError as rollback_error:
                    raise ManagerError(
                        tr("新配置启动失败，且回滚后重启也失败。原备份位于 {backup}。\n回滚错误：{rollback_error}", backup=backup, rollback_error=rollback_error)
                    ) from rollback_error
                result_details["rolled_back"] = True
                raise ManagerError(tr("新配置启动失败，已成功回滚：{restart_error}", restart_error=restart_error)) from restart_error

            result_details["status"] = "updated"
            registry["active"] = name
            subscriptions[name]["last_success"] = now_iso()
            subscriptions[name]["last_sha256"] = digest
            save_registry(manager_config, registry)
            prune_backups(registry, target)
            print(tr("更新成功，当前订阅为“{name}”。", name=name))
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
        if not isinstance(exc, ConcurrentUpdateError):
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
                eprint(tr("警告：无法记录更新失败历史：{history_error}", history_error=history_error))
        if isinstance(exc, ManagerError):
            raise
        raise ManagerError(tr("更新失败：{exc}", exc=exc)) from exc

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
        raise ManagerError(tr("找不到受管理的备份：{backup_name}", backup_name=backup_name))

    target = Path(str(registry["target_config"]))
    if not target.exists():
        raise ManagerError(tr("当前配置不存在，拒绝回滚：{target}", target=target))

    started_at = now_iso()
    started = time.monotonic()
    print(tr("正在用 Mihomo 校验备份 {value1}……", value1=selected.name))
    validate_with_mihomo(registry, selected)
    safety_backup = make_backup(registry, target)
    assert safety_backup is not None
    try:
        restore_backup(target, selected)
        print(tr("备份已原子恢复，正在重启 Mihomo……"))
        restart_mihomo(registry)
    except (ManagerError, OSError) as exc:
        eprint(tr("恢复的配置启动失败，正在还原回滚前配置……"))
        try:
            restore_backup(target, safety_backup)
            restart_mihomo(registry)
        except (ManagerError, OSError) as recovery_error:
            raise ManagerError(
                tr("备份恢复失败，且还原回滚前配置后仍无法启动。安全备份位于 {safety_backup}。\n恢复错误：{recovery_error}", safety_backup=safety_backup, recovery_error=recovery_error)
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
            eprint(tr("警告：无法记录回滚失败历史：{history_error}", history_error=history_error))
        raise ManagerError(tr("备份启动失败，已恢复回滚前配置：{exc}", exc=exc)) from exc

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
    print(tr("已恢复备份 {value1}，Mihomo 运行正常。", value1=selected.name))


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
    container_backend = str(registry.get("service_backend") or "systemd") == "container"
    if container_backend:
        runtime = read_container_runtime(registry)
        mihomo_service = (
            "active"
            if runtime.get("mihomo_state") == "running"
            and process_is_alive(runtime.get("mihomo_pid"))
            else str(runtime.get("mihomo_state") or "unknown")
        )
        timer_enabled = "enabled" if runtime.get("updater_enabled") else "disabled"
        if not runtime.get("updater_enabled"):
            timer_active = "inactive"
        else:
            timer_active = "active" if runtime.get("updater_running") else "waiting"
        timer_next = str(runtime.get("next_update") or "unknown")
    else:
        timer_next = command_text(
            [
                "systemctl",
                "show",
                DEFAULT_UPDATER_TIMER,
                "--property=NextElapseUSecRealtime",
                "--value",
            ]
        )
        mihomo_service = command_text(
            ["systemctl", "is-active", str(registry["systemd_service"])]
        )
        timer_enabled = command_text(
            ["systemctl", "is-enabled", DEFAULT_UPDATER_TIMER]
        )
        timer_active = command_text(["systemctl", "is-active", DEFAULT_UPDATER_TIMER])
    return {
        "manager_config": str(manager_config),
        "target_config": str(target),
        "active_subscription": active_name,
        "last_success": active_details.get("last_success"),
        "last_result": active_details.get("last_result") or "no-record",
        "last_error": active_details.get("last_error"),
        "mihomo_service": mihomo_service,
        "timer_enabled": timer_enabled,
        "timer_active": timer_active,
        "timer_next": timer_next if timer_next not in {"", "unknown", "n/a"} else None,
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
    print(tr("  Mihomo 服务:   {value1}", value1=format_state(status['mihomo_service'])))
    print(tr("  更新定时器:    {value1} / {value2}", value1=format_state(status['timer_active']), value2=format_state(status['timer_enabled'])))
    print(tr("  下次更新:      {value1}", value1=status['timer_next'] or tr('未知')))
    print(tr("  当前订阅:      {value1}", value1=status['active_subscription'] or tr('未设置')))
    print(tr("  上次结果:      {value1}", value1=format_state(status['last_result'])))
    print(tr("  上次成功:      {value1}", value1=status['last_success'] or tr('从未')))
    print(tr("  配置文件:      {value1}", value1=status['target_config']))
    if status.get("config_sha256"):
        print(tr("  配置 SHA-256:  {value1}…", value1=status['config_sha256'][:12]))
    print(
        tr("  配置摘要:      {value1} 节点 / {value2} 节点提供器 / {value3} 组 / {value4} 规则", value1=summary.get('proxies', 0), value2=summary.get('providers', 0), value3=summary.get('groups', 0), value4=summary.get('rules', 0))
    )
    if status.get("last_error"):
        print(tr("  最近错误:      {value1}", value1=status['last_error']))


def print_history(registry: dict[str, Any], *, limit: int = 20) -> None:
    history = [item for item in registry.get("history", []) if isinstance(item, dict)]
    if not history:
        print(tr("尚无更新或回滚历史。"))
        return
    for event in reversed(history[-max(1, limit) :]):
        kind = tr("更新") if event.get("kind") == "update" else tr("回滚")
        target = event.get("subscription") or event.get("backup") or "-"
        duration = event.get("duration_seconds", "-")
        print(
            f"{event.get('finished_at', '-')}  {kind:<2}  "
            f"{fit_display(format_state(event.get('status')), 12)}  {target}  {duration}s"
        )
        if event.get("error"):
            print(tr("  错误：{value1}", value1=event['error']))


def print_backups(registry: dict[str, Any]) -> None:
    rows = backup_rows(registry)
    if not rows:
        print(tr("尚无备份。"))
        return
    for row in rows:
        summary = row["summary"]
        print(
            tr("{value1}  {value2}  {value3} 字节  {value4} 节点  {value5}…", value1=row['name'], value2=row['modified_at'], value3=row['size'], value4=summary.get('proxies', 0), value5=row['sha256'][:12])
        )


def fetch_journal(
    unit: str, *, registry: dict[str, Any] | None = None, lines: int = 200
) -> list[str]:
    if registry and str(registry.get("service_backend") or "systemd") == "container":
        log_name = (
            "updater.log" if unit == DEFAULT_UPDATER_SERVICE else "mihomo.log"
        )
        path = Path(
            str(registry.get("container_log_dir") or DEFAULTS["container_log_dir"])
        ) / log_name
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                output = handle.readlines()[-max(1, lines) :]
        except FileNotFoundError:
            return [tr("暂无日志。")]
        except OSError as exc:
            return [tr("无法读取日志：{exc}", exc=exc)]
        return [item.rstrip("\n") for item in output] or [tr("暂无日志。")]

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
        return [tr("无法读取日志：{exc}", exc=exc)]
    output = result.stdout.strip()
    return output.splitlines() if output else [tr("暂无日志。")]


def configure_overlay(registry: dict[str, Any], *, initial: bool = False) -> str | None:
    path = Path(str(registry["overlay_file"]))
    overlay = read_yaml_mapping(path, missing_ok=True)
    current_controller = str(overlay.get("external-controller") or "127.0.0.1:9090")
    controller = ask(tr("external-controller 监听地址"), current_controller)

    if controller.startswith("0.0.0.0:") or controller.startswith("[::]:"):
        print(tr("提示：控制 API 将暴露到局域网；请同时限制防火墙并使用强 Secret。"))

    current_secret = str(overlay.get("secret") or "")
    generated: str | None = None
    if initial or not current_secret:
        if confirm(tr("要手动输入 Secret 吗（否则自动生成 64 位随机值）"), False):
            first = getpass.getpass(tr("输入 Secret: "))
            second = getpass.getpass(tr("再次输入 Secret: "))
            if not first or first != second:
                raise ManagerError(tr("Secret 为空或两次输入不一致"))
            current_secret = first
        else:
            current_secret = secrets.token_hex(32)
            generated = current_secret
    elif confirm(tr("要轮换现有 Secret 吗"), False):
        current_secret = secrets.token_hex(32)
        generated = current_secret

    existing_cors = overlay.get("external-controller-cors")
    existing_origins: list[str] = []
    if isinstance(existing_cors, dict) and isinstance(existing_cors.get("allow-origins"), list):
        existing_origins = [str(item) for item in existing_cors["allow-origins"]]
    origins_text = ask(
        tr("允许的 Dashboard Origin（逗号分隔；例如 http://192.168.1.10:3000）"),
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
    print(tr("本地覆盖已保存到 {path}（权限 0600）。", path=path))
    return generated


def initialize(manager_config: Path, *, force: bool = False) -> None:
    if manager_config.exists() and not force:
        raise ManagerError(tr("{manager_config} 已存在；如需覆盖请使用 init --force", manager_config=manager_config))

    registry = copy.deepcopy(DEFAULTS)
    print(tr("初始化 Mihomo Console。直接回车可使用检测到的默认值。"))
    registry["target_config"] = ask(tr("Mihomo 主配置路径"), str(DEFAULTS["target_config"]))
    registry["mihomo_home"] = ask(tr("Mihomo 工作目录"), str(DEFAULTS["mihomo_home"]))
    registry["mihomo_binary"] = ask(tr("Mihomo 可执行文件"), str(DEFAULTS["mihomo_binary"]))
    registry["systemd_service"] = ask(tr("systemd 服务名"), str(DEFAULTS["systemd_service"]))
    registry["overlay_file"] = ask(tr("本地覆盖 YAML 路径"), str(DEFAULTS["overlay_file"]))
    registry["backup_dir"] = ask(tr("备份目录"), str(DEFAULTS["backup_dir"]))
    save_registry(manager_config, registry)
    generated = configure_overlay(registry, initial=True)
    print(tr("管理配置已保存到 {manager_config}（权限 0600）。", manager_config=manager_config))
    if generated:
        print(tr("已自动生成 Secret。为避免出现在终端历史中，这里不直接显示；可显式运行 show-secret 查看。"))


def add_subscription(manager_config: Path, registry: dict[str, Any]) -> None:
    name = ask(tr("订阅名称"))
    if not name or not NAME_RE.fullmatch(name):
        raise ManagerError(tr("订阅名称不能为空，且不能包含 /、换行或 NUL"))
    if name in registry["subscriptions"] and not confirm(tr("同名订阅已存在，覆盖吗"), False):
        return
    url = getpass.getpass(tr("订阅 URL（隐藏输入）: ")).strip()
    validate_subscription_url(url)
    user_agent = ask(tr("下载 User-Agent"), "clash.meta")
    proxy_url = ask(tr("下载代理 URL（可留空；例如 http://127.0.0.1:7890）"))
    if proxy_url:
        validate_subscription_url(proxy_url)
    registry["subscriptions"][name] = {
        "url": url,
        "user_agent": user_agent,
        "download_proxy": proxy_url or None,
    }
    if registry.get("active") is None or confirm(tr("设为当前订阅吗"), True):
        registry["active"] = name
    save_registry(manager_config, registry)
    print(tr("已保存订阅“{name}”；URL 仅保存在权限 0600 的管理配置中。", name=name))


def list_subscriptions(registry: dict[str, Any]) -> None:
    subscriptions = registry["subscriptions"]
    if not subscriptions:
        print(tr("尚未配置订阅。"))
        return
    active = registry.get("active")
    for name, details in subscriptions.items():
        marker = "*" if name == active else " "
        last = details.get("last_success") or tr("从未成功更新")
        proxy = tr("，使用下载代理") if details.get("download_proxy") else ""
        print(f"{marker} {name} — {last}{proxy}")


def activate(manager_config: Path, registry: dict[str, Any], name: str) -> None:
    if name not in registry["subscriptions"]:
        raise ManagerError(tr("找不到订阅：{name}", name=name))
    registry["active"] = name
    save_registry(manager_config, registry)
    print(tr("当前订阅已切换为“{name}”。运行 update-active 才会下载并应用。", name=name))


def remove_subscription(manager_config: Path, registry: dict[str, Any], name: str) -> None:
    if name not in registry["subscriptions"]:
        raise ManagerError(tr("找不到订阅：{name}", name=name))
    if not confirm(tr("确认删除订阅“{name}”吗（不会删除当前 Mihomo 配置）", name=name), False):
        return
    del registry["subscriptions"][name]
    if registry.get("active") == name:
        registry["active"] = next(iter(registry["subscriptions"]), None)
    save_registry(manager_config, registry)
    print(tr("已删除订阅“{name}”。", name=name))


def choose_subscription(registry: dict[str, Any], prompt: str) -> str:
    names = list(registry["subscriptions"])
    if not names:
        raise ManagerError(tr("尚未配置订阅"))
    list_subscriptions(registry)
    default = str(registry.get("active") or names[0])
    name = ask(prompt, default)
    if name not in registry["subscriptions"]:
        raise ManagerError(tr("找不到订阅：{name}", name=name))
    return name


def interactive_menu(manager_config: Path) -> None:
    while True:
        registry = load_registry(manager_config)
        print(
            tr("\nMihomo Console（简易菜单）\n  1. 查看订阅\n  2. 添加/修改订阅\n  3. 选择当前订阅\n  4. 更新当前订阅\n  5. 校验当前订阅（不应用）\n  6. 删除订阅\n  7. 配置本地控制器覆盖\n  8. 显示 Secret\n  0. 退出")
        )
        choice = ask(tr("请选择"))
        try:
            if choice == "0":
                return
            if choice == "1":
                list_subscriptions(registry)
            elif choice == "2":
                add_subscription(manager_config, registry)
            elif choice == "3":
                activate(manager_config, registry, choose_subscription(registry, tr("设为当前的订阅")))
            elif choice in {"4", "5"}:
                active = registry.get("active")
                if not active:
                    raise ManagerError(tr("尚未选择当前订阅"))
                update_profile(manager_config, registry, str(active), dry_run=choice == "5")
            elif choice == "6":
                remove_subscription(manager_config, registry, choose_subscription(registry, tr("要删除的订阅")))
            elif choice == "7":
                configure_overlay(registry)
            elif choice == "8":
                show_secret(registry)
            else:
                print(tr("无效选项。"))
        except ManagerError as exc:
            eprint(tr("错误：{exc}", exc=exc))


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
        self.message = tr("r 刷新 · Tab 切换页面 · ? 帮助 · q 退出")
        self.registry: dict[str, Any] = {}
        self.status: dict[str, Any] = {}
        self.backups: list[dict[str, Any]] = []
        self.logs: list[str] = []

    def refresh(self) -> None:
        self.registry = load_registry(self.manager_config)
        self.status = collect_status(self.manager_config, self.registry)
        self.backups = backup_rows(self.registry)
        self.logs = fetch_journal(self.log_unit, registry=self.registry)
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
            self.put(0, 0, tr("终端过小：Mihomo Console 至少需要 70×18。"))
            self.put(2, 0, tr("当前大小：{width}×{height}，按 q 退出。", width=width, height=height))
            self.screen.refresh()
            return

        title_attr = self.curses.color_pair(1) | self.curses.A_BOLD
        good = self.status.get("mihomo_service") == "active"
        service_attr = self.curses.color_pair(2 if good else 3) | self.curses.A_BOLD
        self.put(0, 0, " MIHOMO CONSOLE ", title_attr)
        if width >= 90:
            self.put(0, 19, tr("安全订阅与运行管理"))
        service = f"mihomo {format_state(self.status.get('mihomo_service'))}"
        self.put(0, max(1, width - display_width(service) - 2), service, service_attr)
        self.put(1, 1, tr("l 中文 / English · ? 帮助 · q 退出"), self.curses.A_DIM)

        nav_column = 1
        for index, name in enumerate(self.PAGES):
            item = f" {index + 1} {tr(name)} "
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
            (tr("当前订阅"), str(self.status.get("active_subscription") or tr("未设置"))),
            (tr("上次结果"), format_state(self.status.get("last_result", "no-record"))),
            (tr("上次成功"), str(self.status.get("last_success") or tr("从未"))),
            (
                tr("自动更新"),
                f"{format_state(self.status.get('timer_active'))} / "
                f"{format_state(self.status.get('timer_enabled'))}",
            ),
            (tr("下次运行"), str(self.status.get("timer_next") or tr("未知"))),
            (
                tr("配置摘要"),
                tr("{value1} 节点 · {value2} 节点提供器 · {value3} 组 · {value4} 规则", value1=summary.get('proxies', 0), value2=summary.get('providers', 0), value3=summary.get('groups', 0), value4=summary.get('rules', 0)),
            ),
            (tr("备份/历史"), f"{self.status.get('backups', 0)} / {self.status.get('history', 0)}"),
            (tr("配置文件"), str(self.status.get("target_config", "-"))),
        ]
        self.put(start, 2, tr("运行概览"), self.curses.A_BOLD)
        label_width = max(12, *(display_width(label) for label, _ in rows))
        value_column = 4 + label_width + 2
        for offset, (label, value) in enumerate(rows, start=1):
            self.put(start + offset, 4, fit_display(label, label_width), self.curses.color_pair(4))
            self.put(start + offset, value_column, value)
        digest = self.status.get("config_sha256")
        if digest:
            self.put(start + 9, 4, fit_display(tr("配置哈希"), label_width), self.curses.color_pair(4))
            self.put(start + 9, value_column, f"{digest[:16]}…")
        error = self.status.get("last_error")
        if error:
            height, _ = self.screen.getmaxyx()
            error_row = start + 10
            if height - error_row > 3:
                self.put(error_row, 2, tr("最近错误"), self.curses.color_pair(3) | self.curses.A_BOLD)
                self.put(error_row + 1, 4, str(error))
            else:
                self.put(error_row, 2, f"{tr('最近错误')}: {error}", self.curses.color_pair(3))
        self.message = tr("u 更新 · d 仅校验 · r 刷新 · Tab 切换")

    def draw_subscriptions(self, start: int) -> None:
        subscriptions = list(self.registry.get("subscriptions", {}).items())
        self.put(start, 2, tr("订阅"), self.curses.A_BOLD)
        self.put(start + 1, 2, tr("名称"), self.curses.color_pair(4))
        self.put(start + 1, 30, tr("上次结果"), self.curses.color_pair(4))
        self.put(start + 1, 44, tr("上次成功"), self.curses.color_pair(4))
        if not subscriptions:
            self.put(start + 3, 4, tr("尚未配置订阅，按 a 添加。"))
        for index, (name, details) in enumerate(subscriptions):
            marker = "*" if name == self.registry.get("active") else " "
            attr = self.curses.A_REVERSE if index == self.subscription_index else 0
            self.put(start + 2 + index, 2, fit_display(f"{marker} {name}", 26), attr)
            self.put(start + 2 + index, 30, fit_display(format_state(details.get("last_result") or "no-record"), 12), attr)
            self.put(start + 2 + index, 44, str(details.get("last_success") or tr("从未")), attr)
        self.message = tr("↑↓ 选择 · Enter 激活 · u 更新 · d 校验 · a 编辑 · x 删除")

    def draw_history(self, start: int) -> None:
        history = [item for item in self.registry.get("history", []) if isinstance(item, dict)]
        self.put(start, 2, tr("最近操作（不记录 URL、Secret 或节点凭据）"), self.curses.A_BOLD)
        if not history:
            self.put(start + 2, 4, tr("尚无历史；下一次校验、更新或回滚后会出现在这里。"))
        height, _ = self.screen.getmaxyx()
        available = max(1, height - start - 4)
        for offset, event in enumerate(reversed(history[-available:]), start=1):
            kind = tr("更新") if event.get("kind") == "update" else tr("回滚")
            target = event.get("subscription") or event.get("backup") or "-"
            status = str(event.get("status") or "unknown")
            attr = self.curses.color_pair(3 if status == "failed" else 2)
            self.put(
                start + offset,
                3,
                f"{event.get('finished_at', '-')}  {kind}  {fit_display(format_state(status), 12)}  {target}",
                attr,
            )
        self.message = tr("r 刷新 · Tab 切换 · q 退出")

    def draw_backups(self, start: int) -> None:
        self.put(start, 2, tr("配置备份"), self.curses.A_BOLD)
        self.put(start + 1, 2, tr("备份"), self.curses.color_pair(4))
        self.put(start + 1, 43, tr("大小"), self.curses.color_pair(4))
        self.put(start + 1, 55, tr("节点"), self.curses.color_pair(4))
        if not self.backups:
            self.put(start + 3, 4, tr("尚无备份；首次实际更新时会自动创建。"))
        for index, row in enumerate(self.backups):
            attr = self.curses.A_REVERSE if index == self.backup_index else 0
            self.put(start + 2 + index, 2, fit_display(row["name"], 39), attr)
            self.put(start + 2 + index, 43, fit_display(str(row["size"]), 10), attr)
            self.put(start + 2 + index, 55, str(row["summary"].get("proxies", 0)), attr)
        self.message = tr("↑↓ 选择 · Enter 恢复 · r 刷新 · Tab 切换")

    def draw_logs(self, start: int) -> None:
        self.put(start, 2, tr("日志 · {value1}", value1=self.log_unit), self.curses.A_BOLD)
        height, _ = self.screen.getmaxyx()
        available = max(1, height - start - 3)
        end = max(0, len(self.logs) - self.log_scroll)
        begin = max(0, end - available)
        for offset, line in enumerate(self.logs[begin:end], start=1):
            attr = self.curses.color_pair(3) if "error" in line.lower() else 0
            self.put(start + offset, 2, line, attr)
        self.message = tr("↑↓ 滚动 · t 切换日志 · r 刷新 · Tab 切换")

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
            print(tr("\n操作完成。"))
        except ManagerError as exc:
            print(tr("\n错误：{exc}", exc=exc), file=sys.stderr)
        except KeyboardInterrupt:
            print(tr("\n已取消。"), file=sys.stderr)
        try:
            input(tr("\n按 Enter 返回 Mihomo Console……"))
        except EOFError:
            pass
        self.curses.reset_prog_mode()
        self.screen.clear()
        self.refresh()

    def show_help(self) -> None:
        def help_text() -> None:
            print(
                tr("全局：1-5 切换页面，Tab/Shift-Tab 前后切换，r 刷新，l 切换语言，q 退出。\n概览：u 更新当前订阅，d 仅下载并校验。\n订阅：方向键选择，Enter 激活，u 更新，d 校验，a 添加，x 删除。\n备份：方向键选择，Enter 校验并恢复；恢复失败会自动还原。\n日志：方向键滚动，t 在更新服务和 Mihomo 服务之间切换。\n\nTUI 不会显示订阅 URL、Secret 或节点凭据。")
            )

        self.run_external(tr("快捷键"), help_text)

    def handle_key(self, key: int) -> bool:
        if key in (ord("q"), ord("Q")):
            return False
        if key in (ord("l"), ord("L")):
            set_language("en_US" if LANGUAGE == "zh_CN" else "zh_CN")
            self.refresh()
            return True
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
                self.message = tr("尚未设置当前订阅。")
                return True
            dry_run = key == ord("d")
            self.run_external(
                tr("校验当前订阅") if dry_run else tr("更新当前订阅"),
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
                    tr("添加或修改订阅"),
                    lambda: add_subscription(self.manager_config, self.registry),
                )
            elif names and key in (10, 13, self.curses.KEY_ENTER):
                name = self.selected_subscription()
                assert name is not None
                self.run_external(
                    tr("激活订阅 {name}", name=name),
                    lambda: activate(self.manager_config, self.registry, name),
                )
            elif names and key in (ord("u"), ord("d")):
                name = self.selected_subscription()
                assert name is not None
                dry_run = key == ord("d")
                self.run_external(
                    tr("校验订阅 {name}", name=name) if dry_run else tr("更新订阅 {name}", name=name),
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
                    tr("删除订阅 {name}", name=name),
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
                    if confirm(tr("确认恢复备份 {name} 并重启 Mihomo 吗", name=name), False):
                        rollback_backup(self.manager_config, self.registry, name)
                    else:
                        print(tr("已取消。"))

                self.run_external(tr("恢复备份 {name}", name=name), restore_selected)
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
                self.logs = fetch_journal(self.log_unit, registry=self.registry)
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
        raise ManagerError(tr("TUI 需要交互式终端；自动任务请使用明确的 CLI 子命令"))
    try:
        import curses
    except ImportError as exc:
        raise ManagerError(tr("当前 Python 缺少 curses 模块，无法启动 TUI")) from exc
    try:
        curses.wrapper(
            lambda screen: ConsoleTUI(screen, curses, manager_config).run()
        )
    except (curses.error, OSError) as exc:
        raise ManagerError(tr("无法启动 TUI：{exc}", exc=exc)) from exc


def show_secret(registry: dict[str, Any]) -> None:
    overlay = read_yaml_mapping(Path(str(registry["overlay_file"])))
    secret = overlay.get("secret")
    if not secret:
        raise ManagerError(tr("本地覆盖中没有设置 Secret"))
    print(str(secret))


class ConsoleHelpFormatter(argparse.HelpFormatter):
    def _format_usage(self, usage: Any, actions: Any, groups: Any, prefix: Any) -> str:
        return super()._format_usage(
            usage, actions, groups, tr("用法：") if prefix is None else prefix
        )


class ConsoleArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, **kwargs: Any):
        kwargs["add_help"] = False
        kwargs["formatter_class"] = ConsoleHelpFormatter
        super().__init__(*args, **kwargs)
        self._positionals.title = tr("命令与参数")
        self._optionals.title = tr("选项")
        self.add_argument("-h", "--help", action="help", help=tr("显示帮助并退出"))


def build_parser() -> argparse.ArgumentParser:
    parser = ConsoleArgumentParser(
        description=tr("Mihomo Console：安全更新、诊断和恢复完整订阅配置")
    )
    parser.add_argument(
        "--lang", choices=("auto", "zh_CN", "en_US"), default="auto",
        help=tr("界面语言：auto 跟随环境，zh_CN 中文，en_US 英文"),
    )
    parser.add_argument(
        "--manager-config",
        type=Path,
        default=DEFAULT_MANAGER_CONFIG,
        help=tr("管理配置路径（默认：{DEFAULT_MANAGER_CONFIG}）", DEFAULT_MANAGER_CONFIG=DEFAULT_MANAGER_CONFIG),
    )
    subparsers = parser.add_subparsers(dest="command")

    init_parser = subparsers.add_parser("init", help=tr("初始化管理配置和本地覆盖"))
    init_parser.add_argument("--force", action="store_true", help=tr("覆盖已有管理配置"))
    subparsers.add_parser("tui", help=tr("进入终端控制台（默认）"))
    subparsers.add_parser("menu", help=tr("进入兼容的简易文本菜单"))
    subparsers.add_parser("status", help=tr("显示服务、定时器和当前配置摘要"))
    subparsers.add_parser("list", help=tr("列出订阅（不显示 URL）"))
    history_parser = subparsers.add_parser("history", help=tr("显示脱敏的更新与回滚历史"))
    history_parser.add_argument("--limit", type=int, default=20, help=tr("最多显示多少条（默认 20）"))
    subparsers.add_parser("backups", help=tr("列出受管理的配置备份"))
    subparsers.add_parser("add", help=tr("交互式添加或修改订阅"))

    activate_parser = subparsers.add_parser("activate", help=tr("选择当前订阅，但不立即应用"))
    activate_parser.add_argument("name")
    remove_parser = subparsers.add_parser("remove", help=tr("删除一个订阅"))
    remove_parser.add_argument("name")

    update_parser = subparsers.add_parser("update", help=tr("下载并应用指定订阅"))
    update_parser.add_argument("name")
    update_parser.add_argument("--dry-run", action="store_true", help=tr("仅下载和校验"))
    update_active_parser = subparsers.add_parser("update-active", help=tr("下载并应用当前订阅"))
    update_active_parser.add_argument("--dry-run", action="store_true", help=tr("仅下载和校验"))

    rollback_parser = subparsers.add_parser("rollback", help=tr("校验并恢复一个配置备份"))
    rollback_parser.add_argument("backup", help=tr("backups 命令列出的备份文件名"))
    rollback_parser.add_argument("--yes", action="store_true", help=tr("跳过交互确认"))

    subparsers.add_parser("configure-overlay", help=tr("配置控制 API、Secret 和 CORS 覆盖"))
    subparsers.add_parser(
        "configure-systemd-sandbox",
        help=tr("按当前路径生成自动更新服务的 systemd 沙箱配置"),
    )
    subparsers.add_parser("show-secret", help=tr("显式输出当前 Secret"))
    return parser


def main() -> int:
    # Resolve the language before constructing translated help, including --help.
    language_parser = argparse.ArgumentParser(add_help=False)
    language_parser.add_argument("--lang", default="auto")
    language_args, _ = language_parser.parse_known_args()
    set_language(language_args.lang)
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
                raise ManagerError(tr("尚未选择当前订阅"))
            update_profile(manager_config, registry, str(active), dry_run=args.dry_run)
        elif command == "rollback":
            if args.yes or confirm(
                tr("确认恢复备份 {value1} 并重启 Mihomo 吗", value1=args.backup), False
            ):
                rollback_backup(manager_config, registry, args.backup)
            else:
                print(tr("已取消。"))
        elif command == "configure-overlay":
            configure_overlay(registry)
        elif command == "configure-systemd-sandbox":
            install_systemd_sandbox(manager_config, registry)
        elif command == "show-secret":
            show_secret(registry)
        else:
            parser.error(tr("未知命令：{command}", command=command))
        return 0
    except KeyboardInterrupt:
        eprint(tr("\n已取消。"))
        return 130
    except (ManagerError, OSError) as exc:
        eprint(tr("错误：{exc}", exc=exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
