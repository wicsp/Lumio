import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Citekey, DerivedFrom, Id, type NoteRef } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { parseFrontmatter } from "@lumio/knowledge";
import { originalBytes, parseOriginal, scanOriginals } from "../originals.ts";
import { scanVault } from "../vault.ts";
import { extractKnowledgeLinks, plainText, resolveMarkdownPath } from "@lumio/knowledge";

import { embeddedLinks } from "./hosts.ts";

const VERSION = 7; // ADR 0065: rebuild derived host relationships; no business-data migration.
export interface IndexOptions {
  text?: (key: string, ...args: unknown[]) => string;
  stateDir?: string;
  /** Dependency injection lets tests assert unchanged notes are never parsed again. */
  parse?: typeof parseFrontmatter;
}
export interface NoteRow {
  path: string; id: string | null; type: NoteRef["type"]; title: string; citekey: string | null;
  filename: string; private: number; mtime: number; size: number;
  frontmatter: string; body: string; search_text: string; host_path: string | null;
}

/** 查询结果中的笔记引用。没有 ID 的笔记不带 `id`，不生成替代值（P1-1 review）。 */
export function noteRef(row: NoteRow): NoteRef {
  return {
    ...(row.id ? { id: row.id } : {}), type: row.type, title: row.title, path: row.path,
    ...(row.citekey ? { citekey: row.citekey } : {}),
  };
}

/**
 * 另一个进程可能同时在建表：先拿写锁（BEGIN IMMEDIATE，配合 busy_timeout 等待），
 * 拿到后再确认一次还是空库才建。否则后到的进程会报"表已存在"，并被误当成索引损坏而删库重建。
 */
function initializeOnce(db: Database, root: string): void {
  db.transaction(() => {
    const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()!.n;
    if (!count) initialize(db, root);
  }).immediate();
}

const ORIGINALS_TABLES = `
  CREATE TABLE IF NOT EXISTS original_files (
    path TEXT UNIQUE NOT NULL, owner TEXT, mtime REAL NOT NULL, size INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS original_owner ON original_files(owner);
  CREATE VIRTUAL TABLE IF NOT EXISTS originals_fts USING fts5(body, tokenize='trigram');
`;

function initialize(db: Database, root: string): void {
  db.exec(`
    CREATE TABLE metadata (version INTEGER NOT NULL, vault TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE notes (path TEXT UNIQUE NOT NULL, id TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
      citekey TEXT, filename TEXT NOT NULL, private INTEGER NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL,
      frontmatter TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL, host_path TEXT);
    CREATE INDEX notes_id ON notes(id);
    CREATE INDEX notes_filename ON notes(filename);
    CREATE VIRTUAL TABLE fulltext USING fts5(title, body, authors, citekey, tags, tokenize='trigram');
    ${ORIGINALS_TABLES}
    CREATE TABLE embedded_links (from_path TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, resolved_path TEXT);
    CREATE TABLE links (from_path TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, resolved_path TEXT);
    CREATE INDEX links_from ON links(from_path);
    CREATE INDEX links_to ON links(resolved_path);
    CREATE TABLE derived_from (target TEXT NOT NULL, from_path TEXT NOT NULL, PRIMARY KEY(target, from_path));
    CREATE INDEX derived_from_path ON derived_from(from_path);
    CREATE TABLE resource_links (target TEXT NOT NULL, from_path TEXT NOT NULL, PRIMARY KEY(target, from_path));
    CREATE INDEX resource_links_path ON resource_links(from_path);
    CREATE TABLE ai_links (from_path TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, resolved_path TEXT);
    CREATE INDEX ai_links_from ON ai_links(from_path);
    CREATE INDEX ai_links_to ON ai_links(resolved_path);
  `);
  db.query("INSERT INTO metadata VALUES (?, ?, ?)").run(VERSION, root, new Date().toISOString());
}

/**
 * Hub 与本地 CLI 可能同时打开同一个索引（两个进程）。遇到锁时等待而不是立刻失败；
 * WAL 让读取不被写入挡住。
 */
