import { Database } from "bun:sqlite";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Citekey, Id, textContainsCardNumber, type NoteRef } from "@lumio/schema";
import { CoreError } from "../errors.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { scanVault } from "../vault.ts";
import { extractLinks, plainText } from "./links.ts";

const VERSION = 1;
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

async function openStore(path: string, root: string): Promise<Database> {
  let db: Database | undefined;
  try {
    db = new Database(path, { create: true, strict: true });
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (!tables.length) { initialize(db, root); return db; }
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
  await unlink(path);
  const fresh = new Database(path, { create: true, strict: true });
  try { initialize(fresh, root); return fresh; }
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
    database.transaction(() => {
      const remove = (path: string) => {
        database.query("DELETE FROM fulltext WHERE rowid IN (SELECT rowid FROM notes WHERE path=?)").run(path);
        database.query("DELETE FROM notes WHERE path=?").run(path);
        database.query("DELETE FROM links WHERE from_path=?").run(path);
        database.query("DELETE FROM files WHERE path=?").run(path);
      };
      for (const path of previous.keys()) if (!current.has(path)) remove(path);
      for (const change of changes) {
        remove(change.path);
        database.query("INSERT INTO files VALUES (?, ?, ?, ?)").run(change.path, change.mtime, change.size, Number(!change.note));
        if (!change.note) continue;
        const n = change.note;
        const result = database.query("INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(n.path, n.id, n.type, n.title, n.citekey, n.filename, n.private, change.mtime, change.size, n.frontmatter, n.body, n.search_text);
        database.query("INSERT INTO fulltext(rowid, title, body, authors, citekey, tags) VALUES (?, ?, ?, ?, ?, ?)")
          .run(result.lastInsertRowid, n.title, n.body, change.authors!, n.citekey ?? "", change.tags!);
        for (const link of extractLinks(JSON.parse(n.frontmatter), n.body)) {
          database.query("INSERT INTO links VALUES (?, ?, ?, NULL)").run(n.path, link.source, link.target);
        }
      }
      if (changes.length || previous.size !== current.size) {
        database.exec(`UPDATE links SET resolved_path = CASE source
          WHEN 'related' THEN (SELECT min(path) FROM notes WHERE id=links.target HAVING count(*)=1)
          ELSE (SELECT min(path) FROM notes WHERE filename=links.target HAVING count(*)=1) END`);
      }
    })();
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
