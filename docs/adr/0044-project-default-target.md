# 0044 项目默认委派目标与「一键委托」

- 状态：Proposed
- 日期：2026-11-09
- 领域：数据 | AI 协作与权限
- 影响：补充 ADR 0033（委派时按「任务 → 项目」继承，与 workdir 同一模式）、ADR 0032（`work.task.dispatch` 缺省 `to` 的解析顺序）。
  契约：`WorkProject` 增加可选 `default_target`；`WorkTask` 增加可选 `target`；对应 create / update 参数同步增加。均为向后兼容的新增，不迁移数据。
- 实施说明：[E1-0](../tasks/E1-0-project-default-target.md)

## 背景

人类 2026-11-09 提出：在 Today 里有很多待办，其中项目任务大多是交给同一个 agent（如 `codex@macsp`）去做的。
现在委派要先打开任务、选目标再派出；`work.task.dispatch` 不带 `to` 时只会沿用最近一轮的 agent，新任务没有历史就必须手选。
希望给项目设一个默认执行者，项目下的任务都继承它，Today 的待办卡片右侧直接有「委托」按钮，一点就用默认执行者开工。

术语：Lumio 里「执行器」指设备上的 Runtime（如 `macsp`）。这里的默认值是**委派目标**（`engine@runtime`，如 `codex@macsp`），
界面上称「默认执行者」，避免与 Runtime 混淆。

## 决定

### 1. 字段：项目设默认，任务可覆盖

- `WorkProject.default_target?: AgentTarget`——项目下任务的默认委派目标。
- `WorkTask.target?: AgentTarget`——只有这个任务要换人时才设；缺失表示继承项目。
- 与 workdir 一样**在委派那一刻解析，不在新建任务时复制**：改项目默认后，没有单独设置的任务随之改变；已派出的轮次不受影响（Job 记录当时的目标）。
- 提交时按 ADR 0033 第 3 节校验目标存在（不存在 → INVALID 并列出可用目标；离线允许，结果注明离线）。
  执行器改名后旧默认值不会被自动改写，下次委派时报错并提示去项目里改。

### 2. `work.task.dispatch` 缺省 `to` 的解析顺序

1. 显式 `to`；
2. 任务有交接计划时，按计划当前步骤的 agent（现有规则不变）；
3. 轮到人且原因为 `answer`（回答并继续）时，沿用提问的那一轮的 agent，保证接上同一个会话；
4. 任务的 `target`；
5. 所属项目的 `default_target`；
6. 最近一轮的 agent（保留旧行为，覆盖无项目、无默认的老任务）；
7. 都没有 → INVALID，提示指定 `to` 或给项目设默认执行者。

派出结果里带上实际使用的目标与它的来源（`explicit / plan / session / task / project / last_round`），Web 与 CLI 据此提示「已交给 codex@macsp（项目默认）」。

### 3. 权限不变

- 人点「委托」= 人直接委派，和现在一样不需要批准；agent 设置 `target` / `default_target` 属于修改任务 / 项目，沿用现有权限与提议规则；agent 不带 `to` 委派仍要人批准（ADR 0031）。
- 被阻塞的任务（ADR 0039）照常拒绝委派。

### 4. Today「委托」按钮

- 出现在「待办」组里**轮到你、原因为 todo、结局 open**、且能解析出目标（任务 `target` 或项目 `default_target`）的条目右侧；
  提问 / 验收 / 失败卡片已有各自的继续按钮，不重复加。
- 一次点击即派出（带 `expected_revision`），按钮提示写明交给谁；旁边的小箭头可临时换目标（只作用于这一次，不改任务字段）。
- 被阻塞时禁用并说明缺哪些前置；派出后条目离开待办，提示里可跳到这一轮的运行。
- 没有可解析目标的待办不显示按钮，保持 Today 简洁；在任务详情里照常可以选目标委派。

## 不在本 ADR 内

- 默认目标改为引用 ADR 0041 的 Profile / 用途绑定：等 Job 接入 Connection/Profile 时再定，届时 `default_target` 可迁移为 Profile 引用。
- 批量委托（多选待办一次派出）、按标签设默认：先用单条按钮试用，有需要再加。

## 后果

- 好处：日常「把这件事交给 AI」变成 Today 里的一次点击；项目换 agent 只改一处。
- 代价：契约新增两个字段；dispatch 的缺省解析多两步，结果里多一个来源字段；Web 项目详情、任务详情、Today 和 CLI 都要显示继承来的目标。
- 风险：解析顺序变化后，有项目默认的老任务在不带 `to` 继续时会交给项目默认而不是上一轮的 agent（`answer` 例外）；派出提示写明来源以免意外。

## 修订记录
