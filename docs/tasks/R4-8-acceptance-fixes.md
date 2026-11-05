# R4-8 验收反馈修复

- 依据：R4-7 人工验收（2026-11-05）的反馈；[ADR 0033](../adr/0033-project-workdir-proposal-withdrawal-targets.md)
- 前置：R4-1 至 R4-6 已合并；#93（执行页「需要处理」跟随当前轮到谁）已合并

## 切片

| 编号 | 内容 | 负责 | 涉及 | 依赖 |
|---|---|---|---|---|
| R4-8a ✅ #94 | 契约：项目 `workdir`、提议 `withdrawn` 与 `superseded_by`、撤回命令、`execution.target.list` 与 `ExecutionTarget` | Claude 起草，人类批准 | `packages/schema` | ADR 0033 |
| R4-8b | Hub 与 Work：工作目录继承、提议取代与撤回、目标查询与校验、每轮输入加 repo | 后端（Codex） | `packages/work`、`packages/storage`、`apps/hub`、`packages/api-client` | R4-8a |
| R4-8c | CLI 与 skill：`--help`、完整的参数文档、连接错误说明、`lumio targets`、撤回提议 | 后端（Codex） | `apps/cli`、`skills/lumio` | R4-8b |
| R4-8d | Web：项目页任务列表与新建、项目工作目录与任务的实际目录、实时刷新、底部「发表并继续」、已连接 agent 的三种命令、已撤回的提议 | Claude | `apps/web` | R4-8b |

## R4-8b Hub 与 Work（Codex）

- **契约（R4-8a 已批准，只做机械登记）**：能力目录加入 `execution.target.list`（read，参数 `ExecutionTargetListArgs`，结果 `ExecutionTarget[]`）与
  `approval.proposal.withdraw`（write，参数 `{ proposal }`，结果 `Proposal`；只能撤回自己的待批准提议）；重新导出 JSON Schema。不做其他契约改动。

- **工作目录**：委派（包括交接计划的自动委派）时按「任务 → 项目 → `~`」确定目录，再做现有的 vault 检查；Job 记录最终目录。
  项目 create / update 支持 `workdir`（patch 里 `null` 清空）。
- **每轮输入**：所属项目有 `repo` 时加一行 `Repository: <repo>`。
- **提议取代**：同一作者、同一任务、同类 Work 提议（dispatch 对 dispatch、plan.set 对 plan.set）提交新提议时，
  旧的待批准提议在同一事务里改为 `withdrawn` 并写 `superseded_by`；请求去重（同一 request_id）不触发取代。
- **撤回**：作者撤回自己待批准的提议；对非 pending 的提议返回 CONFLICT；撤回的提议不能再被决定。撤回与取代写审计、不发通知。
- **目标**：实现 `execution.target.list`；dispatch 的 `to` 与 plan.set 的每个 agent 步骤在提交时校验（人和 agent 都校验），
  不存在时 INVALID，说明里列出可用目标；离线允许，结果注明。
- **验收**：继承的三种情况（任务有、项目有、都没有）；改项目目录后新一轮用新目录、旧轮次不变；取代与撤回各自的状态与审计；
  错误目标在提议时被拒绝并列出候选；agent 不能撤回别人的提议。

## R4-8c CLI 与 skill（Codex）

- 所有命令和子命令支持 `--help`；带 `--json` 时输出结构化的用法，而不是参数错误。
- `lumio targets [--json]` 列出可委派的目标；`lumio proposals withdraw <id>`。
- `task new` / `task update` 的 `--workdir` 等参数、`task continue` 的完整参数写进 SKILL.md 的命令表（从能力目录与 CLI 定义生成，不手写）。
- skill 说明里写明：委派或设置计划之前先用 `lumio targets` 查目标；提议写错时直接再提一次（会自动取代），或撤回。
- 连不上 Hub 时说明连的是哪个地址、可能的原因（Hub 未运行、地址错误、运行环境限制网络），不再只报 INTERNAL。

## R4-8d Web（Claude）

- 项目页：按「轮到谁」分组列出该项目的任务；「在此项目新建任务」。
- 项目属性加「工作目录」；任务页的执行设置显示实际会用的目录，继承时注明「来自项目」。
- 实时刷新：重新获得焦点或回到前台时刷新；页面开着时收到推送，由 service worker 通知页面刷新；可见时当前页面约 15 秒静默刷新。
- 任务页只保留顶部一个委派按钮；底部输入框增加「发表并交给 X 继续」（评论与委派在同一事务）。
- 设置页「已连接的 agent」：Codex / Claude / pi 三个命令可切换。
- 审批与今日：已撤回的提议在历史里显示「已撤回」，并链接到取代它的提议。

## R4-8b / R4-8c 实现验收证据

两片在同一个后端 PR 中交付：能力目录登记后，CLI 的逐能力执行检查需要同时接上新命令。先实现 Hub/Work，再实现 CLI/skill；R4-8d 不在本 PR 范围内。

- R4-8b：`apps/hub/test/r4-8b.test.ts` 覆盖任务 / 项目 / `~` 的目录优先级、项目目录更新后的自动交接与旧 Job 不变、每轮 repo、清空项目目录与继承目录的 vault 检查。
- R4-8b：同文件覆盖两类提议各自取代、作者 / 任务 / 类型隔离、原 request_id 重放、撤回的状态与审计、撤回后不能决定、不能撤回他人的提议、撤回不新增通知、取代只产生新提议的通知、审计故障整体回滚和重启持久化。
- R4-8b：同文件覆盖人 / agent 查询目标，错误的委派与计划目标在提交时返回 INVALID 并列出候选；离线目标允许提交。离线说明通过 `X-Lumio-Offline-Targets` 响应头返回，也写入提议理由；CLI 在 stderr 提示。
- R4-8c：`apps/cli/test/r4-8c.test.ts` 遍历命令和命名空间的结构化帮助，检查 Hub / Runtime 路由也在执行前显示帮助；中英文本与 JSON 的断线说明都包含地址和三种可能原因。
- R4-8c：同文件检查 task new / update 的执行字段与 continue 的完整参数；skill 表由能力目录和 `apps/cli/src/command-definitions.ts` 生成，测试确保 Work 参数没有漏写，并包含先查 targets、错误提议直接重提或撤回的说明。
- 联动：`apps/cli/test/r3-access.test.ts` 逐能力执行 CLI 并校验结果契约；`packages/api-client/test/r4-8.test.ts` 检查新端点、输入输出契约、离线提示及连接错误的地址脱敏。
- 契约仅机械登记 `execution.target.list` 与 `approval.proposal.withdraw`，运行 `bun run schema:export` 重新生成（生成目录按现有规则不入库）。未新增依赖；测试只用 fixtures 和临时合成数据。
- 完整验证：`LUMIO_LANG=en bun run check` 与 `LUMIO_LANG=zh bun run check` 均通过（各 1117 pass / 3 skip / 0 fail）；另有中英文帮助分组专项回归。
