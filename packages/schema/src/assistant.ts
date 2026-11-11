import {NativeEventData} from "./ai.ts";
import { z } from "zod";
import { CapabilityChange, CapabilityName } from "./capabilities.ts";
import { RequestId, Revision, Timestamp, idOf } from "./common.ts";
import { ResourceRef } from "./work.ts";
import { FocusSnapshot, Notice, WorkbenchAction } from "./workbench.ts";

/**
 * Assistant 模块契约 v2（ADR 0025 第 1、3、7 节，R0-1）。
 *
 * 对话、消息、轮次、工具操作记录；以及给模型适配器用的统一接口（不绑定某供应商）。
 * 记忆、上下文快照、权限与工具详细流程在后续 ADR 明确，这里提供基础契约。
 */

/** 对话里保存的消息角色。system 提示不保存为消息，只出现在交给模型的请求里。 */
export const MessageRole = z.enum(["user", "assistant", "tool"]);
/** 交给模型的消息角色（包括 system）。 */
export const ModelMessageRole = z.enum(["system", "user", "assistant", "tool"]);

/** 一段对话。 */
export const AssistantConversation = z.strictObject({
  id: idOf("conv"),
  title: z.string().min(1),
  native_session: idOf("ais").optional(),
  profile: idOf("aip").optional(),
  owner: idOf("act").describe("拥有者身份；只有拥有者与授权者可见"),
  created: Timestamp,
  updated: Timestamp,
  revision: Revision.describe("对话结构版本：新增消息/轮次时递增"),
});

/** 一条消息。role=tool 时必须带 tool_call；user 消息不带 tool_call、turn。 */
export const AssistantMessage = z
  .strictObject({
    id: idOf("amsg"),
    conversation: idOf("conv"),
    role: MessageRole,
    content: z.string().describe("消息正文；tool 角色时是工具返回的结果"),
    created: Timestamp,
    turn: idOf("turn").optional().describe("属于哪个轮次"),
    tool_call: idOf("tool").optional().describe("role=tool 时：对应的工具调用"),
  })
  .refine((m) => (m.role === "tool") === (m.tool_call !== undefined), {
    message: "role 为 tool 时必须有 tool_call，其他角色不能有",
    path: ["tool_call"],
  });

export const TurnStatus = z.enum(["running", "done", "failed", "unknown", "cancelled"]);

/** 一次轮次：assistant 思考 + 可能多次工具调用 + 一条回复。 */
export const AssistantTurn = z.strictObject({
  id: idOf("turn"),
  conversation: idOf("conv"),
  request_id: RequestId.describe("触发这个轮次的请求 ID；重放时不重复执行"),
  status: TurnStatus,
  created: Timestamp,
  finished: Timestamp.optional().describe("轮次结束时间"),
  error: z.string().optional().describe("失败原因"),
});

export const ToolCallStatus = z.enum(["prepared", "running", "succeeded", "failed", "unknown"]);

/** 一次工具调用。同一个轮次可以有多个工具调用（并行或顺序）。 */
export const AssistantToolCall = z.strictObject({
  id: idOf("tool"),
  turn: idOf("turn"),
  name: z.string().min(1).describe("工具名称"),
  args: z.record(z.string(), z.unknown()).describe("工具参数"),
  status: ToolCallStatus,
  result: z.unknown().optional().describe("工具返回值；succeeded 时必须有值"),
  error: z.string().optional().describe("失败原因"),
  created: Timestamp,
  finished: Timestamp.optional(),
  capability: CapabilityName.optional().describe("对应的能力（ADR 0029）；不是能力目录里的工具时缺失"),
  change: CapabilityChange.optional().describe("写入类能力成功后的变更记录，界面据此显示变更卡片与撤回"),
  private_read: z.boolean().optional().describe("这次调用读取了私密内容（只在 human 拥有的对话中可能为 true）"),
});

/**
 * 记忆（ADR 0025 第 7 节）：assistant 的长期上下文片段。
 * 可以是用户告诉它的偏好，也可以是助手从对话中提炼的事实。
 */
