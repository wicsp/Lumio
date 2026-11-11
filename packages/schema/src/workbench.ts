import { z } from "zod";
import { idOf, RequestId, Revision, Timestamp } from "./common.ts";
import { ResourceRef } from "./work.ts";

/**
 * 单入口助手与共用工作台（ADR 0059、0060、0061 第 1、3、4 节，A1-1）。
 *
 * - 主对话：每个 human 一个，Web 默认进入。锚点（消息 ↔ ResourceRef）是 Assistant 的内部关联表，**不进契约**（ADR 0059 第 1 节）。
 * - 焦点快照随聊天请求发送（`AssistantChatRequest.focus`），只接受主对话；Hub 复验上限（ADR 0060 第 1 节）。
 * - 展示动作只给内置助手在 human 拥有的主对话里使用，不进入外部 agent 的能力目录；
 *   Hub 发出前校验分区、助手对每个 ResourceRef 的可见性，搜索结果须来自本轮已返回给助手的工具结果（ADR 0060 第 2 节）。
 * - 提醒（`ntc_`）与提前探索（`xpl_`）是 Hub 的跨模块协调数据；只有拥有者 human 可读写。
 * - 判断闸门直接绑定 TypeSafe Jev 连接（ADR 0046 规定它不能用于 Profile）。
 *
 * HTTP（全部只授予 human）：
 * - `POST /v2/assistant/main`：AssistantMainEnsure → AssistantMain（幂等；没有时创建）
 * - `POST /v2/assistant/chat`：在 `AssistantChatRequest` 上带 `focus`；非主对话带 `focus` 返回 INVALID
 * - `GET  /v2/notices?unread=&level=&limit=`：NoticeList（新的在前）
 * - `POST /v2/notices/commands`：NoticeCommand → NoticeCommandResult
 * - `GET  /v2/explorations?active=&limit=`：ExplorationList；`GET /v2/explorations/<id>`：Exploration
 * - `POST /v2/explorations/commands`：ExplorationCommand → Exploration
 * - `GET/PUT /v2/ai/decision-binding`：DecisionGateBinding | null / DecisionGateBindingUpdate
 */

// ───────────────────────── 主对话 ─────────────────────────

export const AssistantMainEnsure = z.strictObject({ request_id: RequestId });
export const AssistantMain = z.strictObject({
  conversation: idOf("conv"),
  created: z.boolean().describe("这次请求是否新建了主对话"),
});

// ───────────────────────── 焦点快照（ADR 0060 第 1 节） ─────────────────────────

/** 上限。浏览器按字素边界截断，Hub 复验，超限拒绝。 */
export const FOCUS_LIMITS = {
  /** 整个焦点快照序列化为 JSON 后的 UTF-8 字节数。 */
  max_bytes: 8 * 1024,
  /** 选中文字的字素簇数。 */
  max_selection_graphemes: 512,
  /** 选中的对象个数。 */
  max_selected: 20,
} as const;

/** Web 工作台的分区。设置与回收站不在其中：助手不能把人带到那里。 */
export const WORKBENCH_SECTIONS = ["overview", "knowledge", "work", "execution", "assistant", "approvals", "inbox"] as const;
export const WorkbenchSection = z.enum(WORKBENCH_SECTIONS);

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * 人此刻在看什么。选中文字是上下文数据，**不能作为人批准任何事的证据**（ADR 0060 第 1 节、0061 第 2 节）。
 * 焦点一旦发给模型，就按实际发送的内容计入请求快照。
 */
export const FocusSnapshot = z
  .strictObject({
    section: WorkbenchSection.optional().describe("当前分区；在设置、回收站等其他页面时缺省"),
    primary: ResourceRef.optional().describe("页面上的主对象，例如正在看的任务"),
    selected: z.array(ResourceRef).max(FOCUS_LIMITS.max_selected).default([]).describe("页面上选中的对象"),
    selection_text: z.string().min(1).optional().describe("选中的文字"),
  })
  .superRefine((focus, ctx) => {
    if (focus.selection_text !== undefined && graphemes(focus.selection_text) > FOCUS_LIMITS.max_selection_graphemes)
      ctx.addIssue({ code: "custom", path: ["selection_text"], message: `选中文字最多 ${FOCUS_LIMITS.max_selection_graphemes} 个字素` });
    if (utf8Bytes(focus) > FOCUS_LIMITS.max_bytes)
      ctx.addIssue({ code: "custom", message: `焦点快照最多 ${FOCUS_LIMITS.max_bytes} 字节` });
  });

// ───────────────────────── 展示动作（ADR 0060 第 2 节） ─────────────────────────

/** 内置助手的展示工具名。不登记进 `CAPABILITIES`。 */
export const WORKBENCH_TOOLS = ["ui.navigate", "ui.highlight", "ui.show", "ui.clear"] as const;
export const WorkbenchToolName = z.enum(WORKBENCH_TOOLS);

