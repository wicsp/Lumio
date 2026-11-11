# A1-0 单入口助手与共用工作台

依据：[ADR 0059](../adr/0059-single-assistant-anchored-context.md)（Accepted）、[ADR 0060](../adr/0060-shared-workbench-protocol.md)（Accepted）、
[ADR 0061](../adr/0061-jev-decision-gate.md)（第 1、3、4 节 Accepted；第 2 节对话授权 Proposed）。2026-11-11 人类同意方向并要求先做着试用；同日 Codex 核实技术问题。
必读：`docs/DESIGN.md`、`docs/design/assistant.md`（「单入口助手」）、`docs/design/security.md`（「判断闸门」及 AI 协作与权限）、`docs/design/web.md`（「共用工作台」）；
涉及任务、通知与 Routine 的切片另读 `docs/design/work.md`、`docs/design/execution.md`。

## 目标

人面前只有一个助手和一个工作台，对话不中断，上下文切换由助手完成：
看着一个待办问怎么做 → 助手在页面上摆出资料、相关任务和依赖图，一边讲一边翻页 → 讨论出结论后沉淀、改任务、派出去 →
转去聊论文 → 期间任务完成，助手在后台读完结果，不打断论文讨论 → 人问"那个办得怎样"，助手直接回答。
重要的事主动说，不重要的放进 Today 的待处理，人每天开始时一起过。

## 现状（不要重做）