export const AssistantMemory = z.strictObject({
  id: idOf("mem"),
  owner: idOf("act").describe("拥有者身份；记忆继承来源对话/资料的可见性约束"),
  content: z.string().min(1).describe("记忆内容，可以是 Markdown"),
  sources: z.array(ResourceRef).describe("来源：对话、知识、任务等；继承最严格的访问限制"),
  private: z.boolean().describe("来源含私密内容；按知识私密规则处理，不交给 agent 身份或执行器"),
  revision: Revision,
  created: Timestamp,
  updated: Timestamp,
});

// ───────────────────────── 记忆命令（R0-7）─────────────────────────

/**
 * 记忆命令：保存用户显式偏好/事实或删除已有记忆（ADR 0025 第 7 节，R0-7）。
 *
 * 语义：
 * - assistant.memory.remember：保存新记忆。owner 为调用者（必须为 human），由应用注入。
 *   sources 缺省为空数组（应用供给）；不可访问的引用在保存时拒绝，不接受后填充 private。
 *   revision 起始值为 1；id/created/updated 由应用生成。
 *   **本切片只接受人类显式记忆，不提供从对话自动提取或 agent 调用权限。**
 * - assistant.memory.forget：删除记忆（按调用者作用域幂等：不存在或已删除均返回成功）。
 *   已忘记的记忆 ID 重放旧 remember 请求可能返回 forgotten 结果，不恢复内容。
 *
 * content 必须非空且非纯空白（包括空格、制表符、换行符）。
 */

const nonBlank = (s: string) => s.trim().length > 0;

const AssistantMemoryRemember = z.strictObject({
  op: z.literal("assistant.memory.remember"),
  args: z.strictObject({
    content: z
      .string()
      .min(1)
      .refine(nonBlank, { message: "content 不能为空或纯空白" })
      .describe("记忆内容，不能为空或纯空白"),
    sources: z
      .array(ResourceRef)
      .optional()
      .describe("来源引用；缺省为空数组（应用供给）；不可访问的引用在保存时拒绝"),
  }),
});

const AssistantMemoryForget = z.strictObject({
  op: z.literal("assistant.memory.forget"),
  args: z.strictObject({
    memory: idOf("mem").describe("要删除的记忆 ID；按调用者作用域幂等（不存在或已删除不报错）"),
  }),
});

/**
 * 记忆命令的 discriminated union。
 */
export const AssistantMemoryCommand = z.discriminatedUnion("op", [
  AssistantMemoryRemember,
  AssistantMemoryForget,
]);

export const ASSISTANT_MEMORY_COMMAND_NAMES = AssistantMemoryCommand.options.map(
  (o) => o.shape.op.value,
);

/**
 * 记忆命令请求：带 request_id 去重。
 */
export const AssistantMemoryCommandRequest = z.strictObject({
  request_id: RequestId,
  operation: AssistantMemoryCommand,
});

/**
 * 记忆命令结果（严格 discriminated union）：
 * - remember → {kind:'memory', memory: AssistantMemory}
 * - forget → {kind:'forgotten', memory: <mem_ID>}（幂等；已删除或不存在也返回此结果）
 *
 * 已忘记的 ID 重放 remember 请求可能返回 forgotten 变体，不恢复内容。
 */
export const AssistantMemoryCommandResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("memory"),
    memory: AssistantMemory.describe("新建的记忆；owner/private/revision/id/timestamps 由应用生成"),
  }),
  z.strictObject({
    kind: z.literal("forgotten"),
    memory: idOf("mem").describe("已删除的记忆 ID（幂等；不存在或已删除也成功）"),
  }),
]);


// ───────────────────────── 命令与查询 ─────────────────────────

/** 发起一轮对话（可以是新对话或继续已有对话）。 */
export const AssistantChatRequest = z.strictObject({
  request_id: RequestId,
  conversation: idOf("conv").optional().describe("缺省时创建新对话"),
  message: z.string().min(1).describe("用户输入"),
  profile: idOf("aip").optional(),
  effort: z.string().min(1).max(32).optional(),
  model: z.string().min(1).optional().describe("指定模型；缺省由应用决定"),
  focus: FocusSnapshot.optional().describe("人此刻在看什么；只接受主对话（ADR 0060 第 1 节）"),
});

