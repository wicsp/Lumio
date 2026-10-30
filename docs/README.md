# Lumio 文档导航

| 想知道 | 读这个 |
|---|---|
| Lumio 现在是怎么设计的、有哪些规则 | [`DESIGN.md`](DESIGN.md)（**唯一的现行设计说明**） |
| AI 必须遵守什么 | [`../AGENTS.md`](../AGENTS.md) |
| 接下来要做什么 | [`tasks/README.md`](tasks/README.md) |
| 某条规则**为什么**这样定 | `adr/` 中对应的 ADR（DESIGN.md 里每条规则都标了编号） |
| 数据格式的精确定义 | `packages/schema` |

## 现在在哪一步（2026-10-25）

P0 与 P0-7（真实 vault 迁移）已完成；P1-1 至 P1-4 已完成（P1-4 的链接部分由 ADR 0018 取代）；P1-5（按引用导出、断链检查、Hub 备份）已完成；P1 已完成（skill 在 Claude Code、Codex 上验收通过，pi 待补）；P2 已设计完（ADR 0019），P2-1（执行器骨架）已完成，实验室服务器已作为执行器在线；P2-2（派活的可靠核心）已完成；P2-3（agent 适配器）已完成；P2-4（任务笔记里的一问一答，`related` 与 `link.add` 已删除）已完成，P2 已能日常使用；P2-5（例行任务）已完成；P2-6（`lumio-runtime sudo` 审批门，ADR 0020）已完成，P2 的功能全部完成，Codex 已交叉 review P2-3 至 P2-5 并修复。第一次人工验收卡在安装上，因此先做 **P2-7 至 P2-10：一条命令安装、执行器配对、自检、识别 Markdown 链接**（ADR 0021、0022），之后再验收、规划 P3。需要人类动手的验收见 [`tasks/README.md`](tasks/README.md) 的"等人类回来处理"。阶段表见 [`DESIGN.md`](DESIGN.md) 第 8 节。

## 文档各管什么

| 文档 | 写什么 | 写法 | 谁来改 |
|---|---|---|---|
| `DESIGN.md` | 现在是什么样 | 随时改成最新，不留历史 | Claude 起草，人类批准 |
| `adr/` | 为什么这样决定 | 只追加；实现后定稿（ADR 0013） | Claude 起草，人类批准 |
| `tasks/` | 一个切片要做什么、怎么验收 | 做完后保留原文 | Claude 起草 |
| `AGENTS.md` | AI 的硬规则 | 随时改成最新 | 人类批准 |

改 ADR 的 PR 必须同时改 `DESIGN.md`（ADR 0015）。

## ADR 索引（按领域）

状态：**Implemented** = 已写进代码，定稿；**Accepted** = 已批准未实现，修改需批准并记修订记录；
**部分实现** = 已实现的小节定稿，其余仍可改。一条 ADR 可能出现在多个领域下。

**工程基础**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](adr/0001-monorepo-and-separate-vault.md) | 代码放一个仓库；笔记放独立的 vault | Implemented |
| [0002](adr/0002-typescript-on-bun.md) | 全部用 TypeScript + Bun（研究后放弃 Rust） | Implemented |
| [0003](adr/0003-zod-as-contract.md) | 数据格式用 Zod 写，导出 JSON Schema 给其他语言 | Implemented |

**数据**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](adr/0001-monorepo-and-separate-vault.md) | vault 是知识的唯一事实来源 | Implemented |
| [0004](adr/0004-paper-citekey-format.md) | 论文 citekey 是 `姓_年份_缩写`，全自动生成，也是文件名 | Implemented |
| [0008](adr/0008-null-means-absent.md) | frontmatter 里留空的字段视为没填 | Implemented |
| [0009](adr/0009-lumio-owns-metadata.md) | 元数据由 Lumio 补全；只补缺的，不改已有的 | 部分实现 |
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | vault 六个大类；外部资料、发布内容、资产三种新类型 | 部分实现 |
| [0018](adr/0018-links-in-body-ai-recommends.md) | 链接只写在正文；改名只在受控环境；导出时从正文找引用 | Implemented |

