# Lumio 设计

> **本文件只写现在生效的设计与规则**，按领域组织，不保留历史。每条规则后的 `ADR 00xx` 是它的出处，
> 想知道"为什么"时再去查；平时不需要读 ADR。
> 修改规则：改了 ADR 就要在同一个 PR 里同步改本文件（ADR 0015）。本文件与 ADR 不一致时，说明有一方没同步，告诉人类。

> **已批准、实施中的重构**：[ADR 0025](adr/0025-four-module-architecture.md)（Accepted，2026-10-31 人类批准）规定知识、工作、执行、助手四模块与混合存储；
> [实施说明 R0-0](tasks/R0-0-four-module-refactor.md)。以下规则描述现有路径，按切片落地后同步替换；必要契约由 Claude 起草，不迁移真实数据。

## 0. 目标与非目标

**目标**：在一个地方管理论文笔记、外部资料、想法、项目与任务、实验结果、发布内容和个人资产；
把想法通过链接串成报告；把工作派给 Mac 或服务器上的 AI，并支持定时工作流。

**非目标**（至少在 P3 之前）：自己写编辑器、复杂的多 agent 协作与模型路由、多用户与托管服务、完整的 AI 权限系统
（只预留接口，见第 5 节）、与飞书双向同步正文、同步第二份 vault。

## 1. 总体结构

```
 任意编辑器 / 以后的官方 GUI ── 直接编辑文件 ──┐
                                                ▼
┌──── 程序入口（可替换）────┐      ┌───────────────────────────────┐
│ CLI │ 飞书 Bot │ Web/插件  │─API─▶│ Hub（程序写入的唯一裁判）       │
└──────────────────────────┘令牌  │  校验 → 执行 AI 边界 → 写文件   │
                                    │  监听文件变化 → 补全与索引      │
                                    │  任务与轮次 · 例行任务 · 搜索   │
                                    └───────▲───────────┬───────────┘
      执行器主动连接、轮询               │           │ 自动提交
                   ┌────────────────────────┘           ▼
            ┌──────┴────────┐                vault 的 git（只做历史与备份，
            │ 执行器@每台设备 │ 本地队列、定时、  .git 在同步目录之外）
            │ 调用 agent CLI │ 待交回的结果
            └───────────────┘
```

- **vault 是知识的唯一事实来源**：一个装 Markdown + YAML frontmatter 的普通文件夹，任何编辑器都能改；Lumio 不依赖、不读写任何编辑器的配置。
  用外部编辑器改文件是一直支持但最不正式的用法，正式的编辑方式以后由官方 GUI 提供（ADR 0001、0007、0022）。默认位置 `~/.config/lumio/vault`，安装时可改。
- **一套系统只有一个 Hub**，vault 在 Hub 所在的机器上。这个文件夹可以被任何外部工具（git、Syncthing、iCloud……）同步到别的设备上编辑，
  同步进来的修改等同于人改文件；Lumio 不做自己的同步（ADR 0017、0022）。
- `index.sqlite` 是可重建的知识索引，`refs.bib` 是生成物；`hub.sqlite` 保存身份、执行记录以及新版 Work/Assistant 业务数据，不能删除后靠 vault 重建（ADR 0014、0025）。
- **知识与工作独立**：知识正文仍由文件负责，数据库任务与项目由 Work 负责；Work 可以在未配置 `LUMIO_VAULT` 时使用。
  Task 描述使用 Markdown 语法，但不因此成为知识笔记；各模块通过 ID 和公开接口协作（ADR 0025）。

## 2. 工程基础

- **一个代码仓库**，数据（vault）不放在仓库里（ADR 0001）。
- **全部 TypeScript，运行在 Bun 上**；Bun 固定为 1.3.x，与人类的 Nix 环境一致（ADR 0002，AGENTS.md）。
- CLI、Hub、Runtime 用 `bun build --compile` 编译成单个二进制（ADR 0002）。
- **契约**：`packages/schema` 中的 Zod 定义是数据格式的唯一事实来源；其他语言用 `bun run schema:export`
  导出的 JSON Schema（ADR 0003）。vault 实体用宽松对象（未知字段原样保留），协议用严格对象（未知字段拒绝）。

