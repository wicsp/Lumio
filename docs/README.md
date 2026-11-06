# Lumio 文档导航

| 想知道 | 读这个 |
|---|---|
| Lumio 现在是怎么设计的、有哪些规则 | [`DESIGN.md`](DESIGN.md)（**现行设计总览**）与 [`design/`](design/) 下的分册 |
| AI 必须遵守什么 | [`../AGENTS.md`](../AGENTS.md) |
| 接下来要做什么 | [`tasks/README.md`](tasks/README.md)；当前：[R1-0 v0.2 上线](tasks/R1-0-v0.2-release.md)、[R2-0 v0.2.1](tasks/R2-0-language-terminal-theme.md) |
| 四模块重构的目标与实施顺序 | [ADR 0025](adr/0025-four-module-architecture.md)（Accepted，大部分已实现）、[R0-0](tasks/R0-0-four-module-refactor.md) |
| Web GUI 启动、配置与功能 | [工作台说明](../apps/web/README.md)、[P4-1](tasks/P4-1-web-workbench.md) |
| 助手模型配置、显式记忆与工具权限 | [助手使用](assistant.md) |
| 旧任务笔记切换数据库、备份与回退 | [迁移与回退](migration-v2.md) |
| 某条规则**为什么**这样定 | 设计文档里标注的 ADR、任务或 PR 编号 |
| 数据格式的精确定义 | `packages/schema` |

## 现在在哪一步（2026-11-02）

P0、P1、P2 全部完成（P2-1 至 P2-13，最新发布 v0.1.6），Mac 单机安装与实验室服务器执行器已人工验收。
ADR 0025 的四模块重构已合入：业务库、显式委派、Routine、助手对话与显式记忆、可配置模型适配、JSONL/产物和完整业务备份，以及可核查的旧数据迁移。
实现证据与交叉 review 见 [R0-0](tasks/R0-0-four-module-refactor.md)。真实数据迁移、已安装服务升级和发布单独安排；未排期的待办见 [`tasks/README.md`](tasks/README.md)，阶段表也在 [`tasks/README.md`](tasks/README.md)。

## 文档各管什么

| 文档 | 写什么 | 写法 | 谁来改 |
|---|---|---|---|
| `DESIGN.md` + `design/` | 现在是什么样：总览与各模块的规则和边界 | 随时改成最新，不留历史；每个文件 ≤ 15 KB | Claude 起草，人类批准 |
| `adr/` | 架构级决定为什么这样定 | 只为架构级决定写（ADR 0036）；只追加；实现后定稿（ADR 0013） | Claude 起草，人类批准 |
| `tasks/` | 一个切片要做什么、怎么验收；小功能的具体需求；阶段表 | 做完后保留原文 | Claude 起草 |
| `AGENTS.md` | AI 的硬规则 | 随时改成最新 | 人类批准 |

改 ADR 的 PR 必须同时改设计文档（ADR 0015）；反过来，小改动直接改设计文档或只写任务说明，不写 ADR（ADR 0036，判断方法见 [`DESIGN.md`](DESIGN.md) 第 5 节）。

## ADR 索引（按领域）

状态：**Implemented** = 已写进代码，定稿；**Accepted** = 已批准未实现，修改需批准并记修订记录；
**部分实现** = 已实现的小节定稿，其余仍可改。一条 ADR 可能出现在多个领域下。

**客户端**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0026](adr/0026-web-workbench.md) | Web 工作台：同源代理、登录保持与四模块 GUI | Implemented（第 2 节由 0027 取代） |
| [0027](adr/0027-v0.2-rollout.md) | v0.2 上线：一个程序、Hub 提供 Web 与 PWA、助手模型配置、旧任务笔记直接退役 | Accepted |
| [0028](adr/0028-language-terminal-theme.md) | 界面语言（默认英文、中文环境用中文）、终端输出样式、Web 主题切换 | Accepted |
| [0035](adr/0035-live-note-editing-and-related-notes.md) | 笔记实时预览编辑、相关推荐、`[[` 候选与上标脚注 | Accepted |
| [0037](adr/0037-content-autosave-and-local-drafts.md) | 内容自动保存与按账户隔离的浏览器恢复副本 | Accepted |
| [0038](adr/0038-delete-and-trash.md) | 删除项目、任务、笔记和对话：移入回收站，30 天内可恢复 | Implemented |

**工程基础**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](adr/0001-monorepo-and-separate-vault.md) | 代码放一个仓库；笔记放独立的 vault | Implemented |
| [0002](adr/0002-typescript-on-bun.md) | 全部用 TypeScript + Bun（研究后放弃 Rust） | Implemented |
| [0003](adr/0003-zod-as-contract.md) | 数据格式用 Zod 写，导出 JSON Schema 给其他语言 | Implemented |
| [0025](adr/0025-four-module-architecture.md) | 知识、工作、执行、助手四模块；数据库、Markdown 与 JSONL 分工 | Accepted（部分实现） |

