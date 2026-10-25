# Lumio 设计

> **本文件只写现在生效的设计与规则**，按领域组织，不保留历史。每条规则后的 `ADR 00xx` 是它的出处，
> 想知道"为什么"时再去查；平时不需要读 ADR。
> 修改规则：改了 ADR 就要在同一个 PR 里同步改本文件（ADR 0015）。本文件与 ADR 不一致时，说明有一方没同步，告诉人类。

## 0. 目标与非目标

**目标**：在一个地方管理论文笔记、外部资料、想法、项目与任务、实验结果、发布内容和个人资产；
把想法通过链接串成报告；把工作派给 Mac 或服务器上的 AI，并支持定时工作流。

**非目标**（至少在 P3 之前）：自己写编辑器、自己写 agent 循环、多用户与托管服务、完整的 AI 权限系统
（只预留接口，见第 5 节）、与飞书双向同步正文、同步第二份 vault。

## 1. 总体结构

```
 Obsidian（Mac / iPad / 手机）── 直接编辑文件 ──┐
                                                ▼
┌──── 程序入口（可替换）────┐      ┌───────────────────────────────┐
│ CLI │ 飞书 Bot │ Web/插件  │─API─▶│ Hub（程序写入的唯一裁判）       │
└──────────────────────────┘令牌  │  校验 → 执行 AI 边界 → 写文件   │
                                    │  监听文件变化 → 补全与索引      │
                                    │  提议队列 · job 队列 · 搜索     │
                                    └───────┬───────────┬───────────┘
            Tailscale（或 HTTPS 反向代理）  │           │ 自动提交
                   ┌────────────────────────┘           ▼
            ┌──────▼───────┐                 vault 的 git（只做历史与备份，
            │ Runtime@设备 │ 领取 job，       .git 在同步目录之外）
            │ 调用 agent   │ 结果经 Hub 写回
            └──────────────┘
```

- **vault 是知识的唯一事实来源**：Markdown + YAML frontmatter，就是 Obsidian vault，当前放在 iCloud（ADR 0001、0007）。
- **一套系统只有一个 Hub，vault 只放在 Hub 所在的机器上，没有第二份**（ADR 0017）。
- SQLite 只是派生索引，可随时删除重建；`refs.bib` 是生成物（ADR 0007、0014）。

## 2. 工程基础

- **一个代码仓库**，数据（vault）不放在仓库里（ADR 0001）。
- **全部 TypeScript，运行在 Bun 上**；Bun 固定为 1.3.x，与人类的 Nix 环境一致（ADR 0002，AGENTS.md）。
- CLI、Hub、Runtime 用 `bun build --compile` 编译成单个二进制（ADR 0002）。
- **契约**：`packages/schema` 中的 Zod 定义是数据格式的唯一事实来源；其他语言用 `bun run schema:export`
  导出的 JSON Schema（ADR 0003）。vault 实体用宽松对象（未知字段原样保留），协议用严格对象（未知字段拒绝）。

| 模块 | 职责 | 可以依赖 |
|---|---|---|
| `packages/schema` | 契约 | 仅 zod |
| `packages/core` | vault 解析、补全、链接、索引、BibTeX；纯本地，**不联网** | schema |
| `packages/api-client` | 调用 Hub 的 SDK | schema |
| `apps/cli` | `lumio` 命令行；联网获取论文元数据 | core, schema |
| `apps/hub` | Hub：API、监听、提议、自动提交；以后可加 MCP 适配层 | core, schema |
| `apps/runtime` | 设备 daemon，与 Hub 只走 HTTP | schema |
| `apps/feishu-bot`、`apps/web` 等 | 各个客户端 | api-client |

依赖方向由 `bun run lint:deps` 强制：`packages` 不依赖 `apps`，`apps` 之间不互相依赖。

## 3. 数据

### 3.1 vault 目录（ADR 0012）

```
library/   papers/ → paper     sources/ → source     refs.bib（生成物）
research/  ideas/ → idea       experiments/ → experiment     reports/（暂不扫描）
plan/      projects/ → project tasks/ → task
create/    posts/ → post
life/      assets/ → asset（私密）
files/     attachments/  drawings/（Excalidraw）  templates/     —— 不是实体，不扫描
```

- **类型由所在的类型目录决定**；映射表 `VAULT_LAYOUT`（`packages/core`）是唯一来源，其他代码不得写死路径。
- 类型目录下可以自由建子文件夹，只用于浏览，不影响类型。每个实体只对应一个 `.md` 文件。
- 扫描时跳过隐藏文件、`*.excalidraw.md` 和 frontmatter 含 `excalidraw-plugin` 的文件。
- 大文件（视频原片等）不进 vault，用 `media://<相对路径>` 引用，由各设备配置媒体根目录。

### 3.2 实体类型

所有实体共有：`id`（`<前缀>_<ULID>`）、`type`、`title`、`created`、`updated`（ISO 8601 带时区）、`tags`、`related`。

