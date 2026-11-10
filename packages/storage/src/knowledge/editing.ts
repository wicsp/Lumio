import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Database } from "bun:sqlite";
import { AiNote, KnowledgeAiNoteUpdateArgs, KnowledgeAiNoteResult, RequestId, KnowledgeDocument, KnowledgeUpdateRequest, KnowledgeUpdateResult, KnowledgeRelatedRequest, KnowledgeRelatedResult, KnowledgeReferencesRequest, KnowledgeReferencesResult, type NoteDetail } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { editableMetadata, editKnowledgeDocument, parseFrontmatter, lexicalTerms, searchableText, rankRelated, referenceText, entityDirectory, aiNoteSources, type KnowledgeMetadataEdits } from "@lumio/knowledge";
import { withIndex, noteRef, type NoteRow, type IndexOptions } from "./index/store.ts";
import { vaultFileAt } from "./vault.ts";
import { writeFileAtomic } from "./write.ts";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fail(code: string): never { throw new CoreError(code, { key: "write.file_changed_during_processing_run_again", args: [] }); }
async function indexed(root: string, id: string, options: IndexOptions): Promise<NoteRow> {
    return withIndex(root, options, db => { const rows = db.query<NoteRow, [
        string
    ]>("SELECT * FROM notes WHERE id=?").all(id); if (rows.length !== 1 || rows[0]!.private)
        fail("NOTE_NOT_EDITABLE"); return rows[0]!; });
}
async function bytesAt(root: string, path: string): Promise<Buffer> {
    const file = await vaultFileAt(root, path);
    if (!file || file.private)
        fail("UNSAFE_NOTE_PATH");
    return readFile(file.path);
}
function document(row: NoteRow, bytes: Buffer): KnowledgeDocument {
    const parsed = parseFrontmatter(bytes);
    if (parsed.data.id !== row.id || !editableMetadata(parsed.data, row.type))
        fail("NOTE_NOT_EDITABLE");
    return KnowledgeDocument.parse({ document: { note: { ...noteRef(row), title: parsed.data.title }, frontmatter: parsed.data, body: parsed.body.toString("utf8") }, revision: hash(bytes) });
}
export async function readKnowledgeDocument(root: string, id: string, options: IndexOptions = {}): Promise<KnowledgeDocument> {
    const row = await indexed(root, id, options);
    return document(row, await bytesAt(root, row.path));
}
interface Receipt {
    actor: string;
    request_id: string;
    fingerprint: string;
    path: string;
    before: string;
    after: string;
    result: string;
    ready: number;
}
interface EditingHooks {
    now: Date;
    validate(bytes: Buffer): void;
    finalize(note: NoteDetail, bytes: Buffer, actor: string): Promise<void>;
    audit(note: NoteDetail, actor: string): void;
    beforeWrite?(): Promise<void>;
}
interface AiNoteEdit {
    currentSource?: string;
    tags?: string[];
    sources?: string[];
    validateSources?(sources: readonly string[]): Promise<void>;
}
export class KnowledgeEditingStore {
    constructor(private db: Database, private root: string, private options: IndexOptions = {}) {
        db.exec(`CREATE TABLE IF NOT EXISTS knowledge_edits(actor TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,path TEXT NOT NULL,before TEXT NOT NULL,after TEXT NOT NULL,result TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(actor,request_id));
   CREATE UNIQUE INDEX IF NOT EXISTS knowledge_edit_pending ON knowledge_edits(path) WHERE ready=0;`);
    }
    async update(actor: string, id: string, input: KnowledgeUpdateRequest, hooks: EditingHooks): Promise<KnowledgeUpdateResult> {
        return this.save(actor, id, KnowledgeUpdateRequest.parse(input), hooks);
    }
    async updateAiNote(
        actor: string, requestId: string, input: KnowledgeAiNoteUpdateArgs,
        hooks: EditingHooks & Pick<AiNoteEdit, "validateSources">, currentSource?: string,
    ): Promise<KnowledgeAiNoteResult> {
        const { note, tags, derived_from, ...request } = KnowledgeAiNoteUpdateArgs.parse(input);
        const result = await this.save(actor, note, { request_id: RequestId.parse(requestId), ...request }, hooks, {
            tags, sources: derived_from, currentSource, validateSources: hooks.validateSources,
        });
        return KnowledgeAiNoteResult.parse({ note: result.document.note, revision: result.revision });
    }
    private async save(
        actor: string, id: string,
        request: Omit<KnowledgeUpdateRequest, "title" | "body"> & Partial<Pick<KnowledgeUpdateRequest, "title" | "body">>,
        hooks: EditingHooks, ai?: AiNoteEdit,
    ): Promise<KnowledgeUpdateResult> {
        const root = await realpath(this.root);
        const { validateSources, ...aiArgs } = ai ?? {};
        const fingerprint = hash(JSON.stringify({ root, id, ...request, ...(ai ? { ai: aiArgs } : {}) }));
        let receipt = this.db.query<Receipt, [
            string,
            string
        ]>("SELECT * FROM knowledge_edits WHERE actor=? AND request_id=?").get(actor, request.request_id);
        if (receipt && receipt.fingerprint !== fingerprint)
            fail("REQUEST_CONFLICT");
        if (receipt?.ready === 1)
            return KnowledgeUpdateResult.parse(JSON.parse(receipt.result));
        if (receipt && receipt.ready < 0)
            fail("REVISION_CONFLICT");
        let row: NoteRow, before: Buffer, current: KnowledgeDocument;
        try {
            row = await indexed(root, id, this.options);
            if (ai && row.type !== "ai-note")
                fail("NOTE_NOT_EDITABLE");
            if (receipt && receipt.path !== row.path)
                fail("REVISION_CONFLICT");
            before = await bytesAt(root, row.path);
            current = document(row, before);
        }
        catch (cause) {
            // Deleted, moved or invalidated documents must not leave a permanent path reservation.
            if (receipt && cause instanceof CoreError) {
                this.abandon(actor, request.request_id);
                fail("REVISION_CONFLICT");
            }
            throw cause;
        }
        if (!receipt) {
            if (current.revision !== request.expected_revision)
                fail("REVISION_CONFLICT");
            const { note, body, frontmatter } = current.document;
            const metadata: KnowledgeMetadataEdits = {};
            if (ai) {
                const stored = AiNote.parse(frontmatter).derived_from;
                const sources = aiNoteSources(ai.sources ?? stored, ai.currentSource);
                if (sources !== stored)
                    metadata.derived_from = sources;
                if (ai.tags !== undefined)
                    metadata.tags = ai.tags;
                await validateSources?.(sources ?? []);
            }
            const after = editKnowledgeDocument(before, request.title ?? note.title, request.body ?? body, hooks.now.toISOString(), metadata);
            hooks.validate(after);
            const result = KnowledgeUpdateResult.parse({ ...document(row, after), request_id: request.request_id });
            const stale = this.db.query<Receipt, [
                string
            ]>("SELECT * FROM knowledge_edits WHERE path=? AND ready=0").get(row.path);
            if (stale)
                await this.settle(stale, before, hooks);
            this.db.query("INSERT INTO knowledge_edits(actor,request_id,fingerprint,path,before,after,result) VALUES (?,?,?,?,?,?,?)").run(actor, request.request_id, fingerprint, row.path, before.toString("utf8"), after.toString("utf8"), JSON.stringify(result));
            receipt = this.db.query<Receipt, [
                string,
                string
            ]>("SELECT * FROM knowledge_edits WHERE actor=? AND request_id=?").get(actor, request.request_id)!;
        }
        else if (validateSources) {
            const pending = KnowledgeUpdateResult.parse(JSON.parse(receipt.result));
            await validateSources(AiNote.parse(pending.document.frontmatter).derived_from ?? []);
        }
        const result = KnowledgeUpdateResult.parse(JSON.parse(receipt.result)), after = Buffer.from(receipt.after), old = Buffer.from(receipt.before);
        hooks.validate(after);
        if (!before.equals(after)) {
            if (!before.equals(old)) {
                this.abandon(actor, request.request_id);
                fail("REVISION_CONFLICT");
            }
            try {
                await hooks.beforeWrite?.();
                // Revalidate the entire path immediately before the guarded atomic writer.
                const latest = await bytesAt(root, row.path);
                if (!latest.equals(old))
                    fail("REVISION_CONFLICT");
                await writeFileAtomic(join(root, row.path), after, { expectedContent: old, beforeCommit: async () => { const checked = await bytesAt(root, row.path); if (!checked.equals(old))
                        fail("REVISION_CONFLICT"); } });
            }
            catch (cause) {
                if (cause instanceof CoreError && ["FILE_CHANGED", "REVISION_CONFLICT", "UNSAFE_NOTE_PATH"].includes(cause.code)) {
                    this.abandon(actor, request.request_id);
                    fail("REVISION_CONFLICT");
                }
                throw cause;
            }
        }
        if (!(await bytesAt(root, row.path)).equals(after)) {
            this.abandon(actor, request.request_id);
            fail("REVISION_CONFLICT");
        }
        if (!old.equals(after))
            await hooks.finalize(result.document, after, actor);
        this.db.transaction(() => { hooks.audit(result.document, actor); this.db.query("UPDATE knowledge_edits SET ready=1 WHERE actor=? AND request_id=?").run(actor, request.request_id); })();
        return result;
    }
    /**
     * Writes are serialized, so a pending receipt seen by another request is an interrupted save whose client may be gone
     * (reload, closed tab). Resolve it per ADR 0035 §4 instead of reserving the path forever: expected new bytes on disk
     * complete its index, audit and receipt; original or third-party bytes end it so its own retry reports a conflict.
     */
    private async settle(stale: Receipt, current: Buffer, hooks: {
        finalize(note: NoteDetail, bytes: Buffer, actor: string): Promise<void>;
        audit(note: NoteDetail, actor: string): void;
    }): Promise<void> {
        const after = Buffer.from(stale.after);
        if (!current.equals(after)) {
            this.abandon(stale.actor, stale.request_id);
            return;
        }
        const result = KnowledgeUpdateResult.parse(JSON.parse(stale.result));
        if (!Buffer.from(stale.before).equals(after))
            await hooks.finalize(result.document, after, stale.actor);
        this.db.transaction(() => { hooks.audit(result.document, stale.actor); this.db.query("UPDATE knowledge_edits SET ready=1 WHERE actor=? AND request_id=?").run(stale.actor, stale.request_id); })();
    }
    private abandon(actor: string, request: string): void { this.db.query("UPDATE knowledge_edits SET ready=-1 WHERE actor=? AND request_id=?").run(actor, request); }
}
async function candidates(root: string, context: {
    title: string;
    text: string;
    focus: string;
}, exclude: string | undefined, query: string | undefined, options: IndexOptions) {
    const terms = lexicalTerms(query ?? [searchableText(context.focus), context.title, searchableText(context.text)].join(" "), !!query);
    if (!terms.length)
        return [];
    return withIndex(root, options, db => {
        const longer = terms.filter(t => Array.from(t).length >= 3).slice(0, 12), shorter = terms.filter(t => Array.from(t).length < 3).slice(0, 12);
        const filter = "n.private=0 AND n.type IN ('paper','source','idea','experiment','post','ai-note') AND (? IS NULL OR n.id!=? OR n.id IS NULL)";
        const rows: NoteRow[] = [];
        if (longer.length)
            rows.push(...db.query<NoteRow, [
                string,
                string | null,
                string | null
            ]>(`SELECT n.* FROM fulltext JOIN notes n ON n.rowid=fulltext.rowid WHERE fulltext MATCH ? AND ${filter} ORDER BY bm25(fulltext),n.path LIMIT 120`).all(longer.map(t => '"' + t.replaceAll('"', '""') + '"').join(" OR "), exclude ?? null, exclude ?? null));
        const fragments = [...shorter, ...longer.map(t => t.slice(0, Math.max(3, Math.floor(t.length * .65))))].slice(0, 16);
        if (fragments.length) {
            const conditions = fragments.map(() => "n.search_text LIKE ? ESCAPE '\\'").join(" OR ");
            rows.push(...db.query<NoteRow, any>(`SELECT n.* FROM notes n WHERE ${filter} AND (${conditions}) ORDER BY n.path LIMIT 120`).all(exclude ?? null, exclude ?? null, ...fragments.map(t => '%' + t.replace(/[\\%_]/g, "\\$&") + '%')));
        }
        return [...new Map(rows.map(r => [r.path, r])).values()].filter(r => { try {
            return editableMetadata(JSON.parse(r.frontmatter), r.type);
        }
        catch {
            return false;
        } }).map(r => ({ note: noteRef(r), body: r.body }));
    });
}
export async function relatedKnowledge(root: string, input: KnowledgeRelatedRequest, options: IndexOptions = {}): Promise<KnowledgeRelatedResult> {
    const request = KnowledgeRelatedRequest.parse(input);
    return KnowledgeRelatedResult.parse({ method: "lexical", hits: rankRelated(await candidates(root, request, request.exclude_id, undefined, options), request).slice(0, 5) });
}
export async function knowledgeReferences(root: string, input: KnowledgeReferencesRequest, options: IndexOptions = {}): Promise<KnowledgeReferencesResult> {
    const request = KnowledgeReferencesRequest.parse(input), context = request.context ?? { title: "", text: "", focus: "" };
    const source = request.source_id ? (await readKnowledgeDocument(root, request.source_id, options)).document.note.path : entityDirectory(request.source_kind === "video" || request.source_kind === "web" ? "source" : request.source_kind!) + "/new.md";
    const hits = rankRelated(await candidates(root, context, request.source_id, request.query || undefined, options), context, request.query || undefined).slice(0, request.query ? 10 : 5);
    return withIndex(root, options, db => KnowledgeReferencesResult.parse({ hits: hits.map(hit => ({ ...hit, insert_text: referenceText(source, hit.note, db.query<{
                n: number;
            }, [
                string
            ]>("SELECT count(*) AS n FROM notes WHERE filename=?").get(basename(hit.note.path, ".md"))!.n === 1) })) }));
}