**数据**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0001](adr/0001-monorepo-and-separate-vault.md) | vault 是知识的唯一事实来源 | Implemented |
| [0004](adr/0004-paper-citekey-format.md) | 论文 citekey 是 `姓_年份_缩写`，全自动生成，也是文件名 | Implemented |
| [0008](adr/0008-null-means-absent.md) | frontmatter 里留空的字段视为没填 | Implemented |
| [0009](adr/0009-lumio-owns-metadata.md) | 元数据由 Lumio 补全；只补缺的，不改已有的 | 部分实现 |
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | vault 六个大类；外部资料、发布内容、资产三种新类型 | 部分实现 |
| [0018](adr/0018-links-in-body-ai-recommends.md) | 链接只写在正文；改名只在受控环境；导出时从正文找引用 | Implemented |
| [0032](adr/0032-task-model-outcome-turn.md) | 任务模型：结局、轮到谁、事件；交接计划取代流程 | Accepted |
| [0034](adr/0034-knowledge-creation-and-authoring.md) | 知识新建入口、类型模板与后续写作 | Accepted（第 1–5 节） |

**Hub 与运行**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0005](adr/0005-runtime-execution-semantics.md) | 给 AI 派活不怕中断：一轮只执行一次，状态不明就交给人 | Implemented |
| [0019](adr/0019-hub-runtimes-tasks-rounds.md) | Hub 与执行器；任务生命周期（交接现见 0024）；一个任务很多轮；例行任务；派活的安全底线 | Implemented |
| [0007](adr/0007-hub-as-single-writer.md) | Hub 是程序写入的唯一裁判；git 只做备份；只讲 HTTP | Implemented |
| [0014](adr/0014-hub-and-ai-access.md) | Hub 的存放、链接、搜索、写入路径、自动提交 | Implemented（链接部分由 0018 取代） |
| [0016](adr/0016-operations-actors-authorization.md) | 每次修改都是一个操作，统一授权；审计与 git trailer | Implemented |
| [0017](adr/0017-single-machine-deployment.md) | Hub 与 vault 同机、只有一个 Hub；单用户（远程访问与 vault 同步部分由 0022 取代） | Implemented（部分被取代） |
| [0030](adr/0030-round-questions-and-review.md) | 一轮里的提问与验收；需要你处理只看最新一轮 | Accepted |
| [0033](adr/0033-project-workdir-proposal-withdrawal-targets.md) | 项目工作目录、提议撤回与执行目标查询 | Accepted |

**AI 协作与权限**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | AI 内容写在标记区块里；`life/` 私密 | 部分实现 |
| [0014](adr/0014-hub-and-ai-access.md) | AI 只能提议；入口是 CLI + skill；两种令牌 | Implemented（链接部分由 0018 取代） |
| [0016](adr/0016-operations-actors-authorization.md) | 身份与令牌分开；允许 / 拒绝 / 需要批准；错误带决策信息 | Implemented |
| [0018](adr/0018-links-in-body-ai-recommends.md) | 链接写在正文里；AI 只推荐不写链接；`related` 弃用 | Implemented |
| [0019](adr/0019-hub-runtimes-tasks-rounds.md) | 执行器只能领活和回报；AI 的汇报不能派活；`lumio sudo` 需要批准 | Implemented |
| [0020](adr/0020-privileged-exec-signed-approvals.md) | 高权限命令：Hub 签名的一次性批准凭据，root 助手程序自己验证 | Implemented |
| [0021](adr/0021-install-pairing-selftest.md) | 安装、配对与自检：发布编译好的程序，装 Hub 一行、每台执行器一行，`doctor`/`selftest` 代替手动清单 | Implemented |
| [0022](adr/0022-editor-agnostic-deployment-modes.md) | 编辑器无关；单机 / 服务器两种部署模式；网络由部署者负责，Tailscale 只是补充 | 部分实现（官方 GUI 与改名操作未做） |
| [0023](adr/0023-write-switch-fields.md) | 补全时写出开关字段（任务交接现见 0024） | Implemented |
| [0024](adr/0024-assignee-string-default-workdir.md) | `assignee: pi@server` 作为交接开关；`workdir` 缺省 `~` | Implemented（P2-13） |
| [0029](adr/0029-capabilities-and-agent-access.md) | 能力目录与 agent 访问：Lumio 记录与决策，agent 是可替换的手 | Accepted |
| [0031](adr/0031-workflows-delegation-push.md) | 交接计划与 agent 接力、委派需要批准、统一推送（先做 PWA） | Accepted |

**安全**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0007](adr/0007-hub-as-single-writer.md) | 所有请求都要令牌；HTTPS 交给反向代理 | Implemented |
| [0012](adr/0012-vault-layout-sources-posts-assets.md) | 禁存卡号；卡号写法 + Luhn 校验 | 部分实现 |
| [0014](adr/0014-hub-and-ai-access.md) | 含卡号的文件不提交、不索引；私密由令牌角色执行 | Implemented |
| [0017](adr/0017-single-machine-deployment.md) | Hub 默认只监听本机（远程访问方式由 0022 取代：网络由部署者负责） | Implemented（部分被取代） |
| [0020](adr/0020-privileged-exec-signed-approvals.md) | root 只能凭 Hub 签名、一次性的批准凭据执行 | Implemented |

**流程**
| 编号 | 一句话 | 状态 |
|---|---|---|
| [0013](adr/0013-adr-lifecycle.md) | ADR 实现之后才定稿 | Implemented |
| [0015](adr/0015-design-doc-and-adr-domains.md) | DESIGN.md 写现行规则，ADR 只记原因；按领域打标签 | Implemented（第 1、2 节由 0036 修订） |
| [0036](adr/0036-adr-threshold-and-design-split.md) | 只为架构级决定写 ADR；现行设计拆成总览加分册，每个文件 ≤ 15 KB | Implemented |

已删除的编号：0006、0010、0011（未实现，合并为 0014）。编号不复用。
