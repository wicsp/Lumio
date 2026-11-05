# R4-0 任务模型 v3、交接计划、委派需要批准、PWA 推送

- 依据：[ADR 0032](../adr/0032-task-model-outcome-turn.md)（任务模型：结局、轮到谁、事件；交接计划）、
  [ADR 0031](../adr/0031-workflows-delegation-push.md)（委派需要批准、统一推送、术语，2026-11-04 修订），以及 ADR 0029、0030
- 状态（2026-11-05）：R4-1 至 R4-6 已合并（#85 契约、#86 契约 R4-1b、#87 任务模型 v3、#88 交接计划、#90 推送、#91 Web）；只剩 R4-7 人工验收
- 前置：R3 完成（R3-5 人工验收可与 R4 并行）
- 2026-11-04 重排：原 R4-2「流程引擎」按 ADR 0032 改为任务模型切换（R4-2）与交接计划（R4-3）两片；后续切片顺延。

## 切片

| 编号 | 内容 | 负责 | 涉及 | 依赖 |
|---|---|---|---|---|
| R4-1 ✅ | 契约：委派提议、推送订阅与通知（#85）；任务模型 v3、交接计划、新命令（R4-1b） | Claude 起草，人类批准 | `packages/schema` | R3 |
| R4-2 ✅ #87 | 任务模型 v3 切换：迁移、「轮到谁」的规则、委派需要批准、每一轮的输入（Inline & Spill）、CLI | 后端（Codex） | `packages/schema`（只做下面列出的切换）、`packages/work`、`packages/storage`、`apps/hub`、`apps/cli`、`apps/runtime`（文字）、`apps/web`（只做编译所需的机械修改） | R4-1 |
| R4-3 ✅ #88 | 交接计划：计划运行、检查点、打回、轮数上限、计划模板、CLI | 后端（Codex） | `packages/work`、`apps/hub`、`apps/cli` | R4-2 |
| R4-4 ✅ #90 | 通知：统一接口与 Web Push（VAPID、订阅、发送、测试通知） | 后端（Codex） | `apps/hub`、`packages/api-client` | R4-2 |
| R4-5 ✅ #91 | Web：按「轮到谁」重做今日与任务列表；任务时间线；交回 / 完成 / 我自己来；计划编辑与检查点；提议卡片；设置页「通知」；service worker | Claude | `apps/web` | R4-2 至 R4-4 |
| R4-6 ✅ | 术语「派活」→「委派」：DESIGN、任务说明、Web（Claude）；CLI 与 Hub 输出（Codex，可并入 R4-2） | Claude + Codex | 文档、各 app | — |
| R4-7 | 验收：用 Lumio 跑一次 Lumio 自己的开发流程（见文末） | 人类 + Claude | — | R4-1 至 R4-6 |

## R4-1 契约（Claude）✅

`packages/schema`：

- **任务模型 v3**（`work.ts`，与 v2 并存直到 R4-2 切换）：
  - `TaskOutcome`（open / done / cancelled）。
  - `Turn`（`holder` 为 human / agent / external / nobody，`reason` 为 todo / answer / review / failed / working / waiting / on_hold，二者必须匹配；另有 `since`、`round`、`job`、`stage`、`note`）。
  - `WorkTaskV3`（没有 status 与 assignee；有 `outcome`、`turn`、`plan`；已结束的任务轮到无人）。
  - `TaskTurnChange`（交接记录，只追加）、`WorkTaskDetailV3`（多了 `turns`）。
  - `RESPONSE_REASONS`（answer / review / failed）。
- **新命令**：
  - `work.task.hand`：交给 human / external（必须附说明）/ nobody。
  - `work.task.finish`（done / cancelled）、`work.task.reopen`。
  - `work.task.plan.set`：可带 `from`，`null` 表示清除。
  - `work.task.checkpoint`：处理为 continue / send_back（必须带 back_to 与评论）/ finish / hold；`stage` 可为 end。
  - `work.plan_template.save` / `delete`。
  - `work.task.dispatch` 已有可选的 `comment`（回答并继续）。