/** 完整对话：对话对象、消息、轮次。 */
export const AssistantConversationDetail = z.strictObject({
  conversation: AssistantConversation,
  messages: z.array(AssistantMessage),
  turns: z.array(AssistantTurn),
});

/** 聊天结果：新建或更新的对话、这一轮的 turn 和新增的消息。 */
export const AssistantChatResult = z.strictObject({
  conversation: AssistantConversation,
  turn: AssistantTurn,
  messages: z.array(AssistantMessage).describe("这一轮新增的消息"),
});

// ───────────────────────── 模型适配器接口 ─────────────────────────

/**
 * 给模型的消息格式（领域统一接口，不绑定某供应商；由适配器翻译成具体格式）。
 * tool_calls 与 tool_call_id 表达常见的"模型请求调用工具 → 回传结果"循环。
 */
export const AssistantModelMessage = z.strictObject({
  role: ModelMessageRole,
  continuation: z.strictObject({reasoning_content:z.string().nullable().optional(),encrypted_content:z.string().nullable().optional()}).optional(),
  content: z.string(),
  tool_call_id: z.string().optional().describe("role=tool 时：这是哪个工具调用的结果"),
  tool_calls: z
    .array(z.strictObject({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }))
    .optional()
    .describe("role=assistant 时：assistant 想调用的工具"),
});

/** 工具声明。 */
export const AssistantToolSpec = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  input_schema: z.record(z.string(), z.unknown()).describe("JSON Schema 对象"),
});

/** 模型请求（给适配器用）。 */
export const AssistantModelRequest = z.strictObject({
  reasoning_effort:z.string().optional(),
  thinking:z.enum(["default","off","on"]).optional(),
  model: z.string().min(1).optional().describe("缺省时用适配器默认模型"),
  messages: z.array(AssistantModelMessage).min(1),
  tools: z.array(AssistantToolSpec).describe("可用工具；没有工具时传 []"),
});

/** 模型响应（适配器返回给 Assistant 核心）。 */
export const AssistantModelResponse = z.strictObject({
  continuation:z.strictObject({reasoning_content:z.string().nullable().optional(),encrypted_content:z.string().nullable().optional()}).optional(),
  content: z.string().describe("assistant 回复的文本内容"),
  tool_calls: z.array(z.strictObject({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) })).describe(
    "assistant 想调用的工具；没有时为空数组",
  ),
});

// ───────────────────────── 事件（用于以后的流式响应） ─────────────────────────

export const ASSISTANT_REASONING_DELTA_LIMIT = 65_536;

/** Assistant NDJSON 事件。进度事件需要客户端显式订阅（ADR 0050）。 */
export const AssistantEvent = z.discriminatedUnion("type", [
  z.strictObject({type:z.literal("native"),turn:idOf("turn"),event:NativeEventData}),
  z.strictObject({ type: z.literal("model_waiting"), turn: idOf("turn") }),
  z.strictObject({ type: z.literal("reasoning"), turn: idOf("turn"), delta: z.string().min(1).max(ASSISTANT_REASONING_DELTA_LIMIT) }),
  z.strictObject({ type: z.literal("token"), turn: idOf("turn"), delta: z.string() }),
  z.strictObject({ type: z.literal("tool"), turn: idOf("turn"), tool: AssistantToolCall }),
  z.strictObject({ type: z.literal("result"), turn: idOf("turn"), messages: z.array(AssistantMessage) }),
  z.strictObject({ type: z.literal("error"), turn: idOf("turn"), error: z.string() }),
  // A1-1：以下三类只出现在主对话的聊天流里（ADR 0059、0060）
  z.strictObject({ type: z.literal("ui"), turn: idOf("turn"), tool: idOf("tool"), action: WorkbenchAction }),
  z.strictObject({ type: z.literal("topic"), turn: idOf("turn"), anchors: z.array(ResourceRef).min(1).max(8) }),
  z.strictObject({ type: z.literal("notice"), turn: idOf("turn"), notice: Notice }),
]);

