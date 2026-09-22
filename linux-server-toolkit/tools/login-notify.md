# 登录通知（Bark）

通过工具箱主菜单 **2 安全与访问 → 9 登录通知（Bark）** 安装和管理。
目标平台为 Debian 12/13 + systemd；需要下载整个仓库。
后台服务独立运行，退出工具箱或移动仓库不影响已安装的服务。

## 安装与使用

```bash
sudo env TOOLKIT_LANG=zh ./server-toolkit.sh
```

选择“安装 / 更新”，填写机器别名、Bark 服务地址和设备 key。
地址只填写 HTTPS origin，例如 `https://api.day.app` 或自建服务的
`https://bark.example.com:8443`；不包含 key、路径、查询参数。
key 使用隐藏输入，不通过环境变量或命令行传递。
通知时区填写 `Asia/Tokyo` 等 IANA 名称，首次配置留空跟随服务器本地时区；
之后留空保留原值，输入 `-` 恢复使用系统时区。
所有通知时间包含 UTC 偏移，设置通知时区不会修改系统时区。

安装完成后：

1. 查看“服务 / 队列 / 日志缺口”。服务异常时也可查看
   `sudo journalctl -u login-notify.service -n 50 --no-pager`。
2. 发送测试通知，确认手机收到。菜单提示“入队”不等于已送达。
3. 重新 SSH 登录、从控制台完成一次正常 Linux 登录。
4. 运行兼容性检查，查看两类样本是否为 `observed`。
   `unverified` 只表示检查范围内没有识别到样本，不能据此声称该类型受到监控。

兼容性检查也可以在安装前运行，不需要 Bark 配置：

```bash
sudo /usr/bin/python3 -I tools/login-notify.py probe --zh
```

检查从最新记录向前读取，最多七天或 100,000 条系统 journal 记录，
先达到哪个限制就停止。输出扫描上限、cursor 定位检查、持久化情况和每类最新样本；
来源 IP 脱敏，不输出原始日志或公钥指纹。这个诊断不会初始化通知队列。

内置 Profile 不自动启用推送；自定义 Profile 可以显式加入 `login_notify`。
非交互安装/更新需要预先通过交互向导完成私有配置。Dry Run 不安装依赖、
不询问凭据、不建立连接、不写文件。

## 文件和权限

| 路径 | 用途 |
| --- | --- |
| `/usr/local/lib/login-notify/login-notify.py` | root 所有、普通用户只读的后台程序 |
| `/etc/login-notify/config.json` | root:login-notify，0640；配置目录 0750 |
| `/var/lib/login-notify/queue.sqlite3` | 专用账户所有；状态目录 0700，文件默认 0600 |
| `/etc/systemd/system/login-notify.service` | systemd 单元 |

依赖仅有 Python 3 标准库、系统 `libsystemd0` 和 CA 证书，不使用 pip。
服务账户 `login-notify` 不允许交互登录，并加入 `systemd-journal` 组。
该组可读取系统 journal；程序只保存解析后的必要登录信息，不保存完整日志。
服务通过 systemd 限制普通文件写入范围为自身状态目录，并禁用 core dump。

配置不进入工具箱的通用备份和报告流程。修改采用验证后原子替换；
格式错误时保留原配置。不要把真实配置复制进 Git、工单或聊天记录。
HTTP 使用验证证书的 HTTPS、JSON POST，拒绝重定向且不继承环境代理。
诊断只记录错误类别，不输出异常字符串、Bark 响应或 URL。

更新保留配置、队列、发送状态和 cursor。停用后再次启用会补读仍保留的日志；
卸载默认保留账户、配置和队列，重新安装可以继续处理。
若要彻底清除，先卸载服务，再人工删除上述配置和状态目录及专用账户；
删除队列会永久丢失待发送事件和处理位置。

## 检测规则

- 读取本机 systemd **系统 journal**，不会只订阅 SSH unit。
- 先检查 journal 的 `_UID`、`_EXE`、`_COMM` 等进程元数据，再匹配消息。
  单独伪造 `SYSLOG_IDENTIFIER=sshd` 或向日志写入 `Accepted` 不足以触发通知。
- SSH：只接受最终 `Accepted ...`，支持密码、公钥、keyboard-interactive 等
  方法名；兼容 `sshd`、`sshd-session`、`sshd-auth` 和 `ssh`/`sshd` 服务名。
  不要求 TTY，不把 `Partial ...` 多因素认证的中间结果视为成功。
- 本地：只接受 `login` 进程的 `pam_unix(login:session): session opened`。
  不匹配 SSH PAM、sudo、su、cron、图形终端窗口或 `ROOT LOGIN ON ...`。
- 终端优先来自字段，其次来自 getty/serial-getty 实例名；没有编号白名单。
  没有终端时仍通知，显示“未知”；不把来源 IP 当作控制台浏览器访问者 IP。
- 所有成功登录都通知，包括 root、自己的来源地址；SSH 连接复用不产生新认证
  时，不会因为同一连接里又开了一个通道而生成新的认证通知。
- 时间采用事件时间，不使用补发时间。缺少可选通知字段时显示“未知”。

当前首版仅接入 journal，不修改 `/etc/pam.d/login`、全局 PAM 栈或 SSH 配置。
若目标系统不记录本地事件，应先标记该能力未验证；PAM 备用接入需另行针对
发行版验证 `open_session` 钩子、短时本地入队、失败不阻断及恢复入口，
并与 journal 的本地事件来源互斥。不要自行同时叠加两个通知钩子。