async function connect(path: string): Promise<Database> {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        // WAL 已开启时不再切换模式；首次并发初始化的模式切换可能立即 SQLITE_BUSY，
        // 即使配置了 busy_timeout。仅对锁冲突做有界重试，不把它误判为索引损坏。
        db.exec(`PRAGMA busy_timeout = ${Math.max(1, deadline - Date.now())}`);
        if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()!.journal_mode !== "wal") db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
      } catch (cause) {
        if ((cause as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw cause;
        await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
  } catch (cause) { db.close(); throw cause; }
}

async function openStore(path: string, root: string): Promise<Database> {
  let db: Database | undefined;
  try {
    db = await connect(path);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (!tables.length) { initializeOnce(db, root); return db; }
    const metadata = tables.some((t) => t.name === "metadata")
      ? db.query<{ version: number; vault: string }, []>("SELECT * FROM metadata").get() : null;
    const healthy = Object.values(db.query("PRAGMA quick_check").get() ?? {})[0] === "ok";
    if (healthy && metadata?.version === VERSION && metadata.vault === root
      && ["files", "notes", "fulltext", "links", "derived_from", "resource_links", "ai_links", "embedded_links"].every((name) => tables.some((t) => t.name === name))) {
      db.exec("INSERT INTO fulltext(fulltext) VALUES ('integrity-check')");
      // Additive derived metadata remains readable by older clients; no business migration.
      if (!db.query<{ name: string }, []>("PRAGMA table_info(metadata)").all().some(column => column.name === "updated_at")) {
        db.transaction(() => {
          if (!db!.query<{ name: string }, []>("PRAGMA table_info(metadata)").all().some(column => column.name === "updated_at")) {
            db!.exec("ALTER TABLE metadata ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
            db!.query("UPDATE metadata SET updated_at=?").run(new Date().toISOString());
          }
        }).immediate();
      }
      // Originals extend the derived index in place so older local clients can still use it.
      if (!tables.some(table => table.name === "original_files")) {
        db.transaction(() => db!.exec(ORIGINALS_TABLES)).immediate();
      }
      db.exec("INSERT INTO originals_fts(originals_fts) VALUES ('integrity-check')");
      return db;
    }
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (!code?.startsWith("SQLITE_CORRUPT") && code !== "SQLITE_NOTADB" && code !== "SQLITE_ERROR") {
      db?.close();
      throw cause;
    }
  }
  db?.close();
  // 连同 WAL 的辅助文件一起删掉，否则新索引可能读到旧数据。
  for (const file of [path, `${path}-wal`, `${path}-shm`]) await unlink(file).catch((cause) => {
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
  });
  const fresh = await connect(path);
  try { initializeOnce(fresh, root); return fresh; }
  catch (cause) { fresh.close(); throw cause; }
}

function strings(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => typeof v === "string").join(" ") : "";
}

export async function withIndex<T>(root: string, options: IndexOptions, query: (db: Database) => T): Promise<T> {
  let db: Database | undefined;
  try {
    const state = options.stateDir ?? process.env.LUMIO_STATE_DIR ?? join(homedir(), ".local", "share", "lumio");
    await mkdir(state, { recursive: true });
    db = await openStore(join(state, "index.sqlite"), resolve(root));
    const [files, originals] = await Promise.all([scanVault(root), scanOriginals(root)]);
    const previous = new Map(db.query<{ path: string; mtime: number; size: number }, []>("SELECT * FROM files").all().map((f) => [f.path, f]));
    const current = new Set(files.map((f) => f.relativePath));
    const changes: { note: NoteRow; authors: string; tags: string }[] = [];
    for (const file of files) {
      const info = await stat(file.path);
      const old = previous.get(file.relativePath);
      if (old?.mtime === info.mtimeMs && old.size === info.size) continue;
      const source = await readFile(file.path);
      let fm: Record<string, unknown> = {}, body = source.toString("utf8");
      try { const parsed = (options.parse ?? parseFrontmatter)(source); fm = parsed.data; body = parsed.body.toString("utf8"); }
      catch (cause) { if (!(cause instanceof CoreError) || cause.code !== "INVALID_FRONTMATTER") throw cause; }
      const title = strings(fm.title) || basename(file.path, ".md");
      const citekey = file.type === "paper" && Citekey.safeParse(fm.citekey).success ? fm.citekey as string : null;
      const authors = [strings(fm.authors), strings(fm.author)].filter(Boolean).join(" ");
      const tags = strings(fm.tags);
      changes.push({ authors, tags, note: {
        path: file.relativePath, id: Id.safeParse(fm.id).success ? fm.id as string : null,
        type: file.type, title, citekey, filename: basename(file.path, ".md"), private: Number(file.private),
        mtime: info.mtimeMs, size: info.size, frontmatter: JSON.stringify(fm), body,
        search_text: [title, body, authors, citekey ?? "", tags].join("\n"), host_path: null,
      } });
    }
    const previousOriginals = new Map(db.query<{ path: string; mtime: number; size: number }, []>(
      "SELECT path,mtime,size FROM original_files",
    ).all().map(file => [file.path, file]));
    const currentOriginals = new Set(originals.map(file => file.relativePath));
    const originalChanges: { path: string; mtime: number; size: number; original?: ReturnType<typeof parseOriginal> }[] = [];
    for (const file of originals) {
      try {
        const info = await stat(file.path);
        const old = previousOriginals.get(file.relativePath);
        if (old?.mtime === info.mtimeMs && old.size === info.size) continue;
        const bytes = await originalBytes(root, file.relativePath);
        const change: (typeof originalChanges)[number] = { path: file.relativePath, mtime: info.mtimeMs, size: info.size };
        try { change.original = parseOriginal(bytes); }
        catch (cause) {
          if (!(cause instanceof CoreError) || !["INVALID_FRONTMATTER", "NOTE_NOT_FOUND"].includes(cause.code)) throw cause;
        }
        originalChanges.push(change);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT" && !(cause instanceof CoreError && cause.code === "NOTE_NOT_FOUND")) throw cause;
        currentOriginals.delete(file.relativePath);
      }
    }
    const database = db;
    const removed = [...previous.keys()].filter((path) => !current.has(path));
    const removedOriginals = [...previousOriginals.keys()].filter(path => !currentOriginals.has(path));
    // 没有变化时不开写事务，免得每次查询都去抢写锁。
    // 有变化时用 IMMEDIATE：一开始就拿写锁（会按 busy_timeout 等待）。默认的延迟事务在 WAL 下
    // 由读升级为写时若别的进程刚写过，会直接报 "database is locked"，不会等待。
    if (changes.length || removed.length || originalChanges.length || removedOriginals.length) database.transaction(() => {
      const remove = (path: string) => {
        database.query("DELETE FROM fulltext WHERE rowid IN (SELECT rowid FROM notes WHERE path=?)").run(path);
        database.query("DELETE FROM notes WHERE path=?").run(path);
        database.query("DELETE FROM links WHERE from_path=?").run(path);
        database.query("DELETE FROM derived_from WHERE from_path=?").run(path);
        database.query("DELETE FROM resource_links WHERE from_path=?").run(path);
        database.query("DELETE FROM ai_links WHERE from_path=?").run(path);
        database.query("DELETE FROM embedded_links WHERE from_path=?").run(path);
        database.query("DELETE FROM files WHERE path=?").run(path);
      };
      for (const path of removed) remove(path);
      for (const { note: n, authors, tags } of changes) {
        remove(n.path);
        database.query("INSERT INTO files VALUES (?, ?, ?)").run(n.path, n.mtime, n.size);
        const result = database.query("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
          .run(n.path, n.id, n.type, n.title, n.citekey, n.filename, n.private, n.mtime, n.size, n.frontmatter, n.body, n.search_text);
        database.query("INSERT INTO fulltext(rowid, title, body, authors, citekey, tags) VALUES (?, ?, ?, ?, ?, ?)")
          .run(result.lastInsertRowid, n.title, n.body, authors, n.citekey ?? "", tags);
        const { derived_from: sources } = JSON.parse(n.frontmatter);
        if (Array.isArray(sources)) {
          for (const source of sources) {
            const parsed = DerivedFrom.safeParse(source);
            if (parsed.success) database.query("INSERT OR IGNORE INTO derived_from VALUES (?, ?)").run(parsed.data, n.path);
          }
        }
        const { links, resourceIds } = extractKnowledgeLinks(n.body, n.path);
        for (const id of new Set(resourceIds)) database.query("INSERT INTO resource_links VALUES (?, ?)").run(id, n.path);
        // AI 笔记的出链不进人的链接图（ADR 0051），单独存放供"AI 笔记提到"查询（ADR 0053）。
        const table = n.type === "ai-note" ? "ai_links" : "links";
        if (!n.private && (n.type === "paper" || n.type === "source")) {
          for (const link of embeddedLinks(n.body, n.path)) database.query("INSERT INTO embedded_links VALUES (?, ?, ?, NULL)").run(n.path, link.source, link.target);
        }
        for (const link of links) database.query(`INSERT INTO ${table} VALUES (?, ?, ?, NULL)`).run(n.path, link.source, link.target);
      }
      for (const table of ["links", "ai_links", "embedded_links"] as const) {
        database.exec(`UPDATE ${table} SET resolved_path = (SELECT min(path) FROM notes WHERE filename=${table}.target HAVING count(*)=1)
          WHERE source='wikilink'`);
        // Resolve every Markdown edge again: an unchanged source may gain or lose a target.
        const markdown = database.query<{ rowid: number; from_path: string; target: string }, []>(
          `SELECT rowid, from_path, target FROM ${table} WHERE source='markdown'`,
        ).all();
        const find = database.query<{ path: string }, [string]>("SELECT path FROM notes WHERE path=?");
        const update = database.query(`UPDATE ${table} SET resolved_path=? WHERE rowid=?`);
        for (const link of markdown) {
          const path = resolveMarkdownPath(link.from_path, link.target);
          update.run(path ? find.get(path)?.path ?? null : null, link.rowid);
        }
      }
      // Recompute after all links resolve: either side may change, disappear, or become ambiguous.
      database.exec(`UPDATE notes SET host_path = (
        SELECT min(h.path) FROM embedded_links e JOIN notes h ON h.path=e.from_path
        JOIN derived_from d ON d.from_path=notes.path AND d.target=h.id
        WHERE e.resolved_path=notes.path AND h.private=0 AND h.type IN ('paper','source')
        HAVING count(DISTINCT h.path)=1
      ) WHERE type='ai-note' AND private=0`);
      const removeOriginal = (path: string) => {
        database.query("DELETE FROM originals_fts WHERE rowid=(SELECT rowid FROM original_files WHERE path=?)").run(path);
        database.query("DELETE FROM original_files WHERE path=?").run(path);
      };
      for (const path of removedOriginals) removeOriginal(path);
      for (const change of originalChanges) {
        removeOriginal(change.path);
        const { lastInsertRowid } = database.query("INSERT INTO original_files VALUES (?, ?, ?, ?)")
          .run(change.path, change.original?.frontmatter.of ?? null, change.mtime, change.size);
        if (change.original) database.query("INSERT INTO originals_fts(rowid, body) VALUES (?, ?)").run(lastInsertRowid, change.original.body);
      }
      database.query("UPDATE metadata SET updated_at=?").run(new Date().toISOString());
    }).immediate();
    return query(database);
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("INDEX_FAILED", { key: "store.could_not_update_or_query_local_index", args: [] }, { cause });
  } finally { db?.close(); }
}

export function snippet(text: string, query: string): string {
  const plain = plainText(text);
  let position = plain.toLowerCase().indexOf(query.toLowerCase());
  // Markdown may occur in the literal query. Locate its rendered position even
  // when removing presentation means the full query no longer exists verbatim.
  if (position < 0) {
    const raw = text.toLowerCase().indexOf(query.toLowerCase());
    position = raw < 0 ? 0 : plainText(text.slice(0, raw)).length;
  }
  const start = Math.max(0, Array.from(plain.slice(0, Math.max(0, position))).length - 60);
  return Array.from(plain).slice(start, start + 200).join("");
}

/** Refresh the derived index without issuing a user query. */
export async function updateIndex(root: string, options: IndexOptions = {}): Promise<void> {
  await withIndex(root, options, () => {});
}

/** Read the current index snapshot without scanning, parsing or modifying vault files. */
export async function readIndex<T>(root: string, options: IndexOptions, query: (db: Database) => T): Promise<T> {
  let db: Database | undefined;
  try {
    const state = options.stateDir ?? process.env.LUMIO_STATE_DIR ?? join(homedir(), ".local", "share", "lumio");
    db = new Database(join(state, "index.sqlite"), { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const metadata = db.query<{ version: number; vault: string }, []>("SELECT version,vault FROM metadata").get();
    if (metadata?.version !== VERSION || metadata.vault !== resolve(root)) throw new Error("Index metadata mismatch");
    const database = db;
    return database.transaction(() => query(database))();
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("INDEX_FAILED", { key: "store.could_not_update_or_query_local_index", args: [] }, { cause });
  } finally { db?.close(); }
}