| 模块 | 职责 | 可以依赖 |
|---|---|---|
| `packages/schema` | 契约 | 仅 zod |
| `packages/knowledge` | 知识规则、解析/补全/链接、论文创建与查询用例；不做 I/O | schema, foundation，已有 YAML/XML 解析依赖 |
| `packages/work` | 数据库项目/任务、依赖、讨论、输入快照、显式派活用例；不做 I/O | schema |
| `packages/execution` | Job 生命周期、设备名称/能力/在线事实、取消与执行有效性、数据库 Routine 计划与历史输入、cron；不做 I/O | schema, foundation |
| `packages/assistant` | 对话、上下文、Agent 循环、工具记录与恢复；通过接口调用模型 | schema |
| `packages/storage` | 各领域的 SQLite、知识文件与索引适配器 | schema 与业务包公开接口 |
| `packages/foundation` | 稳定 ID 与带 code 的基础错误 | schema |
| `packages/platform` | 终端、下载、升级回退、诊断与配对/Hub 检查；显示和版本由应用传入 | schema |
| `packages/core` | 旧包兼容转发入口，已无上述具体实现；应用禁止再依赖 | 上述内部包 |
| `packages/api-client` | 调用 Hub 的 SDK | schema |
| `apps/cli` | `lumio` 命令行；联网获取论文元数据、本地知识模式、Hub 客户端 | api-client, knowledge, storage, foundation, platform, schema |
| `apps/hub` | API、模块组装、跨模块协调、身份与旧路径兼容 | 业务包、storage、foundation、platform、schema |
| `apps/runtime` | 设备 daemon，与 Hub 只走 HTTP | execution 的纯计划能力、platform、schema |
| `apps/feishu-bot`、`apps/web` 等 | 各个客户端 | api-client |

依赖方向由 `bun run lint:deps` 强制：`packages` 不依赖 `apps`，`apps` 之间不互相依赖；四个业务包不导入其他业务包实现或具体适配器，禁止文件/网络/SQLite/进程 I/O；应用不依赖 Core 兼容汇总入口（ADR 0025）。

## 3. 数据

### 3.1 vault 目录（ADR 0012）

下列 Task/Project/Routine 目录保留旧笔记兼容与显式迁移来源；新版业务对象在数据库中，不要求在这些目录里有文件（ADR 0025）。

```
library/   papers/ → paper     sources/ → source     refs.bib（生成物）
research/  ideas/ → idea       experiments/ → experiment     reports/（暂不扫描）
plan/      projects/ → project tasks/ → task  routines/ → routine
create/    posts/ → post
life/      assets/ → asset（私密）
files/     attachments/  drawings/（Excalidraw）  templates/     —— 不是实体，不扫描
```

- **类型由所在的类型目录决定**；映射表 `VAULT_LAYOUT`（`packages/knowledge`）是唯一来源，其他代码不得写死路径。
- 类型目录下可以自由建子文件夹，只用于浏览，不影响类型。每个实体只对应一个 `.md` 文件。
- 扫描时跳过隐藏文件、`*.excalidraw.md` 和 frontmatter 含 `excalidraw-plugin` 的文件。
- 大文件（视频原片等）不进 vault，用 `media://<相对路径>` 引用，由各设备配置媒体根目录。

### 3.2 实体类型

本表描述知识目录中的文件格式；Project/Task/Routine 保留旧格式兼容，新业务对象与数据库规则见第 4.7 节。

所有实体共有：`id`（`<前缀>_<ULID>`）、`type`、`title`、`created`、`updated`（ISO 8601 带时区）、`tags`。（`related` 已删除，旧笔记里的值原样保留但不计入链接图，ADR 0018。）

| 类型 | 前缀 | 要点 |
|---|---|---|
| paper | `pap` | `citekey`、`authors`、`year` 必填；`arxiv`、`doi`、`venue`、`url`；正文末尾有 BibTeX 一节 |
| source | `src` | 网页、视频、播客、课程、书；`kind`、`url`、`author`、`site` |
| idea | `idea` | `status`；可关联 `project` |
| project | `prj` | `status`、`goal`、`repo`、`deadline` |
| task | `task` | `status`（todo/active/waiting/paused/done/cancelled，只由人改）、`assignee`（`human` / `pi` / `pi@server`，同时是"现在轮到谁"）、`due`；派给 AI 时可选的 `workdir`（缺省 `~`）、`model`、`gpus`、`timeout_minutes`（ADR 0019、0024） |
| routine | `rtn` | 例行任务：`schedule`（5 段 cron）、`assignee`（agent）、`context`（none/previous）与执行配置；每次结果追加在笔记里（ADR 0019） |
| experiment | `exp` | `project` 必填；`hypothesis`、`metrics`、`artifacts` |
| post | `post` | `format` 必填（无默认值）；`media` 按角色命名；`targets` 每个平台一个，发布结果由程序写入 |
| asset | `ast` | `kind` 必填；订阅、卡、账户、域名、保险、证件等；**私密**；禁止存完整卡号、CVV、密码、余额、证件号 |

