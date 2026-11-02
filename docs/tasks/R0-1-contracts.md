# R0-1 契约：v2 业务对象、存储格式与兼容矩阵

- 状态：契约已编写并测试（2026-10-31）；按 ADR 0025 修订记录中的人类授权实施。调用方实现由后续切片完成。
- 范围：只改 `packages/schema/`（`src/common.ts`、新增 `src/work.ts`、`src/execution.ts`、`src/assistant.ts`、`src/storage.ts`、`src/index.ts`，新增测试）。
- 依据：ADR 0025 第 1、3、4、5、6、7、8 节；R0-0 的 R0-1 切片。
- 没有新增依赖；`job.ts`、`operation.ts`、`api.ts`、`query.ts`、`entities.ts` 未修改。

## 通用规则

- 新对象全部是 `z.strictObject`：未知字段拒绝。可选字段用"缺失"表示未填，**不接受 `null`**。只有 patch 中标明的字段用 `null` 表示清空。
- 时间：`Timestamp`（ISO 8601，必须带时区）。`revision`：`Revision`，正整数，每次修改加一。
- 引用一律用 ID，不用路径或标题。v2 Work/Execution 对象没有 `path`，不会以 `NoteRef` 返回。
- `request_id`：`RequestId`，16–128 个 `[A-Za-z0-9._:-]` 字符；同一 `request_id` 重放不重复执行。
  （比提议的"非空 16–128 字符"更保守：限制字符集，便于作为日志与数据库键。）
- 每个 v2 schema 都有同名 `z.infer` type。

### 新增 ID 前缀（`ID_PREFIXES`）

| 键 | 前缀 | 用途 |
|---|---|---|
| `work_comment` | `wmsg` | WorkComment |
| `conversation` | `conv` | AssistantConversation |
| `assistant_message` | `amsg` | AssistantMessage |
| `assistant_turn` | `turn` | AssistantTurn |
| `tool_call` | `tool` | AssistantToolCall |
| `memory` | `mem` | AssistantMemory |
| `log_event` | `evt` | RunLogEvent |
| `artifact` | `art` | StoredArtifact |
| `migration` | `mig` | MigrationPlan |

`Id` 接受所有前缀，`idOf(p)` 只接受指定前缀；`ID_PREFIXES` 只在 `common.ts` 定义一次。

### 新增公共辅助（`common.ts`）

| 导出 | 定义 |
|---|---|
| `AgentTarget` | 字符串 `claude-code|codex|pi`，可带 `@<RuntimeName>`；不接受对象 |
| `TaskAssignee` | `"human"` 或 `AgentTarget` |
| `Revision` | 正整数 |
| `RequestId` | 见上 |
| `SafeRelativePath`、`isSafeRelativePath` | 非空；不以 `/` 开头；无 `..`、`.`、空段；无反斜杠、NUL、URL scheme |
| `Sha256` | 64 位**小写**十六进制 |

旧的 `AgentAssignee`、`Assignee`、`parseAssignee` 不变，继续用于 v1 笔记解码。`entities.ts` 内部的 `isSafeRelativePath` 保持原样（`MediaRef` 行为不变）。

## Work（`work.ts`）

`Module = knowledge | work | execution | assistant`。

**ResourceRef** `{ module, id: Id, revision?: string, label?: string }`
附加约束：`id` 前缀必须属于该模块（`MODULE_ID_PREFIXES`）：
knowledge = pap/idea/src/exp/post/ast/rpt；work = prj/task/wmsg；execution = job/rtn/evt/art；assistant = conv/amsg/turn/tool/mem。

**WorkProject** `{ schema_version: 2, type: "project", id: prj, title(非空), description: string, revision, status: planning|active|paused|done, created, updated, tags: string[], goal?, repo?, deadline?: Timestamp }`

