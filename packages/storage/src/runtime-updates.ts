import type { Database } from "bun:sqlite";
import { RuntimeUpdateView } from "@lumio/schema";
import type { RuntimeUpdateRecord, RuntimeUpdateStore } from "@lumio/execution";

/** Additive execution configuration; existing runtime registrations and business data are untouched. */
export class SqliteRuntimeUpdates implements RuntimeUpdateStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_updates(actor TEXT PRIMARY KEY REFERENCES actors(id),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS runtime_update_requests(owner TEXT NOT NULL REFERENCES actors(id),request TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,request));`);
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  get(actor: string): RuntimeUpdateRecord | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM runtime_updates WHERE actor=?").get(actor);
    return row ? JSON.parse(row.record) as RuntimeUpdateRecord : undefined;
  }
  put(actor: string, value: RuntimeUpdateRecord): void {
    this.db.query("INSERT INTO runtime_updates(actor,record) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET record=excluded.record").run(actor, JSON.stringify(value));
  }
  receipt(owner: string, request: string) {
    const row = this.db.query<{ fingerprint: string; result: string }, [string, string]>("SELECT fingerprint,result FROM runtime_update_requests WHERE owner=? AND request=?").get(owner, request);
    return row ? { fingerprint: row.fingerprint, result: RuntimeUpdateView.parse(JSON.parse(row.result)) } : undefined;
  }
  saveReceipt(owner: string, request: string, fingerprint: string, result: RuntimeUpdateView): void {
    this.db.query("INSERT INTO runtime_update_requests(owner,request,fingerprint,result) VALUES(?,?,?,?)").run(owner, request, fingerprint, JSON.stringify(result));
  }
}