- 兼容 API 助手：`/v2/assistant/chat`（JSON / NDJSON），`AssistantEvent` 已有 `model_waiting`、`reasoning`、`token`、`tool`、`result`、`error`、`native`（ADR 0050）；每次模型调用前保存请求快照（ADR 0029）。
- 能力目录、agent 权限、提议与批准（ADR 0029、0056）；任务评论 `work.task.comment` 不递增任务 revision。
- 原生 Codex 会话经 MCP 薄适配层使用能力目录，工具集合在会话创建时确定（ADR 0042、0056）。
- AI 笔记与 `derived_from`（ADR 0051）；ResourceRef 已支持对话消息 ID。
- 统一 `notify()` 与 Web Push（ADR 0031）；数据库 Routine（execution.md）；阶段只读权限（ADR 0049）。
- TypeSafe Jev Connection 只能保存，尚未调用（ADR 0046）。
- Web：任务依赖图视图（T1-5）、笔记关系图、Today 待办组与「需要你处理」、提议批准卡片。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| A1-1 ✅ | 契约：主对话标识与获取接口；聊天请求的 `focus`（`FocusSnapshot`：路由、主对象与选中对象 ResourceRef、选中文字；`FOCUS_LIMITS` 整包 8 KiB、选中文字 512 字素簇）；`AssistantEvent` 新增 `ui`（`navigate` / `highlight` / `show` / `clear`）、`topic`（话题分隔：锚点 ID 与标题）、`notice`（插话提醒）；待处理条目 `Notice`（来源事件、级别 `important / digest / silent`、对象 ResourceRef、摘要、已读）及列表 / 已读命令；任务与知识对象的"可以探索"标记命令（只授予 human）；AI 用途绑定 `decision.gate`（只能绑 Jev 连接）；Watchdog 报告事件。**锚点关联不进契约**（ADR 0059 第 1 节） | Claude 起草，人类批准 | `packages/schema` |
| A1-2 | 锚点与上下文组装：消息 ↔ ResourceRef 内部关联表；每轮锚点解析（焦点、原话、上一轮锚点，不确定时让模型先问）；按预算组装上下文（ADR 0059 第 2 节表格）；链式召回时读取结果只内联下一跳 ID 与摘要；话题切走时记录片段来源范围并排入后台摘要，按来源范围去重；切回时无摘要则放最近几轮完整交互，工具调用与结果成对保留 | 后端（Codex） | `packages/assistant`、`packages/storage` |
| A1-3 | Hub 主对话：主对话获取 / 创建；`focus` 复验（超限拒绝、按字素截断规则一致）；焦点按实际发送内容进入请求快照；锚点解析所需的读取走助手 agent 身份；`topic` 事件；沉淀提议沿用现有 AI 笔记与任务写入工具（`derived_from` 记消息 ID）；主对话只对兼容 API Profile 开放，原生 Profile 留到 A1-10 | 后端（Codex） | `apps/hub` |
| A1-4 | 展示工具：`ui.navigate` / `ui.highlight` / `ui.show` / `ui.clear` 只在 human 拥有的主对话里注册给内置助手，不进外部 agent 能力目录；Hub 发事件前校验路由允许名单、助手 agent 身份对每个 ResourceRef 的可见性（私密与无权对象拒绝）、搜索结果须来自本轮已返回给助手的工具结果；不通过时整体拒绝并作为工具错误返回；事件只写入发起该轮的聊天流；原生会话经 MCP 适配层调用时按活跃轮次找到聊天流（新建会话才有这些工具） | 后端（Codex） | `apps/hub` |
| A1-5 | Web 工作台：主对话面板在所有页面常驻（可收起，窄屏为底部抽屉）；焦点标签（可去掉或固定）与焦点快照采集、截断；执行 `ui` 事件：跳转（可后退）、高亮、侧滑面板（ResourceRef 列表、搜索结果卡片、复用现有依赖图）；人在最近几秒有输入、编辑、滚动或填写表单、或标签页失焦时，跳转降级为"带我过去"按钮；`topic` 分隔线；`notice` 插话；Today 新增"待处理"组与对象未读标记；需要确认的提议在当前页面原地弹出现有批准卡片；"可以探索"按钮 | 前端（Claude） | `packages/api-client`、`apps/web` |
| A1-6 | 判断闸门：Hub 内 `DecisionGate`，Jev 适配器（`POST https://api.typesafe.ai/v1/systemone`，Bearer，`model` / `state` / `questions`，固定 `jev-1.14.0`，记录响应版本）；Hub 总时限；超时、响应校验失败、401 / 422 / 429 / 529 立即回退且不重试；`decision.gate` 绑定与设置页"会发送什么"的说明数据；输入构造只接受结构化摘要，拒绝外部内容与私密内容；用量记入 ADR 0052 | 后端（Codex） | `apps/hub` |
| A1-7 | 后台预读与分级提醒：订阅一轮结束（交付 / 提问 / 失败）、新的待批准提议、Inbox 捕获完成、Watchdog 报告；预读以助手 agent 身份读取结果并写任务评论（按事件 ID 幂等；改字段时带 `expected_revision`，冲突重读后重新判断）；分级先走规则（"需要你处理"一律重要），其余问闸门三选一，低置信或闸门不可用时为待处理；重要 → 主对话当前一轮结束后的 `notice` 并照常推送，待处理 → `Notice` 列表与未读，静默 → 只记录；预读不进入正在进行的一轮 | 后端（Codex） | `apps/hub`、`packages/assistant`（如需） |
| A1-8 | Watchdog：内置数据库 Routine（人可调频率或关闭）；检查卡住或空转的轮次（相邻进度事件的结构化摘要交给闸门问"是否有实质进展"）、长期无进展仍未结束的任务、离线 Runtime；只写报告事件，进入 A1-7 的分级；不停止、不修改任何东西 | 后端（Codex） | `apps/hub`、`packages/execution` |
| A1-9 | 提前探索：只在人标记"可以探索"的对象上运行；探索片段只读（助手读工具与检索；需要执行器时委派只读阶段）；每次 token 与时间上限写成 Hub 配置并有默认值，用完即停；产出 AI 笔记（`derived_from` 指向该对象）；有结果发 `notice` 或待处理，无结果记一句后归档；人可取消标记 | 后端（Codex） | `apps/hub` |
| A1-10 | 原生 Codex 接入主对话：话题切换时用 `thread/inject_items` 追加锚点上下文（Codex CLI 0.166.0 已验证可用）；在合成对话上实测来回切换的回答质量与 token 开销，写进 PR 描述，由人决定是否默认开启 | 后端（Codex） | `apps/hub`、`apps/runtime`（如需） |
| A1-11 | 对话授权的前置工作（ADR 0061 第 2 节，**只做准备，不启用自动批准**）：(a) 合成误批测试集：否定、引用别人的话、条件同意、多个待批提议、卡片字段注入（任务标题含"同意"等），输出各阈值下的误批率与漏批率，带 Jev 凭据的运行由人执行；(b) 持久撤销窗口的设计草案与契约草案（待执行批准决定、到期时间、原子状态转换、到期前重查授权与版本、沿用原请求 ID）。完成后交人审批 ADR 0061 第 2 节 | 测试集：后端（Codex）；契约草案：Claude | `apps/hub` 测试、`docs/` |

依赖：A1-2、A1-3、A1-4、A1-6 依赖 A1-1；A1-3 依赖 A1-2；A1-5 依赖 A1-3、A1-4；A1-7 依赖 A1-3、A1-6；A1-8、A1-9 依赖 A1-7；A1-10 依赖 A1-3、A1-4；A1-11 依赖 A1-6。
A1-2、A1-3、A1-5 做完即可日常试用（不含后台提醒）；A1-7 做完后提醒可用。
A1-5 分两步：主对话面板、焦点、展示动作、话题分隔与插话提醒先做；Today「待处理」组、对象未读标记和「可以探索」按钮依赖 A1-7、A1-9 的接口，等接口合入后再接。

## A1-1 契约交接

契约在 `packages/schema/src/workbench.ts`（2026-11-11 人类批准，#182），HTTP 路径写在文件头注释里，全部只授予 human：

