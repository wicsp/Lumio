import { z } from "zod";
import { AIQuotaSnapshot, ClaudeQuotaAccount, ClaudeBackgroundResult } from "./ai-usage.ts";
import { idOf, Timestamp, Revision, RequestId, RuntimeName } from "./common.ts";
/** ADR 0041/0042: shared model configuration; credentials never appear in a view. */
export const TYPESAFE_JEV_BASE_URL = "https://api.typesafe.ai/v1";
/** ADR 0055：阿里云百炼（DashScope）语音服务的官方地址，按区域固定；Hub 由此派生 wss 地址。默认北京。 */
export const DASHSCOPE_BASE_URLS = { beijing: "https://dashscope.aliyuncs.com", singapore: "https://dashscope-intl.aliyuncs.com" } as const;
/** ADR 0055：只能绑定语音用途的连接类型。 */
export const SPEECH_CONNECTION_KINDS = ["dashscope"] as const;
export const AIConnectionKind = z.enum(["codex-account", "openai-compatible", "deepseek", "doubao", "typesafe-jev", "claude-code-subscription", "dashscope"]);
export const AIConnection = z.strictObject({ id: idOf("aic"), owner: idOf("act"), name: z.string().trim().min(1).max(100), kind: AIConnectionKind,
    host: z.union([z.literal("hub"), RuntimeName]), base_url: z.string().url().optional(), api_key_set: z.boolean(), revision: Revision, created: Timestamp, updated: Timestamp });
export function supportsAliyunBilling(connection: Pick<AIConnection, "kind" | "host" | "base_url">): boolean {
  if (connection.host !== "hub" || !connection.base_url) return false;
  const base = connection.base_url.replace(/\/+$/, "");
  if (connection.kind === "dashscope") return Object.values(DASHSCOPE_BASE_URLS).some(url => base === url);
  if (connection.kind !== "openai-compatible") return false;
  const url = URL.parse(base);
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/compatible-mode/v1") return false;
  return ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com",
    "cn-hongkong.dashscope.aliyuncs.com"].includes(url.hostname) ||
    /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname);
}
export const AIConnectionInput = z.strictObject({ name: z.string().trim().min(1).max(100), kind: AIConnectionKind, host: z.union([z.literal("hub"), RuntimeName]), base_url: z.string().url().optional(), api_key: z.string().min(1).max(8192).optional(), clear_api_key: z.boolean().optional() })
    .refine(v => !(v.api_key && v.clear_api_key), "Conflicting credential changes")
    .refine(v => v.kind !== "typesafe-jev" || v.base_url === TYPESAFE_JEV_BASE_URL, { path: ["base_url"], message: "Use the official TypeSafe API address" })
    .refine(v => v.kind !== "dashscope" || (Object.values(DASHSCOPE_BASE_URLS) as string[]).includes(v.base_url ?? ""), { path: ["base_url"], message: "Use an official DashScope region address" })
    .refine(v => (v.kind === "codex-account" || v.kind === "claude-code-subscription") ? v.host !== "hub" && !v.api_key && !v.base_url && (v.kind !== "claude-code-subscription" || !v.clear_api_key) : !!v.base_url && v.host === "hub", "Unsupported connection location")
    .refine(v => !v.base_url || (() => { const u = new URL(v.base_url); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; })(), "Invalid API address");
export const AIProfile = z.strictObject({ id: idOf("aip"), owner: idOf("act"), name: z.string().trim().min(1).max(100), connection: idOf("aic"), engine: z.enum(["lumio", "codex", "speech"]).describe("speech 只能用于语音用途（ADR 0055）"), model: z.string().trim().min(1).max(200), thinking: z.enum(["default", "off", "on"]).default("default"), effort: z.string().min(1).max(32).optional(), revision: Revision, created: Timestamp, updated: Timestamp });
export const AIProfileInput = AIProfile.omit({ id: true, owner: true, revision: true, created: true, updated: true });
export const AIUsageBinding = z.strictObject({ profile: idOf("aip"), purpose: z.enum(["assistant", "job", "routine"]), revision: Revision, workdir: z.literal("managed-session"),
    approval_policy: z.literal("on-request"), reviewer: z.literal("user"), sandbox: z.literal("workspace-write"), command_network: z.literal(false), tools: z.array(z.string().min(1)).max(128), timeout_seconds: z.number().int().min(30).max(7200) });
