# R3-0 能力目录与 agent 访问；一轮里的提问与验收

- 依据：[ADR 0029](../adr/0029-capabilities-and-agent-access.md)、[ADR 0030](../adr/0030-round-questions-and-review.md)（均 Accepted，2026-11-04），以及 ADR 0014、0016、0019、0025、0027
- 契约：新增（R3-1 起草，人类审阅后合并）
- 前置：R2-2 合并（R3-2、R3-3 与 R2-2 都改 `apps/cli`、`apps/hub`，按顺序做避免冲突）

## 切片

| 编号 | 内容 | 负责 | 涉及 | 依赖 |
|---|---|---|---|---|
| R3-1 ✅ | 契约：能力目录、助手配置接口、一轮访问凭据、执行者显示；提问与验收（ADR 0030） | Claude 起草，人类批准 | `packages/schema` | — |
| R3-2 | Hub：agent 权限规则、能力执行层、内置助手接上工具（含私密读取与撤回）、助手配置接口与热加载；需要你处理、回答并继续、已查看 | 后端（Codex） | `apps/hub`、`packages/assistant`、`packages/work`、`packages/execution`、`packages/knowledge`、`apps/cli`（setup 改用同一实现） | R3-1、R2-2 |
| R3-3 | 外部 agent：每轮访问凭据、`lumio agent`、`lumio skill install`、由目录生成 SKILL.md 与 CLI 覆盖测试 | 后端（Codex） | `apps/hub`、`apps/runtime`、`apps/cli`、`packages/execution`、`skills/lumio` | R3-2 |
| R3-4 | Web：设置页「助手模型」「已连接的 agent」；对话里的工具调用与变更卡片（撤回）；任务里显示执行者；回答框、验收卡片、需要你处理 | Claude | `apps/web` | R3-2（模型配置部分只依赖 R3-1 与 R3-2 的接口） |
| R3-5 | 验收（见文末） | 人类 + Claude | — | R3-1 至 R3-4 |

## R3-1 契约（Claude）✅

已在 `packages/schema` 落地（`capabilities.ts`、`access.ts`，以及 `assistant.ts`、`job.ts`、`work.ts` 的增量字段）：

- **能力目录** `CAPABILITIES`：17 项，每项有 `name`、`kind`（read / write）、`summary`（en / zh）、`args`、`result`。
  - 读：`knowledge.note.search|show|links`、`work.task.list|show`、`work.project.list|show`、`execution.job.list|show`、`execution.routine.list`、`approval.proposal.list`、`work.attention.list`（ADR 0030）。
  - 写：`work.task.create|update|comment`、`work.project.create|update`。参数就是对应 Work 命令的 `args`，结果是 `WorkCommandResult`；`request_id` 由调用方生成。
  - 工具名：`toolName()` 把点换成 `__`（兼容接口的函数名不允许点），`capabilityFromTool()` 反查。
  - `AGENT_SETTABLE_TASK_STATUSES`：agent 能设置的任务状态（todo、active、waiting、paused）。
- **变更记录** `CapabilityChange`，挂在 `AssistantToolCall.change`；`AssistantToolCall` 还增加 `capability`、`private_read`。
- **模型配置** `AssistantConfigView`（不含密钥，带 `managed`）、`AssistantConfigUpdate`（地址规则、`api_key` 只写、`clear_api_key`、`check`），
  验证失败用 ApiError `INVALID`，reason 为 `assistant-config-{address|auth|model|response|timeout}`。
- **每轮凭据** `JobAccess`，放在 `RuntimeSync.access`。只在执行器的同步请求带 `X-Lumio-Features: job-access` 时返回，旧执行器不受影响；不进 `JobSpec`。
- **agent 管理** `AgentTokenRequest`、`AgentTokenIssued`、`AgentInfo`（不含令牌原文）、`AgentRevokeRequest`。
- **执行者** `WorkTask` / `WorkProject` 增加可选的 `created_by`、`updated_by`（身份 ID；名称经 `/v1/actors` 查）。
- `bun run schema:export` 同时导出每项能力的 `capability.<名称>.args|result.json`。
- **提问与验收**（ADR 0030）：`WorkAttention`（`GET /v2/work/attention`，kind 为 question / review / failed）；
  `work.task.dispatch` 的可选 `comment`（回答并继续，同一事务）；新命令 `work.task.acknowledge`（已查看某一轮）与 `WorkExecution.acknowledged`。
  `packages/work` 暂时拒绝这两种新用法（INVALID），由 R3-2 实现，避免静默忽略。

## R3-2 Hub 与内置助手（Codex）

- **规则表**（`apps/hub/src/authorize.ts`）：按 ADR 0029 第 3 节给 `agent` 加 v2 读取与低风险写入；
  `work.task.update` 的状态改为 done / cancelled、派活、例行任务的新建与修改、提议决定、删除与归档对 agent 一律拒绝，原因码写清楚。
  规则按操作与参数判断，不按调用方区分；对每条拒绝都要有测试。
- **能力执行层**：一个函数按能力名称校验参数、`authorize`、调用对应模块的公开接口，返回契约结果。内置助手工具与 HTTP 都走它。
- **内置助手**：把能力目录注册为工具（工具身份仍是持久的 agent 身份）。对话所有者是 human 时允许私密读取（只在进程内这条路径），
  每次私密读取在工具调用记录中标出并进审计。写入的工具调用结果里保存旧值，供撤回使用；撤回是一个新的普通写入，带 `expected_revision`。
