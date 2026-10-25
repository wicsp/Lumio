# P2-5 例行任务

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0019（第 6 节）
- 涉及：`apps/hub`、`apps/runtime`、`packages/core`、`apps/cli`
- 契约：`entities.ts` 的 `Routine`、`job.ts` 的 `RoutineSpec`、`JobSource`（已批准，**不得修改**）
- 依赖：P2-4

## 目标
在 `plan/routines/` 写一篇例行任务笔记（要求 + `schedule`），到点由执行器自己执行，**Mac 合上也照常**；
每次的结果按日期追加在这篇笔记里。

## 范围
1. **Hub**：监听 `plan/routines/` 下的笔记；`status: active` 的例行任务按负责人选出执行器，生成 `RoutineSpec`
   （`revision` 为笔记内容的哈希，`template.run.prompt` 为固定说明 + 人写的部分；`context: previous` 时附上上一次的汇报摘要）
   放进该执行器的 `RuntimeSync.routines`。笔记改动或暂停后，下次同步替换或移除。
2. **执行器**：保存最新的计划；用 `schedule` + `timezone` 计算触发时间（自己实现 5 段 cron，或说明理由后引入依赖）；
   到点生成 Job：
   - **编号确定**：ULID 的时间部分取计划触发时间，随机部分取 `routine ID + 触发时间` 的哈希。重复生成得到同一编号。
   - `source`：`routine`、`round: 1`、`fired_at`；lease 用计划的 lease；**每次都是新会话**。
   - 执行器离线错过的触发：恢复后**只补跑最近错过的一次**，更早的记为跳过（写进下一次结果的说明里）。
3. **Hub 收到结果**：在例行任务笔记末尾追加区块 `<!-- lumio:ai start name=run-<日期时间> job=<job> -->`，
   标题 `### <日期> 的结果`；写回前的敏感信息检查同 P2-4。Hub 接受"计划 lease 一致、来自被指派执行器"的例行任务结果。
4. `lumio routine followup <例行任务> <日期>`：新建一个任务笔记（`plan/tasks/`），`routine` 字段指向来源，
   正文写明来源并附上那一次的汇报；负责人、执行配置与例行任务相同；`turn: human`，等人写下追问后再派出。
5. `lumio routine list [--json]`：名称、计划、下次触发时间、上次结果。

## 不做
- 不做"超过一年自动归档"；不做飞书通知（P3）。

## 验收标准
1. `bun run check` 通过。
2. 注入时钟的测试：
   - 到点触发一次；同一触发重复生成只有一个 Job；结果追加到笔记，顺序正确。
   - Hub 离线期间触发：执行器照常执行，Hub 恢复后补写结果。
   - 执行器离线错过三次：恢复后只补跑最近一次。
   - 改 `schedule` / `status: paused` 后，下次同步生效。
   - `context: previous` 时 prompt 中带上上一次的摘要，否则不带。
   - `followup` 生成的任务字段正确。
3. 人类手动验证：建一个每 10 分钟执行一次的例行任务，合上 Mac 半小时后打开，笔记里有补写的结果。
