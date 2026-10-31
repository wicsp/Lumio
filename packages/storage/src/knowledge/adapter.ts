import { readFile } from "node:fs/promises";
import { CoreError } from "@lumio/foundation";
import { parseFrontmatter, type KnowledgeRepository, type KnowledgeQueryOptions, type NewNote } from "@lumio/knowledge";
import { searchNotes, showNote, noteLinks, checkLinks } from "./index/query.ts";
import type { IndexOptions } from "./index/store.ts";
import { saveNewNote } from "./create.ts";
import { scanVault } from "./vault.ts";

export class FileKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly root: string, private readonly index: IndexOptions = {}) {}
  search(query: string, options: KnowledgeQueryOptions) { return searchNotes(this.root, query, { ...this.index, ...options }); }
  show(reference: string, options: KnowledgeQueryOptions) { return showNote(this.root, reference, { ...this.index, ...options }); }
  links(reference: string, options: KnowledgeQueryOptions) { return noteLinks(this.root, reference, { ...this.index, ...options }); }
  check(options: KnowledgeQueryOptions) { return checkLinks(this.root, { ...this.index, ...options }); }
  saveNew(note: NewNote) { return saveNewNote(this.root, note); }
  async papers() {
    const papers: { path: string; frontmatter: Record<string, unknown> }[] = [];
    for (const file of await scanVault(this.root, ["paper"])) {
      try { papers.push({ path: file.relativePath, frontmatter: parseFrontmatter(await readFile(file.path)).data }); }
      catch (cause) { throw new CoreError("DUPLICATE_CHECK_FAILED", `无法检查已有论文：${file.relativePath}，请先修复该文件`, { cause }); }
    }
    return papers;
  }
}
