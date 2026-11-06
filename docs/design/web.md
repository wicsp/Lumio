# Web 工作台

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。
> 功能、页面与快捷键见 [`apps/web/README.md`](../../apps/web/README.md)（ADR 0036：设计文档不写界面交互细节）。

网页由 Hub 提供；决定见 ADR 0026、0027。

- **技术栈**：原生 TypeScript、DOM 与 CSS，用 Bun 1.3.x 构建静态资源，由 Hub 提供。业务依赖 `@lumio/api-client` 与 `@lumio/schema`；笔记编辑集成 CodeMirror 6 的 state/view/commands/language/lang-markdown/autocomplete（ADR 0035）。
  Hub 为每次 HTML 响应生成样式 nonce，允许编辑器动态样式，不放宽脚本 CSP。
- **类型隔离**：浏览器端与服务端是两个独立的 TypeScript 程序，根 typecheck 同时检查两者。
- **访问路径**（ADR 0027）：网页由 Hub 在自己的地址上提供（单机 `http://127.0.0.1:7420`；服务器模式为 Hub 的对外地址），浏览器与 Hub 同源，直接调用 `/v1`、`/v2`。
  Hub 为页面与资源设置限制性 CSP；浏览器请求（带 `Origin` 或 `Sec-Fetch-Site`）的 Origin/Host 必须是本机监听地址、`LUMIO_PUBLIC_URL` 或 `LUMIO_WEB_ORIGINS` 列出的来源。
- **会话**：先用 `lumio login-code --name web` 配对。身份验证后，默认以 sessionStorage 保留当前标签页登录，刷新自动恢复；勾选「记住这台设备」时使用 localStorage，关闭重开仍可恢复。仅保存凭据，按网页所在的 Hub 来源隔离。恢复前验证 human 身份。同源脚本可读，受现有 CSP 与安全渲染保护；不等同 HttpOnly 或钥匙串隔离。验证遇到 401/403 或登出时清除对应凭据，任何 401 或登出中止请求、清空模块；临时断线保留凭据并允许重试。存储受限时降级并提示，不缓存业务数据或直接访问 vault。
- **数据规则**：私有内容须显式开启；知识的新建与编辑规则见 [knowledge.md](knowledge.md)；任务与项目的每次修改只改一个字段并带 revision，描述单独保存；评论与委派是独立的显式操作；
  执行结果中的文件下载要校验大小与 SHA；助手会话可查看已保存状态，不重放；高权限审批必须展示完整 argv、job、runtime 与理由，由人显式接受或拒绝。
- **渲染**：只支持安全的 Markdown 子集。转义原始 HTML，过滤不安全协议，不加载外部图片。沿用 source/private 过滤，并丢弃过期请求的结果。
- **主题与语言**（ADR 0028）：主题与界面语言可切换，默认分别跟随系统与浏览器语言，选择只保存在本浏览器；请求带 `Accept-Language`。
- **推送**（ADR 0031，R4-5）：`/sw.js` 只处理推送与点击跳转，不缓存；CSP 允许 `worker-src 'self'`。通知规则见 [work.md](work.md)。
- **部署**：前端资源构建时嵌入 `lumio` 程序，随 Hub 一起提供与升级（ADR 0027）。
- **App**：提供 Web App Manifest 与图标，可安装到桌面或主屏幕；不缓存业务数据。原生 Mac App 以后另定（ADR 0027）。
- **边界**：Web 不自行运行 agent，通过 Hub 显式委派。
