import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { lstat, mkdir, open, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { RunLogEvent, StoredArtifact, SafeRelativePath, type ResourceRef } from "@lumio/schema";
import { StorageError } from "./errors.ts";
import { validateArchivedRunLog } from "./logs.ts";

/** Refuse symlinks in every component before reading a managed or backup file. */
export async function safeStoredFile(root: string, key: string): Promise<string> {
  if (!SafeRelativePath.safeParse(key).success) throw new StorageError("INVALID", { key: "artifacts.invalid_file_path", args: [] });
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new StorageError("CORRUPT", { key: "artifacts.storage_root_must_be_a_real_directory", args: [] });
  let path = root;
  for (const [index, part] of key.split("/").entries()) {
    path = join(path, part); const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index < key.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new StorageError("CORRUPT", { key: "artifacts.managed_files_cannot_be_accessed_through_symbolic_links_or_special_f", args: [] });
  }
  return path;
}
export async function fileDigest(path: string): Promise<{ sha256: string; size: number }> {
  const digest = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path)) { digest.update(chunk); size += chunk.length; }
  return { sha256: digest.digest("hex"), size };
}
export const RUN_LOG_MEDIA_TYPE = "application/vnd.lumio.runlog+jsonl";

/** 日志事件 ID 在已归档运行日志中的位置（ADR 0053）：派生数据，可由归档文件重建。 */
export interface RunEventLocation { event: string; run: string; artifact: StoredArtifact; type: string; time: string }

