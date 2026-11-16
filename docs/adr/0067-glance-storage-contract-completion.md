# 0067 所见入库契约：资料类型、原文来源与托管文件归属

- 状态：Implemented（2026-11-16 人类批准；契约由 B0-1 一并实施）
- 日期：2026-11-16
- 领域：契约、存储格式
- 关联：ADR 0025、0057、0066、0068；C1-2 / C1-3 / C1-4 / C1-6；PR #221、#222

## 背景

#222 合入的契约无法表达 ADR 0066 已决定的入库行为（三处均已用合成数据调用 `safeParse` 复现）：

1. `Source.kind` 没有 `text`，而 ADR 0066 规定无网址的所见生成 `kind: text` 的资料；同时 `CaptureKind` 已有 `text`，两套资料类型各自维护、已经不一致。
2. `OriginalFrontmatter` 是严格对象，不能记截图、App、窗口与所见。
3. `StoredArtifact.owner` 只接受 `ResourceRef`，`gln_` 不是 ResourceRef，截图没有合法归属。

项目处于开发期，可以做破坏性修改（ADR 0068）。本 ADR 按长期设计补齐，而不是按最小改动打补丁；取代 #223 初稿的平铺字段与 `module: "capture"` 方案。

## 决定

### 1. 资料类型只有一份定义

`entities.ts` 定义 `SOURCE_KINDS = ["web", "video", "podcast", "course", "book", "text"]`，`Source.kind` 用它；
`CaptureKind` 改为由它派生：`z.enum(["paper", ...SOURCE_KINDS])`，不再单独列举。
`text` 表示没有网址的资料（粘贴正文或无网址的所见）。有网址仍为 `web` 等，论文仍走论文路径。

### 2. 原文的来源写成一个结构

`OriginalFrontmatter` 仍是严格对象，新增一个可选的嵌套对象 `glance`，替代 #223 草案中的五个平铺字段：

```ts
glance: z.strictObject({
  id: idOf("gln"),
  app: GlanceApp,
  window: z.string().max(GLANCE_LIMITS.max_window_title_chars).optional(),
  screenshot: idOf("art").optional(),          // 截图已不保存时缺省
  pointing: GlancePointing.shape.method,        // selection / region / point / none
}).optional()
```

理由：这几项只会一起出现，平铺会让"有 app 却没有 glance"之类的组合也合法；嵌套后由类型保证。
vault 是知识的权威来源，原文脱离 Hub 也应能看懂来自哪个 App、哪个窗口，所以 App 与窗口照抄进 frontmatter；
识字块、轨迹、选中文字只留在 Glance 记录里，不重复。`extractor` 用 `glance-ocr@1`（本机识字）或 `glance-vision@1`（`knowledge.vision`）。

### 3. 托管文件的归属：业务对象或 Hub 协调对象

`work.ts` 不变（`Module` 仍只有四个业务模块，`ResourceRef` 不收 `cap_`/`gln_`）。`storage.ts` 新增：

```ts
/** Hub 的跨模块协调数据（捕获、所见），不是业务模块，不进 ResourceRef。 */
export const HubRef = z.strictObject({ module: z.literal("hub"), id: z.union([idOf("cap"), idOf("gln")]) });
export const ArtifactOwner = z.union([ResourceRef, HubRef]);
StoredArtifact.owner: ArtifactOwner
```

用 `module: "hub"` 而不是 `"capture"`：存储表按 `owner_module/owner_id` 两列存，`hub` 如实说明它是 Hub 协调数据，不会被误读成捕获记录。

**归属随用途转移**（取代"截图永远归所见"）：

- 上传后、尚未入库：归 `{ module: "hub", id: gln_… }`。只用于对话的截图一直如此，到保留期删除，Glance 留下 `purged` 时间与哈希。
- 所见存成资料时：Hub 在生成资料的同一事务里把截图归属改为 `{ module: "knowledge", id: src_… }`，此后随资料进回收站、恢复与业务备份，
  不需要另外的关联规则。论文 PDF（`OriginalFrontmatter.pdf`，ADR 0057）同样归 `{ knowledge, pap_… }`。
- Storage 增加"转移归属"操作：只允许 `hub → knowledge`，在同一事务内校验目标存在且属于同一 human。

**读取权限**：`execution` 文件规则不变（现有代码都显式判断 `module === "execution"`）。
`knowledge` 文件按所属实体的可见性与私密规则读取；`hub` 文件只能由所见的 human 所有者经 `/v2/glances/<id>/image` 读取。
runtime 与 agent 身份不能登记或读取 `hub` 文件。

## 兼容

开发期，不保留旧格式读取（ADR 0068）。现有数据中没有 knowledge 或 hub 归属的托管文件，`pdf` 字段尚未实际写入，因此无需迁移。
Swift 请求格式（`GlanceCreate` / `CaptureCreate` / `AssistantChatRequest`）不变。

## 验证

- 契约测试：`CaptureKind` 与 `SOURCE_KINDS` 一致；无网址所见原文；`glance` 对象缺项、多项、错误前缀被拒绝；`HubRef` 只收 `cap_`/`gln_`；`gln_` 仍不是 ResourceRef。
- Storage / Hub 测试：上传归 hub → 入库后转为 knowledge → 随资料删除与恢复 → 业务备份含该文件；只用于对话的截图到期清理；agent/runtime 读取被拒。全部合成数据。

## 考虑过的替代方案

- 平铺五个可选字段（#223 初稿）：允许无意义的组合，靠运行时约定保证一致。
- 截图永远归所见：资料删除、恢复、备份要再写一套"经 used_by 找截图"的规则。
- 把 `hub` 加进 `Module`：所有以 ResourceRef 为输入的接口与能力目录都要处理一个不是业务模块的东西。
- `OriginalFrontmatter` 改宽松对象：扩大整个原文格式，而需要的字段有限且明确。
