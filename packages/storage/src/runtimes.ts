import type { Database } from "bun:sqlite";
import { RuntimeInfo } from "@lumio/schema";
import type { RuntimeRecord, RuntimeRegistryStore } from "@lumio/execution";

/** Reuses the existing runtime table and actor identity reference without rewriting registration history. */
export class SqliteRuntimeRegistry implements RuntimeRegistryStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtimes(actor TEXT PRIMARY KEY REFERENCES actors(id),name TEXT NOT NULL UNIQUE,registration TEXT NOT NULL,last_seen TEXT NOT NULL)`);
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  private read(row: { actor: string; registration: string; last_seen: string } | null): RuntimeRecord | undefined {
    if (!row) return;
    const value = RuntimeInfo.parse({ actor: row.actor, registration: JSON.parse(row.registration), last_seen: row.last_seen, online: false });
    return { actor: value.actor, registration: value.registration, last_seen: value.last_seen };
  }
  byActor(actor: string): RuntimeRecord | undefined { return this.read(this.db.query<{ actor: string; registration: string; last_seen: string }, [string]>("SELECT actor,registration,last_seen FROM runtimes WHERE actor=?").get(actor)); }
  byName(name: string): RuntimeRecord | undefined { return this.read(this.db.query<{ actor: string; registration: string; last_seen: string }, [string]>("SELECT actor,registration,last_seen FROM runtimes WHERE name=?").get(name)); }
  list(): RuntimeRecord[] { return this.db.query<{ actor: string; registration: string; last_seen: string }, []>("SELECT actor,registration,last_seen FROM runtimes ORDER BY name").all().map((row) => this.read(row)!); }
  save(value: RuntimeRecord): void {
    const record = RuntimeInfo.parse({ ...value, online: false });
    this.db.query(`INSERT INTO runtimes(actor,name,registration,last_seen) VALUES(?,?,?,?)
      ON CONFLICT(actor) DO UPDATE SET registration=excluded.registration,last_seen=excluded.last_seen`).run(record.actor, record.registration.name, JSON.stringify(record.registration), record.last_seen);
  }
  touch(actor: string, time: string): boolean { return this.db.query("UPDATE runtimes SET last_seen=? WHERE actor=?").run(time, actor).changes > 0; }
}
