import {
  AgentConcurrencyUpdate, AgentConcurrencyView, PiConcurrencyBackend,
  type AgentConcurrencyTarget, type Job, type NativeSession, type RuntimeInfo,
} from "@lumio/schema";
import { HubError } from "./errors.ts";
import type { Database } from "bun:sqlite";
import type { SqliteAIStore, SqliteExecutionStore, SqliteJobActivity } from "@lumio/storage";
interface Store {
  db: Database;
  aiStore: SqliteAIStore;
  executionStore: SqliteExecutionStore;
  jobActivity: SqliteJobActivity;
  runtimes(now: Date): RuntimeInfo[];
}

type Target = AgentConcurrencyTarget;
type Engine = "codex" | "claude-code" | "pi";
type Account = { engine: Engine; route: string };
const defaults: Record<Engine, number> = { codex: 4, "claude-code": 2, pi: 1 };
const fallback = (engine: Engine): Account => ({ engine, route: "default:" + engine });
const device = (engine: Engine, actor: string, backend?: string): Account =>
  ({ engine, route: `runtime:${actor}:${engine}` + (backend ? ":" + backend : "") });
const verified = (engine: Engine, account: string): Account => ({ engine, route: `account:${engine}:${account}` });

export class AgentConcurrency {
  constructor(private store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS agent_concurrency_routes (route TEXT PRIMARY KEY, group_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_concurrency_limits (scope TEXT PRIMARY KEY, capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_concurrency_holds (job TEXT PRIMARY KEY, scope TEXT NOT NULL);`);
  }

  private connection(owner: string, id: string): Account | undefined {
    const connection = this.store.aiStore.connection(id);
    if (!connection || connection.owner !== owner) return;
    const quota = this.store.aiStore.quota(id);
    if (connection.kind === "codex-account") {
      let binding: unknown;
      try { binding = quota.binding ? JSON.parse(quota.binding) : undefined; } catch { /* Use the conservative default. */ }
      if (Array.isArray(binding) && typeof binding[1] === "string" && /^[a-f0-9]{64}$/.test(binding[1]))
        return verified("codex", binding[1]);
      return { engine: "codex", route: "connection:" + id };
    }
    if (connection.kind === "claude-code-subscription")
      return quota.claudeAccount ? verified("claude-code", quota.claudeAccount) : { engine: "claude-code", route: "connection:" + id };
    if (connection.host === "hub" && ["openai-compatible", "deepseek", "doubao"].includes(connection.kind))
      return { engine: "pi", route: "connection:" + id };
  }

  private assignment(route: string): string | null {
    return this.store.db.query<{ group_name: string }, [string]>(
      "SELECT group_name FROM agent_concurrency_routes WHERE route=?").get(route)?.group_name ?? null;
  }

  private scope(account: Account) {
    const group = this.assignment(account.route);
    if (group) return "group:" + group;
    return account.route.startsWith("account:") ? account.route : fallback(account.engine).route;
  }

  private limit(account: Account): number {
    const scope = this.scope(account);
    return this.store.db.query<{ capacity: number }, [string]>(
      "SELECT capacity FROM agent_concurrency_limits WHERE scope=?").get(scope)?.capacity ?? defaults[account.engine];
  }

  private job(job: Job): Account | undefined {
    const run = job.spec.run;
    if (run.kind !== "agent") return;
    const binding = this.store.jobActivity.account(job.spec.id);
    if (binding) return verified("codex", binding.account);
    if (run.engine === "pi" && run.model?.includes("/")) {
      const backend = PiConcurrencyBackend.safeParse(run.model.split("/")[0]);
      if (backend.success) {
        const route = device("pi", job.spec.runtime, backend.data);
        if (this.assignment(route.route)) return route;
      }
    }
    return device(run.engine, job.spec.runtime);
  }

  private native(session: NativeSession): Account {
    return session.connection_auth ? verified("codex", session.connection_auth.account)
      : this.connection(session.owner, session.connection.id) ?? fallback("codex");
  }

  private available(account: Account): boolean {
    const scope = this.scope(account);
    let count = 0;
    for (const job of this.store.executionStore.list({ open: true })) {
      const active = job.admitted || job.status === "assigned" || job.status === "running";
      if (!active) continue;
      const previous = this.store.db.query<{ scope: string }, [string]>(
        "SELECT scope FROM agent_concurrency_holds WHERE job=?").get(job.spec.id)?.scope;
      const current = this.job(job);
      if (previous === scope || current && this.scope(current) === scope) count++;
    }
    for (const session of this.store.aiStore.sessions()) {
      if (!session.quarantined && !["running", "awaiting_approval"].includes(session.view.state)
        && !this.store.aiStore.deliveries(session.id).some(delivery => delivery.state === "sent")) continue;
      if (this.scope(this.native(session)) === scope) count++;
    }
    return count < this.limit(account);
  }

  admit(job: Job): boolean {
    const account = this.job(job);
    if (!account) return true;
    if (!this.available(account)) return false;
    this.store.db.query("INSERT OR IGNORE INTO agent_concurrency_holds VALUES(?,?)").run(job.spec.id, this.scope(account));
    return true;
  }

  finish(job: string) {
    this.store.db.query("DELETE FROM agent_concurrency_holds WHERE job=?").run(job);
  }

  nativeAvailable(session: NativeSession) { return this.available(this.native(session)); }

  private targets(owner: string): [Target, string, Account][] {
    const rows: [Target, string, Account][] = [];
    for (const engine of ["codex", "claude-code", "pi"] as const) rows.push([{ kind: "default", engine }, engine, fallback(engine)]);
    for (const runtime of this.store.runtimes(new Date())) {
      for (const engine of runtime.registration.engines) {
        const route = device(engine.name, runtime.actor), name = `${engine.name}@${runtime.registration.name}`;
        rows.push([{ kind: "runtime", engine: engine.name, runtime: runtime.actor }, name, route]);
        if (engine.name !== "pi") continue;
        const prefix = route.route + ":";
        const backends = this.store.db.query<{ route: string }, [string]>(
          "SELECT route FROM agent_concurrency_routes WHERE route GLOB ? ORDER BY route").all(prefix + "*");
        for (const row of backends) {
          const backend = row.route.slice(prefix.length);
          rows.push([{ kind: "runtime", engine: "pi", runtime: runtime.actor, backend }, `${name} · ${backend}`, device("pi", runtime.actor, backend)]);
        }
      }
    }
    for (const connection of this.store.aiStore.connections(owner)) {
      const account = this.connection(owner, connection.id);
      if (account) rows.push([{ kind: "connection", connection: connection.id }, connection.name, account]);
    }
    return rows;
  }

  view(owner: string) {
    return AgentConcurrencyView.parse(this.targets(owner).map(([target, name, account]) => ({
      target, name, group: this.assignment(account.route), max_concurrent: this.limit(account),
      uses_default: this.scope(account) === fallback(account.engine).route,
    })));
  }

  update(owner: string, raw: unknown) {
    const input = AgentConcurrencyUpdate.safeParse(raw);
    if (!input.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
    const { target, group, max_concurrent: limit } = input.data;
    const targets = this.targets(owner);
    const match = (value: Target) => targets.find(([candidate]) => JSON.stringify(candidate) === JSON.stringify(value))?.[2];
    const account = target.kind === "runtime" && target.backend !== undefined
      ? target.engine === "pi" && match({ kind: "runtime", engine: "pi", runtime: target.runtime }) && device("pi", target.runtime, target.backend)
      : match(target);
    if (!account || target.kind === "default" && group) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
    return this.store.db.transaction(() => {
      if (group) {
        this.store.db.query(`INSERT INTO agent_concurrency_routes VALUES(?,?)
          ON CONFLICT(route) DO UPDATE SET group_name=excluded.group_name`).run(account.route, group);
        if (limit === null) this.store.db.query("INSERT OR IGNORE INTO agent_concurrency_limits VALUES(?,?)").run("group:" + group, defaults[account.engine]);
      } else this.store.db.query("DELETE FROM agent_concurrency_routes WHERE route=?").run(account.route);
      const scope = this.scope(account);
      const canSet = target.kind === "default" || scope !== fallback(account.engine).route;
      if (limit !== null && canSet) this.store.db.query(`INSERT INTO agent_concurrency_limits VALUES(?,?)
        ON CONFLICT(scope) DO UPDATE SET capacity=excluded.capacity`).run(scope, limit);
      else if (!group && (target.kind === "default" || account.route.startsWith("account:")))
        this.store.db.query("DELETE FROM agent_concurrency_limits WHERE scope=?").run(scope);
      return this.view(owner);
    })();
  }
}
