# Mihomo Console

面向 Debian/Ubuntu 的终端代理管理应用，包含 Mihomo 内核安装与升级、systemd
服务管理、完整订阅刷新、节点选择和运行模式切换，可直接通过 SSH 使用。

适用场景是“订阅地址返回完整 Clash/Mihomo YAML”。多个订阅是多个可切换的
完整配置，**不会合并为一份**；定时任务只更新当前选中的订阅。

## 能做什么

- 在全新 Linux 主机上下载官方稳定版内核，校验 SHA-256，创建并启用主服务。
- 保留已有内核、主服务和配置；显式升级内核前校验配置，启动失败恢复旧内核。
- 在 TUI 中启动、停止、重启主服务，控制开机启动和订阅自动刷新的间隔。
- 查看策略组、选择手动策略组的节点、测试延迟，保存规则/全局/直连模式。
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

安装脚本会请求 `sudo`，检查 systemd、Python/PyYAML 和 CA 证书，然后：

1. 安装 Console、文档和订阅刷新单元。
2. 内核缺失时从 `MetaCubeX/mihomo` 官方稳定版下载匹配架构的发布包，校验
   GitHub 发布资产的 SHA-256，再验证内核版本；缺少校验值时停止安装。
3. 创建缺失的管理配置、本地覆盖及初始直连配置。默认代理端口
   `127.0.0.1:7890`，控制器 `127.0.0.1:9090`，自动生成控制器密钥。
4. 创建缺失的 `mihomo.service`，验证配置、启动并设置开机启动。
5. 在交互终端中引导添加订阅、校验和应用；成功应用后询问是否启用自动刷新，
   并让用户选择更新间隔，最后打开 TUI。

已有内核、主服务、管理配置、当前配置和本地覆盖不会被覆盖；已有服务的
启停及开机启动状态保持原样。主服务使用的内核路径与 `mihomo_binary` 不一致
时会停止并提示校正，不接管不匹配的服务。

支持 x86-64、x86 32 位、ARM64、ARMv7 和 ARMv6。x86-64 优先选择 `amd64-v1`
或兼容构建，避免较老 CPU 无法运行高指令集版本。

可指定稳定版、语言，或暂不启动新建的主服务：

```bash
./setup.sh --core-version v1.19.30 --lang zh_CN
./setup.sh --no-start
```

初始配置只提供本机直连代理；添加并应用订阅后才有代理节点。安装器不会修改
桌面系统代理、启用 TUN 或更改路由。后续订阅更新会继续保留本地端口、控制器
和模式覆盖。

只更新 Console 文件及订阅刷新单元，不下载内核或初始化主配置：

```bash
./setup.sh --install-only
```

安装后的主命令是：

```bash
sudo mihomo-console
```

### 内核与服务管理

安装 Console 后，也可直接完成本机安装或查看可用稳定版：

```bash
sudo mihomo-console install
sudo mihomo-console core status
sudo mihomo-console core check
sudo mihomo-console core update
sudo mihomo-console core update --version v1.19.30 --yes
sudo mihomo-console core rollback --yes
```

内核更新与订阅刷新共用操作锁。新内核先通过版本检查和当前配置校验，再原子
替换；旧内核保存在可执行文件旁的 `.previous`。原服务正在运行时会重启并检查
稳定性，启动失败恢复旧内核并重新启动。原服务停止时，更新保持停止状态。
`core rollback` 同样先校验再替换，并把替换下来的版本保留为 `.previous`。
符号链接形式的内核不会被替换，应使用原安装方式管理。

```bash
sudo mihomo-console service status
sudo mihomo-console service start
sudo mihomo-console service stop
sudo mihomo-console service restart
sudo mihomo-console service enable
sudo mihomo-console service disable
sudo mihomo-console service enable --timer
sudo mihomo-console service disable --timer
```

主服务的 `enable/disable` 只修改开机启动；定时器的 `enable/disable` 同时启动或
停止定时器。自动刷新只更新订阅，**不会自动升级内核**。

### 节点与运行模式

```bash
sudo mihomo-console proxies list
sudo mihomo-console proxies select '策略组名称' '节点名称'
sudo mihomo-console proxies delay '节点名称'
sudo mihomo-console mode
sudo mihomo-console mode rule
sudo mihomo-console mode global
sudo mihomo-console mode direct
```

节点列表来自正在运行的控制器，手动切换只允许 `Selector` 类型的组。初始本地
覆盖启用 `profile.store-selected`，由 Mihomo 保存节点选择；已有配置是否保存
选择取决于其设置。延迟测试通过所选节点访问
`https://www.gstatic.com/generate_204`，超时为 5 秒。

模式切换会验证候选配置，保存到当前配置和本地覆盖，再通过控制器应用；请求
失败时恢复文件并尝试恢复原运行模式。这样重启及订阅刷新后仍保留所选模式。
控制器请求绕过 shell 的代理环境变量，密钥只放在认证头中，并拒绝 HTTP 重定向。
控制器未开启、认证失败或服务离线时，节点页面会提示原因。

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
`3600`；后者设为 `0` 可禁用容器内自动更新。也可在 TUI 的内核页按 `f` 修改
间隔、`t` 启停，或使用 `mihomo-console schedule 6h --enable`。
Console 保存的 `update_schedule` 优先于环境变量，随数据目录持久化；运行中
约 1 秒内生效，无需重启容器。修改间隔会重新计时；正在进行的更新会先完成。
首次启动仍使用 `UPDATE_START_DELAY_SECONDS`，之后在每次更新结束后等待所选间隔。
镜像更新方式：

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

