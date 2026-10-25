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
| [P1-4](P1-4-proposals.md) | 提议队列 | 后端（Codex） | P1-3 |
| [P1-5](P1-5-skill.md) | `skills/lumio/SKILL.md` | Claude | P1-4 |

P1 的设计决定见 ADR 0014、0016、0017；契约见 `packages/schema/src/` 中的 `query.ts`、`actor.ts`、`operation.ts`、`proposal.ts`、`api.ts`。

## 待办（尚未排期，到时再写成任务说明）

| 内容 | 大约在 | 备注 |
|---|---|---|
| 论文笔记半手动补全：手写的笔记里有 `arxiv` 或 `doi` 时，联网取元数据补齐其余字段 | P1 之后 | 联网放在 CLI 或 Hub，不进 core |
| 语义搜索 / RAG：按意思找笔记，方便按想法引用论文 | P2 之后 | 向量和 `index.sqlite` 放在一起；本地模型还是 API 到时再定 |
| 测试能否调用真实 AI | P2 | 未决定 |
| 完整的 AI 权限系统与 Agent 身份生命周期 | P3 之后 | 接在 ADR 0016 预留的 `authorize`、操作、提议上 |
| 服务器模式下 Obsidian 怎么用 | 上服务器时 | ADR 0017 第 5 节的三个备选 |

已完成（✅）的任务说明保留当时的原文，其中的 vault 路径（如 `papers/`）以 ADR 0012 的新目录为准。

## 给实现者的约定
- 开始前读 `AGENTS.md`、`docs/DESIGN.md` 和本任务说明；任务说明里列出的 ADR 只在需要了解原因时再读。
- 只做"范围"里列出的事；"不做"里的内容即使顺手也不要做。
- 说明里写明的决定直接照做。遇到说明没有覆盖、又会影响接口或数据格式的问题，
  **停下来提问**，不要自行决定。
- 完成时按 `AGENTS.md` 的要求汇报，并逐条对照"验收标准"说明如何验证。
- **PR 合并时更新 ADR 状态**（ADR 0013）：把这个切片实现的 ADR 小节标为已实现；
  全部实现的 ADR 改为 `Implemented`。
