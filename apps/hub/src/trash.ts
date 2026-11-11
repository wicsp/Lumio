import {
  TrashItem, TrashListResult, TrashPurgeResult, TrashRestoreResult, TrashResult, TRASH_RETENTION_DAYS, TRASHED_REASON,
  type KnowledgeDeleteRequest, type TrashListArgs,
} from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { KnowledgeTrashFiles, type NoteTrashMove, type SqliteWorkStore, type SqliteAssistantStore } from "@lumio/storage";
import type { WorkService } from "@lumio/work";
import type { AssistantService } from "@lumio/assistant";
import type { HubStore, Identity } from "./store.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { text as msg } from "./messages.ts";

interface TrashModules {
  work: WorkService;
  workStore: SqliteWorkStore;
  assistant: AssistantService;
  assistantStore: SqliteAssistantStore;
  native?: {beforePurge(conversation:string):void};
}

type Change = "delete-note" | "delete-conversation" | "restore" | "purge";
type Result = TrashResult | TrashRestoreResult | TrashPurgeResult;
interface Journal {
  item: TrashItem;
  move: NoteTrashMove;
  companions?: NoteTrashMove[];
  change: Change;
  result: Result;
  actor: string;
  request: string;
  fingerprint: string;
  applied?: boolean;
  system?: boolean;
}

export interface TrashCompanion { path: string; owner: string; original?: true }
interface CaptureTrash {
  companions(entity: string): Promise<TrashCompanion[]>;
  trashed(entity: string, action: "delete-note" | "restore" | "purge", moves: readonly NoteTrashMove[], notePath?: string): void;
}

const missing = () => new HubError("NOT_FOUND", { key: "trash.not_found", args: [] });
const conflict = () => new HubError("CONFLICT", { key: "index.request_id_was_used_for_a_different_operation", args: [] });

export function assertNoteVisible(db: HubStore["db"], id: string): void {
  if (db.query(`SELECT 1 FROM knowledge_trash WHERE id=? UNION ALL
      SELECT 1 FROM knowledge_trash_pending WHERE id=? AND json_extract(record,'$.change')='delete-note'
        AND json_extract(record,'$.applied')=1`).get(id, id)) {
    throw new HubError("NOT_FOUND", { key: "query.note_not_found_candidates_none", args: [] }, { reason: TRASHED_REASON });
  }
}

export class Trash {
  private readonly files?: KnowledgeTrashFiles;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;

