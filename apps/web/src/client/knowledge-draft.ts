/** Claude UI draft, reviewed: keep exact empty values and immutable uncertain submissions. */
import { KnowledgeCreateRequest, type KnowledgeNoteKind, type PaperResolveResult } from "@lumio/schema";
export type NoteFields = Record<string, string>;
export function noteRequest(kind: KnowledgeNoteKind, fields: NoteFields, request_id: string): KnowledgeCreateRequest {
  const value = (key: string) => fields[key]?.trim() || undefined;
  const common = { title: value("title"), tags: (fields.tags ?? "").split(/[,，]/u).map(s => s.trim()).filter(Boolean) };
  const note = kind === "paper" ? { kind, ...common, authors: (fields.authors ?? "").split(/[,，\n]/u).map(s => s.trim()).filter(Boolean),
    year: Number(fields.year), ...Object.fromEntries(["venue", "doi", "arxiv", "url", "status", "bibtex", "firstAuthorFamily"].map(key => [key, value(key)])) }
    : kind === "idea" ? { kind, ...common } : { kind, ...common, ...Object.fromEntries(["url", "author", "site", "status"].map(key => [key, value(key)])) };
  return KnowledgeCreateRequest.parse({ request_id, note, body: fields.body ?? "" });
}
export function importEmptyFields(fields: NoteFields, metadata: PaperResolveResult): NoteFields {
  const result = { ...fields };
  for (const key of ["title", "authors", "year", "venue", "doi", "arxiv", "url", "bibtex"] as const) {
    const value = metadata[key];
    if (!result[key]?.trim() && value !== undefined) result[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  if (!fields.authors?.trim() && metadata.firstAuthorFamily) result.firstAuthorFamily = metadata.firstAuthorFamily;
  return result;
}
export class NoteDraft {
  readonly fields = new Map<KnowledgeNoteKind, NoteFields>();
  pending?: KnowledgeCreateRequest;
  saving = false;
  changed = false;
  set(kind: KnowledgeNoteKind, fields: NoteFields): void { this.fields.set(kind, { ...fields }); }
  begin(kind: KnowledgeNoteKind, fields: NoteFields, requestId: string): KnowledgeCreateRequest {
    this.pending ??= noteRequest(kind, fields, requestId);
    this.saving = true;
    return this.pending;
  }
  failed(error: unknown): void {
    this.saving = false;
    // Only definitive pre-save errors permit a different payload. Network/5xx recovery keeps exact request.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const reason = error && typeof error === "object" && "reason" in error ? error.reason : undefined;
    if (code === "INVALID" || code === "FORBIDDEN" || (code === "CONFLICT" && ["file_exists", "duplicate_paper"].includes(String(reason)))) this.pending = undefined;
  }
}
