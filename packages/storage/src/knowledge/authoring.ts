import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { KnowledgeAiNoteCreateArgs, KnowledgeAiNoteResult, KnowledgeCreateRequest, KnowledgeCreateResult, RequestId } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { duplicatePaper, renderAiNote, renderKnowledgeNote, type FillContext, type NewNote } from "@lumio/knowledge";
import { FileKnowledgeRepository } from "./adapter.ts";
import { saveNewNote } from "./create.ts";

interface Receipt { actor: string; request_id: string; fingerprint: string; vault: string; path: string; content: string; result: string; ready: number; published: number }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function conflict(code: string): never { throw new CoreError(code, { key: "create.could_not_create_note_check_that_vault_directory_exists_and_is_writa", args: [] }); }

interface CreationHooks<Result> {
  validate(note: NewNote): void;
  published?(result: Result): Promise<void>;
  finalize(result: Result, content: Buffer): Promise<void>;
  audit(result: Result): void;
}

/** Journal lives in hub.sqlite and is backed up with business state; Markdown remains authoritative. */
export class KnowledgeCreationStore {
  constructor(private db: Database, private vault: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_creations (
      actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, vault TEXT NOT NULL,
      path TEXT NOT NULL, content TEXT NOT NULL, result TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(actor, request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_creation_pending_path ON knowledge_creations(vault,path) WHERE ready=0;`);
  }
  private get(actor: string, request: string): Receipt | null {
    return this.db.query<Receipt, [string, string]>("SELECT * FROM knowledge_creations WHERE actor=? AND request_id=?").get(actor, request);
  }
  /** Reads never follow a substituted note or type directory during recovery. */
  private async existing(path: string): Promise<Buffer | undefined> {
    let current = this.vault;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) conflict("UNSAFE_NOTE_PATH");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
    return readFile(current);
  }
  async create(actor: string, input: KnowledgeCreateRequest, ctx: FillContext, hooks: CreationHooks<KnowledgeCreateResult>): Promise<KnowledgeCreateResult> {
    const request = KnowledgeCreateRequest.parse(input);
    const paper = request.note.kind === "paper" ? request.note : undefined;
    const suffixes = paper ? ["", ..."bcdefghijklmnopqrstuvwxyz"] : [""];
    return this.save(actor, request.request_id, digest(JSON.stringify(request)), hooks, {
      parse: KnowledgeCreateResult.parse,
      suffixes,
      render: suffix => renderKnowledgeNote(request, ctx, suffix),
      checkDuplicates: paper && (async root => {
        const files = await new FileKnowledgeRepository(this.vault).papers();
        const pending = this.db.query<{ result: string }, [string]>("SELECT result FROM knowledge_creations WHERE vault=? AND ready=0").all(root);
        if (duplicatePaper(paper, [...files, ...pending.map(row => ({ frontmatter: JSON.parse(row.result).metadata ?? {} }))])) conflict("DUPLICATE_PAPER");
      }),
    });
  }

  async createAiNote(
    actor: string, requestId: string, input: KnowledgeAiNoteCreateArgs,
    ctx: FillContext, hooks: CreationHooks<KnowledgeAiNoteResult>, currentSource?: string,
  ): Promise<KnowledgeAiNoteResult> {
    const request = KnowledgeAiNoteCreateArgs.parse(input);
    const fingerprint = digest(JSON.stringify({ operation: "knowledge.ainote.create", request, currentSource }));
    return this.save(actor, RequestId.parse(requestId), fingerprint, hooks, {
      parse: KnowledgeAiNoteResult.parse,
      suffixes: [""],
      render: () => {
        const rendered = renderAiNote(actor, request, ctx, currentSource);
        return { ...rendered, result: KnowledgeAiNoteResult.parse({ note: rendered.note, revision: digest(rendered.content) }) };
      },
    });
  }

  /** Hub serializes this with its vault watcher. A prepared receipt survives any later failure. */
  private async save<Result>(
    actor: string, requestId: string, fingerprint: string, hooks: CreationHooks<Result>,
    operation: {
      parse(value: unknown): Result;
      suffixes: string[];
      render(suffix: string): NewNote & { result: Result };
      checkDuplicates?(root: string): Promise<void>;
    },
  ): Promise<Result> {
    let row = this.get(actor, requestId);
    let root: string;
    try { root = await realpath(this.vault); }
    catch { conflict(row ? "NOTE_RECOVERY_CONFLICT" : "NOTE_NOT_CREATED"); }
    if (row && (row.fingerprint !== fingerprint || row.vault !== root)) conflict("REQUEST_CONFLICT");
    if (row && row.ready < 0) conflict("NOTE_RECOVERY_CONFLICT");
    if (row?.ready === 1) return operation.parse(JSON.parse(row.result));
    if (!row) {
      // Creations are serialized, so any pending receipt here is interrupted. A missing file (deleted after publication,
      // or never written) cannot be recovered: retain the receipt, release its path reservation.
      for (const pending of this.db.query<Receipt, [string]>("SELECT * FROM knowledge_creations WHERE vault=? AND ready=0").all(root)) {
        try {
          if (!(await this.existing(pending.path))) this.db.query("UPDATE knowledge_creations SET ready=-1 WHERE actor=? AND request_id=?").run(pending.actor, pending.request_id);
        } catch { /* An unrelated unsafe file stays reserved for manual inspection. */ }
      }
      await operation.checkDuplicates?.(root);
      for (const suffix of operation.suffixes) {
        const rendered = operation.render(suffix);
        hooks.validate(rendered);
        if (await this.existing(rendered.relativePath)) continue;
        const occupied = this.db.query("SELECT 1 FROM knowledge_creations WHERE vault=? AND path=? AND ready=0").get(root, rendered.relativePath);
        if (occupied) continue;
        this.db.query("INSERT INTO knowledge_creations(actor,request_id,fingerprint,vault,path,content,result) VALUES (?,?,?,?,?,?,?)")
          .run(actor, requestId, fingerprint, root, rendered.relativePath, rendered.content.toString("utf8"), JSON.stringify(rendered.result));
        row = this.get(actor, requestId)!; break;
      }
      if (!row) conflict("FILE_EXISTS");
    }
    const result = operation.parse(JSON.parse(row.result));
    const note = { relativePath: row.path, content: Buffer.from(row.content) };
    hooks.validate(note);
    let bytes: Buffer | undefined;
    try { bytes = await this.existing(row.path); }
    catch { conflict("NOTE_RECOVERY_CONFLICT"); }
    if (!bytes && row.published) {
      this.db.query("UPDATE knowledge_creations SET ready=-1 WHERE actor=? AND request_id=?").run(actor, requestId);
      conflict("NOTE_RECOVERY_CONFLICT");
    }
    if (bytes && !bytes.equals(note.content)) conflict("NOTE_RECOVERY_CONFLICT");
    if (!bytes) {
      try { await saveNewNote(this.vault, note); }
      catch (cause) {
        let current: Buffer | undefined;
        try { current = await this.existing(row.path); }
        catch { conflict("NOTE_RECOVERY_CONFLICT"); }
        if (!current || !current.equals(note.content)) {
          this.db.query("UPDATE knowledge_creations SET ready=-1 WHERE actor=? AND request_id=?").run(actor, requestId);
          if (cause instanceof CoreError && cause.code === "FILE_EXISTS") throw cause;
          conflict("NOTE_NOT_CREATED");
        }
        throw new CoreError("NOTE_SAVE_UNCERTAIN", { key: "create.could_not_create_note_check_that_vault_directory_exists_and_is_writa", args: [] }, { cause });
      }
    }
    // From here, failure means possibly saved. Never issue a second note on a retry.
    try {
      this.db.query("UPDATE knowledge_creations SET published=1 WHERE actor=? AND request_id=?").run(actor, requestId);
      await hooks.published?.(result);
      await hooks.finalize(result, note.content);
      this.db.transaction(() => {
        hooks.audit(result);
        this.db.query("UPDATE knowledge_creations SET ready=1 WHERE actor=? AND request_id=?").run(actor, requestId);
      })();
    } catch (cause) {
      throw new CoreError("NOTE_SAVE_UNCERTAIN", { key: "create.could_not_create_note_check_that_vault_directory_exists_and_is_writa", args: [] }, { cause });
    }
    return result;
  }
}
