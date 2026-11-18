# 0082 F18 网页捕获使用一次性全站授权

- 状态：Implemented（2026-11-18）
- 领域：macOS 捕获、浏览器插件、权限
- 关联：ADR 0057、0066、0081

## 背景

ADR 0081 要求启用 F18 时逐站添加并授权。用户决定在按键时选择要剪藏的网页，取消扩展自己的白名单。
F18 由 Capture 接收，Chromium 的 `activeTab` 只在调用扩展本身时临时生效。[Chromium activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

## 决定

- 新的桌面配对一次性请求 HTTP 与 HTTPS 通配站点权限。已有桌面配对复用原密钥，可在扩展中启用同一权限。浏览器负责提示、授权和撤销。原配对白名单字段只作升级兼容，新记录只保存配对秘密。Hub 配对独立，按钮和右键继续使用既有路径。[Chromium 可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- 扩展通过已认证回环连接接收限时请求，只在真实捕获手势后读取前台活动标签页的已加载文档。抓取允许普通 HTTP(S) 页面和内网网站。排除无痕、浏览器保护的页面、导航后替换的文档以及含嵌入凭据的网址。浏览器权限缺失时保留原截图和 OCR 流程。
- 不改变 Hub 主动抓取校验、应用排除规则以及网页正文的存储和清理。此变更替代 ADR 0081 的逐站授权决定，协议保持兼容。
