# I1-0 Inbox 与外部资料入库

依据：[ADR 0057](../adr/0057-inbox-and-captured-sources.md)（Accepted，2026-11-11 人类批准方向）。
必读：`docs/DESIGN.md`、`docs/design/knowledge.md`（「外部资料与 Inbox」「来源与 AI 笔记」「搜索」）、`docs/design/security.md`；
I1-4 另读 `docs/design/execution.md`，I1-5、I1-7 另读 `docs/design/web.md`。

## 目标

遇到一篇文章、论文或视频时，粘贴链接（或点浏览器插件）就存下来。Lumio 按类型解析出原文，AI 写一张卡片，
资料进入 Inbox。人花几秒分拣：想读、存档、已读或丢弃。不分拣也能被检索到。
以后写笔记或在助手里聊到相关的事时，这些资料能被找出来作为参考。

## 现状（不要重做）

- `paper`、`source` 实体与目录、citekey、论文元数据解析（arXiv / Crossref，K1-3 的受限抓取）已存在。
- AI 笔记（`ai/notes/`、`derived_from`、嵌入卡片渲染）已实现（K4，ADR 0051、0053）。
- 搜索是 FTS5 + trigram；编辑器相关推荐是词法匹配（ADR 0035）。
- AI 配置底座：Connection / Profile / 用途绑定（ADR 0041）；用量记录（ADR 0052）；DashScope 连接已用于语音（ADR 0055）。
- Job 的 command 类型只执行执行器上登记过的程序；文件经托管文件交回（ADR 0025）。
- 回收站（ADR 0038）。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| I1-1 ✅ | 契约：`cap` 前缀与 `Capture`（输入、渠道、状态 `queued / extracting / summarizing / ready / failed`、实体 ID、`triaged`、错误）；捕获、列表、分拣、重试、重新抽取、深读的请求与结果；`paper` / `source` 的 `status` 增加 `reference`；原文文件 frontmatter（`of`、`url`、`captured`、`extractor`、`lang`、`sha256`、可选 `pdf` 文件 ID）；AI 用途绑定 `knowledge.summary`、`knowledge.embedding`（向量 Profile 只能绑向量用途）；能力 `knowledge.original.show`；搜索结果增加命中位置（`body` / `original`）、阅读状态与入库时间 | Claude 起草（ADR 已批准） | `packages/schema` |
| I1-2 ✅ | Knowledge 与索引：`VAULT_LAYOUT` 增加非实体目录 `files/originals/`；原文文件的命名、写入（只由 Lumio 写）、读取；原文进入单独的全文表并映射回实体；实体模板开头的 AI 笔记嵌入段；`reference` 状态 | 后端（Codex） | `packages/knowledge`、`packages/storage` |
| I1-3 ✅ | Hub 捕获流程：`POST /v2/inbox/captures` 等接口与 `lumio capture <url>`；URL 规范化与去重（含"曾丢弃"提示）；受限抓取（第 7 节的地址检查）；网页正文抽取、arXiv HTML 全文；生成实体与原文；Inbox 处理身份；卡片生成写 AI 笔记（原文放在明确的数据边界内，无工具调用）；深读；失败记录与人工重试；分拣与丢弃（实体、原文、AI 笔记一起进回收站）；`knowledge.original.show` 登记进能力目录 | 后端（Codex） | `apps/hub`、`packages/knowledge`（如需） |
| I1-4 | 重的抽取走执行器：PDF 转 Markdown、字幕或音频下载、本地语音识别作为 command Job 运行登记过的程序，结果经托管文件交回后由 Hub 写入原文；可选改用云端语音识别（语音 Profile）；字幕所需 Cookie 只放在执行器机器上 | 后端（Codex） | `apps/hub`、`apps/runtime`、`packages/execution` |
| I1-5 ✅ | Web：快速捕获（粘贴框、命令面板、PWA 分享目标）；Inbox 视图（处理进度、卡片、"可能相关"前 3 条、分拣按钮、失败原因与重试、手动粘贴正文）；原文阅读页（只读）；"让 AI 细读"；设置页的摘要与向量 Profile（写明内容发给哪个服务） | 前端（Claude） | `packages/api-client`、`apps/web` |
| I1-6 | 语义检索：按"标题 + 卡片"（笔记按标题与正文）生成向量存入 `index.sqlite`；换模型时整体重算；混合检索（FTS 与向量按 RRF 融合）用于 `knowledge.search`、编辑器相关推荐和 Inbox"可能相关"；私密实体不生成向量；未配置向量用途时退回纯全文检索 | 后端（Codex） | `packages/knowledge`、`packages/storage`、`apps/hub` |
| I1-7 | 浏览器插件：把当前页面的 URL、标题与正文（人当前看到的内容）送到 Inbox；配对方式沿用 Web 登录 | 前端（Claude） | `apps/chrome-ext` |

