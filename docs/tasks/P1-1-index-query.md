# P1-1 本地索引与查询：`search`、`show`、`links`、`export bib`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0004、0014（第 2–7 节）、0012（目录、AI 区块、私密实体、卡号防护）
- 涉及：`packages/core`、`apps/cli`
- 契约：`packages/schema/src/query.ts`（已由 Claude 起草并经人类批准，**本任务不得修改**）

## 目标
不需要 Hub，直接对本地 vault 建索引并查询。做完后，AI 就能在 shell 里查你的笔记和链接，
写论文时也能一条命令生成 `refs.bib`。

## 用法
```
lumio search <查询> [--type paper|idea|…] [--limit N] [--include-private] [--json]
lumio show   <引用> [--include-private] [--json]
lumio links  <引用> [--include-private] [--json]
lumio export bib [--out <路径>]          # 默认写到 library/refs.bib
```
**引用**可以是 ID、论文 citekey，或文件名（不含 `.md`）。匹配不到或匹配到多个时报错，列出候选。

**目录一律通过 `@lumio/core` 的 `VAULT_LAYOUT` / `entityDirectory()` 取得**（P0-6），不得写死路径。

## 范围

### packages/core
1. **索引**（`index/`）：使用 Bun 内置的 `bun:sqlite`，**不引入新依赖**。
   - 位置：`<状态目录>/index.sqlite`；状态目录取 `LUMIO_STATE_DIR`，默认 `~/.local/share/lumio/`。
   - 表：笔记（id、type、title、path、citekey、mtime、size、frontmatter JSON、正文）、链接（from、source、target、
     解析结果）、全文（FTS5，`tokenize='trigram'`）。
   - **增量更新**：每次查询前扫描 vault，按（路径、mtime、size）比对，只重新解析有变化的文件，删除已不存在的文件。
     索引文件损坏或 schema 版本不符时，删除后重建。
   - 不符合 schema 的笔记（如缺 id）**仍然进入全文索引**，但没有 ID 的笔记不能被 ID 引用；`show`/`links` 可按文件名引用它们。
   - **原始文本含疑似卡号的文件不进入索引**（用 `@lumio/schema` 的 `textContainsCardNumber`，ADR 0012），
     查询时也不会出现；`lumio search` 的人类可读输出末尾提示"有 N 个文件因疑似含卡号未被索引"，只给路径。
   - 每篇笔记记录 `private`（来自 `scanVault`）。
2. **链接解析**（ADR 0014 第 4 节）：
   - `related` 中的每个 ID → 按 ID 解析。
   - 正文中的 `[[名称]]`、`[[名称|别名]]`、`[[名称#标题]]` → 去掉 `|…` 与 `#…` 后按文件名（不含扩展名）解析；
     忽略代码块（``` 围起来的部分）和行内代码中的内容。
   - 解析不到的标记为悬空链接（`dangling: true`）。
   - `<!-- lumio:ai start … -->` 与 `<!-- lumio:ai end … -->` 之间的 `[[ ]]` **不计入链接图**（ADR 0012 第 3 节：
     AI 区块中的链接不属于人）。把它们标记为"AI 提议"需要扩展契约，留到以后。
3. **搜索**（ADR 0014 第 5 节）：
   - 查询 ≥ 3 个字符：FTS5 trigram，按相关度排序。
   - 查询 < 3 个字符：退回 `LIKE '%…%'`（转义 `%`、`_`），按修改时间倒序。
   - 范围：标题、正文、作者、citekey、tags。`snippet` 取第一个命中位置前后的纯文本，不超过 200 个字符。
4. **私密实体**（ADR 0012 第 6 节）：`search`、`show`、`links` 默认排除 `private` 的笔记（包括出现在别人的
   链接列表里时，按悬空处理）；`--include-private` 时才包含。本地模式无法分辨调用者，只能做到默认排除；
   强制执行在 P1-2 的 Hub 中。`export bib` 永远不包含私密实体。
5. **`export bib`**：遍历 paper 类型目录（`entityDirectory("paper")`），取每篇笔记 `## BibTeX` 一节中 ```` ```bibtex ```` 代码块的内容，
   按 citekey 排序拼接，文件开头写注释"本文件由 lumio 生成，请勿手动编辑"。
   代码块的 key 与笔记 citekey 不一致时：用笔记的 citekey 改写 key（复用 `rewriteBibtexKey`），并在输出中警告。
   缺少 BibTeX 一节的论文：跳过并警告。写文件使用已有的 `writeFileAtomic`。

### apps/cli
6. 四个新命令。`--json` 时输出**严格符合** `@lumio/schema` 中 `SearchResult`、`NoteDetail`、`LinksResult`
   的 JSON（单个对象、末尾一个换行）；否则输出给人看的文本。错误一律输出到 stderr、退出码 1。
7. 本任务中查询只有本地模式；`LUMIO_HUB_URL` 的支持在 P1-2 中加入。

## 不做
- 不实现 Hub、文件监听、令牌、提议。
- 不改 `packages/schema`。
- 不做语义搜索、向量检索。

## 验收标准
1. `bun run check` 通过。
2. 用 `fixtures/` 中新建的合成 vault（ADR 0012 的目录结构；至少 10 篇笔记，包含中文和英文、带 related 与各种 `[[ ]]` 写法、
   一个悬空链接、一个代码块里的 `[[假链接]]`、一个 AI 区块里的 `[[链接]]`、一篇缺 id 的笔记、一个 `life/assets/` 下的
   私密笔记、一个正文含疑似卡号的笔记）测试：
   - 中文 2 字查询（如"来源"）与 ≥ 3 字查询都能命中；英文大小写不敏感。
   - `links` 的出链、反向链接、悬空链接都正确；代码块中的 `[[ ]]` 被忽略。
   - 引用解析：ID、citekey、文件名三种都能用；重名时报错并列出候选。
   - AI 区块里的链接不出现在 `links` 结果中。
   - 私密笔记默认不出现在 `search`、`show`、`links` 中，加 `--include-private` 后出现；`export bib` 不受该参数影响。
   - 含疑似卡号的笔记搜不到，且输出中不出现该数字。
3. 所有 `--json` 输出用对应 schema 的 `parse` 验证通过（测试中直接断言）。
4. 增量更新：修改一个文件后再查询能看到新内容；删除文件后不再出现；未变化的文件不被重新解析（可通过注入的计数器断言）。
5. `export bib`：生成内容可预测（按 citekey 排序）、key 被纠正时有警告、缺 BibTeX 时跳过并警告；连续运行两次文件不被重写。
6. 测试不读写真实 vault 和真实的 `~/.local/share/lumio/`（通过 `LUMIO_STATE_DIR` 指向临时目录）。
