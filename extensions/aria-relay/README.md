# Aria Relay

一个隐私优先的 Chromium Manifest V3 aria2 下载管理扩展。点击工具栏图标会打开侧边栏，也可以在完整标签页中使用管理器。

## 功能

- 实时任务队列：下载中、等待/暂停、完成、错误/移除
- 速度、进度、剩余时间、文件大小、来源与 GID
- 暂停、继续、重试、移除、清除记录、全部暂停/继续
- 添加 HTTP(S)、FTP、SFTP、Magnet 链接；支持每行一个的批量任务
- 上传 `.torrent`、`.metalink`、`.meta4`（最大 48 MiB）
- 下载目录、输出文件名、Referer、自定义请求头和“先暂停”选项
- 任务详情与 BT 文件列表
- 网页链接、图片、视频、音频和当前页面的右键发送
- 浅色、深色和跟随系统主题；侧边栏与完整标签页响应式布局
- 中英文扩展名称/描述本地化

## 安全模型

Aria Relay 为避免常见下载扩展的过度权限，刻意采用以下边界：

| 能力 | 权限策略 |
| --- | --- |
| aria2 RPC | `optional_host_permissions` 只在保存设置时申请当前 RPC origin |
| 右键发送 | 必需的 `contextMenus`，Chrome 只传入用户点选的 URL |
| 设置 | 必需的 `storage`，并限制为 `TRUSTED_CONTEXTS` |
| 通知 | 可选 `notifications`，默认关闭 |
| 侧边栏 | 必需的 `sidePanel` |

扩展**没有**内容脚本，也没有 `cookies`、`history`、`tabs`、`downloads`、`webRequest` 或 `<all_urls>` 的安装期授权。它不会自动拦截 Chrome 下载，因为那需要“管理你的下载”权限；推荐使用右键菜单或新建任务。这是有意的安全取舍。

RPC 密钥默认放在 `chrome.storage.session`，浏览器重启、扩展更新或禁用时会清除。只有用户显式开启“在本机持久保存密钥”后，才写入 `chrome.storage.local`。Chrome 扩展存储不是系统钥匙串，持久模式不应被当作加密存储。

远程 aria2 建议使用 HTTPS、可信 VPN 或 SSH 隧道。不要把未限制访问的 aria2 RPC 直接暴露到公网。

## 构建

需要 Node.js 22.12 或更新版本。

```bash
cd extensions/aria-relay
npm install
npm run validate
```

构建产物位于 `dist/`。

## 安装到 Chrome

1. 运行 `npm run build`。
2. 打开 `chrome://extensions`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本目录下的 `dist/`。
5. 点击 Aria Relay 图标，或从扩展详情页打开“扩展程序选项”。
6. RPC 地址填写 `http://127.0.0.1:6800/jsonrpc`，输入 `rpc-secret`，点击“授权、测试并保存”。

你的 aria2 配置至少需要：

```ini
enable-rpc=true
rpc-listen-port=6800
rpc-secret=请使用强随机密钥
```

如果 aria2 和 Chrome 在同一台设备上，建议将 `rpc-listen-all=false`；只有确实需要局域网访问时再开启监听所有地址，并配合防火墙。

## 开发

```bash
npm run dev        # 带本地样例数据的 UI 预览
npm run typecheck
npm run test
npm run build
```

生产构建会移除开发预览数据。运行时代码没有第三方依赖；Vite、TypeScript 和 Vitest 只用于开发和构建。

## 目录

- `src/background.ts`：Manifest V3 service worker、消息路由、右键菜单
- `src/aria2-client.ts`：JSON-RPC 客户端与允许列表化的 aria2 参数
- `src/config.ts`：设置与会话/持久密钥存储
- `src/security.ts`：RPC origin、下载 URI 与自定义请求头验证
- `src/manager.ts`：侧边栏/完整页下载管理器
- `src/settings.ts`：权限申请、连接测试、安全设置
- `public/manifest.json`：最小权限清单

本项目使用仓库根目录的 MIT License。