## 队列、恢复和限制

消费者通过 `libsystemd` 的 journal API 实时读取，每批最多 128 条记录。
识别结果入队、丢弃告警（如触及容量）和最终 cursor 在同一个 SQLite 事务内提交，
使用 WAL 和 `synchronous=FULL`。HTTP 在独立线程、独立数据库连接中执行，
请求期间不占用消费事务，也不会进入登录认证路径。

首次启动捕获当前尾部 cursor，不发送已有历史；从捕获尾部到开始监听之间的新
记录仍会处理。若没有可读日志，启动失败，不把无权限误报为健康。
后续启动先定位保存的 cursor，再通过 `sd_journal_test_cursor()` 验证精确匹配。
仅 `seek_cursor()` 成功不足以证明恢复成功，因为 API 可返回临近位置。

cursor 不可恢复时，持久化 `journal_gap` 告警，然后从**最后提交记录的实时时间戳**
向后补读仍保留的日志，不退回首次安装逻辑，也不静默跳到最新日志。
丢失区间和数量无法精确推断；严重时钟回拨还可能使时间定位无法覆盖所有事件。
告警会一直留在状态页，不能将降级恢复视为“保证无漏报”。
正常恢复依赖仍保留的 journal；未持久化 journal 会产生单独告警，
可以通过工具箱现有“监控 / 告警基础 → 配置 journald 持久化”处理。
程序不会自动改写全局 journal 保留策略。

默认参数可以在私有 JSON 配置中调整，修改后重启服务：

| 参数 | 默认值 | 行为 |
| --- | --- | --- |
| `max_events` | 10,000 | 包括已发送和待发送记录；先清理已发送，再拒收超限的新事件 |
| `sent_retention_days` | 7 | 已发送记录保留时间 |
| `pending_retention_days` | 30 | 自入队起算，过期待发送记录清理并记录丢失 |
| `request_timeout` | 10 秒 | HTTP 网络操作超时 |
| `retry_initial` | 5 秒 | 指数退避起点，带随机抖动 |
| `retry_max` | 3,600 秒 | 最大重试间隔 |

容量拒收与待发送过期在数据库里留下持久化的原因、累计数量、首次/最近时间、
受影响时间范围。过期范围按入队时间计，容量拒收范围按事件时间计。
减小容量不会立即删除已有待发送记录；发送/清理到限制以内之前，新事件可能被拒收。
SQLite 使用有限事件容量并复用已释放页面，文件不保证每次清理后物理缩小。
磁盘满等导致事务失败时，不推进 cursor，服务退出并由 systemd 重启；
应及时恢复磁盘空间，避免等待期间 journal 也被轮转清除。

重试没有固定次数上限，但受待发送保留时间限制。只有 HTTP 200 且 Bark JSON
返回 `code: 200` 才标记为已发送；这表示服务端接受请求，不证明手机已经展示通知。
事件按 journal cursor 的摘要去重。去重只覆盖还保留的事件记录；
网络超时或服务端收到后本进程崩溃，都可能导致重发，**不承诺严格送达一次**。

## 验证范围

Debian 13 / OpenSSH 10.0p1 的 SSH 公钥、无 TTY 远程命令、SFTP、仅隧道
连接和 VNC 内的正常 `login` 成功事件已取得真实日志验证；原生 API 只读诊断
也已在目标机器运行。SFTP 仅执行 `pwd`，隧道仅建立短时本机环回转发。
Debian 12 的 `sshd` 形态、密码、keyboard-interactive、其他终端编号使用合成
样本做回归测试，尚不能算目标系统上的实际验收。上述检查未部署通知服务，
真实 Bark 推送、专用账户下的完整服务运行仍需在配置后完成端到端验收。

```bash
python3 tests/test_login_notify.py
bash -n server-toolkit.sh
systemd-analyze verify tools/login-notify.service
```

测试包括原子回滚、首次启动竞态、cursor 丢失、重启恢复、容量/保留期告警、
模拟断网补发、发送阻塞时继续入队，以及本机模拟 Bark 的错误响应、JSON 和
重定向行为。测试凭据全部虚构，本机 HTTP 服务只监听 loopback 随机端口。

上线验收还需检查密码/公钥/keyboard-interactive、无 TTY 远程命令、SFTP、
仅隧道、同次 SSH 的 PAM 去重、本地 TTY 和其他编号、sudo/cron/普通终端排除、
断网恢复、进程重启和登录不受通知故障影响。不要为了测试而降低生产 SSH 安全设置；
生产机未启用的认证方式可在独立 Debian 测试环境验证。

这是登录事件预警，不是完整入侵检测。打开服务商控制台查看画面、接管已有会话、
宿主机读盘或修改虚拟机，可能没有任何新登录事件。root 或宿主机控制者也能关闭
或绕过监控，不能将它描述为能够可靠检测服务商访问的工具。

实现参考：
[systemd cursor 定位语义](https://www.freedesktop.org/software/systemd/man/latest/sd_journal_seek_head.html)、
[cursor 精确验证](https://www.freedesktop.org/software/systemd/man/latest/sd_journal_get_cursor.html)、
[Bark JSON API](https://github.com/Finb/bark-server/blob/master/docs/API_V2.md)。