export const AIConfiguration = z.strictObject({ connections: z.array(AIConnection), profiles: z.array(AIProfile) });
/** ADR 0043: versioned, idempotent removal of an owned AI configuration. */
export const AIConfigurationDelete = z.strictObject({ request_id: RequestId, expected_revision: Revision });
export const AIConfigurationDeleted = z.strictObject({ id: z.union([idOf("aic"), idOf("aip")]), deleted: z.literal(true) });
export const AIModel = z.strictObject({ id: z.string().min(1), default_effort: z.string().optional(), efforts: z.array(z.string()) });
export const NativeAccountBinding = z.strictObject({ account: z.string().regex(/^[a-f0-9]{64}$/), generation: Revision });
export const NativeConnectionAction = z.strictObject({ request_id: RequestId, action: z.enum(["login", "cancel", "logout"]) });
export const NativeConnectionView = z.strictObject({
    state: z.enum(["offline", "signed_out", "authorizing", "ready", "error"]),
    binding: NativeAccountBinding.optional(), models: z.array(AIModel).default([]),
    login_url: z.string().url().refine(value => { const u = new URL(value); return u.protocol === "https:" && ["auth.openai.com", "chatgpt.com"].includes(u.hostname) && !u.username && !u.password; }).optional(),
    login_code: z.string().min(1).max(100).optional(), expires: Timestamp.optional(), error: z.string().max(100).optional(),
});
export const NativeState = z.enum(["starting", "login_required", "ready", "running", "awaiting_approval", "recovering", "unknown", "failed", "closed", "offline"]);
export const NativeApproval = z.strictObject({ id: z.string().min(1).max(180), instance: z.string().min(1), method: z.enum(["command", "file", "mcp", "input"]), description: z.string().max(32000), created: Timestamp, expires: Timestamp,
    questions: z.array(z.strictObject({ id: z.string(), header: z.string(), question: z.string(), options: z.array(z.strictObject({ label: z.string(), description: z.string() })).optional() })).optional() });
export const NativeRuntimeView = z.strictObject({ state: NativeState, instance: z.string().optional(), thread: z.string().optional(), version: z.string().optional(), account: z.string().optional(),
    stopped: z.boolean().optional(), models: z.array(AIModel).default([]), model: z.string().optional(), default_model: z.string().optional(), effort: z.string().optional(), login_url: z.string().url().refine(value=>{const u=new URL(value);return u.protocol==="https:"&&["auth.openai.com","chatgpt.com"].includes(u.hostname)&&!u.username&&!u.password;},"Official login URL required").optional(), login_code: z.string().optional(), approval: NativeApproval.optional(), error: z.string().max(1000).optional(), usage: z.record(z.string(), z.number()).optional() });
export const NativeSession = z.strictObject({ id: idOf("ais"), conversation: idOf("conv"), owner: idOf("act"), runtime: idOf("act"), profile: AIProfile, connection: AIConnection, binding: AIUsageBinding,
    connection_auth: NativeAccountBinding.optional(), view: NativeRuntimeView, sequence: z.number().int().nonnegative(), created: Timestamp, updated: Timestamp, quarantined: z.boolean(), context_revision: z.string(), capabilities: z.array(z.string()) });
