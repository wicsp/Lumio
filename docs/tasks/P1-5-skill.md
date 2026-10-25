# P1-5 `skills/lumio/SKILL.md`

- 负责：Claude（文档）　Review：人类
- 相关 ADR：0014（第 1、2、6 节）、0016（操作与错误信息）
- 依赖：P1-1 至 P1-4 的命令与 `--json` 输出稳定之后

## 目标
一份让 Claude Code、Codex、pi 都能读懂的 skill，教 AI 什么时候、怎样使用 `lumio`，以及它的边界。

## 内容
1. frontmatter：`name: lumio`，`description` 一句话说明使用时机（查用户的论文笔记、想法、链接；写报告时生成引用；
   提议笔记之间的关联）。
2. 正文控制在一屏以内：
   - 环境变量：`LUMIO_HUB_URL`、`LUMIO_TOKEN`（agent 令牌）。
   - 命令速查与 `--json` 输出的关键字段。
   - **边界**（ADR 0014 第 1、6 节、ADR 0012）：可以查询、可以新建想法和论文笔记、可以提议链接；不能修改已有笔记的正文与链接，
     不要试图直接编辑 vault 中的文件；不要使用 `--include-private`，不要读取 `life/` 目录。
   - **请求被拒绝或需要批准时**：读 `--json` 输出里的 `ApiError`（`code`、`operation`、`reason`）或
     `pending_approval` 里的提议 ID，在对话里告诉用户"我想做什么、为什么需要批准、提议 ID"，不要换个办法绕过去。
   - 写报告时的流程：`search` → `show` → `links` → 在报告中用 `\cite{citekey}` → `export bib`。
3. `skills/lumio/README.md`：如何把这份 skill 安装到 Claude Code、Codex、pi（各一行命令或路径）。

## 验收标准
1. 人类在三种 agent 中各试一次：让它"找出我关于来源边界的笔记并提议一条链接"，确认它按 skill 使用命令，
   且只提交提议、没有直接修改文件。
