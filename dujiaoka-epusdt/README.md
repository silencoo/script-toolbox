# Dujiaoka + EPUSDT Deployment

一键部署 [独角数卡 (Dujiaoka)](https://github.com/assimon/dujiaoka) 与 [EPUSDT](https://github.com/assimon/epusdt) 的自动化脚本。适用于 Ubuntu / Debian VPS，配合 Nginx 反向代理与 Cloudflare（或其他 CDN）使用。

## 功能

- 单份 `docker-compose.yml` 部署商店、EPUSDT、MariaDB、Redis
- 自动生成管理员密码、MySQL 密码、API Token、后台随机路径
- Nginx 站点配置（主站 + `usdt.` 子域）
- 凭据写入 `credentials.txt`（权限 600），避免散落在终端历史里

## 环境要求

| 项目 | 说明 |
|------|------|
| 系统 | Ubuntu 20.04+ / Debian 11+ |
| 权限 | 可 `sudo` 的普通用户 |
| 域名 | 主域名 + `usdt.` 子域名解析到服务器 IP |
| 端口 | 80 对外开放（HTTPS 建议由 Cloudflare 代理） |

## 快速开始

### 1. 进入工具目录

```bash
cd dujiaoka-epusdt
```

### 2. 配置 DNS

在域名服务商（如 Cloudflare）添加记录：

| 类型 | 名称 | 内容 |
|------|------|------|
| A | `@` | 服务器 IP |
| A | `www` | 服务器 IP |
| A | `usdt` | 服务器 IP |

### 3. 执行安装

```bash
chmod +x install.sh
./install.sh example.com YOUR_BOT_TOKEN YOUR_TELEGRAM_USER_ID
```

参数说明：

| 参数 | 说明 |
|------|------|
| `domain` | 主域名，不含 `https://` |
| `telegram_bot_token` | Telegram Bot Token（EPUSDT 通知用） |
| `telegram_admin_id` | Telegram 管理员用户 ID |

示例：

```bash
./install.sh example.com YOUR_BOT_TOKEN YOUR_TELEGRAM_USER_ID
```

### 4. 查看凭据

安装完成后查看：

```bash
cat credentials.txt
```

其中包含后台地址、管理员账号密码、MySQL 密码等。**请妥善保存后删除或移出服务器。**

## 目录结构

```
dujiaoka-epusdt/
├── install.sh              # 主安装脚本
├── docker-compose.yml      # Docker 服务定义
├── sql/
│   ├── dujiaoka-init.sql   # 独角数卡数据库初始化
│   └── epusdt-init.sql     # EPUSDT 数据库初始化
├── nginx/
│   └── dujiaoka.conf.template
├── scripts/
│   └── generate-admin-password.php
├── config/                 # 安装后生成（已 gitignore）
├── data/                   # 持久化数据（已 gitignore）
├── uploads/                # 商品图片等
├── storage/
├── .env                    # Docker 环境变量（已 gitignore）
└── credentials.txt         # 部署凭据（已 gitignore）
```

## 服务与端口

| 服务 | 容器内端口 | 宿主机绑定 |
|------|-----------|-----------|
| 独角数卡 | 80 | `127.0.0.1:18080` |
| EPUSDT | 8000 | `127.0.0.1:18081` |
| MariaDB | 3306 | 仅 Docker 内部 |
| Redis | 6379 | 仅 Docker 内部 |

可通过环境变量修改宿主机端口：

```bash
SHOP_PORT=8080 EPUSDT_PORT=8081 ./install.sh example.com TOKEN USER_ID
```

## 常用运维命令

在仓库目录下执行：

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f web
docker compose logs -f epusdt

# 重启所有服务
docker compose restart

# 停止
docker compose down

# 启动（已安装后）
docker compose up -d
```

## 重装说明

脚本默认幂等保护：存在 `.installed` 文件时不会重复安装。

若要**完全重装**（会清空数据库）：

```bash
docker compose down -v
rm -rf data/ runtime/ config/ .env credentials.txt .installed
./install.sh example.com TOKEN USER_ID
```

## 与旧版脚本的改进

| 项目 | 旧版 | 现版 |
|------|------|------|
| 脚本命名 | `run.sh` / `dujiao.sh` / 文本文件 | `install.sh` |
| 架构 | 两套独立 compose + 双份 DB/Redis | 单 compose，共享 DB/Redis |
| 端口 | 随机 20000–60000 | 固定 localhost 端口，仅 Nginx 对外 |
| 参数校验 | 声明 3 个参数实际用 5 个 | 统一 3 个必需参数 |
| SQL 初始化 | 内嵌 800 行 + 无效 `IF/LEAVE` | 独立 `sql/` 文件 |
| 容器操作 | 硬编码 `shop_web_1` | `docker compose exec -T web` |
| 错误处理 | 无 | `set -euo pipefail` |
| 安全 | `chmod 777`、固定 APP_KEY | 随机密钥、收紧目录权限 |
| Nginx | 修改主 `nginx.conf` | `sites-available` 站点文件 |
| TokenPay | 生成配置但未部署 | 已移除未完成逻辑 |

## 支付配置提示

安装后 EPUSDT 支付通道已在数据库中预置并启用（`Epusdt[trc20]`）。你还需要：

1. 登录后台 `系统设置` 配置站点信息
2. 在 EPUSDT 管理端配置 TRON 收款钱包地址
3. 确认 `usdt.` 子域可正常访问

## 故障排查

**Docker 权限错误**

```bash
sudo usermod -aG docker $USER
# 重新登录 SSH 后再试
```

**Nginx 配置测试失败**

```bash
sudo nginx -t
sudo journalctl -u nginx -n 50
```

**数据库未就绪**

```bash
docker compose logs db
docker compose ps
```

**后台 502**

```bash
docker compose logs web
curl -I http://127.0.0.1:18080
```

## 许可证

本仓库仅包含部署脚本与 SQL 初始化数据。独角数卡、EPUSDT 及其 Docker 镜像遵循各自上游项目的许可证。
