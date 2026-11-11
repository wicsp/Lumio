import { z } from "zod";
import { Id, Sha256, Timestamp } from "./common.ts";
import { Citekey, ReadingStatus } from "./entities.ts";

/**
 * 查询结果的契约：CLI 的 `--json` 输出与 Hub 查询 API 的响应体（ADR 0014 第 2 节）。
 * AI 通过 skill 依赖这些结构，修改即为契约变更。
 */

export const NOTE_TYPES = ["paper", "idea", "project", "task", "routine", "experiment", "source", "post", "asset", "ai-note"] as const;

/** 一篇笔记的简要信息，出现在搜索结果和链接列表中。 */
export const NoteRef = z.strictObject({
  id: Id.optional().describe(
    "缺失表示这篇笔记还没有 ID（运行 lumio sync 或由 Hub 补全）；这时只能按文件名引用它。不会用其他值代替",
  ),
  type: z.enum(NOTE_TYPES),
  title: z.string(),
  path: z.string().describe("相对 vault 根目录的路径，如 library/papers/He_2020_LightGCN.md"),
  citekey: Citekey.optional().describe("仅论文有"),
});

export const SearchHit = z.strictObject({
  note: NoteRef,
  snippet: z.string().describe("命中位置附近的一段纯文本，不超过 200 个字符"),
  // ADR 0057：命中位置、阅读状态与入库时间，缺失表示不适用或未知（旧 Hub 不返回）。
  matched_in: z.enum(["body", "original", "semantic"]).optional().describe("body：笔记正文或标题；original：资料原文；semantic：只按意思相近（向量）命中"),
  status: ReadingStatus.optional().describe("论文与资料的阅读状态"),
  created: Timestamp.optional().describe("笔记的 created，资料即入库时间"),
});

export const SearchResult = z.strictObject({
  query: z.string(),
  hits: z.array(SearchHit),
  total: z.number().int().nonnegative(),
});

/**
 * 链接来源（ADR 0018、0022）：正文中的 `[[名称]]`（按文件名解析），或标准 Markdown 链接 `[文字](相对路径.md)`（按路径解析）。
 * 两种都识别，用哪种由人决定。
 */
export const LinkSource = z.enum(["wikilink", "markdown"]);

export const Link = z.strictObject({
  source: LinkSource,
  note: NoteRef.optional().describe("链接解析到的笔记；悬空链接时缺省"),
  target: z.string().describe("原始链接目标：[[ ]] 中去掉别名和标题后的名称；Markdown 链接为解码、去掉 #标题 后的路径"),
  dangling: z.boolean().describe("目标无法解析为 vault 中的笔记"),
});

export const LinksResult = z.strictObject({
  note: NoteRef,
  outgoing: z.array(Link),
  incoming: z.array(Link.extend({ note: NoteRef }).describe("反向链接：哪些笔记链接到了这里")),
  // ADR 0053：AI 笔记正文里的链接单独列出，不计入人的链接图、全库图谱与引用导出。缺失表示没有。
  ai_outgoing: z.array(Link).min(1).optional().describe("这篇 AI 笔记正文里的链接（只有 AI 笔记有）"),
  ai_incoming: z.array(Link.extend({ note: NoteRef })).min(1).optional().describe("哪些 AI 笔记提到了这里"),
});

/**
 * `lumio check` 的结果：vault 中所有悬空链接（ADR 0018）。改名造成的断链由人修复，Lumio 只负责列出。
 * 私密笔记中的链接，以及指向私密笔记的链接是否可见，规则与 `links` 相同。
 */
export const CheckResult = z.strictObject({
  dangling: z.array(
    z.strictObject({
      from: NoteRef.describe("链接所在的笔记"),
      source: LinkSource,
      target: z.string().describe("原始链接目标"),
    }),
  ),
  total: z.number().int().nonnegative(),
});

/** `lumio show` 的结果。 */
export const NoteDetail = z.strictObject({
  note: NoteRef,
  frontmatter: z.record(z.string(), z.unknown()),
  body: z.string(),
  revision: Sha256.optional().describe("File revision for versioned AI note updates"),
});

export type NoteRef = z.infer<typeof NoteRef>;
export type SearchHit = z.infer<typeof SearchHit>;
export type SearchResult = z.infer<typeof SearchResult>;
export type Link = z.infer<typeof Link>;
export type LinksResult = z.infer<typeof LinksResult>;
export type NoteDetail = z.infer<typeof NoteDetail>;
export type CheckResult = z.infer<typeof CheckResult>;

/** A resource anchor exposes only the metadata the caller can see. */
export const KnowledgeReferenceCount = z.number().int().nonnegative();
export const ResourceSummary = z.discriminatedUnion("status", [
  z.strictObject({
    id: Id, status: z.literal("visible"), title: z.string(),
    parent: Id.optional().describe("Conversation, task or job containing the anchor"),
    timestamp: Timestamp.optional(),
    knowledge_references: KnowledgeReferenceCount.optional(),
  }),
  z.strictObject({ id: Id, status: z.enum(["trashed", "deleted", "unavailable"]) }),
]);
export type ResourceSummary = z.infer<typeof ResourceSummary>;
