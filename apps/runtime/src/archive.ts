import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredArtifact } from "@lumio/schema";
import { newId } from "@lumio/foundation";
import { fileDigest } from "@lumio/storage";
import { iterateRunLog } from "@lumio/storage/logs";
import type { RuntimeConfig } from "./config.ts";
import type { Queue, LocalJob } from "./queue.ts";

/** File receipts are independent of result receipts. Local originals and uncertain deliveries are retained. */
export class RuntimeArchives {
  private retries = new Map<string, { at: number; delay: number }>();
  private warned = false;
  constructor(private readonly config: RuntimeConfig, private readonly queue: Queue,
    private readonly fetcher: typeof fetch, private readonly log: (line: string) => void) {
    queue.db.exec(`CREATE TABLE IF NOT EXISTS archive_scanned(job TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS archive_outbox(id TEXT PRIMARY KEY,job TEXT NOT NULL,path TEXT NOT NULL UNIQUE,
        record TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','confirmed','conflict')));`);
  }
  retryNow() { this.retries.clear(); }
  private async events(job: LocalJob): Promise<string | undefined> {
    const directory = join(this.config.stateDir, "events", job.spec.id);
    let names: string[];
    try { names = await readdir(directory); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; }
    if (names.some((name) => name.endsWith(".active.jsonl"))) throw new Error("trace not sealed");
    const path = join(this.config.stateDir, "logs", `${job.spec.id}.events.jsonl`), temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(this.config.stateDir, "logs"), { recursive: true, mode: 0o700 });
    const file = await open(temporary, "wx", 0o600);
    try {
      for await (const event of iterateRunLog(join(this.config.stateDir, "events"), job.spec.id)) await file.writeFile(JSON.stringify(event) + "\n");
      await file.sync(); await file.close(); await rename(temporary, path); return path;
    } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  private async scan(): Promise<void> {
    for (const job of this.queue.jobs().filter((value) => value.state === "finished")) {
      if (this.queue.db.query("SELECT 1 FROM archive_scanned WHERE job=?").get(job.spec.id)) continue;
      let eventPath: string | undefined, complete = true;
      try { eventPath = await this.events(job); }
      catch { complete = false; if (!this.warned) this.log("一份运行日志尚未完成封存，文件已保留；其他日志继续归档"); this.warned = true; }
      try { for (const [path, media_type] of [[join(this.config.stateDir, "logs", `${job.spec.id}.log`), "text/plain"], [eventPath, "application/vnd.lumio.runlog+jsonl"]] as const) {
        if (!path || !await Bun.file(path).exists() || this.queue.db.query("SELECT 1 FROM archive_outbox WHERE path=?").get(path)) continue;
        const digest = await fileDigest(path), now = new Date(), id = newId("art", now, randomBytes);
        const metadata = StoredArtifact.parse({ id, owner: { module: "execution", id: job.spec.id }, key: `${id}.bin`,
          ...digest, media_type, status: "staged", private: false, created: now.toISOString() });
        this.queue.db.query("INSERT INTO archive_outbox(id,job,path,record,state) VALUES(?,?,?,?,'pending')").run(id, job.spec.id, path, JSON.stringify(metadata));
      }
      if (complete) this.queue.db.query("INSERT OR IGNORE INTO archive_scanned(job) VALUES(?)").run(job.spec.id);
      } catch { if (!this.warned) this.log("一份文件暂时无法登记，原始日志已保留；其他日志继续归档"); this.warned = true; }
    }
  }
  async flush(signal: AbortSignal): Promise<number> {
    try { await this.scan(); } catch { if (!this.warned) this.log("运行日志尚未完成封存，文件保留在执行器，归档稍后重试"); this.warned = true; }
    let next = 60_000;
    const rows = this.queue.db.query<{ id: string; path: string; record: string }, []>("SELECT id,path,record FROM archive_outbox WHERE state='pending' ORDER BY rowid").all();
    for (const row of rows) {
      if (signal.aborted) break;
      const retry = this.retries.get(row.id);
      if (retry && retry.at > Date.now()) { next = Math.min(next, retry.at - Date.now()); continue; }
      try {
        const metadata = StoredArtifact.parse(JSON.parse(row.record));
        const send = (path: string, method: string, body: NonNullable<RequestInit["body"]>) => this.fetcher(`${this.config.url}${path}`, { method, body, redirect: "error",
          headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": method === "POST" ? "application/json" : "application/octet-stream" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
        const stage = await send("/v2/execution/artifacts", "POST", JSON.stringify(metadata));
        if (stage.status === 409) {
          this.queue.db.query("UPDATE archive_outbox SET state='conflict' WHERE id=?").run(row.id);
          this.log(`文件 ${row.id} 登记冲突（409），原始日志已保留，等待人工核查`); continue;
        }
        if (!stage.ok) throw new Error("archive registration failed");
        let result = StoredArtifact.parse(await stage.json());
        if (result.status !== "ready") {
          const upload = await send(`/v2/execution/artifacts/${row.id}`, "PUT", Bun.file(row.path));
          if (!upload.ok) throw new Error("archive upload failed"); result = StoredArtifact.parse(await upload.json());
        }
        if (result.id !== metadata.id || result.status !== "ready" || result.sha256 !== metadata.sha256 || result.size !== metadata.size || result.owner.module !== "execution" || result.owner.id !== metadata.owner.id) throw new Error("archive receipt mismatch");
        this.queue.db.query("UPDATE archive_outbox SET state='confirmed',record=? WHERE id=?").run(JSON.stringify(result), row.id); this.retries.delete(row.id);
      } catch {
        if (signal.aborted) break;
        const delay = Math.min(retry ? retry.delay * 2 : this.config.pollSeconds, 60);
        this.retries.set(row.id, { delay, at: Date.now() + delay * 1000 }); next = Math.min(next, delay * 1000);
      }
    }
    return next;
  }
}
