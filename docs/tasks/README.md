# 任务说明

每份任务说明是一个**纵向切片**：做完后能直接使用，并且可以独立验证。
按编号顺序实现，后一个切片可以依赖前一个切片的代码。

**实施中的重构**：[R0-0 四模块重构](R0-0-four-module-refactor.md)列出后续切片、迁移与验收要求；
依据 [ADR 0025](../adr/0025-four-module-architecture.md)（Accepted，2026-10-31 人类批准并授权持续实施）。
具体契约由 Claude 起草，按切片实现并同步 DESIGN，不读取真实 vault。

已落地的分支切片：[R0-3 公共维护](R0-3-platform-maintenance.md)、[R0-5 设备登记](R0-5-runtime-registry.md)、
[R0-7 显式记忆](R0-7-assistant-memory.md)、[R0-7 模型适配](R0-7-model-adapter.md)、[R0-7 上下文记录](R0-7-assistant-context.md)、[R0-1 契约](R0-1-contracts.md)、[R0-5 数据库 Routine](R0-5-execution-routines.md)、
[R0-6 日志、文件与业务备份](R0-6-storage-files.md)、[R0-8 显式迁移](R0-8-legacy-import.md)。剩余工作与最终验收以 R0-0 为准。
真实切换另见[迁移与回退说明](../migration-v2.md)，不会在重构测试中执行。

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
| [P2-2](P2-2-dispatch-core.md) ✅ | 派活的可靠核心（只跑普通命令） | 后端（Codex） | P2-1 |
| [P2-3](P2-3-agent-adapters.md) ✅ | 接上 codex、claude、pi | 后端（Codex） | P2-2 |
| [P2-4](P2-4-task-rounds.md) ✅ | 任务笔记里的一问一答（做完即可日常使用） | 后端（Codex） | P2-3 |
| [P2-5](P2-5-routines.md) ✅ | 例行任务 | 后端（Codex） | P2-4 |
| [P2-6](P2-6-sudo-gate.md) ✅ | `lumio-runtime sudo`：高权限命令的审批门（ADR 0020） | 后端（Codex） | P2-4 |
| [P2-7](P2-7-release-and-setup.md) ✅ | 发布编译好的程序；一条命令装好 Hub、CLI 与本机执行器（ADR 0021、0022） | 后端（Codex） | P2-6 |
| [P2-8](P2-8-runtime-pairing.md) ✅ | 加一台执行器、另一台机器上的 CLI：一次性配对码；一条命令装提权助手 | 后端（Codex） | P2-7 |
| [P2-9](P2-9-doctor-selftest-upgrade.md) ✅ | `lumio doctor`、`lumio selftest`、`upgrade` | 后端（Codex） | P2-8 |
| [P2-10](P2-10-markdown-links.md) ✅ | 同时识别标准 Markdown 链接（ADR 0022） | 后端（Codex） | 无 |
| [P2-11](P2-11-acceptance-fixes.md) ✅ | 第一次验收发现的问题：终端输入、Tailscale 询问、重新登录、写出开关字段（ADR 0023） | 后端（Codex） | P2-8 |
| [P2-12](P2-12-install-feedback.md) ✅ | 安装与配对：下载进度、配对失败说出原因、发现另一个 Hub | 后端（Codex） | P2-9 |
| [P2-13](P2-13-assignee-handoff.md) ✅ | 负责人写成 `pi@server` 并作为交接开关（删除 `turn`）、`workdir` 缺省为 `~`（ADR 0024） | 后端（Codex） | P2-12 |
| [R1-1](R1-0-v0.2-release.md) | Web 资源入口模块、同源 API、PWA 清单与图标 | Claude | — |
| [R1-2](R1-0-v0.2-release.md) | 一个程序 `lumio`；Hub 提供 Web；安装、升级、doctor 跟进 | 后端（Codex） | R1-1 |
| [R1-3](R1-0-v0.2-release.md) | `lumio hub assistant setup / status / clear` | 后端（Codex） | — |
| [R1-4](R1-0-v0.2-release.md) | `migrate retire`、`switch --retire-legacy`、selftest 改用数据库任务 | 后端（Codex） | — |
| R1-5 | 发布 v0.2.0，真实切换与人工验收（见下方清单） | 人类 + Claude | R1-1 至 R1-4 |
| [R2-1](R2-0-language-terminal-theme.md) | 终端进度与颜色、`upgrade` 已是最新时不下载、`switch` 显示 doctor 结果 | 后端（Codex） | — |
| [R2-2](R2-0-language-terminal-theme.md) | 命令行与 Hub 错误说明的中英文 | 后端（Codex） | R2-1 |
| [R2-3](R2-0-language-terminal-theme.md) | Web 主题切换与中英文界面 | Claude | — |
| R2-4 | 发布 v0.2.1 与验收 | 人类 + Claude | R2-1 至 R2-3 |
| [R3-1](R3-0-capabilities-agent-access.md) ✅ | 契约：能力目录、助手配置接口、每轮访问凭据 | Claude 起草，人类批准 | — |
| [R3-2](R3-0-capabilities-agent-access.md) | Hub：agent 权限、能力执行层、内置助手接上工具、模型配置接口 | 后端（Codex） | R3-1、R2-2 |
| [R3-3](R3-0-capabilities-agent-access.md) | 每轮凭据、`lumio agent`、`lumio skill install`、生成 SKILL.md | 后端（Codex） | R3-2 |
| [R3-4](R3-0-capabilities-agent-access.md) | Web：模型配置、已连接的 agent、对话里的变更卡片与撤回 | Claude | R3-2 |
| R3-5 | 验收 | 人类 + Claude | R3-1 至 R3-4 |

