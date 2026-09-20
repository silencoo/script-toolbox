# Linux.do 内容归档

`linuxdo-content-archiver.user.js` 支持保存主题 HTML，或将内容发送到自己的 WordPress。

## WordPress 凭证设置

1. 安装或更新用户脚本，使用支持 `GM_xmlhttpRequest` 的 `redirect: 'error'` 的 Tampermonkey 5.0+。
2. 在 Linux.do 工具栏打开 Settings，填写自己网站的 HTTPS 地址，选择“保存偏好并前往 WP 后台”。
3. 在自己网站的 `/wp-admin/` 页面，通过 Tampermonkey 菜单选择“配置本站 WordPress 发布”。
4. 保存用户名和 WordPress 应用密码，然后返回 Linux.do 发布。建议使用专门的低权限账号。

凭证输入框只存在于 WordPress 后台页面，Linux.do 设置界面不读取、输入或回填密码。
已存密码也不会回填到后台输入框；同一站点、同一账号下留空表示保留。
切换站点或账号必须重新填写密码。旧版已保存的 HTTPS 站点仍可发布；HTTP 站点需重新配置。
用户脚本更新会增加 HTTPS WordPress 后台的匹配权限，这是设置界面所在的位置。

发布请求只允许发往已配置站点的 HTTPS WordPress API，禁止跟随重定向；若站点迁移，
请先在新站点后台重新保存设置。应用密码仍保存在用户脚本管理器中，未做额外本地加密。

## 验证

`tests/privacy.test.cjs` 使用 Playwright、独立浏览器上下文及虚构 GM 存储；所有网络请求均由测试截获。
通过 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，必要时通过 `CHROMIUM_EXECUTABLE` 指定浏览器。
