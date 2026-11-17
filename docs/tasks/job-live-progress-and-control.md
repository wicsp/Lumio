# Job 实时进度与同轮人工介入

- 依据：[ADR 0069](../adr/0069-job-live-progress-and-control.md)（Proposed，获批准后实施）
- 必读：[设计总览](../DESIGN.md)、[Execution](../design/execution.md)、[Work](../design/work.md)、
  [Assistant](../design/assistant.md)、[安全](../design/security.md)、[Web](../design/web.md)。

派给 Codex 或 Claude 的 Job 在运行中应能查到机器是否已接手、最近实际做了什么以及何时需要人工介入。
人在同一轮回答或决定授权时，可以确认对应请求已送达或过期。

| 顺序 | 交付 | 范围 |
|---|---|---|
| 1 | 定义活动快照、游标分页、协商、运行端收发和人工请求/动作类型，重新生成 JSON Schema | `packages/schema` |
| 2 | 持久补发、去重、Hub 查询及控制鉴权，接入现有 Job 取消与终态；Codex/Claude 流式适配，保留最终报告 | `packages/execution`、`packages/storage`、`apps/runtime`、`apps/hub` |
| 3 | 在 Today、任务和执行页展示活动，增加 `lumio job watch`、JSON 和明确的旧执行器/失联提示 | `packages/api-client`、`apps/cli`、`apps/web` |
| 4 | 两种引擎同轮问答及审批、受支持的纠偏/停止、工作流和独立 Job 的交互模式、人工通知；同步分册 | 上述模块及 `packages/work` |

验收用合成 Job、临时数据库、假引擎二进制和录制后脱敏的结构化事件样本。

1. 在本机 Hub 和 Runtime 测试配置中，接手确认和第一条已观察工具事件各自在 5 秒内可见。
   Codex 命令执行中可看到命令状态，Claude 可看到已提供的工具活动，两者长时间静默时仍显示心跳与上次活动。
2. 从 Today 进入任务再进入 Job，能看到对应阶段、时间线和当前人工请求。两个并行分支的活动不串线。
   刷新、重复或乱序投递、延迟送达、Runtime 到 Hub 断线、浏览器过期游标、终态提前到达时，
   状态、事件与报告保持一致，已经运行的 Job 或工具不被重跑。
3. 流解析覆盖拆开的 UTF-8、同一块内多行、未知事件、超限/破损行、长输出后才出现最终结果。
   容量耗尽时特殊事件和轮末结果仍可交付，已知测试密钥和原始工具输出不出现在 Job 活动接口、推送与审计正文。
4. 各跑一例 Codex 和 Claude 的问答、批准、拒绝、超时、取消及断线后的决定。两个窗口重复提交只执行一次。
   错误设备、旧 lease、旧进程或轮次、任务已取消、非 human 身份、已过期的请求都不能完成授权。
   原有轮末提问、阶段权限申请、检查点和结果验收回归测试通过。
5. 验证新 Hub 与上一版 Runtime 的握手和 Job 结果，验证仓库锁定的 Bun 1.4.4 上 `bun run check` 通过。
   PR 记录使用的真实引擎版本、认证和隔离支持范围，以及在隔离环境中实际运行的端到端路径。