字段的完整定义以 `packages/schema` 为准。

### 3.3 元数据规则

- **元数据由 Lumio 负责，编辑器只是编辑器**，不依赖任何编辑器的模板或插件（ADR 0009、0022）。
- 两种创建方式结果相同：`lumio new <类型>`，或直接在类型目录里随手写，再由补全器补齐；两者共用同一个补全器（ADR 0009）。
- **补全器只补缺失的字段**，不覆盖已有的值，不改正文和链接。缺失包括值为空（`null`）的情况（ADR 0008、0009）。
- 补全规则：类型取自目录，标题缺失时取文件名，`created` 取文件创建时间，`id` 新生成；无法推断的必填项只报告、不猜（ADR 0009）。
- 唯一例外是 **schema 中声明的"程序字段"**（如 post 的发布结果、asset 顺延的 `renews_on`），程序可以更新；
  这类更新必须经过 Hub（ADR 0009、0014）。
- 可选字段留空视为没填，带默认值的字段留空取默认值，必填字段留空报错；协议（job）不适用这条（ADR 0008）。
- 默认值不写进文件，读取时由 schema 补上。例外是需要人拨动的开关：任务与例行任务的 `status`、任务的 `assignee`（`human`），缺失时补全器写上默认值（ADR 0023、0024）。

### 3.4 论文 citekey（ADR 0004）

- 格式 `<第一作者姓>_<年份>_<缩写>`，如 `He_2020_LightGCN`；**同时是文件名、`[[链接]]` 和 `\cite{}` 的 key**。
- 全自动生成，不需要人确认：
  - 姓：去掉重音后删除所有非 ASCII 字母，只把首字母改成大写；删完为空时用 `Anon`。
  - 缩写：标题冒号前若是单个词就用它（删除非字母数字字符，`GPT-4` → `GPT4`）；否则取前四个实词的首字母；为空时用 `Paper`。
  - `--abbr` 可以主动指定缩写。
- 撞名（另一篇论文已占用）时自动加 `b`、`c`……；同一篇论文（arXiv 或 DOI 相同）则报"已存在"。
- 元数据来源：arXiv API、Crossref；BibTeX 只改 key，其余原样保留。

### 3.5 链接与 AI 区块

- **链接只写在正文里**，由人在写作时写，并在句子里说明关系（ADR 0018）。两种写法都识别，用哪种由人决定（ADR 0022）：
  `[[文件名]]`（去掉 `|别名`、`#标题` 后按文件名解析）；标准 Markdown 链接 `[文字](相对路径.md)`（相对于所在笔记的目录解析，以 `/` 开头的相对于 vault 根目录；大小写敏感；忽略图片、外部地址与非 `.md` 附件；P2-10）。
- frontmatter 的 `related` **已删除**：旧笔记里的值作为未知字段原样保留，但不计入链接图（ADR 0018）。
- **改名**：用任何编辑器改名都可以（有的编辑器会自动更新链接）；造成的断链由 `lumio check` 列出，不自动修复；以后官方 GUI 经 Hub 改名并同时更新引用（ADR 0018）。
- 解析不到的标为悬空链接，不报错；代码块里的 `[[ ]]` 忽略。
- 导出参考文献时从正文找引用：`lumio export bib --from <笔记>` 只导出该笔记里 `[[citekey]]`、指向论文笔记的 Markdown 链接或 `\cite{citekey}` 引用到的论文（ADR 0018）。
- AI 生成的内容写在正文的标记区块里（ADR 0012）：
  ```
  <!-- lumio:ai start name=summary model=<模型> generated=<时间> -->
  ……
  <!-- lumio:ai end name=summary -->
  ```
  AI 只能整体重写区块内部；人想保留的内容要移到区块外。**区块内的 `[[ ]]` 不计入人的链接图。**

## 4. Hub 与运行

