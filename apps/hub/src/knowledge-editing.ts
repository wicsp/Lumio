import type { SemanticSearch } from "./semantic-search.ts";
import { assertNoteVisible } from "./trash.ts";
import { Id, KnowledgeUpdateRequest, KnowledgeRelatedRequest, KnowledgeReferencesRequest } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { KnowledgeEditingStore, noteById, fuseSearch, readKnowledgeDocument, relatedKnowledge, knowledgeReferences, updateIndex, openVaultGit } from "@lumio/storage";
import { HubError } from "./errors.ts";
import { text as msg } from "./messages.ts";
import type { HubStore, Identity } from "./store.ts";
import type { HubConfig } from "./config.ts";
export const EDITING_ROUTES = [
    { operation: "knowledge.document", method: "GET", pattern: /^\/v2\/knowledge\/notes\/([^/]+)\/document$/ },
    { operation: "knowledge.update", method: "PUT", pattern: /^\/v2\/knowledge\/notes\/([^/]+)\/document$/ },
    { operation: "knowledge.related", method: "POST", pattern: /^\/v2\/knowledge\/related$/ },
    { operation: "knowledge.references", method: "POST", pattern: /^\/v2\/knowledge\/references$/ },
] as const;
export class KnowledgeEditing {
    private edits: KnowledgeEditingStore;
    constructor(private config: HubConfig, private store: HubStore, private exclusive: <T>(action: () => Promise<T>) => Promise<T>, private issue: (path: string, message: string) => void, private semantic?: SemanticSearch) { this.edits = new KnowledgeEditingStore(store.db, config.vault, { stateDir: config.stateDir }); }
    async update(identity: Identity, id: string, input: KnowledgeUpdateRequest, now: Date) {
        const options = { stateDir: this.config.stateDir };
        return this.exclusive(() => {
            assertNoteVisible(this.store.db, id);
            return this.edits.update(identity.actor.id, id, input, {
                now,
                finalize: async (note, bytes, writer) => { await updateIndex(this.config.vault, options); const git = await openVaultGit(this.config.vault); if (git)
                    try {
                        await git.add(note.note.path, bytes);
                        await git.commit([note.note.path], "lumio: edit knowledge note", { "Lumio-Actor": writer });
                    }
                    catch (cause) {
                        this.issue(note.note.path, msg("knowledge.commit_failed"));
                        throw cause;
                    } },
                audit: (note, writer) => {
                    const original = writer === identity.actor.id ? identity : this.store.recoveryIdentity(writer);
                    this.store.audit(original, "knowledge.update", "allow", undefined, `${writer === identity.actor.id ? "updated" : "recovered"}:${note.note.id}`);
                }
            });
        });
    }
    async handle(request: Request, operation: string, body: unknown, identity: Identity, now: Date): Promise<Response> {
        const options = { stateDir: this.config.stateDir };
        try {
            if (operation === "knowledge.related") {
                const input = KnowledgeRelatedRequest.parse(body);
                const result = await relatedKnowledge(this.config.vault, input, options);
                // Only send context for an existing public note selected by its ID.
                if (input.exclude_id && this.semantic && await noteById(this.config.vault, input.exclude_id, options)) {
                    const hits = (await this.semantic.hits(identity.actor.id, [input.title, input.focus, input.text].filter(Boolean).join("\n"), undefined, 12))
                        .filter(hit => hit.note.id !== input.exclude_id);
                    if (hits.length) {
                        const lexical = result.hits.map(hit => ({ ...hit, matched_in: "body" as const, status: null, created: null }));
                        const fused = fuseSearch({ query: "", total: lexical.length, hits: lexical }, hits, 5);
                        this.store.audit(identity, operation, "allow");
                        return Response.json({ method: "hybrid", hits: fused.hits.map(({ note, snippet }) => ({ note, snippet })) });
                    }
                }
                this.store.audit(identity, operation, "allow");
                return Response.json(result);
            }
            if (operation === "knowledge.references") {
                const result = await knowledgeReferences(this.config.vault, KnowledgeReferencesRequest.parse(body), options);
                this.store.audit(identity, operation, "allow");
                return Response.json(result);
            }
            const raw = /\/notes\/([^/]+)\/document$/.exec(new URL(request.url).pathname)?.[1];
            const id = Id.parse(decodeURIComponent(raw ?? ""));
            if (operation === "knowledge.document") {
                assertNoteVisible(this.store.db, id);
                const result = await readKnowledgeDocument(this.config.vault, id, options);
                this.store.audit(identity, operation, "allow");
                return Response.json(result);
            }
            const input = KnowledgeUpdateRequest.parse(body);
            const result = await this.update(identity, id, input, now);
            return Response.json(result);
        }
        catch (cause) {
            if (cause instanceof HubError)
                throw cause;
            if (cause instanceof Error && cause.name === "ZodError")
                throw new HubError("INVALID", { key: "editing.invalid", args: [] }, { reason: "invalid-note" });
            if (cause instanceof CoreError) {
                const reason = cause.code.toLowerCase();
                if (["REVISION_CONFLICT", "REQUEST_CONFLICT"].includes(cause.code))
                    throw new HubError("CONFLICT", { key: `editing.${reason}`, args: [] }, { reason });
                if (["NOTE_NOT_EDITABLE", "UNSAFE_NOTE_PATH", "NOTE_NOT_FOUND", "INVALID_FRONTMATTER"].includes(cause.code))
                    throw new HubError("INVALID", { key: "editing.not_editable", args: [] }, { reason: "note_not_editable" });
            }
            throw new HubError("INTERNAL", { key: "editing.uncertain", args: [] }, { reason: "save_uncertain" });
        }
    }
}
