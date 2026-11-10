import { z } from "zod";

/** 每类实体的 ID 前缀。ID 形如 `pap_01J9Z3...`（前缀 + ULID）。 */
export const ID_PREFIXES = {
  ai_connection: "aic",
  ai_profile: "aip",
  ai_session: "ais",
  paper: "pap",
  idea: "idea",
  project: "prj",
  task: "task",
  experiment: "exp",
  source: "src",
  post: "post",
  asset: "ast",
  report: "rpt",
  job: "job",
  proposal: "prop",
  actor: "act",
  routine: "rtn",
  // ADR 0025（R0-1）：Work / Assistant / 存储新增的前缀
  work_comment: "wmsg",
  conversation: "conv",
  assistant_message: "amsg",
  assistant_turn: "turn",
  tool_call: "tool",
  memory: "mem",
  log_event: "evt",
  artifact: "art",
  migration: "mig",
  // ADR 0031（R4-1）：流程模板、推送设备
  workflow_template: "wft",
  push_device: "pdev",
  // ADR 0051（K4-1）：AI 笔记。键与实体 type 同名（知识实体按 type 取前缀）
  "ai-note": "ain",
} as const;

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ALL_PREFIXES = Object.values(ID_PREFIXES).join("|");

/** 任意实体的 ID。 */
export const Id = z
  .string()
  .regex(new RegExp(`^(${ALL_PREFIXES})_${ULID}$`), "ID 必须是 <前缀>_<ULID>")
  .describe("<前缀>_<ULID>，例如 pap_01J9Z3...");

/** 指定前缀的 ID，例如 `idOf("pap")` 只接受论文 ID。 */
export const idOf = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(new RegExp(`^${prefix}_${ULID}$`), `ID 必须是 ${prefix}_<ULID>`);

/**
 * 正文里引用非知识资源的链接地址：`lumio:<ID>`（ADR 0051 第 3 节）。
 * 只存 ID、不存 Hub 地址；ID 前缀全局唯一，能推出所属模块。
 */
export const LUMIO_LINK_SCHEME = "lumio:";
export const LumioLink = z
  .string()
  .regex(new RegExp(`^lumio:(${ALL_PREFIXES})_${ULID}$`), "必须是 lumio:<前缀>_<ULID>")
  .describe("lumio:<ID>，例如 lumio:amsg_01J9Z3...");
/** 由 ID 生成 `lumio:<ID>`。 */
export const lumioLink = (id: string): string => `${LUMIO_LINK_SCHEME}${id}`;
/** 从 `lumio:<ID>` 取出 ID；不是合法的 Lumio 链接时返回 undefined。 */
export function idOfLumioLink(href: string): string | undefined {
  return LumioLink.safeParse(href).success ? href.slice(LUMIO_LINK_SCHEME.length) : undefined;
}

/**
 * 知识的来源（ADR 0051 第 2 节）：Lumio ID（任何模块，粒度可到消息 `amsg_`、Job、日志事件）或 http(s) URL。
 * 只说明"从哪里来"，不计入链接图。
 */
export const DerivedFrom = z
  .union([Id, z.url({ protocol: /^https?$/ })])
  .describe("Lumio ID（如 amsg_…、job_…、src_…）或 http(s) URL");

/** ISO 8601 时间，必须带时区。 */
export const Timestamp = z.iso.datetime({ offset: true });

/**
 * vault 实体的可选字段：缺失或 YAML 里留空（解析为 `null`）都视为未填写（ADR 0008）。
 * 人手写 frontmatter 时一定会留空字段，例如 `venue:`。
 */
export const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((v): z.output<T> | undefined => v ?? undefined);

/** vault 实体的带默认值字段：缺失或留空都取默认值（ADR 0008）。 */
export const withDefault = <T extends z.ZodType>(schema: T, value: z.output<T>) =>
  schema.nullish().transform((v): z.output<T> => v ?? value);