### 4.1 Hub 的职责（ADR 0007、0014）
- **程序写入的唯一裁判**：修改已有内容的程序写入（接受提议、更新程序字段）必须经过 Hub，没有 Hub 时不能用。
- **人可以直接改文件**：Hub 监听 vault，自动补全并重建索引；frontmatter 不合法时提醒人，不拒绝、不覆盖人的改动。
- 新建笔记和补全元数据（`lumio new`、`lumio sync`）不需要 Hub，性质等同于人新建文件。
- 知识查询两种模式都支持：设置 `LUMIO_HUB_URL` 时走 Hub，否则直接读本地 vault；规则与用例在 Knowledge，文件和索引在 Storage，两边共用。
- 数据库 Work/Assistant 经 Hub 使用；未配置知识目录时 Hub 不启动文件监听，知识查询给出未配置说明（ADR 0025）。

### 4.2 存放
- Hub 的运行数据放在 `~/.local/share/lumio/`（可配置），**不在 vault、不在同步目录里**：
  `index.sqlite`（派生索引，可重建）、`hub.sqlite`（身份、令牌、提议、审计、Job、数据库 Work 和 Assistant，需要备份）。
  `lumio-hub backup <目标文件>` 仍提供旧数据库单文件备份；完整业务备份用 `lumio-hub backup business <新目录>`，
  以数据库一致性快照确定 ready 托管文件，复制文件并生成校验清单（ADR 0014、0016、0025）。
- `lumio-hub backup verify <目录>` 校验清单、数据库和引用文件；`lumio-hub restore business <备份目录> <新状态目录>` 只恢复到新目录。
  拒绝缺失或被篡改的文件、重复清单与符号链接，不覆盖已有状态。知识目录与安装配置单独备份，索引可重建（ADR 0025）。
- Hub 与离线迁移通过同一业务目录的 SQLite OS 租约互斥；进程崩溃自动释放锁，不删除锁文件或凭 PID 猜测锁失效。

### 4.2.1 日志与托管文件（ADR 0025）

- Runtime 保留原始输出，同时写分段 JSONL（RunLogEvent v1）；每次运行独占日志目录，事件顺序从 1 连续递增。
  原始 stdout/stderr 的 JSONL output 负载用 base64 表达，避免二进制和 UTF-8 分块造成内容损坏。
- 活跃日志末行不完整可报告；封存日志截断、行损坏、事件重复或缺失必须失败。恢复中断运行只封存完整前缀并记 recovery，Job 仍由数据库标为 unknown，不从日志重新执行。
- 自有日志归档 MIME 为 `application/vnd.lumio.runlog+jsonl`，按完整运行流再次校验；原始输出以 text/plain 独立归档。
- Runtime 为文件保留独立交付记录；Hub 校验大小与 SHA-256，先发布字节再登记 ready。登记冲突保留文件待核查，重复交付不重复登记。
  Job 结果确认与文件确认互不替代，上传失败不阻塞结果交回；确认后原始文件仍留在 Runtime。
- 文件接口在 `/v2/execution/` 下；runtime 只能上传自己已接手的 Job 的文件。读取只授予 human，私密产物需显式 include_private。
  `lumio job artifacts <Job ID>` 查看 staged/ready；`lumio job download <文件 ID> --output <新文件>` 流式校验后保存，不覆盖目标。
- Job 协议仍为 2；旧 Runtime 不归档文件，新 Runtime 遇到旧 Hub 时保留待交付文件并重试，不影响旧结果协议。

### 4.3 自动提交（ADR 0014）
- vault 安静 5 分钟（可配置）后自动提交一次；没有 git 仓库时跳过。任何非隐藏文件的变化都会重新计时（报告、附件也会被提交），补全只处理笔记。
- Hub 启动时先全量补全与索引一次，覆盖它没运行期间的改动。
- 提交前检查疑似卡号，命中的文件不提交（见第 6 节）。

### 4.4 搜索（ADR 0014）
- SQLite FTS5 + trigram 分词；**少于 3 个字符的查询改用子串匹配**（trigram 搜不到两个汉字的词）。
- 范围：标题、正文、作者、citekey、tags。空查询列举可见笔记，可配合 `type` 过滤；旧任务可用 `lumio task list --legacy` 列举。
  新版 `lumio task list` 使用独立 Work 查询，不伪造笔记路径（ADR 0025）。
- 索引用 WAL，遇到锁时等待（最多 5 秒）；Hub 与本地 CLI 可以同时使用同一个索引。
- 没有 ID 的笔记照样能搜到，结果里**不带 `id`**，只能按文件名引用；不生成替代 ID。

### 4.5 部署（ADR 0007、0017、0021、0022）
- **两种模式，都只有一个 Hub**：
  - **单机模式（默认）**：Hub、vault、执行器在同一台机器（macOS 或 Linux），Hub 只听 `127.0.0.1`，不需要任何网络配置。
  - **服务器模式（标准）**：Hub 与 vault 在服务器上，像普通自托管软件一样部署；其他机器作为 CLI 客户端和执行器主动连接 Hub。