| 类型 | 前缀 | 要点 |
|---|---|---|
| paper | `pap` | `citekey`、`authors`、`year` 必填；`arxiv`、`doi`、`venue`、`url`；正文末尾有 BibTeX 一节 |
| source | `src` | 网页、视频、播客、课程、书；`kind`、`url`、`author`、`site` |
| idea | `idea` | `status`；可关联 `project` |
| project | `prj` | `status`、`goal`、`repo`、`deadline` |
| task | `task` | `status`、`assignee`（人或某个 agent）、`due`、`job` |
| experiment | `exp` | `project` 必填；`hypothesis`、`metrics`、`artifacts` |
| post | `post` | `format` 必填（无默认值）；`media` 按角色命名；`targets` 每个平台一个，发布结果由程序写入 |
| asset | `ast` | `kind` 必填；订阅、卡、账户、域名、保险、证件等；**私密**；禁止存完整卡号、CVV、密码、余额、证件号 |

字段的完整定义以 `packages/schema` 为准。

### 3.3 元数据规则

- **元数据由 Lumio 负责，Obsidian 只是编辑器**，不依赖 Obsidian 的模板或插件（ADR 0009）。
- 两种创建方式结果相同：`lumio new <类型>`，或直接在类型目录里随手写，再由补全器补齐；两者共用同一个补全器（ADR 0009）。
- **补全器只补缺失的字段**，不覆盖已有的值，不改正文和链接。缺失包括值为空（`null`）的情况（ADR 0008、0009）。
- 补全规则：类型取自目录，标题缺失时取文件名，`created` 取文件创建时间，`id` 新生成；无法推断的必填项只报告、不猜（ADR 0009）。
- 唯一例外是 **schema 中声明的"程序字段"**（如 post 的发布结果、asset 顺延的 `renews_on`），程序可以更新；
  这类更新必须经过 Hub（ADR 0009、0014）。
- 可选字段留空视为没填，带默认值的字段留空取默认值，必填字段留空报错；协议（job）不适用这条（ADR 0008）。
- 默认值不写进文件，读取时由 schema 补上。

### 3.4 论文 citekey（ADR 0004）

- 格式 `<第一作者姓>_<年份>_<缩写>`，如 `He_2020_LightGCN`；**同时是文件名、`[[链接]]` 和 `\cite{}` 的 key**。
- 全自动生成，不需要人确认：
  - 姓：去掉重音后删除所有非 ASCII 字母，只把首字母改成大写；删完为空时用 `Anon`。
  - 缩写：标题冒号前若是单个词就用它（删除非字母数字字符，`GPT-4` → `GPT4`）；否则取前四个实词的首字母；为空时用 `Paper`。
  - `--abbr` 可以主动指定缩写。
- 撞名（另一篇论文已占用）时自动加 `b`、`c`……；同一篇论文（arXiv 或 DOI 相同）则报"已存在"。
- 元数据来源：arXiv API、Crossref；BibTeX 只改 key，其余原样保留。

### 3.5 链接与 AI 区块

- 链接图包括 frontmatter 的 `related` 和正文中的 `[[名称]]`（去掉 `|别名`、`#标题` 后按文件名解析）；**两者都属于人**（ADR 0014）。
- 解析不到的标为悬空链接，不报错；代码块里的 `[[ ]]` 忽略。
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
- 查询两种模式都支持：设置 `LUMIO_HUB_URL` 时走 Hub，否则直接读本地 vault；查询逻辑在 `packages/core`，两边共用。

### 4.2 存放
- Hub 的运行数据放在 `~/.local/share/lumio/`（可配置），**不在 vault、不在 iCloud**：
  `index.sqlite`（派生索引，可重建）、`hub.sqlite`（身份、令牌、提议、审计记录、以后的 job，需要单独备份）（ADR 0014、0016）。

### 4.3 自动提交（ADR 0014）
- vault 安静 5 分钟（可配置）后自动提交一次；没有 git 仓库时跳过。
- Hub 启动时先全量补全与索引一次，覆盖它没运行期间的改动。
- 提交前检查疑似卡号，命中的文件不提交（见第 6 节）。

### 4.4 搜索（ADR 0014）
- SQLite FTS5 + trigram 分词；**少于 3 个字符的查询改用子串匹配**（trigram 搜不到两个汉字的词）。
- 范围：标题、正文、作者、citekey、tags。
- 索引用 WAL，遇到锁时等待（最多 5 秒）；Hub 与本地 CLI 可以同时使用同一个索引。
- 没有 ID 的笔记照样能搜到，结果里**不带 `id`**，只能按文件名引用；不生成替代 ID。

### 4.5 部署（ADR 0007、0017）
- **只做单用户、单机模式**：Hub 与 vault 都在 Mac 上，Mac 开着才能用。iPad、手机经 iCloud 同步来的修改等同于人直接改文件。
- 以后的服务器模式：Hub 与 vault 都搬到服务器上，其他设备都是客户端；**不存在两边各有一份、互相同步的模式**。
  服务器模式下 Obsidian 怎么用尚未决定（ADR 0017 第 5 节）。
