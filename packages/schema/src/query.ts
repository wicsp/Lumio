import { z } from "zod";
import { Id } from "./common.ts";
import { Citekey } from "./entities.ts";

/**
 * 查询结果的契约：CLI 的 `--json` 输出与 Hub 查询 API 的响应体（ADR 0014 第 2 节）。
 * AI 通过 skill 依赖这些结构，修改即为契约变更。
 */

export const NOTE_TYPES = ["paper", "idea", "project", "task", "experiment", "source", "post", "asset"] as const;

/** 一篇笔记的简要信息，出现在搜索结果和链接列表中。 */
export const NoteRef = z.strictObject({
  id: Id,
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

/** 链接来源：frontmatter 的 related，或正文中的 [[名称]]（ADR 0014 第 4 节）。 */
export const LinkSource = z.enum(["related", "wikilink"]);

export const Link = z.strictObject({
  source: LinkSource,
  note: NoteRef.optional().describe("链接解析到的笔记；悬空链接时缺省"),
  target: z.string().describe("原始链接目标：related 中的 ID，或 [[ ]] 中去掉别名和标题后的名称"),
  dangling: z.boolean().describe("目标无法解析为 vault 中的笔记"),
});

export const LinksResult = z.strictObject({
  note: NoteRef,
  outgoing: z.array(Link),
  incoming: z.array(Link.extend({ note: NoteRef }).describe("反向链接：哪些笔记链接到了这里")),
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