- **网络由部署者负责**：Hub 只讲 HTTP；监听地址（`LUMIO_HUB_LISTEN`）与对外地址（`LUMIO_PUBLIC_URL`）由部署者设置，
  HTTPS 推荐放 Caddy 等反向代理（文档有示例）。非本机监听且对外地址是 `http://` 时只警告、不拒绝。
  Tailscale 等私有网络是补充：`setup` 检测到时可以帮忙填对外地址，核心代码不依赖它。
- **安装**（ADR 0021）：打 `v*` 标签时 CI 编译 `lumio`、`lumio-hub`、`lumio-runtime` 发布到 GitHub Releases；`install.sh` 下载、校验、装到 `~/.local/bin`，
  再运行 `lumio-hub setup`（可重复运行；`--server` 为服务器模式）：vault 路径、身份、CLI 配置文件 `~/.config/lumio/config.json`、
  Hub 与本机执行器的后台服务（macOS：launchd；Linux：systemd 用户服务）。
  加执行器：`lumio runtime add <名称>` 生成一次性配对码（10 分钟、一次有效），那台机器上 `lumio-runtime join` 换取令牌并装好后台服务；
  另一台机器上的 CLI 用 `lumio login`。`lumio doctor`、`lumio-runtime doctor` 检查安装；`lumio selftest` 用真实 agent 验证关键路径；`upgrade` 升级。
  Nix 以后作为另一种安装方式。作者自己的用法见 `docs/personal-setup.md`。
- 只信任配置过的反向代理传来的客户端信息。
- 飞书 Bot 用官方 SDK 的长连接，不需要公网回调地址。

### 4.6 Runtime 与旧任务笔记兼容（P2，ADR 0005、0019）

本节的文件开关和写回语义仅适用于尚未执行 v2 apply 的旧模式；Job 的可靠执行协议继续共用。
数据库 Work 的负责人、显式派活与结果规则见第 4.7 节。

本节关于修改笔记负责人触发、元数据交接和 AI 区块写回的条款适用于旧笔记路径；新版数据库 Work 使用第 4.7 节。
Job 协议、执行器主动连接、lease 校验与可靠交回仍共同适用（ADR 0025）。
- **Hub 是中心，每台设备上一个执行器**（`lumio-runtime`）。执行器登记能力（agent 及版本、隔离级别、标签如 `gpu:4`），
  **主动轮询 Hub**；只有 Hub 能派活。执行器的身份角色是 `runtime`：只能领活、回报、登记，不能查询笔记库。
- **一个任务很多轮**：一轮（Job）= 让某个 agent 执行一次，**只执行一次，不自动重试**；重试由人派出新的一轮。
- **负责人就是开关**（ADR 0024，P2-13）：`assignee` 写成 `human`、`<agent>` 或 `<agent>@<执行器>`（旧的 `{agent, device}` 对象仍可读）。
  人把 `assignee` 从 `human` 改成某个 agent（笔记安静 30 秒后派），或 `lumio task continue <任务> [--to <负责人>]`；都走操作 `task.dispatch`。
  交接只改这一个字段：一轮结束回到 `human`，人再改成另一个 agent 就由它接手（换 agent 开新会话）。agent 不能把任务交给另一个 agent。
  任务已有一轮在执行时不再派。`status` 为 `done`、`cancelled` 或 `paused` 时不派出（包括 CLI）；重新开始须先改回 `active` / `todo`。
  **升级兼容**：笔记中仍有 `turn` 字段时沿用旧开关，只有 `turn: agent` 才按负责人派出，否则视为轮到人；结束或拒绝派出时只把 `turn` 写回 `human`，保留原负责人及其对象写法。
  没有 `turn` 时才用 `assignee` 作开关；升级启动扫描不把旧笔记固定的 agent 负责人当成新的派活请求。AI 有问题时这一轮以"等你回答"结束，人回答后接着同一个会话继续。
- **派给哪个执行器**：写了 `@<执行器>` 时用它；否则用 Hub 所在机器上的本机执行器，没有时拒绝（ADR 0024）。不在线时 Job 等它上线后领取。
  `workdir` 缺省为执行器上的 `~`，不能在笔记库里。执行中人改 `assignee` 不生效，只记入 `hub status` 的问题列表。第一次派出时 `status` 从 `todo` 改成 `active`；人在执行中改成 `paused`/`cancelled` 会取消这一轮。