**Hub 与运行**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0005](adr/0005-runtime-execution-semantics.md) | 给 AI 派活不怕中断：一轮只执行一次，状态不明就交给人 | Accepted（P2） |
| [0019](adr/0019-hub-runtimes-tasks-rounds.md) | Hub 与执行器；任务生命周期（交接现见 0024）；一个任务很多轮；例行任务；派活的安全底线 | Accepted（P2） |
| [0007](adr/0007-hub-as-single-writer.md) | Hub 是程序写入的唯一裁判；git 只做备份；只讲 HTTP | 部分实现 |
| [0014](adr/0014-hub-and-ai-access.md) | Hub 的存放、链接、搜索、写入路径、自动提交 | 部分实现（第 4、5 节） |
| [0016](adr/0016-operations-actors-authorization.md) | 每次修改都是一个操作，统一授权；审计与 git trailer | Implemented |
| [0017](adr/0017-single-machine-deployment.md) | Hub 与 vault 同机、只有一个 Hub；单用户（远程访问与 vault 同步部分由 0022 取代） | Accepted（P1，部分被取代） |

**AI 协作与权限**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | AI 内容写在标记区块里；`life/` 私密 | 部分实现 |
| [0014](adr/0014-hub-and-ai-access.md) | AI 只能提议；入口是 CLI + skill；两种令牌 | Accepted（P1） |
| [0016](adr/0016-operations-actors-authorization.md) | 身份与令牌分开；允许 / 拒绝 / 需要批准；错误带决策信息 | Implemented |
| [0018](adr/0018-links-in-body-ai-recommends.md) | 链接写在正文里；AI 只推荐不写链接；`related` 弃用 | Implemented |
| [0019](adr/0019-hub-runtimes-tasks-rounds.md) | 执行器只能领活和回报；AI 的汇报不能派活；`lumio sudo` 需要批准 | Accepted（P2） |
| [0020](adr/0020-privileged-exec-signed-approvals.md) | 高权限命令：Hub 签名的一次性批准凭据，root 助手程序自己验证 | Implemented |
| [0021](adr/0021-install-pairing-selftest.md) | 安装、配对与自检：发布编译好的程序，装 Hub 一行、每台执行器一行，`doctor`/`selftest` 代替手动清单 | Accepted（P2-7 至 P2-9） |
| [0022](adr/0022-editor-agnostic-deployment-modes.md) | 编辑器无关；单机 / 服务器两种部署模式；网络由部署者负责，Tailscale 只是补充 | Accepted |
| [0023](adr/0023-write-switch-fields.md) | 补全时写出开关字段（任务交接现见 0024） | Implemented |

| [0024](adr/0024-assignee-string-default-workdir.md) | `assignee: pi@server` 作为交接开关；`workdir` 缺省 `~` | Implemented（P2-13） |

**安全**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0007](adr/0007-hub-as-single-writer.md) | 所有请求都要令牌；HTTPS 交给反向代理 | 部分实现 |
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | 禁存卡号；卡号写法 + Luhn 校验 | 部分实现 |
| [0014](adr/0014-hub-and-ai-access.md) | 含卡号的文件不提交、不索引；私密由令牌角色执行 | Accepted（P1） |
| [0017](adr/0017-single-machine-deployment.md) | Hub 默认只监听本机（远程访问方式由 0022 取代：网络由部署者负责） | Accepted（P1，部分被取代） |
| [0020](adr/0020-privileged-exec-signed-approvals.md) | root 只能凭 Hub 签名、一次性的批准凭据执行 | Implemented |

**流程**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0013](adr/0013-adr-lifecycle.md) | ADR 实现之后才定稿 | Implemented |
| [0015](adr/0015-design-doc-and-adr-domains.md) | DESIGN.md 写现行规则，ADR 只记原因；按领域打标签 | Implemented |

已删除的编号：0006、0010、0011（未实现，合并为 0014）。编号不复用。
