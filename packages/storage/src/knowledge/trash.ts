import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { CoreError } from "@lumio/foundation";
import { isVaultNotePath, parseFrontmatter } from "@lumio/knowledge";
import { textContainsCardNumber } from "@lumio/schema";
import { openVaultGit } from "./git.ts";
import { showNote } from "./index/query.ts";
import { updateIndex, type IndexOptions } from "./index/store.ts";
import { vaultFileAt } from "./vault.ts";

export interface NoteTrashMove {
  from: string;
  to?: string;
  revision?: string;
  file?: string;
}

const revisionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const conflict = () => new CoreError("REVISION_CONFLICT", { key: "write.file_changed_during_processing_run_again", args: [] });
const identityOf = (file: { dev: bigint; ino: bigint }) => `${file.dev}:${file.ino}`;
const missing = () => new CoreError("NOTE_NOT_FOUND", { key: "query.note_not_found_candidates_none", args: [] });

export class KnowledgeTrashFiles {
  constructor(private readonly root: string, private readonly options: IndexOptions) {}

  async deletion(id: string, revision: string) {
    const { note } = await showNote(this.root, id, { ...this.options, includePrivate: true });
    if (note.id !== id) throw missing();
    const file = await vaultFileAt(this.root, note.path);
    if (!file || file.private || ["task", "project", "routine"].includes(file.type)) {
      throw new CoreError("NOTE_NOT_EDITABLE", { key: "query.note_not_found_candidates_none", args: [] });
    }
    const to = await this.available(`.trash/${note.path}`);
    return { note, move: await this.prepare(note.path, to, id, revision) };
  }

  async restoration(id: string, from: string, original: string): Promise<NoteTrashMove> {
    return this.prepare(from, await this.available(original), id);
  }

  async removal(id: string, from: string): Promise<NoteTrashMove> {
    return await this.entry(from) ? this.prepare(from, undefined, id) : { from };
  }

  private async prepare(from: string, to: string | undefined, id: string, expected?: string): Promise<NoteTrashMove> {
    const file = await this.entry(from);
    if (!file?.isFile()) throw conflict();
    const bytes = await readFile(join(this.root, from));
    const revision = revisionOf(bytes);
    if ((expected && expected !== revision) || parseFrontmatter(bytes).data.id !== id) throw conflict();
    return { from, to, revision, file: identityOf(file) };
  }

  private async entry(path: string, createParents = false) {
    const relative = path.startsWith(".trash/") ? path.slice(".trash/".length) : path;
    if (!isVaultNotePath(relative)) throw conflict();
    let current = this.root;
    const parts = path.split("/");
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (createParents) await mkdir(current).catch(cause => {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      });
      const info = await this.stat(current);
      if (!info) return;
      if (!info.isDirectory()) throw conflict();
    }
    return this.stat(join(current, parts.at(-1)!));
  }

  private async stat(path: string) {
    try { return await lstat(path, { bigint: true }); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }

  private async available(path: string): Promise<string> {
    const extension = extname(path);
    const stem = path.slice(0, -extension.length);
    let candidate = path;
    for (let suffix = 2; await this.entry(candidate); suffix++) candidate = `${stem}-${suffix}${extension}`;
    return candidate;
  }

  /** The journal stores the inode before linking so replay can recognize a move interrupted between link and unlink. */
  async apply(move: NoteTrashMove): Promise<void> {
    const from = join(this.root, move.from), to = move.to && join(this.root, move.to);
    const source = await this.entry(move.from);
    const sameFile = (info: typeof source) => info?.isFile() && identityOf(info) === move.file;
    if (to && move.to) {
      const target = await this.entry(move.to, true);
      if (!sameFile(target)) {
        if (target || !sameFile(source) || revisionOf(await readFile(from)) !== move.revision) throw conflict();
        try { await link(from, to); }
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
          throw cause;
        }
      }
    }
    if (sameFile(source)) {
      if (revisionOf(await readFile(from)) !== move.revision) throw conflict();
      await unlink(from);
    } else if (source && !to) throw conflict();
    await updateIndex(this.root, this.options);
  }

  async canAbandon(move: NoteTrashMove): Promise<boolean> {
    const from = await this.entry(move.from);
    const to = move.to ? await this.entry(move.to) : undefined;
    return !!from?.isFile() && identityOf(from) === move.file && (!to || identityOf(to) !== move.file);
  }

  async commit(move: NoteTrashMove, actor?: string): Promise<void> {
    const git = await openVaultGit(this.root);
    if (!git) return;
    const changed = await git.changedFiles();
    const paths: string[] = [];
    if (changed.includes(move.from) && !await this.entry(move.from)) {
      await git.add(move.from, null, move.from.startsWith(".trash/"));
      paths.push(move.from);
    }
    if (move.to) {
      const entry = await this.entry(move.to);
      if (entry?.isFile() && identityOf(entry) === move.file) {
        const bytes = await readFile(join(this.root, move.to));
        if (!textContainsCardNumber(bytes.toString("utf8"))) {
          await git.add(move.to, bytes, true);
          paths.push(move.to);
        }
      }
    }
    await git.commit(paths, "lumio: update knowledge trash", actor ? { "Lumio-Actor": actor } : undefined);
  }
}
