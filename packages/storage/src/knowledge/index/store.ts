import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Citekey, Id, textContainsCardNumber, type NoteRef } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { parseFrontmatter } from "@lumio/knowledge";
import { scanVault } from "../vault.ts";
import { extractLinks, plainText, resolveMarkdownPath } from "@lumio/knowledge";

const VERSION = 3; // 3：同时索引按路径解析的 Markdown 链接（P2-10），旧索引自动重建
export interface IndexOptions {
  stateDir?: string;
  /** Dependency injection lets tests assert unchanged notes are never parsed again. */
  parse?: typeof parseFrontmatter;
}
export interface NoteRow {
  path: string; id: string | null; type: NoteRef["type"]; title: string; citekey: string | null;
  filename: string; private: number; mtime: number; size: number;
  frontmatter: string; body: string; search_text: string;
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

function initialize(db: Database, root: string): void {
  db.exec(`
    CREATE TABLE metadata (version INTEGER NOT NULL, vault TEXT NOT NULL);
    CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL, blocked INTEGER NOT NULL);
    CREATE TABLE notes (path TEXT UNIQUE NOT NULL, id TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
      citekey TEXT, filename TEXT NOT NULL, private INTEGER NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL,
      frontmatter TEXT NOT NULL, body TEXT NOT NULL, search_text TEXT NOT NULL);
    CREATE INDEX notes_id ON notes(id);
    CREATE INDEX notes_filename ON notes(filename);
    CREATE VIRTUAL TABLE fulltext USING fts5(title, body, authors, citekey, tags, tokenize='trigram');
    CREATE TABLE links (from_path TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, resolved_path TEXT);
    CREATE INDEX links_from ON links(from_path);
    CREATE INDEX links_to ON links(resolved_path);
  `);
  db.query("INSERT INTO metadata VALUES (?, ?)").run(VERSION, root);
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
      && ["files", "notes", "fulltext", "links"].every((name) => tables.some((t) => t.name === name))) {
      db.exec("INSERT INTO fulltext(fulltext) VALUES ('integrity-check')");
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
    const files = await scanVault(root);
    const previous = new Map(db.query<{ path: string; mtime: number; size: number }, []>("SELECT * FROM files").all().map((f) => [f.path, f]));
    const current = new Set(files.map((f) => f.relativePath));
    const changes: { path: string; mtime: number; size: number; note?: Omit<NoteRow, "mtime" | "size">; authors?: string; tags?: string }[] = [];
    for (const file of files) {
      const info = await stat(file.path);
      const old = previous.get(file.relativePath);
      if (old?.mtime === info.mtimeMs && old.size === info.size) continue;
      const source = await readFile(file.path);
      const change: (typeof changes)[number] = { path: file.relativePath, mtime: info.mtimeMs, size: info.size };
      if (!textContainsCardNumber(source.toString("utf8"))) {
        let fm: Record<string, unknown> = {}, body = source.toString("utf8");
        try { const parsed = (options.parse ?? parseFrontmatter)(source); fm = parsed.data; body = parsed.body.toString("utf8"); }
        catch (cause) { if (!(cause instanceof CoreError) || cause.code !== "INVALID_FRONTMATTER") throw cause; }
        const title = strings(fm.title) || basename(file.path, ".md");
        const citekey = file.type === "paper" && Citekey.safeParse(fm.citekey).success ? fm.citekey as string : null;
        const authors = [strings(fm.authors), strings(fm.author)].filter(Boolean).join(" ");
        const tags = strings(fm.tags);
        change.note = {
          path: file.relativePath, id: Id.safeParse(fm.id).success ? fm.id as string : null,
          type: file.type, title, citekey, filename: basename(file.path, ".md"), private: Number(file.private),
          frontmatter: JSON.stringify(fm), body,
          search_text: [title, body, authors, citekey ?? "", tags].join("\n"),
        };
        change.authors = authors; change.tags = tags;
      }
      changes.push(change);
    }
    const database = db;
    const removed = [...previous.keys()].filter((path) => !current.has(path));
    // 没有变化时不开写事务，免得每次查询都去抢写锁。
    // 有变化时用 IMMEDIATE：一开始就拿写锁（会按 busy_timeout 等待）。默认的延迟事务在 WAL 下
    // 由读升级为写时若别的进程刚写过，会直接报 "database is locked"，不会等待。
    if (changes.length || removed.length) database.transaction(() => {
      const remove = (path: string) => {
        database.query("DELETE FROM fulltext WHERE rowid IN (SELECT rowid FROM notes WHERE path=?)").run(path);
        database.query("DELETE FROM notes WHERE path=?").run(path);
        database.query("DELETE FROM links WHERE from_path=?").run(path);
        database.query("DELETE FROM files WHERE path=?").run(path);
      };
      for (const path of removed) remove(path);
      for (const change of changes) {
        remove(change.path);
        database.query("INSERT INTO files VALUES (?, ?, ?, ?)").run(change.path, change.mtime, change.size, Number(!change.note));
        if (!change.note) continue;
        const n = change.note;
        const result = database.query("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(n.path, n.id, n.type, n.title, n.citekey, n.filename, n.private, change.mtime, change.size, n.frontmatter, n.body, n.search_text);
        database.query("INSERT INTO fulltext(rowid, title, body, authors, citekey, tags) VALUES (?, ?, ?, ?, ?, ?)")
          .run(result.lastInsertRowid, n.title, n.body, change.authors!, n.citekey ?? "", change.tags!);
        for (const link of extractLinks(JSON.parse(n.frontmatter), n.body, n.path)) {
          database.query("INSERT INTO links VALUES (?, ?, ?, NULL)").run(n.path, link.source, link.target);
        }
      }
      {
        database.exec(`UPDATE links SET resolved_path = (SELECT min(path) FROM notes WHERE filename=links.target HAVING count(*)=1)
          WHERE source='wikilink'`);
        // Resolve every Markdown edge again: an unchanged source may gain or lose a target.
        const markdown = database.query<{ rowid: number; from_path: string; target: string }, []>(
          "SELECT rowid, from_path, target FROM links WHERE source='markdown'",
        ).all();
        const find = database.query<{ path: string }, [string]>("SELECT path FROM notes WHERE path=?");
        const update = database.query("UPDATE links SET resolved_path=? WHERE rowid=?");
        for (const link of markdown) {
          const path = resolveMarkdownPath(link.from_path, link.target);
          update.run(path ? find.get(path)?.path ?? null : null, link.rowid);
        }
      }
    }).immediate();
    return query(database);
  } catch (cause) {
    if (cause instanceof CoreError) throw cause;
    throw new CoreError("INDEX_FAILED", "无法更新或查询本地索引", { cause });
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