- **写回**：每轮结果写进正文末尾的 `round-N` AI 区块，新格式的 `assignee`（旧格式的 `turn`）改回 `human`；汇报疑似含卡号或密钥时不写入笔记，只提示用 `lumio job show` 查看。
  Hub 的这两次写入（派出、写回）各自单独提交；目标笔记里人还没提交的修改先作为一次自动保存提交。
- **上下文**：能接上原会话时只发人新写的部分；接不上时发人写的部分加最近一轮的汇报。
- **记录分开**：笔记里是每一轮的汇报摘要（AI 区块）；Hub 数据库里是每一轮的完整记录（配置、状态、时间、退出码、
  会话编号、开始与结束时的 git 提交、完整汇报）；完整日志在执行器本地。
- **断开后能接上**：执行器先把 Job 写进本地队列再确认；确认后这一轮归它负责，失联时 Hub 不转给别人。
  结果先存"待交回"，Hub 确认后才删；重复交回只记一次。Hub 只接受被指派的执行器、带着当前 lease 的回报。
  执行器重启时，执行到一半的标为 `unknown`，新格式的 `assignee`（旧格式的 `turn`）改回 `human`。
- **例行任务**（`plan/routines/`）：`status: active` 的例行任务由 Hub 做成计划同步给执行器（选执行器的规则同上），
  到点由执行器自己触发（Hub 离线也照常），Job 编号由"例行任务 + 计划触发时间"确定，重复生成只有一个；每次是独立的新会话，
  `context: previous` 时带上上一次的摘要。执行器离线错过的只补跑最近一次，其余在结果里注明跳过了几次。
  结果按时间追加在这篇笔记的 `run-<日期时间>` AI 区块里。`lumio routine list` 列出计划；
  `lumio routine followup <例行任务> <日期>`（操作 `routine.followup`）从某一次开出普通任务：执行配置照抄，`assignee: human`。
- **高权限申请**（ADR 0020）：每轮单独的本地 socket 凭据经 `lumio-runtime sudo -- <绝对路径程序>` 发起；人用 `lumio proposals` 查看并批准或拒绝。批准后 Hub 签发 10 分钟有效的一次性凭据，root 助手独立验证并在执行前记为已用；输出只返回调用者，执行状态离线时保留交回。安装见 `infra/sudo-helper.md`。
- **适配器**：`codex exec`、`claude -p`、`pi -p` 的非交互模式；锁定验证过的版本；如实声明隔离级别（`os`/`none`）。
  不经过 shell；command 类型只执行登记过的程序；密钥在执行节点上才解析。
- **不做**：跨设备调用工具、每一轮单独的权限、上下文管理、模型路由；留给以后自研的 agent（作为执行器里的一种引擎接入）。

### 4.7 数据库 Work 与内置 Assistant（ADR 0025，分支内逐步实现）

- `/v2/work/commands` 使用 `WorkCommandRequest` 与 `WorkCommandResult`；Task/Project 查询返回严格业务对象，不含路径。
- Task/Project 描述在数据库中；状态、负责人、依赖、讨论、执行关联各有明确归属。修改负责人或保存描述不隐式派活。
- 更新带 `expected_revision`；请求用 `request_id` 去重。派活在同一事务内保存 Job、Work 关联和请求回执；同一任务默认只有一轮待完成。
- 运行结果作为 Work 进展追加一次，不自动把 Task 标成 done，不强制改变负责人。旧 v1 派活接口拒绝操作数据库任务。
- 数据库 Routine 使用 `/v2/execution/routines` 与 `/v2/execution/commands`；计划在 Execution，独立于 Task 与知识目录。
  Runtime 继续使用 Job 协议 2，本地触发与 outbox 不变。已交付计划保留历史快照，旧结果按原 lease 匹配输入；心跳无 lease 时不猜测多份历史计划。
- Work 派活与 Routine 修改的业务数据、请求回执和成功审计参加同一数据库事务；审计失败不交付半个派活。
- 设备登记规则和在线时限由 Execution 判断，Runtime 表与 Job 表由 Storage 适配；Hub 的身份和 HTTP 入口只组装并转发。
  审批通过 Execution 查询 Job 是否仍有效，取消请求已登记时即拒绝开启高权限工作，不直接读取执行表。
- CLI：`project new/list/show/update/edit/status`，`task new/list/show/update/edit/status/assign/comment/continue`；`--legacy` 明确使用旧任务笔记。
  `edit` 打开带版本的外部编辑副本；用 `--file` 提交已有正文时必须带 `--revision`，冲突保留内容。