依赖：I1-2、I1-3 依赖 I1-1；I1-4、I1-5、I1-6、I1-7 依赖 I1-3。I1-3 做完即可日常使用（网页与 arXiv）。

## I1-1 契约交接

契约在 `packages/schema/src/inbox.ts`（2026-11-11）：

- `Capture`、`CaptureCreate` / `CaptureCreateResult`（`duplicate: none / existing / discarded`）、`CaptureListArgs` / `CaptureList`、
  `CaptureCommand`（`triage` / `retry` / `reextract` / `summarize`，都带 `expected_revision`）、`CAPTURE_LIMITS`、`CaptureErrorCode`。
  处理状态 `state` 只有 `queued / extracting / ready / failed`；卡片单独记在 `card`（`none / pending / ready / deep / failed`），没有卡片不影响入库。
- HTTP 路径写在 `inbox.ts` 文件头注释里；全部只授予 human。Inbox 的"可能相关"复用 `KnowledgeReferencesRequest`（ADR 0035），以捕获出的实体为来源。
- `READING_STATUSES` / `ReadingStatus` 在 `entities.ts`，`paper` 与 `source` 的 `status` 都用它（增加 `reference`）。
- `ORIGINALS_DIRECTORY`、`OriginalFrontmatter`（`of` 只能是 `pap_` / `src_`；`extractor` 形如 `readability@1`）。
- `SearchHit` 增加可选的 `matched_in`（`body / original / semantic`）、`status`、`created`。
- `KnowledgeAIBinding` / `KnowledgeAIBindingUpdate`（`knowledge.summary` / `knowledge.embedding`）；`AIProfile.engine` 增加 `embedding`。
  Hub 现有规则已拒绝把 `embedding` Profile 用于聊天；I1-3 校验摘要 Profile 为 `lumio`，I1-6 校验向量 Profile 为 `embedding`。
- `knowledge.original.show`：`KnowledgeOriginalShowArgs` / `KnowledgeOriginal` / `ORIGINAL_SUMMARY` 已定义，**未登记进 `CAPABILITIES`**，由 I1-3 实现时登记（同 K4-3）。

## 实现约定

- 网页正文抽取需要新依赖（例如 Readability 加 HTML 转 Markdown），在 I1-3 的 PR 里写明理由与替代方案（AGENTS.md 第 5 条）。
- 向量直接存为 SQLite BLOB，暴力计算余弦相似度，不引入向量数据库或 sqlite 扩展。
- 卡片的输入上限、默认语言写成 Hub 配置，有默认值（约 8k token、中文）。
- 失败不自动重试（ADR 0005）。同一捕获的重试记为新的一次 attempt。
- 测试只用 `fixtures/` 的合成网页、合成 PDF 与假模型；不访问真实网站与模型服务（AGENTS.md 第 6、7 条）。

## 验收要点

- 粘贴一篇网页链接：几秒内在 Inbox 出现，处理完成后有卡片；vault 中出现 `library/sources/` 的实体、`files/originals/` 的原文和 `ai/notes/` 的 AI 笔记，
  实体正文开头嵌入 AI 笔记，其余为空模板。
- 粘贴 arXiv 链接：生成 `paper`（citekey 规则不变），原文来自 arXiv HTML；重复粘贴同一篇（含不同版本号或 abs/pdf 链接）返回已有实体。
- 未配置摘要用途：资料照常入库，Inbox 显示"未生成卡片"；配置后可以补做。
- 分拣：存档后 `status: reference`，离开 Inbox；丢弃后三个文件都进回收站，恢复后一起恢复；再次捕获同一链接时提示曾丢弃。
- 搜索原文中才出现的词，能找到该资料并标明"命中原文"；私密笔记不出现在任何结果中，也不生成向量。
- 内网地址（如 `http://127.0.0.1:7420`、`http://192.168.1.1`）和重定向到内网的链接被拒绝。
- agent 能读原文与 AI 笔记、能用检索；不能捕获、分拣、改实体或原文。
- 合成网页正文中写入"忽略之前的指令……"之类的文字：卡片照常生成，内容里只是转述，不产生任何操作。

## 不做

- 分块级检索与原文段落定位；Assistant 在每条消息前自动注入相关资料（第一版由 AI 按需调用检索）。
- 持久化关联建议、"已采纳 / 已忽略"列表、所有资料两两之间的关联。
- 定时提醒"想读"的资料。
- 语音里的想法、待办进入 Inbox。
- agent 代为捕获。
- 下载网页图片、保存视频或音频原件、PDF 标注。
