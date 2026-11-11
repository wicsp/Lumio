import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@lumio/foundation";
import { AgentInfo, AgentTokenIssued, JobAccess, type JobSpec, Actor, Proposal, type ProposalOperation, type ProposalStatus, type ActorRole, RuntimeRegistration, RuntimeInfo } from "@lumio/schema";
import { HubError } from "./errors.ts";
import { ExecutionRuntimes } from "@lumio/execution";
import { workSystemActor, SqliteRuntimeRegistry, SqliteExecutionStore } from "@lumio/storage";

export interface Identity { actor: Actor; label: string; job?: string }
export class HubStore {
  proposalCreated: ((proposal: Proposal) => void) | undefined;
  readonly executionStore: SqliteExecutionStore;
  private readonly runtimeRegistry: ExecutionRuntimes;
  private constructor(public readonly db: Database) {
    this.runtimeRegistry = new ExecutionRuntimes(new SqliteRuntimeRegistry(db));
    this.executionStore = new SqliteExecutionStore(db, {
      runtimes: (now) => this.runtimeRegistry.list(now), syncRuntime: (actor, now) => this.runtimeRegistry.sync(actor, now),
    });
  }

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
        CREATE TABLE IF NOT EXISTS agent_tokens (label TEXT PRIMARY KEY REFERENCES tokens(label), kind TEXT NOT NULL,
          job TEXT, lease TEXT, expires TEXT, last_used TEXT);
        CREATE TABLE IF NOT EXISTS agent_activity (actor TEXT PRIMARY KEY REFERENCES actors(id), time TEXT NOT NULL);
        INSERT OR IGNORE INTO agent_tokens(label,kind) SELECT tokens.label,'manual' FROM tokens JOIN actors ON actors.id=tokens.actor_id WHERE actors.role='agent';
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, operation TEXT NOT NULL, reason TEXT NOT NULL,
          author TEXT NOT NULL REFERENCES actors(id), status TEXT NOT NULL, created TEXT NOT NULL, decided TEXT, decided_by TEXT REFERENCES actors(id));
        CREATE TABLE IF NOT EXISTS audit (time TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES actors(id), token_label TEXT NOT NULL,
          operation TEXT NOT NULL, authorization TEXT NOT NULL, proposal_id TEXT, execution_result TEXT);
      `);
      if (!db.query<{ name: string }, []>("PRAGMA table_info(proposals)").all().some(column => column.name === "superseded_by")) db.exec("ALTER TABLE proposals ADD COLUMN superseded_by TEXT REFERENCES proposals(id)");
      return new HubStore(db);
    } catch (cause) { db.close(); throw cause; }
  }

  /** A stable internal agent identity is separate from the conversation owner; it receives no token or human delegation. */
  assistantActor(): Actor { return this.internalAgent("assistant-tools", "assistant"); }

  inboxActor(): Actor { return this.internalAgent("inbox-summary", "inbox"); }

  decisionGateActor(): Actor { return this.internalAgent("decision-gate", "decision-gate"); }

  private internalAgent(purpose: string, name: string): Actor {
    return this.db.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS internal_actors(purpose TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id))");
      const binding = this.db.query<{ actor: string }, [string]>("SELECT actor FROM internal_actors WHERE purpose=?").get(purpose);
      if (binding) {
        const actor = this.actors().find((value) => value.id === binding.actor);
        if (!actor || actor.role !== "agent") throw new HubError("INVALID", { key: "store.invalid_assistant_tool_identity_configuration", args: [] });
        return actor;
      }
      const actor = this.createActor(`${name}-${randomBytes(6).toString("hex")}`, "agent");
      this.db.query("INSERT INTO internal_actors(purpose,actor) VALUES(?,?)").run(purpose, actor.id);
      return actor;
    })();
  }

  /** Stable, tokenless identity for automatic Work hand-backs and migration. */
  workActor(): Actor { return workSystemActor(this.db); }

  createActor(name: string, role: ActorRole): Actor {
    const now = new Date();
    const parsed = Actor.safeParse({ id: newId("act", now, randomBytes), name, role, created: now.toISOString() });
    if (!parsed.success) throw new HubError("INVALID", { key: "store.invalid_actor_name_or_role", args: [] });
    if (this.db.query("SELECT id FROM actors WHERE name=?").get(name)) throw new HubError("CONFLICT", { key: "store.actor_name_already_exists", args: [] });
    const actor = parsed.data;
    this.db.query("INSERT INTO actors VALUES (?, ?, ?, ?)").run(actor.id, actor.name, actor.role, actor.created);
    return actor;
  }

  actors(): Actor[] { return this.db.query("SELECT * FROM actors ORDER BY created, id").all().map((row) => Actor.parse(row)); }

  recoveryIdentity(id: string): Identity {
    const actor = Actor.parse(this.db.query("SELECT * FROM actors WHERE id=?").get(id));
    return { actor, label: "knowledge-recovery" };
  }

  createToken(label: string, actorName: string): string {
    if (!label) throw new HubError("INVALID", { key: "store.token_label_must_not_be_empty", args: [] });
    const row = this.db.query("SELECT * FROM actors WHERE name=?").get(actorName);
    if (!row) throw new HubError("NOT_FOUND", { key: "store.actor_not_found", args: [] });
    if (this.db.query("SELECT label FROM tokens WHERE label=?").get(label)) throw new HubError("CONFLICT", { key: "store.token_label_already_exists", args: [] });
    const actor = Actor.parse(row);
    const token = `lumio_${randomBytes(32).toString("base64url")}`;
    this.db.query("INSERT INTO tokens(label,actor_id,hash,created,revoked) VALUES (?, ?, ?, ?, NULL)")
      .run(label, actor.id, createHash("sha256").update(token).digest("hex"), new Date().toISOString());
    if (actor.role === "agent") this.db.query("INSERT INTO agent_tokens(label,kind) VALUES(?,'manual')").run(label);
    return token;
  }

  private agent(name: string): Actor {
    const actor = this.actors().find(value => value.name === name) ?? this.createActor(name, "agent");
    if (actor.role !== "agent") throw new HubError("CONFLICT", { key: "agents.name_not_agent", args: [] });
    return actor;
  }

  issueAgentToken(name: string, label = `agent-${randomBytes(12).toString("hex")}`): AgentTokenIssued {
    return this.db.transaction(() => {
      const actor = this.agent(name), token = this.createToken(label, actor.name);
      const created = this.tokens().find(value => value.label === label)!.created;
      return AgentTokenIssued.parse({ actor, label, token, created });
    })();
  }

  issueJobAccess(spec: JobSpec, now: Date): JobAccess | undefined {
    if (spec.run.kind !== "agent") return;
    const engine = spec.run.engine;
    return this.db.transaction(() => {
      const runtime = this.runtimes(now).find(value => value.actor === spec.runtime);
      if (!runtime) throw new HubError("NOT_FOUND", { key: "store.actor_not_found", args: [] });
      const actor = this.agent(`${engine}@${runtime.registration.name}`);
      // Delivery may be retried before ack; rotate the credential without retaining plaintext.
      this.db.query("UPDATE tokens SET revoked=? WHERE label IN (SELECT label FROM agent_tokens WHERE job=?) AND revoked IS NULL").run(now.toISOString(), spec.id);
      const label = `job-${randomBytes(16).toString("hex")}`, token = this.createToken(label, actor.name);
      const expires = new Date(now.getTime() + spec.timeout_seconds * 1000).toISOString();
      this.db.query("UPDATE agent_tokens SET kind='job',job=?,lease=?,expires=? WHERE label=?").run(spec.id, spec.lease, expires, label);
      return JobAccess.parse({ job: spec.id, actor: actor.id, token, expires });
    })();
  }

  /** Validate against Execution facts on every use, including immediately after cancellation. */
  private validAgentToken(label: string, now: Date): boolean {
    const meta = this.db.query<{ job: string | null; lease: string | null; expires: string | null }, [string]>("SELECT job,lease,expires FROM agent_tokens WHERE label=?").get(label);
    if (!meta?.job) return true;
    const job = this.executionStore.get(meta.job);
    const valid = !!job && !job.result && ["queued", "assigned", "running"].includes(job.status)
      && job.spec.lease === meta.lease && !this.executionStore.cancelRequested(meta.job) && Date.parse(meta.expires!) > now.getTime();
    if (!valid) this.revokeToken(label);
    return valid;
  }

  agents(now = new Date()): AgentInfo[] {
    return this.actors().filter(actor => actor.role === "agent").map(actor => {
      const tokens = this.tokens().filter(token => token.actor_id === actor.id && !token.revoked && this.validAgentToken(token.label, now)).map(token => {
        const meta = this.db.query<{ kind: "manual" | "job"; job: string | null; last_used: string | null }, [string]>("SELECT kind,job,last_used FROM agent_tokens WHERE label=?").get(token.label);
        return { label: token.label, created: token.created, kind: meta?.kind ?? "manual", job: meta?.job ?? undefined, last_used: meta?.last_used ?? undefined };
      });
      const activity = this.db.query<{ time: string | null }, [string, string]>("SELECT MAX(time) AS time FROM (SELECT time FROM audit WHERE actor_id=? AND authorization='allow' UNION ALL SELECT time FROM agent_activity WHERE actor=?)").get(actor.id, actor.id)?.time;
      return AgentInfo.parse({ actor, tokens, last_activity: activity ?? undefined });
    });
  }

  activity(identity: Identity): void {
    if (identity.actor.role === "agent") this.db.query("INSERT INTO agent_activity(actor,time) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET time=excluded.time").run(identity.actor.id, new Date().toISOString());
  }

  revokeAgent(name: string, label?: string): void {
    const actor = this.actors().find(value => value.name === name && value.role === "agent");
    if (!actor) throw new HubError("NOT_FOUND", { key: "store.actor_not_found", args: [] });
    const tokens = this.tokens().filter(token => token.actor_id === actor.id && (label === undefined || token.label === label));
    if (label !== undefined && !tokens.length) throw new HubError("NOT_FOUND", { key: "store.token_not_found", args: [] });
    for (const token of tokens) this.revokeToken(token.label);
  }

  /** Preserve old token labels for audit while invalidating their credentials. */
  replaceToken(label: string, actorName: string): string {
    return this.db.transaction(() => {
      if (this.tokens().some((token) => token.label === label)) {
        this.revokeToken(label);
        this.db.query("DELETE FROM agent_tokens WHERE label=?").run(label);
        this.db.query("UPDATE tokens SET label=? WHERE label=?").run(`${label}#${newId("act", new Date(), randomBytes)}`, label);
      }
      return this.createToken(label, actorName);
    })();
  }

  tokens() { return this.db.query<{ label: string; actor_id: string; created: string; revoked: string | null }, []>("SELECT label, actor_id, created, revoked FROM tokens ORDER BY created, label").all(); }

  revokeToken(label: string): void {
    const result = this.db.query("UPDATE tokens SET revoked=COALESCE(revoked, ?) WHERE label=?").run(new Date().toISOString(), label);
    if (!result.changes) throw new HubError("NOT_FOUND", { key: "store.token_not_found", args: [] });
  }

  authenticate(header: string | null, now = new Date()): Identity | null {
    const match = /^Bearer (lumio_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) return null;
    const digest = createHash("sha256").update(match[1]!).digest();
    const row = this.db.query<{ label: string; actor_id: string; hash: string; revoked: string | null }, [string]>(
      "SELECT label, actor_id, hash, revoked FROM tokens WHERE hash=?",
    ).get(digest.toString("hex"));
    const stored = row ? Buffer.from(row.hash, "hex") : Buffer.alloc(32);
    const equal = stored.length === digest.length && timingSafeEqual(digest, stored);
    if (!row || !equal || row.revoked !== null || !this.validAgentToken(row.label, now)) return null;
    this.db.query("UPDATE agent_tokens SET last_used=? WHERE label=?").run(now.toISOString(), row.label);
    const actor = Actor.parse(this.db.query("SELECT * FROM actors WHERE id=?").get(row.actor_id));
    const access = this.db.query<{ job: string | null }, [string]>("SELECT job FROM agent_tokens WHERE label=?").get(row.label);
    return { actor, label: row.label, ...(access?.job ? { job: access.job } : {}) };
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
    const row = this.db.query<{ id: string; operation: string; reason: string; author: string; status: string; created: string; decided: string | null; decided_by: string | null; superseded_by: string | null }, [string]>(
      "SELECT * FROM proposals WHERE id=?",
    ).get(id);
    return row ? Proposal.parse({ ...row, operation: JSON.parse(row.operation), decided: row.decided ?? undefined, superseded_by: row.superseded_by ?? undefined, decided_by: row.decided_by ?? undefined }) : undefined;
  }

  createProposal(operation: ProposalOperation, reason: string, author: string): Proposal {
    return this.db.transaction(() => {
      // 内容相同的待批准提议只保留一个（按完整操作比较，与操作种类无关）。
      const duplicate = this.proposals("pending").find((p) => p.author === author && JSON.stringify(p.operation) === JSON.stringify(operation));
      if (duplicate) throw new HubError("CONFLICT", { key: "store.an_identical_proposal_is_already_pending", args: [] }, { ...(operation.op !== "work.command" ? { operation } : {}), proposal: duplicate.id });
      const now = new Date();
      const proposal = Proposal.parse({ id: newId("prop", now, randomBytes), operation, reason, author, status: "pending", created: now.toISOString() });
      this.db.query("INSERT INTO proposals(id,operation,reason,author,status,created) VALUES (?, ?, ?, ?, ?, ?)")
        .run(proposal.id, JSON.stringify(operation), reason, author, proposal.status, proposal.created);
      this.proposalCreated?.(proposal);
      return proposal;
    })();
  }

  withdrawProposal(id: string, identity: Identity, supersededBy?: string): Proposal {
    return this.db.transaction(() => {
      const proposal = this.proposal(id);
      if (!proposal) throw new HubError("NOT_FOUND", { key: "operations.proposal_not_found", args: [] });
      if (identity.actor.role === "runtime" || proposal.author !== identity.actor.id) throw new HubError("FORBIDDEN", { key: "proposal.own_only", args: [] });
      if (proposal.status !== "pending") throw new HubError("CONFLICT", { key: "operations.only_pending_proposals_can_be_decided", args: [] });
      this.db.query("UPDATE proposals SET status='withdrawn',decided=?,decided_by=?,superseded_by=? WHERE id=? AND status='pending'")
        .run(new Date().toISOString(), identity.actor.id, supersededBy ?? null, id);
      this.audit(identity, "approval.proposal.withdraw", "allow", id, supersededBy ? `superseded_by:${supersededBy}` : "withdrawn");
      return this.proposal(id)!;
    })();
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

  registerRuntime(actor: string, registration: RuntimeRegistration, now: Date): RuntimeInfo { return this.runtimeRegistry.register(actor, registration, now); }
  syncRuntime(actor: string, now: Date): void { this.runtimeRegistry.sync(actor, now); }
  runtimes(now: Date): RuntimeInfo[] { return this.runtimeRegistry.list(now); }

  close(): void { this.db.close(); }
}
