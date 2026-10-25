# P2-3 接上三个 agent：codex、claude、pi

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0019（第 3、7 节）、0005（适配器锁定版本）
- 涉及：`apps/runtime`、`apps/hub`、`apps/cli`
- 契约：`job.ts` 的 `AgentRun`、`JobResult`（`engine`、`question`、`session_id`、`git`）（已批准，**不得修改**）
- 依赖：P2-2

## 目标
把一段要求交给服务器上的某个 agent，用它的**非交互模式**执行，拿回汇报；能接着上一次的会话继续；
AI 有问题时这一轮以"等你回答"结束。

## 用法（测试与手动使用；任务笔记的接入在 P2-4）
```
lumio job submit --runtime server --agent codex|claude-code|pi [--model …] [--session <id> [--resume]] \
  --workdir ~/proj [--timeout 2h] "<要求>"
```

## 范围

### apps/runtime：适配器
1. **先验证再实现**：在服务器（以及人类的 Mac）上用 `--help` 与一次真实运行，确认下面每个参数在当前版本可用，
   结果写进 PR 描述。**尤其要确认 pi 的 `--session-id` 能否与 `-p` 一起用**；不能的话 pi 不支持接着会话继续
   （`session` 被忽略并在 `error` 里说明，而不是失败）。
2. 每个适配器提供：版本检测、**验证过的版本范围**（超出范围时这一轮直接 `failed`，不猜测输出格式）、
   隔离级别（`os` / `none`，如实声明）、把 `AgentRun` 翻译成 argv、从输出中取出最后的汇报与会话编号。
   参考（以第 1 条的验证结果为准）：
   | engine | 执行 | 接着会话 | 取汇报与会话编号 | 隔离 |
   |---|---|---|---|---|
   | codex | `codex exec --skip-git-repo-check --sandbox workspace-write [-m 模型] <要求>` | `codex exec resume <id> <要求>` | `--json` 事件或 `--output-last-message <文件>` | `os` |
   | claude-code | `claude -p <要求> --output-format json [--model 模型]` | `--session-id <uuid>`（新建）/ `--resume <id>` | JSON 结果中的 `result`、`session_id` | `none` |
   | pi | `pi -p <要求> [--model 模型]` | `--session-id <id>`（不存在则新建） | stdout 为汇报；会话编号即传入的 id | `none` |
3. 所有 agent：**stdin 接 `/dev/null`**；不经过 shell；`cwd` 为 `workdir`；新建进程组；超时与取消沿用 P2-2。
   完整的 stdout/stderr 照旧写入日志文件。
4. **提问约定**：Hub 组装的要求里会告诉 agent："需要人决定时，在最后的回复里用
   `<lumio-question>…</lumio-question>` 写出问题，然后结束。"适配器在最后的汇报里找到这个标记时，
   结果为 `waiting_for_human`，`question` 为标记内的文字，`report` 为去掉标记后的汇报。
   退出码为 0 且没有标记 → `done`；退出码非 0 → `failed`。
5. **git 状态**：`workdir` 是 git 仓库时，执行前后各记录一次 `branch`、`commit`、`dirty`（`git status --porcelain` 非空）。
6. `JobResult.engine` 记录实际的 agent、版本与隔离级别。

### apps/hub、apps/cli
7. `job submit` 支持 agent 类型（参数见用法）；`job show` 的人类可读输出显示 agent、版本、隔离级别、问题、git 前后提交。

## 不做
- 不组装任务上下文、不写回任务笔记（P2-4）。
- 不做跨设备工具、权限细分、模型路由（ADR 0019 第 7 节）。

## 验收标准
1. `bun run check` 通过。
2. 用**假的 agent 可执行文件**（测试脚本，模拟各自的参数与输出格式）测试：参数翻译、汇报与会话编号的提取、
   提问标记 → `waiting_for_human`、版本超出范围 → `failed` 且未执行、stdin 为空、git 前后状态、超时与取消。
3. 人类在服务器上对三个 agent 各手动运行一次（在一个临时 git 仓库里让它新建一个文件并提交），
   再用 `--resume` 追问一次，确认能接上上下文；在 PR 中记录结果。pi 若无法接上，记录原因。
