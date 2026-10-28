# P2-10 同时识别标准 Markdown 链接

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：**0022**（第 1 节）、0018（链接写在正文里）
- 涉及：`packages/core`（只动这一个包；CLI 与 Hub 的输出自动带上新的 `source`）
- 契约：`packages/schema/src/query.ts` 的 `LinkSource` 已改为 `["wikilink", "markdown"]`（已合并，**不得修改**）
- 依赖：无（可与 P2-7 至 P2-9 任意顺序进行，但同一时间只有一个会话改仓库）

## 目标
人在任何编辑器里写 `[文字](../ideas/某个想法.md)` 与写 `[[某个想法]]` 效果相同：出现在 `lumio links`、反向链接、`lumio check` 的悬空链接、
`lumio export bib --from` 的引用里。用哪种写法由人决定。

## 范围
1. `extractLinks`：在已经去掉代码块、行内代码、AI 区块的正文里，额外识别 `[文字](目标)`：
   - 不识别图片 `![…](…)`、带协议的地址（`http:`、`https:`、`mailto:`、`obsidian:` 等任何 `scheme:`）、只有 `#标题` 的页内链接、
     引用式链接定义（`[x]: url`，以后再说）。
   - 目标可以用尖括号包起来（`[x](<含 空格.md>)`），可以带标题（`"title"`）；去掉 `#标题` 与 `?…`；做 URL 解码（`%20` → 空格），
     解码失败就按原文处理。
   - 只认指向 `.md` 文件或没有扩展名的目标；其他扩展名（图片、PDF、附件）不是笔记链接，忽略。没有扩展名时补 `.md`。
   - `RawLink` 增加解析需要的信息：`source: "markdown"`，`target` 为解码后的路径（不含 `#`），以及链接所在笔记的路径（用于相对解析）。
2. **解析**（`store.ts` 的索引更新）：
   - `wikilink`：照旧按文件名（唯一才算解析成功）。
   - `markdown`：相对于链接所在笔记的目录解析；以 `/` 开头的相对于 vault 根目录；规范化 `.`、`..`；结果跑出 vault 之外 → 悬空。
     与 `notes.path` 精确匹配才算解析成功（大小写敏感）。
   - 两种来源分别存储，`resolved_path` 的含义不变。索引版本号加 1（首次运行自动重建）。
3. **引用**（`extractCitations` / 导出 BibTeX）：Markdown 链接解析到一篇论文笔记时，与 `[[citekey]]` 一样计入引用；AI 区块里的照旧不计入、计数警告。
4. `plainText`（搜索摘要）已经把 `[文字](…)` 换成文字，确认不需要改。
5. 私密规则不变：指向 `life/` 的链接在默认查询里不出现（与 wikilink 一致）。

## 不做
- Lumio 写链接、改名时自动更新链接（ADR 0018 不变）；引用式链接；HTML `<a href>`。

## 验收标准
1. `bun run check` 通过。
2. 测试（合成 fixtures）：相对路径、`..`、以 `/` 开头、尖括号与空格、`%20`、`#标题`、没有扩展名、图片与外部地址被忽略、
   代码块与行内代码与 AI 区块里的不算、跑出 vault 的为悬空、大小写不同为悬空；同一篇里两种写法指向同一笔记时 `links` 各列一条；
   反向链接与 `check` 包含 Markdown 链接；`export bib --from` 通过 Markdown 链接引用论文。
3. 契约测试：`lumio links --json`、`lumio check --json` 的输出用 `@lumio/schema` 校验，包含 `source: "markdown"`。
