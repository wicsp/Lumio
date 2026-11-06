import type { KnowledgeDocument, KnowledgeUpdateRequest } from "@lumio/schema";
import type { createClient } from "@lumio/api-client";
type Client = ReturnType<typeof createClient>;
import { newRequestId } from "./commands.ts";
export class NoteSave {
    title: string;
    body: string;
    pending?: KnowledgeUpdateRequest;
    error?: unknown;
    latest?: KnowledgeDocument;
    private flight?: Promise<boolean>;
    constructor(public base: KnowledgeDocument, private client: Pick<Client, "updateNote" | "knowledgeDocument">, private notify: () => void) { this.title = base.document.note.title; this.body = base.document.body; }
    get dirty(): boolean { return !!this.pending || this.title.trim() !== this.base.document.note.title || this.body !== this.base.document.body; }
    get saving(): boolean { return !!this.flight; }
    change(title: string, body: string): void { this.title = title; this.body = body; const e = this.error as {
        code?: string;
        reason?: string;
    } | undefined; if (e?.code === "INVALID" && e.reason === "invalid-note")
        this.error = undefined; this.notify(); }
    save(): Promise<boolean> {
        if (this.flight)
            return this.flight;
        this.error = undefined;
        const run = async () => {
            while (this.dirty) {
                this.pending ??= { request_id: newRequestId("note-edit"), expected_revision: this.base.revision, title: this.title.trim(), body: this.body };
                this.notify();
                try {
                    const result = await this.client.updateNote(this.base.document.note.id!, this.pending);
                    const latest = await this.client.knowledgeDocument(this.base.document.note.id!);
                    this.base = result;
                    this.pending = undefined;
                    if (latest.revision !== result.revision) {
                        this.latest = latest;
                        this.error = { code: "CONFLICT", reason: "revision_conflict", message: "Saved note changed elsewhere" };
                        return false;
                    }
                }
                catch (cause) {
                    this.error = cause;
                    const e = cause as {
                        code?: string;
                        reason?: string;
                    };
                    if (e.code === "INVALID" || e.reason === "revision_conflict")
                        this.pending = undefined;
                    return false;
                }
            }
            return true;
        };
        this.flight = run().finally(() => { this.flight = undefined; this.notify(); });
        this.notify();
        return this.flight;
    }
    async compare(): Promise<KnowledgeDocument> { const latest = await this.client.knowledgeDocument(this.base.document.note.id!); this.latest = latest; return latest; }
    /** Only the exact version the user reviewed may become the next expected version. */
    rebase(reviewed: KnowledgeDocument): void { this.base = reviewed; this.pending = undefined; this.error = undefined; this.latest = undefined; this.notify(); }
}
