# Mihomo 完整订阅配置管理器

这个工具适合“订阅地址返回完整 Clash/Mihomo YAML”的场景。多个订阅是多个可切换的完整配置，**不会把它们合并成一份**；定时任务只更新当前选中的那个。

每次更新按下面的顺序执行：

1. 下载当前订阅（URL 不会打印到日志）。
2. 将 `/etc/mihomo/local-overrides.yaml` 深度合并到远端配置之上。
3. 用 `mihomo -t` 校验生成的候选配置。
4. 备份旧配置并原子替换 `/etc/mihomo/config.yaml`。
5. 执行 `systemctl restart mihomo.service` 并确认服务进入 active。
6. 如果启动失败，恢复备份并再次启动旧配置。

本地覆盖默认负责 `external-controller`、`secret` 和 `external-controller-cors`，所以远端 YAML 是否包含这些字段都没有关系。覆盖文件也可以手动加入任意其他不希望被订阅覆盖的顶层配置。

## 安装

推荐直接运行交互式安装脚本：

```bash
./setup.sh
```

脚本会在需要时请求一次 `sudo`，自动安装缺失的 Python/PyYAML、管理器和
systemd 单元，然后引导初始化、添加订阅、dry-run、首次应用以及启用 timer。
已有的 `/etc/mihomo/subscription-manager.json` 不会被覆盖，实际应用配置和
启用定时任务前也会分别确认。

如果只想安装文件、暂时不进行初始化：

```bash
./setup.sh --install-only
```

### 手动安装

Debian/Ubuntu 可先安装 PyYAML：

```bash
sudo apt install python3-yaml
```

然后从本目录安装脚本和 systemd 单元：

```bash
sudo install -m 0755 mihomo_subscription_manager.py /usr/local/sbin/mihomo-subscription-manager
sudo install -d -m 0755 /usr/local/share/doc/mihomo-subscription-manager
sudo install -m 0644 README.md /usr/local/share/doc/mihomo-subscription-manager/README.md
sudo install -m 0644 mihomo-subscription-update.service /etc/systemd/system/
sudo install -m 0644 mihomo-subscription-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

首次配置：

```bash
sudo mihomo-subscription-manager init
sudo mihomo-subscription-manager add
sudo mihomo-subscription-manager update-active --dry-run
sudo mihomo-subscription-manager update-active
```

不带子命令运行会进入交互菜单：

```bash
sudo mihomo-subscription-manager
```

确认手动更新正常后，再启用定时任务：

```bash
sudo systemctl enable --now mihomo-subscription-update.timer
systemctl list-timers mihomo-subscription-update.timer
```

默认启动 10 分钟后首次运行，之后约每小时更新一次，并随机延迟最多 5 分钟。可用 systemd drop-in 调整频率：

```bash
sudo systemctl edit mihomo-subscription-update.timer
```

例如每天一次：

```ini
[Timer]
OnBootSec=
OnUnitActiveSec=
OnCalendar=daily
RandomizedDelaySec=30min
```

修改后运行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart mihomo-subscription-update.timer
```

## 常用命令

```bash
sudo mihomo-subscription-manager list
sudo mihomo-subscription-manager add
sudo mihomo-subscription-manager activate NAME
sudo mihomo-subscription-manager update NAME --dry-run
sudo mihomo-subscription-manager update NAME
sudo mihomo-subscription-manager configure-overlay
sudo mihomo-subscription-manager show-secret
journalctl -u mihomo-subscription-update.service
```

`activate` 只改变“当前订阅”指针，不会立即覆盖运行配置；随后执行 `update-active` 才会应用。

## 文件与安全边界

- `/etc/mihomo/subscription-manager.json`：订阅 URL，权限 0600。
- `/etc/mihomo/local-overrides.yaml`：本地 Secret 和控制器设置，权限 0600。
- `/etc/mihomo/backups/`：最近 8 份完整配置，目录 0700、文件 0600。
- `/etc/mihomo/config.yaml`：成功应用后强制为 0600，同时尽量保留原属主。
- 当前源码目录不存放订阅 URL 或 Secret，但如果用 `npx serve .`，知道准确路径的人仍可能下载源码。安装完成后不需要通过 Web 暴露这个 `admin/` 目录。

如果 `external-controller` 使用 `0.0.0.0:9090`，Secret 只是第一层保护；仍建议用主机防火墙把 9090 只开放给可信局域网地址。CORS 的 Origin 必须包含协议和前端端口，例如 `http://192.168.1.10:3000`，不是 Zashboard 页面路径。

订阅提供方通常会让 URL 自身携带令牌。不要把管理配置、备份或日志上传到 Git 仓库，也不要把 URL 放到 systemd unit 的命令行参数中。
