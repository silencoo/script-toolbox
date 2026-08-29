# Mihomo Console

面向 Debian/Ubuntu 服务器的 Mihomo 完整订阅配置控制台。它把安全更新核心、
systemd 定时任务、诊断命令和一个零额外依赖的 SSH TUI 放在同一个工具里。

适用场景是“订阅地址返回完整 Clash/Mihomo YAML”。多个订阅是多个可切换的
完整配置，**不会合并为一份**；定时任务只更新当前选中的订阅。

## 能做什么

- TUI 概览 Mihomo 服务、更新 timer、当前订阅、配置摘要和最近错误。
- 添加、切换、dry-run 和更新完整订阅，不显示订阅 URL。
- 保存最近 50 次脱敏的更新/回滚历史。
- 查看最近 8 份配置备份，校验后手动恢复。
- 在 TUI 中查看更新服务与 Mihomo 的 journald 日志。
- 通过 systemd timer 无人值守更新，CLI 子命令保持适合脚本调用。

每次实际更新按以下顺序执行：

1. 下载当前订阅，URL 不写入输出或历史。
2. 将 `/etc/mihomo/local-overrides.yaml` 深度合并到远端配置之上。
3. 用 `mihomo -t` 校验候选配置。
4. 备份旧配置并原子替换 `/etc/mihomo/config.yaml`。
5. 重启 `mihomo.service`，确认连续至少 3 秒保持 active。
6. 启动失败时恢复旧配置并再次启动。

本地覆盖默认负责 `external-controller`、`secret` 和
`external-controller-cors`，也可以加入其他不希望被订阅覆盖的顶层设置。

## 安装

在本目录运行：

```bash
./setup.sh
```

安装脚本会在需要时请求 `sudo`，检查 Python/PyYAML，安装程序、文档和
systemd 单元，然后引导初始化、添加订阅、dry-run、首次应用与启用 timer。
已有 `/etc/mihomo/subscription-manager.json` 不会被覆盖，真正替换配置和启用
timer 前也会分别确认。

只安装文件、不初始化：

```bash
./setup.sh --install-only
```

安装后的主命令是：

```bash
sudo mihomo-console
```

## Docker 部署

Docker 版本把 Mihomo 内核、Console 和自动更新循环放在同一容器中，并可选启动
MetaCubeXD Dashboard。它不在容器中模拟 systemd：PID 1 监督 Mihomo，Console
通过容器运行时安全重启内核，原有的校验、原子替换和失败回滚流程保持不变。

镜像支持 `linux/amd64`、`linux/arm64` 和 `linux/arm/v7`：

```text
ghcr.io/silencoo/mihomo-console:latest
```

### Docker Compose

复制环境变量模板并至少设置 NAS 的固定局域网 IP：

```bash
cd mihomo-console
cp .env.example .env
# 编辑 .env：设置 NAS_IP，以及需要时设置 DATA_PATH 和 MIHOMO_SECRET
docker compose up -d
```

默认端口：

- `18080`：MetaCubeXD Dashboard。
- `19090`：Mihomo Controller API。
- `17890`：HTTP/SOCKS mixed proxy。

如果 `MIHOMO_SECRET` 留空，首次启动会生成 64 位随机 Secret，并只写入持久化
目录。查看它并在 Dashboard 中填写：

```bash
docker compose exec mihomo-console mihomo-console show-secret
```

添加订阅、校验并首次应用：

```bash
docker compose exec mihomo-console mihomo-console add
docker compose exec mihomo-console mihomo-console update-active --dry-run
docker compose exec mihomo-console mihomo-console update-active
```

更新时会自动处理新版 Mihomo 的两项兼容变化：把已移除的
`global-client-fingerprint` 迁移到适用的内联代理，并强制把 REALITY
`short-id` 输出为带引号的字符串，避免纯数字或科学计数法外观的 ID 被 YAML
解析器误判类型。订阅源本身不合法的节点仍会被 Mihomo 校验拒绝。

进入完整 TUI：

```bash
docker compose exec mihomo-console mihomo-console
```

查看运行状态与日志：

```bash
docker compose ps
docker compose logs -f mihomo-console
docker compose exec mihomo-console mihomo-console status
```

`UPDATE_START_DELAY_SECONDS` 默认为 `600`，`UPDATE_INTERVAL_SECONDS` 默认为
`3600`；后者设为 `0` 可禁用容器内自动更新。镜像更新方式：

```bash
docker compose pull
docker compose up -d
```

### QNAP Container Station

1. 在 QNAP 中选择或创建一个用于持久化的共享文件夹及子目录。
2. 打开 Container Station 3，进入“应用程序 → 创建”。
3. 复制 `deploy/qnap.compose.yaml`，把示例 IP `192.168.1.50` 改成 NAS
   的固定局域网 IP，并把 `/replace_me` 改成实际目录，例如
   `/share/docker-data/mihomo-console`。
4. 创建应用，待两个容器健康后访问 `http://NAS_IP:18080`。
5. 从 Container Station 的终端进入 `mihomo-console` 容器，或通过 SSH 执行上面的
   `docker exec -it mihomo-console mihomo-console` 完成订阅初始化。

QNAP 管理界面经常占用 `8080`，因此示例默认使用 `18080`。如果其他端口也有
冲突，只修改 Compose 端口映射左侧的主机端口。

### TrueNAS

适用于使用 Docker Apps 后端的 TrueNAS 24.10+；TrueNAS CORE 需要改用 Linux
虚拟机。先创建例如 `tank/apps/mihomo-console` 的 Dataset，然后：

