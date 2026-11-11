import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { AssistantConversation, AssistantMessage, AssistantTurn, AssistantToolCall, AssistantMemory, AssistantMemoryCommandResult, AssistantModelRequest, ResourceRef, TrashItem, Timestamp, idOf } from "@lumio/schema";
import { ASSISTANT_FRAGMENT_MAX_ATTEMPTS, AssistantError, type AssistantFragment, type AssistantFragmentSource, type AssistantStore } from "@lumio/assistant";
import { StorageError } from "./errors.ts";

const conversationAnchors = `
  SELECT id FROM assistant_conversations WHERE id=$id
  UNION ALL SELECT id FROM assistant_messages WHERE conversation=$id
  UNION ALL SELECT id FROM assistant_turns WHERE conversation=$id
  UNION ALL SELECT id FROM assistant_calls WHERE turn IN (SELECT id FROM assistant_turns WHERE conversation=$id)
`;

interface FragmentRow {
  conversation: string;
  first_message: string;
  last_message: string;
  anchors: string;
  attempts: number;
  summary: string | null;
}

function fragmentFromRow(row: FragmentRow): AssistantFragment {
  return {
    conversation: row.conversation, firstMessage: row.first_message, lastMessage: row.last_message,
    anchors: ResourceRef.array().parse(JSON.parse(row.anchors)), attempts: row.attempts, summary: row.summary ?? undefined,
  };
}

