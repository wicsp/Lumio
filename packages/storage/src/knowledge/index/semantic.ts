import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ReadingStatus, Timestamp, type SearchHit, type SearchResult } from "@lumio/schema";
import { noteRef, readIndex, snippet, withIndex, type IndexOptions, type NoteRow } from "./store.ts";

const table = `CREATE TABLE IF NOT EXISTS knowledge_vectors (
  profile TEXT NOT NULL, path TEXT NOT NULL, stamp TEXT NOT NULL, vector BLOB NOT NULL,
  PRIMARY KEY (profile, path)
)`;
const exists = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_vectors'").get();
// Hosted AI cards belong to the source. Their index revisions are part of its embedding revision.
const stamp = `CAST(n.mtime AS TEXT)||':'||n.size||':'||COALESCE((SELECT group_concat(rev,',') FROM
  (SELECT CAST(c.mtime AS TEXT)||':'||c.size AS rev FROM notes c WHERE c.host_path=n.path AND c.private=0 ORDER BY c.path)), '')`;
const scope = "n.private=0 AND n.host_path IS NULL";

export interface EmbeddingDocument { path: string; stamp: string; text: string }

export async function pendingEmbeddings(root: string, options: IndexOptions, profile: string, limit: number): Promise<EmbeddingDocument[]> {
  const pending = (db: Database) => {
    if (!exists(db)) return undefined;
    return db.query<{ path: string; stamp: string; text: string; card: string | null }, [string, number]>(`
      SELECT n.path, ${stamp} AS stamp, n.search_text AS text,
        (SELECT group_concat(c.search_text,char(10)) FROM notes c WHERE c.host_path=n.path AND c.private=0) AS card
      FROM notes n LEFT JOIN knowledge_vectors v ON v.path=n.path AND v.profile=?
      WHERE ${scope} AND (v.stamp IS NULL OR v.stamp!=${stamp}) ORDER BY n.mtime DESC,n.path LIMIT ?
    `).all(profile, limit).map(row => ({ path: row.path, stamp: row.stamp, text: [row.text, row.card].filter(Boolean).join("\n\n").slice(0, 6_000) }));
  };
  return await readIndex(root, options, pending).catch(() => undefined) ?? withIndex(root, options, db => {
    db.exec(table);
    return pending(db)!;
  });
}

export function unitVector(values: readonly number[]): Float32Array | undefined {
  if (!values.length || values.length > 8192 || !values.every(Number.isFinite)) return;
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return;
  return Float32Array.from(values, value => value / norm);
}

export async function saveEmbeddings(root: string, options: IndexOptions, profile: string, batch: readonly { document: EmbeddingDocument; vector: Float32Array }[]) {
  await withIndex(root, options, db => {
    db.exec(table);
    db.transaction(() => {
      db.query("DELETE FROM knowledge_vectors WHERE path NOT IN (SELECT path FROM notes WHERE private=0 AND host_path IS NULL)").run();
      const put = db.query(`INSERT INTO knowledge_vectors(profile,path,stamp,vector)
        SELECT ?,n.path,?,? FROM notes n WHERE n.path=? AND ${scope} AND ${stamp}=?
        ON CONFLICT(profile,path) DO UPDATE SET stamp=excluded.stamp,vector=excluded.vector`);
      for (const { document, vector } of batch) put.run(profile, document.stamp, new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), document.path, document.stamp);
    })();
  });
}

export const embeddingNamespace = (...values: (string | number)[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex");

export async function semanticHits(root: string, options: IndexOptions, profile: string, query: Float32Array,
  type: SearchHit["note"]["type"] | undefined, limit: number): Promise<SearchHit[]> {
  return readIndex(root, options, db => {
    if (!exists(db)) return [];
    const rows = db.query<NoteRow & { vector: Uint8Array }, [string, string | null, string | null]>(`
      SELECT n.*,v.vector FROM knowledge_vectors v JOIN notes n ON n.path=v.path
      WHERE v.profile=? AND ${scope} AND v.stamp=${stamp} AND (? IS NULL OR n.type=?)
    `).all(profile, type ?? null, type ?? null);
    return rows.flatMap(row => {
      if (row.vector.byteLength !== query.byteLength) return [];
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      let similarity = 0;
      for (let i = 0; i < query.length; i++) similarity += query[i]! * view.getFloat32(i * 4, true);
      if (!Number.isFinite(similarity) || similarity < 0.26) return [];
      return [{ row, similarity }];
    }).sort((a, b) => b.similarity - a.similarity || a.row.path.localeCompare(b.row.path)).slice(0, limit).map(({ row }) => {
      const fm = JSON.parse(row.frontmatter);
      return { note: noteRef(row), snippet: snippet(row.search_text, ""), matched_in: "semantic" as const,
        status: row.type === "paper" || row.type === "source" ? ReadingStatus.safeParse(fm.status ?? "to-read").data ?? null : null,
        created: Timestamp.safeParse(fm.created).data ?? null };
    });
  });
}

export function fuseSearch(lexical: SearchResult, semantic: SearchHit[], limit: number): SearchResult {
  if (!semantic.length) return { ...lexical, hits: lexical.hits.slice(0, limit) };
  const byPath = new Map<string, { hit: SearchHit; score: number }>();
  lexical.hits.forEach((hit, rank) => byPath.set(hit.note.path, { hit, score: 1 / (61 + rank) }));
  semantic.forEach((hit, rank) => {
    const previous = byPath.get(hit.note.path);
    byPath.set(hit.note.path, { hit: previous?.hit ?? hit, score: (previous?.score ?? 0) + 1 / (61 + rank) });
  });
  return { ...lexical, total: Math.max(lexical.total, byPath.size),
    hits: [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ hit }) => hit) };
}
