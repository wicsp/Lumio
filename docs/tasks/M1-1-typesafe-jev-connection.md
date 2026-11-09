# M1-1 TypeSafe Jev 连接

必读：`docs/DESIGN.md`、`docs/design/assistant.md`、`docs/design/web.md`、`docs/design/security.md`。

交付 [ADR 0046](../adr/0046-typesafe-jev-connection.md) 的连接配置与 Web 入口。Jev 使用固定官方地址和私有密钥，创建时需要密钥，编辑时可以保留或更换。禁止 Jev 成为聊天 Profile。决策推理由后续用例接入。

验证使用合成连接、独立 Hub 状态及 `@lumio/schema` 校验请求和响应，覆盖地址限制、所有者隔离、密钥保留与轮换、旧连接兼容及聊天 Profile 拒绝。提交前运行 `bun run check`。