- **助手配置接口**：human 专用的读取与写入；写入先验证（可跳过），原子写入现有环境文件，进程内重载适配器，不重启。
  密钥不出现在响应、日志、审计详情里。`lumio hub assistant setup / status / clear` 改用同一实现，行为保持不变（去掉重启这一步）。
- **提问与验收**（ADR 0030）：
  - `GET /v2/work/attention`：按每个任务最新的、已写回的一轮计算 question / review / failed；派出新一轮、任务变为 done / cancelled / paused、
    这一轮已查看时不再出现。api-client 增加对应方法；能力 `work.attention.list` 走能力执行层。
  - `work.task.dispatch` 的 `comment`：评论与派出同一事务，派出失败时评论不保存；同一 `request_id` 重试不重复评论。
  - `work.task.acknowledge`：写入 `WorkExecution.acknowledged`，不改任务状态；只允许 human（规则表里对 agent 拒绝并有测试）。
  - 给 agent 的固定说明（Hub 组装 prompt 的固定部分）：需要补充或确认时用 `<lumio-question>` 提一个明确的问题并结束本轮；
    做完按「结果 / 改动 / 验证」汇报；不要宣布任务完成。
  - CLI：`lumio task continue <任务> --comment <文字>`、`lumio task ack <任务> --round N`、`lumio attention [--json]`。
- 同步 `docs/assistant.md` 的「工具边界」与配置说明。
- **验收**：attention 的三种状态与四种消失条件、旧轮次不残留；回答并继续的原子性与重试；agent 不能 acknowledge。用合成数据和假模型测试：助手在对话中能列出待办、新建任务、评论；把任务标为 done、派活、批准会被拒绝且模型拿到明确原因；
  私密读取只在 human 对话中成功；撤回成功与冲突两种情况；配置接口写入后下一次对话立即使用新配置；密钥不出现在任何响应与日志里。

## R3-3 外部 agent（Codex）

- **每轮访问凭据**：Hub 交付一轮时按负责人（如 `codex@server`）找到或创建 agent 身份，签发只属于这一轮的令牌（只存哈希），
  在该轮结束、取消、lease 失效时作废。执行器只把它交给这一轮的 agent 进程（`LUMIO_HUB_URL`、`LUMIO_TOKEN`），并把 lumio skill 放进该轮的 agent 配置；
  执行器自己的令牌仍不交出。凭据不写入 Job 记录、日志、结果。
- **`lumio agent add / list / revoke`**：human 经 Hub API 管理 agent 身份与令牌；令牌只显示一次。
- **`lumio skill install [--for codex|claude|pi]`**：把 skill 装进对应 agent 的 skill 目录；连接配置单独写，令牌不进 skill 文件；
  已安装时更新到当前版本。
- **SKILL.md**：命令表由能力目录生成（`bun run gen:skill`），说明部分手写、英文；覆盖数据库任务与项目、执行轮次、提议列表，
  删掉 v1 任务笔记的内容，写明第 3 节的边界（不能完成任务、不能派活、不能审批）。测试：目录中每项能力都有 CLI 命令且 `--json` 输出符合结果契约；生成的 SKILL.md 与提交的文件一致。
- **验收**：合成执行器上一轮 agent 用凭据查任务、在自己的任务上评论成功；该轮结束后凭据失效；尝试标记完成被拒绝；
  `skill install` 在临时 HOME 下写入三种 agent 的目录。

## R3-4 Web（Claude）

- 设置页「助手模型」：地址（带常见服务预设，不预设默认）、模型、密钥（只写）、测试连接、保存后立即生效。
- 设置页「已连接的 agent」：身份、最近活动、吊销。
- 助手对话：工具调用显示为可折叠的一行（读了什么）；写入显示变更卡片与「撤回」；私密读取有标记。
- 任务的讨论与属性变更显示执行者（人或 agent）。
- **提问与验收**（ADR 0030）：「今日」的「需要你处理」改用 `/v2/work/attention`，分「等你回答 / 等你验收 / 执行失败」；
  执行详情、任务页、今日卡片上直接回答（「回答并继续」，默认派给上一轮的 agent，可改）；
  验收卡片：标记完成 / 补充意见并继续 / 已查看；失败卡片：重试 / 已查看；侧栏与底栏的提醒数用同一列表。

## R3-5 验收（人类 + Claude）

1. 设置页填入模型配置并测试连接，不重启 Hub 即可对话。
2. 在 Web 助手里问「我还有哪些待办」「把 X 记成待办，期限周五」，结果正确；变更卡片能撤回。
3. Mac 上 `lumio skill install --for codex`，在 Codex 里问待办、新建任务，Web 里看到「由 codex」。
4. 派一轮给服务器上的 pi，它能读到任务和相关笔记，并在任务里留下评论；该轮结束后凭据失效。
5. 让任意 agent 把任务标为完成或派活，被拒绝并说明原因。
6. 提问与验收（ADR 0030）：派一轮会提问的任务（如作者 2026-11-04 建的交互测试任务）→ 「今日」出现「等你回答」→
   在卡片上回答并继续 → 旧提问消失 → 这一轮结束后出现「等你验收」→ 标记完成后消失；另测「已查看」与「补充意见并继续」。
