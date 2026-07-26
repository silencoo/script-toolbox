# XSijishe Enhancer

适用于 XSijishe 相关域名的 Tampermonkey / Violentmonkey 用户脚本。它将原本固定宽度的页面调整为响应式布局，并提供栏目导航、显示控制和图片布局选项。

## 功能

- 将 `xsijishe.net`、`xsijishe.cn` 及其子域名链接统一到 `xsijishe.com`
- 自动移除链接中的 `mobile` 和 `forcemobile` 查询参数
- 优化桌面端和移动端页面布局，避免横向溢出
- 根据当前页面栏目生成快捷导航
- 单独隐藏或恢复页面栏目
- 在填充裁剪、完整显示和瀑布流三种图片模式之间切换
- 可选隐藏页面底部区域
- 使用 userscript 本地存储保存显示偏好

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开[脚本直装链接](https://raw.githubusercontent.com/silencoo/script-toolbox/main/userscripts/xsijishe-enhancer/xsijishe-enhancer.user.js)。
3. 在 userscript 管理器中确认安装，然后访问脚本支持的任一域名。

## 支持的域名

- `xsijishe.com` 及其子域名
- `xsijishe.net` 及其子域名
- `xsijishe.cn` 及其子域名

脚本会将支持域名中的页面和站内链接归一化到 `xsijishe.com`。如果站点的主域名策略发生变化，请在安装前检查脚本中的 `PRIMARY_HOST` 配置。

## 配置与隐私

栏目显隐、图片模式和页脚显示偏好通过 `GM_setValue` 保存在 userscript 管理器的本地存储中。脚本不包含第三方依赖，不会向项目控制的服务器发送数据。

## 开发

脚本是无需构建的单文件 userscript。修改后请同步更新脚本元数据中的 `@version`，并运行：

```sh
node --check userscripts/xsijishe-enhancer/xsijishe-enhancer.user.js
```

## License

[MIT](../../LICENSE)