export type AssistantMemoryCommand = z.infer<typeof AssistantMemoryCommand>;
export type AssistantMemoryCommandName = AssistantMemoryCommand["op"];
export type AssistantMemoryCommandRequest = z.infer<typeof AssistantMemoryCommandRequest>;
export type AssistantMemoryCommandResult = z.infer<typeof AssistantMemoryCommandResult>;


export type MessageRole = z.infer<typeof MessageRole>;
export type ModelMessageRole = z.infer<typeof ModelMessageRole>;
export type AssistantConversation = z.infer<typeof AssistantConversation>;
export type AssistantMessage = z.infer<typeof AssistantMessage>;
export type TurnStatus = z.infer<typeof TurnStatus>;
export type AssistantTurn = z.infer<typeof AssistantTurn>;
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;
export type AssistantToolCall = z.infer<typeof AssistantToolCall>;
export type AssistantMemory = z.infer<typeof AssistantMemory>;
export type AssistantChatRequest = z.infer<typeof AssistantChatRequest>;
export type AssistantConversationDetail = z.infer<typeof AssistantConversationDetail>;
export type AssistantChatResult = z.infer<typeof AssistantChatResult>;
export type AssistantModelMessage = z.infer<typeof AssistantModelMessage>;
export type AssistantToolSpec = z.infer<typeof AssistantToolSpec>;
export type AssistantModelRequest = z.infer<typeof AssistantModelRequest>;
export type AssistantModelResponse = z.infer<typeof AssistantModelResponse>;
export type AssistantEvent = z.infer<typeof AssistantEvent>;

// ───────────────────────── 模型配置（ADR 0027 第 4 节、0029 第 7 节）─────────────────────────

/**
 * `GET /v2/assistant/config`（仅 human）。密钥只写不读：只返回是否已设置。
 * managed 为 false 表示配置由 Hub 服务的外部运行环境注入，界面只读、不能在这里修改。
 */
export const AssistantConfigView = z.strictObject({
  base_url: z.string().url().optional().describe("兼容 Chat Completions 的 API 基础路径；未配置时缺失"),
  model: z.string().min(1).optional(),
  api_key_set: z.boolean(),
  managed: z.boolean().describe("true：保存在 Hub 的私有环境文件，可以在设置页或 lumio hub assistant setup 修改"),
});

/**
 * `PUT /v2/assistant/config`（仅 human）：先验证再原子写入，进程内重新加载，不重启 Hub。
 * api_key 缺失表示保留现有密钥；clear_api_key 删除密钥（服务不需要鉴权时）。两者不能同时给。
 * 地址只接受 http(s)，不含用户名、密码、查询参数或片段（与现有适配器规则相同）。
 */
export const AssistantConfigUpdate = z
  .strictObject({
    base_url: z.string().url().refine((value) => {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
    }, "只接受不含凭据、查询参数或片段的 http(s) 地址"),
    model: z.string().min(1),
    api_key: z.string().min(1).optional().describe("只写；不出现在任何响应、日志或审计详情中"),
    clear_api_key: z.boolean().optional(),
    check: z.boolean().optional().describe("缺省 true：保存前用一次最小请求验证，失败不保存"),
  })
  .refine((update) => !(update.api_key && update.clear_api_key), "api_key 与 clear_api_key 不能同时给");

/**
 * 验证失败的原因，放在 ApiError 的 reason 中（code 为 INVALID）：
 * address 地址不可达或不是兼容接口；auth 鉴权失败；model 模型名不被接受；response 响应格式不对；timeout 超时。
 */
export const ASSISTANT_CONFIG_PROBLEMS = ["address", "auth", "model", "response", "timeout"] as const;
export const AssistantConfigProblem = z.enum(ASSISTANT_CONFIG_PROBLEMS);
export const assistantConfigReason = (problem: z.infer<typeof AssistantConfigProblem>) => `assistant-config-${problem}` as const;

export type AssistantConfigView = z.infer<typeof AssistantConfigView>;
export type AssistantConfigUpdate = z.infer<typeof AssistantConfigUpdate>;
export type AssistantConfigProblem = z.infer<typeof AssistantConfigProblem>;