export class SqliteArtifacts {
  private readonly pending = new Map<string, Promise<StoredArtifact>>();
  constructor(private readonly db: Database, readonly root: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS storage_artifacts (id TEXT PRIMARY KEY, owner_module TEXT NOT NULL, owner_id TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('staged','ready')), record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS storage_artifacts_owner ON storage_artifacts(owner_module,owner_id,status);
      CREATE TABLE IF NOT EXISTS storage_run_events (event TEXT PRIMARY KEY, artifact TEXT NOT NULL, run TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_run_events_indexed (artifact TEXT PRIMARY KEY);`);
  }
  /**
   * 按日志事件 ID 找到它所在的运行与归档文件。每份已归档的运行日志只扫描一次，结果存进派生表；
   * 之后的查询直接命中索引（ADR 0053）。文件缺失或校验失败的归档不建索引，下次再试。
   */
  async runEvent(event: string): Promise<RunEventLocation | undefined> {
    const lookup = () => this.db.query<{ run: string; artifact: string; type: string; time: string; record: string }, [string]>(
      `SELECT e.run, e.artifact, e.type, e.time, a.record FROM storage_run_events e JOIN storage_artifacts a ON a.id=e.artifact
       WHERE e.event=? AND a.status='ready'`).get(event);
    let row = lookup();
    if (!row) { await this.indexRunEvents(); row = lookup(); }
    return row ? { event, run: row.run, artifact: StoredArtifact.parse(JSON.parse(row.record)), type: row.type, time: row.time } : undefined;
  }
  private async indexRunEvents(): Promise<void> {
    const pending = this.db.query<{ record: string }, [string]>(
      `SELECT record FROM storage_artifacts WHERE status='ready' AND json_extract(record,'$.media_type')=?
       AND id NOT IN (SELECT artifact FROM storage_run_events_indexed) ORDER BY rowid`).all(RUN_LOG_MEDIA_TYPE)
      .map(row => StoredArtifact.parse(JSON.parse(row.record)));
    for (const artifact of pending) {
      let path: string;
      try { path = await this.path(artifact.id); } catch { continue; }
      const events: RunLogEvent[] = [];
      const stream = createReadStream(path), lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { continue; }
          const parsed = RunLogEvent.safeParse(raw);
          if (parsed.success && parsed.data.run === artifact.owner.id) events.push(parsed.data);
        }
      } finally { lines.close(); stream.destroy(); }
      this.db.transaction(() => {
        const insert = this.db.query("INSERT OR IGNORE INTO storage_run_events(event,artifact,run,type,time) VALUES(?,?,?,?,?)");
        for (const value of events) insert.run(value.id, artifact.id, value.run, value.type, value.time);
        this.db.query("INSERT OR IGNORE INTO storage_run_events_indexed(artifact) VALUES(?)").run(artifact.id);
      })();
    }
  }
  get(id: string): StoredArtifact {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM storage_artifacts WHERE id=?").get(id);
    if (!row) throw new StorageError("NOT_FOUND", { key: "artifacts.managed_file_not_found", args: [] });
    return StoredArtifact.parse(JSON.parse(row.record));
  }
  list(owner?: ResourceRef): StoredArtifact[] {
    const rows = owner ? this.db.query<{ record: string }, [string, string]>("SELECT record FROM storage_artifacts WHERE owner_module=? AND owner_id=? ORDER BY rowid").all(owner.module, owner.id)
      : this.db.query<{ record: string }, []>("SELECT record FROM storage_artifacts ORDER BY rowid").all();
    return rows.map((row) => StoredArtifact.parse(JSON.parse(row.record)));
  }
  stage(input: unknown): StoredArtifact {
    const parsed = StoredArtifact.safeParse(input);
    if (!parsed.success || parsed.data.status !== "staged" || parsed.data.key !== `${parsed.data.id}.bin`) throw new StorageError("INVALID", { key: "artifacts.invalid_file_registration_format_or_storage_key", args: [] });
    const value = parsed.data;
    return this.db.transaction(() => {
      const row = this.db.query<{ record: string }, [string]>("SELECT record FROM storage_artifacts WHERE id=?").get(value.id);
      if (row) {
        const prior = StoredArtifact.parse(JSON.parse(row.record));
        if (JSON.stringify({ ...prior, status: "staged" }) !== JSON.stringify(value)) throw new StorageError("CONFLICT", { key: "artifacts.file_id_already_has_different_registration_content", args: [] });
        return prior;
      }
      this.db.query("INSERT INTO storage_artifacts(id,owner_module,owner_id,key,status,record) VALUES(?,?,?,?,?,?)").run(value.id, value.owner.module, value.owner.id, value.key, value.status, JSON.stringify(value));
      return value;
    })();
  }
  async path(id: string): Promise<string> {
    const value = this.get(id);
    if (value.status !== "ready") throw new StorageError("CONFLICT", { key: "artifacts.file_is_not_fully_archived", args: [] });
    const path = await safeStoredFile(this.root, value.key), digest = await fileDigest(path);
    if (digest.sha256 !== value.sha256 || digest.size !== value.size) throw new StorageError("CORRUPT", { key: "artifacts.managed_file_verification_failed", args: [] });
    return path;
  }
  private async validate(path: string, value: StoredArtifact): Promise<void> {
    if (value.media_type === RUN_LOG_MEDIA_TYPE) await validateArchivedRunLog(path, value.owner.id);
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }
  private ready(value: StoredArtifact): StoredArtifact {
    const result = StoredArtifact.parse({ ...value, status: "ready" });
    this.db.query("UPDATE storage_artifacts SET status='ready',record=? WHERE id=?").run(JSON.stringify(result), result.id); return result;
  }
  publish(id: string, source: AsyncIterable<Uint8Array>): Promise<StoredArtifact> {
    if (this.pending.has(id)) return Promise.reject(new StorageError("CONFLICT", { key: "artifacts.this_file_is_uploading_retry_later", args: [] }));
    const pending = this.write(id, source); this.pending.set(id, pending);
    void pending.finally(() => this.pending.delete(id)).catch(() => {}); return pending;
  }
  private async write(id: string, source: AsyncIterable<Uint8Array>): Promise<StoredArtifact> {
    const value = this.get(id);
    if (value.status === "ready") { await this.path(id); return value; }
    const staging = join(this.root, ".staging"); await mkdir(staging, { recursive: true, mode: 0o700 });
    const temporary = join(staging, randomUUID()), handle = await open(temporary, "wx", 0o600), hash = createHash("sha256"); let size = 0;
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > value.size) throw new StorageError("INVALID", { key: "artifacts.uploaded_file_size_does_not_match_registration", args: [] });
        hash.update(chunk); await handle.writeFile(chunk);
      }
      if (size !== value.size || hash.digest("hex") !== value.sha256) throw new StorageError("INVALID", { key: "artifacts.uploaded_file_size_or_checksum_does_not_match_registration", args: [] });
      try { await this.validate(temporary, value); }
      catch (cause) { if (cause instanceof StorageError && cause.code === "CORRUPT") throw new StorageError("INVALID", { key: "artifacts.invalid_own_log_format_or_truncated_archive", args: [] }); throw cause; }
      await handle.sync(); await handle.close();
      try { await link(temporary, join(this.root, value.key)); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        const digest = await fileDigest(await safeStoredFile(this.root, value.key));
        if (digest.size !== value.size || digest.sha256 !== value.sha256) throw new StorageError("CORRUPT", { key: "artifacts.storage_key_already_has_different_content", args: [] });
      }
      const directory = await open(this.root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return this.ready(value);
    } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
  }
  /** Crash after publishing bytes but before committing ready is safe to finish; absent staging never appears available. */
  async recover(): Promise<{ recovered: string[]; missing: string[] }> {
    const recovered: string[] = [], missing: string[] = [];
    for (const value of this.list().filter((artifact) => artifact.status === "staged")) {
      let path: string;
      try { path = await safeStoredFile(this.root, value.key); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { missing.push(value.id); continue; } throw cause; }
      const digest = await fileDigest(path);
      if (digest.sha256 !== value.sha256 || digest.size !== value.size) throw new StorageError("CORRUPT", { key: "artifacts.interrupted_archive_file_verification_failed", args: [] });
      await this.validate(path, value);
      this.ready(value); recovered.push(value.id);
    }
    return { recovered, missing };
  }
}