**WorkTask** `{ schema_version: 2, type: "task", id: task, title(非空), description: string, revision, status: todo|active|waiting|paused|done|cancelled, assignee: TaskAssignee, created, updated, tags, project?: prj, parent?: task, dependencies: task[], references: ResourceRef[], due?, workdir?, model?, gpus?: 非负整数[], timeout_minutes?: 正整数 }`
- 输出时 `assignee`、`dependencies`、`references` 总是存在（没有 schema 默认值；新建缺省由应用填 `human`/`[]`）。
- schema 只检查单对象内能判断的事：`parent ≠ id`、`dependencies` 不含自己、不重复。环、跨对象存在性由 Work 判断。
- 负责人不是执行开关；改 `assignee` 不派活。

**WorkComment** `{ id: wmsg, task, author: act, body(非空), created }`

**WorkExecution** `{ task, job, round: 正整数, input_revision: Revision, input_snapshot: string, created, applied: boolean }`
Job 的运行状态由 Execution 解释；Job `done` 不代表 Task `done`。

**WorkTaskDetail** `{ task: WorkTask, comments: WorkComment[], executions: WorkExecution[] }`

### 命令

`WorkCommandRequest { request_id: RequestId, operation: WorkCommand }`，`WorkCommand` 按 `op` 区分（`WORK_COMMAND_NAMES`）：

| op | args |
|---|---|
| `work.project.create` | `{ title, description?, tags?, goal?, repo?, deadline? }` |
| `work.project.update` | `{ project, expected_revision, patch: WorkProjectPatch }` |
| `work.task.create` | `{ title, description?, status?, assignee?: TaskAssignee, project?, parent?, dependencies?, references?, tags?, due?, workdir?, model?, gpus?, timeout_minutes? }` |
| `work.task.update` | `{ task, expected_revision, patch: WorkTaskPatch }` |
| `work.task.comment` | `{ task, body }` |
| `work.task.dispatch` | `{ task, to?: AgentTarget, expected_revision?: Revision }` |

- create 的缺省值（`description: ""`、`tags: []`、`status: todo`、`assignee: human`、`dependencies/references: []`）**由应用填写**，schema 不做 default，输入与输出类型一致。
- **patch**：至少一个字段；严格对象，因此 `id`/`schema_version`/`type`/`revision`/`created`/`updated` 直接拒绝。
  - WorkProjectPatch：`title, description, status, tags, goal|null, repo|null, deadline|null`。
  - WorkTaskPatch：`title, description, status, assignee, tags, project|null, parent|null, dependencies, references, due|null, workdir|null, model|null, gpus|null, timeout_minutes|null`；数组整体替换。
  - 必填字段（title/status/assignee/tags 等）不接受 `null`。
  - **保守选择**：`description` 只能单独出现在 patch 中（ADR 0025 第 4 节“描述与结构化字段分别编辑”），与其他字段混合时拒绝。
- `expected_revision` 与当前不一致时 Hub 应返回 `CONFLICT`（`ApiError` 原有代码）。dispatch 的 `to` 缺省用任务负责人；负责人是 `human` 且未给 `to` 时应拒绝（由 Work/Hub 实现）。
- 结果 `WorkCommandResult` 按 `kind`：`{kind:"project",project}`｜`{kind:"task",task}`｜`{kind:"comment",comment}`｜`{kind:"job",job: Job}`（完整 v1 `Job` 记录，协议 2）。

## Execution（`execution.ts`）

**ExecutionRoutine** `{ schema_version: 2, id: rtn, title, description: string, revision, status: active|paused, schedule: 5 段 cron(CRON_PATTERN), timezone: 非空, assignee: AgentTarget, context: none|previous, created, updated, workdir?, model?, gpus?, timeout_minutes? }`
存储后 `timezone`、`context` 总是有值。v1 `Routine.project` 没有带入（Routine 归 Execution，不拥有 Work 关联）；迁移时如有需要放到协调流程处理并在 dry-run 中列出。

**ExecutionRoutineInfo** `{ routine: ExecutionRoutine, runtime?: RuntimeName, next?: Timestamp, last?: { job, status: JobStatus, fired_at }, problem?: string }`

