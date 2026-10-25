# 0002 全部使用 TypeScript，运行在 Bun 上

- 状态：Implemented（2026-10-22）
- 日期：2026-10-22
- 取代：本 ADR 早先的提议版本"Rust 写后端，TS 写客户端"

## 背景
需要 CLI、Hub、Runtime（部署在 Mac 与实验室服务器）、飞书 Bot、Chrome 插件、Web、手机端。
代码主要由 AI 编写，人负责 review 和掌控结构。曾考虑用 Rust 写后端，研究后放弃。

## 研究结论（2026-10-22）
- **契约跨语言生成不成熟**：typify v1 实际只支持 Draft 7，对 `allOf`/`oneOf`、跨文件 `$ref`
  处理差，typify 2 无发布时间；Zod 的 `z.fromJSONSchema()` 为实验性 API。
- **Rust 的 YAML 生态动荡**：`serde_yaml` 停止维护，`serde_yml` 被 RUSTSEC-2025-0068 判定为
  不安全且已归档，只剩社区 fork。frontmatter 解析是 P0 的核心。
- **飞书**：官方 Node SDK 支持 WSClient 长连接；Rust 只有非官方 SDK，事件处理未完成。
- **MCP**：两边都有官方 SDK；Rust 的 rmcp 半年内从 1.0 升到 3.x，接口变动频繁。
- **单二进制分发**：`bun build --compile` 可交叉编译到 macOS arm64、Linux x64/arm64，
  抵消了 Rust 的主要分发优势（代价是体积较大）。
- **AI 协作**：用自己不熟悉的语言 review AI 代码，会削弱对结构的掌控。

## 决定
- 所有包和应用都用 TypeScript，运行时与包管理器用 Bun，测试用 `bun test`。
- CLI、Hub、Runtime 用 `bun build --compile` 编译成单个二进制。
- 实验侧 Python SDK 仍用 Python，类型从导出的 JSON Schema 生成（ADR 0003）。

## 后果
- 好处：一套工具链；飞书、MCP、Markdown/YAML 都有成熟库；人能有效 review 全部代码。
- 代价：二进制体积大于 Rust；Bun 比 Node 年轻，遇到兼容问题时可退回 Node（代码不依赖
  Bun 专有 API 的部分无需改动）。
- 保留选项：Runtime 只通过 HTTP + job 协议与 Hub 通信（ADR 0005），将来如果想用 Rust
  重写，只替换 `apps/runtime` 一个应用。