- `routine new/list/show/update/edit/status/followup` 使用数据库路径；`--legacy` 选择旧笔记。
  新版追问从指定执行创建人工 Work 任务并保留执行来源；旧 v1 followup 拒绝数据库 Routine。
- `lumio-hub migrate plan/apply/sources/source` 提供显式迁移，完整步骤见 [切换与回退](migration-v2.md)。
  apply 要求匹配的完整备份、源摘要和设备准备确认，并与 Hub 独占同一状态目录；原始字节和未知字段进入来源档案。
  第一次成功 apply 后关闭整个工作区的旧 Task/Routine 文件控制与旧派活/追问；知识文件继续可编辑，不再由旧字段覆盖数据库。
- Runtime 与离线准备也持有独占状态租约。`prepare-migration --state-dir <目录>` 只在执行器停止且无待执行/交付数据时清空派生计划缓存。
  迁移仅导入已处理历史关联与已经暂停的 Routine，不生成 Job 或重放工具/审批；下一轮取历史最高轮次加一。
- `/v2/assistant/chat` 支持 JSON 与 NDJSON；对话、轮次、工具调用和记忆归 Assistant。CLI 用 `chat`、`chat list/show`。
  模型和工具通过注入接口提供；当前基础接入不选择默认模型供应商，模型/工具生产适配随 R0 后续切片完成。
- 助手持久化工具调用状态；中断或写操作结果不明标为 unknown，不自动重放。最终空回复明确失败，工具调用中间消息可无文本。
- 新 v2 工作与助手入口目前仅 human 可访问，不自动放宽 agent/runtime 权限；搜索来源与私密规则继续适用。

## 5. AI 协作与权限（ADR 0014、0016、0018）

- **AI 只推荐，不写链接**（ADR 0018）：AI 可以查询、新建想法和论文笔记、重写 AI 区块；它检索已有笔记，在对话里告诉人
  "哪篇的哪一段和这里相似"并给出原文，由人决定是否、怎样写进正文。AI 不能写任何链接，不能改人写的正文。
- **AI 的入口是 CLI + skill**：`lumio search/show/links … --json`，配合 `skills/lumio/SKILL.md`；
  Claude Code、Codex、pi 共用一份。MCP 只在出现没有 shell 的客户端时，作为薄适配层再加。
- **身份与令牌分开**（ADR 0016）：人和每个 AI agent 各是一个身份（`act_<ULID>`），角色是 `human` 或 `agent`；
  令牌只是身份的凭证，一个身份可以有多个，可单独吊销。提议、审计、日志里记身份 ID，不记令牌名称。
  令牌只显示一次，Hub 只存哈希；所有请求都要令牌，内网也不例外（ADR 0007）。
- **每次修改都是一个操作，只有一个入口**（ADR 0016）：程序对 vault 的修改表示为 `{ op, args }`（现有 `task.dispatch`、`routine.followup`、`exec.privileged`；`link.add` 已删除，ADR 0018），
  Hub 先 `authorize(身份, 操作)` 再执行。以后的完整权限系统只替换 `authorize`。
- **授权结果三种**：允许 → 立即执行；拒绝 → 403；**需要批准 → 生成提议**，提议里存完整的操作，人接受后 Hub 执行它。
  现行规则：`human` 可查询、派活与决定提议（高权限申请由 runtime 发起）；`agent` 查询允许（私密除外），派任务、开追问任务、决定提议、访问私密实体拒绝；`runtime` 只能用执行器接口及提交 `exec.privileged`；不能查看提议列表或决定提议。
  `exec.privileged` 一律需要人批准；只有 runtime 可以申请，而且必须属于它正在执行、未取消的一轮（ADR 0020）。
- **错误带决策信息**：错误响应统一为 `ApiError`（代码、说明、被拒绝的操作、原因、提议 ID），AI 据此向人解释。
- **审计**：每次授权与执行都记入 `hub.sqlite`；Hub 执行的操作立即单独提交，提交信息带 `Lumio-Actor`，
  经提议执行的还带 `Lumio-Proposal`、`Lumio-Approved-By`；派出一轮、写回一轮结果的提交带 `Lumio-Job`。自动保存的提交不带身份。