export const WORKBENCH_LIMITS = {
  max_refs: 20,
  max_search_results: 10,
  max_note_chars: 200,
} as const;

const Note = z.string().min(1).max(WORKBENCH_LIMITS.max_note_chars);

/** 搜索结果卡片：只能来自本轮已返回给助手的工具结果。 */
export const WorkbenchSearchResult = z.strictObject({
  title: z.string().min(1).max(200),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  snippet: z.string().min(1).max(500).optional(),
});

export const WorkbenchPanel = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refs"), title: Note.optional(), refs: z.array(ResourceRef).min(1).max(WORKBENCH_LIMITS.max_refs) }),
  z.strictObject({ kind: z.literal("search"), title: Note.optional(), results: z.array(WorkbenchSearchResult).min(1).max(WORKBENCH_LIMITS.max_search_results) }),
  z.strictObject({ kind: z.literal("dependency_graph"), project: ResourceRef.refine((ref) => ref.id.startsWith("prj_"), "必须是项目") }),
]);

/**
 * 一个展示动作；也是对应工具的参数（去掉 `action`）。
 * 动作只带分区与 ID，内容由浏览器以人的凭据读取；Hub 校验在先，浏览器不再判断权限。
 */
export const WorkbenchAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("navigate"), section: WorkbenchSection, target: ResourceRef.optional() }),
  z.strictObject({ action: z.literal("highlight"), refs: z.array(ResourceRef).min(1).max(WORKBENCH_LIMITS.max_refs), note: Note.optional() }),
  z.strictObject({ action: z.literal("show"), panel: WorkbenchPanel }),
  z.strictObject({ action: z.literal("clear") }),
]);

// ───────────────────────── 提醒（ADR 0059 第 4 节、0061 第 3 节） ─────────────────────────

/** 哪类事件产生的提醒。 */
export const NoticeSourceKind = z.enum(["turn", "proposal", "capture", "watchdog", "exploration"]);

/** 重要：在主对话当前一轮结束后插话并推送；待处理：进入 Today 并标未读；静默：只记录。 */
export const NoticeLevel = z.enum(["important", "digest", "silent"]);

/** 级别是谁定的：规则、判断闸门，或闸门不可用 / 置信度低时的回退（一律 digest）。 */
export const NoticeGrader = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("rule") }),
  z.strictObject({ by: z.literal("gate"), model: z.string().min(1).max(64), confidence: z.number().min(0).max(1) }),
  z.strictObject({ by: z.literal("fallback"), reason: z.enum(["unconfigured", "timeout", "error", "low_confidence"]) }),
]);

/** Watchdog 的一条发现。只读巡检，不停止、不修改任何东西（ADR 0059 第 5 节）。 */
export const WatchdogFinding = z.strictObject({
  kind: z.enum(["stalled_turn", "stale_task", "runtime_offline"]),
  subject: ResourceRef,
  since: Timestamp,
});

export const Notice = z
  .strictObject({
    id: idOf("ntc"),
    owner: idOf("act"),
    source: NoticeSourceKind,
    event: z.string().min(8).max(128).describe("来源事件的去重键；同一事件只产生一条提醒"),
    level: NoticeLevel,
    graded: NoticeGrader,
    subject: ResourceRef.optional().describe("提醒关于哪个对象；问起时助手把锚点切到它"),
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(2000).optional().describe("预读写的摘要（AI 生成）；私密对象不写摘要"),
    comment: idOf("wmsg").optional().describe("预读写入的任务评论"),
    ai_note: idOf("ain").optional().describe("探索产出的 AI 笔记"),
    findings: z.array(WatchdogFinding).max(50).optional(),
    read: Timestamp.optional(),
    created: Timestamp,
  })
  .refine((notice) => (notice.source === "watchdog") === (notice.findings !== undefined), {
    message: "只有 Watchdog 提醒带 findings，且必须带",
    path: ["findings"],
  });

