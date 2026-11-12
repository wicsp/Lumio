import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreError } from "@lumio/foundation";
import {
  aiNoteFileName, capturedNoteBody, duplicatePaper, editKnowledgeDocument, entityDirectory, generateCitekey,
  knowledgeTemplate, parseFrontmatter, renderAiNote, renderKnowledgeNote, VAULT_LAYOUT,
} from "@lumio/knowledge";
import {
  FileKnowledgeRepository, openVaultGit, readKnowledgeDocument, readOriginalFile, saveNewNote, updateIndex,
  vaultFileAt, writeFileAtomic, writeOriginal,
} from "@lumio/storage";
import { AiNote, Paper, Source, type Capture, type KnowledgeAiNoteCreateArgs, type NoteRef, type ReadingStatus } from "@lumio/schema";
import type { HubConfig } from "./config.ts";
import type { Extracted } from "./inbox-extract.ts";
import { CaptureFailure } from "./inbox-fetch.ts";
import { text as msg, withLanguage } from "./messages.ts";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export interface CapturePlan {
  entity: NoteRef;
  entityBytes?: string;
  original: string;
  extraction: { body: string; extractor: string; lang?: string; captured: string };
}

export class InboxFiles {
  private readonly vault: string;
  private readonly options: { stateDir: string };
  constructor(config: HubConfig, private readonly issue: (path: string, message: string) => void) {
    this.vault = config.vault;
    this.options = { stateDir: config.stateDir };
  }

  async prepare(capture: Capture, extracted: Extracted, id: string, now: Date): Promise<CapturePlan> {
    const note = extracted.note, captured = now.toISOString();
    const extraction = { body: extracted.body, extractor: extracted.extractor, lang: extracted.lang, captured };
    if (capture.entity?.id && capture.original) {
      const { document } = await readKnowledgeDocument(this.vault, capture.entity.id, this.options);
      await this.noteBytes(document.note);
      return { entity: document.note, original: capture.original, extraction };
    }
    const originalPath = (entity: NoteRef) => `${VAULT_LAYOUT.originals}/${aiNoteFileName(entity.title, entity.id!)}.md`;
    const kind = note.kind === "idea" ? "web" : note.kind;
    const template = withLanguage("zh", () => knowledgeTemplate({ kind, locale: "zh" }, msg)).body;
    const status = capture.triage && capture.triage !== "discard" ? capture.triage : "to-read";
    const context = { now, tz: "UTC", newId: () => id };
    if (note.kind === "paper") {
      const papers = await new FileKnowledgeRepository(this.vault).papers();
      const existing = papers.find(file => duplicatePaper(note, [file]));
      if (existing) {
        const paper = Paper.parse(existing.frontmatter);
        const entity = { id: paper.id, type: paper.type, title: paper.title, citekey: paper.citekey, path: existing.path };
        return { entity, original: originalPath(entity), extraction };
      }
      for (const suffix of ["", ..."bcdefghijklmnopqrstuvwxyz"]) {
        const rendered = renderKnowledgeNote({ request_id: capture.id, note: { ...note, url: undefined }, body: template }, context, suffix);
        const metadata = Paper.parse({ ...rendered.result.metadata, status, url: capture.url });
        const entity = { id, path: rendered.relativePath, type: metadata.type, title: metadata.title, citekey: metadata.citekey };
        try { await lstat(join(this.vault, entity.path)); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          const body = parseFrontmatter(rendered.content).body.toString("utf8");
          return { entity, original: originalPath(entity), extraction, entityBytes: render(metadata, body) };
        }
      }
      throw new CaptureFailure("extract_failed");
    }
    const metadata = Source.parse({ id, type: "source", title: note.title, kind: capture.kind === "podcast" ? "podcast" : kind,
      status, url: capture.url, site: "site" in note ? note.site : undefined, created: captured, updated: captured });
    const entity = { id, type: metadata.type, title: metadata.title, path: `${entityDirectory("source")}/${aiNoteFileName(metadata.title, id)}.md` };
    return { entity, original: originalPath(entity), extraction, entityBytes: render(metadata, template) };
  }

