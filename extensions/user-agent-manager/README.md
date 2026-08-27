# UA Switcher & Manager

一个面向 Chromium 138+ 的 Manifest V3 User-Agent 切换与管理扩展。所有配置和规则都保存在浏览器本地。

## 功能

- 在弹窗中为当前网站或所有网站快速选择身份
- 内置 Chrome、Edge、Firefox、Safari、Android、iPhone 和 Googlebot 配置
- 创建、复制、编辑和删除自定义身份
- 按域名设置覆盖规则；更具体的域名优先
- 同步 `User-Agent` 与 `Sec-CH-UA*` Client Hints
- 对非 Chromium 身份移除 Chromium Client Hints，避免明显冲突
- 使用 MV3 User Scripts 在 `document_start` 同步 `navigator.userAgent`、`platform`、`vendor` 和 `userAgentData`
- JSON 导入/导出、全局暂停、明暗主题和键盘可操作界面

## 构建与加载

```bash
cd extensions/user-agent-manager
npm install
npm run validate
```

然后打开 `chrome://extensions`：

1. 开启“开发者模式”。
2. 选择“加载已解压的扩展程序”。
3. 选择本项目生成的 `dist/` 目录。
4. 在扩展详情中开启“允许用户脚本”。如果未开启，请求头切换仍可用，但网页读取到的 `navigator.userAgent` 仍可能是浏览器原始值。

## Manifest V3 实现

- `declarativeNetRequestWithHostAccess`：通过动态 `modifyHeaders` 规则设置 `User-Agent`。
- Client Hints：只在 Chrome 原本会发送对应提示时替换它，避免主动增加高熵请求头；Safari/Firefox 等身份会移除现有的 Chromium 提示。
- `userScripts`：注册一个 `MAIN` world、`document_start` 脚本，使用同一份域名优先级配置同步页面 JavaScript 可见值。
- `storage`：保存身份、域名规则和设置。
- `tabs`：读取当前标签页域名，并在应用规则后刷新该标签页。
- `http://*/*`、`https://*/*`：修改网络请求头和运行页面身份同步所必需的主机访问权限。

扩展不使用 `webRequestBlocking`、远程代码、内容脚本桥接、遥测或外部服务。

## 兼容性说明

- 修改 User-Agent 不会改变 TLS/HTTP2 指纹、浏览器特有 API、CSS 支持、渲染引擎或 IP 地址；需要完整浏览器伪装时应使用独立浏览器配置或自动化环境。
- Chrome 会定期减少 User-Agent 信息。内置版本是可复现的兼容快照，不代表自动追踪最新浏览器版本；可复制为自定义配置后更新。
- 网站可能缓存 Client Hints。切换后建议刷新页面；某些站点可能需要关闭旧标签页后重新打开。
- Chrome 内部页、扩展页和 Chrome Web Store 页面不允许普通扩展修改。

## 开发

```bash
npm run typecheck
npm test
npm run build
```

生产构建位于 `dist/`，Vite 会复制清单、本地化文件和 PNG 图标。
