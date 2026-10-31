import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredArtifact, SafeRelativePath, type ResourceRef } from "@lumio/schema";
import { StorageError } from "./errors.ts";

/** Refuse symlinks in every component before reading a managed or backup file. */
export async function safeStoredFile(root: string, key: string): Promise<string> {
  if (!SafeRelativePath.safeParse(key).success) throw new StorageError("INVALID", "文件路径不合法");
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new StorageError("CORRUPT", "存储根目录必须是实际目录");
  let path = root;
  for (const [index, part] of key.split("/").entries()) {
    path = join(path, part); const stat = await lstat(path);
    if (stat.isSymbolicLink() || (index < key.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new StorageError("CORRUPT", "托管文件不能通过符号链接或特殊文件访问");
  }
  return path;
}
export async function fileDigest(path: string): Promise<{ sha256: string; size: number }> {
  const digest = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path)) { digest.update(chunk); size += chunk.length; }
  return { sha256: digest.digest("hex"), size };
}
export class SqliteArtifacts {
  private readonly pending = new Map<string, Promise<StoredArtifact>>();
  constructor(private readonly db: Database, readonly root: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS storage_artifacts (id TEXT PRIMARY KEY, owner_module TEXT NOT NULL, owner_id TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('staged','ready')), record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS storage_artifacts_owner ON storage_artifacts(owner_module,owner_id,status);`);
  }
  get(id: string): StoredArtifact {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM storage_artifacts WHERE id=?").get(id);
    if (!row) throw new StorageError("NOT_FOUND", "托管文件不存在");
    return StoredArtifact.parse(JSON.parse(row.record));
  }
  list(owner?: ResourceRef): StoredArtifact[] {
    const rows = owner ? this.db.query<{ record: string }, [string, string]>("SELECT record FROM storage_artifacts WHERE owner_module=? AND owner_id=? ORDER BY rowid").all(owner.module, owner.id)
      : this.db.query<{ record: string }, []>("SELECT record FROM storage_artifacts ORDER BY rowid").all();
    return rows.map((row) => StoredArtifact.parse(JSON.parse(row.record)));
  }
  stage(input: unknown): StoredArtifact {
    const parsed = StoredArtifact.safeParse(input);
    if (!parsed.success || parsed.data.status !== "staged" || parsed.data.key !== `${parsed.data.id}.bin`) throw new StorageError("INVALID", "文件登记格式或存储键不合法");
    const value = parsed.data;
    return this.db.transaction(() => {
      const row = this.db.query<{ record: string }, [string]>("SELECT record FROM storage_artifacts WHERE id=?").get(value.id);
      if (row) {
        const prior = StoredArtifact.parse(JSON.parse(row.record));
        if (JSON.stringify({ ...prior, status: "staged" }) !== JSON.stringify(value)) throw new StorageError("CONFLICT", "文件编号已有不同的登记内容");
        return prior;
      }
      this.db.query("INSERT INTO storage_artifacts(id,owner_module,owner_id,key,status,record) VALUES(?,?,?,?,?,?)").run(value.id, value.owner.module, value.owner.id, value.key, value.status, JSON.stringify(value));
      return value;
    })();
  }
  async path(id: string): Promise<string> {
    const value = this.get(id);
    if (value.status !== "ready") throw new StorageError("CONFLICT", "文件尚未完成归档");
    const path = await safeStoredFile(this.root, value.key), digest = await fileDigest(path);
    if (digest.sha256 !== value.sha256 || digest.size !== value.size) throw new StorageError("CORRUPT", "托管文件校验失败");
    return path;
  }
  private ready(value: StoredArtifact): StoredArtifact {
    const result = StoredArtifact.parse({ ...value, status: "ready" });
    this.db.query("UPDATE storage_artifacts SET status='ready',record=? WHERE id=?").run(JSON.stringify(result), result.id); return result;
  }
  publish(id: string, source: AsyncIterable<Uint8Array>): Promise<StoredArtifact> {
    if (this.pending.has(id)) return Promise.reject(new StorageError("CONFLICT", "这个文件正在上传，可稍后重试"));
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
        if (size > value.size) throw new StorageError("INVALID", "上传文件大小与登记不符");
        hash.update(chunk); await handle.writeFile(chunk);
      }
      if (size !== value.size || hash.digest("hex") !== value.sha256) throw new StorageError("INVALID", "上传文件大小或校验和与登记不符");
      await handle.sync(); await handle.close();
      try { await link(temporary, join(this.root, value.key)); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        const digest = await fileDigest(await safeStoredFile(this.root, value.key));
        if (digest.size !== value.size || digest.sha256 !== value.sha256) throw new StorageError("CORRUPT", "存储键已有不同内容");
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
      if (digest.sha256 !== value.sha256 || digest.size !== value.size) throw new StorageError("CORRUPT", "中断归档的文件校验失败");
      this.ready(value); recovered.push(value.id);
    }
    return { recovered, missing };
  }
}