- **交接计划**（`plan.ts`，取代 R4-1 的 `workflow.ts`）：
  - `HandoffPlan` 的阶段分为 agent 阶段（`agent`、`instruction`、`back_to`）和检查点（`prompt`）；至少一个 agent 阶段；`back_to` 必须指向 agent 阶段；轮数上限 1–30，缺省 8。
  - `PlanRun`（`plan`、`approved`、`stage`（含 end）、`rounds`），`PlanTemplate`（ID 前缀 wft）。
- **委派提议**：`WorkCommandProposal`（`op: "work.command"`，内含 dispatch 或 plan.set）。它只放在 `Proposal.operation`（`ProposalOperation`）里，v1 的 `Operation` 不变。
- **需要你处理**：`WorkAttention` 的 kind 为 question / review / failed，分别对应原因 answer / review / failed；另有可选的 `stage`、`prompt`（检查点）。
- **通知**：`NotificationKind` 为 turn.answer / turn.review / turn.failed / proposal.pending；另有 `NotificationEvent`（只有标题和站内路径）、`PushSubscriptionInput`（只接受 https）、`PushDevice`（ID 前缀 pdev，不返回推送地址与密钥）、`PushDeviceUpdate`、`PushPublicKey`、`PushTestResult`。
- 在实现之前，Work 与 Hub 对新命令、新提议一律返回 INVALID。

## R4-2 任务模型 v3 切换（Codex）

- **契约切换**（R4-1b 已批准，这里只做机械变更）：
  - `WorkTaskV3` / `WorkTaskDetailV3` 改名为 `WorkTask` / `WorkTaskDetail`，删除 v2 的任务定义。
  - 删除 `WorkTaskPatch` 里的 `status` 与 `assignee`，以及 `work.task.create` 的 `status` 与 `assignee`（新建轮到人，原因 todo）。
  - 删除 `work.task.acknowledge` 与 `WorkExecution.acknowledged`，删除 `AGENT_SETTABLE_TASK_STATUSES`。
  - 能力目录加入 `work.task.hand`（agent 只能交给 human 或 external）；`work.task.update` 的说明去掉状态。
  - 导出的 JSON Schema 随之更新。不做其他契约改动；需要时停下来问人。
- **迁移**：按 ADR 0032 第 8 节，把旧任务一次性改写为 v3（迁移前自动完整备份；可重复运行；旧的「已查看」改为轮到人、原因 todo）。
  - 每个任务写一条初始交接记录。
  - CLI 的迁移入口沿用 `lumio hub migrate` 的风格。
- **「轮到谁」的规则**（ADR 0032 第 3、4 节），全部在 Work 里一个地方实现：
  - 委派 → 轮到 agent（working，带 round 与 job）。
  - 一轮结束：提问 → answer；失败 / 不明 → failed；取消 → todo；交付 → 没有计划时为 review，有计划时交给 R4-3。
  - hand、finish（同时取消正在进行的一轮）、reopen 分别按规则改变持有者。
  - 每次改变都追加 `TaskTurnChange`；同一任务同一时间只有一个持有者，轮到 agent 时不能再委派。
- **权限**（`authorize.ts`）：
  - finish / reopen / plan_template / checkpoint：只有人。
  - hand：人都可以；agent 只能 `to: human | external`。
  - agent 的 dispatch 与 plan.set → 需要批准，生成 `WorkCommandProposal`，结果返回 `{ kind: "proposal" }`。
  - 人批准时以提议作者身份、按原 request_id 执行；revision 变了就 CONFLICT 并说明。
  - 去掉 R4-1 加在 `operations.ts` 里的临时拒绝。
- **需要你处理**：`/v2/work/attention` 改为直接按 `turn` 计算（轮到人且原因属于 `RESPONSE_REASONS`）。
- **每一轮的输入**（ADR 0032 第 6 节，Inline & Spill）：
  - 输入包括：任务标题与描述，这一阶段的说明（R4-3 起），上次交回以来的评论，上一轮汇报的摘要，以及更早轮次、相关笔记的 ID 与一行摘要。
  - 固定说明里告诉 agent 用 Lumio skill 沿 ID 取回更多内容。
  - 删掉把整段讨论都放进输入的做法。
