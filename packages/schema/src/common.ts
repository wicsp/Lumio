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

/** 任务的负责人：`human` 表示自己，或指定某个 AI agent。 */
export const Assignee = z.union([
  z.literal("human"),
  z.strictObject({
    agent: z.enum(AGENTS),
    device: z.string().optional().describe("指定设备；省略则由调度决定"),
  }),
]);