export const NativeCreate = z.strictObject({ request_id: RequestId, profile: idOf("aip"), title: z.string().trim().min(1).max(100).optional() });
export const NativeAction = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("login") }), z.strictObject({ action: z.literal("resume") }), z.strictObject({ action: z.literal("interrupt"), confirmed: z.literal(true).optional() }), z.strictObject({ action: z.literal("compact") }), z.strictObject({ action: z.literal("close") }), z.strictObject({ action: z.literal("idle") }),
    z.strictObject({ action: z.literal("approval"), approval: z.string().min(1), instance: z.string().min(1), accept: z.boolean(), answers: z.record(z.string(), z.array(z.string())).optional() }),
    z.strictObject({ action: z.literal("resolve"), resolution: z.enum(["verified-complete", "verified-not-executed", "retry-at-own-risk"]), note: z.string().trim().min(8).max(2000), processes_stopped: z.literal(true) })
]);
export const NativeEventData = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("state"), view: NativeRuntimeView }),
    z.strictObject({ type: z.literal("text"), delta: z.string().max(65536) }), z.strictObject({ type: z.literal("reasoning"), delta: z.string().max(65536) }),
    z.strictObject({ type: z.literal("tool"), id: z.string(), name: z.string(), status: z.enum(["running", "completed", "failed", "unknown"]), description: z.string().max(32000) }),
    z.strictObject({ type: z.literal("complete"), status: z.enum(["done", "failed", "unknown", "cancelled"]), text: z.string().max(2000000), error: z.string().max(1000).optional() })
]);
export const CodexQuotaResult = z.union([
    z.strictObject({ status: z.literal("ready"), binding: NativeAccountBinding, snapshot: AIQuotaSnapshot.refine(value => value.source === "codex") }),
    z.strictObject({ status: z.literal("credentials") }),
    z.strictObject({ status: z.enum(["error", "unsupported"]), binding: NativeAccountBinding.optional() }),
]);
export type CodexQuotaResult = z.infer<typeof CodexQuotaResult>;
export const NativeRuntimeCommand = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("claude_usage"), command: z.string().uuid(), connection: idOf("aic"),
        generation: z.string().uuid(), account: ClaudeQuotaAccount.optional() }),
    z.strictObject({ type: z.literal("connection_usage"), command: z.string().uuid(), connection: idOf("aic"), owner: idOf("act") }),
    z.strictObject({ type: z.literal("connection_auth"), command: z.string().uuid(), connection: idOf("aic"), owner: idOf("act"), action: z.enum(["status", "login", "cancel", "logout"]) }),
    z.strictObject({ type: z.literal("open"), command: z.string(), session: NativeSession, hub_url: z.string().url(), mcp_token: z.string().min(16) }),
    z.strictObject({ type: z.literal("action"), command: z.string(), session: idOf("ais"), input: NativeAction }),
    z.strictObject({ type: z.literal("turn"), command: z.string(), session: idOf("ais"), turn: idOf("turn"), profile_revision: Revision, message: z.string().max(1000000), model: z.string(), effort: z.string().optional(), context: z.string().max(1000000), context_revision: z.string() }),
    z.strictObject({ type: z.literal("ack"), session: idOf("ais"), sequence: z.number().int().nonnegative() })
]);
export const NativeRuntimeMessage = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("hello"), protocol: z.literal(1), instance: z.string(), version: z.string(), isolation: z.enum(["macos-seatbelt", "unsupported"]), connection_auth: z.literal(true).optional(), connection_usage: z.literal(true).optional(), claude_usage: z.literal(true).optional() }),
    z.strictObject({ type: z.literal("claude_usage"), command: z.string().uuid(), connection: idOf("aic"),
        generation: z.string().uuid(), result: ClaudeBackgroundResult }),
    z.strictObject({ type: z.literal("connection_usage"), command: z.string().uuid(), connection: idOf("aic"), result: CodexQuotaResult }),
    z.strictObject({ type: z.literal("connection_auth"), command: z.string().uuid(), connection: idOf("aic"), owner: idOf("act"), view: NativeConnectionView }),
    z.strictObject({ type: z.literal("event"), session: idOf("ais"), sequence: z.number().int().positive(), turn: idOf("turn").optional(), event: NativeEventData }),
    z.strictObject({ type: z.literal("pong") })
]);
export const NativeMCPRequest = z.strictObject({ session: idOf("ais"), request_id: RequestId, tool: z.string().min(1), args: z.record(z.string(), z.unknown()) });
export const NativeMCPResult = z.strictObject({ result: z.unknown() });
export type AIConnection = z.infer<typeof AIConnection>;
export type AIConnectionInput = z.infer<typeof AIConnectionInput>;
export type AIProfile = z.infer<typeof AIProfile>;
export type AIProfileInput = z.infer<typeof AIProfileInput>;
export type AIConfiguration = z.infer<typeof AIConfiguration>;
export type AIConfigurationDelete = z.infer<typeof AIConfigurationDelete>;
export type AIConfigurationDeleted = z.infer<typeof AIConfigurationDeleted>;
export type AIUsageBinding = z.infer<typeof AIUsageBinding>;
export type AIModel = z.infer<typeof AIModel>;
export type NativeAccountBinding = z.infer<typeof NativeAccountBinding>;
export type NativeConnectionAction = z.infer<typeof NativeConnectionAction>;
export type NativeConnectionView = z.infer<typeof NativeConnectionView>;
export type NativeSession = z.infer<typeof NativeSession>;
export type NativeRuntimeView = z.infer<typeof NativeRuntimeView>;
export type NativeApproval = z.infer<typeof NativeApproval>;
export type NativeAction = z.infer<typeof NativeAction>;
export type NativeCreate = z.infer<typeof NativeCreate>;
export type NativeEventData = z.infer<typeof NativeEventData>;
export type NativeRuntimeCommand = z.infer<typeof NativeRuntimeCommand>;
export type NativeRuntimeMessage = z.infer<typeof NativeRuntimeMessage>;
export const AIRuntime = z.strictObject({ actor: idOf("act"), name: RuntimeName, online: z.boolean(), isolation: z.enum(["macos-seatbelt", "unsupported"]) });
export const NativeEventRecord = z.strictObject({ sequence: z.number().int().positive(), turn: idOf("turn").optional(), event: NativeEventData });
export type AIRuntime = z.infer<typeof AIRuntime>;
export type NativeEventRecord = z.infer<typeof NativeEventRecord>;
