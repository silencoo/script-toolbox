# Cookie Exporter

一个隐私优先的 Chromium Manifest V3 扩展。它只在用户点击读取时申请目标网站权限，在弹窗内预览 Cookie，并导出到本地文件。

## 功能

- 从当前标签页或手动输入的 URL 读取 Cookie
- 提供“当前 URL”和“整个站点域”两种读取范围
- 读取普通、Secure 和 HttpOnly Cookie
- 当前标签页会使用它所属的 Cookie Store，兼容普通窗口和已授权的隐身窗口
- 默认隐藏 Cookie 值，以每页 10 条分页预览并允许逐条编辑
- 按 Name、Value、Domain、Path、SameSite、安全属性等字段搜索读取结果
- 在内存中编辑 Cookie 快照字段，修改会进入复制和导出但不会写回浏览器
- 将当前所选格式的完整文本直接复制到剪贴板
- 默认在读取完成后移除目标网站权限
- 不发送网络请求，不加载远程脚本，不使用扩展存储

支持的导出格式：

| 格式 | 适用场景 | 保真说明 |
| --- | --- | --- |
| JSON | 备份、程序处理 | 保留扩展 API 返回的全部字段 |
| Netscape cookies.txt | curl、wget、yt-dlp | 无法表示 SameSite、Store、分区等现代属性 |
| Cookie 请求头 | 临时粘贴到 HTTP 工具（仅“当前 URL”范围） | 只保留 name=value |
| CSV | 人工查看、表格处理 | 将 API 字段按列展开 |

## 开发与构建

需要 Node.js 22.12 或更高版本。

    npm ci
    npm run validate

开发时可以运行：

    npm run dev

生产构建输出到 <code>dist/</code>：

    npm run build

## 安装

1. 在本目录运行 <code>npm ci</code> 和 <code>npm run build</code>。
2. 打开 <code>chrome://extensions</code>。
3. 启用“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本项目的 <code>dist/</code> 目录。
5. 将扩展固定到工具栏，从任意 http 或 https 页面打开。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| <code>activeTab</code> | 用户打开弹窗时识别当前标签页 URL |
| <code>cookies</code> | 读取完整 Cookie 属性，包括 HttpOnly |
| 可选网站权限 | 只在点击“授权并读取 Cookie”后申请所选读取范围需要的主机 |

扩展声明了 http 和 https 的可选 host permission 模板，但不会在安装时获得所有网站访问权。点击读取后：

- “当前 URL”只申请目标主机及其合法父 Cookie 域的精确权限。例如 <code>gemini.google.com</code> 会申请 <code>gemini.google.com</code> 和 <code>google.com</code>，不会申请其他 Google 子域；查询仍按完整 URL 匹配，所以 Path、Secure 等规则继续生效。
- “整个站点域”申请可注册域及其通配子域权限。例如 <code>gemini.google.com</code> 会申请 <code>google.com</code> 和 <code>*.google.com</code>，并读取该域下全部子域和路径的 Cookie。

站点域使用 Public Suffix List 规则计算，因此 <code>example.co.uk</code>、<code>project.github.io</code> 等地址不会用简单的“最后两段”方式误判。默认设置会在读取完成后立即尝试撤销本次申请的权限。当前标签页由 <code>activeTab</code> 提供的临时访问仍遵循浏览器生命周期，会在导航到其他站点或关闭标签页后结束。

## 数据与安全

Cookie 可能等同于账户登录凭据。导出文件和点击“复制”生成的剪贴板内容都不会经过任何服务器，但复制、同步或分享仍可能导致账户被接管。使用后应及时删除不再需要的导出文件并覆盖敏感剪贴板内容。

扩展不会：

- 上传 Cookie 或目标网址
- 将 Cookie 写入 localStorage、IndexedDB 或 chrome.storage
- 未经点击就自动复制 Cookie 到剪贴板
- 记录 Cookie 值到控制台

关闭弹窗会释放页面内存中的读取结果。

搜索只影响弹窗预览，不会减少复制或导出的 Cookie 数量。匹配结果按每页 10 条分页，因此每条 Cookie 都可到达并编辑。编辑器支持常用字段、安全属性、Store ID 和 Partition Key；每条修改都可恢复到本次读取时的原值。所有修改仅存在于当前弹窗内存中。

## 当前限制

- 首版以 Chrome 119+ 及 Chromium 系浏览器为目标，尚未打包 Firefox 或 Safari 版本。
- “当前 URL”范围只导出会随该 URL 发送的 Cookie；“整个站点域”范围会忽略 URL Path 并覆盖所有子域。
- 指定网址使用当前扩展上下文的默认 Cookie Store。要导出隐身窗口 Cookie，请在已授权运行扩展的隐身窗口中打开弹窗。
- JSON 和 CSV 会保留 API 返回的 <code>partitionKey</code>，但首版不会主动枚举目标站点的所有分区 Cookie jar。
- Netscape 和请求头格式天生有损，不能作为完整的往返备份格式。

## 测试边界

自动化测试覆盖 Public Suffix 站点域计算、运行时权限范围、URL/站点域两种 Cookie 查询、字段搜索、快照编辑与恢复、导出格式以及弹窗的单滚动容器布局。浏览器 API 测试使用 <code>chrome.cookies</code> mock，不会读取开发者或用户的真实登录 Cookie；真实网站返回数量仍需在安装扩展的目标 Chrome Profile 中人工确认。
