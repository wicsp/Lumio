# 0003 以 Zod 作为契约，导出 JSON Schema 给其他语言

- 状态：Implemented（2026-10-22）
- 日期：2026-10-22
- 领域：工程基础
- 取代：本 ADR 早先的提议版本"以 JSON Schema 作为跨语言契约"

## 背景
实体（paper、idea、project、task、experiment）和 job 协议需要在 CLI、Hub、Runtime、各客户端
之间共享，Python 实验 SDK 也需要。早先提议以手写 JSON Schema 为源头生成各语言类型，
研究发现"JSON Schema → 代码"方向的生成器目前都不够成熟（见 ADR 0002）。

## 决定
- `packages/schema` 中的 Zod 定义是唯一事实来源，同时提供运行时校验和 TS 类型。
- `bun run schema:export` 用 Zod 的 `z.toJSONSchema()`（稳定 API）导出 draft 2020-12 的
  JSON Schema 到 `packages/schema/json/`，供 Python 等其他语言生成类型。导出物不入库、不手改。
- vault 实体用宽松对象（`looseObject`）：frontmatter 中的未知字段解析后原样保留，
  避免改写文件时丢掉 Obsidian 等工具写入的字段。
- job 协议用严格对象（`strictObject`）：未知字段直接拒绝，协议变更必须显式进行。
- 契约测试位于 `packages/schema/test/`，覆盖 citekey 规则、默认值、字段保留和导出。

## 后果
- 好处：方向是"代码 → JSON Schema"，这是成熟的方向；TS 侧零生成步骤。
- 代价：契约绑定在 TS 上；其他语言是二等公民，只能读导出的 JSON Schema。