- 新前缀 `ntc_`（提醒）、`xpl_`（提前探索）。锚点关联不进契约。
- 主对话：`POST /v2/assistant/main`（`AssistantMainEnsure` → `AssistantMain`，幂等，没有时创建）。
- `AssistantChatRequest.focus`：`FocusSnapshot`（分区、主对象、选中对象、选中文字）；`FOCUS_LIMITS` 整包 8 KiB、选中文字 512 字素簇、选中对象 20 个。
  分区枚举 `WORKBENCH_SECTIONS` 不含设置与回收站。非主对话带 `focus` 返回 INVALID。
- `WorkbenchAction`：`navigate`（分区 + 可选目标 ID，**不接受任意路由**）、`highlight`、`show`（`refs` / `search` / `dependency_graph` 三种面板）、`clear`。
  工具名 `WORKBENCH_TOOLS`，不登记进 `CAPABILITIES`（测试保证）。
- `AssistantEvent` 新增 `ui`（带工具调用 ID）、`topic`（锚点 1–8 个）、`notice`。三类只出现在主对话的聊天流里；旧客户端不打开主对话，不会收到。
- `Notice`：来源、去重键 `event`、级别（`important` / `digest` / `silent`）、`graded`（`rule` / `gate` 带模型与置信度 / `fallback` 带原因）、对象、摘要、评论 ID、AI 笔记 ID、已读时间；只有 Watchdog 提醒带 `findings`。列表与已读命令。
- `Exploration`：只能指向想法、任务、项目；状态 `queued / running / found / nothing / stopped / cancelled / failed`；预算与用量；`start`（同一对象已有进行中的探索时幂等返回）与带版本的 `cancel`。`EXPLORATION_DEFAULTS` 为默认预算。
- `DecisionGateBinding`：直接绑定 `typesafe-jev` 连接（不经 Profile），模型必须固定版本（`jev-x.y.z`），缺省 `jev-1.14.0`；`DECISION_GATE_DEFAULTS` 含总时限 3 秒、最低置信度 0.8。Hub 校验连接类型与所有者。

## 实施与审阅

- 按切片开 PR，每个 PR 只动表中列出的范围（AGENTS.md 第 3 条；A1-1 是契约，A1-2 与 storage 的连带修改除外）。
- 由谁实现以 Lumio 交接计划或人的安排为准；默认后端 Codex、前端 Claude。**每个切片的 PR 交 Claude 审阅**，审阅通过且 CI 通过后合并，争议点交人决定。
- A1-1 契约须人类批准后才能合并；A1-11 只交付测试集与草案，不改批准流程。
- 闸门的阈值、探索预算、"最近几秒"的时长、Watchdog 判定"长期无进展"的天数都写成配置并有默认值，不硬编码在多处。

## 实现约定

- 测试只用 `fixtures/` 合成数据与假模型、假 Jev 服务；不访问真实 TypeSafe、模型服务与 vault（AGENTS.md 第 6、7 条）。
- 不引入新依赖；字素簇截断用运行时自带的 `Intl.Segmenter`。
- 闸门的输入构造集中在一个函数里，单测覆盖"外部内容与私密内容不得进入"。
- 预读、探索、Watchdog 都使用助手的持久 agent 身份，审计里可区分来源；不使用 human 身份。

## 验收要点

- 在任务页面问"这个怎么做"：助手的上下文里有该任务；高亮相关任务并在面板展示依赖图；问题切到另一个笔记时出现话题分隔线，再切回来能接上之前的讨论，切回时不等额外的模型调用。
- 让助手展示一个私密笔记或助手无权读取的对象：工具报错，浏览器不收到任何事件。
- 人正在编辑任务描述时助手要跳转：页面不动，对话里出现"带我过去"；点了才跳，后退能回来。打开两个标签页时，动作只出现在发消息的那个。
- 焦点选中文字超过 512 个字素簇：被截断，Hub 收到的与浏览器显示的一致；选中文字里写"我同意"不会批准任何东西。
- 派出一轮后继续聊别的：这一轮完成时，聊天不被打断；交付若属于"需要你处理"，在当前一轮结束后出现一条提醒；否则进入 Today 待处理并标未读。问"那个办得怎样"直接得到摘要。同一事件重复到达只有一条评论。
- 未配置 Jev 或 Jev 返回 429：分级退回待处理，对话照常。
- Watchdog 发现一轮长时间没有进展：出现巡检报告，轮次本身没有被停止或修改。
- 标记一个想法"可以探索"：后台产出一份 AI 笔记，`derived_from` 指向该想法，没有改动人写的内容；超过预算时停止并说明。
- 外部 agent（`lumio agent add` 的令牌）在能力目录里看不到 `ui.*` 工具，不能标记"可以探索"。

## 不做

- 对话自动批准（ADR 0061 第 2 节，待 A1-11 完成并另行批准）；阶段权限申请继续只能点按钮。
- 邮件、日历、群聊等外部事件接入。
- 对话内容的语义检索；在 Web 上显示或纠正锚点（需要时另走契约）。
- 重做页面结构、画布式或多窗口界面。