**ExecutionRoutineCommandRequest** `{ request_id, operation }`：
- `execution.routine.create` args `{ title, description?, status?, schedule, timezone?, assignee: AgentTarget, context?, workdir?, model?, gpus?, timeout_minutes? }`；`timezone` 缺省由应用填 Hub 时区，`status` 缺省 active，`context` 缺省 none。
- `execution.routine.update` args `{ routine, expected_revision, patch: ExecutionRoutinePatch }`；patch 字段 `title, description, status, schedule, timezone, assignee, context, workdir|null, model|null, gpus|null, timeout_minutes|null`，非空，服务器字段拒绝。

Hub ↔ Runtime 仍用 `job.ts`（`RoutineSpec.revision` 是字符串，Hub 用 `String(routine.revision)` 填写即可，不需改协议）。

## Assistant（`assistant.ts`）

- **AssistantConversation** `{ id: conv, title, owner: act, created, updated, revision }`
- **AssistantMessage** `{ id: amsg, conversation, role: user|assistant|tool, content, created, turn?, tool_call?: tool }`；`role=tool` ⇔ 有 `tool_call`。
  system 提示不保存为消息（`MessageRole` 不含 system）。
- **AssistantTurn** `{ id: turn, conversation, request_id: RequestId, status: running|done|failed|unknown|cancelled, created, finished?, error? }`
- **AssistantToolCall** `{ id: tool, turn, name, args: record, status: prepared|running|succeeded|failed|unknown, result?: unknown, error?, created, finished? }`
  恢复时 `prepared/running/unknown` 先核查，不直接重放。
- **AssistantMemory** `{ id: mem, owner: act, content(非空), sources: ResourceRef[], private: boolean, revision, created, updated }`
- **AssistantChatRequest** `{ request_id, conversation?: conv, message(非空), model? }`
- **AssistantConversationDetail** `{ conversation, messages, turns }`；**AssistantChatResult** `{ conversation, turn, messages(本轮新增) }`
- 模型接口（不绑定供应商）：
  - `AssistantModelMessage { role: system|user|assistant|tool, content, tool_call_id?, tool_calls?: [{id,name,args}] }`
  - `AssistantModelRequest { model?, messages(至少 1 条), tools: AssistantToolSpec[] }`，`AssistantToolSpec { name, description, input_schema: record }`
  - `AssistantModelResponse { content, tool_calls: [{id,name,args}] }`
- **AssistantEvent**（按 `type`，都带 `turn`）：
  `token {delta}`｜`tool {tool: AssistantToolCall}`（状态变化时整条发送）｜`result {messages}`｜`error {error}`。
  以后 Hub 流式响应建议每行一个事件（NDJSON 或 SSE `data:`），以 `result` 或 `error` 结束；最终状态以数据库为准。

助手权限不在本契约中放宽；记忆 `private: true` 按知识私密规则处理。

## 存储格式（`storage.ts`）

- **RunLogEvent** `{ schema_version: 1, id: evt, run: Id, sequence: 正整数, time, type: 非空, payload: record }`；同一 `run` 内 sequence 从 1 连续递增。
- **StoredArtifact** `{ id: art, owner: ResourceRef, key: SafeRelativePath, sha256, size: 非负整数, media_type, status: staged|ready, private, created }`
- **BackupManifest** `{ schema_version: 1, created, database: {path, sha256, size}, files: [{path, sha256, size}] }`，路径相对备份目录。
- **MigrationEntry** `{ id: Id, type: project|task|routine, path: SafeRelativePath, sha256, title }`；`id` 前缀必须与 `type` 对应（prj/task/rtn）。
- **MigrationPlan** `{ schema_version: 1, id: mig, created, source_hash, entries, problems: 非空字符串[] }`；`problems` 非空时不能 apply。

## JSON 导出（`CONTRACTS` 新增键）

