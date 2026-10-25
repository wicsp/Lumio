# P0-3 `lumio new paper`

- 负责：后端（Codex）　Review：Claude
- 相关 ADR：0004、0008、0009、0014
- 涉及：`packages/core`（解析、citekey、渲染，纯本地）、`apps/cli`（联网获取）
- 依赖：P0-1

## 目标
输入 arXiv 号或 DOI，自动生成一篇完整的论文笔记：frontmatter、笔记小节和 BibTeX，
只需要人确认 citekey 的缩写。这是 P0 最核心的切片，直接解决"手填书目信息不现实"的问题。

## 用法
```
lumio new paper <输入> [--vault <路径>] [--abbr <缩写>] [--yes]
```
接受的输入：
- arXiv 号：`2403.14720`、`2403.14720v2`、`arXiv:2403.14720`、旧格式 `hep-th/9901001`
- arXiv 链接：`https://arxiv.org/abs/...`、`https://arxiv.org/pdf/...`（可带 `.pdf` 和版本号）
- DOI：`10.1145/3397271.3401063`、`https://doi.org/10.1145/...`
无法识别时报错，列出接受的格式。版本号只用于识别，存储时去掉。

## 数据来源（全部在 apps/cli 中请求；packages/core 不联网）
| 输入 | 元数据 | BibTeX |
|---|---|---|
| arXiv | arXiv API：`https://export.arxiv.org/api/query?id_list=<id>`（Atom XML） | `https://arxiv.org/bibtex/<id>` |
| DOI | Crossref：`https://api.crossref.org/works/<doi>`（JSON） | `https://doi.org/<doi>`，请求头 `Accept: application/x-bibtex` |

- 所有请求设置 `User-Agent: lumio/<版本>`。如果设置了环境变量 `LUMIO_CONTACT_EMAIL`，
  Crossref 请求附带 `mailto` 参数。**不得在代码里写死任何邮箱。**
- 超时 15 秒；失败时报错退出，说明哪个来源失败，不写任何文件。
- 查询会议、补全正式发表信息（DBLP 等）**不在本切片范围内**。

## 范围

### packages/core（纯函数，可用 fixture 完整测试）
1. **输入识别**：`parsePaperInput(s) → { kind: "arxiv", id } | { kind: "doi", doi }`。
2. **元数据解析**：把 arXiv Atom XML、Crossref JSON 分别转成统一结构：
   标题（合并多余空白）、作者列表（保持顺序）、年份、arxiv、doi、url、venue（仅 Crossref 的
   `container-title` 有值时填写）。解析 XML 所需的库如有必要可以提出，**先问再加**。
3. **citekey 候选**（ADR 0004）：
   - 姓：Crossref 有 `family` 字段时直接用；arXiv 只有全名时取最后一个词。
   - 转写为 ASCII（Unicode NFD 分解后去掉组合附加符号），去掉空格、连字符、撇号，首字母大写。
   - 缩写：标题中第一个冒号之前的部分如果是单个词（如 `LightGCN:`、`AgentDojo:`），就用它；
     否则取标题中前几个实词的首字母大写拼接（去掉 a、an、the、of、for、with、and、on、in、to 等）。
   - 结果必须匹配 `CITEKEY_PATTERN`；匹配不了时视为没有候选。
   - **这只是候选**。实现要清楚地把"候选"和"已确认"区分开（ADR 0004：缩写由人确认）。
4. **BibTeX 处理**：把取回的 BibTeX 条目的 key 改成 citekey，其余内容保持不变。
5. **渲染笔记**：frontmatter（来自同一个补全器，再加上书目字段；值为空的可选字段不写）+ 正文：
   ```markdown
   ## 一句话

   ## 我的笔记

   ## 可以引用的点

   ## 和我的研究的关系

   ## BibTeX
   ```bibtex
   <BibTeX 条目>
   ```
   ```

### apps/cli
6. **确认 citekey**：
   - 显示候选，例如 `citekey: Hines_2024_Spotlighting`，询问"回车确认，或输入新的缩写"。
     输入新缩写时只替换缩写部分，姓和年份不变；结果必须通过 citekey 校验，否则重新询问。
   - `--abbr <缩写>`：直接使用该缩写，不询问。
   - `--yes`：直接接受候选，不询问；没有候选时报错。
   - 标准输入不是终端（非交互）且没有 `--abbr` 或 `--yes` 时：报错退出，提示使用这两个参数。
7. **去重**：写入前检查 vault 的 `papers/`：
   - 已有笔记的 `arxiv` 或 `doi` 与本次相同：报错退出，显示已有的文件。
   - 已有同名 citekey 文件：报错退出，提示用 `--abbr` 换一个缩写（例如加 `b`，见 ADR 0004）。
8. 写入 `papers/<citekey>.md`，输出相对路径，退出码 0。

## 不做
- 不查询 DBLP 或 Semantic Scholar，不升级 BibTeX 为正式发表版本（后续切片）。
- 不下载 PDF，不生成 `refs.bib`，不生成摘要或任何 AI 内容。

## 验收标准
1. `bun run check` 通过。
2. **普通测试一律不联网**：网络请求通过可注入的 fetcher 完成，测试用 `fixtures/` 中保存的真实响应
   （至少：arXiv 的 2002.02126、2403.14720、2406.13352 各一份 Atom XML 与 BibTeX；一份 Crossref JSON
   和对应 BibTeX）。另外提供一个只在设置 `LUMIO_LIVE=1` 时运行的联网冒烟测试。
3. 输入识别：上面列出的每种格式都有测试，包括带版本号和 `.pdf` 后缀的链接。
4. citekey 候选：用三篇 arXiv fixture 分别得到 `He_2020_LightGCN`、`Debenedetti_2024_AgentDojo`、
   以及 Spotlighting 论文的候选（记录实际结果；若与 `Hines_2024_Spotlighting` 不同，在汇报中说明原因）；
   带重音符号的姓（如 Balunović）能正确转写；`van der Maaten` 这类情况在汇报中说明当前行为。
5. 生成的笔记能通过 `Paper` 校验，且**运行 `lumio sync` 后为"补全 0 个"**。
6. 去重测试：相同 arXiv 号、相同 DOI、相同 citekey 三种情况都拒绝写入。
7. 非交互且没有 `--abbr` 或 `--yes` 时报错，不写文件。