- **CLI**：
  - `lumio task hand <任务> --to human|external|nobody [--note 文字]`；`lumio task finish|cancel|reopen <任务>`。
  - `lumio task list` 按「轮到谁」分组显示，支持 `--turn me|agents|external|hold`。
  - `task status` 与 `task assign` 删除，或提示改用新命令。
  - 输出里「派活」统一改为「委派」（R4-6 的命令行部分）。
- **Web**：只做让它编译通过的机械修改（例如把状态显示改为从 `outcome` 与 `turn` 推出），不改界面；界面由 R4-5 重做。
- **skill**：重新生成 SKILL.md。说明里写明：没有状态和负责人；agent 能交回给人或外部；委派和计划只能提议；完成由人决定。
- **验收**：
  - 迁移覆盖 ADR 0032 第 8 节表格的每一行，可以重复运行，迁移前有备份。
  - 四种一轮结果分别交给正确的持有者。
  - 每次交接都有记录。
  - agent 不能完成、取消、重新打开、交给无人、处理检查点。
  - agent 的委派生成提议，批准后执行，revision 变了就拒绝。
  - attention 只来自 turn。
  - 每一轮的输入不再包含整段讨论。

## R4-3 交接计划（Codex）

- plan.set：人设置立即生效（agent 的在 R4-2 中已是提议）。设置不会自己开始委派。
- 一轮交付后，按计划推进：
  - 下一阶段是 agent → 自动委派。执行者是 Hub 的系统身份，交接记录与审计里写明计划与阶段；输入附上这一阶段的说明。
  - 汇报带 `<lumio-outcome>changes</lumio-outcome>` 且这一阶段声明了 `back_to` → 委派到 back_to 阶段。
  - 下一阶段是检查点 → 轮到人（review，带 stage 与 prompt）。
  - 计划走完 → 轮到人（review，stage 为 end）。
- 检查点的处理：
  - continue：委派下一阶段；在 end 上选 continue 无效。
  - send_back：评论交给 back_to 阶段并委派。
  - finish：完成任务。
  - hold：交给无人。
- 只能委派给计划里写明的 agent。达到轮数上限时轮到人（review），并在 note 里写明原因。
- 计划模板：save / delete，并提供 `GET /v2/work/plan-templates`；只有人能用。
- CLI：`lumio task plan set <任务> --file plan.json [--from 阶段]`、`lumio task plan show <任务>`、`lumio task checkpoint <任务> --stage S --action continue|send-back|finish|hold [--back-to S] [--comment 文字]`、`lumio plan-template list|save|delete`。
- 验收：用假 agent 跑通「实现 → review（打回一次）→ 检查点（继续）→ 合并 → 计划结束，轮到人」，轮数正确；达到上限、失败、提问都轮到人；对过时的阶段做处理会被拒绝。

## R4-4 通知（Codex）

- Hub 内一个 `notify(event)`，交给各个通道；先实现 Web Push，接口要能以后加飞书等。
- 事件来源：交接记录里新出现的「轮到人且原因属于 RESPONSE_REASONS」，以及新的待批准提议。按 `NotificationEvent.id` 去重。
  正文只有标题与事件类型；`path` 是站内路径。
- Web Push：
  - 首次需要时生成 VAPID 密钥，私密保存（600）。
  - 接口（只有人，只能管理自己的设备）：`GET /v2/notifications/push/key`；设备的 `POST/GET /v2/notifications/push/devices`、`PATCH/DELETE /v2/notifications/push/devices/<id>`；`POST /v2/notifications/push/test`。
  - 推送服务返回 404/410 时移除设备；其他失败记 `last_error`（不含推送地址）。推送地址与密钥不出现在任何响应、日志、审计详情中。
  - RFC 8291 与 RFC 8292 优先用运行时自带的 crypto 实现，并用 RFC 的测试向量验证；若要引入依赖，在 PR 里写明理由。
- api-client 增加对应方法。
- 验收：用合成的推送服务验证载荷能被解密、VAPID 签名正确；同一事件只推一次；todo 不推；404/410 时设备被移除。

## R4-5 Web（Claude）

