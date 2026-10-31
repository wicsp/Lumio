# R0-7 可配置模型适配器

- 依据：ADR 0025 第 1、2、7、9 节；AssistantModel 既有纯端口。
- 范围：仅 apps/hub 的模型 HTTP 适配、环境配置、组装和合成测试，以及设计与使用文档；不改 schema。
- 不引入第三方依赖，不固定供应商/地址/模型，不启用真实工具或新增委托权限。
- 状态：已实现并验证。

首个适配器使用兼容 Chat Completions 的 HTTP/SSE 传输，网络留在应用层。
地址与模型均须显式配置，凭据只从运行时环境捕获，通过函数提供，不落盘或序列化。
已有模型注入接口保留；没有配置时助手给出配置说明，Work/Execution/Knowledge 照常使用。

参考 OpenAI Docs 官方 [请求格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
和 [流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)（2026-11-01 查阅）。
这里选兼容传输以便替换供应商，不把助手业务模型绑定到该传输。没有选择或调用真实模型。

验收：分片 UTF-8、工具 JSON 组装、完整终止、截断/非法参数/未知工具/长度限制、响应体上限、取消、无重试、无凭据泄露、JSON 兼容响应。
本地假 HTTP 服务验证环境配置 → Hub → Assistant → 适配器 → 持久化回执与重复请求的真实调用链。
提交前完整 bun run check。

验证：定向 7 pass；完整 LUMIO_LIVE=0 bun run check：804 pass、3 skip、0 fail，807 tests / 94 files；Bun 1.3.13。Claude 对固定快照只读审查未发现可验证缺陷；审查范围与限制将在最终 review 记录中保留。
