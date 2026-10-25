import type { Database } from "bun:sqlite";
import { LinksResult, NoteDetail, SearchResult, type Link, type NoteRef } from "@lumio/schema";
import { CoreError } from "../errors.ts";
import { noteRef, snippet, withIndex, type IndexOptions, type NoteRow } from "./store.ts";

export interface QueryOptions extends IndexOptions { includePrivate?: boolean }
export interface SearchOptions extends QueryOptions { type?: NoteRef["type"]; limit?: number }

function resolveReference(db: Database, reference: string, includePrivate = false): NoteRow {
  const candidates = db.query<NoteRow, [string, string, string, number]>(
    "SELECT * FROM notes WHERE (id=? OR citekey=? OR filename=?) AND (private=0 OR ?=1) ORDER BY path",
  ).all(reference, reference, reference, Number(includePrivate));
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw new CoreError("NOTE_NOT_FOUND", "找不到笔记；候选：无");
  throw new CoreError("AMBIGUOUS_REFERENCE", `引用匹配到多个笔记；候选：\n${candidates.map((n) => n.path).join("\n")}`);
}

export async function searchNotes(root: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  if (!query.trim()) throw new CoreError("INVALID_QUERY", "查询不能为空");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CoreError("INVALID_LIMIT", "limit 必须是正整数");
  return withIndex(root, options, (db) => {
    const fts = Array.from(query).length >= 3;
    const filter = "(n.private=0 OR $private=1) AND ($type IS NULL OR n.type=$type)";
    const from = fts ? "fulltext JOIN notes n ON n.rowid=fulltext.rowid" : "notes n";
    const match = fts ? "fulltext MATCH $query" : "n.search_text LIKE $query ESCAPE '\\'";
    const params = {
      query: fts ? `"${query.replaceAll('"', '""')}"` : `%${query.replace(/[\\%_]/g, "\\$&")}%`,
      private: Number(options.includePrivate ?? false), type: options.type ?? null,
    };
    const total = db.query<{ total: number }, typeof params>(`SELECT count(*) AS total FROM ${from} WHERE ${filter} AND ${match}`).get(params)!.total;
    const rows = db.query<NoteRow, typeof params & { limit: number }>(
      `SELECT n.* FROM ${from} WHERE ${filter} AND ${match} ORDER BY ${fts ? "bm25(fulltext)," : ""} n.mtime DESC, n.path LIMIT $limit`,
    ).all({ ...params, limit });
    return SearchResult.parse({ query, total, hits: rows.map((row) => ({ note: noteRef(row), snippet: snippet(row.search_text, query) })) });
  });
}

export async function showNote(root: string, reference: string, options: QueryOptions = {}): Promise<NoteDetail> {
  return withIndex(root, options, (db) => {
    const row = resolveReference(db, reference, options.includePrivate);
    return NoteDetail.parse({ note: noteRef(row), frontmatter: JSON.parse(row.frontmatter), body: row.body });
  });
}

export async function noteLinks(root: string, reference: string, options: QueryOptions = {}): Promise<LinksResult> {
  return withIndex(root, options, (db) => {
    const row = resolveReference(db, reference, options.includePrivate);
    type Edge = { from_path: string; source: Link["source"]; target: string; resolved_path: string | null };
    const outgoing = db.query<Edge, [string]>("SELECT * FROM links WHERE from_path=? ORDER BY rowid").all(row.path).map((edge): Link => {
      const target = edge.resolved_path ? db.query<NoteRow, [string]>("SELECT * FROM notes WHERE path=?").get(edge.resolved_path) : null;
      const visible = target && (!target.private || options.includePrivate);
      return { source: edge.source, target: edge.target, dangling: !visible, ...(visible ? { note: noteRef(target) } : {}) };
    });
    const incoming = db.query<Edge, [string]>("SELECT * FROM links WHERE resolved_path=? ORDER BY from_path, rowid").all(row.path).flatMap((edge) => {
      const from = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE path=?").get(edge.from_path)!;
      return from.private && !options.includePrivate ? [] : [{ source: edge.source, target: edge.target, dangling: false, note: noteRef(from) }];
    });
    return LinksResult.parse({ note: noteRef(row), outgoing, incoming });
  });
}

/** Paths only: raw sensitive text is never stored or returned. */
export async function excludedCardPaths(root: string, options: QueryOptions = {}): Promise<string[]> {
  return withIndex(root, options, (db) => db.query<{ path: string }, []>("SELECT path FROM files WHERE blocked=1 ORDER BY path").all().map((f) => f.path));
}
