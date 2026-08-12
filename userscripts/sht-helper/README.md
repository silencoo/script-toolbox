# SHT Helper

A Tampermonkey / Violentmonkey userscript purpose-built for the [Sehuatang](https://sehuatang.org/) forum. It consolidates the routine tasks of reading a thread — previewing attachments, unpacking archives, collecting ED2K and magnet links, hiding visual clutter, and pushing downloads to cloud storage — into a single toolbar.

[![Version](https://img.shields.io/badge/version-3.2.0-blue.svg)](https://github.com/silencoo/script-toolbox/tree/main/userscripts/sht-helper)
[![Userscript](https://img.shields.io/badge/userscript-ready-green.svg)](#installation)
[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg)](../../LICENSE)

---

## Features

### Attachment preview and archive extraction

- Inline preview for plain-text attachments (`txt`, `nfo`, `log`, `json`, `md`, `csv`, etc.)
- ZIP and RAR extraction in a Web Worker, with automatic charset detection (`jschardet`)
- Download progress and cancellation for attachment previews and torrent sends
- Multi-password auto-attempt using a built-in candidate list, fully editable
- Top-of-post aggregation that lifts every attachment and extract button to the header of the thread

### ED2K and magnet aggregation

- Automatic collection of every `ed2k://` and `magnet:?xt=urn:btih:` link in the post body
- One-click copy of all links, individual copy, optional preservation of tracker and display-name parameters
- Direct push to 115 Cloud and 123 Cloud offline download (requires the user to supply their own session cookie)
- Bounded cloud-task concurrency, cancellation, consistent retry/error handling, and connection tests

### Image and clutter control

- One-click hide for placeholder images and oversized inline images
- Domain allow-list for exceptions
- Configurable hiding of common list-view columns (reply count, last reply, author)

### Search enhancements

- Remembered primary/secondary sorting by time, replies, views, file size, or quota
- Quota badges and filters for quota-bearing and request-area threads
- Configurable hot-thread highlighting with automatic, low, medium, and high thresholds
- Keyword filtering and per-module blocking

### Quality-of-life

- A grouped, collapsible thread toolbar that keeps common actions visible and moves occasional actions out of the way
- Remembered group state, live item/task counts, and an optional compact toolbar mode
- Author-only mode that jumps straight to the original poster’s posts
- Quick-rate button with configurable default score and reason
- Thread history that visually marks already-visited posts (greyed, struck-through, or tinted)
- Config import and export for migrating settings across browsers and devices, with credentials redacted by default
- Optional current-page-memory-only credentials and an exportable, redacted diagnostic report

---

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) browser extension.
2. Use the [direct install link](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js), or create a new userscript and paste the entire contents of [`sht-helper.user.js`](./sht-helper.user.js).
3. Visit a thread page to use the main toolbar, or a forum search page to use the search sorting panel. The script matches the official domain and its subdomains.

Optional archive and charset libraries are loaded only when the corresponding preview action is used. ZIP 2.7.53 is vendored in this repository; RAR is loaded from the commit-pinned [`silencoo/libunrar-js`](https://github.com/silencoo/libunrar-js) fork; `jschardet` remains version-pinned on jsDelivr. Every downloaded executable/archive runtime is verified against a built-in SHA-256 digest before use. Installing the generated userscript requires no local build step.

SHT Helper supersedes the former standalone `sehuatang-search-sorter` userscript. Uninstall or disable an existing copy of that legacy script before enabling SHT Helper. Its saved search preferences are imported automatically once when possible.

---

## Optional: 115 Cloud and 123 Cloud offline push

Open the script’s settings panel to configure cloud push.

| Service | Required input |
| --- | --- |
| 115 Cloud | Full cookie (`USERSESSIONID`, `UID`, `CID`, `SEID`, …), optional custom User-Agent, default upload directory ID |
| 123 Cloud | `Authorization` token, `LoginUuid`, full cookie |

To obtain these values, log into the cloud web app, open the browser’s DevTools, switch to the Network tab, select any request, and copy the entire Cookie header. The 123 Pan `Authorization` token is the request header value; `LoginUuid` is found in the request body or in `localStorage`.

By default these credentials are stored only in the browser’s local `GM_setValue` storage. They are sent only to the corresponding cloud provider when you use a cloud action, never to a project-controlled backend. The shipped source contains no built-in account.

Credential fields are masked by default and include connection-test and clear actions. Enable **credentials only in current-page memory** to keep the values out of persistent userscript and same-origin web storage; they are then cleared on reload or navigation.

---

## Configuration storage

Main customizations — password candidates, image allow-list, keyword filters, cloud cookies, and so on — are persisted via `GM_setValue('sht_cfg_v2', …)` in the browser using a versioned schema and migrations. Search-panel state is stored separately under `sht_sorter_config`. Export covers both stores but omits cloud credentials by default; enable **Include credentials** only when creating a trusted backup. Import accepts only known fields with the expected data types, previews the changes, and preserves local credentials when the imported file omits them.

---

## Privacy and security

- Userscript matches and cross-origin connections are restricted to the official Sehuatang domain/subdomains, the supported cloud providers, GitHub-hosted resources, and the pinned jsDelivr charset dependency. There is no wildcard `@connect` or project-controlled backend.
- Credentials supplied by the user are used solely to call that user’s own cloud account over the official APIs.
- Configuration exports omit credentials unless the user explicitly opts in.
- The script ships as a single unminified, generated file and remains fully readable and auditable.
- Network diagnostics strip authorization, cookies, tokens, UUIDs, and magnet URLs before a report can be exported.
- Paste cloud cookies only on devices you control and trust.

For a different-host community mirror, review that site first and add a precise local `@match` rule (and only the specific `@connect` hosts it needs). Broad wildcard mirror permissions are intentionally not shipped.

---

## Development

```bash
git clone https://github.com/silencoo/script-toolbox.git
cd script-toolbox/userscripts/sht-helper
npm ci
npm run build
npm run check
```

Edit the ordered fragments in `src/`, not the generated `sht-helper.user.js`. `npm run build` assembles the metadata and modules into the single distributable userscript. `npm run check` verifies bundle freshness and syntax, then runs the Node test suite. Keep the metadata `@version` and runtime `SCRIPT_VERSION` synchronized.

---

## Changelog

### 3.2.0

- Vendored ZIP in `script-toolbox`, switched RAR to the commit-pinned `silencoo/libunrar-js` fork, and added SHA-256 runtime verification
- Added one cancellable `GM_xmlhttpRequest` layer with timeouts, safe GET retries, progress callbacks, typed errors, and redacted diagnostics
- Added per-post incremental ED2K/magnet indexing instead of rescanning unchanged posts
- Added a bounded cloud-provider task queue and common 115/123Pan provider adapters
- Replaced blocking browser alerts, prompts, and confirmations with accessible dialogs and non-blocking toasts
- Remembered toolbar group state, added live counts, and added compact mode
- Added attachment/torrent download progress and cancellation with clearer error categories
- Masked credential fields and added connection tests, clear actions, and current-page-memory-only storage
- Added configuration schema migrations and an import change preview
- Split toolbar/settings and 123Pan client/folder/task code into smaller source modules
- Added redacted diagnostic export plus real DOM fixture, request, task-queue, integrity, and UI tests

### 3.1.0

- Scoped page lifecycle work: the thread toolbar and `MutationObserver` now run only on thread pages
- Replaced repeated full-document attachment/link scans with a single candidate scan and combined ED2K/magnet collection
- Grouped the toolbar into collapsible common, attachment/link, cloud, and additional-action sections
- Fixed configuration portability: exports include search state, redact credentials by default, and imports validate known fields
- Replaced wildcard site/network permissions with explicit official-domain and service-host rules
- Lazy-loaded pinned ZIP and charset dependencies only when enhanced previews need them
- Made quick-rating requests use the current forum origin for official subdomain compatibility
- Split the monolithic source into ordered modules while retaining one generated userscript for distribution
- Added bundle, routing, permission, configuration, scanning, and search tests plus CI validation

### 3.0.1

- Limited the attachment aggregation toolbar to thread-detail pages
- Removed floating scroll controls from the forum home page
- Made page detection independent of URL query-parameter order

### 3.0.0

- Consolidated the former standalone search sorter into SHT Helper and retired the duplicate script
- Added remembered hot-thread highlighting with automatic and configurable thresholds
- Added one-time migration for legacy standalone sorter preferences
- Improved search-panel accessibility and narrow-screen layout
- Hid zero-value quota badges and fixed restoring the original order after clearing a secondary-only sort

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
- 附件预览与种子发送支持下载进度和取消
- 多密码自动尝试，内置候选列表且完全可编辑
- 顶部聚合：将所有附件入口与解压按钮提升至帖子顶部

### ED2K 与磁力链接聚合

- 自动收集正文中的 `ed2k://` 与 `magnet:?xt=urn:btih:` 链接
- 支持一键复制全部、单独复制、可选保留 tracker 与 `dn=` 参数
- 直接推送到 115 网盘与 123 云盘离线下载（需用户自行配置会话 Cookie）
- 网盘任务支持并发限制、取消、统一错误处理与连接测试

### 图片与列表项控制

- 一键隐藏占位图与过大的内联图片
- 域名白名单用于放行
- 可配置隐藏常见列表列（回复数、最后回复、作者）

### 搜索增强

- 按时间、回复数、浏览数、文件大小或配额进行可记忆的主/次排序
- 配额徽标，以及“仅含配额”和“过滤求片区”筛选
- 热门帖子高亮，支持自动、低、中、高四档门槛
- 关键字过滤与模块屏蔽

### 杂项

- 分组且可折叠的帖子工具栏：常用操作保持可见，低频操作按类别收纳
- 记忆分组展开状态、显示实时数量，并提供可选极简模式
- “只看楼主”模式，一键跳转到楼主全部发言
- 一键评分按钮，默认分数与理由可配置
- 帖子历史记录，可对已访问帖子做灰显 / 删除线 / 染色标记
- 配置导入与导出，便于跨浏览器与跨设备迁移；默认不导出敏感凭据
- 可选仅在当前页面内存中保存凭据，并可导出脱敏诊断报告

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/) 浏览器扩展。
2. 使用[直接安装链接](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/sht-helper/sht-helper.user.js)，或新建用户脚本并粘贴 [`sht-helper.user.js`](./sht-helper.user.js) 的完整内容。
3. 访问帖子页使用主工具栏，或访问论坛搜索页使用搜索排序面板。脚本默认匹配官方域名及其子域名。

压缩包与字符集识别等可选依赖只在用户触发相应预览操作时加载。ZIP 2.7.53 已 vendoring 到本仓库；RAR 来自锁定具体提交的 [`silencoo/libunrar-js`](https://github.com/silencoo/libunrar-js) fork；`jschardet` 继续使用锁定版本的 jsDelivr。所有下载后执行的脚本与 RAR 内存文件都必须先通过内置 SHA-256 校验。安装已生成的用户脚本无需本地构建。

SHT Helper 已取代原独立 `sehuatang-search-sorter` 用户脚本。启用 SHT Helper 前，请卸载或禁用已安装的旧脚本；旧脚本保存的搜索偏好会在可用时自动迁移一次。

---

## 可选：115 网盘与 123 云盘离线推送

打开脚本的设置面板以配置网盘推送。

| 服务 | 需提供 |
| --- | --- |
| 115 网盘 | 完整 Cookie（`USERSESSIONID`、`UID`、`CID`、`SEID` 等），可选自定义 User-Agent，默认上传目录 ID |
| 123 云盘 | `Authorization` Token、`LoginUuid`、完整 Cookie |

获取方式：登录对应网盘网页版 → 打开浏览器 DevTools → 切换到 Network 面板 → 选择任意请求 → 复制完整 Cookie 头。123 Pan 的 `Authorization` Token 即请求头中的对应字段；`LoginUuid` 在请求体或 `localStorage` 中。

上述凭据默认仅保存在浏览器本地的 `GM_setValue` 存储中；使用网盘操作时仅发送至对应网盘服务，不会发送至项目自有后端。脚本源码中不含任何内置账号。

凭据输入框默认遮罩显示，并提供连接测试与清除按钮。启用“凭据仅保留在当前页面内存”后，凭据不会写入持久化用户脚本存储或同源 Web Storage，刷新或离开页面后即清除。

---

## 配置存储

主要自定义项（密码候选、图片白名单、关键字过滤、网盘 Cookie 等）通过带版本迁移的配置结构持久化在 `GM_setValue('sht_cfg_v2', …)`；搜索面板状态另存于 `sht_sorter_config`。导出文件会同时包含两类配置，但默认排除网盘凭据；仅在制作可信备份时勾选“包含敏感凭据”。导入时只接受已知且类型正确的字段，先显示变更预览；导入文件未包含凭据时会保留本机已有凭据。

---

## 隐私与安全

- 用户脚本匹配范围与跨域权限限制为色花堂官方域名/子域名、所支持的网盘服务、GitHub 资源及锁定版本的 jsDelivr 依赖；不再使用通配 `@connect`，也不存在项目自有后端。
- 用户填入的凭据仅用于通过官方接口访问该用户本人的网盘账号。
- 配置导出默认省略凭据，只有用户主动勾选时才会包含。
- 脚本仍以单一、未压缩的生成文件分发，完全可读且可审计。
- 导出的诊断报告会自动移除 Authorization、Cookie、Token、UUID 与磁力链接。
- 请仅在受信任且由本人控制的设备上粘贴网盘 Cookie。

若使用不同域名的社区镜像，请先确认其可信度，再自行添加精确的本地 `@match`，并仅为实际需要的主机添加 `@connect`。项目不再默认提供宽泛的镜像通配权限。

---

## 开发

```bash
git clone https://github.com/silencoo/script-toolbox.git
cd script-toolbox/userscripts/sht-helper
npm ci
npm run build
npm run check
```

请编辑 `src/` 中按顺序组织的源码片段，不要直接修改生成的 `sht-helper.user.js`。`npm run build` 会将元数据与模块组装为单一可分发脚本；`npm run check` 会检查产物是否最新、JavaScript 语法，并运行 Node 测试。发布时应同步更新元数据 `@version` 与运行时 `SCRIPT_VERSION`。

---

## 更新日志

### 3.2.0

- 将 ZIP vendoring 到 `script-toolbox`，RAR 切换至锁定提交的 `silencoo/libunrar-js` fork，并增加 SHA-256 运行时校验
- 增加统一、可取消的 `GM_xmlhttpRequest` 层，包含超时、安全 GET 重试、进度回调、分类错误和脱敏诊断
- 按楼层建立 ED2K/磁力链接增量索引，不再重复扫描未变化的楼层
- 增加有限并发的网盘任务队列，以及统一的 115/123Pan 提供方适配层
- 以可访问对话框与非阻塞 Toast 替换原生阻塞弹窗
- 记忆工具栏分组状态，增加实时数量与极简模式
- 附件和种子下载增加进度、取消与更明确的错误分类
- 凭据输入默认遮罩，增加连接测试、清除操作与仅当前页面内存保存模式
- 增加配置结构版本迁移与导入变更预览
- 继续拆分工具栏、设置、123Pan 客户端、文件夹和任务模块
- 增加脱敏诊断导出，以及真实 DOM fixture、网络、队列、完整性和 UI 测试

### 3.1.0

- 按页面限制生命周期：帖子工具栏与 `MutationObserver` 仅在帖子详情页运行
- 以一次候选节点扫描和一次 ED2K/磁力链接联合收集替代多次全文扫描
- 将工具栏分为可折叠的常用、附件与链接、网盘和更多操作区域
- 修复配置迁移：导出包含搜索设置并默认隐藏凭据，导入只接受已知合法字段
- 以明确的官方域名和服务主机规则替换站点及网络通配权限
- ZIP 与字符集识别依赖锁定版本，并仅在增强预览实际需要时加载
- 一键评分请求使用当前论坛源地址，兼容官方子域名
- 将单体源码拆分为有序模块，同时继续发布单一生成用户脚本
- 增加构建、路由、权限、配置、扫描与搜索测试，并接入 CI 校验

### 3.0.1

- 将附件聚合工具栏严格限制在帖子详情页
- 不再在论坛首页显示浮动滚动按钮
- 页面识别不再依赖 URL 查询参数的排列顺序

### 3.0.0

- 将原独立搜索排序脚本完整并入 SHT Helper，并移除重复脚本
- 增加可记忆的热门帖子高亮，以及自动、低、中、高四档门槛
- 增加旧版独立排序脚本配置的一次性迁移
- 改进搜索面板的无障碍交互与窄屏布局
- 不再显示数值为零的配额徽标，并修复仅使用次排序后清除次排序时无法恢复原顺序的问题

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
