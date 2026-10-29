# P2-13 负责人写成一行、默认工作目录、上一轮结果

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0024**（先读）、0019、0009、0008
- 涉及：`packages/schema`（契约变更，已经人类批准）、`packages/core`、`apps/hub`、`apps/cli`、`skills/lumio`
- 契约：改（`Assignee`、`Task.workdir`、`Routine.workdir`、新增 `Task.last_round`）
- 依赖：P2-12

## 范围

### 1. 契约（`packages/schema`）
- `Assignee` 增加字符串形式：`human` | `<agent>` | `<agent>@<RuntimeName>`；旧的 `{agent, device}` 对象仍然接受。
  例行任务的负责人同理，但不能是 `human`。
- 导出 `parseAssignee(value)`：返回 `"human"` 或 `{ agent, device? }`；不合法时返回带说明的错误（说明里给出正确写法的例子 `pi@server`）。
- `Task.workdir`、`Routine.workdir` 改为可选。
- `Task` 新增 `last_round: optional(enum(["done", "question", "failed", "unknown", "cancelled"]))`，标注为程序字段。
- 契约测试：三种字符串形式、旧对象形式、非法值（`pi@`、`@server`、`gpt@server`、`Pi@server`）；例行任务拒绝 `human`。
- `bun run schema:export` 重新导出 JSON Schema。

### 2. 读取负责人的地方一律用 `parseAssignee`
- `packages/core/src/fill.ts`：判断"负责人是 agent"时用它（字符串和旧对象都要写 `turn: human`）。
- `apps/hub/src/tasks.ts`、`apps/hub/src/routines.ts`：选执行器、组 Job 时用它。
- Hub 写出的负责人（`routine.followup` 开出的任务、自检笔记）一律写字符串形式。
- `lumio check`：负责人是旧对象写法时提示"可以改成 `pi@server` 这种写法"，不算错误、不影响退出码。

### 3. 默认工作目录
- 任务与例行任务没有 `workdir` 时，Job 的工作目录为 `~`（由执行器展开为它自己的主目录）。不把默认值写回笔记。
- 把 `workdirInVault` 改成"工作目录在笔记库里，**或包含笔记库**"都拒绝（只在 Hub 与执行器同一台机器时检查，判断方式同现在）。
  拒绝时的说明：`工作目录不能包含笔记库（agent 可以改工作目录下的文件）。在这台机器上派活请在任务里写 workdir，例如 workdir: ~/Projects/xxx`。
- 例行任务同样适用。

### 4. 写回 `last_round`
- 写回一轮结果时，与 `turn: human` 在同一次写入里写 `last_round`，取值与区块标题对应：
  完成 → `done`，有问题等你回答 → `question`，失败 → `failed`，情况不明（含执行器重启时标为 unknown 的）→ `unknown`，已取消 → `cancelled`。
- 其余 frontmatter 字段与写法不变；正文区块以外逐字节不变（P2-4 的规则）。

### 5. 文档与 skill
- `skills/lumio/SKILL.md` 与 `docs/` 里的任务、例行任务示例改成字符串写法，去掉"必须写 workdir"的说法。
- ADR 0024 按 ADR 0013 标为 `Implemented`；`docs/tasks/README.md` 中 P2-13 标 ✅。

## 不做
- 不自动把已有笔记里的旧对象写法改成字符串。
- 不给执行器加"默认工作目录"配置项。
- 不改 `turn`、`status` 的含义和谁能改它们。

## 验收标准
1. `bun run check` 通过。
2. 新任务只写 `assignee: pi@server` 和正文，`turn` 改成 `agent` 后能派出；Job 的 workdir 为执行器上的 `~`。
3. 同一任务写 `assignee: pi` 能按现行规则挑执行器；旧对象写法的任务照常派出，`lumio check` 给出提示。
4. Hub 与执行器同机、任务没写 `workdir` 时拒绝，错误说明如上；写了不在笔记库里的目录时正常派出。
5. 每种结果写回后 `last_round` 取值正确，`turn` 为 `human`；写回前后除 `turn`、`last_round`、`status`（第一次派出时）外的 frontmatter 不变。
6. `routine.followup` 开出的任务负责人是字符串形式。
