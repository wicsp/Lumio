import type { Database } from "bun:sqlite";
import { AssistantConversation, AssistantMessage, AssistantTurn, AssistantToolCall, AssistantMemory } from "@lumio/schema";
import type { AssistantStore } from "@lumio/assistant";

/** Typed Assistant persistence; indexed ownership and lifecycle fields are committed with validated records. */
export class SqliteAssistantStore implements AssistantStore {
  constructor(private readonly db: Database) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS platform_migrations(name TEXT PRIMARY KEY,applied TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_conversations_owner ON assistant_conversations(owner);
      CREATE TABLE IF NOT EXISTS assistant_turns(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES assistant_conversations(id),
        status TEXT NOT NULL CHECK(status IN ('running','done','failed','unknown','cancelled')),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_turns_conversation ON assistant_turns(conversation);
      CREATE TABLE IF NOT EXISTS assistant_calls(id TEXT PRIMARY KEY,turn TEXT NOT NULL REFERENCES assistant_turns(id),
        status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','unknown')),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS assistant_messages(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES assistant_conversations(id),
        turn TEXT REFERENCES assistant_turns(id),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_messages_conversation ON assistant_messages(conversation);
      CREATE TABLE IF NOT EXISTS assistant_requests(owner TEXT NOT NULL,request TEXT NOT NULL,input TEXT NOT NULL,
        turn TEXT NOT NULL REFERENCES assistant_turns(id),PRIMARY KEY(owner,request));
      CREATE TABLE IF NOT EXISTS assistant_memories(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS assistant_memories_owner ON assistant_memories(owner);
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES('assistant-1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `))();
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
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
  messages(conversation: string): AssistantMessage[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_messages WHERE conversation=? ORDER BY rowid").all(conversation).map((row) => AssistantMessage.parse(JSON.parse(row.record)));
  }
  putMessage(input: AssistantMessage): void {
    const value = AssistantMessage.parse(input);
    this.db.query("INSERT INTO assistant_messages(id,conversation,turn,record) VALUES(?,?,?,?)").run(value.id, value.conversation, value.turn ?? null, JSON.stringify(value));
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
  putCall(input: AssistantToolCall): void {
    const value = AssistantToolCall.parse(input);
    this.db.query("INSERT INTO assistant_calls(id,turn,status,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record")
      .run(value.id, value.turn, value.status, JSON.stringify(value));
  }
  receipt(owner: string, request: string): { input: string; turn: string } | undefined {
    return this.db.query<{ input: string; turn: string }, [string,string]>("SELECT input,turn FROM assistant_requests WHERE owner=? AND request=?").get(owner, request) ?? undefined;
  }
  putReceipt(owner: string, request: string, input: string, turn: string): void {
    this.db.query("INSERT INTO assistant_requests(owner,request,input,turn) VALUES(?,?,?,?)").run(owner, request, input, turn);
  }
  memories(owner: string): AssistantMemory[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM assistant_memories WHERE owner=? ORDER BY rowid").all(owner).map((row) => AssistantMemory.parse(JSON.parse(row.record)));
  }
  putMemory(input: AssistantMemory): void {
    const value = AssistantMemory.parse(input);
    this.db.query("INSERT INTO assistant_memories(id,owner,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(value.id, value.owner, JSON.stringify(value));
  }
}
