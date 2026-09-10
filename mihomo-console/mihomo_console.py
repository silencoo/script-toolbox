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
import contextlib
import io
import platform
import queue
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
import threading
import time
import unicodedata
import zlib
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
    "全局：1-7 切换页面，Tab/Shift-Tab 前后切换，r 刷新，l 切换语言，q 退出。\n概览：u 更新当前订阅，d 仅下载并校验。\n订阅：方向键选择，Enter 激活，u 更新，d 校验，a 添加，x 删除。\n备份：方向键选择，Enter 校验并恢复；恢复失败会自动还原。\n日志：方向键滚动，t 在更新服务和 Mihomo 服务之间切换。\n\nTUI 不会显示订阅 URL、Secret 或节点凭据。": "Global: 1-7 select pages, Tab/Shift-Tab cycle pages, r refreshes, l switches language, q quits.\nOverview: u updates the active subscription; d downloads and validates only.\nProfiles: arrows select, Enter activates, u updates, d validates, a adds, x deletes.\nBackups: arrows select; Enter validates and restores, with automatic recovery on failure.\nLogs: arrows scroll; t switches between updater and Mihomo service logs.\n\nThe TUI does not display subscription URLs, secrets or proxy credentials.",
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


EN_MESSAGES.update({
    "内核：i 安装，u 升级，b 回退，s/x/k 启动/停止/重启，e 开机启动，t 自动刷新。": "Core: i installs, u upgrades, b rolls back, s/x/k start/stop/restart, e toggles autostart, t toggles the timer.",
    "节点：Enter 打开组或使用节点，Esc 返回，d 测试延迟，m 保存运行模式。": "Proxies: Enter opens a group or selects a proxy, Esc goes back, d tests latency, m saves the mode.",
    "e 切换开机启动 · t 切换订阅自动刷新": "e Toggle autostart · t Toggle subscription timer",
    "i 安装/修复 · u 升级内核 · b 回退内核": "i Install/repair · u Upgrade core · b Roll back",
    "r 重试 · 6 内核与服务 · Tab 切换": "r Retry · 6 Core & service · Tab Pages",
    "rule 规则模式 · global 全局代理 · direct 直连": "rule Rule mode · global Global proxy · direct Direct",
    "s 启动 · x 停止 · k 重启": "s Start · x Stop · k Restart",
    "↑↓ 选择 · Enter 打开/使用 · Esc 返回 · d 测速 · m 模式": "↑↓ Select · Enter Open/use · Esc Back · d Test · m Mode",
    "上一版内核": "Previous core",
    "不支持此服务操作。": "Unsupported service action.",
    "主服务": "Main service",
    "保留已安装内核：{version}": "Keeping installed core: {version}",
    "保留现有主服务：{service}": "Keeping existing main service: {service}",
    "内核": "Core",
    "内核 SHA-256 校验失败，未修改已安装版本。": "Core SHA-256 verification failed; the installed version was not changed.",
    "内核下载超时或超过大小限制。": "Core download timed out or exceeded the size limit.",
    "内核与服务": "Core & service",
    "内核升级失败，已恢复旧内核及服务：{error}": "Core upgrade failed; the old core and service were restored: {error}",
    "内核升级失败，旧内核已恢复但服务启动失败：{error}": "Core upgrade failed; the old core was restored but the service failed to start: {error}",
    "内核压缩包无效。": "Invalid core archive.",
    "内核发布包不是有效的 Linux 可执行文件。": "The core asset is not a valid Linux executable.",
    "内核安装完成：{version}": "Core installation complete: {version}",
    "内核已是所选版本，无需替换或重启。": "The selected core is already installed; no replacement or restart needed.",
    "内核或备份路径是符号链接，请通过原安装方式管理。": "The core or backup path is a symlink; use the original installation method.",
    "内核文件": "Core binary",
    "内核版本": "Core version",
    "内核版本与发布元数据不一致。": "Core version does not match the release metadata.",
    "内核路径必须是绝对路径。": "The core path must be absolute.",
    "内核随容器镜像更新；k 重启内核。": "Update the core via the container image; k restarts it.",
    "准备安装 {version}：{asset}": "Preparing to install {version}: {asset}",
    "创建主服务但不启动或设置开机启动": "Create the main service without starting or enabling it",
    "升级内核": "Upgrade core",
    "发布包下载地址不符合官方路径，已停止安装。": "The asset URL does not match the official release path; installation stopped.",
    "只支持官方稳定版发布。": "Only official stable releases are supported.",
    "可用稳定版：{version} · {asset}": "Available stable release: {version} · {asset}",
    "启用自动刷新订阅并选择更新频率吗": "Enable automatic subscription refresh and choose an interval",
    "更新频率": "Update interval",
    "  更新频率:      {interval}": "  Update interval: {interval}",
    "e 开机启动 · t 自动更新 · f 更新频率": "e Autostart · t Auto-update · f Interval",
    "t 自动更新 · f 更新频率": "t Auto-update · f Interval",
    "停用自动刷新订阅": "Disable automatic subscription refresh",
    "启用自动刷新订阅": "Enable automatic subscription refresh",
    "刷新失败（r 重试）：{error}": "Refresh failed (r retries): {error}",
    "后台加载中，仍可切换页面或退出。": "Loading in background; tabs and quit remain available.",
    "更新间隔须为 1 分钟至 30 天，例如 30m、6h、1d。": "Use an interval from 1 minute to 30 days, e.g. 30m, 6h or 1d.",
    "更新间隔，例如 30m、6h、1d（1 分钟至 30 天）": "Update interval, e.g. 30m, 6h, 1d (1 minute to 30 days)",
    "更新间隔：30m / 1h / 6h / 12h / 1d，或自定义 1m 至 30d。": "Interval: 30m / 1h / 6h / 12h / 1d, or a custom value from 1m to 30d.",
    "更新频率保存失败，已恢复原设置：{error}": "Could not save the interval; previous settings restored: {error}",
    "更新频率保存失败，恢复也失败：{error}；{recovery}": "Could not save or restore the interval: {error}; {recovery}",
    "更新频率：内核页面按 f 设置，t 启用或停用自动刷新。": "Schedule: press f on the Core page to set the interval, t to toggle automatic refresh.",
    "查看或设置订阅自动更新频率": "View or set the automatic subscription refresh interval",
    "自动更新设置已保存。": "Automatic update settings saved.",
    "自动更新设置无效。": "Invalid automatic update settings.",
    "订阅定时器未安装，请先运行 setup.sh。": "Subscription timer is not installed; run setup.sh first.",
    "回退内核": "Roll back core",
    "安装内核、初始配置和 systemd 主服务": "Install the core, initial configuration and systemd main service",
    "安装内核与主服务": "Install core and main service",
    "安装后引导订阅设置并打开 TUI": "Guide subscription setup and open the TUI after installation",
    "安装完成，可运行 mihomo-console 进入控制台。": "Installation complete. Run mihomo-console to open the console.",
    "官方发布下载失败：HTTP {code}": "Official release download failed: HTTP {code}",
    "官方发布下载失败：{reason}": "Official release download failed: {reason}",
    "官方发布元数据无效。": "Invalid official release metadata.",
    "官方发布缺少 SHA-256 校验值，已停止安装。": "The official release has no SHA-256 digest; installation stopped.",
    "官方稳定版版本号，默认 latest": "Official stable release version (default: latest)",
    "容器内核由镜像管理，请更新容器镜像；服务生命周期由容器管理器控制。": "Update the container image to upgrade its core; the container manager controls its lifecycle.",
    "尚无策略组，请先添加并应用订阅。": "No proxy groups yet; add and apply a subscription first.",
    "已切换并保存运行模式：{mode}": "Switched and saved proxy mode: {mode}",
    "已创建主服务：{service}": "Created main service: {service}",
    "已创建仅监听本机的初始直连配置；添加订阅后即可使用代理节点。": "Created an initial direct configuration listening only on localhost; add a subscription to use proxy nodes.",
    "已恢复上一版内核。": "Restored the previous core.",
    "已选择节点：{group} → {node}": "Selected proxy: {group} → {node}",
    "开机启动": "Autostart",
    "所选节点不在此策略组中。": "The selected proxy is not a member of this group.",
    "控制器认证失败，请检查本地 Secret 与运行配置是否一致。": "Controller authentication failed; check that the local secret matches the running configuration.",
    "控制器请求失败：HTTP {code}": "Controller request failed: HTTP {code}",
    "控制器返回了无效响应。": "The controller returned an invalid response.",
    "操作订阅刷新定时器": "Operate on the subscription refresh timer",
    "无效的 systemd 服务名：{name}": "Invalid systemd service name: {name}",
    "无法运行 Mihomo 内核：{path}": "Cannot run the Mihomo core: {path}",
    "无法连接 Mihomo 控制器，请检查服务和监听地址。": "Cannot connect to the Mihomo controller; check the service and listen address.",
    "无法连接 systemd：{details}": "Cannot connect to systemd: {details}",
    "无法重新加载 systemd：{details}": "Cannot reload systemd: {details}",
    "暂不支持自动安装此架构：{arch}": "Automatic installation does not support this architecture yet: {arch}",
    "服务操作失败：{details}": "Service action failed: {details}",
    "服务操作完成：{action}": "Service action complete: {action}",
    "服务路径必须是无控制字符的绝对路径。": "Service paths must be absolute and contain no control characters.",
    "未配置可用的 TCP 控制器，请先配置 external-controller。": "No usable TCP controller is configured; configure external-controller first.",
    "查看、安装、升级或回退 Mihomo 内核": "Inspect, install, upgrade or roll back the Mihomo core",
    "查看或保存运行模式": "Show or persist the proxy mode",
    "查看策略组、选择节点或测试延迟": "List proxy groups, select a proxy or test latency",
    "查看策略组及节点": "List proxy groups and their members",
    "校验通过，现在应用订阅配置吗": "Validation passed; apply the subscription configuration now",
    "模式必须为 rule、global 或 direct。": "Mode must be rule, global or direct.",
    "正在下载并校验官方内核……": "Downloading and verifying the official core…",
    "此操作需要 root 权限，请使用 sudo。": "This action requires root privileges; use sudo.",
    "此稳定版没有适合本机架构的发布包。": "This stable release has no asset for the local architecture.",
    "此策略组不是手动选择类型。": "This group is not a manual selector.",
    "没有可用的上一版内核。": "No previous core is available.",
    "测试节点延迟": "Test proxy latency",
    "版本必须为 latest 或 v主版本.次版本.修订版本。": "Version must be latest or vMAJOR.MINOR.PATCH.",
    "现在下载并校验当前订阅吗": "Download and validate the active subscription now",
    "现在添加第一个订阅吗": "Add the first subscription now",
    "现有服务使用的内核路径与管理配置不同；请先校正 mihomo_binary，现有服务已保留。": "The existing service uses a different core path; correct mihomo_binary first. The existing service was preserved.",
    "确认升级内核（运行中的服务会短暂重启）吗": "Upgrade the core (a running service will briefly restart)",
    "确认回退内核（运行中的服务会短暂重启）吗": "Roll back the core (a running service will briefly restart)",
    "管理主服务": "Manage main service",
    "管理主服务或订阅刷新定时器": "Manage the main service or subscription refresh timer",
    "自动安装仅支持使用 systemd 的 Linux。": "Automatic installation supports Linux with systemd only.",
    "节点与模式：{mode}": "Proxies & mode: {mode}",
    "节点延迟测试未返回有效结果。": "The proxy latency test did not return a valid result.",
    "节点延迟：{node} · {delay} ms": "Proxy latency: {node} · {delay} ms",
    "运行模式": "Proxy mode",
    "选择策略组后按 Enter 查看节点": "Select a group and press Enter to view its proxies",
    "选择节点": "Select proxy",
    "配置文件已还原，但无法确认运行模式；请刷新状态或重启服务。": "Configuration files were restored, but the live mode is uncertain; refresh status or restart the service.",
    "未安装": "Not installed",
    "可用": "Available",
    "无": "None",
    "规则模式": "Rule",
    "全局代理": "Global",
    "直连模式": "Direct",
    "手动选择": "Selector",
    "自动测速": "URL test",
    "故障转移": "Fallback",
    "负载均衡": "Load balance",
    "启动": "Start",
    "停止": "Stop",
    "重启": "Restart",
    "启用": "Enable",
    "禁用": "Disable",
    "首次运行，立即安装 Mihomo 内核与主服务吗": "First run: install the Mihomo core and main service now"
})


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
    "not-installed": "未安装", "available": "可用", "none": "无",
    "rule": "规则模式", "global": "全局代理", "direct": "直连模式",
    "Selector": "手动选择", "URLTest": "自动测速", "Fallback": "故障转移", "LoadBalance": "负载均衡",
    "start": "启动", "stop": "停止", "restart": "重启", "enable": "启用", "disable": "禁用",
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
DEFAULT_SCHEDULE_DROPIN = Path("/etc/systemd/system") / f"{DEFAULT_UPDATER_TIMER}.d" / "zz-mihomo-console.conf"
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


