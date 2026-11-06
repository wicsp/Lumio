# Knowledge：知识目录、实体与链接

> 现行设计分册，只写现在生效的规则；总览、跨模块规则与写法见 [`../DESIGN.md`](../DESIGN.md)。

## vault 目录（ADR 0012）

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

## 实体类型

本表描述知识目录中的文件格式；Project/Task/Routine 保留旧格式兼容，新业务对象与数据库规则见 [work.md](work.md)。

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

## 元数据规则

- **元数据由 Lumio 负责，编辑器只是编辑器**，不依赖任何编辑器的模板或插件（ADR 0009、0022）。
- Web 新建入口可在保存前完整撰写正文；已有笔记仍可用外部编辑器修改。创建回执位于 `hub.sqlite` 的 `knowledge_creations`，按身份与请求 ID 去重；中断后重试核对同一文件，文件被改或已发布后丢失时要求人工核对，禁止覆盖（ADR 0034）。
- 两种原有创建方式结果相同：`lumio new <类型>`，或直接在类型目录里随手写，再由补全器补齐；两者共用同一个补全器（ADR 0009）。
- **补全器只补缺失的字段**，不覆盖已有的值，不改正文和链接。缺失包括值为空（`null`）的情况（ADR 0008、0009）。
- 补全规则：类型取自目录，标题缺失时取文件名，`created` 取文件创建时间，`id` 新生成；无法推断的必填项只报告、不猜（ADR 0009）。
- 唯一例外是 **schema 中声明的"程序字段"**（如 post 的发布结果、asset 顺延的 `renews_on`），程序可以更新；
  这类更新必须经过 Hub（ADR 0009、0014）。
- 可选字段留空视为没填，带默认值的字段留空取默认值，必填字段留空报错；协议（job）不适用这条（ADR 0008）。
- 默认值不写进文件，读取时由 schema 补上。例外是需要人拨动的开关：任务与例行任务的 `status`、任务的 `assignee`（`human`），缺失时补全器写上默认值（ADR 0023、0024）。

## 论文 citekey（ADR 0004）

- 格式 `<第一作者姓>_<年份>_<缩写>`，如 `He_2020_LightGCN`；**同时是文件名、`[[链接]]` 和 `\cite{}` 的 key**。
- 全自动生成，不需要人确认：
  - 姓：去掉重音后删除所有非 ASCII 字母，只把首字母改成大写；删完为空时用 `Anon`。
  - 缩写：标题冒号前若是单个词就用它（删除非字母数字字符，`GPT-4` → `GPT4`）；否则取前四个实词的首字母；为空时用 `Paper`。
  - `--abbr` 可以主动指定缩写。
- 撞名（另一篇论文已占用）时自动加 `b`、`c`……；同一篇论文（arXiv 或 DOI 相同）则报"已存在"。
- 元数据来源：arXiv API、Crossref；BibTeX 只改 key，其余原样保留。

## 链接与 AI 区块

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

## 在 Lumio 里新建与编辑笔记（ADR 0034 §1–5、0035 §1–8；本地验收中）

- **只对 human 开放**：新建与编辑接口不授予 agent / runtime。human 可新建论文、视频、网页、想法。
- **可编辑范围**：合法、公开的 paper / source / idea / experiment / post 可在 Web 里直接编辑标题与正文；私密笔记、旧工作笔记和元数据不合法的笔记保持只读。
- **不覆盖外部修改**：保存带 SHA-256 版本检查与可恢复的幂等回执；检测到外部更新时冲突，保留草稿并提供比较。保留未知元数据，保存后更新索引与链接。
- **原文就是 Markdown**：编辑器保留原始 Markdown；`[[` 候选插入的链接统一保存为标准 Markdown 链接，脚注保存为 Markdown 上标脚注，文末编号按首次出现排列。
- **相关推荐**：词法匹配，最多 5 篇、默认 3 篇，附命中片段；`[[` 空查询使用所在段落作上下文，输入后搜索标题与正文。
- 界面与交互细节见 [`apps/web/README.md`](../../apps/web/README.md)。

## 自动提交（ADR 0014）
- vault 安静 5 分钟（可配置）后自动提交一次；没有 git 仓库时跳过。任何非隐藏文件的变化都会重新计时（报告、附件也会被提交），补全只处理笔记。
- Hub 启动时先全量补全与索引一次，覆盖它没运行期间的改动。
- 提交前检查疑似卡号，命中的文件不提交（见 [security.md](security.md)「安全」一节）。

## 搜索（ADR 0014）
- SQLite FTS5 + trigram 分词；**少于 3 个字符的查询改用子串匹配**（trigram 搜不到两个汉字的词）。
- 范围：标题、正文、作者、citekey、tags。空查询列举可见笔记，可配合 `type` 过滤；旧任务可用 `lumio task list --legacy` 列举。
  新版 `lumio task list` 使用独立 Work 查询，不伪造笔记路径（ADR 0025）。
- 索引用 WAL，遇到锁时等待（最多 5 秒）；Hub 与本地 CLI 可以同时使用同一个索引。
- 没有 ID 的笔记照样能搜到，结果里**不带 `id`**，只能按文件名引用；不生成替代 ID。