  async publish(capture: Capture, plan: CapturePlan): Promise<void> {
    const input = { ...plan.extraction, title: plan.entity.title, of: plan.entity.id!, url: capture.url };
    if (!plan.entityBytes) await this.noteBytes(plan.entity);
    let existing;
    try { existing = await readOriginalFile(this.vault, plan.original); }
    catch (cause) { if (!(cause instanceof CoreError) || cause.code !== "NOTE_NOT_FOUND") throw cause; }
    if (existing?.frontmatter.of === input.of && existing.frontmatter.sha256 === digest(input.body) &&
        existing.frontmatter.extractor === input.extractor && existing.frontmatter.captured === input.captured) {
      // The original was already published before an interruption.
    } else if (capture.original) {
      await writeOriginal(this.vault, input, capture.original);
    } else {
      const created = await writeOriginal(this.vault, input);
      if (created.path !== plan.original) throw new CaptureFailure("extract_failed");
    }
    if (plan.entityBytes) await this.publishNote(plan.entity, plan.entityBytes);
    await this.commit([plan.original, ...(plan.entityBytes ? [plan.entity.path] : [])], capture.owner, "lumio: capture source");
  }

  async status(note: NoteRef, status: ReadingStatus, now: Date, actor: string): Promise<void> {
    const bytes = await this.noteBytes(note);
    const { data, body } = parseFrontmatter(bytes);
    (note.type === "paper" ? Paper : Source).parse({ ...data, status });
    const updated = editKnowledgeDocument(bytes, String(data.title), body.toString("utf8"), now.toISOString(), { status });
    await this.replaceNote(note, bytes, updated, actor, "lumio: triage capture");
  }

  async card(id: string, input: KnowledgeAiNoteCreateArgs, actor: string, now: Date, revision?: string): Promise<NoteRef> {
    if (!revision) {
      const note = renderAiNote(actor, input, { now, newId: () => id, tz: "UTC" });
      await this.publishNote(note.note, note.content.toString("utf8"));
      await this.commit([note.note.path], actor, "lumio: save capture AI note");
      return note.note;
    }
    const { document } = await readKnowledgeDocument(this.vault, id, this.options);
    const bytes = await this.noteBytes(document.note);
    const { data } = parseFrontmatter(bytes);
    if (digest(bytes) !== revision || AiNote.parse(data).generated_by !== actor) throw new CaptureFailure("summary_failed");
    const updated = editKnowledgeDocument(bytes, document.note.title, input.body, now.toISOString(),
      { tags: input.tags, derived_from: input.derived_from, model: input.model });
    await this.replaceNote(document.note, bytes, updated, actor, "lumio: save capture AI note");
    return document.note;
  }

  async embed(note: NoteRef, aiNote: NoteRef, owner: string, now: Date): Promise<void> {
    const bytes = await this.noteBytes(note);
    const parsed = parseFrontmatter(bytes), body = parsed.body.toString("utf8");
    if (body.includes(aiNote.id!)) return;
    const updated = editKnowledgeDocument(bytes, String(parsed.data.title), capturedNoteBody("", note.path, aiNote.path, "AI note") + body, now.toISOString());
    await this.replaceNote(note, bytes, updated, owner, "lumio: link capture AI note");
  }

  private async publishNote(note: NoteRef, bytes: string): Promise<void> {
    try { await saveNewNote(this.vault, { relativePath: note.path, content: Buffer.from(bytes) }); }
    catch (cause) {
      if (!(cause instanceof CoreError) || cause.code !== "FILE_EXISTS" || !(await this.noteBytes(note)).equals(Buffer.from(bytes))) throw cause;
    }
  }

  private async noteBytes(note: NoteRef): Promise<Buffer> {
    const file = await vaultFileAt(this.vault, note.path);
    if (!file || file.private || file.type !== note.type) throw new CaptureFailure("extract_failed");
    const bytes = await readFile(file.path);
    if (parseFrontmatter(bytes).data.id !== note.id) throw new CaptureFailure("extract_failed");
    return bytes;
  }

  private async replaceNote(note: NoteRef, before: Buffer, after: Buffer, actor: string, message: string) {
    if (!before.equals(after)) await writeFileAtomic(join(this.vault, note.path), after, { expectedContent: before });
    await this.commit([note.path], actor, message);
  }

  private async commit(paths: string[], actor: string, message: string) {
    await updateIndex(this.vault, this.options);
    const git = await openVaultGit(this.vault);
    if (!git) return;
    try {
      for (const path of paths) await git.add(path, await readFile(join(this.vault, path)));
      await git.commit(paths, message, { "Lumio-Actor": actor });
    } catch {
      for (const path of paths) this.issue(path, msg("knowledge.commit_failed"));
    }
  }
}

function render(data: Record<string, unknown>, body: string): string {
  const metadata = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  return parseFrontmatter("").render(metadata).toString("utf8") + body;
}
