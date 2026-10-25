# 0008 vault 实体中的空值视为未填写

- 状态：Implemented（2026-10-23）
- 日期：2026-10-22
- 领域：数据

## 背景
人手写 frontmatter 时会留空字段，例如模板里的 `venue:`。YAML 把它解析为 `null`，
而原 schema 只接受"字符串或字段缺失"，导致合理的手写笔记校验失败。

## 决定
- vault 实体（paper、idea、project、task、experiment）中：
  - **可选字段**为 `null` 时，视同未填写（解析结果为 `undefined`）。
  - **带默认值的字段**为 `null` 时，取默认值（如 `status: to-read`、`tags: []`）。
  - **必填字段**（`id`、`title`、`citekey` 等）仍然拒绝 `null`。
- 实现：`packages/schema/src/common.ts` 中的 `optional()` 与 `withDefault()`。
- job 协议**不适用**本规则：协议由程序生成，空值说明有 bug，应当报错。
- 导出的 JSON Schema 中，这些字段的类型包含 `null`，且不在 `required` 中。

## 后果
- 好处：模板可以保留全部字段名作为提示，人按需填写。
- 代价：工具写回文件时需要约定空字段的输出方式（省略或写成空值），在 P0 实现时决定。
