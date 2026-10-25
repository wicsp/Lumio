# P0-5 schema：source、post、asset 三种新类型

- 负责：Claude 起草，人类批准　Review：Codex
- 状态：✅ 已完成（2026-10-23，PR #8，经人类批准）
- 相关 ADR：0012、0008、0014
- 涉及：`packages/schema`（**契约变更**）
- 依赖：P0-4

## 背景
ADR 0012 新增三种实体类型。本任务只改契约，不改 core 和 CLI；路径映射与迁移在 P0-6 完成。

## 范围
1. `ID_PREFIXES` 增加 `source: "src"`、`post: "post"`、`asset: "ast"`。
2. 新增以下 schema，字段、默认值和取值完全按照 ADR 0012 第 2、4、5 节：
   - `Source`；
   - `Post`、`PostTarget`、`MediaRef`；
   - `Asset`。
   可选字段一律用 `optional()`，带默认值的字段用 `withDefault()`（ADR 0008）。
3. `MediaRef`：字符串，必须是 vault 内的相对路径（不以 `/` 开头，不含 `..`），
   或者以 `media://` 开头、后面同样是不含 `..` 的相对路径。
4. `PostTarget` 用 `strictObject`；`platform` 只校验 kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`）。
   `PostTarget.media` 必须是 `Post.media` 中存在的角色名：在 `Post` 上用 `superRefine` 检查。
5. `Asset`：
   - `expires` 接受 `YYYY-MM-DD` 或 `YYYY-MM`；`renews_on` 只接受 `YYYY-MM-DD`；
   - `last4` 为正好 4 位数字的字符串；
   - `cycle` 为 `monthly | yearly | once`，或正整数（天数）；
   - `last4` 也接受 YAML 解析出的整数（`last4: 0123` 会被解析为 123），并补回前导零。
   - **疑似完整卡号防护**（ADR 0012 修订后的规则）：frontmatter 中任何键或值（含未知字段、嵌套结构、数字），
     出现"写法像卡号且通过 Luhn 校验"的数字时校验失败，错误信息不得回显该数字。
     判定函数 `textContainsCardNumber` / `containsCardNumber` 放在 `src/secrets.ts`，供 Hub 复用。
6. 把三种类型加入 `Entity` 联合类型，导出对应的 TypeScript 类型，重新生成 JSON Schema。

## 不做
- 不实现 `asset` 的续费日顺延、提醒、RDAP 查询；不实现平台表。
- 不改 `packages/core`、`apps/*`（编译受影响时只做最小修改，并在汇报中说明）。

## 验收标准
1. `bun run check` 通过。
2. 契约测试：ADR 0012 中的每个示例都能通过校验；`fixtures/` 中新增 source、post、asset 的合法与非法样例各若干。
3. 误判测试：日期区间、手机号、ISBN、ISO 时间、ULID、arXiv 号、DOI、Luhn 不通过的 16 位数字都**不**被判为卡号。
4. 非法样例至少包括：`media` 为 `../x.mp4` 或 `/abs/x.mp4`；target 引用不存在的媒体角色；
   `platform: "Bilibili"`；`last4: "123"`；在 `login` 或 `title` 中写入 16 位卡号（包括带空格和连字符的写法）。
5. 字段留空（`null`）时，按 ADR 0008 视为未填写或取默认值。
