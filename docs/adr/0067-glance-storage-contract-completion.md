# 0067 补齐所见入库与托管文件归属契约

- 状态：Proposed（等待人类批准，尚未修改 `packages/schema`）
- 日期：2026-11-16
- 领域：契约、存储格式与兼容
- 关联：ADR 0025、0057、0066；C1-2 / C1-3 / C1-4 / C1-6；PR #221、#222

## 背景

人要求完成 C1-2、C1-3、C1-4、C1-6。检查 #222 合入后的契约，发现三处无法满足 C1-0 已描述的入库行为：

1. `packages/schema/src/entities.ts` 的 `Source.kind` 只接受 `web/video/podcast/course/book`，不接受无网址所见所需的 `text`。
2. `packages/schema/src/inbox.ts` 的 `OriginalFrontmatter` 是严格对象，只接受 `of/url/captured/extractor/lang/sha256/pdf`；
   C1-0 要求的 `glance/screenshot/app/window` 与指向判定方式都会被拒绝。`writeOriginal` 与原文读取均使用此契约校验。
3. `packages/schema/src/storage.ts` 的 `StoredArtifact.owner` 只接受 `ResourceRef`，而 `gln_` 明确不是 ResourceRef。
   上传后、尚未用于捕获或对话时，截图没有可合法填写的现有业务对象归属。

以上三项已用合成数据调用当前 schema 的 `safeParse` 复现：分别返回 `invalid_value`、`unrecognized_keys`、`invalid_value`。
这不是放宽 Hub 校验就能修复的问题。绕过 schema 会令读写、业务备份或其他客户端对同一数据产生不同解释。
AGENTS.md 第 1 条要求先提出契约 ADR、经人类批准后再实现。

## 提议

### 1. 无网址的资料

在 `Source.kind` 增加 `text`，用于无网址的桌面所见；有网址仍为 `web`，论文仍走现有论文路径。
默认值保持 `web`，不改写现有资料，也不改变普通文字捕获的既有行为。

### 2. 原文的所见元数据

保持 `OriginalFrontmatter` 为严格对象，新增以下可选字段：

| 字段 | 类型 | 用途 |
|---|---|---|
| `glance` | `idOf("gln")` | 原文所依据的所见 |
| `screenshot` | `idOf("art")` | 所见截图的托管文件 ID |
| `app` | `GlanceApp` | App 名称与可选 bundle ID |
| `window` | 字符串，最多 `GLANCE_LIMITS.max_window_title_chars` | 窗口标题 |
| `pointing` | `GlancePointing` 的 `method` 枚举 | selection / region / point / none |

这些字段只在所见来源的原文中写入。全文识字、选中文字、光标轨迹仍由 Glance 记录负责，不重复写成 frontmatter。
正文按 ADR 0066 保留“指向的段落”和“窗口文字”；已有原文缺少新增字段时仍合法。

### 3. 托管文件的所见归属

新增独立的 `ArtifactOwner` 契约，取以下两者之一：

- 现有 `ResourceRef`；
- 严格对象 `{ module: "capture", id: idOf("gln") }`，仅表示 Hub 捕获协调数据的文件归属。

`StoredArtifact.owner` 改用 `ArtifactOwner`。不向 `Module` 或 `ResourceRef` 增加第五个业务模块，
也不把 `gln_` 塞进 knowledge、assistant 或 execution；其余 ResourceRef 使用方保持现有边界。

截图从上传开始就归所属所见，后续通过 `used_by.capture/message` 关联用途，不伪造笔记、消息或 Job 来挂文件。
复用现有 staged/ready 发布、大小与哈希校验、业务备份与恢复。保留期清理后，Glance 中保留文件 ID、哈希及 `purged` 时间；
不再让业务备份引用已删除的文件。清理与资料回收站遵守 ADR 0066 第 5 节，不扩大截图可见性。

权限检查必须显式区分所见归属：执行归档接口仍仅允许原来的 Job 所有者，不能凭 runtime 或 agent 身份注册、读取所见截图。
所见截图只能通过 `/v2/glances/<id>/image` 由该所见的 human 所有者读取。

## 兼容与验证

- 不迁移或重写既有 vault、原文或托管文件；既有记录继续通过新契约。
- 新产生的 `text`、所见原文及所见文件归属不保证能由旧版本识别。因此产生新数据后，不把直接安装旧二进制视为可靠回退；
  回退必须先评估数据兼容性，必要时使用升级前的一致性备份，明确后续新增数据的处置。
- 增加契约测试：旧样例兼容、无网址所见、完整原文元数据、非法字段、错误 ID 前缀及 `gln_` 仍不属于 ResourceRef。
- 增加 Hub / Storage 测试：归属校验、上传发布与失败恢复、备份恢复、截图清理后备份、agent/runtime 拒绝访问；全部使用合成数据。
- Swift 请求继续按 #222 的 `GlanceCreate` / `CaptureCreate` / `AssistantChatRequest`，本提议不改变上传或对话请求格式。
- 批准后按契约连带修改规则实施 `packages/schema` 及必要使用方，生成 JSON Schema，并运行 `bun run check`。

## 考虑过的替代方案

- 把无网址资料标成 `web`、把截图信息塞进正文：避开了校验，但不满足已批准的资料类型与结构化来源要求。
- 为截图伪造 ResourceRef，或提前创建空笔记/对话：使文件归属与用户实际操作不符。
- 另外维护一套截图文件表及备份分支：可以避免扩展 `StoredArtifact`，但重复 staged/ready、校验、清理与备份逻辑，偏离复用托管文件的要求。
- 把 `OriginalFrontmatter` 改成宽松对象：扩大整个原文格式的接受范围，而所需字段有限且明确。

本提议选择显式补齐三处契约。批准前不修改 schema，不合并依赖本提议的实现，也不部署。
