/** ADR 0034 §1–5, approved 2026-11-06. Claude draft, reviewed against the approved scope. */
import { z } from "zod";
import { RequestId, SafeRelativePath, Id } from "./common.ts";
import { Paper, Source, Idea } from "./entities.ts";

export const KnowledgeNoteKind = z.enum(["paper", "video", "web", "idea"]);
export type KnowledgeNoteKind = z.infer<typeof KnowledgeNoteKind>;
const Title = z.string().trim().min(1).max(500);
const Url = z.url({ protocol: /^https?$/ }).max(2000);
const Tags = z.array(z.string().trim().min(1).max(100)).max(100).default([]);
const ReadingStatus = z.enum(["to-read", "reading", "read"]);
const paperFields = {
  title: Title,
  authors: z.array(z.string().trim().min(1).max(300)).min(1).max(300),
  year: z.number().int().min(1000).max(9999),
  firstAuthorFamily: z.string().trim().min(1).max(300).optional(),
  venue: z.string().max(500).optional(),
  arxiv: z.string().trim().min(1).max(100).optional(),
  doi: z.string().trim().min(1).max(500).optional(),
  url: Url.optional(),
};
export const KnowledgeTemplateRequest = z.strictObject({ kind: KnowledgeNoteKind, locale: z.enum(["en", "zh"]).default("en") });
export const KnowledgeTemplateResult = z.strictObject({ kind: KnowledgeNoteKind, locale: z.enum(["en", "zh"]), version: z.string().min(1), body: z.string() });
export const PaperResolveRequest = z.strictObject({ input: z.string().trim().min(1).max(2000) });
export const PaperResolveResult = z.strictObject({ ...paperFields, bibtex: z.string().max(100000).optional() });
const sourceFields = { title: Title, url: Url.optional(), author: z.string().max(300).optional(), site: z.string().max(300).optional(), tags: Tags, status: ReadingStatus.optional() };
export const KnowledgeCreateRequest = z.strictObject({
  request_id: RequestId,
  note: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("paper"), ...paperFields, tags: Tags, status: ReadingStatus.optional(), bibtex: z.string().max(100000).optional() }),
    z.strictObject({ kind: z.literal("video"), ...sourceFields }),
    z.strictObject({ kind: z.literal("web"), ...sourceFields }),
    z.strictObject({ kind: z.literal("idea"), title: Title, tags: Tags }),
  ]),
  body: z.string().max(500000),
});
export const KnowledgeCreateResult = z.strictObject({ id: Id, path: SafeRelativePath, metadata: z.union([Paper, Source, Idea]) });
export type KnowledgeTemplateRequest = z.infer<typeof KnowledgeTemplateRequest>;
export type KnowledgeTemplateResult = z.infer<typeof KnowledgeTemplateResult>;
export type PaperResolveRequest = z.infer<typeof PaperResolveRequest>;
export type PaperResolveResult = z.infer<typeof PaperResolveResult>;
export type KnowledgeCreateRequest = z.infer<typeof KnowledgeCreateRequest>;
export type KnowledgeCreateResult = z.infer<typeof KnowledgeCreateResult>;
