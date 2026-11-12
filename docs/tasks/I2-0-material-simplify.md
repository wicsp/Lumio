# I2-0 资料入库后的显示与入口收敛

依据：[ADR 0065](../adr/0065-material-ai-card-host-inbox-without-triage.md)（Implemented，2026-11-12）。
必读：`docs/DESIGN.md`、`docs/design/knowledge.md`（「来源与 AI 笔记」「外部资料与 Inbox」「搜索」）；I2-3 另读 `docs/design/web.md` 与 `apps/web/README.md`。

## 目标

一篇资料在知识库里只出现一次，打开就能看到 AI 卡片和原链接；Inbox 只是按时间排列的收藏夹，不要求人做任何决定；
卡片写得足够清楚，看完就知道这篇资料在做什么，不再需要"让 AI 细读"。

**不改契约，不改存储格式。** 不新增依赖。全部切片由 Codex 实现；按 AGENTS.md 第 9 条默认流程合并与部署。

## 现状（不要重做）

- 捕获、原文、AI 卡片、嵌入段、`derived_from` 已实现（I1-3，`apps/hub/src/inbox.ts`、`inbox-files.ts`、`inbox-summary.ts`）。
  卡片的 `derived_from` 是 `[实体 ID, 捕获 ID, URL]`。
- 嵌入只在 `value.ownsEntity && !capture.ai_note` 时发生（`inbox.ts` 的 `summarize`），复用已有实体时不嵌入——这就是"资料笔记里没有卡片"的原因。
  `InboxFiles.embed` 本身已按 ID 判断是否已嵌入，可重复调用。
- 知识列表就是空查询的搜索（Web `panes/knowledge.ts` 调 `client.search`）；搜索、相关推荐、`[[` 候选、图谱分别在
  `packages/storage/src/knowledge/index/query.ts`（`searchNotes`、`knowledgeGraph`）与 `packages/storage/src/knowledge/editing.ts`（`relatedKnowledge`、`knowledgeReferences`）。
- 资料页已读取 frontmatter 的 `url`（`panes/knowledge.ts`）；Inbox 页面在 `panes/inbox.ts`，含分拣、深读、原文阅读。

## 切片

| 编号 | 内容 | 改动范围 | 依赖 |
|---|---|---|---|
| I2-1 | 索引推出 AI 笔记的宿主；搜索、列表、相关推荐、`[[` 候选、图谱按宿主收敛 | `packages/storage`（如需纯函数则 `packages/knowledge`） | — |
| I2-2 | Hub：卡片写成功后补嵌入；改卡片提示词 | `apps/hub` | — |
| I2-3 | Web：Inbox 改为收藏夹；资料页突出原链接；去掉深读与 Inbox 内的原文入口 | `apps/web`（文案表同步中英） | I2-1、I2-2 合并后验收更方便，但可并行开发 |

### I2-1 宿主与结果收敛

- **宿主规则**（ADR 0065 第 1 节）：AI 笔记 X 的宿主是 `paper` / `source` 实体 H，当且仅当 H 正文里有单独成段、指向 X 的链接（`[[ ]]` 或标准 Markdown 链接，按现有链接解析），
  且 X 的 `derived_from` 含 H 的 ID。多个 H 同时满足时视为没有宿主。私密笔记不参与。
- 宿主在建索引时算出并存进 `index.sqlite`（例如 notes 表加一列宿主路径或 ID）。需要提升索引版本时按现有做法整体重建，不迁移业务数据。
  "单独成段"的判断与 Web 把链接渲染为 AI 卡片的判断保持一致；如果目前链接表不记录这个信息，在解析时补上。
- **收敛**：
  - `searchNotes`（含空查询列举、`type` 过滤）：有宿主的 X 不作为结果；X 命中时换成 H，`matched_in: "body"`，片段取自 X；H 已在结果中时合并为一条，取较高排名，`total` 按合并后的条数。
    I1-6 的混合检索落地时，在融合之后做同样的合并。
  - `relatedKnowledge` / `knowledgeReferences`（编辑器相关推荐、Inbox"可能相关"、`[[` 空查询与输入搜索）：同样不出现 X，命中 X 换成 H；来源笔记本身仍排除（来源是 H 时，X 的命中也排除）。
  - `knowledgeGraph`：不返回 X 节点及指向它的边。
  - 不变：`showNote` / `noteById` / `noteLinks` 按 ID 或路径直接打开 X；`ai_incoming` / `ai_outgoing`；AI 笔记能力；引用导出。
