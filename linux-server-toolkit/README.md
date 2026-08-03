# Linux Server Toolkit

面向 Debian 10+ 与 Ubuntu 20.04+ 的 all-in-one 服务器初始化和运维工具。单一脚本提供交互式菜单、Profile 自动执行、执行计划、Dry Run、配置备份与有限回滚能力。

## 功能范围

- 基础初始化、APT 换源、常用工具，以及按需启用的 Swap/sysctl 优化
- 用户、SSH、UFW、Fail2ban、安全更新和安全审计
- Docker Engine、Compose、应用管理、反向代理和容器安全
- Node.js、Python、PHP、Java、Go 和 .NET 运行时
- 磁盘、云盘、备份恢复、监控、诊断和服务器测试
- `minimal`、`docker-host`、`dev-box`、`secure-server` 内置 Profile
- 仅位于“高级 / 高风险”菜单、且需要输入确认的 DD 重装和痕迹清理

## 使用方法

脚本会修改系统配置，建议先在可恢复的测试服务器上验证，并备份重要数据。

```bash
chmod +x server-toolkit.sh
sudo ./server-toolkit.sh
```

## 怎么选

| 你的用途 | 建议入口 | 说明 |
| --- | --- | --- |
| 第一次初始化普通 VPS | `minimal` | 基础工具、SSH、UFW、Fail2ban 和自动安全更新 |
| 部署 Docker 应用 | `docker-host` | 在服务器基线上增加 Docker、反向代理、备份、监控和容器安全 |
| 把 VPS 当远程开发机 | `dev-box` | 在服务器安全基线上增加语言运行时、终端和网络工具 |
| 强化公网服务器 | `secure-server` | 增加安全审计、SSH 审计、端口检查和维护窗口 |
| 还不确定需要什么 | 直接运行脚本 | 从“快速开始”查看计划，再按用途选择 |

四个内置 Profile 共用基础安全模块：基础工具、SSH、UFW、Fail2ban 和自动安全更新；各 Profile 只在这套基线上增加用途相关模块。

例如，先查看计划，再执行相同 Profile：

```bash
PLAN_ONLY=1 INIT_PROFILE=minimal ./server-toolkit.sh
sudo env INIT_PROFILE=minimal ./server-toolkit.sh
```

## 安全预览

以 Dry Run 查看默认流程，不执行系统变更：

```bash
sudo env NON_INTERACTIVE=1 DRY_RUN=1 ./server-toolkit.sh
```

仅查看内置 Profile 的执行计划：

```bash
PLAN_ONLY=1 INIT_PROFILE=docker-host ./server-toolkit.sh
```

## 时区、Swap 与 sysctl

默认不会修改服务器现有时区。需要统一时区时，传入有效的 IANA 时区名：

```bash
sudo env SYSTEM_TIMEZONE=Etc/UTC INIT_PROFILE=minimal ./server-toolkit.sh
```

PHP 配置和新生成的 CloudDrive2 Compose 配置会使用同一个时区；未设置
`SYSTEM_TIMEZONE` 时使用服务器当前时区。

标准快速初始化和四个内置 Profile 都不会自动创建 Swap，也不会应用宽泛的
sysctl 调优。需要时，在“系统与维护”或“自定义初始化”中明确选择相应模块。
“系统与维护”中的保守、标准和激进三档 sysctl 性能预设都会配置 `fq + BBR`；
实际应用前会检查当前内核是否提供 `tcp_bbr`，应用后会验证两项配置均已生效。
非交互执行显式选择的 Swap 模块时，可用 `SWAP_SIZE_MB=2048` 指定大小；未指定
则使用脚本根据内存计算的建议值。

## 出口 IP 与双栈诊断

“诊断与测试”中的“出口 IP / 双栈诊断”会分别显示 IPv4 和 IPv6 的本地全局地址、
默认路由、实际选路、公网出口地址与状态，并检查 DNS A/AAAA 记录和当前解析器。
当 DNS 返回 AAAA、但机器的 IPv6 默认路由或公网出口损坏时，诊断会给出明确警告。
该功能只读，不会自动删除路由、禁用 IPv6 或修改 DNS。

无需进入菜单，也不要求 root：

```bash
./server-toolkit.sh --network
```

