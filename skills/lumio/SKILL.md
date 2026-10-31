---
name: lumio
description: 查用户（Wenbin）的研究笔记库：论文笔记、想法、外部资料、它们之间的链接；为用户正在写的内容推荐相关的旧笔记段落；写报告时按正文引用导出 BibTeX。用户提到"我的笔记""我之前写过""相关论文""引用"时使用。
---

# lumio：用户的研究笔记库

笔记是 Markdown 文件，由 Lumio 管理。你通过 `lumio` 命令访问，**只读**。

## 环境
- `LUMIO_HUB_URL`、`LUMIO_TOKEN` 都已设置时走 Hub（正常情况）。令牌是 agent 令牌，看不到私密内容，也不能写链接。
- 没设置时命令会直接读本地 vault；这时同样遵守下面的边界。

## 命令（都加 `--json`，输出是单个 JSON 对象）
| 命令 | 用途 | 关键字段 |
|---|---|---|
| `lumio search <查询> [--type paper\|idea\|source…] [--limit N]` | 全文搜索（中英文子串） | `hits[].note.{title,path,citekey}`、`hits[].snippet` |
| `lumio show <引用>` | 读一篇笔记全文 | `note`、`frontmatter`、`body` |
| `lumio links <引用>` | 出链与反链 | `outgoing[]`、`incoming[]`，`dangling` 为断链 |
| `lumio check` | 列出所有断掉的链接 | `dangling[].{from,target}` |
| `lumio export bib --from <报告> [--out 路径]` | 只导出该笔记正文引用到的论文 | 无 `--out` 时 BibTeX 打到 stdout |

引用可以是 ID、论文的 citekey（如 `He_2020_LightGCN`）或文件名（不含 `.md`）。没有 ID 的笔记结果里没有 `id`，用文件名引用。

## 边界（必须遵守）
- **不写任何链接**：Lumio 没有写链接的命令，链接由用户自己写在正文里。
- **不改文件**：不直接编辑、移动、重命名 vault 里的任何文件，也不用 `lumio sync`。新建笔记只在用户明确要求时用 `lumio new idea|paper`。
- **不碰私密内容**：不用 `--include-private`，不读 `life/` 目录。
- 命令失败时读 JSON 里的 `error.code`、`error.reason`，把原因告诉用户；**不要换个办法绕过去**（比如改用直接读文件）。

## 推荐相关笔记
1. 换几种说法搜：中文、英文、同义词、方法名，各 `search` 一次。`snippet` 很短，候选要用 `show` 读原文。
2. 回复时每条给出：标题、`[[文件名]]`、**相关的那一段原文**（引用原话）、一句话说明为什么相关。
3. 只推荐，不替用户决定。用不用、怎么写进正文，由用户决定。

## 写报告时
`search` → `show` → 用户在报告正文写 `[[citekey]]` 或 `\cite{citekey}` → `lumio export bib --from <报告> --out <路径>`。
导出的警告（找不到的 citekey、AI 区块里未计入的引用）要转告用户。

## 任务笔记（`plan/tasks/`）
- 用户可以把任务交给服务器上的 agent 一轮一轮地做。笔记里 `<!-- lumio:ai start name=round-N … -->` 区块是各轮 agent 的汇报，
  区块以外是用户写的要求和意见。frontmatter 的 `assignee` 表示现在轮到谁（`human`、`pi` 或 `pi@server`）；`workdir` 可以不写，默认执行器上的 `~`。
- 你只能读：**不能派任务**（`lumio task continue` 对 agent 令牌会被拒绝），也不要改 `assignee`、`status`。
- 旧笔记如果还有 `turn`，仍按旧开关运行；不要改旧 `turn` 或自行迁移笔记。`done` / `cancelled` / `paused` 的任务须由人先恢复状态才可派出。
- 用 `lumio show <任务>` 读笔记；问到某一轮的细节时，告诉用户用 `lumio job show <job>` 查看完整汇报。

## 例行任务（`plan/routines/`）
- 按 `schedule` 自动执行的模板；每次的结果追加在笔记里的 `run-…` 区块。`lumio routine list` 看计划、下次与上次。
- 想就某一次追问由用户运行 `lumio routine followup <例行任务> <日期>`（agent 令牌会被拒绝）。

## 高权限命令审批
- `exec.privileged` 提议来自服务器上一轮之内的 agent。用户用 `lumio proposals` 查看执行器、命令、来源与理由，
  用 `lumio proposals accept|reject <ID>` 作决定。需要 root 的执行器 agent 用 `lumio-runtime sudo -- <绝对路径程序> [参数…]` 申请并等待。
- AI 可以解释命令的作用和影响，**不能替用户接受**（agent 令牌会被拒绝），不要建议用户不看就接受。

## 其他
- 正文里 `<!-- lumio:ai start … -->` 到 `<!-- lumio:ai end … -->` 之间是 AI 写的草稿，不是用户的观点；引用用户观点时不要用这部分。
- 用户改过文件名后，可以用 `lumio check` 找出断链，告诉用户在哪里，由用户修。
