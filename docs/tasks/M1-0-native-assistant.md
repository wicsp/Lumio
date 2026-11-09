# M1-0 原生 Codex Assistant 本地试用

用户 2026-11-08 已授权实现、独立本地部署、推送，试用后再决定合并。ADR 0041/0042 与契约连带修改同批交付，不自动合并。

必读：docs/DESIGN.md；design/assistant.md、execution.md、security.md、hub.md、web.md；reviews/V0-0-spike-report.md；reviews/codex-assistant-adr-revision-notes.md。

交付：统一 Connection/Profile/用途绑定契约及 API/原生选择；官方 Codex 原生登录、动态模型/effort、连续对话、流式正文与公开思考摘要、审批、中断、恢复、MCP 业务工具；持久事件、配置/账户隔离与未知执行冻结；合成契约/故障/OS 读取隔离测试；独立本地试用服务和回退说明。

保留兼容：旧 API 配置与旧对话继续可用；Job 协议 2 保留，本切片不把既有任务/Routine 协议 3 迁移当作 native 聊天的前置条件。

验证：bun run check；真实官方客户端合成会话；平台隔离反向测试；本地 Web 交互验收。不得读取真实 vault，不复用个人全局客户端配置或复制认证文件作为正式登录方案。

验收状态（2026-11-08）：实现与独立本地部署完成；Bun 1.4.4 全量检查 1267 pass / 4 skip / 0 fail；真实 Codex 恢复与 MCP 合成验收通过。结果见 [验收报告](../reviews/M1-0-native-assistant-acceptance.md)，登录与启停见 [试用说明](../native-assistant-trial.md)。待用户试用后决定合并。

2026-11-08 用户追加明确指令：合并全部 PR 后从 main 构建并部署到现有 7420；原隔离试用仅作为历史验证记录。

2026-11-09：用户批准 [ADR 0044](../adr/0044-codex-connection-auth-and-assistant-controls.md)，授权实现连接级登录、对话自动恢复和统一停止并部署现有 7420。合成 Hub/Runtime 验收覆盖双会话、同账户重登、并发刷新、正常中断和未确认副作用；官方 0.166.0 通过环回 TLS 合成账户测试，确认 managed cache 刷新、external auth 401 回调和凭据目录隔离。真实账户需由用户在官方页授权。
