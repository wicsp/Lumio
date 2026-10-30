# P2-0 P2 的设计与契约

- 负责：Claude 起草，人类批准
- 相关 ADR：0019（新）、0005（修订）
- 涉及：`packages/schema`、`docs/`；`packages/core` 的 `VAULT_LAYOUT` 加入 `plan/routines`（契约连带修改）

## 内容（已完成）
- ADR 0019：Hub 与执行器、任务的 `status` / `assignee`（交接开关见 ADR 0024）、一个任务很多轮、记录分开存放、一轮只执行一次、例行任务、安全底线。
- ADR 0005 修订：一轮只执行一次、不自动重试、lease 取代多次 Attempt 的 fencing 编号、`needs_attention` 并入 `unknown`。
- 契约：
  - `entities.ts`：`Task`（`status`、`assignee`、执行配置（ADR 0024）；删去 `job` 字段）、新类型 `Routine`（前缀 `rtn`）。
  - `actor.ts`：角色 `runtime`。
  - `job.ts`：协议第 2 版——`JobSpec`、`JobResult`、`Job`、`RuntimeRegistration`、`RuntimeInfo`、`RuntimeHeartbeat`、
    `RuntimeSync`、`RuntimeAck`、`RoutineSpec`。
  - `operation.ts`：`TaskDispatch`、`ExecPrivileged` 的格式（尚未加入 `Operation`，分别由 P2-4、P2-6 加入）。
- DESIGN.md 第 3、4.6、5、6、8 节。
