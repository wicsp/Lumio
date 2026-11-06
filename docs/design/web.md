# Web 工作台

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。

中文 GUI，网页由 Hub 提供；决定见 ADR 0026、0027。

- **技术栈**：原生 TypeScript、DOM 与 CSS，用 Bun 1.3.x 构建静态资源，由 Hub 提供。只依赖 `@lumio/api-client` 与 `@lumio/schema`。
- **类型隔离**：浏览器端与服务端是两个独立的 TypeScript 程序，根 typecheck 同时检查两者。
- **访问路径**（ADR 0027）：网页由 Hub 在自己的地址上提供（单机 `http://127.0.0.1:7420`；服务器模式为 Hub 的对外地址），浏览器与 Hub 同源，直接调用 `/v1`、`/v2`。
  Hub 为页面与资源设置限制性 CSP；浏览器请求（带 `Origin` 或 `Sec-Fetch-Site`）的 Origin/Host 必须是本机监听地址、`LUMIO_PUBLIC_URL` 或 `LUMIO_WEB_ORIGINS` 列出的来源。
- **会话**：先用 `lumio login-code --name web` 配对。身份验证后，默认以 sessionStorage 保留当前标签页登录，刷新自动恢复；勾选「记住这台设备」时使用 localStorage，关闭重开仍可恢复。仅保存凭据，按网页所在的 Hub 来源隔离。恢复前验证 human 身份。同源脚本可读，受现有 CSP 与安全渲染保护；不等同 HttpOnly 或钥匙串隔离。验证遇到 401/403 或登出时清除对应凭据，任何 401 或登出中止请求、清空模块；临时断线保留凭据并允许重试。存储受限时降级并提示，不缓存业务数据或直接访问 vault。
- **模块**：
  - 概览。
  - Knowledge：只读，支持搜索、类型与链接视图，私有内容需显式开启。
  - Project/Task：按状态分组的列表；属性点选后立即保存（每次一个字段，带 revision）；描述默认渲染、点击编辑，单独保存；评论与派发是独立的显式操作。
  - Jobs：结果与待回答问题、取消；文件下载校验大小与 SHA。
  - Routine：创建、编辑、暂停与恢复；设备列表。
  - Assistant：流式会话与停止；可查看已保存状态，不重放；记忆显式管理。
  - 审批：展示完整 argv、job、runtime 与理由，由用户显式接受或拒绝。
- **渲染**：只支持安全的 Markdown 子集。转义原始 HTML，过滤不安全协议，不加载外部图片。沿用 source/private 过滤，并丢弃过期请求的结果。
- **主题与语言**（ADR 0028）：可切换「跟随系统 / 浅色 / 深色」与「English / 中文」，默认分别跟随系统与浏览器语言，选择保存在本浏览器；请求带 `Accept-Language`。
- **交互**：⌘K 命令面板（跳转、新建、搜索）；数字键切换模块、C 新建任务、J/K 列表导航；设置页（`#settings`：外观「跟随系统 / 浅色 / 深色」、English / 中文、Hub 与执行器状态、退出登录）；860px 以下底栏只有今日、任务、知识库、助手四项，执行与审批从「今日」进入，列表与详情分屏显示（ADR 0028）。
- **部署**：前端资源构建时嵌入 `lumio` 程序，随 Hub 一起提供与升级（ADR 0027）。仓库内 `bun run demo:web` 用合成数据试用。
- **App**：提供 Web App Manifest 与图标，可在 Safari「添加到程序坞」、Chrome「安装」、iPad/iPhone「添加到主屏幕」；不注册 Service Worker、不缓存业务数据。原生 Mac App 以后另定（ADR 0027）。
- **边界**：Web 不自行运行 agent，通过 Hub 显式委派。
