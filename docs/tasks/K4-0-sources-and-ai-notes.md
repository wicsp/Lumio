# K4-0 知识来源与独立的 AI 笔记

依据：[ADR 0051](../adr/0051-resource-anchors-ai-notes.md)（Accepted，2026-11-10 人类批准并授权直接合并）。
必读：`docs/DESIGN.md`、`docs/design/knowledge.md`（「来源与 AI 笔记」）、`security.md`、`web.md`。

## 目标

AI 写的知识与人写的笔记在文件层面分开；任何知识都能记下来源并找回原始对话或执行记录。
典型流程：人放入一篇资料 → 让 AI 先读 → AI 写一份 AI 笔记（`derived_from` 指向资料）→ 人看摘要、看原文 → 在自己的笔记里嵌入那份 AI 笔记。
对话中说"把这个记下来"→ AI 写 AI 笔记，`derived_from` 记当前消息 ID → 以后从笔记一键回到那条消息。

## 现状

- `ResourceRef` 与各模块 ID 前缀已存在（`packages/schema/src/work.ts`、`common.ts`），消息 `amsg_`、Job、日志事件都有稳定 ID。
- post 已有 `derived_from: Id[]`。知识的 AI 产出目前只有 `<!-- lumio:ai -->` 区块（`packages/knowledge/src/blocks.ts`），agent 没有任何知识写入能力。

## 切片

| 编号 | 内容 | 负责 | 改动范围 |
|---|---|---|---|
| K4-1 | 契约：`ai-note` 类型与 `ain` 前缀、`VAULT_LAYOUT` 增加 `ai/notes/`、公共字段 `derived_from`（ID 或 URL，post 放宽）、能力 `knowledge.ainote.create` / `knowledge.ainote.update` 的参数与结果 | Claude 起草（ADR 已批准） | `packages/schema` |
| K4-2 | 知识与索引：补全器支持 `ai-note`；索引保存 `derived_from` 反向关系与正文 `lumio:<ID>` 跨模块引用；AI 笔记出链不计入人的链接图与引用导出、图谱可区分；不再向知识笔记写 AI 区块 | 后端（Codex） | `packages/knowledge`、`packages/storage` |
| K4-3 | Hub：两项 agent 能力（直接执行并记录执行者、带 SHA-256 版本、`derived_from` 可见性检查、只能写 `ai/notes/`）；`GET` 解析任意 ID 到可见摘要（供 `lumio:` 链接与来源展示）；删除对话/任务时返回被知识引用的数量；内置助手与原生会话 MCP 接上新能力 | 后端（Codex） | `apps/hub`、`packages/assistant`（如需） |
| K4-4 | Web：渲染 `lumio:` 链接与来源列表（不可见/已删除状态）；单独成段指向 AI 笔记的链接渲染为标明 AI 的可折叠卡片；AI 笔记详情页显示来源与生成者；删除确认显示引用数 | 前端（Claude） | `packages/api-client`、`apps/web` |

K4-2、K4-3 依赖 K4-1；K4-4 依赖 K4-3 的接口。

## 验收要点

- agent 令牌能新建 / 更新 AI 笔记，不能写其他类型、不能删除；`derived_from` 含私密或不可见资源时拒绝；审计记录执行者。
- 人在 Web 改过 AI 笔记后，AI 用旧版本更新返回 `CONFLICT`。
- 人的笔记里指向 AI 笔记的链接计入链接图；AI 笔记正文里的链接不计入，`export bib` 不取 AI 笔记中的引用。
- `lumio:amsg_…` 链接在 Web 中能打开对应对话并定位到消息；对话进回收站后显示"已在回收站"，恢复后恢复。
- 已有 `<!-- lumio:ai -->` 区块照常被排除，旧任务 / 例行任务笔记的写回不受影响。
- 不做：对话 / 执行记录的检索或自动匹配、自动写入知识或自动提议写入、旧区块迁移。
- 测试只用 `fixtures/` 的合成数据。
