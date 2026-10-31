# R0-5 数据库 Routine 与协议 2 接入

- 依据：ADR 0025 第 1、3、4、5、8 节，已批准的 R0-1 ExecutionRoutine 契约。
- 范围：Execution 用例及其必要 Storage、Hub、API Client、CLI 调用方；不修改 schema 或 Runtime 协议。
- 状态：分支内完成，等待最终交叉 review 与合并。

## 交付

Routine 的计划、执行模板与配置版本由 Execution 数据库负责，不要求 Knowledge 或 Task。
创建/更新不立即派出 Job；计划仍交给 Runtime 本地触发，保留确定性编号、ack/outbox 与结果幂等。
每次已发出的计划保留不可变快照；离线设备的旧结果通过 lease 找到当时输入。
心跳只有 Job ID 时不猜测多份历史输入，等待结果的 lease 消除歧义。

Hub 组合旧未迁移 Routine 与新版计划；新版入口沿用统一授权、版本与请求去重。
CLI 提供 new/list/show/update/edit/status/followup，旧笔记通过 --legacy 或旧 Hub 404 兼容。
正文编辑冲突保留副本；追问创建 Work 任务，不修改知识笔记。

## 验证

- 纯合成 SQLite 验证无 Knowledge/Task 可用，非法 cron/时区、修订冲突、重复请求不派活。
- 旧计划在离线时更新，结果仍保存原始输入，错误 lease 被拒绝，重复回报只有一条 Job。
- Hub/CLI 与 Runtime 协议 2 端到端验证，保留旧 Routine 兼容测试。
- 提交前运行 bun run check；不读取真实数据或调用真实 agent。

2026-11-01 验证：Bun 1.3.13，完整 `LUMIO_LIVE=0 bun run check` 通过，758 pass、3 skip、0 fail
（761 tests / 84 files）；包含实际 Hub + Runtime 的无知识目录、离线补交、错过触发合并与 CLI 追问测试。
没有改 schema、Runtime 协议或引入依赖。
