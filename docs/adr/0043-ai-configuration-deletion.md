# 0043 AI 配置删除接口

- 状态：Proposed（等待人类批准，未改契约或实现删除）
- 日期：2026-11-09
- 关联：ADR 0041、0042；PR #120 的后端 review

## 背景

Connection/Profile 只有创建和修改接口，无法清理废弃配置。删除需要明确所有者、并发修改、引用保护与历史保留规则；不修改已经 Implemented 的 ADR 0041/0042。

## 提议

- 新增 `DELETE /v2/ai/connections/:id` 与 `DELETE /v2/ai/profiles/:id`，只允许 human 删除自己拥有的配置，不进入 agent 能力目录。
- `packages/schema` 新增严格的 `AIConfigurationDelete` 请求 `{ request_id, expected_revision }` 和 `AIConfigurationDeleted` 结果 `{ id, deleted: true }`，ID 只能是 Connection/Profile ID。JSON Schema 由脚本导出。
- 修订号不符返回 `CONFLICT`；不存在或属于其他所有者统一返回 `NOT_FOUND`。按所有者、资源 ID、request_id 保存无凭据回执；相同请求重放返回原结果，相同 request_id 改变参数返回 `CONFLICT`。
- Connection 仍被任何 Profile 引用时拒绝删除，需先删 Profile。Profile 被未关闭的原生 Session 引用时拒绝删除，包括回收站中的对话和 unknown/隔离状态；先按原有流程停机、核查并关闭环境。检查与删除、回执同一事务提交。
- 删除只从可选配置中移除，不级联删除历史对话、运行、Profile/Connection 冻结快照和审计。已开始的 API 轮次继续使用冻结地址与凭据；以后显式引用已删除 Profile 的请求返回 `NOT_FOUND`，不偷偷切回默认模型。
- Connection 的私有密钥随活动配置行一并删除；既有备份与运行快照独立保留，删除配置不声称抹除历史备份。原生官方登录仍通过现有会话关闭流程管理。
- 兼容配置只迁移一次；删除最后一项后，GET 或进程重启不得再次从旧环境配置创建。迁移回执与删除回执不含密钥。

## 实施范围与验证

批准后由 Claude 起草 `packages/schema`，Codex 按契约完成 Storage 与 Hub，API Client/Web 后续接入。契约连带修改允许跨包，其余可读性修复独立提交。

合成测试覆盖 human/agent/runtime、跨所有者、修订冲突、重复请求、引用保护、unknown 会话、历史快照保留、删除后重启不复活及密钥不出现在响应/回执；提交前通过 `bun run check`。
