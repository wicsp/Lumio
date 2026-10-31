import { CheckResult, LinksResult, NoteDetail, SearchResult, type NoteRef } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import type { FillContext } from "./fill.ts";
import { renderIdea, type NewNote } from "./create.ts";
import { renderPaper } from "./paper.ts";
import type { PaperMetadata } from "./paper-metadata.ts";
import { parsePaperInput } from "./paper-input.ts";
import { isPrivateType } from "./layout.ts";

export interface KnowledgeQueryOptions { includePrivate?: boolean; type?: NoteRef["type"]; limit?: number }
export interface KnowledgeRepository {
  search(query: string, options: KnowledgeQueryOptions): Promise<SearchResult>;
  show(reference: string, options: KnowledgeQueryOptions): Promise<NoteDetail>;
  links(reference: string, options: KnowledgeQueryOptions): Promise<LinksResult>;
  check(options: KnowledgeQueryOptions): Promise<CheckResult>;
  saveNew(note: NewNote): Promise<string>;
  papers(): Promise<{ path: string; frontmatter: Record<string, unknown> }[]>;
}
function identity(value: unknown, kind: "arxiv" | "doi"): string | undefined {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const parsed = parsePaperInput(value);
    if (parsed.kind !== kind) return;
    return parsed.kind === "arxiv" ? parsed.id.toLowerCase() : parsed.doi.toLowerCase();
  } catch { return value.trim().toLowerCase(); }
}

/** Knowledge owns validation and creation rules; repositories own filesystem and index operations. */
export class KnowledgeService {
  constructor(private readonly repository: KnowledgeRepository) {}
  private visible(notes: NoteRef[], options: KnowledgeQueryOptions): void {
    if (!options.includePrivate && notes.some((note) => isPrivateType(note.type))) throw new CoreError("INVALID_QUERY_RESULT", "查询返回了不可见的知识条目");
  }
  async search(query: string, options: KnowledgeQueryOptions = {}): Promise<SearchResult> {
    if (query && !query.trim()) throw new CoreError("INVALID_QUERY", "查询不能只包含空白");
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new CoreError("INVALID_LIMIT", "limit 必须是正整数");
    const result = SearchResult.parse(await this.repository.search(query, options));
    this.visible(result.hits.map((hit) => hit.note), options); return result;
  }
  async show(reference: string, options: KnowledgeQueryOptions = {}): Promise<NoteDetail> {
    const result = NoteDetail.parse(await this.repository.show(reference, options));
    this.visible([result.note], options); return result;
  }
  async links(reference: string, options: KnowledgeQueryOptions = {}): Promise<LinksResult> {
    const result = LinksResult.parse(await this.repository.links(reference, options));
    this.visible([result.note, ...result.outgoing.flatMap((link) => link.note ? [link.note] : []), ...result.incoming.map((link) => link.note)], options);
    return result;
  }
  async check(options: KnowledgeQueryOptions = {}): Promise<CheckResult> {
    const result = CheckResult.parse(await this.repository.check(options));
    this.visible(result.dangling.map((link) => link.from), options); return result;
  }
  async createIdea(title: string, context: FillContext): Promise<string> { return this.repository.saveNew(renderIdea(title, context)); }
  async createPaper(metadata: PaperMetadata, citekey: string, bibtex: string, context: FillContext): Promise<string> {
    let note = renderPaper(metadata, citekey, bibtex, context);
    const arxiv = identity(metadata.arxiv, "arxiv"), doi = identity(metadata.doi, "doi");
    const checkDuplicate = async () => {
      for (const file of await this.repository.papers()) {
        if ((arxiv && identity(file.frontmatter.arxiv, "arxiv") === arxiv) || (doi && identity(file.frontmatter.doi, "doi") === doi)) {
          throw new CoreError("DUPLICATE_PAPER", `该论文已存在：${file.path}`);
        }
      }
    };
    try {
      await checkDuplicate();
      for (const suffix of ["", ..."bcdefghijklmnopqrstuvwxyz"]) {
        if (suffix) note = renderPaper(metadata, citekey + suffix, bibtex, context);
        try { return await this.repository.saveNew(note); }
        catch (cause) { if (!(cause instanceof CoreError) || cause.code !== "FILE_EXISTS") throw cause; await checkDuplicate(); }
      }
      throw new CoreError("CITEKEY_EXHAUSTED", `citekey ${citekey} 及后缀 b 到 z 已全部占用`);
    } catch (cause) {
      if (cause instanceof CoreError) throw cause;
      throw new CoreError("CREATE_FAILED", "无法创建论文笔记", { cause });
    }
  }
}
