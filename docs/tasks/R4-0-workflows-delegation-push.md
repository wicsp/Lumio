# R4-0 任务流程与 agent 接力、委派需要批准、PWA 推送

- 依据：[ADR 0031](../adr/0031-workflows-delegation-push.md)（Accepted，2026-11-04），以及 ADR 0029、0030
- 契约：新增（R4-1 起草，人类审阅后合并）
- 前置：R3 完成（R3-3 的每轮凭据与 skill，R3-5 验收）

## 切片

| 编号 | 内容 | 负责 | 涉及 | 依赖 |
|---|---|---|---|---|
| R4-1 ✅ | 契约：流程（步骤、走向、轮数上限、批准）、委派提议、推送订阅与通知偏好、通知事件 | Claude 起草，人类批准 | `packages/schema` | R3 |
| R4-2 | Hub：agent 委派改为需要批准；流程引擎（自动接力、打回、人的步骤、上限、暂停）；流程模板 | 后端（Codex） | `apps/hub`、`packages/work`、`packages/execution`、`apps/cli` | R4-1 |
| R4-3 | Hub：统一通知接口与 Web Push 通道（VAPID 密钥、订阅、发送、测试通知）；事件接入 | 后端（Codex） | `apps/hub`、`packages/platform`（如需要） | R4-1 |
| R4-4 | Web：流程的建立 / 查看 / 进度、委派与流程提议卡片；设置页「通知」；service worker 与 CSP | Claude | `apps/web` | R4-2、R4-3 |
| R4-5 | 术语「派活」→「委派」：DESIGN、任务说明、Web 文字（Claude）；CLI 与 Hub 输出（Codex） | Claude + Codex | 文档、`apps/web`、`apps/cli`、`apps/hub` | — |
| R4-6 | 验收：用 Lumio 跑一次 Lumio 自己的开发流程（见文末） | 人类 + Claude | — | R4-1 至 R4-5 |

## R4-1 契约（Claude）

`packages/schema`：`workflow.ts`、`notifications.ts`，以及 `work.ts`、`operation.ts`、`proposal.ts`、`common.ts` 的增量。

- **流程** `Workflow`：1–20 个步骤，`max_rounds` 1–30（缺省 8）。
  - 三种步骤：`agent`（`agent`、`instruction`、`next`、`on_changes`）；`ask`（`question`、2–4 个 `options`，各带 `next`）；`accept`。
  - 规则：步骤 ID 唯一，`end` 是保留字，引用的步骤必须存在，至少一个人的步骤。
  - 运行状态 `WorkflowRun` 存在 `WorkTask.workflow`：`approved`、`current`、`rounds`、`stopped`（原因：max_rounds / failed / unknown / paused / cancelled / by_human）。
  - 模板 `WorkflowTemplate`（ID 前缀 `wft`）。
- **命令**：
  - `work.task.workflow.set`：设置、替换或清除（`null`），`from` 指定起点或继续。
  - `work.task.workflow.decide`：ask 步骤用 `option`，accept 步骤用 `back_to`，可带 `comment`。
  - `work.workflow_template.save` / `delete`。
  - 结果新增 `template`、`removed`、`proposal`（agent 发起而需要批准时，只给提议 ID）。都不是 agent 能力。
- **委派提议**：`WorkCommandProposal`（`op: "work.command"`，内含 `work.task.dispatch` 或 `work.task.workflow.set` 与 request_id）。
  它只进入 `Proposal.operation`（新的 `ProposalOperation`），**不加入** v1 的 `Operation`，`POST /v1/operations` 不接受它。
- **需要你处理**：`WorkAttention` 新增 `decision`（流程的 ask 步骤：`step`、`question`、`options`，没有 job / round）；accept 步骤以 `review` 出现并带 `step`。
- **通知**：
  - `NotificationKind`（attention.question / review / failed / decision、proposal.pending）。
  - `NotificationEvent`：去重 `id`、标题、站内 `path`，不含正文。
  - `PushSubscriptionInput`：只接受 https 推送地址。
  - `PushDevice`（ID 前缀 `pdev`，不返回推送地址与密钥）、`PushDeviceUpdate`、`PushPublicKey`、`PushTestResult`。
- 在 R4-2 实现之前，Hub 与 Work 对新命令、新提议一律返回 INVALID，不静默忽略。Web 已能显示 `decision` 卡片（选项按钮）。

## 要点

- **委派提议**：agent 的 `work.task.dispatch` → 授权结果「需要批准」→ 提议；批准时按提议里看到的 revision 执行，变了就失败并说明。
- **流程引擎**：
  - 一轮结束（结果写回）后，按当前步骤与结果决定下一步：agent 步骤通过 → 下一步；`<lumio-outcome>changes</lumio-outcome>` → 打回去向；
    人的步骤 → 停下，进入 attention（提问步骤用 question，验收步骤用 review）；人回答后按选项走向继续。
  - 每次自动委派都是一个普通的 `work.task.dispatch`（执行者是 Hub 的流程身份，审计里写明所属流程与步骤），输入里附上这一步的说明。
  - 轮数上限、失败、结果不明、任务暂停或取消 → 停止并交给人。只允许委派给流程里写明的执行者。
- **通知**：Hub 内一个通知接口，多个通道；事件来自 attention 与待批准提议的变化（新出现时发一次，不重复）。
  正文只含任务标题与事件类型，点击打开对应页面；订阅失效（推送服务返回 404/410）时自动移除。
- **Web**：service worker 只处理推送与点击跳转，不做离线缓存；CSP 加上 `worker-src 'self'`。设置页：开启本设备通知（需要点击触发）、测试通知、事件开关、已订阅设备列表。
  页面不是 HTTPS 或浏览器不支持时说明原因（iOS 需 16.4+ 且从主屏幕打开）。

## R4-6 验收（用 Lumio 开发 Lumio）

1. 在 Claude（带 Lumio skill）里讨论一个小改动，让它建任务、写好说明，并提出流程「codex@mac 实现 → claude-code@mac review → 你决定是否合并 → claude-code@mac 合并 → 你验收」。
2. 手机收到「待批准的流程」通知，批准。
3. Codex 实现并开 PR → 自动交给 Claude Code review；若打回，回到 Codex，轮数不超上限。
4. 手机收到「是否合并」的通知，回答「合并」→ Claude Code 合并。
5. 收到「等你验收」通知，验收后标记完成。
6. 期间：GitHub 上 Codex 的凭据没有合并权限；任何时候暂停任务，流程立即停止。
