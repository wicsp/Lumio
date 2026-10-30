import { z } from "zod";

/** 每类实体的 ID 前缀。ID 形如 `pap_01J9Z3...`（前缀 + ULID）。 */
export const ID_PREFIXES = {
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
