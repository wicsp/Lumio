import type { Database } from "bun:sqlite";
import { CheckResult, KnowledgeGraph, LinksResult, NoteDetail, SearchResult, type Link, type NoteRef } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { extractCitations, resolveMarkdownPath } from "@lumio/knowledge";
import { noteRef, snippet, withIndex, readIndex, type IndexOptions, type NoteRow } from "./store.ts";

export interface QueryOptions extends IndexOptions { includePrivate?: boolean }
export interface SearchOptions extends QueryOptions { type?: NoteRef["type"]; limit?: number }

function resolveReference(db: Database, reference: string, includePrivate = false): NoteRow {
  const candidates = db.query<NoteRow, [string, string, string, string, number]>(
    "SELECT * FROM notes WHERE (path=? OR id=? OR citekey=? OR filename=?) AND (private=0 OR ?=1) ORDER BY path",
  ).all(reference, reference, reference, reference, Number(includePrivate));
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw new CoreError("NOTE_NOT_FOUND", { key: "query.note_not_found_candidates_none", args: [] });
  throw new CoreError("AMBIGUOUS_REFERENCE", { key: "query.reference_matches_multiple_notes_candidates", args: [candidates.map((n) => n.path).join("\n")] });
}

export async function searchNotes(root: string, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  if (query && !query.trim()) throw new CoreError("INVALID_QUERY", { key: "service.query_must_not_contain_only_whitespace", args: [] });
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CoreError("INVALID_LIMIT", { key: "query.limit_must_be_a_positive_integer", args: [] });
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

export async function noteById(root: string, id: string, options: QueryOptions = {}): Promise<NoteRef | undefined> {
  return withIndex(root, options, db => {
    const rows = db.query<NoteRow, [string, number]>("SELECT * FROM notes WHERE id=? AND (private=0 OR ?=1) LIMIT 2")
      .all(id, Number(options.includePrivate ?? false));
    return rows.length === 1 ? noteRef(rows[0]!) : undefined;
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
    const out = (table: "links" | "ai_links") => db.query<Edge, [string]>(`SELECT * FROM ${table} WHERE from_path=? ORDER BY rowid`).all(row.path).map((edge): Link => {
      const target = edge.resolved_path ? db.query<NoteRow, [string]>("SELECT * FROM notes WHERE path=?").get(edge.resolved_path) : null;
      const visible = target && (!target.private || options.includePrivate);
      return { source: edge.source, target: edge.target, dangling: !visible, ...(visible ? { note: noteRef(target) } : {}) };
    });
    const into = (table: "links" | "ai_links") => db.query<Edge, [string]>(`SELECT * FROM ${table} WHERE resolved_path=? ORDER BY from_path, rowid`).all(row.path).flatMap((edge) => {
      const from = db.query<NoteRow, [string]>("SELECT * FROM notes WHERE path=?").get(edge.from_path)!;
      return from.private && !options.includePrivate ? [] : [{ source: edge.source, target: edge.target, dangling: false, note: noteRef(from) }];
    });
    // ADR 0053：AI 笔记的链接单独列出，缺失表示没有。
    const aiOutgoing = out("ai_links"), aiIncoming = into("ai_links");
    return LinksResult.parse({ note: noteRef(row), outgoing: out("links"), incoming: into("links"),
      ...(aiOutgoing.length ? { ai_outgoing: aiOutgoing } : {}), ...(aiIncoming.length ? { ai_incoming: aiIncoming } : {}) });
  });
}

/** References used for bibliography exports are always public, including the source note. */
export async function collectCitations(root: string, reference: string, options: IndexOptions = {}): Promise<{ papers: NoteRef[]; warnings: string[] }> {
  const msg = options.text ?? ((key: string, ...args: unknown[]) => key.replace(/\$\{(\d+)\}/g, (_, index: string) => String(args[Number(index)])));
  return withIndex(root, options, (db) => {
    const row = resolveReference(db, reference);
    if (row.type === "ai-note") return { papers: [], warnings: [] };
    const { citations, ignored } = extractCitations(row.body, row.path);
    const papers = new Map<string, NoteRef>();
    const warnings: string[] = ignored ? [msg("${0} citations inside AI blocks were excluded", ignored)] : [];
    for (const citation of citations) {
      const column = citation.source === "markdown" ? "path" : citation.source === "cite" ? "citekey" : "filename";
      const target = citation.source === "markdown" ? resolveMarkdownPath(row.path, citation.target) : citation.target;
      const matches = target === undefined ? [] : db.query<NoteRow, [string]>(`SELECT * FROM notes WHERE ${column}=? ORDER BY path`).all(target);
      // Match the graph's path/unique-filename resolution; LaTeX keys only match papers.
      const candidates = citation.source === "cite" ? matches.filter((n) => n.type === "paper") : matches;
      const paper = candidates.length === 1 ? candidates[0] : undefined;
      if (paper?.type === "paper" && !paper.private && paper.citekey) papers.set(paper.citekey, noteRef(paper));
      else if (citation.source === "cite" && !candidates.some((n) => n.private)) warnings.push(msg("Citekey not found: ${0}", citation.target));
    }
    return { papers: [...papers.values()], warnings };
  });
}

export async function checkLinks(root: string, options: QueryOptions = {}): Promise<CheckResult> {
  return withIndex(root, options, (db) => {
    type Edge = { from_path: string; source: Link["source"]; target: string };
    const edges = db.query<Edge, [number, number]>(`
      SELECT l.* FROM links l JOIN notes n ON n.path=l.from_path
      WHERE l.resolved_path IS NULL AND (n.private=0 OR ?=1)
        AND (?=1 OR NOT EXISTS (SELECT 1 FROM notes p WHERE p.private=1 AND
          l.source='wikilink' AND p.filename=l.target))
      ORDER BY l.from_path, l.target, l.rowid
    `).all(Number(options.includePrivate ?? false), Number(options.includePrivate ?? false));
    const dangling = edges.map((edge) => ({
      from: noteRef(db.query<NoteRow, [string]>("SELECT * FROM notes WHERE path=?").get(edge.from_path)!),
      source: edge.source, target: edge.target,
    }));
    return CheckResult.parse({ dangling, total: dangling.length });
  });
}

/** Count visible notes referencing any of the supplied resources, once per note. */
export async function countKnowledgeReferences(root: string, targets: readonly string[], options: QueryOptions = {}): Promise<number> {
  if (!targets.length) return 0;
  return withIndex(root, options, db => db.query<{ count: number }, { targets: string; includePrivate: number }>(`
    WITH targets AS (SELECT value FROM json_each($targets)), refs AS (
      SELECT from_path FROM derived_from WHERE target IN (SELECT value FROM targets)
      UNION
      SELECT from_path FROM resource_links WHERE target IN (SELECT value FROM targets)
    )
    SELECT count(*) AS count FROM refs JOIN notes n ON n.path=refs.from_path
    WHERE n.private=0 OR $includePrivate=1
  `).get({ targets: JSON.stringify(targets), includePrivate: Number(options.includePrivate ?? false) })!.count);
}

/** Paths only: raw sensitive text is never stored or returned. */
export async function excludedCardPaths(root: string, options: QueryOptions = {}): Promise<string[]> {
  return withIndex(root, options, (db) => db.query<{ path: string }, []>("SELECT path FROM files WHERE blocked=1 ORDER BY path").all().map((f) => f.path));
}

/** Whole graph comes from one consistent index snapshot, never a per-note query loop. */
export async function knowledgeGraph(root: string, options: SearchOptions & { includeLegacy?: boolean } = {}): Promise<KnowledgeGraph> {
  return readIndex(root, options, db => {
    const params = { private: Number(options.includePrivate ?? false), type: options.type ?? null, legacy: Number(options.includeLegacy ?? false) };
    const rows = db.query<NoteRow, typeof params>(`SELECT * FROM notes WHERE (private=0 OR $private=1)
      AND ($type IS NULL OR type=$type) AND ($legacy=1 OR type NOT IN ('task','project','routine'))
      AND path NOT LIKE '.trash/%' AND path NOT LIKE '%/.trash/%' ORDER BY path`).all(params);
    const shown = new Set(rows.map(row => row.path)), edges = new Map<string, { from: string; to: string; count: number }>();
    let dangling = 0;
    const links = db.query<{ from_path: string; resolved_path: string | null }, []>("SELECT from_path,resolved_path FROM links ORDER BY from_path,resolved_path,rowid").all();
    for (const link of links) {
      if (!shown.has(link.from_path)) continue;
      if (link.resolved_path === null) { dangling++; continue; }
      if (!shown.has(link.resolved_path) || link.from_path === link.resolved_path) continue;
      const key = JSON.stringify([link.from_path, link.resolved_path]);
      const edge = edges.get(key) ?? { from: link.from_path, to: link.resolved_path, count: 0 }; edge.count++; edges.set(key, edge);
    }
    return KnowledgeGraph.parse({ nodes: rows.map(noteRef), edges: [...edges.values()], dangling,
      generated_at: db.query<{ updated_at: string }, []>("SELECT updated_at FROM metadata").get()!.updated_at });
  });
}