`resource-ref`、`work-project`、`work-task`、`work-comment`、`work-execution`、`work-task-detail`、`work-command-request`、`work-command-result`、
`execution-routine`、`execution-routine-info`、`execution-routine-command-request`、
`assistant-conversation`、`assistant-message`、`assistant-turn`、`assistant-tool-call`、`assistant-memory`、`assistant-chat-request`、
`assistant-conversation-detail`、`assistant-chat-result`、`assistant-model-request`、`assistant-model-response`、`assistant-event`、
`run-log-event`、`stored-artifact`、`backup-manifest`、`migration-plan`。原有键不变。

## 兼容矩阵

| 对象 / 接口 | v1（现有） | v2（新增） | 说明 |
|---|---|---|---|
| 任务/项目/例行笔记 | `Task`/`Project`/`Routine`（loose，`schema_version: 1`，null=未填，旧对象负责人可读） | 只用于旧笔记解码与迁移 dry-run | 不变 |
| Work 对象 | — | `WorkProject`/`WorkTask`（strict，`schema_version: 2`，无 path） | 不以 NoteRef 表达 |
| Routine | `Routine` 笔记 + `RoutineInfo{routine: NoteRef}` | `ExecutionRoutine` + `ExecutionRoutineInfo{routine: 对象}` | v1 `RoutineInfo` 不变，不能装 v2 对象 |
| 写操作 | `OperationRequest`/`Operation`（`task.dispatch`、`routine.followup`、`exec.privileged`）→ `OperationResult{note?: NoteRef}` | `WorkCommandRequest` → `WorkCommandResult`；`ExecutionRoutineCommandRequest` | 名称不重叠（`work.*`/`execution.*`）；v1 `OperationResult` 不接受新字段 |
| 负责人 | 字符串或 `{agent, device}` | 只有字符串 | 对象写法只用于解码 |
| 查询 | `SearchResult`/`NoteDetail`/`LinksResult`（NoteRef） | Knowledge 查询沿用；Work/Execution 用上面的对象 | 新对象不进 v1 搜索结果 |
| 错误 | `ApiError` | 同一个 `ApiError`（版本冲突用 `CONFLICT`） | 不变 |
| Hub ↔ Runtime | `JobSpec`/`JobResult`/`RuntimeSync` 等，`protocol_version: 2` | 不变 | 无需兼容窗口 |
| 日志/文件/备份/迁移 | — | 各自 `schema_version: 1` | 新格式 |

### 对后续实现的约定（schema 不强制）

- v2 HTTP 路径建议放在 `/v2/...`（如 `/v2/work/commands`、`/v2/work/tasks/:id`）；v1 路径与响应保持原格式。
- 已切换为数据库权威的 Task/Project/Routine：v1 `task.dispatch`/`routine.followup` 对它们应返回 `CONFLICT`（或 `INVALID`）并说明改用 v2，不得伪造笔记路径。
- 版本不兼容（`schema_version`、`protocol_version` 不符）一律校验失败返回 `INVALID`，不猜测转换。

## 冲突与保守选择

1. `RequestId` 限制字符集（见上）。
2. `description` 必须单独 patch。
3. create 不在 schema 中设 default，缺省由应用填，避免导出的输入/输出 JSON Schema 不一致。
4. `ResourceRef` 校验 id 前缀与模块一致；`MigrationEntry` 校验 id 前缀与 type 一致。
5. `AssistantMessage` 存储角色不含 `system`；模型请求才有 system。
6. `ExecutionRoutine` 不带 v1 的 `project` 字段。
7. `Sha256` 只接受小写。

## 验证

- `bun test packages/schema/test`：8 个文件全部通过（新增 `v2-contracts.test.ts`、`r0-1-compat.test.ts`）。
- `bun run typecheck`：通过。
- `bun run schema:export`：生成全部 JSON Schema（`packages/schema/json/`，生成物不入库）。
- 测试只用合成数据，未读取 vault、`~/.config/lumio` 或已安装服务。
