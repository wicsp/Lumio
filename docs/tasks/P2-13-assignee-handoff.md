# P2-13 负责人写成一行并作为交接开关；`workdir` 缺省为 `~`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0024**（先读）、0019、0023、0008
- 涉及：`packages/schema`（契约变更，ADR 0024 批准后）、`packages/core`、`apps/hub`、`apps/cli`、`skills/lumio`
- 契约：改（`Assignee`、`Task`、`Routine`）
- 依赖：P2-12

## 范围

### 1. 契约（`packages/schema`）
- `Assignee`：`human` | `<agent>` | `<agent>@<RuntimeName>`；旧的 `{agent, device}` 对象仍然接受。例行任务的负责人同理但不能是 `human`。
- 导出 `parseAssignee(value)`：返回 `"human"` 或 `{ agent, device? }`；不合法时返回带说明的错误（说明里给出例子 `pi@server`）。
- `Task`：删除 `turn`（旧值作为未知字段保留）；`workdir` 改为可选。`Routine.workdir` 改为可选。
- 契约测试：三种字符串形式、旧对象形式、非法值（`pi@`、`@server`、`gpt@server`、`Pi@server`）；例行任务拒绝 `human`。
- `bun run schema:export` 重新导出 JSON Schema。

### 2. 补全（`packages/core`）
- 读取负责人一律用 `parseAssignee`。
- 任务缺 `assignee`（含空值）时写上 `human`；不再写 `turn`。例行任务的 `status` 规则不变（ADR 0023）。

### 3. Hub（`apps/hub`）
- **本机执行器**：`setup` 时把本机执行器的名称记进 Hub 配置（已安装的 Hub 升级后，找不到记录时用 setup 的同一规则推出名称并写回配置）。
  `assignee` 没写 `@` 时用它；它不存在或未登记时拒绝：`这台 Hub 没有本机执行器，请写 pi@<执行器名称>`。`pickRuntime` 不再"自动挑一个在线的"。
- **触发**：监听到任务的 `assignee` 由 `human`（或缺失）变成某个 agent → 记下时间；笔记安静 30 秒后，若仍是这个 agent 且没有执行中的轮次 → `task.dispatch`（trigger `assignee`）。
  30 秒内改回 `human` → 不派。去重规则同 P2-4。
- **写回**：一轮结束时把 `assignee` 写成 `human`（替代原来的 `turn: human`）；其余 frontmatter 不变，正文区块以外逐字节不变。
- **执行中人改了 `assignee`**：不派、不取消，记入 `hub status` 的问题列表；写回时照常改成 `human`。
- **会话续接**：这一轮的 agent 与执行器都和上一轮相同且会话可接上时只发新增部分；否则发"人写的部分 + 最近一轮汇报"（P2-4 已有的两种 prompt）。
- `workdir` 缺失时 Job 的工作目录为 `~`；"不能在笔记库里"的检查不变，不新增"不能包含笔记库"的检查。
- 例行任务的执行器选择同上。`routine.followup` 开出的任务照抄执行配置，`assignee` 写 `human`（相当于原来的 `turn: human`）；人要交给 agent 时自己改 `assignee`。

### 4. CLI（`apps/cli`）
- `lumio task continue <任务> [--to <负责人>]`：把 `assignee` 写成指定的 agent（缺省用最近一轮的 agent 与执行器）并立即派出；`--to human` 拒绝。
- `lumio task list` 显示每个任务的负责人与"执行中 / 等待派出 / 无"。
- `lumio check`：负责人是旧对象写法时提示可以改成字符串写法；笔记里还有 `turn` 字段时提示可以删掉。都不算错误。
- `lumio selftest` 写出的自检笔记用新写法。

### 5. 文档与 skill
- `skills/lumio/SKILL.md` 与 `docs/` 里的示例改成新写法，删除 `turn` 与"必须写 workdir"的说法。
- DESIGN.md 已在 ADR 0024 的 PR 里同步；实现完成时 ADR 0024 标为 `Implemented`，`docs/tasks/README.md` 中 P2-13 标 ✅。

## 不做
- 不自动改写已有笔记里的旧对象写法和 `turn`。
- 不做 agent 之间的自动接力。
- 不在 frontmatter 里记录上一轮的结果。

## 验收标准
1. `bun run check` 通过。
2. 新任务只写正文，补全后出现 `assignee: human`；改成 `pi@server` 安静 30 秒后派到服务器，Job 的工作目录是服务器上的 `~`；结束后 `assignee` 回到 `human`。
3. 改成 `pi`（不写 `@`）派到 Hub 本机执行器；本机没有执行器时错误说明如上。
4. 交接：第 1 轮 `pi@server` 结束后改成 `codex`，第 2 轮由本机 codex 新开会话，prompt 含人写的部分与第 1 轮汇报；再改成 `codex` 时第 3 轮接上第 2 轮的会话。
5. 执行中把 `assignee` 改成别的值：不派出新轮、这一轮不取消，`hub status` 出现问题记录，写回后为 `human`。
6. 旧对象写法与带 `turn` 的旧笔记照常可用；`lumio check` 给出两种提示。
7. 例行任务写 `assignee: pi@server`、不写 `workdir` 时照常触发。
