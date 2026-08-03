# QNAP QPKG deployment for Moriy Agent

这是一份需要按设备修改的部署记录，不是可直接运行的安装脚本。执行前应备份
`/etc/config/qpkg.conf`，确认 NAS 架构、实际存储池路径和 Agent 构建来源。

核心思路是：不用 systemd，也不用 Docker，而是接入 QNAP 自带的 QPKG 启动体系和 `daemon_mgr` 进程守护。

```text
QTS 开机
  ↓
qpkgd 读取 /etc/config/qpkg.conf
  ↓
调用 MoriyAgent.sh start
  ↓
daemon_mgr 启动并监控 moriy-agent
  ↓
读取 config.json
  ↓
通过 HTTPS/WSS 连接 Moriy 面板
```

### 1. 构建原生 QNAP 二进制

目标 QNAP 若为 x86_64，可使用 Go 构建静态 Linux amd64 程序；ARM 设备需要改用
与设备匹配的 `GOARCH`：

```bash
MORIY_AGENT_TARGETS=linux/amd64 \
MORIY_AGENT_VERSION='<version>-qnap' \
./build_moriy.sh
```

产物：

```text
dist/moriy-agent-linux-amd64
```

它是静态 ELF，不依赖 QNAP 自带的 libc 或额外运行库。

### 2. 安装到持久化存储池

没有放到 QNAP 的 /、/usr 等固件分区，因为升级固件后可能被覆盖，而是放在：

```text
/share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/
├── moriy-agent
├── MoriyAgent.sh
├── config.json
└── moriy-agent.log
```

STORAGE_POOL_DATA 还有足够空间，而且会在 QPKG 启动前挂载。

### 3. 令牌不放在命令行

Agent 只通过下面的参数启动：

```bash
moriy-agent --config /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/config.json
```

配置结构类似：

```json
{
  "endpoint": "https://monitor.example.com",
  "token": "<TOKEN>",
  "interval": 3,
  "disable_auto_update": true,
  "disable_web_ssh": true,
  "ignore_unsafe_cert": false,
  "prefer_ip_version": "4",
  "include_nics": "eth0",
  "include_mountpoints": "/share/STORAGE_POOL1_DATA;/share/STORAGE_POOL2_DATA;/share/STORAGE_POOL3_DATA;/share/STORAGE_POOL_DATA"
}
```

配置权限设为：

```bash
chmod 600 config.json
```

这样 ps 只能看到配置文件路径，看不到 Token。

只统计 eth0 是因为 QNAP 上存在大量 Docker Bridge 和 veth，否则流量可能重复计算。磁盘也只统计四个真实存储池，避免把容器 overlay 和 QTS 临时分区算进去。

### 4. 注册为 QPKG

通过 QNAP 自带的 setcfg 向 /etc/config/qpkg.conf 注册：

```bash
setcfg MoriyAgent Name MoriyAgent -f /etc/config/qpkg.conf
setcfg MoriyAgent Status complete -f /etc/config/qpkg.conf
setcfg MoriyAgent Enable TRUE -f /etc/config/qpkg.conf
setcfg MoriyAgent RC_Number 150 -f /etc/config/qpkg.conf
setcfg MoriyAgent Shell \
  /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/MoriyAgent.sh \
  -f /etc/config/qpkg.conf
setcfg MoriyAgent Install_Path \
  /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent \
  -f /etc/config/qpkg.conf
```

同时创建方便手动管理的链接：

```bash
ln -s \
  /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/MoriyAgent.sh \
  /etc/init.d/MoriyAgent.sh
```

QTS 开机时，qpkgd 会读取 Enable = TRUE 的应用，然后调用 Shell 指定的脚本。

### 5. 使用 daemon_mgr 守护

启动脚本的核心是：

```bash
/sbin/daemon_mgr moriy-agent start \
  "QNAP_QPKG=MoriyAgent \
  /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/moriy-agent \
  --config /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/config.json \
  >> /share/STORAGE_POOL_DATA/.qpkg/MoriyAgent/moriy-agent.log 2>&1 &"
```

末尾的 & 很重要。Agent 是前台程序，如果没有它，QPKG 启动脚本会一直阻塞。

停止时先从 daemon_mgr 注销，再向 Agent 发送 TERM，超时才发送 KILL。因此正常停止时 Agent 可以关闭 WebSocket 并清理状态。

管理命令：

```bash
/etc/init.d/MoriyAgent.sh status
/etc/init.d/MoriyAgent.sh stop
/etc/init.d/MoriyAgent.sh start
/etc/init.d/MoriyAgent.sh restart
```

### 6. 做过的验证

- 手动停止、启动均正常。
- 主动终止 Agent 进程后，daemon_mgr 自动生成新 PID 并拉起。
- Agent 重新上传基本信息并连接 v2 WebSocket。
- 面板 RPC 返回 qnap online=true。
- 配置文件权限确认为 600。
- 注册前的 QPKG 配置备份在：

```text
/etc/config/qpkg.conf.moriy-before-<timestamp>
```