默认使用 `www.cloudflare.com` 检查双栈 DNS；可以替换为实际出问题的域名：

```bash
NETWORK_DIAGNOSTIC_HOST=example.com ./server-toolkit.sh --network
```

## 一键完整机器概览

“诊断与测试”中的“一键完整机器概览”把原本分散的信息集中到一次只读输出中：

- 操作系统、Kernel、架构、虚拟化、运行时间、本地时间、UTC 和 NTP 状态；
- CPU 型号/核心/负载、RAM、Swap、根文件系统和块设备；
- SSH 有效端口、公钥/密码认证状态、root 登录策略和 UFW 状态；
- IPv4/IPv6 本地地址、默认路由、公网出口、DNS A/AAAA；
- 当前拥塞控制、可用算法、qdisc、TCP Fast Open、MTU probing 和脚本优化配置；
- SSH、Fail2ban、Docker、自动更新、Nginx、Caddy 等服务状态；
- Node.js、Python、PHP、Java、Go、.NET、Rust 和 Docker 等当前 PATH 中的版本。

无需进入菜单，也不要求 root；部分 SSH 或服务详情在普通用户权限不足时显示 `N/A`：

```bash
./server-toolkit.sh --overview
```

概览不会显示 `authorized_keys` 内容、密码或其他凭据，也不会修改系统配置。

## 非交互执行

外部下载、远程脚本和危险操作分别使用独立开关。只有明确了解相应风险时才启用：

```bash
sudo env \
  NON_INTERACTIVE=1 \
  ALLOW_EXTERNAL=1 \
  ALLOW_REMOTE_EXEC=1 \
  ALLOW_DANGEROUS=1 \
  ./server-toolkit.sh
```

SSH 模块在交互模式下可选择将公钥配置给 `root`、已有普通用户，或跳过
`authorized_keys`。非交互模式默认保持使用 `root`；可通过
`SSH_KEY_TARGET=root|none|用户名` 显式指定。若目标账户尚无公钥，可同时通过
`SSH_PUBLIC_KEY` 提供要追加的公钥：

```bash
sudo env \
  NON_INTERACTIVE=1 \
  SSH_KEY_TARGET=deploy \
  SSH_PUBLIC_KEY="ssh-ed25519 AAAA... admin@example" \
  INIT_PROFILE=minimal \
  ./server-toolkit.sh
```

选择普通用户时，该账户必须已存在、具有可登录 Shell 和有效主目录。脚本只有在
确认其公钥与 sudo 管理权限后，才会提供禁用 root 登录或所有 SSH 密码认证的选项。

远程脚本默认要求可信 SHA256。可通过 `REMOTE_SCRIPT_SHA256` 提供单次摘要，或使用仅 root 可写的校验文件：

```text
/root/init-remote-scripts.sha256
```

每行格式为：

```text
SHA256 URL
```

不建议使用 `ALLOW_UNVERIFIED_REMOTE=1` 绕过摘要校验。

DD 重装和痕迹清理不能加入内置或自定义 Profile。它们只保留在
“高级 / 高风险”菜单中，并继续要求输入原有的文字确认。

## Profile

可直接应用内置 Profile：

```bash
sudo env INIT_PROFILE=secure-server ./server-toolkit.sh
```

也可以加载脚本导出的 Profile 文件：

```bash
sudo env PROFILE_FILE=/root/init-profile-secure-server.env ./server-toolkit.sh
```

## 配套工具与配方

仓库还保留少量不进入交互菜单的独立工具：Cloudflare IPv4 DDNS、vnStat
月流量阈值检查，以及临时 User-Agent 请求捕获服务。它们位于
[`tools/`](./tools/README.md)，拥有独立参数和安全边界。

QNAP、Nginx PWA 反向代理和 CloudDrive MITM 调试资料位于
[`recipes/`](./recipes/README.md)。这些文件只是需要人工审查和改写的参考配置，
不会由主脚本自动执行。

## 检查

```bash
bash -n server-toolkit.sh
for script in tools/*.sh; do bash -n "$script"; done
./tests/test_init_safety.sh
./tests/cloudflare-ddns-test.sh
./tests/vnstat-traffic-firewall-test.sh
```

脚本菜单中的“脚本与运维”还提供静态自检、ShellCheck、安全测试、外部资源信任清单和系统变更报告。
