# 四模块重构第一阶段交叉 review

- 作者：Codex（Work、Assistant、Storage、Hub/CLI 接入）；schema 起草：本机 Claude Code。
- Review：本机 Claude Code，只读审查，未修改仓库；Codex 复核结论并补充验证。
- 范围：R0-1 契约调用方、Work/Assistant 用例及存储、v2 HTTP、CLI、客户端事件流。
- 本文不宣称整个 R0 重构完成；Knowledge/Execution 后续提取、日志、备份迁移和模型适配另有验收。

## 结论与处理

Claude 未报告 P0/P1，报告两项 P2。逐项复核：

1. **建议拒绝所有空 AssistantMessage/模型内容**：不按建议修改 schema。模型调用工具时允许只有 tool_calls、没有文本；
   这是有效的中间状态。工具结果使用 JSON.stringify，空字符串结果会变成 JSON 字符串而不是空消息。
   采纳其中“最终回复不能为空”的有效部分：AssistantService 在无工具调用且最终内容为空白时把本轮标记为失败；
   测试覆盖空中间内容可执行工具、空最终回复明确失败，以及事件监听断开不改变已完成状态。
2. **建议无 vault 时拒绝启动**：不采纳。Work 无知识目录可独立使用是 ADR 0025 的明确目标；server 在未配置时使用
   不扫描文件的协调器，并不会调用 startVaultWatch。真实端到端测试覆盖无知识目录创建任务、派活、结果与重启，
   知识查询则返回明确的未配置错误。没有配置知识目录时不会用空路径做 workdirInVault 检查。

代码与契约的后续交叉 review 继续按 AGENTS.md 执行；上述分歧保留供人类在 PR 中核对。

## 阶段验证

- Bun 1.3.13，`LUMIO_LIVE=0 bun run check`：753 pass、3 skip、0 fail（756 tests / 82 files）；类型和依赖检查通过。
- 首轮完整检查曾有一次 Hub 重启补交结果的等待超时；相同代码单独连续运行 6 次通过，随后完整检查通过。
  未因尚未复现的超时改动执行逻辑或放宽测试期限；最终验收仍需覆盖这一可靠性路径。
- 不读取真实 vault，不调用真实模型或 agent，不升级已安装服务；未引入新的第三方依赖。
