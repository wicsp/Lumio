import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { NativeRuntimeMessage, type NativeSession, type NativeRuntimeView, type NativeEventData } from "@lumio/schema";
export interface LocalNative {
    session: NativeSession;
    token: string;
    hub: string;
    view: NativeRuntimeView;
    sequence: number;
    thread?: string;
    turn?: string;
    contextRevision?: string;
    initialized?: boolean;
    pendingCommand?: string;
}
export class NativeLocalStore {
    readonly db: Database;
    constructor(dir: string) { const path = join(dir, "native.sqlite"); this.db = new Database(path, { create: true }); chmodSync(path, 0o600); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(session TEXT NOT NULL,sequence INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session,sequence)); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL);"); }
    get(id: string): LocalNative | undefined { const r = this.db.query<{
        record: string;
    }, [
        string
    ]>("SELECT record FROM sessions WHERE id=?").get(id); return r ? JSON.parse(r.record) : undefined; }
    all() { return this.db.query<{
        record: string;
    }, [
    ]>("SELECT record FROM sessions").all().map(r => JSON.parse(r.record) as LocalNative); }
    put(v: LocalNative) { this.db.query("INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(v.session.id, JSON.stringify(v)); }
    command(id: string, session: string, kind: string) { return this.db.query("INSERT OR IGNORE INTO commands VALUES(?,?,?)").run(id, session, kind).changes > 0; }
    emit(id: string, event: NativeEventData, turn?: string) { return this.db.transaction(() => { const v = this.get(id)!; const sequence = ++v.sequence; const m = NativeRuntimeMessage.parse({ type: "event", session: id, sequence, turn, event }); this.put(v); this.db.query("INSERT INTO events VALUES(?,?,?)").run(id, sequence, JSON.stringify(m)); return m; })(); }
    events() { return this.db.query<{
        record: string;
    }, [
    ]>("SELECT record FROM events ORDER BY session,sequence").all().map(r => NativeRuntimeMessage.parse(JSON.parse(r.record))); }
    ack(id: string, n: number) { this.db.query("DELETE FROM events WHERE session=? AND sequence<=?").run(id, n); }
    close() { this.db.close(); }
}
