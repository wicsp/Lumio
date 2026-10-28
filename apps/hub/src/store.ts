import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@lumio/core";
import { Actor, Proposal, type Operation, type ProposalStatus, type ActorRole, RuntimeRegistration, RuntimeInfo } from "@lumio/schema";
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
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tokens (label TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id), hash TEXT NOT NULL UNIQUE,
          created TEXT NOT NULL, revoked TEXT);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, operation TEXT NOT NULL, reason TEXT NOT NULL,
          author TEXT NOT NULL REFERENCES actors(id), status TEXT NOT NULL, created TEXT NOT NULL, decided TEXT, decided_by TEXT REFERENCES actors(id));
        CREATE TABLE IF NOT EXISTS runtimes (actor TEXT PRIMARY KEY REFERENCES actors(id), name TEXT NOT NULL UNIQUE,
          registration TEXT NOT NULL, last_seen TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL, cancel INTEGER NOT NULL DEFAULT 0);
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

  /** Preserve old token labels for audit while invalidating their credentials. */
  replaceToken(label: string, actorName: string): string {
    return this.db.transaction(() => {
      if (this.tokens().some((token) => token.label === label)) {
        this.revokeToken(label);
        this.db.query("UPDATE tokens SET label=? WHERE label=?").run(`${label}#${newId("act", new Date(), randomBytes)}`, label);
      }
      return this.createToken(label, actorName);
    })();
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

  auditDenied(identity: Identity, operation: string): void {
    this.db.query("INSERT INTO audit VALUES (?, ?, ?, ?, 'deny', NULL, NULL)")
      .run(new Date().toISOString(), identity.actor.id, identity.label, operation);
  }

  proposals(status: ProposalStatus, author?: string): Proposal[] {
    return this.db.query<{ id: string }, [string, string | null, string | null]>(
      "SELECT id FROM proposals WHERE status=? AND (? IS NULL OR author=?) ORDER BY created DESC, id DESC",
    ).all(status, author ?? null, author ?? null).map((row) => this.proposal(row.id)!);
  }

  proposal(id: string): Proposal | undefined {
    const row = this.db.query<{ id: string; operation: string; reason: string; author: string; status: string; created: string; decided: string | null; decided_by: string | null }, [string]>(
      "SELECT * FROM proposals WHERE id=?",
    ).get(id);
    return row ? Proposal.parse({ ...row, operation: JSON.parse(row.operation), decided: row.decided ?? undefined, decided_by: row.decided_by ?? undefined }) : undefined;
  }

  createProposal(operation: Operation, reason: string, author: string): Proposal {
    // 内容相同的待批准提议只保留一个（按完整操作比较，与操作种类无关）。
    const duplicate = this.proposals("pending").find((p) => JSON.stringify(p.operation) === JSON.stringify(operation));
    if (duplicate) throw new HubError("CONFLICT", "已有相同的待批准提议", { operation, proposal: duplicate.id });
    const now = new Date();
    const proposal = Proposal.parse({ id: newId("prop", now, randomBytes), operation, reason, author, status: "pending", created: now.toISOString() });
    this.db.query("INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
      .run(proposal.id, JSON.stringify(operation), reason, author, proposal.status, proposal.created);
    return proposal;
  }

  decideProposal(id: string, status: "accepted" | "rejected", actor: string): Proposal {
    this.db.query("UPDATE proposals SET status=?, decided=?, decided_by=? WHERE id=? AND status='pending'")
      .run(status, new Date().toISOString(), actor, id);
    return this.proposal(id)!;
  }

  audit(identity: Identity, operation: string, authorization: string, proposal?: string, execution?: string): void {
    this.db.query("INSERT INTO audit VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), identity.actor.id, identity.label, operation, authorization, proposal ?? null, execution ?? null);
  }

  registerRuntime(actor: string, registration: RuntimeRegistration, now: Date): RuntimeInfo {
    return this.db.transaction(() => {
      const existing = this.db.query<{ name: string }, [string]>("SELECT name FROM runtimes WHERE actor=?").get(actor);
      if (existing && existing.name !== registration.name) throw new HubError("CONFLICT", "同一执行器身份不能更换名称");
      const named = this.db.query<{ actor: string }, [string]>("SELECT actor FROM runtimes WHERE name=?").get(registration.name);
      if (named && named.actor !== actor) throw new HubError("CONFLICT", "执行器名称已被另一身份使用");
      this.db.query(`INSERT INTO runtimes VALUES (?, ?, ?, ?)
        ON CONFLICT(actor) DO UPDATE SET registration=excluded.registration, last_seen=excluded.last_seen`)
        .run(actor, registration.name, JSON.stringify(registration), now.toISOString());
      return RuntimeInfo.parse({ actor, registration, last_seen: now.toISOString(), online: true });
    })();
  }

  syncRuntime(actor: string, now: Date): void {
    const result = this.db.query("UPDATE runtimes SET last_seen=? WHERE actor=?").run(now.toISOString(), actor);
    if (!result.changes) throw new HubError("NOT_FOUND", "执行器尚未登记");
  }

  runtimes(now: Date): RuntimeInfo[] {
    return this.db.query<{ actor: string; registration: string; last_seen: string }, []>(
      "SELECT actor, registration, last_seen FROM runtimes ORDER BY name",
    ).all().map((row) => RuntimeInfo.parse({ ...row, registration: JSON.parse(row.registration),
      online: now.getTime() - Date.parse(row.last_seen) <= 180_000 }));
  }

  close(): void { this.db.close(); }
}