def _rollback_backup_impl(
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


def rollback_backup(manager_config: Path, registry: dict[str, Any], backup_name: str) -> None:
    with operation_lock(registry):
        _rollback_backup_impl(manager_config, registry, backup_name)


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
        "update_interval": format_update_interval(current_update_interval(registry)),
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
    print(tr("  更新频率:      {interval}", interval=status['update_interval']))
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


# Native installation and core lifecycle. The updater timer never calls these.
RELEASE_API = "https://api.github.com/repos/MetaCubeX/mihomo/releases"
RELEASE_TAG_RE = re.compile(r"v\d+\.\d+\.\d+")
MAX_CORE_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_CORE_BINARY_BYTES = 200 * 1024 * 1024


@contextlib.contextmanager
def operation_lock(registry: dict[str, Any]):
    path = Path(str(registry["lock_file"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ConcurrentUpdateError(tr("另一个更新任务正在运行")) from exc
        yield


def require_native_root(registry: dict[str, Any]) -> None:
    if registry.get("service_backend", "systemd") != "systemd":
        raise ManagerError(tr("容器内核由镜像管理，请更新容器镜像；服务生命周期由容器管理器控制。"))
    if platform.system() != "Linux":
        raise ManagerError(tr("自动安装仅支持使用 systemd 的 Linux。"))
    if os.geteuid() != 0:
        raise ManagerError(tr("此操作需要 root 权限，请使用 sudo。"))


def service_name(registry: dict[str, Any]) -> str:
    name = str(registry["systemd_service"])
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*\.service", name):
        raise ManagerError(tr("无效的 systemd 服务名：{name}", name=name))
    return name


def service_properties(registry: dict[str, Any]) -> dict[str, str]:
    result = command_output([
        "systemctl", "show", service_name(registry),
        "--property=LoadState,ActiveState,UnitFileState,FragmentPath,ExecStart",
    ], timeout=10)
    if result.returncode:
        raise ManagerError(tr("无法连接 systemd：{details}", details=result.stdout.strip()[-1000:]))
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def core_version(binary: Path) -> str:
    if not binary.is_file():
        return "not-installed"
    result = command_output([str(binary), "-v"], timeout=10)
    match = re.search(r"Mihomo(?: Meta)? ([^\s]+)", result.stdout, re.I)
    if result.returncode or not match:
        raise ManagerError(tr("无法运行 Mihomo 内核：{path}", path=binary))
    return match.group(1)


def core_architecture(machine: str | None = None) -> list[str]:
    machine = (machine or platform.machine()).lower()
    choices = {
        "x86_64": ["amd64-v1", "amd64-compatible"],
        "amd64": ["amd64-v1", "amd64-compatible"],
        "aarch64": ["arm64"], "arm64": ["arm64"],
        "armv7l": ["armv7"], "armv6l": ["armv6"],
        "i386": ["386"], "i686": ["386"],
    }
    if machine not in choices:
        raise ManagerError(tr("暂不支持自动安装此架构：{arch}", arch=machine))
    return choices[machine]


def fetch_release_bytes(url: str, limit: int) -> bytes:
    request = urllib.request.Request(url, headers={
        "User-Agent": "mihomo-console", "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            chunks = []
            size = 0
            deadline = time.monotonic() + 180
            while True:
                chunk = response.read(min(1024 * 1024, limit - size + 1))
                if not chunk:
                    return b"".join(chunks)
                size += len(chunk)
                if size > limit or time.monotonic() > deadline:
                    raise ManagerError(tr("内核下载超时或超过大小限制。"))
                chunks.append(chunk)
    except urllib.error.HTTPError as exc:
        raise ManagerError(tr("官方发布下载失败：HTTP {code}", code=exc.code)) from exc
    except (OSError, urllib.error.URLError) as exc:
        raise ManagerError(tr("官方发布下载失败：{reason}", reason=type(exc).__name__)) from exc


def select_release_asset(release: dict[str, Any], architectures: list[str]) -> dict[str, str]:
    tag = str(release.get("tag_name", ""))
    if not RELEASE_TAG_RE.fullmatch(tag) or release.get("draft") or release.get("prerelease"):
        raise ManagerError(tr("只支持官方稳定版发布。"))
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ManagerError(tr("官方发布元数据无效。"))
    for architecture in architectures:
        name = f"mihomo-linux-{architecture}-{tag}.gz"
        for asset in assets:
            if not isinstance(asset, dict) or asset.get("name") != name:
                continue
            digest = str(asset.get("digest") or "")
            if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
                raise ManagerError(tr("官方发布缺少 SHA-256 校验值，已停止安装。"))
            url = f"https://github.com/MetaCubeX/mihomo/releases/download/{tag}/{name}"
            if asset.get("browser_download_url") != url:
                raise ManagerError(tr("发布包下载地址不符合官方路径，已停止安装。"))
            return {"version": tag, "name": name, "url": url, "sha256": digest[7:].lower()}
    raise ManagerError(tr("此稳定版没有适合本机架构的发布包。"))


def resolve_core_release(version: str = "latest") -> dict[str, str]:
    if version != "latest" and not RELEASE_TAG_RE.fullmatch(version):
        raise ManagerError(tr("版本必须为 latest 或 v主版本.次版本.修订版本。"))
    path = "latest" if version == "latest" else f"tags/{version}"
    try:
        release = json.loads(fetch_release_bytes(f"{RELEASE_API}/{path}", 4 * 1024 * 1024))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManagerError(tr("官方发布元数据无效。")) from exc
    if not isinstance(release, dict):
        raise ManagerError(tr("官方发布元数据无效。"))
    if version != "latest" and release.get("tag_name") != version:
        raise ManagerError(tr("官方发布元数据无效。"))
    return select_release_asset(release, core_architecture())


def unpack_core(archive: bytes, expected_sha256: str, destination: Path) -> None:
    if hashlib.sha256(archive).hexdigest() != expected_sha256:
        raise ManagerError(tr("内核 SHA-256 校验失败，未修改已安装版本。"))
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
            data = compressed.read(MAX_CORE_BINARY_BYTES + 1)
    except (OSError, EOFError, zlib.error) as exc:
        raise ManagerError(tr("内核压缩包无效。")) from exc
    if len(data) > MAX_CORE_BINARY_BYTES or not data.startswith(b"\x7fELF"):
        raise ManagerError(tr("内核发布包不是有效的 Linux 可执行文件。"))
    secure_atomic_write(destination, data, mode=0o755)


def verify_service_binary(registry: dict[str, Any], properties: dict[str, str]) -> None:
    if properties.get("LoadState") == "not-found":
        return
    match = re.search(r"(?:^|[ {])path=(.*?)\s*;", properties.get("ExecStart", ""))
    configured = Path(str(registry["mihomo_binary"]))
    if not match or Path(match.group(1)).resolve() != configured.resolve():
        raise ManagerError(tr("现有服务使用的内核路径与管理配置不同；请先校正 mihomo_binary，现有服务已保留。"))


def replace_core(registry: dict[str, Any], candidate: Path) -> None:
    """Candidate is verified before replacement; preserve inactive service state."""
    binary = Path(str(registry["mihomo_binary"]))
    previous = binary.with_name(binary.name + ".previous")
    if binary.is_symlink() or previous.is_symlink():
        raise ManagerError(tr("内核或备份路径是符号链接，请通过原安装方式管理。"))
    core_version(candidate)
    target = Path(str(registry["target_config"]))
    if target.is_file():
        validate_with_mihomo({**registry, "mihomo_binary": str(candidate)}, target)
    properties = service_properties(registry)
    verify_service_binary(registry, properties)
    was_running = properties.get("ActiveState") in {"active", "activating", "reloading"}
    old = binary.read_bytes() if binary.is_file() else None
    if old is not None:
        secure_atomic_write(previous, old, mode=0o755)
    os.replace(candidate, binary)
    fsync_directory(binary.parent)
    try:
        if was_running:
            restart_mihomo(registry)
    except (ManagerError, OSError) as exc:
        if old is None:
            binary.unlink(missing_ok=True)
            raise
        secure_atomic_write(binary, old, mode=0o755)
        try:
            restart_mihomo(registry)
        except (ManagerError, OSError) as recovery:
            raise ManagerError(tr("内核升级失败，旧内核已恢复但服务启动失败：{error}", error=recovery)) from exc
        raise ManagerError(tr("内核升级失败，已恢复旧内核及服务：{error}", error=exc)) from exc


def install_core(registry: dict[str, Any], *, version: str = "latest", update: bool = False,
                 yes: bool = False) -> None:
    require_native_root(registry)
    binary = Path(str(registry["mihomo_binary"]))
    if not binary.is_absolute():
        raise ManagerError(tr("内核路径必须是绝对路径。"))
    with operation_lock(registry):
        if binary.exists() and not update:
            print(tr("保留已安装内核：{version}", version=core_version(binary)))
            return
        release = resolve_core_release(version)
        print(tr("准备安装 {version}：{asset}", version=release["version"], asset=release["name"]))
        if update and binary.exists() and not yes and not confirm(tr("确认升级内核（运行中的服务会短暂重启）吗")):
            print(tr("已取消。"))
            return
        binary.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".mihomo-core-", dir=binary.parent) as directory:
            candidate = Path(directory) / "mihomo"
            print(tr("正在下载并校验官方内核……"))
            archive = fetch_release_bytes(release["url"], MAX_CORE_ARCHIVE_BYTES)
            unpack_core(archive, release["sha256"], candidate)
            if core_version(candidate) != release["version"]:
                raise ManagerError(tr("内核版本与发布元数据不一致。"))
            if binary.is_file() and binary.read_bytes() == candidate.read_bytes():
                print(tr("内核已是所选版本，无需替换或重启。"))
                return
            replace_core(registry, candidate)
        print(tr("内核安装完成：{version}", version=release["version"]))


def rollback_core(registry: dict[str, Any]) -> None:
    require_native_root(registry)
    binary = Path(str(registry["mihomo_binary"]))
    previous = binary.with_name(binary.name + ".previous")
    with operation_lock(registry):
        if not previous.is_file() or previous.is_symlink():
            raise ManagerError(tr("没有可用的上一版内核。"))
        with tempfile.TemporaryDirectory(prefix=".mihomo-core-", dir=binary.parent) as directory:
            candidate = Path(directory) / "mihomo"
            secure_atomic_write(candidate, previous.read_bytes(), mode=0o755)
            replace_core(registry, candidate)
        print(tr("已恢复上一版内核。"))


def render_mihomo_service(registry: dict[str, Any]) -> bytes:
    values = []
    for key in ("mihomo_binary", "mihomo_home", "target_config"):
        path = Path(str(registry[key]))
        if not path.is_absolute() or any(ord(c) < 32 or ord(c) == 127 for c in str(path)):
            raise ManagerError(tr("服务路径必须是无控制字符的绝对路径。"))
        values.append(quote_systemd_path(path).replace("$", "$$"))
    binary, home, config = values
    return (
        "# Managed by Mihomo Console\n[Unit]\nDescription=Mihomo Daemon\n"
        "Wants=network-online.target\nAfter=network-online.target\n\n"
        "[Service]\nType=simple\n"
        f"ExecStart={binary} -d {home} -f {config}\n"
        "Restart=on-failure\nRestartSec=5\nLimitNOFILE=65536\nUMask=0077\n\n"
        "[Install]\nWantedBy=multi-user.target\n"
    ).encode()


def install_mihomo_service(registry: dict[str, Any], *, unit_dir: Path = Path("/etc/systemd/system")) -> bool:
    require_native_root(registry)
    properties = service_properties(registry)
    unit = unit_dir / service_name(registry)
    if properties.get("LoadState") != "not-found" or unit.exists() or unit.is_symlink():
        verify_service_binary(registry, properties)
        print(tr("保留现有主服务：{service}", service=service_name(registry)))
        return False
    secure_atomic_write(unit, render_mihomo_service(registry), mode=0o644)
    result = command_output(["systemctl", "daemon-reload"])
    if result.returncode:
        raise ManagerError(tr("无法重新加载 systemd：{details}", details=result.stdout.strip()[-1000:]))
    print(tr("已创建主服务：{service}", service=service_name(registry)))
    return True


def service_action(registry: dict[str, Any], action: str, *, timer: bool = False) -> None:
    allowed = {"start", "stop", "restart", "enable", "disable"}
    if action not in allowed:
        raise ManagerError(tr("不支持此服务操作。"))
    if registry.get("service_backend") == "container" and action == "restart" and not timer:
        restart_mihomo(registry)
        return
    require_native_root(registry)
    with (contextlib.nullcontext() if timer else operation_lock(registry)):
        unit = DEFAULT_UPDATER_TIMER if timer else service_name(registry)
        if timer and action in {"start", "restart", "enable"}:
            if not registry.get("active") or registry["active"] not in registry.get("subscriptions", {}):
                raise ManagerError(tr("尚未选择当前订阅"))
        if not timer and action in {"start", "restart"}:
            validate_with_mihomo(registry, Path(str(registry["target_config"])))
            # restart_mihomo also starts an inactive unit and verifies stability.
            if action == "restart" or service_properties(registry).get("ActiveState") != "active":
                restart_mihomo(registry)
        else:
            command = ["systemctl", action]
            if timer and action in {"enable", "disable"}:
                command.append("--now")
            result = command_output([*command, unit])
            if result.returncode:
                raise ManagerError(tr("服务操作失败：{details}", details=result.stdout.strip()[-1000:]))
        print(tr("服务操作完成：{action}", action=format_state(action)))


def parse_update_interval(value: str) -> int:
    match = re.fullmatch(r"([1-9][0-9]{0,7})([mhd])", value.strip().lower())
    seconds = int(match[1]) * {"m": 60, "h": 3600, "d": 86400}[match[2]] if match else 0
    if not 60 <= seconds <= 30 * 86400:
        raise ManagerError(tr("更新间隔须为 1 分钟至 30 天，例如 30m、6h、1d。"))
    return seconds


def format_update_interval(seconds: int) -> str:
    for unit, scale in (("d", 86400), ("h", 3600), ("m", 60)):
        if seconds > 0 and seconds % scale == 0:
            return f"{seconds // scale}{unit}"
    return f"{seconds}s"


def update_schedule_settings(registry: dict[str, Any], default_interval: int = 3600) -> tuple[int, bool]:
    settings = ensure_mapping(registry.get("update_schedule", {}), "update_schedule")
    interval = settings.get("interval_seconds", default_interval or 3600)
    enabled = settings.get("enabled", default_interval > 0)
    if (type(interval) is not int or interval <= 0 or type(enabled) is not bool):
        raise ManagerError(tr("自动更新设置无效。"))
    return interval, enabled


def current_update_interval(registry: dict[str, Any]) -> int:
    default = 3600
    if registry.get("service_backend") == "container":
        runtime = read_container_runtime(registry)
        default = int(runtime.get("update_interval_seconds") or os.environ.get("UPDATE_INTERVAL_SECONDS", 3600))
    return update_schedule_settings(registry, default)[0]


def render_update_schedule(seconds: int) -> bytes:
    # Reset every trigger before adding ours, including any older calendar rule.
    return ("# Managed by Mihomo Console\n[Timer]\n"
            "OnBootSec=\nOnStartupSec=\nOnActiveSec=\nOnUnitActiveSec=\n"
            "OnUnitInactiveSec=\nOnCalendar=\n"
            f"OnActiveSec={seconds}s\nOnUnitInactiveSec={seconds}s\n"
            "RandomizedDelaySec=0\nAccuracySec=1s\n").encode()


def configure_update_schedule(manager_config: Path, registry: dict[str, Any],
                              interval: str | None = None, *, enabled: bool | None = None,
                              dropin: Path = DEFAULT_SCHEDULE_DROPIN) -> None:
    seconds = parse_update_interval(interval) if interval is not None else None
    native = registry.get("service_backend", "systemd") == "systemd"
    if native:
        require_native_root(registry)
    with operation_lock(registry):
        latest = load_registry(manager_config)
        if enabled and latest.get("active") not in latest.get("subscriptions", {}):
            raise ManagerError(tr("尚未选择当前订阅"))
        settings = ensure_mapping(latest.get("update_schedule", {}), "update_schedule").copy()
        if seconds is not None:
            settings["interval_seconds"] = seconds
        if not native and enabled is not None:
            settings["enabled"] = enabled
        latest["update_schedule"] = settings
        if native:
            def systemctl(*arguments: str) -> str:
                result = command_output(["systemctl", *arguments], timeout=20)
                if result.returncode:
                    raise ManagerError(tr("服务操作失败：{details}", details=result.stdout.strip()[-1000:]))
                return result.stdout

            output = systemctl("show", DEFAULT_UPDATER_TIMER, "--property=LoadState,ActiveState,UnitFileState")
            properties = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
            if properties.get("LoadState") != "loaded":
                raise ManagerError(tr("订阅定时器未安装，请先运行 setup.sh。"))
            old_dropin = dropin.read_bytes() if dropin.exists() else None
            old_registry = manager_config.read_bytes()
            try:
                if seconds is not None:
                    secure_atomic_write(dropin, render_update_schedule(seconds), mode=0o644)
                    systemctl("daemon-reload")
                if enabled is not None:
                    systemctl("enable" if enabled else "disable", "--now", DEFAULT_UPDATER_TIMER)
                if seconds is not None and enabled is not False and properties.get("ActiveState") == "active":
                    systemctl("restart", DEFAULT_UPDATER_TIMER)
                save_registry(manager_config, latest)
            except (OSError, ManagerError) as exc:
                try:
                    if seconds is not None:
                        if old_dropin is None:
                            dropin.unlink(missing_ok=True)
                        else:
                            secure_atomic_write(dropin, old_dropin, mode=0o644)
                        systemctl("daemon-reload")
                    secure_atomic_write(manager_config, old_registry)
                    if enabled is not None:
                        systemctl("enable" if properties.get("UnitFileState", "").startswith("enabled") else "disable", DEFAULT_UPDATER_TIMER)
                    systemctl("restart" if properties.get("ActiveState") == "active" else "stop", DEFAULT_UPDATER_TIMER)
                except (OSError, ManagerError) as recovery:
                    raise ManagerError(tr("更新频率保存失败，恢复也失败：{error}；{recovery}", error=exc, recovery=recovery)) from exc
                raise ManagerError(tr("更新频率保存失败，已恢复原设置：{error}", error=exc)) from exc
        else:
            save_registry(manager_config, latest)
        registry.clear()
        registry.update(latest)
    print(tr("自动更新设置已保存。"))


def choose_update_schedule(manager_config: Path, registry: dict[str, Any], *, enabled: bool | None = None) -> None:
    print(tr("更新间隔：30m / 1h / 6h / 12h / 1d，或自定义 1m 至 30d。"))
    interval = ask(tr("更新频率"), format_update_interval(current_update_interval(registry)))
    configure_update_schedule(manager_config, registry, interval, enabled=enabled)


def bootstrap_install(manager_config: Path, *, version: str = "latest", start: bool = True) -> None:
    registry = load_registry(manager_config) if manager_config.exists() else copy.deepcopy(DEFAULTS)
    require_native_root(registry)
    service_properties(registry)  # Fail before writing files if systemd is unavailable.
    for key in ("mihomo_home", "backup_dir"):
        Path(str(registry[key])).mkdir(parents=True, exist_ok=True)
    overlay_path = Path(str(registry["overlay_file"]))
    if not overlay_path.exists():
        overlay = {
            "mixed-port": 7890, "allow-lan": False, "bind-address": "127.0.0.1",
            "external-controller": "127.0.0.1:9090", "secret": secrets.token_hex(32),
            "profile": {"store-selected": True},
        }
        existing = Path(str(registry["target_config"]))
        if existing.is_file():
            current = read_yaml_mapping(existing)
            overlay.update({key: current[key] for key in overlay if key in current})
        secure_atomic_write(overlay_path, yaml.safe_dump(overlay).encode(), mode=0o600)
    if not manager_config.exists():
        save_registry(manager_config, registry)
    install_core(registry, version=version, yes=True)
    target = Path(str(registry["target_config"]))
    if not target.exists():
        profile = deep_merge({"mode": "rule", "log-level": "info", "proxies": [],
                              "rules": ["MATCH,DIRECT"]}, read_yaml_mapping(overlay_path))
        secure_atomic_write(target, yaml.safe_dump(profile).encode(), mode=0o600)
        print(tr("已创建仅监听本机的初始直连配置；添加订阅后即可使用代理节点。"))
    created = install_mihomo_service(registry)
    install_systemd_sandbox(manager_config, registry)
    if created and start:
        service_action(registry, "start")
        service_action(registry, "enable")
    print(tr("安装完成，可运行 mihomo-console 进入控制台。"))


def onboard(manager_config: Path) -> None:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return
    registry = load_registry(manager_config)
    try:
        if not registry["subscriptions"] and confirm(tr("现在添加第一个订阅吗"), True):
            add_subscription(manager_config, registry)
        if registry.get("active") and confirm(tr("现在下载并校验当前订阅吗"), True):
            update_profile(manager_config, registry, str(registry["active"]), dry_run=True)
            if confirm(tr("校验通过，现在应用订阅配置吗"), True):
                update_profile(manager_config, registry, str(registry["active"]))
                if confirm(tr("启用自动刷新订阅并选择更新频率吗"), True):
                    choose_update_schedule(manager_config, registry, enabled=True)
    except ManagerError as exc:
        eprint(tr("错误：{exc}", exc=exc))
        input(tr("\n按 Enter 返回 Mihomo Console……"))
    launch_tui(manager_config)


def collect_core_status(registry: dict[str, Any]) -> dict[str, str]:
    binary = Path(str(registry["mihomo_binary"]))
    result = {"binary": str(binary), "version": "unknown", "enabled": "unknown",
              "backup": "available" if binary.with_name(binary.name + ".previous").is_file() else "none"}
    try:
        result["version"] = core_version(binary)
        if registry.get("service_backend", "systemd") == "systemd":
            properties = service_properties(registry)
            result["enabled"] = properties.get("UnitFileState", "unknown")
            result["unit"] = properties.get("FragmentPath", "")
    except (ManagerError, OSError) as exc:
        result["error"] = str(exc)
    return result


class NoControllerRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None  # Never forward the controller secret to a redirect target.


def controller_endpoint(registry: dict[str, Any]) -> tuple[str, str]:
    config = read_yaml_mapping(Path(str(registry["target_config"])))
    address = str(config.get("external-controller") or "")
    try:
        parsed = urllib.parse.urlsplit("http://" + address)
        host, port = parsed.hostname, parsed.port
        if not host or not port or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("invalid address")
    except ValueError as exc:
        raise ManagerError(tr("未配置可用的 TCP 控制器，请先配置 external-controller。")) from exc
    host = {"0.0.0.0": "127.0.0.1", "*": "127.0.0.1", "::": "::1"}.get(host, host)
    authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
    return f"http://{authority}", str(config.get("secret") or "")


def controller_request(registry: dict[str, Any], path: str, *, method: str = "GET",
                       payload: dict[str, Any] | None = None) -> dict[str, Any]:
    endpoint, secret = controller_endpoint(registry)
    headers = {"Accept": "application/json"}
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(endpoint + path, data=data, headers=headers, method=method)
    # Local controller traffic must not use HTTP(S)_PROXY from the shell.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoControllerRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("oversized response")
            result = json.loads(raw) if raw else {}
            if not isinstance(result, dict):
                raise ValueError("invalid response")
            return result
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise ManagerError(tr("控制器认证失败，请检查本地 Secret 与运行配置是否一致。")) from exc
        raise ManagerError(tr("控制器请求失败：HTTP {code}", code=exc.code)) from exc
    except (OSError, urllib.error.URLError) as exc:
        raise ManagerError(tr("无法连接 Mihomo 控制器，请检查服务和监听地址。")) from exc
    except (ValueError, UnicodeDecodeError) as exc:
        raise ManagerError(tr("控制器返回了无效响应。")) from exc


def proxy_groups(registry: dict[str, Any]) -> dict[str, Any]:
    proxies = controller_request(registry, "/proxies").get("proxies", {})
    if not isinstance(proxies, dict):
        raise ManagerError(tr("控制器返回了无效响应。"))
    groups = {
        name: details for name, details in proxies.items()
        if isinstance(details, dict) and isinstance(details.get("all"), list)
    }
    if any(not isinstance(node, str) for group in groups.values() for node in group["all"]):
        raise ManagerError(tr("控制器返回了无效响应。"))
    return groups


def select_proxy(registry: dict[str, Any], group: str, node: str) -> None:
    groups = proxy_groups(registry)
    details = groups.get(group, {})
    if details.get("type") != "Selector":
        raise ManagerError(tr("此策略组不是手动选择类型。"))
    if node not in details.get("all", []):
        raise ManagerError(tr("所选节点不在此策略组中。"))
    controller_request(registry, "/proxies/" + urllib.parse.quote(group, safe=""),
                       method="PUT", payload={"name": node})
    print(tr("已选择节点：{group} → {node}", group=group, node=node))


def test_proxy_delay(registry: dict[str, Any], node: str) -> int:
    query = urllib.parse.urlencode({"url": "https://www.gstatic.com/generate_204", "timeout": 5000})
    result = controller_request(registry, "/proxies/" + urllib.parse.quote(node, safe="") + "/delay?" + query)
    delay = result.get("delay")
    if not isinstance(delay, int) or isinstance(delay, bool) or delay < 0:
        raise ManagerError(tr("节点延迟测试未返回有效结果。"))
    print(tr("节点延迟：{node} · {delay} ms", node=node, delay=delay))
    return delay


def set_proxy_mode(registry: dict[str, Any], mode: str) -> None:
    if mode not in {"rule", "global", "direct"}:
        raise ManagerError(tr("模式必须为 rule、global 或 direct。"))
    with operation_lock(registry):
        previous_mode = controller_request(registry, "/configs").get("mode")
        if previous_mode not in {"rule", "global", "direct"}:
            raise ManagerError(tr("控制器返回了无效响应。"))
        target = Path(str(registry["target_config"]))
        overlay_path = Path(str(registry["overlay_file"]))
        before_config = target.read_bytes()
        before_overlay = overlay_path.read_bytes() if overlay_path.exists() else None
        profile = read_yaml_mapping(target)
        overlay = read_yaml_mapping(overlay_path, missing_ok=True)
        profile["mode"] = overlay["mode"] = mode
        normalize_mihomo_compatibility(profile)
        candidate_data = yaml.dump(profile, Dumper=MihomoSafeDumper, allow_unicode=True, sort_keys=False).encode()
        with tempfile.TemporaryDirectory(prefix=".mihomo-mode-", dir=target.parent) as directory:
            candidate = Path(directory) / "config.yaml"
            secure_atomic_write(candidate, candidate_data, mode=0o600)
            validate_with_mihomo(registry, candidate)
        requested = False
        try:
            secure_atomic_write(overlay_path, yaml.safe_dump(overlay, allow_unicode=True).encode(), mode=0o600)
            secure_atomic_write(target, candidate_data, mode=0o600, preserve_owner_from=target)
            requested = True
            controller_request(registry, "/configs", method="PATCH", payload={"mode": mode})
        except (ManagerError, OSError) as exc:
            secure_atomic_write(target, before_config, mode=0o600, preserve_owner_from=target)
            if before_overlay is None:
                overlay_path.unlink(missing_ok=True)
            else:
                secure_atomic_write(overlay_path, before_overlay, mode=0o600)
            if requested:
                try:
                    controller_request(registry, "/configs", method="PATCH", payload={"mode": previous_mode})
                except ManagerError as recovery:
                    raise ManagerError(tr("配置文件已还原，但无法确认运行模式；请刷新状态或重启服务。")) from recovery
            raise
    print(tr("已切换并保存运行模式：{mode}", mode=format_state(mode)))


def print_proxy_groups(registry: dict[str, Any]) -> None:
    for name, group in proxy_groups(registry).items():
        print(f"{name} [{format_state(group.get('type'))}] → {group.get('now', '-')}")
        for node in group.get("all", []):
            print(f"  {'*' if node == group.get('now') else ' '} {node}")


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

    PAGES = ("概览", "订阅", "历史", "备份", "日志", "内核", "节点")

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
        self.core_status: dict[str, str] = {}
        self.groups: dict[str, Any] = {}
        self.live_config: dict[str, Any] = {}
        self.controller_error: str | None = None
        self.group_index = 0
        self.node_index = 0
        self.open_group: str | None = None
        self._results: queue.Queue = queue.Queue()
        self._pending: set[str] = set()
        self._checked: dict[str, float] = {}
        self._errors: dict[str, str] = {}
        self._generation = 0
        self._closed = False

    def page_source(self) -> str:
        return {3: "backups", 4: "logs", 5: "core", 6: "proxies"}.get(self.page, "registry")

    def invalidate(self) -> None:
        # Old readers may still finish, but must never overwrite post-action data.
        self._generation += 1
        self._checked.clear()
        self._errors.clear()

    def request_read(self, source: str, action: Callable[[], Any]) -> None:
        if self._closed or source in self._pending:
            return
        if time.monotonic() - self._checked.get(source, float("-inf")) < 5:
            return
        self._pending.add(source)
        generation, log_unit = self._generation, self.log_unit

        def read() -> None:
            value, error = None, None
            try:
                value = action()
            except Exception as exc:
                error = str(exc)
            self._results.put((source, generation, log_unit, value, error))

        # At most one reader per source (six in total); slow I/O never holds the
        # curses thread or delays exit. Workers only read independent snapshots.
        threading.Thread(target=read, name=f"console-{source}", daemon=True).start()

    def refresh(self, *, force: bool = True) -> None:
        if force:
            self.invalidate()
        self.request_read("registry", lambda: load_registry(self.manager_config))
        if not self.registry or "registry" not in self._checked:
            return
        registry = copy.deepcopy(self.registry)
        self.request_read("status", lambda: collect_status(self.manager_config, registry))
        source = self.page_source()
        if source == "backups":
            self.request_read(source, lambda: backup_rows(registry))
        elif source == "logs":
            unit = self.log_unit
            self.request_read(source, lambda: fetch_journal(unit, registry=registry))
        elif source == "core":
            self.request_read(source, lambda: collect_core_status(registry))
        elif source == "proxies":
            self.request_read(source, lambda: (proxy_groups(registry), controller_request(registry, "/configs")))

    def poll_refresh(self) -> bool:
        changed = False
        while not self._results.empty():
            source, generation, unit, value, error = self._results.get_nowait()
            self._pending.discard(source)
            if generation != self._generation or (source == "logs" and unit != self.log_unit):
                continue
            changed = True
            if source == "registry" and not error and self.registry != value:
                self.invalidate()
                self.registry = value
            self._checked[source] = time.monotonic()
            if error:
                self._errors[source] = error
                continue
            self._errors.pop(source, None)
            if source == "status":
                self.status = value
            elif source == "backups":
                self.backups = value
            elif source == "logs":
                self.logs = value
            elif source == "core":
                self.core_status = value
            elif source == "proxies":
                self.groups, self.live_config = value
                self.controller_error = None
                self.group_index = min(self.group_index, max(0, len(self.groups) - 1))
                if self.open_group not in self.groups:
                    self.open_group = None
        self.subscription_index = min(
            self.subscription_index,
            max(0, len(self.registry.get("subscriptions", {})) - 1),
        )
        self.backup_index = min(self.backup_index, max(0, len(self.backups) - 1))
        self.log_scroll = min(self.log_scroll, max(0, len(self.logs) - 1))
        self.controller_error = self._errors.get("proxies")
        self.refresh(force=False)
        return changed

    def close(self) -> None:
        self._closed = True
        self.invalidate()

    def change_page(self, index: int) -> None:
        self.page = index % len(self.PAGES)
        self.log_scroll = 0
        self.refresh(force=False)

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
        nav_width = sum(display_width(tr(name)) + 7 for name in self.PAGES)
        first = max(0, self.page - 3) if nav_width >= width else 0
        if first:
            self.put(2, 0, "‹")
        for index in range(first, len(self.PAGES)):
            name = self.PAGES[index]
            item = f" {index + 1} {tr(name)} "
            if nav_column + display_width(item) >= width - 2:
                self.put(2, width - 2, "›")
                break
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
        elif self.page == 4:
            self.draw_logs(5)
        elif self.page == 5:
            self.draw_core(5)
        else:
            self.draw_proxies(5)

        self.put(height - 2, 0, "─" * max(1, width - 1), self.curses.color_pair(4))
        error = next((self._errors[s] for s in ("registry", self.page_source(), "status") if s in self._errors), None)
        if error:
            self.message = tr("刷新失败（r 重试）：{error}", error=error)
        elif self._pending & {"registry", "status", self.page_source()}:
            self.message = tr("后台加载中，仍可切换页面或退出。")
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

    def draw_core(self, start: int) -> None:
        self.put(start, 2, tr("内核与服务"), self.curses.A_BOLD)
        rows = [
            (tr("内核版本"), format_state(self.core_status.get("version"))),
            (tr("主服务"), format_state(self.status.get("mihomo_service"))),
            (tr("开机启动"), format_state(self.core_status.get("enabled"))),
            (tr("自动更新"), format_state(self.status.get("timer_enabled"))),
            (tr("更新频率"), self.status.get("update_interval", "-")),
            (tr("内核文件"), self.core_status.get("binary", "-")),
            (tr("上一版内核"), format_state(self.core_status.get("backup", "none"))),
        ]
        for offset, (label, value) in enumerate(rows, 1):
            self.put(start + offset, 3, fit_display(label, 16) + "  " + value)
        if self.registry.get("service_backend") == "container":
            self.put(start + 8, 3, tr("内核随容器镜像更新；k 重启内核。"))
            self.put(start + 9, 3, tr("t 自动更新 · f 更新频率"))
        else:
            self.put(start + 8, 3, tr("i 安装/修复 · u 升级内核 · b 回退内核"))
            self.put(start + 9, 3, tr("s 启动 · x 停止 · k 重启"))
            self.put(start + 10, 3, tr("e 开机启动 · t 自动更新 · f 更新频率"))
        self.message = self.core_status.get("error") or tr("r 刷新 · Tab 切换 · q 退出")

    def draw_proxies(self, start: int) -> None:
        mode = format_state(self.live_config.get("mode"))
        self.put(start, 2, tr("节点与模式：{mode}", mode=mode), self.curses.A_BOLD)
        if self.controller_error:
            self.put(start + 2, 3, self.controller_error, self.curses.color_pair(3))
            self.message = tr("r 重试 · 6 内核与服务 · Tab 切换")
            return
        group = self.groups.get(self.open_group, {})
        items = group.get("all", []) if self.open_group else list(self.groups)
        if not items:
            self.put(start + 2, 3, tr("尚无策略组，请先添加并应用订阅。"))
        height, _ = self.screen.getmaxyx()
        available = max(1, height - start - 4)
        selected = self.node_index if self.open_group else self.group_index
        selected = min(selected, max(0, len(items) - 1))
        if self.open_group:
            self.node_index = selected
            self.put(start + 1, 3, str(self.open_group))
        else:
            self.group_index = selected
            self.put(start + 1, 3, tr("选择策略组后按 Enter 查看节点"))
        first = max(0, selected - available + 1)
        for offset, name in enumerate(items[first:first + available]):
            index = first + offset
            if self.open_group:
                text = f"{'*' if name == group.get('now') else ' '} {name}"
            else:
                details = self.groups[name]
                text = f"{name} [{format_state(details.get('type'))}] → {details.get('now', '-')}"
            self.put(start + 2 + offset, 3, text,
                     self.curses.A_REVERSE if index == selected else 0)
        self.message = tr("↑↓ 选择 · Enter 打开/使用 · Esc 返回 · d 测速 · m 模式")

    def choose_mode(self) -> None:
        print(tr("rule 规则模式 · global 全局代理 · direct 直连"))
        mode = ask(tr("运行模式"), str(self.live_config.get("mode") or "rule"))
        set_proxy_mode(self.registry, mode)

    def handle_core_key(self, key: int) -> None:
        if key == ord("i"):
            self.run_external(tr("安装内核与主服务"), lambda: bootstrap_install(self.manager_config))
        elif key == ord("u"):
            self.run_external(tr("升级内核"), lambda: install_core(self.registry, update=True))
        elif key == ord("b"):
            def restore() -> None:
                if confirm(tr("确认回退内核（运行中的服务会短暂重启）吗")):
                    rollback_core(self.registry)
            self.run_external(tr("回退内核"), restore)
        elif key in (ord("s"), ord("x"), ord("k")):
            action = {ord("s"): "start", ord("x"): "stop", ord("k"): "restart"}[key]
            self.run_external(tr("管理主服务"), lambda: service_action(self.registry, action))
        elif key == ord("e"):
            if self.core_status.get("enabled", "unknown") == "unknown":
                return
            enabled = self.core_status.get("enabled", "").startswith("enabled")
            self.run_external(tr("开机启动"), lambda: service_action(self.registry, "disable" if enabled else "enable"))
        elif key == ord("t"):
            if self.status.get("timer_enabled", "unknown") == "unknown":
                return
            enabled = str(self.status.get("timer_enabled", "")).startswith("enabled")
            self.run_external(tr("自动更新"), lambda: configure_update_schedule(self.manager_config, self.registry, enabled=not enabled))
        elif key == ord("f"):
            self.run_external(tr("更新频率"), lambda: choose_update_schedule(self.manager_config, self.registry))

    def handle_proxy_key(self, key: int) -> None:
        if key in (27, 8, 127):
            self.open_group = None
            return
        if key == ord("m"):
            self.run_external(tr("运行模式"), self.choose_mode)
            return
        group = self.groups.get(self.open_group, {})
        items = group.get("all", []) if self.open_group else list(self.groups)
        if not items:
            return
        index = self.node_index if self.open_group else self.group_index
        index = min(index, len(items) - 1)
        if key in (self.curses.KEY_UP, self.curses.KEY_DOWN):
            index = max(0, min(len(items) - 1, index + (1 if key == self.curses.KEY_DOWN else -1)))
            if self.open_group:
                self.node_index = index
            else:
                self.group_index = index
        elif key in (10, 13, self.curses.KEY_ENTER):
            if self.open_group:
                self.run_external(tr("选择节点"), lambda: select_proxy(self.registry, str(self.open_group), items[index]))
            else:
                self.open_group = items[index]
                self.node_index = 0
        elif key == ord("d"):
            self.run_external(tr("测试节点延迟"), lambda: test_proxy_delay(self.registry, items[index]))

    def run_external(self, title: str, action: Callable[[], None]) -> None:
        self.invalidate()
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
                tr("全局：1-7 切换页面，Tab/Shift-Tab 前后切换，r 刷新，l 切换语言，q 退出。\n概览：u 更新当前订阅，d 仅下载并校验。\n订阅：方向键选择，Enter 激活，u 更新，d 校验，a 添加，x 删除。\n备份：方向键选择，Enter 校验并恢复；恢复失败会自动还原。\n日志：方向键滚动，t 在更新服务和 Mihomo 服务之间切换。\n\nTUI 不会显示订阅 URL、Secret 或节点凭据。")
            )
            print(tr("内核：i 安装，u 升级，b 回退，s/x/k 启动/停止/重启，e 开机启动，t 自动刷新。"))
            print(tr("更新频率：内核页面按 f 设置，t 启用或停用自动刷新。"))
            print(tr("节点：Enter 打开组或使用节点，Esc 返回，d 测试延迟，m 保存运行模式。"))

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
        if ord("1") <= key < ord("1") + len(self.PAGES):
            self.change_page(key - ord("1"))
            return True
        if key in (9, self.curses.KEY_RIGHT):
            self.change_page(self.page + 1)
            return True
        if key in (self.curses.KEY_BTAB, self.curses.KEY_LEFT):
            self.change_page(self.page - 1)
            return True
        if key in (ord("r"), ord("R")):
            self.refresh()
            return True
        if not self.registry:
            return True
        if self.page == 5:
            self.handle_core_key(key)
            return True
        if self.page == 6:
            self.handle_proxy_key(key)
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
                self.logs = []
                self._checked.pop("logs", None)
                self._errors.pop("logs", None)
                self.refresh(force=False)
            return True
        return True

    def run(self) -> None:
        self.screen.keypad(True)
        self.screen.timeout(100)
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
        dirty = True
        try:
            while running:
                dirty = self.poll_refresh() or dirty
                if dirty:
                    self.draw()
                key = self.screen.getch()
                dirty = key != -1
                if dirty:
                    running = self.handle_key(key)
        finally:
            self.close()


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

    install_parser = subparsers.add_parser("install", help=tr("安装内核、初始配置和 systemd 主服务"))
    install_parser.add_argument("--version", default="latest", help=tr("官方稳定版版本号，默认 latest"))
    install_parser.add_argument("--no-start", action="store_true", help=tr("创建主服务但不启动或设置开机启动"))
    install_parser.add_argument("--interactive", action="store_true", help=tr("安装后引导订阅设置并打开 TUI"))
    core_parser = subparsers.add_parser("core", help=tr("查看、安装、升级或回退 Mihomo 内核"))
    core_parser.add_argument("action", choices=("status", "check", "install", "update", "rollback"), nargs="?", default="status")
    core_parser.add_argument("--version", default="latest", help=tr("官方稳定版版本号，默认 latest"))
    core_parser.add_argument("--yes", action="store_true", help=tr("跳过交互确认"))
    service_parser = subparsers.add_parser("service", help=tr("管理主服务或订阅刷新定时器"))
    service_parser.add_argument("action", choices=("status", "start", "stop", "restart", "enable", "disable"), nargs="?", default="status")
    service_parser.add_argument("--timer", action="store_true", help=tr("操作订阅刷新定时器"))
    schedule_parser = subparsers.add_parser("schedule", help=tr("查看或设置订阅自动更新频率"))
    schedule_parser.add_argument("interval", nargs="?", help=tr("更新间隔，例如 30m、6h、1d（1 分钟至 30 天）"))
    schedule_state = schedule_parser.add_mutually_exclusive_group()
    schedule_state.add_argument("--enable", action="store_true", help=tr("启用自动刷新订阅"))
    schedule_state.add_argument("--disable", action="store_true", help=tr("停用自动刷新订阅"))
    proxies_parser = subparsers.add_parser("proxies", help=tr("查看策略组、选择节点或测试延迟"))
    proxy_commands = proxies_parser.add_subparsers(dest="proxy_action")
    proxy_commands.add_parser("list", help=tr("查看策略组及节点"))
    select_parser = proxy_commands.add_parser("select", help=tr("选择节点"))
    select_parser.add_argument("group")
    select_parser.add_argument("node")
    delay_parser = proxy_commands.add_parser("delay", help=tr("测试节点延迟"))
    delay_parser.add_argument("node")
    mode_parser = subparsers.add_parser("mode", help=tr("查看或保存运行模式"))
    mode_parser.add_argument("mode", choices=("rule", "global", "direct"), nargs="?")

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
        if command == "install":
            bootstrap_install(manager_config, version=args.version, start=not args.no_start)
            if args.interactive:
                onboard(manager_config)
            return 0
        if command == "init":
            initialize(manager_config, force=args.force)
            return 0
        if command == "tui" and not manager_config.exists() and sys.stdin.isatty() and sys.stdout.isatty():
            if confirm(tr("首次运行，立即安装 Mihomo 内核与主服务吗"), True):
                bootstrap_install(manager_config)
                onboard(manager_config)
            return 0
        registry = load_registry(manager_config)
        if command == "core":
            if args.action == "status":
                info = collect_core_status(registry)
                for label, key in ((tr("内核版本"), "version"), (tr("内核文件"), "binary"),
                                   (tr("开机启动"), "enabled"), (tr("上一版内核"), "backup")):
                    print(f"{label}: {format_state(info.get(key))}")
                if info.get("error"):
                    raise ManagerError(info["error"])
            elif args.action == "check":
                release = resolve_core_release(args.version)
                print(tr("可用稳定版：{version} · {asset}", version=release["version"], asset=release["name"]))
            elif args.action == "rollback":
                if args.yes or confirm(tr("确认回退内核（运行中的服务会短暂重启）吗")):
                    rollback_core(registry)
            else:
                install_core(registry, version=args.version, update=args.action == "update", yes=args.yes)
        elif command == "service":
            if args.action == "status":
                print_status(manager_config, registry)
            else:
                if args.timer and args.action in {"enable", "disable"}:
                    configure_update_schedule(manager_config, registry, enabled=args.action == "enable")
                else:
                    service_action(registry, args.action, timer=args.timer)
        elif command == "schedule":
            if args.interval is not None or args.enable or args.disable:
                configure_update_schedule(manager_config, registry, args.interval,
                                          enabled=True if args.enable else False if args.disable else None)
            print_status(manager_config, registry)
        elif command == "proxies":
            if args.proxy_action == "select":
                select_proxy(registry, args.group, args.node)
            elif args.proxy_action == "delay":
                test_proxy_delay(registry, args.node)
            else:
                print_proxy_groups(registry)
        elif command == "mode":
            if args.mode:
                set_proxy_mode(registry, args.mode)
            else:
                print(format_state(controller_request(registry, "/configs").get("mode")))
        elif command == "tui":
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
