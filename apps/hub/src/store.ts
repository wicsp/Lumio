import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@lumio/core";
import { Actor, type ActorRole } from "@lumio/schema";
import type { QueryOperation } from "./authorize.ts";
import { HubError } from "./errors.ts";

export interface Identity { actor: Actor; label: string }
export class HubStore {
  private constructor(public readonly db: Database) {}

  static async open(stateDir: string): Promise<HubStore> {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, "hub.sqlite");
    const db = new Database(path, { create: true, strict: true });
    try {
      await chmod(path, 0o600);
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens (label TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), hash TEXT NOT NULL UNIQUE,
          created TEXT NOT NULL, revoked TEXT);
        CREATE TABLE IF NOT EXISTS audit (time TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES actors(id), token_label TEXT NOT NULL,
          operation TEXT NOT NULL, authorization TEXT NOT NULL, proposal_id TEXT, execution_result TEXT);
      `);
      return new HubStore(db);
    } catch (cause) { db.close(); throw cause; }
  }

  createActor(name: string, role: ActorRole): Actor {
    const now = new Date();
    const parsed = Actor.safeParse({ id: newId("act", now, randomBytes), name, role, created: now.toISOString() });
    if (!parsed.success) throw new HubError("INVALID", "身份名称或角色不合法");
    if (this.db.query("SELECT id FROM actors WHERE name=?").get(name)) throw new HubError("CONFLICT", "身份名称已存在");
    const actor = parsed.data;
    this.db.query("INSERT INTO actors VALUES (?, ?, ?, ?)").run(actor.id, actor.name, actor.role, actor.created);
    return actor;
  }

  actors(): Actor[] { return this.db.query("SELECT * FROM actors ORDER BY created, id").all().map((row) => Actor.parse(row)); }

  createToken(label: string, actorName: string): string {
    if (!label) throw new HubError("INVALID", "令牌标签不能为空");
    const row = this.db.query("SELECT * FROM actors WHERE name=?").get(actorName);
    if (!row) throw new HubError("NOT_FOUND", "身份不存在");
    if (this.db.query("SELECT label FROM tokens WHERE label=?").get(label)) throw new HubError("CONFLICT", "令牌标签已存在");
    const actor = Actor.parse(row);
    const token = `lumio_${randomBytes(32).toString("base64url")}`;
    this.db.query("INSERT INTO tokens VALUES (?, ?, ?, ?, NULL)")
      .run(label, actor.id, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
    return token;
  }

  tokens() { return this.db.query<{ label: string; actor_id: string; created: string; revoked: string | null }, []>("SELECT label, actor_id, created, revoked FROM tokens ORDER BY created, label").all(); }

  revokeToken(label: string): void {
    const result = this.db.query("UPDATE tokens SET revoked=COALESCE(revoked, ?) WHERE label=?").run(new Date().toISOString(), label);
    if (!result.changes) throw new HubError("NOT_FOUND", "令牌不存在");
  }

  authenticate(header: string | null): Identity | null {
    const match = /^Bearer (lumio_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) return null;
    const digest = createHash("sha256").update(match[1]!).digest();
    const row = this.db.query<{ label: string; actor_id: string; hash: string; revoked: string | null }, [string]>(
      "SELECT label, actor_id, hash, revoked FROM tokens WHERE hash=?",
    ).get(digest.toString("hex"));
    const stored = row ? Buffer.from(row.hash, "hex") : Buffer.alloc(32);
    const equal = stored.length === digest.length && timingSafeEqual(digest, stored);
    if (!row || !equal || row.revoked !== null) return null;
    const actor = Actor.parse(this.db.query("SELECT * FROM actors WHERE id=?").get(row.actor_id));
    return { actor, label: row.label };
  }

  auditDenied(identity: Identity, operation: QueryOperation): void {
    this.db.query("INSERT INTO audit VALUES (?, ?, ?, ?, 'deny', NULL, NULL)")
      .run(new Date().toISOString(), identity.actor.id, identity.label, operation);
  }

  close(): void { this.db.close(); }
}
