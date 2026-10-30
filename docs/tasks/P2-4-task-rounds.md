# P2-4 任务笔记里的一问一答

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0019（第 2、3、4、7 节）、0016（操作、授权、审计）、0018（第 3 节：删除 `link.add` 与 `related`）、0012（AI 区块、卡号）
- 涉及：`packages/schema`（只按本说明做两处契约连带修改）、`packages/core`、`apps/hub`、`packages/api-client`、`apps/cli`、`skills/lumio`
- 依赖：P2-3

## 目标
在 Obsidian 里写一个任务，把它交给服务器上的 agent；每一轮的汇报写回这篇笔记；你写意见、把 `assignee` 改成 `pi@server`，
它就接着干。**做完这一步，P2 就真正能用了。**

## 范围

### 契约连带修改（已在 ADR 0019、0018 中批准）
1. 把 `TaskDispatch` 加入 `Operation`；**删除 `LinkAdd`**，同时删除 Hub、api-client、CLI 中的 `link add` / `propose link`
   及其测试（提议框架保留，审批流程改用 P2-6 的 `exec.privileged` 测试；本切片中用注入的规则表保持覆盖）。
2. **删除 `Base.related`**：已有笔记中的 `related` 作为未知字段原样保留（vault 实体是宽松对象），但不再计入链接图；
   `LinkSource` 只剩 `wikilink`。更新受影响的查询测试与 fixture。

### packages/core
3. 任务笔记的编辑：
   - 追加或替换一轮的 AI 区块：`<!-- lumio:ai start name=round-<N> job=<job> -->` … `<!-- lumio:ai end name=round-<N> -->`，
     放在正文末尾；区块标题行为 `### 第 N 轮 · 完成 | 有问题等你回答 | 失败：<原因> | 情况不明 | 已取消`。
   - 修改 frontmatter 的 `assignee` / `status`，保持其他字段与写法不变；正文中区块以外的部分逐字节不变。
   - 都用带 `expectedContent` 的安全写入。
4. **提取"人写的部分"**：正文去掉所有 `lumio:ai` 区块后的文本。

### apps/hub
5. **触发**：
   - 文件监听发现任务的 `assignee` 由 `human`（或缺失）变成 agent → 记下时间；笔记**安静 30 秒**后，
     若 `assignee` 仍是该 agent 且该任务没有执行中的轮次 → 执行 `task.dispatch`（trigger `assignee`）。
   - `lumio task continue <任务> [--to pi@server]` → `task.dispatch`（trigger `cli`），同时把 `assignee` 写成目标 agent。
   - 执行中的负责人修改不派新轮、不取消；未知负责人报错，都记入 `hub status` 的问题列表。
   - `task.dispatch`：human 允许；agent、runtime 拒绝；写审计。
6. **派出一轮**：
   - 选执行器：写了 `@server` 时用指定执行器；否则只用 Hub 本机执行器，没有登记时拒绝；已登记但离线时排队。
   - **工作目录**：`workdir` 可以不写，默认执行器上的 `~`；位于笔记库内时拒绝。
   - 组装 `prompt`：固定说明（模板放在 `apps/hub` 内）+ 内容。固定说明包括：你在为哪个任务工作；工作目录；
     最后用中文简要汇报做了什么、改了哪些文件、结果、遗留问题；需要人决定时用 `<lumio-question>` 提问后结束；
     **不要读写 Lumio 笔记库**；不要尝试提权。内容：
     - 第 1 轮：任务标题 + 人写的部分全文；
     - 之后能接上会话：人写的部分**相对上一轮派出时快照的新增与修改**（Hub 保存每轮派出时的快照）；
     - 接不上会话：人写的部分全文 + 最近一轮的汇报。
   - 会话：存在 Hub；agent 与执行器相同才续接，换 agent 或执行器开新会话（ADR 0024）；claude-code 用随机 UUID，pi 首轮用任务 ID，之后新会话用独立 ID，codex 用其返回的编号。
   - 执行配置：任务的 `workdir`、`model`、`gpus`、`timeout_minutes`（缺省 120 分钟）。
   - 第一次派出时把 `status` 从 `todo` 改成 `active`。
7. **收到结果**：
   - 写回一轮 AI 区块：汇报摘要（最多 3000 字符，超出部分截断并注明"完整汇报：`lumio job show <job>`"）、问题（醒目显示）、
     失败原因、git 前后提交。
   - **写回前检查**疑似卡号（ADR 0012）和常见密钥格式（如 `sk-`、`ghp_`、`AKIA`、`xox[bp]-`、私钥头）：命中则区块中只写
     "汇报中疑似包含敏感信息，未写入笔记，请用 `lumio job show` 查看"。
   - 把 `assignee` 改为 `human`。
8. **人在执行中把 `status` 改成 `paused` 或 `cancelled`**：取消这一轮（P2-2 的取消），结果写回后 `assignee` 为 `human`。

### apps/cli、packages/api-client
9. `lumio task continue <任务> [--to pi@server]`、`lumio task show <任务> [--json]`（各轮：编号、状态、时间、agent、执行器）。

### skills/lumio
10. 在 skill 中说明：用户的任务笔记里 `lumio:ai` 区块是各轮 AI 的汇报；agent 只读，不能派任务（会被拒绝）。

## 不做
- 不做例行任务（P2-5）、不做 `lumio sudo`（P2-6）、不做飞书按钮。

## 验收标准
1. `bun run check` 通过。
2. 端到端测试（合成 vault + 假 agent）：
   - 新任务 `assignee: pi@server` → 30 秒安静后只派出一轮；30 秒内改回 → 不派；状态来回改、同一修改被监听两次 → 只派一次。
   - 结果写回：区块位置与标题正确，正文区块以外逐字节不变，`assignee` 变 `human`，`status` 从 `todo` 变 `active`。
   - 第 2 轮能接上会话时只发新增内容；接不上时发全文 + 上一轮汇报（检查组装出的 prompt）。
   - 提问 → 区块显示问题；人回答后第 3 轮接着同一会话。
   - 执行中改 `status: paused` → 这一轮被取消。
   - 汇报含测试用的假密钥 → 不写入笔记。
   - agent 令牌调用 `task continue` → 403；审计记录每次派出与触发方式。
   - 删除 `link.add`、`related` 后，查询与链接测试全部更新并通过。
3. 人类在真实 vault 中手动验证：建一个任务交给服务器上的 Codex，来回两轮，在 Obsidian 与 iPad 上都能看到结果。
