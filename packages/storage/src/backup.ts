import { Database } from "bun:sqlite";
import { chmod, copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { BackupManifest, StoredArtifact } from "@lumio/schema";
import { fileDigest, safeStoredFile } from "./artifacts.ts";
import { StorageError } from "./errors.ts";

function referenced(db: Database): StoredArtifact[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='storage_artifacts'").get()) return [];
  return db.query<{ record: string }, []>("SELECT record FROM storage_artifacts WHERE status='ready' ORDER BY id").all().map((row) => StoredArtifact.parse(JSON.parse(row.record)));
}
async function copyPrivate(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, 1); await chmod(target, 0o600); await syncPath(target);
}
async function syncPath(path: string) { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
function verifyDatabase(path: string): void {
  const db = new Database(path, { readonly: true, strict: true });
  try { if (db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) throw new Error(); }
  catch { throw new StorageError("CORRUPT", "备份数据库完整性检查失败"); }
  finally { db.close(); }
}

/** Database snapshot determines the exact immutable files included, even when new files are registered during backup. */
export async function backupBusiness(stateDir: string, destination: string, now = new Date()): Promise<BackupManifest> {
  const target = resolve(destination); let reserved = false, db: Database | undefined, snapshot: Database | undefined;
  try {
    await mkdir(target, { mode: 0o700 }); reserved = true;
    const path = join(target, "hub.sqlite");
    db = new Database(join(stateDir, "hub.sqlite"), { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout=5000"); db.query("VACUUM INTO ?").run(path); await chmod(path, 0o600); await syncPath(path);
    snapshot = new Database(path, { readonly: true, strict: true });
    const files: BackupManifest["files"] = [];
    for (const artifact of referenced(snapshot)) {
      const source = await safeStoredFile(join(stateDir, "files"), artifact.key), relative = `files/${artifact.key}`;
      await copyPrivate(source, join(target, relative));
      const digest = await fileDigest(join(target, relative));
      if (digest.sha256 !== artifact.sha256 || digest.size !== artifact.size) throw new StorageError("CORRUPT", "备份中的托管文件校验失败");
      files.push({ path: relative, ...digest });
    }
    const manifest = BackupManifest.parse({ schema_version: 1, created: now.toISOString(), database: { path: "hub.sqlite", ...await fileDigest(path) }, files });
    verifyDatabase(path);
    const output = await open(join(target, "manifest.json"), "wx", 0o600);
    try { await output.writeFile(JSON.stringify(manifest, null, 2) + "\n"); await output.sync(); } finally { await output.close(); }
    await syncPath(target); await syncPath(dirname(target));
    return manifest;
  } catch (cause) {
    if (reserved) await rm(target, { recursive: true, force: true });
    if (cause instanceof StorageError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("CONFLICT", "备份目标已存在");
    throw new StorageError("INVALID", "无法完成业务备份；请检查数据库与文件是否齐全");
  } finally { snapshot?.close(); db?.close(); }
}
export async function verifyBusinessBackup(source: string): Promise<BackupManifest> {
  let manifest: BackupManifest;
  try { manifest = BackupManifest.parse(JSON.parse(await readFile(await safeStoredFile(source, "manifest.json"), "utf8"))); }
  catch { throw new StorageError("CORRUPT", "备份清单无法读取或格式不合法"); }
  if (manifest.database.path !== "hub.sqlite") throw new StorageError("CORRUPT", "备份数据库路径不合法");
  const paths = new Set<string>();
  for (const entry of [manifest.database, ...manifest.files]) {
    if (paths.has(entry.path) || entry.path === "manifest.json") throw new StorageError("CORRUPT", "备份清单包含重复路径"); paths.add(entry.path);
    try {
      const digest = await fileDigest(await safeStoredFile(source, entry.path));
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) throw new Error();
    } catch { throw new StorageError("CORRUPT", "备份文件缺失或校验失败"); }
  }
  const path = await safeStoredFile(source, manifest.database.path); verifyDatabase(path);
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const expected = referenced(db).map((artifact) => ({ path: `files/${artifact.key}`, sha256: artifact.sha256, size: artifact.size }));
    if (expected.length !== manifest.files.length || expected.some((entry) => !manifest.files.some((file) => file.path === entry.path && file.sha256 === entry.sha256 && file.size === entry.size))) throw new StorageError("CORRUPT", "备份清单与数据库引用的文件不一致");
  } finally { db.close(); }
  return manifest;
}
/** Restore exclusively to a new directory. Switching a stopped installation to it is a separate explicit action. */
export async function restoreBusiness(source: string, destination: string): Promise<BackupManifest> {
  const manifest = await verifyBusinessBackup(source), target = resolve(destination); let reserved = false;
  try {
    await mkdir(target, { mode: 0o700 }); reserved = true;
    for (const entry of [manifest.database, ...manifest.files]) await copyPrivate(await safeStoredFile(source, entry.path), join(target, entry.path));
    // Check the copied bytes too: the source may have changed since verification.
    for (const entry of [manifest.database, ...manifest.files]) {
      const digest = await fileDigest(join(target, entry.path));
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) throw new StorageError("CORRUPT", "恢复期间备份文件发生变化");
    }
    verifyDatabase(join(target, "hub.sqlite")); await syncPath(target); await syncPath(dirname(target)); return manifest;
  } catch (cause) {
    if (reserved) await rm(target, { recursive: true, force: true });
    if (cause instanceof StorageError) throw cause;
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("CONFLICT", "恢复目标已存在，不覆盖已有业务数据");
    throw new StorageError("INVALID", "无法恢复业务备份");
  }
}
