# 0012 vault 目录分组；新增 source、post、asset 三种类型

- 状态：Accepted（部分实现：第 1、2、7 节已实现；第 4、5 节的数据格式已实现，程序行为未实现；第 3、6、8 节未实现）
- 日期：2026-10-23
- 相关：ADR 0004、0005、0006、0007、0008、0009、0010
- 同步修改：ADR 0004、0009（类型由路径决定）、ADR 0010（私密实体）、`docs/ARCHITECTURE.md`；
  vault 的 `README.md` 在迁移时更新

## 背景
1. vault 根目录已有 papers / ideas / projects / tasks / experiments / reports / templates 七个文件夹，
   如果再加外部资料、发布内容、资产、附件、画板，会超过十个，在 Obsidian 和手机上都难以浏览。
2. 有四类内容还没有归属：
   - 非论文的外部资料（网页教程、文章、视频、课程）；
   - 自媒体发布内容：可能是视频、图文或纯文本，要发到多个平台；
   - 订阅、银行卡、账户、域名等资产，以及它们的有效期和续费时间；
   - AI 生成的总结，以及附件（图片、PDF、Excalidraw 画板、视频原片）。
3. 现有实现的两个隐患：
   - `scanVault` 会递归扫描实体目录，并把其中**每一个** `.md` 都当成该类型的实体。
   - Excalidraw 画板是 `.excalidraw.md`。如果嵌入时建在 `ideas/` 下，
     `lumio sync` 会给它补上 idea 的 frontmatter，可能损坏画板。

## 决定

### 1. 目录分组
根目录只放**大类**，类型目录放在大类下面：

```
library/          读过、看过的（输入）
  papers/           paper
  sources/          source（新）
  refs.bib          生成物
research/         自己的研究产出
  ideas/            idea
  experiments/      experiment
  reports/          report（类型待定，暂不扫描）
plan/             要做的事
  projects/         project
  tasks/            task
create/           对外发布
  posts/            post（新）
life/             个人事务
  assets/           asset（新，私密，见第 6 节）
files/            不是实体，不扫描
  attachments/      图片、PDF
  drawings/         Excalidraw 画板
  templates/
```

规则：
- **类型由路径中的类型目录决定**（延续 ADR 0009）。路径与类型的对应表放在 `packages/core` 中，
  是唯一的映射来源；其他代码不得硬编码 `papers/` 之类的路径。
- **类型目录下可以自由建子文件夹**，例如 `life/assets/subscriptions/`、`library/sources/obsidian/`。
  子文件夹只用于浏览，不影响类型；扫描器本来就会递归扫描。
- **每个实体只对应一个 `.md` 文件**，实体目录下不放附属的 `.md` 文件。
- 扫描器在实体目录中**跳过** `*.excalidraw.md`，以及 frontmatter 含 `excalidraw-plugin` 键的文件，作为防御。
- Obsidian 设置（由人配置，不属于代码）：新附件放在 `files/attachments/`；Excalidraw 文件夹设为
  `files/drawings/`，并开启 `embedUseExcalidrawFolder`；「模板」插件指向 `files/templates/`。
- **大文件（视频原片、剪辑工程）不进 vault**，通过 `media://` 引用（见第 4 节）。
- 文件名不变，citekey 规则不变（ADR 0004）；`[[He_2020_LightGCN]]` 这类最短路径链接不受搬迁影响。

### 2. 新类型 `source`：外部资料
ID 前缀 `src`，位于 `library/sources/`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | `web \| video \| podcast \| course \| book`，默认 `web` | |
| `url` | 可选 URL | `book` 可以没有 |
| `author` | 可选字符串 | |
| `site` | 可选字符串 | 来源站点或平台名 |
| `status` | `to-read \| reading \| read`，默认 `to-read` | 与 paper 一致 |

正文结构沿用论文笔记：「一句话 / 我的笔记 / 可以引用的点 / 和我的研究的关系」。
学习笔记直接写在这份文件里，**不另设 notes 类型**。

### 3. AI 产出的区块
AI 生成的总结、评估等内容，写在所属笔记正文中的**标记区块**里，不另建文件：

```markdown
<!-- lumio:ai start name=summary model=<模型> generated=<ISO 时间> -->
……
<!-- lumio:ai end name=summary -->
```
- 可以出现在任何实体的正文中；同一文件可以有多个区块，以 `name` 区分。
- 这是 ADR 0006 所说的"明确标为 AI 产出的内容"：AI 只能整体重写区块**内部**，
  不得改动区块外的正文和链接。
- 人修改了区块内的内容后，再次生成时会被覆盖；想保留的内容应移到区块外，移出后就归人所有。
- 区块内的 `[[链接]]` 不计入人拥有的链接图，由 indexer 单独标记为 AI 提议。

### 4. 新类型 `post`：发布内容
ID 前缀 `post`，位于 `create/posts/`。核心模型是：**一篇 post 对应一件要表达的事；
发到每个平台算一次 target。** 内容只写一份，平台差异单独记录，发布结果按平台分别记录。

**frontmatter**

