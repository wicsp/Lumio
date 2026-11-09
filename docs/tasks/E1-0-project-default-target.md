# E1-0 项目默认执行者与 Today「委托」

依据：[ADR 0044](../adr/0044-project-default-target.md)（Proposed，等人类批准后开工）。
必读：`docs/DESIGN.md`、`docs/design/work.md`、`docs/design/web.md`。

## 目标

给项目设一个默认执行者（如 `codex@macsp`），项目下任务自动继承；Today 的待办卡片上点「委托」就用它开工。

## 现状（不要重做）

- `work.task.dispatch` 的 `to` 可省略，省略时沿用最近一轮的 agent，没有历史则报错（`index.specify_an_agent_assignee_e_g_pi_server`）。
- 委派目标的提交时校验与 `execution.target.list` 已有（ADR 0033，R4-8）。
- workdir 的「任务 → 项目 → `~`」委派时解析，可作为本次的参照实现。
- Today（`apps/web/src/client/panes/overview.ts`）已加载任务与项目；提问 / 验收 / 失败卡片在 `attention-card.ts`，已有目标选择菜单（`engineTargets`）。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| E1-1 | 契约：`WorkProject.default_target`、`WorkTask.target`（含 create / update）；dispatch 结果增加 `target` 与 `target_source`；能力说明文字；`schema:export` | Claude 起草，人类批准 | `packages/schema` |
| E1-2 | Work / Hub：存储两个字段；提交时校验目标；按 ADR 0044 第 2 节解析缺省 `to`；结果带来源；新错误文案（中英） | 后端（Codex） | `packages/work`、`packages/storage`、`apps/hub` |
| E1-3 | CLI 与 skill：`project create/update --default-target`、`task create/update --target`（`--target ""` 清除）；`task show` 显示生效目标与来源；`task dispatch` 不带 `--to` 时打印实际目标 | 后端（Codex） | `apps/cli`、`skills/lumio` |
| E1-4 | Web：项目详情编辑默认执行者；任务详情显示「继承自项目」并可覆盖；Today 待办「委托」按钮与换目标小箭头 | 前端（Claude） | `packages/api-client`、`apps/web` |

E1-2、E1-3 依赖 E1-1；E1-4 依赖 E1-2。

## E1-2 验收要点

- 解析顺序（每条都要有测试）：显式 `to` > 计划步骤 > `answer` 时沿用提问那一轮 > 任务 `target` > 项目 `default_target` > 最近一轮 > INVALID。
- 改项目默认后，未设 `target` 的任务下一次委派用新值；已派出的 Job 不变。
- 默认目标指向已不存在的执行器 / 引擎：委派返回 INVALID，说明里写出来源（「项目默认 codex@old」）和可用目标；离线允许派出并注明。
- 被阻塞任务仍拒绝；agent 不带 `to` 委派仍走提议与批准。
- 删除项目后任务变为无项目，`target` 保留，继承失效（回退到最近一轮）。

## E1-4 界面要点

- 按钮只出现在待办组（轮到你 + todo + open）且能解析出目标的条目上；提示「委托给 codex@macsp（项目默认）」。
- 一次点击派出，带 `expected_revision` 与 `request_id`；成功后条目离开待办，toast 带「查看运行」；冲突时刷新并提示。
- 小箭头打开目标菜单，只影响这一次派出（作为显式 `to` 提交），不改任务字段。
- 被阻塞时按钮禁用并在提示里列出缺的前置（复用 T1-4 的文案）。
- 窄屏下按钮收为图标，不挤掉标题。
