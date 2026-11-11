import type { Database } from "bun:sqlite";
import { AIConnection, AIProfile, NativeSession, NativeEventData, AIQuotaSettings, AIQuotaSnapshot, AIQuotaStatus, type ClaudeQuotaIssue } from "@lumio/schema";

export interface StoredAIQuota {
  settings: AIQuotaSettings;
  generation?: string;
  binding?: string;
  claudeAccount?: string;
  claudeIssue?: ClaudeQuotaIssue;
  snapshot?: AIQuotaSnapshot;
  status?: AIQuotaStatus;
  alerted?: Record<string, string>;
  next?: number;
  failures?: number;
}
/** Additive, private business tables. No credentials in public records or exports. */
export class SqliteAIStore {
  constructor(readonly db: Database) {
    db.exec(`
 CREATE TABLE IF NOT EXISTS ai_connections(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),secret TEXT);
 CREATE TABLE IF NOT EXISTS ai_quota(connection TEXT PRIMARY KEY REFERENCES ai_connections(id) ON DELETE CASCADE,record TEXT NOT NULL CHECK(json_valid(record)));
 CREATE TRIGGER IF NOT EXISTS ai_quota_source_changed AFTER UPDATE ON ai_connections
 WHEN OLD.secret IS NOT NEW.secret OR json_extract(OLD.record,'$.base_url') IS NOT json_extract(NEW.record,'$.base_url')
   OR json_extract(OLD.record,'$.host') IS NOT json_extract(NEW.record,'$.host')
   OR json_extract(OLD.record,'$.kind') IS NOT json_extract(NEW.record,'$.kind')
 BEGIN
   UPDATE ai_quota SET record=json_object('settings',json_extract(record,'$.settings')) WHERE connection=NEW.id;
 END;
 CREATE TABLE IF NOT EXISTS ai_profiles(id TEXT PRIMARY KEY,owner TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)));
 CREATE TABLE IF NOT EXISTS native_sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL UNIQUE,record TEXT NOT NULL CHECK(json_valid(record)),token_hash TEXT,agent TEXT);
 CREATE TABLE IF NOT EXISTS native_events(session TEXT NOT NULL,sequence INTEGER NOT NULL,turn TEXT,record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(session,sequence));
 CREATE TABLE IF NOT EXISTS native_deliveries(session TEXT NOT NULL,turn TEXT NOT NULL UNIQUE,command TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),PRIMARY KEY(session,turn));
 CREATE TABLE IF NOT EXISTS ai_receipts(scope TEXT NOT NULL,request TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,request));
 CREATE TABLE IF NOT EXISTS native_retired_sessions(id TEXT PRIMARY KEY,runtime TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS native_operations(session TEXT NOT NULL,request TEXT NOT NULL,turn TEXT NOT NULL,name TEXT NOT NULL,args TEXT NOT NULL,status TEXT NOT NULL,result TEXT,PRIMARY KEY(session,request));
 `);
  }
  installConversationPurge() {
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS native_conversation_purge AFTER DELETE ON assistant_conversations BEGIN
      INSERT OR IGNORE INTO native_retired_sessions SELECT id,json_extract(record,'$.runtime') FROM native_sessions WHERE conversation=OLD.id;
      DELETE FROM native_events WHERE session IN (SELECT id FROM native_sessions WHERE conversation=OLD.id);
      DELETE FROM native_deliveries WHERE session IN (SELECT id FROM native_sessions WHERE conversation=OLD.id);
      DELETE FROM native_operations WHERE session IN (SELECT id FROM native_sessions WHERE conversation=OLD.id);
      DELETE FROM native_sessions WHERE conversation=OLD.id;
    END`);
  }
  retired(id: string, runtime: string) {
    return !!this.db.query("SELECT 1 FROM native_retired_sessions WHERE id=? AND runtime=?").get(id, runtime);
  }

  connections(owner: string) {
    return this.db
      .query<{ record: string }, [string]>("SELECT record FROM ai_connections WHERE owner=? ORDER BY id")
      .all(owner)
      .map((r) => AIConnection.parse(JSON.parse(r.record)));
  }
  connection(id: string) {
    const r = this.db.query<{ record: string }, [string]>("SELECT record FROM ai_connections WHERE id=?").get(id);
    return r ? AIConnection.parse(JSON.parse(r.record)) : undefined;
  }
  putConnection(v: AIConnection, secret?: string) {
    AIConnection.parse(v);
    this.db
      .query(
        "INSERT INTO ai_connections VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,secret=excluded.secret",
      )
      .run(v.id, v.owner, JSON.stringify(v), secret ?? null);
  }
  deleteConnection(id: string) {
    this.db.query("DELETE FROM ai_connections WHERE id=?").run(id);
  }

  secret(id: string) {
    return (
      this.db.query<{ secret: string | null }, [string]>("SELECT secret FROM ai_connections WHERE id=?").get(id)
        ?.secret ?? undefined
    );
  }
  quota(id: string): StoredAIQuota {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM ai_quota WHERE connection=?").get(id);
    return row ? JSON.parse(row.record) as StoredAIQuota : { settings: { monitor: false, thresholds: {} } };
  }
  putQuota(id: string, value: StoredAIQuota): void {
    this.db.query("INSERT INTO ai_quota VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET record=excluded.record")
      .run(id, JSON.stringify(value));
  }
  quotaConnections(): AIConnection[] {
    return this.db.query<{ record: string }, []>("SELECT ai_connections.record FROM ai_quota JOIN ai_connections ON ai_connections.id=ai_quota.connection")
      .all().map(row => AIConnection.parse(JSON.parse(row.record)));
  }
  profiles(owner: string) {
    return this.db
      .query<{ record: string }, [string]>("SELECT record FROM ai_profiles WHERE owner=? ORDER BY id")
      .all(owner)
      .map((r) => AIProfile.parse(JSON.parse(r.record)));
  }
  profile(id: string) {
    const r = this.db.query<{ record: string }, [string]>("SELECT record FROM ai_profiles WHERE id=?").get(id);
    return r ? AIProfile.parse(JSON.parse(r.record)) : undefined;
  }
  putProfile(v: AIProfile) {
    AIProfile.parse(v);
    this.db
      .query("INSERT INTO ai_profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(v.id, v.owner, JSON.stringify(v));
  }
  deleteProfile(id: string) {
    this.db.query("DELETE FROM ai_profiles WHERE id=?").run(id);
  }

  sessions(owner?: string) {
    const r = owner
      ? this.db.query<{ record: string }, [string]>("SELECT record FROM native_sessions WHERE owner=?").all(owner)
      : this.db.query<{ record: string }, []>("SELECT record FROM native_sessions").all();
    return r.map((v) => NativeSession.parse(JSON.parse(v.record)));
  }
  session(id: string) {
    const r = this.db.query<{ record: string }, [string]>("SELECT record FROM native_sessions WHERE id=?").get(id);
    return r ? NativeSession.parse(JSON.parse(r.record)) : undefined;
  }
  putSession(v: NativeSession) {
    NativeSession.parse(v);
    this.db
      .query(
        "INSERT INTO native_sessions(id,owner,conversation,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(v.id, v.owner, v.conversation, JSON.stringify(v));
  }
  setToken(id: string, hash: string, agent: string) {
    this.db.query("UPDATE native_sessions SET token_hash=?,agent=? WHERE id=?").run(hash, agent, id);
  }
  token(id: string) {
    return this.db
      .query<
        { token_hash: string | null; agent: string | null },
        [string]
      >("SELECT token_hash,agent FROM native_sessions WHERE id=?")
      .get(id);
  }
  invalidate(id: string) {
    this.db.query("UPDATE native_sessions SET token_hash=NULL WHERE id=?").run(id);
  }
  event(session: string, sequence: number, turn: string | undefined, event: NativeEventData) {
    NativeEventData.parse(event);
    return (
      this.db
        .query("INSERT OR IGNORE INTO native_events VALUES(?,?,?,?)")
        .run(session, sequence, turn ?? null, JSON.stringify(event)).changes > 0
    );
  }
  events(session: string, after = 0) {
    return this.db
      .query<{ sequence: number; turn: string | null; record: string }, [string, number]>(
        "SELECT sequence,turn,record FROM native_events WHERE session=? AND sequence>? ORDER BY sequence LIMIT 500",
      )
      .all(session, after)
      .map((r) => ({
        sequence: r.sequence,
        turn: r.turn ?? undefined,
        event: NativeEventData.parse(JSON.parse(r.record)),
      }));
  }
  delivery(session: string, turn: string, command: string, record: unknown) {
    this.db
      .query("INSERT INTO native_deliveries VALUES(?,?,?,'prepared',?)")
      .run(session, turn, command, JSON.stringify(record));
  }
  deliveryState(turn: string, state: string) {
    this.db.query("UPDATE native_deliveries SET state=? WHERE turn=?").run(state, turn);
  }
  deliveries(session: string) {
    return this.db
      .query<
        { turn: string; state: string; record: string },
        [string]
      >("SELECT turn,state,record FROM native_deliveries WHERE session=? ORDER BY rowid")
      .all(session);
  }
  receipt(scope: string, request: string, input: string) {
    const r = this.db
      .query<
        { input: string; result: string },
        [string, string]
      >("SELECT input,result FROM ai_receipts WHERE scope=? AND request=?")
      .get(scope, request);
    return r ? { matches: r.input === input, result: JSON.parse(r.result) as unknown } : undefined;
  }
  putReceipt(scope: string, request: string, input: string, result: unknown) {
    this.db.query("INSERT INTO ai_receipts VALUES(?,?,?,?)").run(scope, request, input, JSON.stringify(result));
  }
}