| 字段 | 类型 | 归属 | 说明 |
|---|---|---|---|
| `format` | `video \| gallery \| article \| text` | 人 | 默认形态，target 可以覆盖 |
| `status` | `idea \| drafting \| ready \| done`，默认 `idea` | 人 | 内容本身的进度 |
| `derived_from` | `Id[]`，默认 `[]` | 人 | 来源的 source / idea / paper |
| `media` | `Record<角色, MediaRef \| MediaRef[]>`，默认 `{}` | 人 | 按用途命名，例如 `main`、`vertical`、`cover`、`images` |
| `targets` | `Target[]`，默认 `[]` | 见下表 | |

**Target**

| 字段 | 类型 | 归属 |
|---|---|---|
| `platform` | 字符串，kebab-case（如 `bilibili`、`xiaohongshu`） | 人 |
| `format` | 可选，覆盖 post 的 `format` | 人 |
| `media` | 可选，`media` 中的角色名 | 人 |
| `schedule` | 可选 Timestamp | 人 |
| `status` | `pending \| scheduled \| published \| failed`，默认 `pending` | 程序 |
| `url` | 可选 URL | 程序 |
| `published_at` | 可选 Timestamp | 程序 |
| `error` | 可选字符串 | 程序 |

- **归属为"程序"的字段**由发布流程经 Hub 写入（ADR 0007），人一般不手改。
  唯一的例外是：人可以把 `failed` 改回 `pending` 来要求重发。
- `failed` **不自动重试**，交给人判断（ADR 0005），以免平台上发出重复内容。
- 所有 target 都变成 `published` 后，Lumio 可以**提议**把 post 改为 `done`，但不直接修改。
- `platform` 在 schema 中只校验格式，不枚举具体平台；新增平台不需要改契约。

**MediaRef** 是以下两种之一：
- vault 内的相对路径，例如 `files/attachments/cover.png`；
- `media://<相对路径>`：指向 vault 外的媒体根目录。各设备在本机配置中把它解析成本地路径
  （例如 Mac 上解析为 `~/Movies/Lumio/`）。代码不假设媒体根目录在哪台机器上。

**正文**
```markdown
## 正文            主稿，所有平台默认都用这一份
## 视频脚本         format 为 video 时使用
## 平台：<platform> 可选，只写与主稿不同的部分（标题、文案、标签）
```

**平台规则分三层存放**

| 内容 | 位置 |
|---|---|
| 平台能力：支持的 format、标题与正文长度上限、标签数量、视频比例 | `packages/core` 中的平台表（纯数据，无网络） |
| 个人默认值：各 format 默认发哪些平台、固定签名、默认标签 | `files/publishing.md` 的 frontmatter（手机上的 Obsidian 也能编辑） |
| 账号、登录态、实际上传 | AiToEarn；Lumio 不保存任何凭据 |

补全器（ADR 0009）在 `targets` 为空时，按个人默认值和 `format` 生成 target。
post 改为 `ready` 时，按平台表逐个校验 target，有问题只报告给人，不自行修改。

### 5. 新类型 `asset`：订阅、卡、账户、域名
ID 前缀 `ast`，位于 `life/assets/`。所有资产共用一个类型，用 `kind` 区分；与续费相关的字段都是可选的。

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | `subscription \| domain \| card \| bank-account \| account \| server \| insurance \| document \| other` | `document` 指护照、签证、驾照等证件 |
| `provider` | 可选字符串 | 服务商、发卡行、注册商 |
| `status` | `active \| paused \| cancelled \| expired`，默认 `active` | 人 |
| `cost` / `currency` | 可选数字 / 可选 ISO 4217 代码 | 每个周期的金额 |
| `cycle` | 可选：`monthly \| yearly \| once` 或天数 | |
| `renews_on` | 可选日期 | 下次扣费日；程序可按 `cycle` 顺延（见下文） |
| `expires` | 可选日期或 `YYYY-MM` | 卡面有效期、域名到期日 |
| `auto_renew` | 可选布尔 | |
| `paid_with` | 可选 `ast_` ID | 由哪张卡或哪个账户支付 |
| `login` | 可选字符串 | 登录用的邮箱或用户名 |
| `last4` | 可选，4 位数字字符串 | 卡或账户的后四位 |
| `vault_item` | 可选字符串 | 密码管理器中对应条目的名称 |
| `manage_url` | 可选 URL | 管理或退订的入口 |

**禁止存放的内容**：完整卡号或账号、CVV、密码、密钥、余额、证件号码（`document` 只记类型和到期日）。
完整信息只放在密码管理器中，用 `vault_item` 指向。

**卡号防护**（修订）：
- **判定规则**：一段数字**写法像卡号**，并且**通过 Luhn 校验**，即视为疑似卡号。"写法像卡号"指：
  连续 13–19 位数字；或用同一种分隔符（空格或连字符）按常见卡号格式分组：4-4-4-4（可再跟 1–3 位）、4-6-5。
  Luhn 是所有银行卡号都满足的校验规则。只认这几种写法，是为了不把日期区间、电话、ISBN 之类误判成卡号。
  YAML 中不加引号的长数字会被解析成数字，同样检查。判定函数放在 `packages/schema/src/secrets.ts`，供各处共用。
