# P1-6 `skills/lumio/SKILL.md`

- 负责：Claude（文档）　Review：人类
- 相关 ADR：0014（第 2、6 节）、0016（错误信息）、0018（AI 只推荐，不写链接）
- 依赖：P1-1 至 P1-5 的命令与 `--json` 输出稳定之后

## 目标
一份让 Claude Code、Codex、pi 都能读懂的 skill，教 AI 什么时候、怎样使用 `lumio`，以及它的边界。

## 内容
1. frontmatter：`name: lumio`，`description` 一句话说明使用时机（查用户的论文笔记、想法、链接；
   为用户正在写的内容推荐相关的已有笔记段落；写报告时生成引用）。
2. 正文控制在一屏以内：
   - 环境变量：`LUMIO_HUB_URL`、`LUMIO_TOKEN`（agent 令牌）。
   - 命令速查与 `--json` 输出的关键字段。
   - **边界**（ADR 0018、0014 第 6 节、ADR 0012）：可以查询、可以新建想法和论文笔记；**不写任何链接**
     （不用 `link add` / `propose link`），不修改已有笔记的正文，不要试图直接编辑 vault 中的文件；
     不要使用 `--include-private`，不要读取 `life/` 目录。
   - **推荐相关笔记的方式**：换几种说法（中文、英文、同义词）`search`，再 `show` 读原文；回复时给出笔记标题、
     `[[文件名]]` 和**相关的那一段原文**，说明为什么相关。是否写进正文、怎么写，由用户决定。
   - **请求被拒绝或需要批准时**：读 `--json` 输出里的 `ApiError`（`code`、`operation`、`reason`）或
     `pending_approval` 里的提议 ID，在对话里告诉用户"我想做什么、为什么需要批准、提议 ID"，不要换个办法绕过去。
   - 写报告时的流程：`search` → `show` → `links` → 用户在报告中写 `[[citekey]]` 或 `\cite{citekey}` →
     `lumio export bib --from <报告> --out <路径>`。
   - 用户改过文件名后，可以用 `lumio check` 列出断掉的链接，告诉用户在哪里，由用户修。
3. `skills/lumio/README.md`：如何把这份 skill 安装到 Claude Code、Codex、pi（各一行命令或路径）。

## 验收标准
1. 人类在三种 agent 中各试一次：让它"找出和我这段话相关的旧笔记"，确认它按 skill 使用命令、
   给出原文段落与 `[[文件名]]`，且没有写任何链接、没有修改文件。