- **远程访问用 Tailscale**：Hub 仍只监听 `127.0.0.1`，由 `tailscale serve` 转发并提供 HTTPS；服务器上的 Runtime 也这样访问。
- **Hub 只讲 HTTP**；以后上公网时由反向代理（Caddy、Cloudflare Tunnel）负责 HTTPS，代码不改。
- 所有地址可配置；只信任配置过的反向代理传来的客户端信息。
- 飞书 Bot 用官方 SDK 的长连接，不需要公网回调地址。

### 4.6 给 AI 派活（P2，ADR 0005）
- 区分 Job 与 Attempt，每次尝试有递增的 fencing 编号，过期的尝试不能覆盖新结果。
- 进程退出码为 0 不等于成功，输出要通过结果 schema 校验。
- 重启后状态不明的尝试标为 `unknown`，Job 标为 `needs_attention`，交给人；只有声明可重试且无副作用的失败才自动重试。
- engine（claude-code、codex、pi、script）与 transport（local、ssh、远端）分开；适配器锁定验证过的 CLI 版本。
- 不经过 shell，只执行登记过的程序；密钥在执行节点上才解析。
- Agent 不自己实现，Runtime 调用现成的 agent CLI。

## 5. AI 协作与权限（ADR 0014、0016）

- **AI 只能提议，链接由人建立**：AI 可以查询、新建想法和论文笔记、提议链接、重写 AI 区块；
  不能写人拥有的链接，不能改人写的正文。提议由人接受后，Hub 只写 frontmatter 的 `related`，永远不改正文。
- **AI 的入口是 CLI + skill**：`lumio search/show/links/propose … --json`，配合 `skills/lumio/SKILL.md`；
  Claude Code、Codex、pi 共用一份。MCP 只在出现没有 shell 的客户端时，作为薄适配层再加。
- **身份与令牌分开**（ADR 0016）：人和每个 AI agent 各是一个身份（`act_<ULID>`），角色是 `human` 或 `agent`；
  令牌只是身份的凭证，一个身份可以有多个，可单独吊销。提议、审计、日志里记身份 ID，不记令牌名称。
  令牌只显示一次，Hub 只存哈希；所有请求都要令牌，内网也不例外（ADR 0007）。
- **每次修改都是一个操作，只有一个入口**（ADR 0016）：程序对 vault 的修改表示为 `{ op, args }`（P1 只有 `link.add`），
  Hub 先 `authorize(身份, 操作)` 再执行。以后的完整权限系统只替换 `authorize`。
- **授权结果三种**：允许 → 立即执行；拒绝 → 403；**需要批准 → 生成提议**，提议里存完整的操作，人接受后 Hub 执行它。
  P1 规则：`human` 全部允许；`agent` 查询允许（私密除外），`link.add` 需要批准，决定提议、访问私密实体拒绝。
- **错误带决策信息**：错误响应统一为 `ApiError`（代码、说明、被拒绝的操作、原因、提议 ID），AI 据此向人解释。
- **审计**：每次授权与执行都记入 `hub.sqlite`；Hub 执行的操作立即单独提交，提交信息带 `Lumio-Actor`，
  经提议执行的还带 `Lumio-Proposal`、`Lumio-Approved-By`。自动保存的提交不带身份。
- **私密实体**（`life/` 下）：默认不出现在任何查询结果中；`agent` 令牌在任何情况下都拿不到；
  `human` 令牌须显式加 `--include-private`。`refs.bib`、报告等不得引用私密实体（ADR 0012、0014）。
- **局限**：不经过 Hub、直接读文件的 AI 拦不住，需要在 agent 的沙箱配置里排除 `life/`。

## 6. 安全

- **卡号防护**（ADR 0012）：写法像卡号（连续 13–19 位，或 4-4-4-4 / 4-6-5 分组）且通过 Luhn 校验即视为疑似卡号。
  - asset 校验报错；Hub 自动提交前和建索引前检查**所有文件**，命中的不提交、不索引，提醒人删除；
  - 错误和日志里永远不出现这串数字；判定函数在 `packages/schema/src/secrets.ts`。
  - 局限：文件本身已同步到 iCloud，需要人手动删除。
- **`life/` 只放记录和提醒**；真正敏感的内容（密码、完整卡号、证件号）放在密码管理器里，不进 vault。
- **密钥**：代码和配置里只写占位符（如 `${secret:openai}`），由运行时注入；令牌不进日志（AGENTS.md、ADR 0007）。
- vault 的 `.gitignore` 排除 Obsidian 插件设置文件（可能含明文密钥）。

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
| P1 | 本地查询与 `export bib`；Hub（身份与令牌、查询 API、监听、自动提交、操作与提议）；skill | 下一步 |
| P2 | 任务与实验；Runtime 与 job 派发；Python 实验 SDK；Chrome 插件入库 | |
| P3 | 飞书 Bot、多维表格镜像、定时工作流（含资产到期提醒） | |
| P4 | Web Dashboard、Docker / Nix、对外 SDK、手机端 | |
