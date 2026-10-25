# Lumio 文档导航

想了解 Lumio，按这个顺序读：本页 → [`ARCHITECTURE.md`](ARCHITECTURE.md) → 需要时再查具体的 ADR。

## 现在在哪一步（2026-10-25）

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 | ✅ 完成 | `lumio new paper`、`lumio new idea`、`lumio sync`；vault 新目录结构；source / post / asset 契约 |
| P0-7 | ⏳ 下一步 | 把真实 vault 迁移到新目录（清单在 [`tasks/P0-6-vault-layout.md`](tasks/P0-6-vault-layout.md) 末尾） |
| P1 | 📋 已规划 | Hub、查询命令、文件监听与自动提交、提议队列、skill（[`tasks/`](tasks/README.md) 中的 P1-1 至 P1-5） |
| P2–P4 | 未开始 | 任务与实验、Runtime、飞书、Web 等，见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 第 5 节 |

## 文档各管什么

| 文档 | 内容 | 谁来改 |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 当前整体设计：架构图、模块、关键规则、阶段 | 人类批准 |
| [`adr/`](adr/) | 每个重要决定的来龙去脉，一个决定一份；修改规则见 ADR 0013 | Claude 起草，人类批准 |
| [`tasks/`](tasks/README.md) | 交给实现者的任务说明，一个切片一份 | Claude 起草 |
| [`../AGENTS.md`](../AGENTS.md) | 所有 AI 必须遵守的规则 | 人类批准 |
| `packages/schema` | 数据格式（契约），代码形式 | Claude 起草，人类批准 |

## 全部 ADR

状态的含义（ADR 0013）：**Implemented** = 已经写进代码，定稿，要改就写新的 ADR；
**Accepted** = 已批准但还没实现，修改要经你批准并记入修订记录；**部分实现** = 已实现的小节定稿，其余仍可改。

| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](adr/0001-monorepo-and-separate-vault.md) | 代码放一个仓库；笔记放独立的 vault，不和代码混在一起 | ✅ Implemented |
| [0002](adr/0002-typescript-on-bun.md) | 全部用 TypeScript，运行在 Bun 上（研究后放弃 Rust） | ✅ Implemented |
| [0003](adr/0003-zod-as-contract.md) | 数据格式用 Zod 写，再导出 JSON Schema 给其他语言 | ✅ Implemented |
| [0004](adr/0004-paper-citekey-format.md) | 论文 citekey 是 `姓_年份_缩写`，全自动生成，也是文件名 | ✅ Implemented |
| [0005](adr/0005-runtime-execution-semantics.md) | 给 AI 派活时不怕中断：状态不明就交给人，不自动重试 | Accepted（P2） |
| [0006](adr/0006-ai-proposes-human-links.md) | AI 只能提议链接，由人接受；AI 的内容写在标记区块里 | Accepted（P1） |
| [0007](adr/0007-hub-as-single-writer.md) | Hub 是程序写入的唯一裁判；git 只做备份；Hub 只讲 HTTP，请求都要令牌 | 部分实现 |
| [0008](adr/0008-null-means-absent.md) | frontmatter 里留空的字段视为没填 | ✅ Implemented |
| [0009](adr/0009-lumio-owns-metadata.md) | 元数据由 Lumio 补全，Obsidian 只是编辑器；只补缺的，不改已有的 | 部分实现 |
| [0010](adr/0010-cli-and-skill-before-mcp.md) | AI 通过命令行 + skill 使用 Lumio；MCP 以后需要时再加 | Accepted（P1） |
| [0011](adr/0011-p1-hub-design.md) | P1 的 Hub 设计：运行数据放在 vault 外、链接、中文搜索、两种令牌、写入路径 | Accepted（P1） |
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | vault 分六个大类；新增外部资料、发布内容、资产；资产私密、禁存卡号 | 部分实现 |
| [0013](adr/0013-adr-lifecycle.md) | ADR 的生命周期：实现之后才定稿 | ✅ Implemented |

## 几条最容易混淆的规则

- **什么必须经过 Hub？** 修改已有内容的程序写入（接受 AI 的提议、程序字段的更新）。新建笔记和补全元数据不需要。
- **AI 能看到什么？** 除 `life/` 以外的内容。经过 Hub 时，AI 的令牌永远拿不到 `life/`；不经过 Hub 时只能做到默认排除。
- **卡号写进 vault 会怎样？** asset 校验报错；Hub 不会把含卡号的文件提交到 git，也不会收进搜索索引。但文件本身已经同步到 iCloud，需要你手动删掉。
- **两个 AI 会话能同时改仓库吗？** 不能，见 `AGENTS.md` 第 9 条。