P1 的设计决定见 ADR 0014、0016、0017、0018；P2 见 ADR 0019、0020、0021、0022 与修订后的 ADR 0005；契约见 `packages/schema/src/` 中的 `query.ts`、`actor.ts`、`operation.ts`、`proposal.ts`、`api.ts`。

新增 GUI 切片：[P4-1 Web 工作台](P4-1-web-workbench.md)（已合并）。当前进行：[R1-0 v0.2 上线](R1-0-v0.2-release.md)（ADR 0027）。

## 等人类回来处理：v0.2 验收（R1-5）

v0.2 起任务、项目、例行任务在数据库里（ADR 0025），旧任务笔记直接退役（ADR 0027）。下面的清单替代 v0.1.x 基于任务笔记的验收。

**升级与切换**（R1-1 至 R1-4 合并并发布 v0.2.0 后）：

1. Mac：`lumio upgrade`（把旧的三个程序换成一个 `lumio`），再按提示运行 `lumio hub switch --retire-legacy`。
2. Mac：`lumio hub assistant setup`，填 API 地址、模型名和密钥。
3. 实验室服务器：`lumio-runtime upgrade`。
4. Mac：`lumio doctor` 全部通过（Hub 与网页、本机执行器、助手、服务器执行器在线且版本一致）；`lumio-runtime doctor` 在服务器上通过。
5. Mac：`lumio selftest --runtime server --agents pi`，以及本机 `lumio selftest`。

新安装：`curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh`（服务器模式加 `-s -- --server`），之后同上第 2、4、5 步。

**自检覆盖不到、需要人工确认的事项**：

| 事项 | 来自 | 怎么做 |
|---|---|---|
| Web 可用 | R1-2 | 浏览器打开 `http://127.0.0.1:7420`，用 `lumio login-code --name web` 的配对码连接，勾选「在这台设备上保持登录」；关闭浏览器再打开仍是登录状态 |
| 当 App 用 | R1-1 | Safari 菜单「文件 → 添加到程序坞」，从程序坞打开是独立窗口和 Lumio 图标；iPad/iPhone 经 Tailscale 打开 Hub 地址，「添加到主屏幕」后同样可用 |
| 在 Web 上派活到服务器 | ADR 0025、0026 | 新建任务「在服务器上运行 nvidia-smi 并汇报」，负责人选 `pi@server`，点「派出」；在「执行」里看到这一轮完成并有报告，任务讨论里出现结果，任务不会自动变成已完成 |
| 等你回答 | ADR 0025 | 派一个需要确认的任务（例如「列出要删除的临时文件，先问我再删」），在「今日 / 等你决定」里看到问题，在任务讨论里回答后「继续下一轮」 |
| 助手对话 | R1-3 | 在 Web 的「助手」里发一句话，看到流式回复；刷新后对话还在；保存一条记忆再遗忘 |
| 旧笔记已退役 | R1-4 | 打开一条旧任务笔记，把负责人改成 `pi@server` 并保存，确认不会产生新的运行；知识库里仍能搜到它 |
| 例行任务 | ADR 0025 | 在 Web「执行 → 例行任务」新建一个每 10 分钟、目标 `pi@server` 的例行任务并启用；合上 Mac 半小时后打开，确认这段时间的运行记录都在 |
| 开机自启动 | P2-7、R1-2 | 重启 Mac 后不做任何事，`lumio doctor` 显示 Hub（含网页）与本机执行器都正常 |
| 提权助手真实安装与审批 | P2-6 / P2-8 | 在有 root 的私人服务器配对后运行 `sudo ~/.local/bin/lumio-runtime install-sudo-helper`，核对指纹；让 agent 申请安装软件包，在 Web「审批」里批准一次、拒绝一次 |