/**
 * 所有 vault 实体共有的 frontmatter 字段。
 *
 * 用 looseObject：frontmatter 里可能有 Obsidian 或其他工具写入的额外字段，
 * 解析后再写回时必须原样保留，不能丢掉。
 */
export const Base = z.looseObject({
  schema_version: z.literal(1).default(1),
  id: Id,
  title: z.string().min(1),
  created: Timestamp,
  updated: Timestamp,
  tags: withDefault(z.array(z.string()), []),
  derived_from: optional(z.array(DerivedFrom)).describe("来源：Lumio ID 或 URL（ADR 0051）；不计入链接图"),
  // related 已删除（ADR 0018）：链接写在正文的 [[ ]] 里。旧笔记里的 related 作为未知字段原样保留，不再计入链接图。
});

export const AGENTS = ["claude-code", "codex", "pi"] as const;

/** 执行器名称（设备名），如 server、mac。 */
export const RuntimeName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "执行器名称只能用小写字母、数字和 . _ -");

const ASSIGNEE_MESSAGE = "负责人必须是 human、agent 或 agent@执行器，例如 pi@server";
export const AgentAssignee = z.union([
  z.string().regex(new RegExp(`^(${AGENTS.join("|")})(@[a-z0-9][a-z0-9._-]{0,31})?$`), ASSIGNEE_MESSAGE),
  z.strictObject({ agent: z.enum(AGENTS), device: RuntimeName.optional() }),
]);
export const Assignee = z.union([z.literal("human"), AgentAssignee]);

/**
 * v2 业务对象使用的负责人写法（ADR 0025 第 8 节）：只接受字符串 `agent` 或 `agent@执行器`，
 * 不接受旧的 `{agent, device}` 对象；对象写法只用于旧笔记解码。
 */
export const AgentTarget = z
  .string()
  .regex(new RegExp(`^(${AGENTS.join("|")})(@[a-z0-9][a-z0-9._-]{0,31})?$`), ASSIGNEE_MESSAGE);
/** v2 任务负责人：`human` 或 AgentTarget。 */
export const TaskAssignee = z.union([z.literal("human"), AgentTarget]);
export type AgentTarget = z.infer<typeof AgentTarget>;
export type TaskAssignee = z.infer<typeof TaskAssignee>;

/** 正整数版本号：每次修改递增，用于 expected_revision 并发检查。 */
export const Revision = z.number().int().positive();

/** 请求去重标识：重放同一 request_id 不重复执行（ADR 0025 第 5 节）。 */
export const RequestId = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/, "request_id 必须是 16–128 个字母、数字或 . _ : -");

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** 安全相对路径：非空，不以 `/` 开头，不含 `..`/`.`/空段、反斜杠、NUL 或 URL scheme。 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || URL_SCHEME.test(path)) return false;
  return path.split("/").every((segment) => segment !== ".." && segment !== "." && segment !== "");
}
export const SafeRelativePath = z
  .string()
  .refine(isSafeRelativePath, "必须是安全的相对路径：不能以 / 开头，不能含 .. 段、反斜杠或 URL");

/** SHA-256 十六进制摘要（小写 64 位）。 */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 必须是 64 位小写十六进制");

export class AssigneeError extends Error {
  readonly code = "INVALID_ASSIGNEE";
  constructor() { super(ASSIGNEE_MESSAGE); this.name = "AssigneeError"; }
}
/** 集中解析字符串与兼容的旧对象写法（ADR 0024）。 */
export function parseAssignee(value: unknown): "human" | { agent: typeof AGENTS[number]; device?: string } {
  const parsed = Assignee.safeParse(value);
  if (!parsed.success) throw new AssigneeError();
  if (parsed.data === "human" || typeof parsed.data === "object") return parsed.data;
  const [agent, device] = parsed.data.split("@");
  return { agent: agent as typeof AGENTS[number], ...(device ? { device } : {}) };
}