- `1` 概览：`u` 更新，`d` 仅校验。
- `2` 订阅：方向键选择，`Enter` 激活，`a` 添加，`x` 删除。
- `3` 历史：查看脱敏的更新和回滚结果。
- `4` 备份：选择后按 `Enter` 校验并恢复。
- `5` 日志：`t` 切换更新服务/Mihomo 日志，方向键滚动。
- `6` 内核：`i` 安装/修复，`u` 升级，`b` 回退，`s/x/k` 启动/停止/重启，
  `e` 开机启动，`t` 自动刷新启停，`f` 设置更新频率。
- `7` 节点：方向键选择，`Enter` 打开组或使用节点，`Esc` 返回组列表，
  `d` 测试延迟，`m` 设置运行模式。
- 全局：`Tab` 切页，`r` 刷新，`l` 切换中英文，`?` 帮助，`q` 退出。

TUI 中需要输入 URL、确认危险操作或等待更新时，会临时返回普通终端；操作
结束后按 Enter 回到控制台。TUI 至少需要 70×18 的终端。
窄终端会显示当前页面附近的导航项，可用 `1`–`7` 或 `Tab` 切换全部页面。
页面先显示缓存，后台每 5 秒刷新状态；备份、日志、内核和节点仅在进入对应
页面后读取。切页不会等待 systemd、日志或控制器请求；`r` 强制重新读取，
加载时仍可切页或退出。
Docker 内可管理节点、模式、自动更新频率和重启内核；内核升级、容器启停及开机启动仍由
镜像和容器管理器负责。

### 界面语言

TUI、CLI 状态、帮助以及添加订阅、校验、更新和回滚的交互提示支持简体中文
和英文。中文界面会把内部状态显示为“运行中”“已禁用”“校验通过”等，
并使用“仅校验”“节点提供器”等统一术语。

用全局参数 `--lang` 指定语言，放在子命令之前：

```bash
sudo mihomo-console --lang zh_CN
sudo mihomo-console --lang en_US
sudo mihomo-console --lang zh_CN update-active --dry-run
sudo mihomo-console --lang en_US status
```

默认 `--lang auto`，依次读取 `MIHOMO_CONSOLE_LANG`、`LC_ALL`、`LC_MESSAGES`、
`LANG`。`en`/`en_*` 使用英文，中文环境使用简体中文；`C`、`POSIX`、未设置或
不支持的语言回退到中文。应用环境变量可设为 `zh_CN`、`en_US` 或 `auto`，例如：

```bash
sudo env MIHOMO_CONSOLE_LANG=zh_CN mihomo-console
```

TUI 中按 `l` 可即时切换语言，只对当前会话生效。订阅名称、文件路径、历史中
已保存的错误详情，以及 Mihomo/systemd 原始日志保留原文；内部状态码与配置
文件内容不受显示语言影响。

从旧版升级后需退出并重新打开 TUI，正在运行的旧进程不会自动加载新代码：

```bash
./setup.sh --install-only
sudo mihomo-console --lang zh_CN
```

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

TUI 按 `6` 进入内核页，再按 `f` 设置间隔。可输入 `30m`、`1h`、`6h`、`12h`、
`1d` 等，支持 **1 分钟至 30 天**的整数分钟、小时或天；按 `t` 启用或停用。
命令行同样支持：

```bash
sudo mihomo-console schedule                # 查看状态和间隔
sudo mihomo-console schedule 6h             # 改为每 6 小时，保留启停状态
sudo mihomo-console schedule 30m --enable   # 每 30 分钟，并启用
sudo mihomo-console schedule 1d --enable    # 每 24 小时，并启用
sudo mihomo-console schedule --disable      # 停用，保留所选间隔
sudo mihomo-console schedule --enable       # 按上次设置重新启用
```

首次启用需要先选择当前订阅。只修改频率不会启用已停用的自动更新。
`1d` 表示间隔 24 小时；这是间隔设置，不是每天某个固定时刻。

原生安装会保存管理设置并写入
`/etc/systemd/system/mihomo-subscription-update.timer.d/zz-mihomo-console.conf`，
重载 systemd；原定时器运行中时会重启定时器使新间隔生效。首次执行由定时器
启用时间及上次更新完成时间决定；后续在每次更新结束后等待所选间隔，
不附加旧版的 5 分钟随机延迟。
文件写入或服务操作失败时会恢复原设置和定时器状态。

Console 升级保留此 drop-in。未设置过间隔的旧安装沿用原默认：启动 10 分钟
后首次执行，之后约每小时更新一次，随机延迟最多 5 分钟。曾手动设置 systemd
日历规则的用户，可继续通过 `systemctl edit` 管理；使用 Console 设置间隔会
清除在它之前加载的 timer 触发规则。不要同时在后加载的自定义 drop-in 中追加
其他触发规则；Console 显示的间隔来自所保存的设置。

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
.venv/bin/python -m unittest discover -v
python3 -m py_compile mihomo_console.py container_runtime.py test_*.py
bash -n setup.sh
```

可用实际 Mihomo 内核运行隔离集成测试。测试仅使用临时目录、随机本机端口和
测试节点，不读取系统订阅，不修改现有服务：

```bash
MIHOMO_TEST_BINARY=/usr/local/bin/mihomo .venv/bin/python -m unittest test_integration -v
```

覆盖真实控制器节点选择、模式跨重启持久化、systemd 单元校验及 curses 终端
交互；未设置 `MIHOMO_TEST_BINARY` 时跳过这组测试。CI 在下载官方内核后执行。
