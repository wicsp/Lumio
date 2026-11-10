import { AiNote, KnowledgeAiNoteCreateArgs, KnowledgeCreateRequest, KnowledgeCreateResult, KnowledgeTemplateRequest, KnowledgeTemplateResult, type NoteRef } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { entityDirectory } from "./layout.ts";
import { fillMetadata, type FillContext } from "./fill.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { generateCitekey } from "./citekey.ts";
import { rewriteBibtexKey } from "./bibtex.ts";
import { parsePaperInput } from "./paper-input.ts";
import type { NewNote } from "./create.ts";

const HEADINGS = {
  paper: ["One sentence", "Method and evidence", "Limitations", "Relation to my research", "Questions to verify"],
  video: ["Summary", "Key timestamps", "My understanding and questions", "Next steps"],
  web: ["Main points", "Quotes and sources", "My understanding and questions", "Next steps"],
  idea: ["Problem", "Current idea", "Evidence", "Uncertainties", "Next validation"],
};
/** Applications supply localized labels, while Knowledge owns template structure and version. */
export function knowledgeTemplate(input: KnowledgeTemplateRequest, text: (key: string) => string): KnowledgeTemplateResult {
  const { kind, locale } = KnowledgeTemplateRequest.parse(input);
  return KnowledgeTemplateResult.parse({ kind, locale, version: "1", body: HEADINGS[kind].map(title => `## ${text(title)}\n\n`).join("") });
}

export function paperIdentity(value: unknown, kind: "arxiv" | "doi"): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  const parsed = parsePaperInput(value);
  if (parsed.kind !== kind) throw new CoreError("INVALID_PAPER_INPUT", { key: "paper-input.unrecognized_paper_input_accepts_arxiv_ids_2403_14720_hep_th_9901001", args: [] });
  return (parsed.kind === "arxiv" ? parsed.id : parsed.doi).toLowerCase();
}
export function duplicatePaper(note: KnowledgeCreateRequest["note"], files: { frontmatter: Record<string, unknown> }[]): boolean {
  if (note.kind !== "paper") return false;
  const arxiv = paperIdentity(note.arxiv, "arxiv"), doi = paperIdentity(note.doi, "doi");
  return files.some(({ frontmatter }) => {
    const identity = (kind: "arxiv" | "doi") => { try { return paperIdentity(frontmatter[kind], kind); } catch { return undefined; } };
    return !!((arxiv && arxiv === identity("arxiv")) || (doi && doi === identity("doi")));
  });
}

/** Pure rendering; defaults are validated on read, not materialized in the Markdown. */
export function renderKnowledgeNote(input: KnowledgeCreateRequest, ctx: FillContext, suffix = ""): NewNote & { result: KnowledgeCreateResult } {
  const { note, body } = KnowledgeCreateRequest.parse(input);
  const type = note.kind === "video" || note.kind === "web" ? "source" : note.kind;
  const fm: Record<string, unknown> = { title: note.title };
  if (note.tags.length) fm.tags = note.tags;
  let name: string, content = body;
  if (note.kind === "paper") {
    name = generateCitekey(note) + suffix;
    Object.assign(fm, { citekey: name, authors: note.authors, year: note.year });
    for (const key of ["venue", "url"] as const) if (note[key]) fm[key] = note[key];
    for (const key of ["arxiv", "doi"] as const) if (note[key]) fm[key] = paperIdentity(note[key], key);
    if (note.status && note.status !== "to-read") fm.status = note.status;
    if (note.bibtex) content += `${content.endsWith("\n") ? "" : "\n"}\n## BibTeX\n\n\`\`\`bibtex\n${rewriteBibtexKey(note.bibtex, name)}\n\`\`\`\n`;
  } else {
    name = note.title.replace(/[\\/:*?"<>|#^\[\]\x00-\x1f\x7f]/g, " ").replace(/\s+/gu, " ").replace(/^[. ]+|[. ]+$/g, "").trim();
    if (!name || new TextEncoder().encode(name).length > 230) throw new CoreError("INVALID_FILE_NAME", { key: "create.title_is_empty_after_removing_invalid_characters_cannot_generate_fil", args: [] });
    if (note.kind !== "idea") {
      fm.kind = note.kind;
      for (const key of ["url", "author", "site"] as const) if (note[key]) fm[key] = note[key];
      if (note.status && note.status !== "to-read") fm.status = note.status;
    }
  }
  if (new TextEncoder().encode(name).length > 230) throw new CoreError("INVALID_FILE_NAME", { key: "create.title_is_empty_after_removing_invalid_characters_cannot_generate_fil", args: [] });
  const { patch, issues } = fillMetadata({ type, frontmatter: fm, fileName: name, birthtime: ctx.now, mtime: ctx.now }, ctx);
  Object.assign(fm, patch);
  if (issues.length) throw new CoreError("INVALID_METADATA", { key: "create.could_not_generate_valid_idea_metadata", args: [] });
  const relativePath = `${entityDirectory(type)}/${name}.md`;
  // Start with an empty document: body beginning with --- is human Markdown, never frontmatter injection.
  const bytes = Buffer.concat([parseFrontmatter("").render(fm), Buffer.from(content)]);
  const result = KnowledgeCreateResult.parse({ id: fm.id, path: relativePath, metadata: fm });
  return { relativePath, content: bytes, result };
}

/** The current run or message is appended once without changing an explicit source order. */
export function aiNoteSources(sources: string[] | undefined, currentSource?: string): string[] | undefined {
  if (!currentSource || sources?.includes(currentSource)) return sources;
  return [...(sources ?? []), currentSource];
}

export function renderAiNote(
  actor: string, args: KnowledgeAiNoteCreateArgs, ctx: FillContext, currentSource?: string,
): NewNote & { note: NoteRef } {
  const { title, body, tags, model, derived_from } = args;
  const sources = aiNoteSources(derived_from, currentSource);
  const id = ctx.newId("ain");
  const timestamp = ctx.now.toISOString();
  const data = {
    id, type: "ai-note", title, created: timestamp, updated: timestamp, generated_by: actor,
    ...(tags !== undefined ? { tags } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(sources !== undefined ? { derived_from: sources } : {}),
  };
  const parsed = AiNote.safeParse(data);
  if (!parsed.success) {
    throw new CoreError("INVALID_METADATA", { key: "create.could_not_generate_valid_idea_metadata", args: [] });
  }
  const path = `${entityDirectory("ai-note")}/${id}.md`;
  const content = Buffer.concat([parseFrontmatter("").render(data), Buffer.from(body)]);
  return { relativePath: path, content, note: { id, path, type: parsed.data.type, title } };
}
