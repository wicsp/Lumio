import { z } from "zod";
import { Id } from "./common.ts";
import { Citekey } from "./entities.ts";

/**
 * 查询结果的契约：CLI 的 `--json` 输出与 Hub 查询 API 的响应体（ADR 0014 第 2 节）。
 * AI 通过 skill 依赖这些结构，修改即为契约变更。
 */

export const NOTE_TYPES = ["paper", "idea", "project", "task", "routine", "experiment", "source", "post", "asset"] as const;

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
});

export type NoteRef = z.infer<typeof NoteRef>;
export type SearchHit = z.infer<typeof SearchHit>;
export type SearchResult = z.infer<typeof SearchResult>;
export type Link = z.infer<typeof Link>;
export type LinksResult = z.infer<typeof LinksResult>;
export type NoteDetail = z.infer<typeof NoteDetail>;
export type CheckResult = z.infer<typeof CheckResult>;