- **测试**（`fixtures/` 合成数据）：有宿主的 X 不出现在列表与图谱；只在卡片里出现的词搜到 H 且只有一条；H 与 X 都命中时只有一条；
  删掉 H 的嵌入段或 X 的 `derived_from` 中的 H 后 X 重新出现；两个实体都嵌入 X 时 X 照常出现；直接按 ID 打开 X 仍可用。

### I2-2 Hub：补嵌入与卡片提示词

- **补嵌入**：`summarize` 写卡片成功后，只要实体正文里还没有指向该 AI 笔记的链接就调用 `embed`，去掉 `ownsEntity && !capture.ai_note` 的条件。
  这样复用已有实体的捕获、以及"重新生成卡片"都会补上嵌入。补测试：先手工建好论文实体再捕获同一篇，卡片写好后实体正文开头有嵌入段；重复生成不重复嵌入。
- **卡片提示词**（`inbox-summary.ts` 的 `card` 分支）：要求按固定四个小标题写，读完能判断要不要读原文：
  1. 是什么：一句话说清它是什么、解决什么问题；
  2. 怎么做：方法、实验设置或论证思路；
  3. 结论：主要结论，有关键数字就写上；
  4. 局限：前提、适用条件或作者承认的不足；原文没有提到就写"原文未说明"。
  网页与视频按同样四项写（"怎么做"写论据或做法）。总长约 300–500 字（按配置的语言），不写套话。小标题文字随 `captureSummaryLanguage` 输出。
  其余不变：原文作为不可信数据、无工具、只返回 `body` 与 `tags` 的 JSON。补测试：用假模型检查系统提示里有四项要求；解析规则不变。
- 深读：Hub 暂时保留 `summarize` 的 `deep` 实现（契约未删），不再新增调用方；下次改 Inbox 契约时删除。

### I2-3 Web

- **Inbox（`panes/inbox.ts`）**：
  - 列表取全部捕获（`untriaged: false`），新的在前；`state: failed` 的放在最上面。去掉"未分拣 / 全部"切换和"N 条待分拣"计数，说明文字改为"存下的资料都在知识库里，想看时到这里挑"之类。
  - 每条：标题、类型、时间、处理状态、卡片（折叠，默认几行）、"在知识库打开"、"打开原链接"（有 `url` 时，新窗口）。
  - 失败的条目：原因、重试、手动粘贴正文、移除。成功的条目：移除只保留为不显眼的图标按钮（沿用现有丢弃命令与确认）。
  - 去掉：待读 / 存档 / 已读分拣按钮、"让 AI 细读"、Inbox 里的原文阅读入口、"AI · 深读"标签与长卡片样式（已有的 `card: deep` 按普通卡片显示）。保留"补做卡片 / 重试卡片"。
- **资料页（`panes/knowledge.ts`，`paper` / `source`）**：标题下方显眼的"打开原链接"按钮（frontmatter `url`，新窗口，沿用 `safeExternalUrl`）；
  嵌入的 AI 卡片照旧渲染。存档文本放在"更多"菜单里（"查看存档文本"，把 Inbox 现有的只读原文查看移到这里，用 `client.showOriginal`）。不提供深读。
- 文案改动同步中英两张文案表；更新 `apps/web/README.md` 的 Inbox 一段。
- 验收：粘贴一篇 arXiv 链接，知识库里只出现一条；打开就有卡片和"打开原链接"；Inbox 没有任何需要决定的按钮。

## 不做

- PDF / 视频阅读器、文中批注、AI 在原文中标重点、逐段解释；引用位置的结构化记录或 Markdown 特殊标记。
- 阅读状态的界面与"读过"的自动推断（真不够用时再议，ADR 0065 后果）。
- 资料页的"问助手"入口：等单入口助手的锚点上下文（A1-0）提供后再接。
- 删除资料时连带移走原文与 AI 笔记（目前只有 Inbox 的移除会三件一起进回收站）。
- 删除契约中暂不使用的分拣与深读字段。

## 交付记录

- I2-1：PR #214，派生宿主索引与结果收敛；人类批准同步 core 的单个索引版本测试断言。
- I2-2：PR #212，已有资料补嵌入、四项提示词、收藏夹查询。
- I2-3：收藏夹与资料页入口收敛，侧栏取消分拣计数，打开编辑器仍显示首行卡片。
- 验证：三个切片分别通过 `bun run check`；临时合成 Hub + 假模型完成桌面/窄屏、存档只读与移除确认验收。无新增依赖、契约修改或业务数据迁移。