- 「今日」与任务列表按「轮到谁」分组：需要你处理（answer / review / failed）、你要做的（todo）、agent 在做、在等外部、搁置。
- 任务页：按时间合并讨论、轮次、交接记录的时间线；交回 / 完成 / 取消 / 重新打开；「我自己来」。
- 交接计划：编辑器（可套用模板）、进度显示、检查点卡片（继续 / 打回 / 完成 / 搁置）。
- 提议卡片：agent 的委派与计划，一键批准或拒绝。
- 设置页「通知」：开启本设备（需要点击触发）、测试通知、事件开关、设备列表。
  页面不是 HTTPS 或浏览器不支持时说明原因（iOS 需要 16.4 以上，并从主屏幕打开）。
- service worker 只处理推送与点击跳转，不做离线缓存；CSP 加 `worker-src 'self'`。

## R4-7 验收（用 Lumio 开发 Lumio）

### 准备（一次性）

1. **升级并迁移**：Mac 上 `lumio upgrade`（Hub、CLI、网页一起升级）。Hub 启动时会自动把旧任务迁移到 v3，也可以停掉 Hub 后手动运行 `lumio hub migrate task-v3`；迁移前会自动做完整备份。
2. **HTTPS 地址**：推送必须走 HTTPS。用 `tailscale serve --bg 7420` 得到 `https://<机器名>.<tailnet>.ts.net`，并运行 `lumio-hub setup --public-url https://<机器名>.<tailnet>.ts.net`（作者的 Mac 已于 2026-10-29 设置过，见 personal-setup.md）。推送签名会用这个地址；没设置时退回用订阅页面的地址。
3. **手机开通知**：iPhone 需要 iOS 16.4 以上。用 Safari 打开上面的 https 地址 → 分享 → 添加到主屏幕 → 从主屏幕打开 Lumio → 设置 → 通知 → 开启 → 发送测试，确认能收到。
4. **执行器**：确认 Mac 的执行器在线，并登记了 `codex` 和 `claude-code` 两个引擎（设置 → 执行器）。下面用 `codex@mac`、`claude-code@mac` 指代，按你实际的执行器名替换。
5. **Claude 侧的 skill**：在 Claude Code 所在机器运行 `lumio skill install --for claude`，让它能以 agent 身份读写 Lumio（只能提议委派和计划）。
6. **GitHub 权限**：Codex 用的 GitHub 凭据只能推分支、开 PR，不能合并；合并由 Claude Code 的凭据完成。
7. **（可选）存一个计划模板**，以后新任务直接套用：

```json
{
  "stages": [
    { "kind": "agent", "id": "implement", "agent": "codex@mac", "instruction": "Implement the change described in the task on a new branch, run bun run check in English and Chinese shells, push, and open a PR. Report the PR number." },
    { "kind": "agent", "id": "review", "agent": "claude-code@mac", "instruction": "Review the PR from the previous round against AGENTS.md and the task. If changes are needed, comment on the PR and end your report with <lumio-outcome>changes</lumio-outcome> on its own line.", "back_to": "implement" },
    { "kind": "checkpoint", "id": "merge-ok", "prompt": "Merge the PR?" },
    { "kind": "agent", "id": "merge", "agent": "claude-code@mac", "instruction": "Squash-merge the reviewed PR once CI is green, then report the merge commit." }
  ],
  "max_rounds": 8
}
```

保存：`lumio plan-template save "Lumio dev loop" --file plan.json`；也可以在网页的计划编辑器里「存为模板」。

### 验收步骤

1. 在 Claude（带 Lumio skill）里讨论一个小改动，让它建任务、写好说明，并提议计划「codex@mac 实现 → claude-code@mac review（可打回）→ 检查点：是否合并 → claude-code@mac 合并」。
2. 手机收到「待批准」通知，批准计划，委派第一轮。
3. Codex 实现并开 PR，自动交给 Claude Code review；如果打回，就回到 Codex，轮数不超过上限。
4. 手机收到「是否合并？」的检查点通知，选择继续，Claude Code 合并。
5. 计划走完，轮到你验收，你标记完成。
6. 期间检查两点：GitHub 上 Codex 的凭据没有合并权限；任何时候搁置任务，都不会再自动委派。

### 记录

验收中发现的问题按「哪一步、看到了什么、期望什么」记下来，发给 Claude 整理成修复任务；全部通过后在本节写上日期和结论，再发布 v0.2.1（标签由人推送）。
