# Work：数据库项目与任务

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。

## 数据库 Work（ADR 0025、0032）

- `/v2/work/commands` 使用 `WorkCommandRequest` 与 `WorkCommandResult`；Task/Project 查询返回严格业务对象，不含路径。
- **任务模型**（ADR 0032，R4-2）：任务只回答三个问题——结局（open / done / cancelled，只有人能改）、轮到谁（你 / 某个 agent / 外部 / 无人，附原因：todo、answer、review、failed、working、waiting、on_hold）、发生过什么（讨论、轮次、交接记录，只追加）。没有状态与负责人字段。「需要你处理」= 轮到你且原因是 answer、review 或 failed。一轮结束：提问 → answer，失败 → failed，取消 → todo，交付 → 没有交接计划时 review，有计划时进入下一步。每一轮的输入只放摘要与 ID，agent 用 skill 沿 ID 取回更多（Inline & Spill）。
- **交接计划**（ADR 0032 第 5 节，R4-3）：agent 步骤（可声明 `back_to`，汇报里单独一行 `<lumio-outcome>changes</lumio-outcome>` 时打回）与检查点；一轮交付后由 Hub 系统身份自动委派下一步，或在检查点 / 计划结束时轮到人（review）。只委派给计划写明的 agent；计划内轮数达到上限（缺省 8）时轮到人。检查点的继续 / 打回 / 完成 / 搁置只有人能做，对过时的步骤操作被拒绝。计划模板只有人能管理。agent 设置计划与委派都只能提议，人批准后以提议作者身份、按提议时的版本执行。
- **通知**（ADR 0031 第 4 节，R4-4）：Hub 内统一 `notify()`，在业务事务里写入待发事件并按事件 ID 去重；只在新出现「轮到人且原因为 answer / review / failed」与新的待批准提议时通知，每个事件最多发一次。先实现 Web Push：VAPID 私钥私密保存，JWT 一定带 https 的 `sub`（`LUMIO_PUBLIC_URL`，否则订阅页面的 Origin），TTL 24 小时；推送服务返回 404/410 时移除设备；推送地址与密钥不出现在响应、日志与审计中。
- **工作目录与目标**（ADR 0033，R4-8）：一轮的工作目录在委派时按「任务 → 项目 → `~`」确定，项目的 `repo` 只供参考并写进每轮输入；
  委派目标与计划里的 agent 在提交时校验，`execution.target.list` 列出可委派的目标。
  同一作者对同一任务的同类 Work 提议会取代它之前的待批准提议（`withdrawn` + `superseded_by`），作者也可以撤回自己的提议。
- Task/Project 描述在数据库中；依赖、讨论、执行关联各有明确归属。保存描述或计划不隐式委派。
- 更新带 `expected_revision`；请求用 `request_id` 去重。委派在同一事务内保存 Job、Work 关联和请求回执；同一任务默认只有一轮待完成。
- 运行结果作为 Work 进展追加一次，同时按结果交回给人，不自动把 Task 标成 done。旧 v1 委派接口拒绝操作数据库任务。
- 一轮里的提问与验收（ADR 0030、0032）：agent 用 `<lumio-question>` 提问并结束本轮；`/v2/work/attention` 只按 turn 选择轮到人且原因为 answer / review / failed 的任务。
  `work.task.hand to=human` 把原因改为 todo（我自己来）；旧的已查看命令与字段已删除。`work.task.dispatch` 可带 `comment`，回答与派出在同一事务。
- Work 的交接规则集中在 `packages/work`，每次变化追加 `TaskTurnChange`，一轮结果的自动交接使用 Hub 的稳定系统身份；完成或取消同时取消当前轮次，迟到结果不会抢回交接。
- 旧数据库任务在 Hub 启动时自动迁移到 v3，也可在停止 Hub 后运行 `lumio hub migrate task-v3`；先完整备份并验证数据库与托管文件，再原子切换，可重复运行。每个任务保留一条初始交接记录；规则见 ADR 0032 第 8 节。
- Work 委派与 Routine 修改的业务数据、请求回执和成功审计参加同一数据库事务；审计失败不交付半个委派。
- CLI 命令以 `lumio project --help`、`lumio task --help` 为准；`--legacy` 明确使用旧任务笔记。
  `edit` 打开带版本的外部编辑副本；用 `--file` 提交已有正文时必须带 `--revision`，冲突保留内容。
