# T1-0 任务结构与可开工状态

依据：[ADR 0039](../adr/0039-task-structure-and-readiness.md)（**Proposed，等人类批准后才能动 `packages/schema`**）。
必读：`docs/DESIGN.md`、`docs/design/work.md`、`web.md`、`security.md`。

## 目标

任务多了也能理清：一眼看出哪些能开工、哪些在等谁；在 Web 上编辑依赖、父任务和标签；agent 能按「可开工」查任务。
这是「以后只和 AI 聊天、由 AI 整理任务」的数据基础，本期**不做** AI 自动整理。

## 现状（实现前已具备，不要重做）

- 契约：`WorkTask` 已有 `project`、`parent`、`dependencies`、`tags`；create / update 已能设置它们。
- `packages/work`：依赖成环、父任务成环、重复依赖校验；前置未完成拒绝委派（`startRound`）与拒绝完成。
- 存储：`work_dependencies` 表；CLI `--project / --parent / --depends`。
- Web：任务详情只读显示依赖 ID 和父任务 ID、标签只读显示，项目可选。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| T1-1 | 契约：`WorkTask.blocked_by`（只读推导）、`WorkTaskDetail.dependents` / `children`、`WorkTaskListArgs` 的 `readiness` / `tag` / `parent`；能力说明文字 | Claude 起草，人类批准 | `packages/schema` |
| T1-2 | Work：推导 `blocked_by` / `dependents` / `children`；新筛选；已取消 / 已删除前置不阻塞（修复卡死）；错误信息带阻塞任务 | 后端（Codex） | `packages/work`、`packages/storage`、`apps/hub` |
| T1-3 | CLI 与 skill：`task list --ready/--blocked/--tag/--parent`，`task show` 显示前置、后续、子任务；SKILL.md 补充 | 后端（Codex） | `apps/cli`、`skills/lumio` |
| T1-4 | Web：被阻塞分组与标记、依赖 / 父任务 / 标签编辑、子任务区、按标签筛选 | 前端（Claude） | `packages/api-client`、`apps/web` |
| T1-5 | Web：项目依赖图视图（可选，T1-4 验收后再决定） | 前端（Claude） | `apps/web` |

T1-2、T1-3 依赖 T1-1；T1-4 依赖 T1-2；T1-5 依赖 T1-4。

## T1-1 契约要点

- `WorkTask.blocked_by: idOf("task")[]`，`.optional()`，说明写明「读取时推导，不存储，不可提交」。`WorkTaskPatch` / `WorkTaskCreate` 不加此字段（严格对象自然拒绝）。
- `WorkTaskDetail` 加 `dependents: idOf("task")[]`、`children: idOf("task")[]`。
- `WorkTaskListArgs` 加 `readiness: z.enum(["ready","blocked"]).optional()`、`tag: z.string().min(1).optional()`、`parent: idOf("task").optional()`。
- 更新 `work.task.list` / `work.task.show` 的中英文 summary；`bun run schema:export` 重新导出。
- 契约测试：带 `blocked_by` 的 create / patch 被拒绝；`WorkTask.parse` 接受有无 `blocked_by` 两种对象。

## T1-2 后端验收要点

- `blocked_by` = `dependencies` 中结局为 open 且不在回收站的任务，保持原顺序；在 Work 返回任务的**每一个出口**填入（列表、详情、命令结果、能力结果、Web 概览）。
  列表批量计算，不要每个任务单独查询。
- 存储写入前剔除 `blocked_by`；迁移、备份、导出不出现这个字段。
- `startRound` 与「标记完成」的前置检查改为用 `blocked_by` 判断：已取消、已删除、已彻底删除的前置**不阻塞**；
  `CONFLICT` 错误的参数里带上阻塞任务的 ID 与标题（新文案键，中英两张表同步）。
- 新筛选：`readiness=ready` 只返回结局 open 且不被阻塞的任务；`blocked` 只返回被阻塞的；`tag` 精确匹配；`parent` 返回直接子任务。可与现有 `project` / `query` 组合。
- `dependents` / `children` 不含回收站中的任务。
- 回归测试：前置 done → 解锁；前置 cancelled → 不阻塞；前置移入回收站 → 不阻塞，恢复后（仍为 open）重新阻塞；前置彻底删除 → 不阻塞，详情仍能读取。
- 不新增通知、不自动委派、不改 attention。

## T1-3 CLI 与 skill

- `lumio task list --ready`、`--blocked`、`--tag <t>`、`--parent <task>`；列表里被阻塞的任务显示「⛓ 等 N 个」（非终端输出用文字）。
- `lumio task show` 增加「前置」（标题 + 结局；已取消 / 已删除注明）、「后续」「子任务」三段。
- `skills/lumio/SKILL.md`：领任务前先 `task list --ready`；发现先后关系时用 `task update --depends` 提出（按现有提议规则），不要擅自改别人的任务结构。

## T1-4 Web 验收要点

- 任务列表：被阻塞的待办单独成组「等待前置」，排在「你的待办」之后；行上显示「等 N 个」小标，悬停列出前置标题。轮到 agent / 外部等其他分组不变。
- 筛选栏新增「标签」筛选（列出已有标签，可搜索）。
- 任务详情属性区：
  - **前置任务**：显示标题 + 结局图标，可点击跳转；可添加（搜索任务，排除自己）与移除；成环时显示 Hub 的错误说明；已取消 / 已删除的前置显示对应标记。
  - **父任务**：可选择或清空；
  - **标签**：可增删，输入时补全已有标签。
- 任务详情新增「后续任务」「子任务」区；子任务区可「新建子任务」（预填父任务与项目），显示完成进度 `x / y`。
- 「派出」按钮在被阻塞时禁用，提示「前置未完成：…」。
- 项目详情里任务列表同样体现被阻塞分组。

## T1-5 项目依赖图（可选）

- 项目详情加「依赖图」切换：按依赖分层自左向右排列未完成任务，箭头表示依赖，可开工的高亮，点节点打开任务。
- 只用现有 DOM / SVG 能力手写简单分层布局，不引入图形依赖；超过 50 个节点时提示改用列表。

## 不做

- AI 自动分类、自动建依赖、自动排期或解锁后自动委派（第二层，另起 ADR）。
- milestone / epic / 分类等新实体；跨项目的全局甘特图；依赖类型（如「开始-开始」）。
- 前置完成时的通知。