- **只做 schema 校验是不够的**：人在 Obsidian 里写下卡号的那一刻，文件就已经同步到 iCloud。
  真正要拦的是之后的扩散，因此：
  - asset 的 schema 校验失败（报告给人）；
  - **Hub 自动提交前**检查所有待提交文件的原始文本，含疑似卡号的文件**不提交**，并提醒人删除（ADR 0011 第 6 条）；
  - **索引时**跳过含疑似卡号的文件，不进入全文索引；
  - 任何错误信息与日志都**不回显**这串数字。

**程序行为**：
- `auto_renew: true` 且 `renews_on` 已过期时，补全器按 `cycle` 把 `renews_on` 顺延到下一个周期（这属于"程序"字段的更新）。
- 到期提醒（P3 定时工作流）：订阅提前 7 天，域名提前 30 天，卡片提前 60 天，通过飞书提醒。
- 支持查询"哪些资产的 `paid_with` 指向这张卡"，用于换卡或挂失时排查。
- 域名可以通过 RDAP 核对真实到期日（属于 Hub / Runtime 的网络操作，不在 core 中做），不一致时只提醒，不改写。

### 6. 私密实体与 AI 访问
- `life/` 下的实体默认标记为**私密**。私密是由路径决定的属性，不写进 frontmatter。
- Hub API 与 CLI（ADR 0010）的查询类命令**默认排除私密实体**。
- **由令牌角色执行**（修订，见 ADR 0011 第 4 条）：程序无法分辨敲命令的是人还是 AI，因此不依赖"确认"：
  - `agent` 令牌：**无论传什么参数，都拿不到私密实体**；
  - `human` 令牌：显式传入 `--include-private` 时才返回。
  skill 中仍写明 AI 不得使用这个参数，但安全不依赖它。
- 局限：在有 shell 的设备上，AI 仍然可以直接读取 vault 文件，Hub 拦不住这条路径。
  这条规则只约束经过 Lumio 的访问；要真正隔离，需要在 agent 的沙箱配置中排除 `life/` 目录（属于部署配置）。
- 生成的 `refs.bib`、报告等**不得引用私密实体**。

### 7. schema 与代码变更（已完成：P0-5、P0-6，PR #8）
- `ID_PREFIXES` 增加 `source: "src"`、`post: "post"`、`asset: "ast"`。
- 新增 `Source`、`Post`、`PostTarget`、`MediaRef`、`Asset`，并加入 `Entity` 联合类型。
- `packages/core`：用"路径 → 类型"映射表取代 `DIRECTORIES`；`paper.ts`、`create.ts` 中硬编码的
  `papers/`、`ideas/` 改为从映射表取得；扫描器跳过 Excalidraw 文件。
- `entities.ts` 中注释的路径 `vault/papers/<citekey>.md` 随之更新。

### 8. 迁移（待执行）
vault 中的现有内容很少（4 篇论文、1 个想法、1 份报告），一次性搬迁即可：
用 git mv 把各目录移到新位置，同时更新 Obsidian 设置和 vault 的 README。不提供旧路径的兼容模式。
迁移清单见 `docs/tasks/P0-6-vault-layout.md` 末尾。另外，已有论文笔记顶部的 `> [!note] AI 草稿` 提示
改为第 3 节的 `<!-- lumio:ai -->` 区块格式。

## 范围
- 本 ADR 只定义目录结构、数据格式和访问边界。
- **不包括**：`lumio new source|post|asset` 命令、平台表的具体内容、发布配置的格式、
  与 AiToEarn 的对接、提醒工作流、RDAP 查询。这些在批准后另写 task spec。

## 后果
- 好处：
  - 根目录从十多个文件夹减少到六个，类型目录下还可以按需建子文件夹。
  - 视频、图文、纯文本共用一套发布结构；发布结果按平台记录，不会重复发布。
  - 订阅和资产有了统一的地方，可以做到期提醒和换卡排查。
  - 敏感信息有明确的禁存规则和访问边界。
  - 修复了 Excalidraw 画板被误识别为实体的隐患。
- 代价：
  - 一次性搬迁，并修改 ADR 0009、0010 及相关文档。
  - 路径变深，CLI 输出和链接预览里的路径更长。
  - 私密边界只约束经过 Lumio 的访问，直接读文件的 agent 需要另行隔离。
  - `media://` 需要每台设备单独配置媒体根目录。

## 讨论记录
- 大类划分与命名：人类确认（2026-10-23）。
- `source.kind` 加 `podcast`；`asset.kind` 加 `insurance`、`document`；发布配置放 `files/publishing.md`（2026-10-23）。
- 身体与运动数据**不建类型**：原始数据留在 Apple Health 等应用中；训练计划、体检预约用 `task`。
  以后若反复需要在 Lumio 中记录，再另立 ADR。

## 修订记录
- 2026-10-23：卡号防护改为"卡号写法 + Luhn 校验"，并前移到 Hub 提交与建索引之前（批准：人类）
- 2026-10-23：私密实体的访问改为由令牌角色执行，不再依赖"人在会话中确认"（批准：人类）