export const NoticeListArgs = z.strictObject({
  unread: z.boolean().optional(),
  level: NoticeLevel.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const NoticeList = z.strictObject({ notices: z.array(Notice), unread: z.number().int().nonnegative().describe("未读总数（不含静默）") });

export const NoticeCommand = z.strictObject({
  request_id: RequestId,
  op: z.literal("read"),
  notices: z.array(idOf("ntc")).min(1).max(100),
});
export const NoticeCommandResult = z.strictObject({ updated: z.array(idOf("ntc")) });

// ───────────────────────── 提前探索（ADR 0059 第 5 节） ─────────────────────────

/** 默认预算，Hub 配置可改。 */
export const EXPLORATION_DEFAULTS = {
  max_tokens: 200_000,
  max_ms: 30 * 60 * 1000,
} as const;

/** 只能探索人写的想法、任务与项目。 */
const ExplorableRef = ResourceRef.refine((ref) => ["idea_", "task_", "prj_"].some((prefix) => ref.id.startsWith(prefix)), "只能探索想法、任务或项目");

/**
 * `found`：有值得看的结果；`nothing`：试过，无发现；`stopped`：用完预算停止；`cancelled`：人取消；`failed`：出错，不自动重试。
 */
export const ExplorationState = z.enum(["queued", "running", "found", "nothing", "stopped", "cancelled", "failed"]);

export const Exploration = z.strictObject({
  id: idOf("xpl"),
  owner: idOf("act"),
  target: ExplorableRef,
  state: ExplorationState,
  budget: z.strictObject({ max_tokens: z.number().int().positive(), max_ms: z.number().int().positive() }),
  used: z.strictObject({ tokens: z.number().int().nonnegative(), ms: z.number().int().nonnegative() }).optional(),
  ai_note: idOf("ain").optional().describe("产出的 AI 笔记，derived_from 指向 target"),
  notice: idOf("ntc").optional(),
  error: z.string().max(500).optional(),
  revision: Revision,
  created: Timestamp,
  updated: Timestamp,
});

export const ExplorationListArgs = z.strictObject({
  active: z.boolean().optional().describe("true 只列 queued / running"),
  limit: z.number().int().min(1).max(200).default(50),
});
export const ExplorationList = z.strictObject({ explorations: z.array(Exploration) });

/** 标记"可以帮我探索"即 start；同一对象已有进行中的探索时返回它（幂等）。 */
export const ExplorationCommand = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("start"),
    request_id: RequestId,
    target: ExplorableRef,
    budget: z.strictObject({ max_tokens: z.number().int().positive().optional(), max_ms: z.number().int().positive().optional() }).optional(),
  }),
  z.strictObject({ op: z.literal("cancel"), request_id: RequestId, exploration: idOf("xpl"), expected_revision: Revision }),
]);

// ───────────────────────── 判断闸门（ADR 0061 第 1 节） ─────────────────────────

export const DECISION_GATE_DEFAULTS = {
  model: "jev-1.14.0",
  /** Hub 的总时限；超时立即回退。 */
  timeout_ms: 3000,
  /** 分级时低于此置信度按 digest 处理。 */
  min_confidence: 0.8,
} as const;

const JevModel = z.string().regex(/^jev-\d+\.\d+\.\d+$/, "固定到具体版本，如 jev-1.14.0");

/** 闸门绑定到一个 `typesafe-jev` 连接。Hub 校验连接类型与所有者。 */
export const DecisionGateBinding = z.strictObject({
  purpose: z.literal("decision.gate"),
  connection: idOf("aic"),
  model: JevModel,
  revision: Revision,
});

export const DecisionGateBindingUpdate = z.strictObject({
  request_id: RequestId,
  /** null 表示解除绑定：分级一律回退为 digest，对话照常。 */
  connection: idOf("aic").nullable(),
  model: JevModel.optional().describe(`缺省为 ${DECISION_GATE_DEFAULTS.model}`),
  expected_revision: Revision.optional(),
});

/** 设置页"会发送给 TypeSafe 什么"的固定说明，避免各处各写一份。 */
export const DECISION_GATE_DISCLOSURE = ["event_kind", "subject_title", "structured_summary"] as const;

export type AssistantMainEnsure = z.infer<typeof AssistantMainEnsure>;
export type AssistantMain = z.infer<typeof AssistantMain>;
export type WorkbenchSection = z.infer<typeof WorkbenchSection>;
export type FocusSnapshot = z.infer<typeof FocusSnapshot>;
export type WorkbenchToolName = z.infer<typeof WorkbenchToolName>;
export type WorkbenchSearchResult = z.infer<typeof WorkbenchSearchResult>;
export type WorkbenchPanel = z.infer<typeof WorkbenchPanel>;
export type WorkbenchAction = z.infer<typeof WorkbenchAction>;
export type NoticeSourceKind = z.infer<typeof NoticeSourceKind>;
export type NoticeLevel = z.infer<typeof NoticeLevel>;
export type NoticeGrader = z.infer<typeof NoticeGrader>;
export type WatchdogFinding = z.infer<typeof WatchdogFinding>;
export type Notice = z.infer<typeof Notice>;
export type NoticeListArgs = z.infer<typeof NoticeListArgs>;
export type NoticeList = z.infer<typeof NoticeList>;
export type NoticeCommand = z.infer<typeof NoticeCommand>;
export type NoticeCommandResult = z.infer<typeof NoticeCommandResult>;
export type ExplorationState = z.infer<typeof ExplorationState>;
export type Exploration = z.infer<typeof Exploration>;
export type ExplorationListArgs = z.infer<typeof ExplorationListArgs>;
export type ExplorationList = z.infer<typeof ExplorationList>;
export type ExplorationCommand = z.infer<typeof ExplorationCommand>;
export type DecisionGateBinding = z.infer<typeof DecisionGateBinding>;
export type DecisionGateBindingUpdate = z.infer<typeof DecisionGateBindingUpdate>;
