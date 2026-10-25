# P2-2 派活的可靠核心（只跑普通命令，不接 AI）

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0005（修订版）、0019（第 5、7 节）、0016（授权、审计）
- 涉及：`apps/runtime`、`apps/hub`、`packages/api-client`、`apps/cli`
- 契约：`job.ts` 的 `JobSpec`（`run.kind = "command"`）、`JobResult`、`Job`、`RuntimeSync`、`RuntimeAck`（已批准，**不得修改**）
- 依赖：P2-1

## 目标
从 Mac 上把一条命令交给服务器执行，并且**不丢、不重复、不乱**：Mac 合上、Hub 重启、执行器重启、网络时断时续，
结果都正确。用普通命令测，排除 AI 输出不确定带来的干扰。

## 用法
```
lumio job submit --runtime server [--workdir ~/x] [--timeout 30m] [--gpus 0,1] -- <程序> [参数…]
lumio job list [--status …] [--json]
lumio job show <job> [--json]
lumio job cancel <job>
```

## 范围

### apps/hub
1. `hub.sqlite` 新表 `jobs`：完整 `JobSpec`、状态、`assigned`、`last_seen`、结果。`lumio job show --json` 输出 `Job`。
2. `job submit`（human 允许，agent、runtime 拒绝；经 `authorize`，写审计）：生成 `job_<ULID>`、随机 lease（≥ 32 字节，base64url）、
   状态 `queued`。指定的执行器不存在时 400。
3. **指派**：执行器 `sync` 时，Hub 在 `RuntimeSync.jobs` 中返回派给它、尚未确认的 Job（含 lease）；执行器 `POST /v1/runtime/ack`
   （`RuntimeAck`）后状态变为 `assigned`。没有确认的会在下次 sync 时重发。
4. **回报**：`POST /v1/runtime/results`（`JobResult`）：
   - 只接受**被指派的执行器、lease 一致**的回报；否则 409，不改任何状态。
   - 同一个 Job 已有结果时，内容相同返回 200（幂等），内容不同返回 409。
   - 心跳 `RuntimeHeartbeat.running` 里的 Job 记为 `running` 并更新 `last_seen`。
5. **取消**：`queued` 直接变 `cancelled`；`assigned`/`running` 放进下次 `RuntimeSync.cancel`，等执行器回报 `cancelled`。
6. 执行器失联时，它名下的 Job **保持原状态**，不判失败、不转派；`lumio job show` 显示"执行器失联"。

### apps/runtime
7. **本地存储**（`<状态目录>/runtime.sqlite`）：队列（Job、本地状态、pid、开始时间）与"待交回"结果。
   **先写本地并提交事务，再 ack**。
8. **执行 command**：
   - `argv[0]` 必须在 `LUMIO_RUNTIME_ALLOWED_COMMANDS`（逗号分隔的绝对路径）中，否则结果为 `failed`，`error` 说明原因。
   - 不经过 shell；`cwd` 为 `workdir`（展开 `~`）；新建进程组；`gpus` 给出时设置 `CUDA_VISIBLE_DEVICES`。
   - stdout 与 stderr 写入 `<状态目录>/logs/<job>.log`，`JobResult.log` 为该路径；`report` 为 stdout 末尾最多 4000 字符。
   - 退出码 0 → `done`，否则 `failed`（记 `exit_code` / `signal`）。
   - **超时**：先向进程组发 SIGTERM，10 秒后仍在则 SIGKILL；结果 `failed`，`error` 为"超时"。
   - **取消**：同样杀掉整个进程组，结果 `cancelled`。
   - 同时执行的数量不超过 `MAX_CONCURRENT`，其余按收到顺序排队。
9. **交回结果**：写入"待交回"后立即尝试交回；Hub 返回 200 后才删除；网络错误按指数退避重试（最长 60 秒）；
   Hub 返回 409 时保留并在日志中报错（不会自动删除，等人处理）。
10. **重启恢复**：执行器启动时，本地标为执行中的 Job：若其进程组仍存在则杀掉；一律以 `unknown` 交回，`error` 说明"执行器重启"。
    未开始的 Job 照常排队执行。

### packages/api-client、apps/cli
11. 上述命令；`--json` 输出 `Job` 或 `Job[]`，用 schema 校验。

## 不做
- 不接 agent（P2-3）；不和任务笔记关联（P2-4）；不做例行任务（P2-5）。
- 不自动重试任何失败（ADR 0005 修订版）。

## 验收标准
1. `bun run check` 通过。
2. 端到端测试（临时 Hub + 临时执行器，允许列表中只有测试用的小程序）：
   - 正常完成：`done`，`report` 与日志内容正确，退出码正确。
   - **Hub 中途停掉再启动**：执行器继续执行，Hub 恢复后收到结果，状态正确。
   - **执行器在 ack 之前崩溃**：Hub 重发，Job 只执行一次。
   - **执行器在执行中崩溃并重启**：子进程组被杀掉（用一个会派生孙进程的测试程序证明），结果为 `unknown`。
   - **结果交回时网络中断**：恢复后重新交回，Hub 只记一次。
   - **错误的 lease、错误的执行器**交回结果：409，状态不变。
   - 超时：进程组（含孙进程）都被杀掉，结果 `failed`/"超时"；取消同理，结果 `cancelled`。
   - 不在允许列表中的程序：`failed`，没有任何进程被启动。
   - `MAX_CONCURRENT=1` 时两个 Job 依次执行。
3. 授权：agent、runtime 令牌不能 submit、cancel；审计里有每次 submit 与 cancel，记录身份 ID。
4. 人类在服务器上手动验证一次：`lumio job submit --runtime server -- /usr/bin/nvidia-smi`，Mac 合上几分钟后再打开，`lumio job show` 能看到结果。
