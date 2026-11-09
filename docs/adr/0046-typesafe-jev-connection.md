# 0046 TypeSafe Jev 决策服务连接

- 状态：Proposed（等待人类批准，尚未变更契约或实现）
- 日期：2026-11-09
- 关联：ADR 0041、0042

## 背景

用户希望在「设置 → AI → 添加连接」的服务列表里保存 TypeSafe 的 Jev 连接，供后续决策功能使用。
TypeSafe System One 接收状态与结构化问题，返回带类型的答案，与目前助手使用的 Chat Completions 协议不同。
官方参考：[TypeSafe API](https://api.typesafe.ai/redoc)。

## 提议

- 在 `AIConnectionKind` 新增 `typesafe-jev`。Web 服务名为「TypeSafe Jev」。由 Hub 保存连接，复用现有所有者与私有密钥规则。公开视图只返回是否保存密钥。
- 此连接固定使用官方地址 `https://api.typesafe.ai/v1`，使用 Bearer API Key。只有用户选择 Jev 并添加连接时才填写 Key。编辑时留空保留旧 Key。保存与查看连接不调用推理。
- 首期只交付连接的添加、编辑和展示。Web 的聊天 Profile 编辑器排除这种连接，Hub 同样拒绝将它用于现有聊天 Profile，避免把对话内容交给不同的协议。决策请求与答案的 Lumio 契约待实际调用场景确定。
- 新枚举值经现有 `/v2/ai/config` 返回。Hub 和 Web 随同一个版本发布。使用严格枚举的旧独立 API Client 需要升级才能读取含 Jev 的配置；已有连接数据无需迁移。

## 实施与验证

获批后由 Claude 起草 `packages/schema` 契约，Hub 和 Web 同批接入。合成契约测试覆盖 Jev 连接保存、固定地址、凭据遮蔽、所有者隔离、旧连接兼容及禁止用于聊天 Profile。提交前运行 `bun run check`。
