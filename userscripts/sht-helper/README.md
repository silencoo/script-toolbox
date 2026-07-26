# SHT Helper

A Tampermonkey / Violentmonkey userscript purpose-built for the [Sehuatang](https://sehuatang.org/) forum. It consolidates the routine tasks of reading a thread — previewing attachments, unpacking archives, collecting ED2K and magnet links, hiding visual clutter, and pushing downloads to cloud storage — into a single toolbar.

[![Version](https://img.shields.io/badge/version-2.9.1-blue.svg)](https://github.com/silencoo/script-toolbox/tree/main/userscripts/sht-helper)
[![Userscript](https://img.shields.io/badge/userscript-ready-green.svg)](#installation)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](../../LICENSE)

---

## Features

### Attachment preview and archive extraction

- Inline preview for plain-text attachments (`txt`, `nfo`, `log`, `json`, `md`, `csv`, etc.)
- ZIP and RAR extraction in a Web Worker, with automatic charset detection (`jschardet`)
- Multi-password auto-attempt using a built-in candidate list, fully editable
- Top-of-post aggregation that lifts every attachment and extract button to the header of the thread

### ED2K and magnet aggregation

- Automatic collection of every `ed2k://` and `magnet:?xt=urn:btih:` link in the post body
- One-click copy of all links, individual copy, optional preservation of tracker and display-name parameters
- Direct push to 115 Cloud and 123 Cloud offline download (requires the user to supply their own session cookie)

### Image and clutter control

- One-click hide for placeholder images and oversized inline images
- Domain allow-list for exceptions
- Configurable hiding of common list-view columns (reply count, last reply, author)

### Search enhancements

- Multi-key sort (time, replies, views)
- Quota visualization
- Keyword filtering and per-module blocking

### Quality-of-life

- Author-only mode that jumps straight to the original poster’s posts
- Quick-rate button with configurable default score and reason
- Thread history that visually marks already-visited posts (greyed, struck-through, or tinted)
- Config import and export for migrating settings across browsers and devices

---

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) browser extension.
2. Use the [direct install link](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js), or create a new userscript and paste the entire contents of [`sht-helper.user.js`](./sht-helper.user.js).
3. Visit any `https://sehuatang.org/forum.php?mod=viewthread&tid=…` page. The toolbar appears automatically at the top right.

The required libraries — `@zip.js`, `jschardet`, and `libunrar-js` — are loaded from public CDNs at runtime; no local build step is required.

SHT Helper already includes search-result sorting. Do not enable it together with the repository's standalone `sehuatang-search-sorter` userscript, because both tools act on the same search result list.

---

## Optional: 115 Cloud and 123 Cloud offline push

Open the script’s settings panel to configure cloud push.

| Service | Required input |
| --- | --- |
| 115 Cloud | Full cookie (`USERSESSIONID`, `UID`, `CID`, `SEID`, …), optional custom User-Agent, default upload directory ID |
| 123 Cloud | `Authorization` token, `LoginUuid`, full cookie |

To obtain these values, log into the cloud web app, open the browser’s DevTools, switch to the Network tab, select any request, and copy the entire Cookie header. The 123 Pan `Authorization` token is the request header value; `LoginUuid` is found in the request body or in `localStorage`.

These credentials are stored only in the browser’s local `GM_setValue` storage. They are sent only to the corresponding cloud provider when you use a cloud action, never to a project-controlled backend. The shipped source contains no built-in account.

---

## Configuration storage

All customizations — password candidates, image allow-list, keyword filters, cloud cookies, and so on — are persisted via `GM_setValue('sht_cfg_v2', …)` in the browser. Use the Export JSON and Import buttons in the settings panel to migrate settings across browsers or devices.

---

## Privacy and security

- The script communicates only with Sehuatang, the configured cloud storage provider, and public CDNs. There is no project-controlled backend.
- Credentials supplied by the user are used solely to call that user’s own cloud account over the official APIs.
- The script ships as a single unminified file of approximately 8,000 lines, fully readable and auditable.
- Paste cloud cookies only on devices you control and trust.

---

## Development

```bash
git clone https://github.com/silencoo/script-toolbox.git
cd script-toolbox
# Edit userscripts/sht-helper/sht-helper.user.js directly. No build step.
```

The `// ==UserScript==` metadata block at the top of `sht-helper.user.js` is parsed by Tampermonkey. Bump `@version` for each release.

---

## Changelog

### 2.9.1

- Restored HTTP, mirror-domain, and external attachment request compatibility from the original userscript metadata
- Restored the original toolbar availability on home, list, search, and thread pages

### 2.9.0

- Replaced emoji controls and status markers with a consistent inline SVG icon set
- Fixed attachment keyword filtering and combined search-filter behavior
- Prevented duplicate search-panel initialization
- Improved modal keyboard focus behavior and respected reduced-motion preferences
- Rendered cloud task results as text-safe DOM content

### 2.8.0

- Search-page sort enhancements: multi-key sort, quota bar, filters
- Fixed dead toggles and intermittent UI jank
- Improved filename parsing for CJK characters, whitespace, and optional segments
- Magnet extraction now preserves `tr=` and `dn=` parameters
- Top-of-post aggregation for attachments and extract controls
- Cloud push for 115 and 123 (configurable in the settings panel)

---

## License

[MIT](../../LICENSE)

---
---

# 中文

色花堂论坛专属的 Tampermonkey / Violentmonkey 用户脚本。把日常浏览帖子时的零碎操作——预览附件、解压压缩包、收集 ED2K 与磁力链接、隐藏视觉干扰、推送到网盘——整合到同一个工具栏中。

---

## 功能

### 附件预览与压缩包解压

- 内联预览纯文本附件（`txt`、`nfo`、`log`、`json`、`md`、`csv` 等）
- 在 Web Worker 中解压 ZIP 与 RAR，自动检测编码（`jschardet`）
- 多密码自动尝试，内置候选列表且完全可编辑
- 顶部聚合：将所有附件入口与解压按钮提升至帖子顶部

### ED2K 与磁力链接聚合

- 自动收集正文中的 `ed2k://` 与 `magnet:?xt=urn:btih:` 链接
- 支持一键复制全部、单独复制、可选保留 tracker 与 `dn=` 参数
- 直接推送到 115 网盘与 123 云盘离线下载（需用户自行配置会话 Cookie）

### 图片与列表项控制

- 一键隐藏占位图与过大的内联图片
- 域名白名单用于放行
- 可配置隐藏常见列表列（回复数、最后回复、作者）

### 搜索增强

- 多键排序（时间、回复数、浏览数）
- 配额可视化
- 关键字过滤与模块屏蔽

### 杂项

- “只看楼主”模式，一键跳转到楼主全部发言
- 一键评分按钮，默认分数与理由可配置
- 帖子历史记录，可对已访问帖子做灰显 / 删除线 / 染色标记
- 配置导入与导出，便于跨浏览器与跨设备迁移

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 浏览器扩展。
2. 使用[直接安装链接](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js)，或新建用户脚本并粘贴 [`sht-helper.user.js`](./sht-helper.user.js) 的完整内容。
3. 访问任意 `https://sehuatang.org/forum.php?mod=viewthread&tid=…` 页面，工具栏将自动出现在右上角。

所需依赖库（`@zip.js`、`jschardet`、`libunrar-js`）在运行时从公共 CDN 加载，无需本地构建。

SHT Helper 已内置搜索结果排序功能。请勿与仓库中的独立 `sehuatang-search-sorter` 用户脚本同时启用，因为两者会操作同一个搜索结果列表。

---

## 可选：115 网盘与 123 云盘离线推送

打开脚本的设置面板以配置网盘推送。

| 服务 | 需提供 |
| --- | --- |
| 115 网盘 | 完整 Cookie（`USERSESSIONID`、`UID`、`CID`、`SEID` 等），可选自定义 User-Agent，默认上传目录 ID |
| 123 云盘 | `Authorization` Token、`LoginUuid`、完整 Cookie |

获取方式：登录对应网盘网页版 → 打开浏览器 DevTools → 切换到 Network 面板 → 选择任意请求 → 复制完整 Cookie 头。123 Pan 的 `Authorization` Token 即请求头中的对应字段；`LoginUuid` 在请求体或 `localStorage` 中。

上述凭据仅保存在浏览器本地的 `GM_setValue` 存储中；使用网盘操作时仅发送至对应网盘服务，不会发送至项目自有后端。脚本源码中不含任何内置账号。

---

## 配置存储

所有自定义项（密码候选、图片白名单、关键字过滤、网盘 Cookie 等）通过 `GM_setValue('sht_cfg_v2', …)` 持久化于浏览器本地。可使用设置面板中的 “导出 JSON” 与 “导入” 功能在多设备间同步。

---

## 隐私与安全

- 脚本仅与色花堂、所配置的网盘服务以及公共 CDN 通信，不存在项目自有后端。
- 用户填入的凭据仅用于通过官方接口访问该用户本人的网盘账号。
- 脚本以单一未压缩文件形式分发，约 8,000 行，完全可审计。
- 请仅在受信任且由本人控制的设备上粘贴网盘 Cookie。

---

## 开发

```bash
git clone https://github.com/silencoo/script-toolbox.git
cd script-toolbox
# 直接编辑 userscripts/sht-helper/sht-helper.user.js，无需构建步骤
```

`sht-helper.user.js` 顶部的 `// ==UserScript==` 元数据块由 Tampermonkey 解析，每次发布时修改 `@version`。

---

## 更新日志

### 2.9.1

- 恢复原脚本对 HTTP、镜像域名以及外部附件请求的兼容规则
- 恢复工具栏在首页、列表页、搜索页和帖子页的原有可见范围

### 2.9.0

- 将表情符号控件与状态标记替换为统一的内联 SVG 图标
- 修复附件关键词过滤以及搜索组合过滤行为
- 避免重复初始化搜索面板
- 改进对话框键盘焦点行为，并适配“减少动态效果”偏好
- 以安全的纯文本 DOM 节点渲染网盘任务结果

### 2.8.0

- 搜索页排序增强：多键排序、配额条、过滤器
- 修复部分开关失效与偶发卡顿
- 改进了对中日韩字符、空格与可选段的文件名解析
- 磁力链接提取保留 `tr=` 与 `dn=` 参数
- 附件与解压入口的顶部聚合
- 115 网盘与 123 云盘离线推送（设置面板中配置）

---

## 许可

[MIT](../../LICENSE)
