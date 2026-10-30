# 0024 负责人写成一行，并且就是交接的开关；工作目录缺省为 `~`

- 状态：Proposed
- 日期：2026-10-29（2026-10-30 按人类意见改写）
- 领域：数据 | Hub 与运行
- 影响：修订 ADR 0019 中任务与例行任务的 `assignee`、`turn`、`workdir`；取代 ADR 0023 中关于 `turn` 的一条；
  DESIGN 第 3.2、3.3、4.6、5 节；`packages/schema` 的 `Assignee`、`Task`、`Routine`

## 背景
打磨期第一次在 iOS Obsidian 上给服务器派活（2026-10-29）时发现：

1. `assignee: {agent: pi, device: server}` 是嵌套对象，Obsidian 的属性面板编辑不了，手机上只能在源码模式里手打缩进。
2. 派一轮要改两个字段：先写 `assignee`，再把 `turn` 改成 `agent`；换一个 agent 接手还要再改一次 `assignee`。
   Obsidian Bases 的看板按一个字段分列，拖动卡片只能改这一个字段。
3. `workdir` 必须写。大部分"看一眼""查一下"的任务并不在意工作目录。

## 决定

### 1. 负责人写成一行字符串
- 任务的 `assignee` 取值：`human`，或 `<agent>`，或 `<agent>@<执行器名称>`。例如 `pi`、`pi@server`、`codex`。
  - `<agent>` 是 `claude-code`、`codex`、`pi` 之一；`<执行器名称>` 的规则同 `RuntimeName`。
  - **不写 `@<执行器>` 时，用 Hub 所在机器上的执行器**（`lumio-hub setup` 装的本机执行器）；这台机器没有执行器时拒绝并说明。
    不再"自动挑一个在线的"。
- 例行任务的 `assignee` 同样写成 `<agent>` 或 `<agent>@<执行器名称>`（不能是 `human`），规则相同。
- 只写这一种格式：文档、模板、`lumio routine followup`、自检笔记和 Hub 写出的内容都用字符串。
- **兼容旧写法**：读取时仍接受旧的 `{agent, device}` 对象，等价于 `agent@device`（没有 `device` 时等价于 `agent`）；
  补全器不改写已有的值，`lumio check` 对旧写法给出提示（不算错误）。以后要删掉兼容时另写 ADR。
- 契约：`Assignee` 提供解析函数（返回 `human` 或 `{agent, device?}`），Hub、补全器与 CLI 只通过它读取负责人。

### 2. `assignee` 就是"现在轮到谁"，删除 `turn`
- **人把 `assignee` 从 `human` 改成某个 agent** → 笔记安静 30 秒后派出一轮（与原来改 `turn` 的规则相同，走操作 `task.dispatch`）。
- **这一轮结束**（完成、有问题、失败、情况不明、已取消）→ Hub 把 `assignee` 写回 `human`。哪个 agent 做了哪一轮，看正文里的区块标题。
- **交接只改这一个字段**：pi 做完回到 `human`，人看过后改成 `codex`，codex 就接着做；改回 `human` 或什么都不改就是自己接手。
  - 换 agent 时开新会话，上下文为"人写的部分 + 最近一轮的汇报"；同一个 agent（含同一执行器）接着做时能接上原会话就接上（ADR 0019 第 4 节规则不变）。
  - **agent 不能把任务交给另一个 agent**：AI 的汇报只是资料，不能派新活（DESIGN 第 5 节不变）。agent 之间自动接力以后经审批再做。
- 一轮执行中，人改 `assignee` 不生效（Hub 只记入 `hub status` 的问题列表，写回时照常改成 `human`）；要停下这一轮仍是把 `status` 改成 `paused` 或 `cancelled`。
- `turn` 删除：旧笔记里的 `turn` 作为未知字段原样保留，Hub 不再读写它。ADR 0023 中"负责人是 agent 的任务补写 `turn: human`"一条作废；
  补全器改为：任务缺 `assignee` 时写上 `human`（开关看得见，ADR 0023 的精神不变）。
- `lumio task continue <任务> [--to <负责人>]`：把 `assignee` 写成指定的 agent（缺省用最近一轮的 agent）并立即派出。

### 3. `workdir` 缺省为执行器上的 `~`
- 任务与例行任务的 `workdir` 改为可选；缺省时在**执行器所在机器**的用户主目录里执行。按 ADR 0008，默认值不写进文件；Job 里记录实际使用的目录。
- 现有规则不变：工作目录不能在笔记库里（ADR 0019）。工作目录包含笔记库（如 Mac 上的 `~`）的情况按人类决定不做限制，由各 agent 的沙箱配置负责。

## 后果
- 好处：手机上在属性面板里改一个字段就能派活和交接；Bases 看板按 `assignee` 分列，拖动卡片就是交接；简单任务只需写正文。
- 代价：
  - `turn` 删除后，"AI 是否正在执行"只能看 `hub status` / `lumio task list`，frontmatter 里看到的 `assignee: pi` 可能是"刚改、30 秒内会派出"，也可能是"执行中"。
  - 负责人有两种写法共存一段时间，解析集中在 schema 的一个函数里。
  - 在 Mac 上不写 `workdir` 时 agent 在 `~` 里工作，能接触到笔记库；靠 agent 自带沙箱与 `AGENTS.md` 约束。

## 不在本 ADR 里
- 在 frontmatter 里记录上一轮的结果（完成 / 有问题 / 失败）：和 `status` 有重叠，人类要求想清楚再定，记在 `docs/tasks/README.md` 的待办里。

## 修订记录
