# R0-7 Assistant 记忆契约（Claude 起草）

**状态：** 已实现并验证。依据已批准 ADR 0025 与范围内必要契约细化授权；Claude CLI 4f81487a-4da2-415f-828e-e2d749c45cc3 起草，Codex 复核。

**契约连带范围：** schema 与生成物、Assistant 端口/用例、Storage、Hub 路由/身份/审计、API Client、CLI；仅为显式记忆命令和身份隔离所需调用方。

**目标：** 为 Assistant 模块添加最小化严格 v2 记忆命令契约，只接受人类显式偏好/事实；不做应用实现或授权细节。

## 背景（ADR 0025 第 7 节）

- Assistant 负责对话、消息、轮次、工具调用**和记忆**。
- 记忆是助手的长期上下文片段；**本切片只处理用户显式告知的偏好或事实**，不提供从对话自动提取或 agent 自动调用权限。
- 记忆继承来源的访问限制；应用控制 `private` 标记与来源可见性。

## 决定

在 `packages/schema/src/assistant.ts` 中新增：

### 1. 记忆命令 discriminated union

```typescript
AssistantMemoryCommand = discriminatedUnion("op", [
  { op: "assistant.memory.remember", args: { content, sources? } },
  { op: "assistant.memory.forget", args: { memory } }
])
```

- **assistant.memory.remember**：保存新记忆（人类显式偏好/事实）。
  - `content: string().min(1).refine(nonBlank)`：非空且非纯空白（拒绝纯空格、制表符、换行符）。
    原文内容原样保留（不 trim），只校验非空白。
  - `sources: ResourceRef[].optional()`：来源引用，缺省为空数组（应用供给该默认值）。
    **不可访问的引用在保存时由应用拒绝**，不接受后填充 `private`。
  - **不接受输入的服务器字段**：`owner`、`private`、`revision`、`id`、`created`、`updated` 由应用生成。
    - `owner`：调用者身份（必须为 human）。
    - `private`：应用根据 `sources` 最严格访问限制确定（任一来源私密则记忆私密）。
    - `revision`：起始值为 1（不从 sources 版本派生）。

- **assistant.memory.forget**：删除记忆。
  - `memory: idOf("mem")`：要删除的记忆 ID。
  - **按调用者作用域幂等**：不存在或已删除均返回成功（只能忘记自己拥有的记忆）。
  - **已忘记的 ID 重放旧 remember 请求**可能返回 `{kind:'forgotten', memory:<ID>}` 结果，不恢复内容。
    这是小的语义可能性，由应用处理，不新增字段标记。

### 2. 请求与结果

```typescript
AssistantMemoryCommandRequest = {
  request_id: RequestId,
  operation: AssistantMemoryCommand
}

AssistantMemoryCommandResult = discriminatedUnion("kind", [
  { kind: "memory", memory: AssistantMemory },
  { kind: "forgotten", memory: <mem_ID> }
])
```

- `request_id` 去重；重放同一请求不重复执行。
- 结果是**严格 discriminated union**：
  - `remember` → `{kind:'memory', memory: AssistantMemory}`
  - `forget` → `{kind:'forgotten', memory: <mem_ID>}`（幂等；已删除或不存在也成功）
- 列举记忆直接使用 `AssistantMemory[]`，不需要额外的命令或结果类型。

### 3. 契约注册

在 `packages/schema/src/index.ts` 的 `CONTRACTS` 中导出：

```typescript
"assistant-memory-command-request": AssistantMemoryCommandRequest,
"assistant-memory-command-result": AssistantMemoryCommandResult,
```

### 4. 类型导出

```typescript
export type AssistantMemoryCommand = z.infer<typeof AssistantMemoryCommand>;
export type AssistantMemoryCommandName = AssistantMemoryCommand["op"];
export type AssistantMemoryCommandRequest = z.infer<typeof AssistantMemoryCommandRequest>;
export type AssistantMemoryCommandResult = z.infer<typeof AssistantMemoryCommandResult>;
```

以及对应的 Zod schema 常量 `ASSISTANT_MEMORY_COMMAND_NAMES`。

### 5. 契约测试（`packages/schema/test/assistant-memory.test.ts`）

- `assistant.memory.remember` 接受非空非纯空白 `content` 和可选 `sources`（有效 `ResourceRef`）。
- 拒绝空字符串、纯空格、纯换行符内容；拒绝未知字段（如 `owner`、`private` 在 args 中）。
- 保留原文空白（不 trim），只校验非纯空白。
- `assistant.memory.forget` 接受 `mem_` 前缀 ID，拒绝其他前缀。
- `AssistantMemoryCommandResult` 严格区分 `{kind:'memory'}` 与 `{kind:'forgotten'}`，拒绝未知字段。
- JSON Schema 导出不抛出异常。

## 非目标与约束

- **只接受人类显式记忆**：不提供从对话自动提取、agent 调用权限、私密检索或模型选择。
- **不实现应用逻辑**：Hub 路由、数据库持久化、权限校验（仅 human）、sources 默认值注入、owner/private/revision 生成留给后续应用切片。
- **不修改已有 v1 契约、Job 协议 2、其他模块的形状或现有 ID 前缀**。

## 验收

- 主 agent 运行 `bun test packages/schema/test/v2-contracts.test.ts` 中 "Assistant memory commands" describe block 全部通过。
- `bun run schema:export` 生成 `assistant-memory-command-request.schema.json` 和 `assistant-memory-command-result.schema.json`，无手动编辑。
- 依赖检查（`bun run lint:deps`）通过：`packages/schema` 仍只依赖 zod。
- 应用实现与权限验证为独立后续切片。

来源必须在保存和每次使用前以明确 agent 身份重新校验；默认未接来源适配器时拒绝带来源记忆，私密来源不开放。遗忘会清除活动记忆及幂等响应中的原文，不宣称删除既有对话或历史备份。

验证：Bun 1.3.13；定向契约/存储/HTTP/CLI 测试 25 pass；完整 LUMIO_LIVE=0 bun run check：797 pass、3 skip、0 fail。schema:export 由 Zod 生成，未手改生成物；无新第三方依赖、无真实模型或数据访问。