/** Typed Assistant persistence; indexed ownership and lifecycle fields are committed with validated records. */
export class SqliteAssistantStore implements AssistantStore {
  constructor(private readonly db: Database) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS platform_migrations(name TEXT PRIMARY KEY,applied TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS assistant_trash(id TEXT PRIMARY KEY REFERENCES assistant_conversations(id),owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS assistant_purged_anchors(id TEXT PRIMARY KEY,owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_purged_requests(owner TEXT NOT NULL,request TEXT NOT NULL,PRIMARY KEY(owner,request));
      CREATE INDEX IF NOT EXISTS assistant_conversations_owner ON assistant_conversations(owner);
      CREATE TABLE IF NOT EXISTS assistant_turns(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES assistant_conversations(id),
        status TEXT NOT NULL CHECK(status IN ('running','done','failed','unknown','cancelled')),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_turns_conversation ON assistant_turns(conversation);
      CREATE TABLE IF NOT EXISTS assistant_calls(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES assistant_turns(id),
        status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','unknown')),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS assistant_messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES assistant_conversations(id),
        turn TEXT REFERENCES assistant_turns(id),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_messages_conversation ON assistant_messages(conversation);
      CREATE TABLE IF NOT EXISTS assistant_message_anchors(
        message TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position>=0),
        resource TEXT NOT NULL CHECK(json_valid(resource)),
        PRIMARY KEY(message,position)
      );
      CREATE TABLE IF NOT EXISTS assistant_fragments(
        conversation TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
        first_message TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
        last_message TEXT NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
        anchors TEXT NOT NULL CHECK(json_valid(anchors)),
        retry_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        PRIMARY KEY(first_message,last_message)
      );
      CREATE INDEX IF NOT EXISTS assistant_fragments_conversation ON assistant_fragments(conversation);
      CREATE INDEX IF NOT EXISTS assistant_fragments_pending ON assistant_fragments(retry_at) WHERE summary IS NULL;
      CREATE TABLE IF NOT EXISTS assistant_fragment_requests(
        first_message TEXT NOT NULL,
        last_message TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        request TEXT NOT NULL CHECK(json_valid(request)),
        created TEXT NOT NULL,
        tool_actor TEXT NOT NULL,
        PRIMARY KEY(first_message,last_message,attempt),
        FOREIGN KEY(first_message,last_message) REFERENCES assistant_fragments(first_message,last_message) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES('assistant-4',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      CREATE TABLE IF NOT EXISTS assistant_requests(owner TEXT NOT NULL,request TEXT NOT NULL,input TEXT NOT NULL,
        turn TEXT NOT NULL REFERENCES assistant_turns(id),PRIMARY KEY(owner,request));
      CREATE TABLE IF NOT EXISTS assistant_memories(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_memories_owner ON assistant_memories(owner);
      CREATE TABLE IF NOT EXISTS assistant_contexts(turn TEXT NOT NULL REFERENCES assistant_turns(id),step INTEGER NOT NULL CHECK(step>=0),
        request TEXT NOT NULL CHECK(json_valid(request)),created TEXT NOT NULL,tool_actor TEXT,PRIMARY KEY(turn,step));
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES('assistant-3',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      CREATE TABLE IF NOT EXISTS assistant_model_states(message TEXT PRIMARY KEY,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS assistant_memory_requests(owner TEXT NOT NULL,request TEXT NOT NULL,operation_hash TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(owner,request));
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES('assistant-2',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES('assistant-1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `))();
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  putModelState(message:string,state:NonNullable<import("@lumio/schema").AssistantModelResponse["continuation"]>):void {this.db.query("INSERT INTO assistant_model_states VALUES(?,?)").run(message,JSON.stringify(state));}
  memory(id: string): AssistantMemory | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_memories WHERE id=?").get(id);
    return row ? AssistantMemory.parse(JSON.parse(row.record)) : undefined;
  }
  modelState(message:string):import("@lumio/schema").AssistantModelResponse["continuation"] {const r=this.db.query<{record:string},[string]>("SELECT record FROM assistant_model_states WHERE message=?").get(message);return r?JSON.parse(r.record):undefined;}
  trash(id: string): TrashItem | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_trash WHERE id=?").get(id);
    return row ? TrashItem.parse(JSON.parse(row.record)) : undefined;
  }
  trashed(owner?: string): TrashItem[] {
    const rows = owner === undefined ? this.db.query<{ record: string }, []>("SELECT record FROM assistant_trash").all()
      : this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_trash WHERE owner=?").all(owner);
    return rows.map(row => TrashItem.parse(JSON.parse(row.record)));
  }
  putTrash(item: TrashItem): void {
    this.db.query("INSERT INTO assistant_trash VALUES (?,?,?)").run(item.id, item.deleted_by, JSON.stringify(TrashItem.parse(item)));
  }
  removeTrash(id: string): void { this.db.query("DELETE FROM assistant_trash WHERE id=?").run(id); }
  purgedAnchorOwner(id: string): string | undefined {
    return this.db.query<{ owner: string }, [string]>("SELECT owner FROM assistant_purged_anchors WHERE id=?").get(id)?.owner;
  }
  anchorIds(id: string): string[] {
    return this.db.query<{ id: string }, { id: string }>(conversationAnchors).all({ id }).map(row => row.id);
  }
  userMessage(conversation: string, turn: string): AssistantMessage | undefined {
    const row = this.db.query<{ record: string }, [string, string]>(`
      SELECT record FROM assistant_messages WHERE conversation=? AND turn=? AND json_extract(record,'$.role')='user' LIMIT 1
    `).get(conversation, turn);
    return row ? AssistantMessage.parse(JSON.parse(row.record)) : undefined;
  }
  purge(id: string): void {
    // Retain only the owner and IDs needed to distinguish broken anchors from inaccessible ones.
    this.db.query(`INSERT OR IGNORE INTO assistant_purged_anchors
      SELECT anchors.id, conversation.owner FROM assistant_conversations AS conversation JOIN (${conversationAnchors}) AS anchors WHERE conversation.id=$id`).run({ id });
    this.db.query(`INSERT OR IGNORE INTO assistant_purged_requests SELECT owner,request FROM assistant_requests
      WHERE turn IN (SELECT id FROM assistant_turns WHERE conversation=?)`).run(id);
    for (const table of ["assistant_requests", "assistant_calls", "assistant_contexts"]) {
      this.db.query(`DELETE FROM ${table} WHERE turn IN (SELECT id FROM assistant_turns WHERE conversation=?)`).run(id);
    }
    this.db.query("DELETE FROM assistant_model_states WHERE message IN (SELECT id FROM assistant_messages WHERE conversation=?)").run(id);
    this.db.query("DELETE FROM assistant_messages WHERE conversation=?").run(id);
    this.db.query("DELETE FROM assistant_turns WHERE conversation=?").run(id);
    this.removeTrash(id);
    this.db.query("DELETE FROM assistant_conversations WHERE id=?").run(id);
  }
  conversation(id: string): AssistantConversation | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_conversations WHERE id=?").get(id);
    return row ? AssistantConversation.parse(JSON.parse(row.record)) : undefined;
  }
  conversations(owner: string): AssistantConversation[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_conversations WHERE owner=? ORDER BY rowid").all(owner).map((row) => AssistantConversation.parse(JSON.parse(row.record)));
  }
  putConversation(input: AssistantConversation): void {
    const value = AssistantConversation.parse(input);
    this.db.query("INSERT INTO assistant_conversations(id,owner,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,record=excluded.record")
      .run(value.id, value.owner, JSON.stringify(value));
  }
  message(id: string): AssistantMessage | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_messages WHERE id=?").get(id);
    return row ? AssistantMessage.parse(JSON.parse(row.record)) : undefined;
  }
  messages(conversation: string): AssistantMessage[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_messages WHERE conversation=? ORDER BY rowid").all(conversation).map((row) => AssistantMessage.parse(JSON.parse(row.record)));
  }
  putMessage(input: AssistantMessage): void {
    const value = AssistantMessage.parse(input);
    this.db.query("INSERT INTO assistant_messages(id,conversation,turn,record) VALUES(?,?,?,?)").run(value.id, value.conversation, value.turn ?? null, JSON.stringify(value));
  }
  messageAnchors(conversation: string): ReadonlyMap<string, readonly ResourceRef[]> {
    const result = new Map<string, ResourceRef[]>();
    const rows = this.db.query<{ message: string; resource: string }, [string]>(`
      SELECT anchor.message,anchor.resource FROM assistant_messages AS message
      JOIN assistant_message_anchors AS anchor ON anchor.message=message.id
      WHERE message.conversation=? ORDER BY message.rowid,anchor.position
    `).all(conversation);
    for (const row of rows) {
      const refs = result.get(row.message) ?? [];
      refs.push(ResourceRef.parse(JSON.parse(row.resource)));
      result.set(row.message, refs);
    }
    return result;
  }
  putMessageAnchors(message: string, anchors: readonly ResourceRef[]): void {
    if (!anchors.length) return;
    this.db.transaction(() => {
      const query = this.db.query("INSERT INTO assistant_message_anchors(message,position,resource) VALUES(?,?,?)");
      anchors.forEach((ref, index) => query.run(message, index, JSON.stringify(ResourceRef.parse(ref))));
    })();
  }
  enqueueFragment(source: AssistantFragmentSource, now: string): void {
    this.db.query(`
      INSERT INTO assistant_fragments(conversation,first_message,last_message,anchors,retry_at)
      SELECT conversation,?,?,?,? FROM assistant_messages AS first
      WHERE first.id=? AND first.conversation=?
        AND EXISTS (SELECT 1 FROM assistant_messages AS last WHERE last.id=? AND last.conversation=first.conversation AND last.rowid>=first.rowid)
      ON CONFLICT(first_message,last_message) DO NOTHING
    `).run(source.firstMessage, source.lastMessage, JSON.stringify(ResourceRef.array().parse(source.anchors)), Timestamp.parse(now),
      source.firstMessage, source.conversation, source.lastMessage);
  }
  recentFragments(conversation: string, anchors: readonly ResourceRef[]): AssistantFragment[] {
    if (!anchors.length) return [];
    return this.db.query<FragmentRow, [string, string]>(`
      SELECT fragment.* FROM assistant_fragments AS fragment
      JOIN assistant_messages AS last ON last.id=fragment.last_message
      WHERE fragment.conversation=? AND fragment.summary IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(fragment.anchors) WHERE json_extract(value,'$.id') IN (SELECT value FROM json_each(?)))
      ORDER BY last.rowid DESC LIMIT 24
    `).all(conversation, JSON.stringify(anchors.map(ref => ref.id))).map(fragmentFromRow);
  }
  nextFragment(now: string): AssistantFragment | undefined {
    const row = this.db.query<FragmentRow, [string, number]>(`
      SELECT fragment.* FROM assistant_fragments AS fragment
      WHERE fragment.summary IS NULL AND fragment.retry_at<=? AND fragment.attempts<?
        AND NOT EXISTS (SELECT 1 FROM assistant_trash WHERE id=fragment.conversation)
      ORDER BY fragment.retry_at,fragment.rowid LIMIT 1
    `).get(Timestamp.parse(now), ASSISTANT_FRAGMENT_MAX_ATTEMPTS);
    return row ? fragmentFromRow(row) : undefined;
  }
  deferFragment(fragment: AssistantFragment, retryAt: string): void {
    this.db.query(`
      UPDATE assistant_fragments SET retry_at=?
      WHERE first_message=? AND last_message=? AND attempts=? AND summary IS NULL AND retry_at<? AND attempts<?
    `).run(Timestamp.parse(retryAt), fragment.firstMessage, fragment.lastMessage, fragment.attempts, retryAt, ASSISTANT_FRAGMENT_MAX_ATTEMPTS);
  }
  startFragment(fragment: AssistantFragment, request: AssistantModelRequest, actor: string, now: string, retryAt: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.query(`
        UPDATE assistant_fragments SET attempts=attempts+1,retry_at=?
        WHERE first_message=? AND last_message=? AND attempts=? AND summary IS NULL AND retry_at<=? AND attempts<?
          AND NOT EXISTS (SELECT 1 FROM assistant_trash WHERE id=assistant_fragments.conversation)
      `).run(Timestamp.parse(retryAt), fragment.firstMessage, fragment.lastMessage, fragment.attempts, Timestamp.parse(now), ASSISTANT_FRAGMENT_MAX_ATTEMPTS);
      if (!result.changes) return false;
      this.db.query(`
        INSERT INTO assistant_fragment_requests(first_message,last_message,attempt,request,created,tool_actor)
        VALUES(?,?,?,?,?,?)
      `).run(fragment.firstMessage, fragment.lastMessage, fragment.attempts + 1, JSON.stringify(AssistantModelRequest.parse(request)), now, idOf("act").parse(actor));
      return true;
    })();
  }
  finishFragment(fragment: AssistantFragment, summary: string): void {
    this.db.query(`
      UPDATE assistant_fragments SET summary=?
      WHERE first_message=? AND last_message=? AND attempts=? AND summary IS NULL
        AND NOT EXISTS (SELECT 1 FROM assistant_trash WHERE id=assistant_fragments.conversation)
    `).run(summary, fragment.firstMessage, fragment.lastMessage, fragment.attempts + 1);
  }
  turn(id: string): AssistantTurn | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_turns WHERE id=?").get(id);
    return row ? AssistantTurn.parse(JSON.parse(row.record)) : undefined;
  }
  turns(conversation?: string): AssistantTurn[] {
    const rows = conversation === undefined ? this.db.query<{ record: string }, []>("SELECT record FROM assistant_turns ORDER BY rowid").all()
      : this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_turns WHERE conversation=? ORDER BY rowid").all(conversation);
    return rows.map((row) => AssistantTurn.parse(JSON.parse(row.record)));
  }
  putTurn(input: AssistantTurn): void {
    const value = AssistantTurn.parse(input);
    this.db.query("INSERT INTO assistant_turns(id,conversation,status,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record")
      .run(value.id, value.conversation, value.status, JSON.stringify(value));
  }
  calls(turn: string): AssistantToolCall[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_calls WHERE turn=? ORDER BY rowid").all(turn).map((row) => AssistantToolCall.parse(JSON.parse(row.record)));
  }
  call(id: string): AssistantToolCall | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_calls WHERE id=?").get(id);
    return row ? AssistantToolCall.parse(JSON.parse(row.record)) : undefined;
  }
  putCall(input: AssistantToolCall): void {
    const value = AssistantToolCall.parse(input);
    this.db.query("INSERT INTO assistant_calls(id,turn,status,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record")
      .run(value.id, value.turn, value.status, JSON.stringify(value));
  }
  receipt(owner: string, request: string): { input: string; turn: string } | undefined {
    if (this.db.query("SELECT 1 FROM assistant_purged_requests WHERE owner=? AND request=?").get(owner, request)) {
      throw new AssistantError("NOT_FOUND", { key: "index.conversation_not_found", args: [] });
    }
    return this.db.query<{ input: string; turn: string }, [string,string]>("SELECT input,turn FROM assistant_requests WHERE owner=? AND request=?").get(owner, request) ?? undefined;
  }
  putReceipt(owner: string, request: string, input: string, turn: string): void {
    this.db.query("INSERT INTO assistant_requests(owner,request,input,turn) VALUES(?,?,?,?)").run(owner, request, input, turn);
  }
  putContext(turn: string, step: number, input: AssistantModelRequest, created: string, toolActor?: string): void {
    if (!Number.isSafeInteger(step) || step < 0) throw new StorageError("INVALID", { key: "assistant.invalid_model_request_sequence_number", args: [] });
    this.db.query("INSERT INTO assistant_contexts(turn,step,request,created,tool_actor) VALUES(?,?,?,?,?)")
      .run(idOf("turn").parse(turn), step, JSON.stringify(AssistantModelRequest.parse(input)), Timestamp.parse(created), toolActor === undefined ? null : idOf("act").parse(toolActor));
  }
  memories(owner: string): AssistantMemory[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_memories WHERE owner=? ORDER BY rowid").all(owner).map((row) => AssistantMemory.parse(JSON.parse(row.record)));
  }
  putMemory(input: AssistantMemory): void {
    const value = AssistantMemory.parse(input);
    this.db.query("INSERT INTO assistant_memories(id,owner,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(value.id, value.owner, JSON.stringify(value));
  }
  memoryReceipt(owner: string, request: string, operation: string): { matches: boolean; result: AssistantMemoryCommandResult } | undefined {
    const row = this.db.query<{ operation_hash: string; result: string }, [string, string]>("SELECT operation_hash,result FROM assistant_memory_requests WHERE owner=? AND request=?").get(owner, request);
    return row ? { matches: row.operation_hash === createHash("sha256").update(operation).digest("hex"), result: AssistantMemoryCommandResult.parse(JSON.parse(row.result)) } : undefined;
  }
  putMemoryReceipt(owner: string, request: string, operation: string, result: AssistantMemoryCommandResult): void {
    this.db.query("INSERT INTO assistant_memory_requests(owner,request,operation_hash,result) VALUES(?,?,?,?)")
      .run(owner, request, createHash("sha256").update(operation).digest("hex"), JSON.stringify(AssistantMemoryCommandResult.parse(result)));
  }
  removeMemory(owner: string, id: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM assistant_memories WHERE owner=? AND id=?").run(owner, id);
      const result = AssistantMemoryCommandResult.parse({ kind: "forgotten", memory: id });
      this.db.query("UPDATE assistant_memory_requests SET result=? WHERE owner=? AND json_extract(result,'$.kind')='memory' AND json_extract(result,'$.memory.id')=?")
        .run(JSON.stringify(result), owner, id);
    })();
  }

}
