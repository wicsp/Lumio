# H1-0 交接图、阶段权限与可选钩子

依据：[ADR 0049](../adr/0049-handoff-graph-stage-permissions-hooks.md)（Accepted，2026-11-10 人类批准方向）。
必读：`docs/DESIGN.md`、`docs/design/work.md`、`docs/design/execution.md`；做 Web 切片时加读 `docs/design/web.md`。

## 目标

让作者的开发方式完整跑在 Lumio 的交接计划里，而不是写在仓库规则里：
A 实现 → B 审核（可并行多个审核者）→ 部署到本机试用 → 检查点「试用通过？」→ 等 CI 后合并 → 自动完成。
谁做、何时交接、每一步的权限由 Lumio 管；怎么做由 agent 与仓库说明决定。

## 现状（不要重做）

- 交接计划（线性 agent 阶段 + 检查点、`back_to`、轮数上限、模板、提议与批准）已实现：`packages/schema/src/plan.ts`、`packages/work/src/index.ts`（`planTurn`、checkpoint 处理）、`apps/web/src/client/plan.ts`。
- 每一轮的固定说明：`apps/hub/src/messages.ts` 的 `modules.you_are_completing_round_of_a_user_task_work_only_in_the_working_dir`；任务快照与阶段说明由 `packages/work` 拼接。
- Codex 适配器固定 `--sandbox workspace-write`（`apps/runtime/src/agents.ts`）；Claude Code 为 `bypassPermissions`、隔离级别 `none`。
- 引擎检测（`apps/runtime/src/engines.ts`）与委派目标校验（`apps/hub/src/targets.ts`）已有。
- 项目默认执行者与 Today「委托」（ADR 0044，E1）已有。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| H1-1 | **不改契约，先做**：每一轮的固定说明补充 ADR 0049 第 1 节（只做本阶段；说明本轮已有的权限；缺权限时说明要什么、为什么并申请）；Runtime 未配置 root 助手时的拒绝信息改为说明「此执行器未配置高权限助手」与配置方法。中英文案同步 | 后端（Codex） | `apps/hub`、`apps/runtime`（文案） |
| H1-2 | 契约（PR 待批准）：ADR 0049 列出的全部新增字段与提议种类；旧计划无 `after` 时按线性读取；`schema:export` | Claude 起草，人类批准 | `packages/schema` |
| H1-3 | Work：交接图推进（汇合、并行写入限制、打回重置下游、并行中的提问与失败、`agents` 持有者）；`finish: auto`；`PlanRun` 迁移（`stage` → `active` / `done`）；项目 `default_plan`；保存模板提议的执行 | 后端（Codex） | `packages/work`、`packages/storage` |
| H1-4 | Runtime：按阶段权限启动 agent（先实测 Codex 放开 `.git` 的配置，结论写入 ADR 0049 修订记录）；`secrets` 只注入本阶段；`before` / `after` 钩子（argv、超时、环境变量、日志） | 后端（Codex） | `apps/runtime` |
| H1-5 | Hub：派出前检查（目标登记、引擎在线、权限能否满足，不满足时轮到人并写明缺什么）；`sandbox: none` 时的「无法强制」提示；人点「委托」时套用项目默认计划 | 后端（Codex） | `apps/hub` |
| H1-6 | CLI 与 skill：计划文件支持新字段；`project update --default-plan`；skill 说明 agent 可以提议保存模板 | 后端（Codex） | `apps/cli`、`skills/lumio` |
| H1-7 | Web：列表式交接图编辑器（同一行表示并行、内置角色预填、保存时校验与提示）；保存模板提议卡片带图形预览；项目详情设默认计划；批准页完整显示钩子与 `full` 权限 | 前端（Claude） | `packages/api-client`、`apps/web` |
| H1-9 | 按需申请权限：Runtime 提取 `<lumio-permission>`；Hub 生成申请卡片，批准时选范围（本轮 / 本任务该阶段），以新权限续接会话；macOS 的 root 助手安装（现在只支持 Linux） | 后端（Codex）；卡片 Web（Claude） | `apps/runtime`、`apps/hub`、`packages/work`、`apps/web`、`infra` |
| H1-8 | 把本仓库的开发流程存成计划模板并设为 Lumio 项目的默认计划，用一个小任务走通全程，记录问题 | 人类 + Claude | Lumio 实例数据，不改代码 |

依赖：H1-1 独立，可立即开始。H1-3～H1-6、H1-9 依赖 H1-2；H1-7 依赖 H1-3 与 H1-5；H1-8 依赖全部。

## 验收要点

- 不写 `after` 的旧计划与新建线性计划，行为与现在逐条一致（现有计划测试全部保留并通过）。
- 两个只读审核者并行：都交付才进入下一阶段；一个打回时等另一个结束，两份汇报都进入重跑的实现轮。
- 两个写入阶段被声明为并行时，保存被拒绝并说明原因。
- `finish: auto` 的计划没有检查点时保存被拒绝；有检查点时，人按「继续」后合并阶段成功即完成，失败轮到人（`failed`）。
- Codex 阶段：`read` 时写文件失败；`write` 时写 `.git` 失败；`write + git` 时能 fetch、提交、推送（含 worktree）；`full` 时不使用沙箱。
- `secrets` 只在声明它的阶段出现在 agent 环境里，不出现在提示、汇报和日志中。
- `before` 钩子失败不启动 agent；钩子超时按失败处理；钩子输出进入本轮日志。
- 目标执行器离线或缺少引擎时，不派出新一轮，任务轮到人并写明原因。
- Codex 在没有 `git` 权限的阶段以 `<lumio-permission>git</lumio-permission>` 结束一轮；人批准后续接同一会话，`git fetch` 成功；拒绝时带说明交回 agent。