1. 进入“Apps → Discover Apps → ⋮ → Install via YAML”。
2. 应用名称填写 `mihomo-console`。
3. 粘贴 `deploy/truenas.compose.yaml`，将其中的 `tank` 和示例 IP 替换为实际
   存储池名称与固定局域网 IP。
4. 确认 Dataset 允许容器写入，然后保存部署。

TrueNAS 的 YAML 编辑器不读取仓库旁的 `.env` 文件，因此专用模板没有使用
Compose 环境变量插值。

### 持久化和安全边界

容器只需要一个可写的 `/data`：

- `/data/manager/`：订阅注册表、本地覆盖和配置备份。
- `/data/mihomo/`：当前配置、Geo 数据和 Mihomo 缓存。
- `/data/logs/`：轮换后的 Mihomo 与自动更新日志。

不需要 `privileged`、host network、`NET_ADMIN` 或 `/dev/net/tun`。此方案提供显式
HTTP/SOCKS 代理，不是透明网关。Dashboard、Controller 和 mixed proxy 只应开放
给可信局域网或 VPN；不要直接转发到公网。

首次启动会进入 TUI。安装器还会创建旧命令
`mihomo-subscription-manager` 的兼容符号链接；管理配置、备份目录和 systemd
单元名称保持兼容，不要求现有用户迁移数据。

### 手动安装

```bash
sudo apt install python3-yaml
sudo install -m 0755 mihomo_console.py /usr/local/sbin/mihomo-console
sudo install -d -m 0755 /usr/local/share/doc/mihomo-console
sudo install -m 0644 README.md /usr/local/share/doc/mihomo-console/README.md
sudo install -m 0644 mihomo-subscription-update.service /etc/systemd/system/
sudo install -m 0644 mihomo-subscription-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

首次配置：

```bash
sudo mihomo-console init
sudo mihomo-console configure-systemd-sandbox
sudo mihomo-console add
sudo mihomo-console update-active --dry-run
sudo mihomo-console update-active
sudo systemctl enable --now mihomo-subscription-update.timer
```

## TUI

```bash
sudo mihomo-console
```

主要页面和快捷键：

- `1` 概览：`u` 更新，`d` dry-run。
- `2` 订阅：方向键选择，`Enter` 激活，`a` 添加，`x` 删除。
- `3` 历史：查看脱敏的更新和回滚结果。
- `4` 备份：选择后按 `Enter` 校验并恢复。
- `5` 日志：`t` 切换更新服务/Mihomo 日志，方向键滚动。
- 全局：`Tab` 切页，`r` 刷新，`?` 帮助，`q` 退出。

TUI 中需要输入 URL、确认危险操作或等待更新时，会临时返回普通终端；操作
结束后按 Enter 回到控制台。TUI 至少需要 70×18 的终端。

## CLI 与诊断

```bash
sudo mihomo-console status
sudo mihomo-console list
sudo mihomo-console history --limit 30
sudo mihomo-console backups
sudo mihomo-console rollback config.yaml.TIMESTAMP

sudo mihomo-console add
sudo mihomo-console activate NAME
sudo mihomo-console update NAME --dry-run
sudo mihomo-console update NAME
sudo mihomo-console update-active
sudo mihomo-console configure-overlay
sudo mihomo-console configure-systemd-sandbox
sudo mihomo-console show-secret
```

`activate` 只改变当前订阅指针；运行 `update-active` 后才会下载并应用。
`rollback` 只接受 `backups` 列出的受管理文件，恢复前先做 `mihomo -t` 校验，
恢复后启动失败则自动回到回滚前配置。脚本中显式确认可使用 `rollback --yes`。

底层日志仍保留在 journald：

```bash
journalctl -u mihomo-subscription-update.service -e
journalctl -u mihomo.service -e
systemctl list-timers mihomo-subscription-update.timer
```

## 定时更新

默认启动 10 分钟后首次执行，之后约每小时更新一次，随机延迟最多 5 分钟：

```bash
sudo systemctl enable --now mihomo-subscription-update.timer
```

可通过 `sudo systemctl edit mihomo-subscription-update.timer` 覆盖频率。例如每天：

```ini
[Timer]
OnBootSec=
OnUnitActiveSec=
OnCalendar=daily
RandomizedDelaySec=30min
```

修改 `target_config`、`mihomo_home`、`overlay_file`、`backup_dir` 或 `lock_file`
后，重新运行 `sudo mihomo-console configure-systemd-sandbox`。它会按实际路径生成
systemd drop-in，避免 `ProtectSystem=strict` 阻止写入。

## 文件与安全边界

- `/etc/mihomo/subscription-manager.json`：订阅 URL、脱敏历史，权限 0600。
- `/etc/mihomo/local-overrides.yaml`：本地 Secret 和控制器设置，权限 0600。
- `/etc/mihomo/backups/`：最近 8 份完整配置，目录 0700、文件 0600。
- `/etc/mihomo/config.yaml`：成功应用后为 0600，并尽量保留原属主。
- `/run/lock/mihomo-subscription-manager.lock`：防止 timer 与手动更新并发。

历史只保存订阅名称、时间、结果、耗时、配置哈希、节点/provider/组/规则数量和
脱敏错误，不保存订阅 URL、Secret 或节点凭据。完整配置备份本身包含节点
凭据，因此必须继续保持 0600，不能上传到 Git。

若 `external-controller` 使用 `0.0.0.0:9090`，仍应通过主机防火墙限制可信局域网，
并设置强 Secret。CORS Origin 必须包含协议和前端端口。

## 开发与测试

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m unittest -v
python3 -m py_compile mihomo_console.py test_manager.py
bash -n setup.sh
```