- **执行器**（ADR 0019）：身份角色 `runtime`，只能领取派给自己的活、回报结果、登记能力；看不到笔记库，只看到 Job 里带的内容。
- **AI 的汇报只是资料**：不能自行派新活或决定 Task 完成。旧笔记模式在一轮结束时把交接开关改回 human（ADR 0024）；
  数据库 Work 不强制改变负责人，修改负责人和派活分开（ADR 0025）。
- **私密实体**（`life/` 下）：默认不出现在任何查询结果中；`agent` 令牌在任何情况下都拿不到；
  `human` 令牌须显式加 `--include-private`。`refs.bib`、报告等不得引用私密实体（ADR 0012、0014）。
- **局限**：不经过 Hub、直接读文件的 AI 拦不住，需要在 agent 的沙箱配置里排除 `life/`。

## 6. 安全

- **卡号防护**（ADR 0012）：写法像卡号（连续 13–19 位，或 4-4-4-4 / 4-6-5 分组）且通过 Luhn 校验即视为疑似卡号。
  - asset 校验报错；Hub 自动提交前和建索引前检查**所有文件**，命中的不提交、不索引，提醒人删除；
  - 错误和日志里永远不出现这串数字；判定函数在 `packages/schema/src/secrets.ts`。
  - 局限：文件本身可能已被同步工具同步出去，需要人手动删除。
- **`life/` 只放记录和提醒**；真正敏感的内容（密码、完整卡号、证件号）放在密码管理器里，不进 vault。
- **密钥**：代码和配置里只写占位符（如 `${secret:openai}`），由运行时注入；令牌不进日志（AGENTS.md、ADR 0007）。
- 编辑器的插件设置可能含明文密钥：建议在 vault 的 `.gitignore` 里排除（Lumio 不管理编辑器配置，ADR 0022）。
- **派活的安全底线**（ADR 0019）：
  - 执行器用普通账号运行，不用 root；工作目录不能在笔记库里；能用 agent 自带沙箱的就打开，每一轮记录隔离级别。
  - 高权限命令只能在一轮之内经 `lumio-runtime sudo` 发起，成为需要批准的操作 `exec.privileged`；人接受后 Hub 签发一次性、10 分钟内有效的
    批准凭据，root 助手程序用 Hub 公钥验证后执行一次（ADR 0020：agent 与执行器同一账号，助手程序不信任调用者）。审批模型（P3）只看命令和人写的要求。
  - AI 汇报写回笔记前检查疑似卡号和常见密钥格式，命中的不写入。
  - 每一轮有最长运行时间（默认 2 小时）；取消时杀掉整个进程组；`gpus` 只暴露指定的 GPU。

## 7. 流程

- **ADR 的生命周期**（ADR 0013）：`Proposed` 随便改 → `Accepted` 修改要人类批准并记修订记录 →
  `Implemented` 定稿，要改就写新的 ADR；部分实现时，已实现的小节先定稿。
- **本文件与 ADR 同步**（ADR 0015）：改 ADR 的 PR 必须同时改本文件。
- **同一时间只有一个会话改代码仓库**；开始前 `git pull`、确认工作区干净，结束时提交并推送（AGENTS.md 第 9 条）。
- **分工**：后端默认 Codex，前端默认 Claude，`packages/schema` 由 Claude 起草、人类批准；交叉 review（AGENTS.md）。
- **任务说明**（`docs/tasks/`）：一个纵向切片一份；PR 合并时把实现了的 ADR 小节标为已实现。

## 8. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | `lumio new paper`、`lumio new idea`、`lumio sync`；vault 目录结构；source / post / asset 契约 | ✅ |
| P0-7 | 迁移真实 vault 到新目录 | ✅ |
| P1 | 本地查询与 `export bib`；Hub（身份与令牌、查询 API、监听、自动提交、操作与提议框架）；按引用导出与断链检查；skill | ✅（pi 验收待补） |
| P2 | 执行器与派活（P2-1 ✅、P2-2 ✅、P2-3 ✅、P2-4 ✅、P2-5 ✅、P2-6 ✅）：执行器登记、可靠的派活核心、三种 agent 适配器、任务笔记里的一问一答、例行任务、`lumio-runtime sudo` 审批的门；安装、配对与自检（P2-7 至 P2-9，ADR 0021、0022）；识别 Markdown 链接（P2-10） | 功能 ✅，安装与自检进行中 |
| P3 | 飞书 Bot（派活、批准、通知）、审批模型、资产到期提醒、多维表格镜像；Chrome 插件入库论文 | |
| P4 | 官方 GUI（Web：浏览、编辑笔记与任务、批准提议）、Docker / Nix 安装、对外 SDK、手机端 | |