  constructor(config: HubConfig, private readonly store: HubStore, private readonly modules: TrashModules,
    private readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>, private readonly now: () => Date,
    private readonly issue: (path: string, message: string) => void, private readonly captures?: CaptureTrash) {
    if (config.vault) this.files = new KnowledgeTrashFiles(config.vault, { stateDir: config.stateDir });
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS trash_requests(actor TEXT NOT NULL,request TEXT NOT NULL,fingerprint TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(actor,request));
      CREATE TABLE IF NOT EXISTS knowledge_trash(id TEXT PRIMARY KEY, path TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS knowledge_trash_companions(id TEXT PRIMARY KEY REFERENCES knowledge_trash(id) ON DELETE CASCADE,
        record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS knowledge_trash_commits(id INTEGER PRIMARY KEY,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS knowledge_trash_pending(id TEXT PRIMARY KEY,actor TEXT NOT NULL,request TEXT NOT NULL,
        record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(actor,request));
    `);
  }

  list(owner: string, args: TrashListArgs): TrashListResult {
    return TrashListResult.parse({ items: this.items(owner)
      .filter(item => !args.kind || item.kind === args.kind)
      .sort((a, b) => Date.parse(b.deleted_at) - Date.parse(a.deleted_at) || a.id.localeCompare(b.id)) });
  }

  private items(owner?: string): TrashItem[] {
    const notes = this.store.db.query<{ record: string }, []>("SELECT record FROM knowledge_trash").all();
    return [...this.modules.workStore.trashed(), ...this.modules.assistantStore.trashed(owner),
      ...notes.map(row => TrashItem.parse(JSON.parse(row.record)))];
  }

  private item(id: string, owner: string, system: boolean): TrashItem | undefined {
    const conversation = this.modules.assistantStore.trash(id);
    if (conversation) return system || conversation.deleted_by === owner ? conversation : undefined;
    const note = this.note(id);
    return this.modules.workStore.trash(id) ?? (note && TrashItem.parse(JSON.parse(note.record)));
  }

  private note(id: string) {
    return this.store.db.query<{ path: string; record: string }, [string]>("SELECT path,record FROM knowledge_trash WHERE id=?").get(id) ?? undefined;
  }

  private replay(actor: string, request: string, fingerprint: string): Result | undefined {
    const row = this.store.db.query<{ fingerprint: string; result: string }, [string, string]>(
      "SELECT fingerprint,result FROM trash_requests WHERE actor=? AND request=?").get(actor, request);
    if (!row) return;
    if (row.fingerprint !== fingerprint) throw conflict();
    return JSON.parse(row.result) as Result;
  }

  private receipt(actor: string, request: string, fingerprint: string, result: Result, identity: Identity, change: Change): void {
    this.store.db.query("INSERT INTO trash_requests VALUES (?,?,?,?)").run(actor, request, fingerprint, JSON.stringify(result));
    const operation = change === "delete-note" ? "knowledge.delete" : change === "delete-conversation" ? "assistant.delete" : `trash.${change}`;
    this.store.audit(identity, operation, "allow", undefined, "applied");
  }

  deleteConversation(id: string, request: string, identity: Identity, knowledgeReferences?: number): TrashResult {
    const actor = identity.actor.id, fingerprint = JSON.stringify(["delete-conversation", id]);
    const { result, applied } = this.store.db.transaction(() => {
      const previous = this.replay(actor, request, fingerprint);
      if (previous) return { result: TrashResult.parse(previous), applied: false };
      this.checkPendingRequest(actor, request);
      const result = TrashResult.parse({ request_id: request, item: this.modules.assistant.trash(id, actor), knowledge_references: knowledgeReferences });
      this.receipt(actor, request, fingerprint, result, identity, "delete-conversation");
      return { result, applied: true };
    })();
    if (applied) this.modules.assistant.abortTrashed(id);
    return result;
  }

  deleteNote(id: string, input: KnowledgeDeleteRequest, identity: Identity): Promise<TrashResult> {
    return this.exclusive(() => this.deleteNoteLocked(id, input, identity));
  }

  async deleteNoteLocked(id: string, input: KnowledgeDeleteRequest, identity: Identity): Promise<TrashResult> {
    return TrashResult.parse(await this.noteChange("delete-note", id, input.request_id, identity, input.expected_revision));
  }

  async change(change: "restore" | "purge", id: string, request: string, identity: Identity, system = false): Promise<TrashRestoreResult | TrashPurgeResult> {
    const actor = identity.actor.id, fingerprint = JSON.stringify([change, id]);
    const previous = this.replay(actor, request, fingerprint);
    if (previous) {
      if (this.files && "kind" in previous && previous.kind === "note") await this.exclusive(() => this.commitNotes());
      return change === "restore" ? TrashRestoreResult.parse(previous) : TrashPurgeResult.parse(previous);
    }
    const item = this.item(id, actor, system);
    if (item?.kind === "note" || this.pending(id)) {
      const result = await this.exclusive(() => this.noteChange(change, id, request, identity, undefined, system));
      return change === "restore" ? TrashRestoreResult.parse(result) : TrashPurgeResult.parse(result);
    }
    if (!item || (system ? !this.expired(item) : change === "restore" && this.expired(item))) throw missing();
    this.checkPendingRequest(actor, request);
    return this.store.db.transaction(() => {
      let reattached_tasks: string[] | undefined;
      if (item.kind === "conversation") {
        if (change === "purge") {this.modules.native?.beforePurge(id);this.modules.assistantStore.purge(id);}
        else this.modules.assistantStore.removeTrash(id);
      } else if (change === "purge") this.modules.workStore.purge(item);
      else reattached_tasks = this.modules.work.restore(item, actor);
      const base = { request_id: request, kind: item.kind, id };
      const result = change === "restore" ? TrashRestoreResult.parse({ ...base, reattached_tasks }) : TrashPurgeResult.parse(base);
      this.receipt(actor, request, fingerprint, result, identity, change);
      return result;
    })();
  }

  private expired(item: TrashItem): boolean { return Date.parse(item.expires_at) <= this.now().getTime(); }

  private pending(id: string): Journal | undefined {
    const row = this.store.db.query<{ record: string }, [string]>("SELECT record FROM knowledge_trash_pending WHERE id=?").get(id);
    return row ? JSON.parse(row.record) as Journal : undefined;
  }

  private checkPendingRequest(actor: string, request: string): void {
    if (this.store.db.query("SELECT 1 FROM knowledge_trash_pending WHERE actor=? AND request=?").get(actor, request)) throw conflict();
  }

  private async noteChange(change: Change, id: string, request: string, identity: Identity, revision?: string, system = false): Promise<Result> {
    const actor = identity.actor.id;
    const fingerprint = JSON.stringify(revision ? [change, id, revision] : [change, id]);
    const previous = this.replay(actor, request, fingerprint);
    if (previous) {
      if (this.files) await this.commitNotes();
      return previous;
    }
    if (!this.files) throw new HubError("INVALID", { key: "server.no_knowledge_directory_configured_work_and_execution_are_available_i", args: [] });
    try {
      const pending = this.pending(id);
      if (pending) {
        if (pending.actor === actor && pending.request === request) {
          if (pending.fingerprint !== fingerprint) throw conflict();
          return await this.finishNote(pending, identity);
        }
        await this.finishNote(pending, this.identity(pending.actor));
      }
      this.checkPendingRequest(actor, request);
      let item: TrashItem, move: NoteTrashMove, result: Result;
      let companions: NoteTrashMove[] = [];
      if (change === "delete-note") {
        assertNoteVisible(this.store.db, id);
        const deletion = await this.files.deletion(id, revision!);
        const now = this.now();
        item = TrashItem.parse({ kind: "note", id, title: deletion.note.title, path: deletion.note.path, deleted_by: actor,
          deleted_at: now.toISOString(), expires_at: new Date(now.getTime() + TRASH_RETENTION_DAYS * 86_400_000).toISOString() });
        move = deletion.move;
        for (const companion of await this.captures?.companions(id) ?? []) {
          companions.push(await this.files.companionDeletion(companion.owner, companion.path, companion.original));
        }
        result = TrashResult.parse({ request_id: request, item });
      } else {
        const note = this.note(id);
        if (!note) throw missing();
        item = TrashItem.parse(JSON.parse(note.record));
        if (system ? !this.expired(item) : change === "restore" && this.expired(item)) throw missing();
        const saved = this.store.db.query<{ record: string }, [string]>("SELECT record FROM knowledge_trash_companions WHERE id=?").get(id);
        const deleted = saved ? JSON.parse(saved.record) as NoteTrashMove[] : [];
        for (const companion of deleted) companions.push(await this.files.companionChange(change as "restore" | "purge", companion));
        const base = { request_id: request, kind: "note", id };
        if (change === "restore") {
          move = await this.files.restoration(id, note.path, item.path!);
          result = TrashRestoreResult.parse({ ...base, path: move.to, renamed: move.to !== item.path });
        } else {
          move = await this.files.removal(id, note.path);
          result = TrashPurgeResult.parse(base);
        }
      }
      const prior = this.replay(actor, request, fingerprint);
      if (prior) return prior;
      const journal: Journal = { item, move, companions, change, result, actor, request, fingerprint, system };
      this.store.db.query("INSERT INTO knowledge_trash_pending VALUES (?,?,?,?)").run(id, actor, request, JSON.stringify(journal));
      return await this.finishNote(journal, identity);
    } catch (cause) {
      if (cause instanceof CoreError) {
        if (cause.code === "REVISION_CONFLICT") throw new HubError("CONFLICT", { key: "trash.note_changed", args: [] });
        if (cause.code === "NOTE_NOT_FOUND") throw new HubError("NOT_FOUND", cause.params);
        if (cause.code === "NOTE_NOT_EDITABLE") throw new HubError("INVALID", { key: "trash.note_not_eligible", args: [] });
        if (["AMBIGUOUS_REFERENCE", "INVALID_FRONTMATTER"].includes(cause.code)) throw new HubError("INVALID", cause.params);
      }
      throw cause;
    }
  }

  private async finishNote(journal: Journal, identity: Identity): Promise<Result> {
    const { item, move, companions = [], actor, request, fingerprint, result, change } = journal;
    const moves = [move, ...companions];
    if (!journal.applied) {
      try {
        for (const entry of change === "restore" ? [...companions, move] : moves) await this.files!.apply(entry);
      }
      catch (cause) {
        if (cause instanceof CoreError && cause.code === "REVISION_CONFLICT" && (await Promise.all(moves.map(entry => this.files!.canAbandon(entry).catch(() => false)))).every(Boolean)) {
          this.store.db.query("DELETE FROM knowledge_trash_pending WHERE id=?").run(item.id);
        }
        throw cause;
      }
      this.store.db.query("UPDATE knowledge_trash_pending SET record=? WHERE id=?").run(JSON.stringify({ ...journal, applied: true }), item.id);
    }
    this.store.db.transaction(() => {
      if (change === "delete-note") {
        this.store.db.query("INSERT INTO knowledge_trash VALUES (?,?,?)").run(item.id, move.to!, JSON.stringify(item));
        if (companions.length) this.store.db.query("INSERT INTO knowledge_trash_companions VALUES (?,?)").run(item.id, JSON.stringify(companions));
      } else {
        this.store.db.query("DELETE FROM knowledge_trash WHERE id=?").run(item.id);
      }
      if (change !== "delete-conversation") this.captures?.trashed(item.id, change, companions, move.to);
      this.receipt(actor, request, fingerprint, result, identity, change);
      this.store.db.query("INSERT INTO knowledge_trash_commits(record) VALUES (?)").run(JSON.stringify({
        move, companions, path: item.path!, actor: journal.system ? undefined : actor,
      }));
      this.store.db.query("DELETE FROM knowledge_trash_pending WHERE id=?").run(item.id);
    })();
    await this.commitNotes();
    return result;
  }

  private async commitNotes(): Promise<void> {
    const commits = this.store.db.query<{ id: number; record: string }, []>("SELECT id,record FROM knowledge_trash_commits ORDER BY id").all();
    for (const commit of commits) {
      const { move, companions = [], actor, path } = JSON.parse(commit.record) as { move: NoteTrashMove; companions?: NoteTrashMove[]; actor?: string; path: string };
      try {
        await this.files!.commit([move, ...companions], actor);
        this.store.db.query("DELETE FROM knowledge_trash_commits WHERE id=?").run(commit.id);
      } catch { this.issue(path, msg("knowledge.commit_failed")); }
    }
  }

  private identity(id: string, label = "trash-recovery"): Identity {
    const actor = this.store.actors().find(actor => actor.id === id) ?? this.store.workActor();
    return { actor, label };
  }

  sweep(): Promise<void> {
    if (!this.sweeping) this.sweeping = this.cleanup().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async cleanup(): Promise<void> {
    if (this.files) await this.exclusive(async () => {
      const pending = this.store.db.query<{ record: string }, []>("SELECT record FROM knowledge_trash_pending").all();
      await this.commitNotes();
      for (const row of pending) {
        const journal = JSON.parse(row.record) as Journal;
        try { await this.finishNote(journal, this.identity(journal.actor)); }
        catch { this.issue(journal.item.path!, msg("trash.recovery_failed")); }
      }
    });
    const identity = this.identity(this.store.workActor().id, "trash-expiry");
    for (const item of this.items().filter(item => this.expired(item))) {
      try { await this.change("purge", item.id, `expiry:${item.id}:${Date.parse(item.deleted_at)}`, identity, true); }
      catch { this.issue(item.path ?? item.id, msg("trash.recovery_failed")); }
    }
  }

  start(): void { this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 60_000); }
  async stop(): Promise<void> { clearInterval(this.timer); await this.sweeping?.catch(() => {}); }
}