### v0.1.x 的验收记录

2026-10-28 第一次 Mac 单机安装已人工通过三个真实 agent、任务笔记的一问一答与例行任务；当时发现的问题已记录为 P2-11。2026-10-29 v0.1.4：Mac 重装、实验室服务器（`server`，只有 pi）经 Tailscale 配对接入，`lumio doctor` 与 `lumio selftest --runtime server --agents pi --notes` 已人工通过。过程中修复：systemd `EnvironmentFile` 引号（#52）、发布测试的时序（#47、#54）；改进见 P2-12。
同日人工通过：服务器执行器跑普通命令（P2-2，`nvidia-smi`）、在 iPad 上查看任务笔记（P2-4），已从上表移除。
之后发布 v0.1.5（P2-12）、v0.1.6（P2-13，2026-10-31）；v0.1.6 起任务的交接只看 `assignee`，旧笔记里的 `turn` 仍兼容。

pi 的 skill 验收说明：pi 的回答完全正确（推荐了 `[[渲染格式与来源判断]]`、没有写入、没有泄露），但回答完之后 pi 进程被 `SIGKILL`（退出码 137），
在自己的终端里直接运行也一样，不是 Lumio 的问题。验收脚本把退出码作为提醒而不是失败。若以后派给 pi 的任务出现"汇报正常但状态为失败（signal SIGKILL）"，再处理。

2026-10-26 已完成 #27–#30 的 Codex 交叉 review，问题与修复见 [review 报告](../reviews/2026-10-26-p2-3-to-p2-5.md)，修复（#33–#35）已合并。

## 待办（尚未排期，到时再写成任务说明）

| 内容 | 大约在 | 备注 |
|---|---|---|
| 论文笔记半手动补全：手写的笔记里有 `arxiv` 或 `doi` 时，联网取元数据补齐其余字段 | P1 之后 | 联网放在 CLI 或 Hub，不进 core |
| 语义搜索 / RAG：按意思找笔记，方便按想法引用论文 | P2 之后 | 向量和 `index.sqlite` 放在一起；本地模型还是 API 到时再定 |
| 在 frontmatter 里看得到上一轮的结果（完成 / 有问题 / 失败），方便总览 | 打磨期 | 和 `status` 有重叠，人类要求想清楚再定（ADR 0024 讨论） |
| 测试能否调用真实 AI | P2 | 未决定；P2-3、P2-4 的自动测试一律用假的 agent，真实 agent 只做人工验证 |
| Python 实验 SDK | 不做 | 实验结果怎么记由各项目自己的 `AGENTS.md` 决定（ADR 0019 背景） |
| 完整的 AI 权限系统与 Agent 身份生命周期 | P3 之后 | 接在 ADR 0016 预留的 `authorize`、操作、提议上 |
| 自研 agent 执行框架（每轮权限、上下文管理、模型路由、跨设备工具） | P3 之后 | ADR 0019 第 7 节：作为执行器的一种引擎接入 |
| 审批模型、飞书批准 | P3 | ADR 0019 第 7 节 |
| 服务器模式下怎么编辑 vault | 上服务器时 | ADR 0022 已定为编辑器无关、Lumio 不做同步；剩下的是选哪种外部同步或改用官方 GUI |
| 改名操作 `note.rename`：自己的客户端经 Hub 改名并同步更新所有引用 | 做自己的客户端时 | ADR 0018 第 4 节 |
| 任务总览在 Obsidian 里也能看 | 用一阵 Web 之后 | ADR 0025 后任务存于数据库；Web 工作台已有按状态分组的列表。如仍要在 Obsidian 里看，需要先实现 ADR 0025 第 3 节的只读 Markdown 投影，由人类决定 |
| 给助手开放业务工具（读写任务、查笔记） | v0.2 用起来之后 | 需要新 ADR，涉及权限（ADR 0025 第 7 节） |

已完成（✅）的任务说明保留当时的原文，其中的 vault 路径（如 `papers/`）以 ADR 0012 的新目录为准。

## 给实现者的约定
- 开始前读 `AGENTS.md`、`docs/DESIGN.md` 和本任务说明；任务说明里列出的 ADR 只在需要了解原因时再读。
- 只做"范围"里列出的事；"不做"里的内容即使顺手也不要做。
- 说明里写明的决定直接照做。遇到说明没有覆盖、又会影响接口或数据格式的问题，
  **停下来提问**，不要自行决定。
- 完成时按 `AGENTS.md` 的要求汇报，并逐条对照"验收标准"说明如何验证。
- **PR 合并时更新 ADR 状态**（ADR 0013）：把这个切片实现的 ADR 小节标为已实现；
  全部实现的 ADR 改为 `Implemented`。
