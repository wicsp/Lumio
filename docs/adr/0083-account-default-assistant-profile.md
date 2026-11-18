# 0083 默认助手模型改为 Hub 上的账号设置

- 状态：Accepted（2026-11-19，人类批准）
- 领域：Assistant、统一 AI 配置、Web、Capture
- 关联：ADR 0041、0042、0059、0066

## 背景

设置页的「默认助手模型」只写进浏览器 localStorage。网页聊天每轮都会附上这个 Profile，所以能正常回复。
F18（Lumio Capture）、iPhone 快捷指令等入口不经过网页，请求不带 Profile。主对话创建时也没有绑定 Profile，Hub 只能退回旧的 `LUMIO_ASSISTANT_*` 设置，旧设置为空就报「模型地址和名称未配置」。
同一缺口还出现在后台话题摘要、提前探索和个人对话：它们各自取第一个 API Profile 或直接用旧设置，与设置页显示的默认值无关。

## 决定

- 默认助手 Profile 是 Hub 上的账号设置：`GET/PUT /v2/ai/assistant-binding`，契约 `AssistantDefaultBinding`、`AssistantDefaultBindingUpdate`。
  只有 human 本人可读写；带 `request_id` 幂等回执，可选 `expected_revision`；`profile: null` 清除默认。可以选 `lumio` 或 `codex` 引擎的聊天 Profile。
- 请求和会话都没有指定 Profile 时，Hub 按同一条规则选模型：账号默认是 Hub 上带 API 地址的 `lumio` Profile 时用它，否则用第一个这样的 Profile，都没有才用旧设置。主对话、普通对话、后台话题摘要、提前探索、个人对话都用这条规则。
- 删除被设为默认的 Profile 不受阻，默认自动失效。
- 网页主对话不再附带 Profile，由 Hub 解析，F18 与网页结果一致，改默认后下一轮生效。
  聊天页对没有绑定 Profile 的对话显示「默认 · 模型名」，选这一项发送时不带 Profile，对话会跟随之后的默认设置。新对话的默认是 Codex Profile 时直接选中它（原生会话需要明确的 Profile）。
- 浏览器里留有旧版选择、而 Hub 还没有记录时，网页把它迁移到 Hub 一次并清掉本地副本。

## 验收

- 只配置 Profile、没有旧设置时，F18 捕获后的主对话能用默认 Profile 回复。
- 改默认后，网页和 F18 的下一轮都用新模型；显式指定的请求或会话 Profile 仍然优先。
- 删除默认 Profile、清除默认、重启 Hub 后都回到第一个可用的 API Profile。
