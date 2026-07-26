# Linux Server Toolkit

面向 Debian 10+ 与 Ubuntu 20.04+ 的 all-in-one 服务器初始化和运维工具。单一脚本提供交互式菜单、Profile 自动执行、执行计划、Dry Run、配置备份与有限回滚能力。

## 功能范围

- 基础初始化、APT 换源、常用工具和系统参数优化
- 用户、SSH、UFW、Fail2ban、安全更新和安全审计
- Docker Engine、Compose、应用管理、反向代理和容器安全
- Node.js、Python、PHP、Java、Go 和 .NET 运行时
- 磁盘、云盘、备份恢复、监控、诊断和服务器测试
- `minimal`、`docker-host`、`dev-box`、`secure-server` 内置 Profile
- DD 重装和痕迹清理等需要额外确认的高风险操作

## 使用方法

脚本会修改系统配置，建议先在可恢复的测试服务器上验证，并备份重要数据。

```bash
chmod +x server-toolkit.sh
sudo ./server-toolkit.sh
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

## Profile

可直接应用内置 Profile：

```bash
sudo env INIT_PROFILE=secure-server ./server-toolkit.sh
```

也可以加载脚本导出的 Profile 文件：

```bash
sudo env PROFILE_FILE=/root/init-profile-secure-server.env ./server-toolkit.sh
```

## 检查

```bash
bash -n server-toolkit.sh
```

脚本菜单中的“脚本与运维”还提供静态自检、ShellCheck、安全测试、外部资源信任清单和系统变更报告。
