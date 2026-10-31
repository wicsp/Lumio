# ADR 0026：Web 工作台（GUI）

- 状态：Accepted（实现位于分支 `codex/web-workbench`，PR 合并时改为 Implemented）
- 日期：2026-11-01

## 背景

P4 的 GUI 此前被推迟。2026-11-01 用户明确提出「顺便再给我写一个 GUI」。现有 Hub HTTP API、`@lumio/api-client` 与 `@lumio/schema` 已覆盖 GUI 所需的用户侧能力，因此可以只新增 `apps/web`，不改契约、不新增委派权限。

## 决定

1. **形态与依赖**：`apps/web` 使用原生 TypeScript、DOM 与 CSS；构建和本地服务用 Bun 1.3.13。只依赖工作区内的 `@lumio/api-client` 与 `@lumio/schema`，不引入外部库。
2. **同源代理**：浏览器端 SDK 只请求同源 `/hub`。Web 服务把请求转发到固定上游 `LUMIO_WEB_HUB_URL`（默认 `http://127.0.0.1:7420`），默认监听 `127.0.0.1:4317`。
3. **代理安全边界**：
   - 用户路由按 GET/POST 严格白名单放行；不暴露 runtime 注册、归档上传与邀请接口。
   - 只转发 `Authorization`、`Content-Type`、`Accept`；不转发 cookie 与 forwarded 类头。
   - 校验 Host 与 Origin；经反向代理访问时，必须显式配置 `LUMIO_WEB_ORIGINS`。
   - 限制请求体与查询串大小；拒绝跟随上游重定向；NDJSON 按流转发。
   - 响应设置 `Cache-Control: no-store` 与限制性 CSP。
4. **凭据与会话**：凭据只保存在浏览器内存中，刷新页面需重新连接。配对沿用 `lumio login-code --name web`。任何 401 或登出都会中止进行中的请求，并清空各模块数据。不使用浏览器数据库，不直接读写 vault。
5. **功能范围**：
   - 概览：展示真实数据。
   - Knowledge：独立的阅读、搜索、类型与链接视图，私有内容需显式开启。Hub 没有 Knowledge 写接口，因此保持只读，编辑在外部完成。
   - Project/Task：核心字段的创建与更新表单。描述（带 revision）、评论、显式派发各自独立操作。描述用 textarea 加 Markdown 预览，不做自定义富文本编辑器。
   - Jobs：查看结果与待回答问题、取消执行；下载文件时校验大小与 SHA。
   - Routine：创建、编辑、暂停与恢复；查看设备列表。
   - Assistant：会话列表、流式输出与停止；可查看已保存状态，但不重放；记忆需显式操作。
   - 审批：先展示完整 argv、job、runtime 与理由，再由用户显式接受或拒绝。
6. **渲染**：Markdown 只支持安全子集。原始 HTML 一律转义，过滤不安全协议，不加载外部图片。界面沿用 source/private 过滤规则，并防止过期请求覆盖新结果。
7. **类型隔离**：浏览器端与 Bun 服务端使用两个独立的 TypeScript 程序，根 typecheck 同时调用两者，避免 DOM 全局类型污染后端代码。

## 边界

GUI 不自动迁移数据、不在 Web 进程安装或启动 agent，只通过 Hub 显式派活。本次实施不升级现有模型或服务、不做发布。它不是新的契约来源，所有数据形状以 `@lumio/schema` 为准。

## 后果

- 用户获得覆盖日常操作的本地 GUI，后端契约不变。
- 代理白名单需要随 Hub 用户路由同步维护；新增的用户路由默认不可通过 GUI 访问。
- 凭据只存内存，安全性更好，代价是刷新后要重新连接。
- Knowledge 保持只读，直到 Hub 提供写接口并另立 ADR。
- 不依赖外部 UI 库，需要自己维护组件与安全的 Markdown 子集。

## 授权记录

- 2026-11-01，用户请求：「顺便再给我写一个 GUI」。据此推进此前推迟的 P4。
- 本决定不改 `packages/schema`，不改公开数据契约，不新增委派权限，因此无需走契约审批流程。
- 上述范围内的常规实现选择不需要用户逐项再批。
- 测试与验证证据由 Codex 在 PR 中补充。

## 修订记录

（暂无）
