# 任务说明

每份任务说明是一个**纵向切片**：做完后能直接使用，并且可以独立验证。
按编号顺序实现，后一个切片可以依赖前一个切片的代码。

| 编号 | 内容 | 负责 | 依赖 |
|---|---|---|---|
| [P0-1](P0-1-sync.md) ✅ | 补全器 + `lumio sync` | 后端（Codex） | — |
| [P0-2](P0-2-new-idea.md) ✅ | `lumio new idea` | 后端（Codex） | P0-1 |
| [P0-3](P0-3-new-paper.md) ✅ | `lumio new paper` | 后端（Codex） | P0-1 |
| [P0-4](P0-4-auto-citekey.md) ✅ | citekey 全自动生成，删除确认流程 | 后端（Codex） | P0-3 |
| [P0-5](P0-5-new-entity-schemas.md) ✅ | schema：source、post、asset，卡号防护 | Claude 起草，人类批准 | P0-4 |
| [P0-6](P0-6-vault-layout.md) ✅ | vault 目录分组与路径映射 | 后端 | P0-5 |
| P0-7 ✅ | 迁移真实 vault 到新目录（清单见 P0-6 末尾） | 人类 + Claude | P0-6 |
| [P1-1](P1-1-index-query.md) ✅ | 本地索引与查询：`search`/`show`/`links`/`export bib` | 后端（Codex） | P0-7 |
| [P1-2](P1-2-hub-server.md) ✅ | Hub 骨架：配置、令牌、查询 API、CLI 远程模式 | 后端（Codex） | P1-1 |
| [P1-3](P1-3-watch-autosave.md) ✅ | 文件监听、自动补全、自动提交 | 后端（Codex） | P1-2 |
| [P1-4](P1-4-proposals.md) ✅ | 操作与提议框架（链接部分已由 ADR 0018 取代） | 后端（Codex） | P1-3 |
| [P1-5](P1-5-cite-check-backup.md) ✅ | 按引用导出 BibTeX、断链检查、Hub 备份 | 后端（Codex） | P1-4 |
| [P1-6](P1-6-skill.md) ✅ | `skills/lumio/SKILL.md`（Claude Code、Codex 自动验收 6 项通过；pi 见待办） | Claude | P1-5 |
| [P2-0](P2-0-design.md) ✅ | P2 的设计与契约（ADR 0019） | Claude 起草，人类批准 | P1 |
| [P2-1](P2-1-runtime-register.md) ✅ | 执行器骨架：登记、能力、在线情况 | 后端（Codex） | P2-0 |
| [P2-2](P2-2-dispatch-core.md) | 派活的可靠核心（只跑普通命令） | 后端（Codex） | P2-1 |
| [P2-3](P2-3-agent-adapters.md) | 接上 codex、claude、pi | 后端（Codex） | P2-2 |
| [P2-4](P2-4-task-rounds.md) | 任务笔记里的一问一答（做完即可日常使用） | 后端（Codex） | P2-3 |
| [P2-5](P2-5-routines.md) | 例行任务 | 后端（Codex） | P2-4 |
| [P2-6](P2-6-sudo-gate.md) | `lumio sudo`：高权限命令的审批门 | 后端（Codex） | P2-4 |

P1 的设计决定见 ADR 0014、0016、0017、0018；P2 见 ADR 0019 与修订后的 ADR 0005；契约见 `packages/schema/src/` 中的 `query.ts`、`actor.ts`、`operation.ts`、`proposal.ts`、`api.ts`。

## 待办（尚未排期，到时再写成任务说明）

| 内容 | 大约在 | 备注 |
|---|---|---|
| 论文笔记半手动补全：手写的笔记里有 `arxiv` 或 `doi` 时，联网取元数据补齐其余字段 | P1 之后 | 联网放在 CLI 或 Hub，不进 core |
| 语义搜索 / RAG：按意思找笔记，方便按想法引用论文 | P2 之后 | 向量和 `index.sqlite` 放在一起；本地模型还是 API 到时再定 |
| 测试能否调用真实 AI | P2 | 未决定；P2-3、P2-4 的自动测试一律用假的 agent，真实 agent 只做人工验证 |
| Python 实验 SDK | 不做 | 实验结果怎么记由各项目自己的 `AGENTS.md` 决定（ADR 0019 背景） |
| 完整的 AI 权限系统与 Agent 身份生命周期 | P3 之后 | 接在 ADR 0016 预留的 `authorize`、操作、提议上 |
| 自研 agent 执行框架（每轮权限、上下文管理、模型路由、跨设备工具） | P3 之后 | ADR 0019 第 7 节：作为执行器的一种引擎接入 |
| 审批模型、飞书批准 | P3 | ADR 0019 第 7 节 |
| 服务器模式下 Obsidian 怎么用 | 上服务器时 | ADR 0017 第 5 节的三个备选 |
| 改名操作 `note.rename`：自己的客户端经 Hub 改名并同步更新所有引用 | 做自己的客户端时 | ADR 0018 第 4 节 |
| 删除 `related` 字段与 `link.add` 操作 | P2-4 | ADR 0018 第 3 节；已写进 P2-4 |
| pi 验收：在 Codex 里嵌套运行 `run.sh pi` 时，pi 调用命令后被 SIGKILL（137）；单独 `pi -p` 正常 | 人类回到 Mac 时 | 先在自己的终端直接运行 `skills/lumio/eval/run.sh pi`，区分是嵌套环境问题还是 pi 的 bug |
| 多进程并发索引测试在 macOS 上偶发失败过一次（Linux、Mac 上各跑几十次未复现） | 再出现时 | 保留失败输出再查 |

已完成（✅）的任务说明保留当时的原文，其中的 vault 路径（如 `papers/`）以 ADR 0012 的新目录为准。

## 给实现者的约定
- 开始前读 `AGENTS.md`、`docs/DESIGN.md` 和本任务说明；任务说明里列出的 ADR 只在需要了解原因时再读。
- 只做"范围"里列出的事；"不做"里的内容即使顺手也不要做。
- 说明里写明的决定直接照做。遇到说明没有覆盖、又会影响接口或数据格式的问题，
  **停下来提问**，不要自行决定。
- 完成时按 `AGENTS.md` 的要求汇报，并逐条对照"验收标准"说明如何验证。
- **PR 合并时更新 ADR 状态**（ADR 0013）：把这个切片实现的 ADR 小节标为已实现；
  全部实现的 ADR 改为 `Implemented`。
