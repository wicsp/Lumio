import { randomBytes } from "node:crypto";
import { AI_NOTE_CAPABILITY_NAMES, Id, type KnowledgeAiNoteCommand } from "@lumio/schema";
import { CoreError, newId } from "@lumio/foundation";
import { KnowledgeCreationStore, KnowledgeEditingStore, openVaultGit, updateIndex } from "@lumio/storage";
import type { HubConfig } from "./config.ts";
import type { HubStore, Identity } from "./store.ts";
import { HubError } from "./errors.ts";
import { assertNoteVisible } from "./trash.ts";
import { text as msg } from "./messages.ts";
import type { ConversationSource, Resources } from "./resources.ts";

export class AiNotes {
  private readonly creations: KnowledgeCreationStore;
  private readonly edits: KnowledgeEditingStore;

  constructor(private config: HubConfig, private store: HubStore, private resources: Resources,
    private exclusive: <T>(action: () => Promise<T>) => Promise<T>,
    private issue: (path: string, message: string) => void, private now: () => Date) {
    this.creations = new KnowledgeCreationStore(store.db, config.vault);
    this.edits = new KnowledgeEditingStore(store.db, config.vault, { stateDir: config.stateDir });
  }

  async execute(input: KnowledgeAiNoteCommand, identity: Identity, conversation?: ConversationSource) {
    const { operation, request_id } = input, actor = identity.actor.id;
    const currentSource = conversation?.message ?? identity.job;
    const validateSources = async (sources: readonly string[]) => {
      for (const source of new Set(sources)) {
        if (Id.safeParse(source).success && (await this.resources.resolve(source, identity, { conversation })).status !== "visible")
          throw new HubError("FORBIDDEN", { key: "knowledge.ai_note_source_unavailable", args: [] }, { reason: "source-unavailable" });
      }
    };
    const finalize = async (path: string, bytes: Buffer, writer = actor) => {
      await updateIndex(this.config.vault, { stateDir: this.config.stateDir });
      const git = await openVaultGit(this.config.vault);
      if (git) try {
        await git.add(path, bytes);
        await git.commit([path], "lumio: save AI note", { "Lumio-Actor": writer, ...(identity.job && writer === actor ? { "Lumio-Job": identity.job } : {}) });
      } catch (cause) {
        this.issue(path, msg("knowledge.commit_failed"));
        throw cause;
      }
    };
    try {
      return await this.exclusive(async () => {
        const now = this.now();
        const audit = (target: string) => this.store.audit(identity, operation.op, "allow", undefined, `applied:${target}`);
        if (operation.op === AI_NOTE_CAPABILITY_NAMES[0]) {
          await validateSources([...(operation.args.derived_from ?? []), ...(currentSource ? [currentSource] : [])]);
          return this.creations.createAiNote(actor, request_id, operation.args, { now, newId: prefix => newId(prefix, now, randomBytes), tz: "UTC" }, {
            finalize: (result, bytes) => finalize(result.note.path, bytes),
            audit: result => audit(result.note.id!),
          }, currentSource);
        }
        assertNoteVisible(this.store.db, operation.args.note);
        return this.edits.updateAiNote(actor, request_id, operation.args, {
          now, validateSources,
          finalize: (document, bytes, writer) => finalize(document.note.path, bytes, writer),
          audit: (document, writer) => {
            if (writer === actor) audit(document.note.id!);
            else {
              this.store.audit(this.store.recoveryIdentity(writer), "knowledge.update", "allow", undefined, `recovered:${document.note.id}`);
            }
          },
        }, currentSource);
      });
    } catch (cause) {
      const known = cause instanceof CoreError ? this.fileError(cause) : cause instanceof HubError ? cause : undefined;
      this.store.audit(identity, operation.op, known?.code === "FORBIDDEN" ? "deny" : "allow", undefined, known?.code ?? "INTERNAL");
      if (known) throw known;
      throw new HubError("INTERNAL", { key: "editing.uncertain", args: [] }, { reason: "save_uncertain" });
    }
  }

  private fileError(cause: CoreError): HubError | undefined {
    if (["REVISION_CONFLICT", "REQUEST_CONFLICT", "NOTE_RECOVERY_CONFLICT", "FILE_EXISTS"].includes(cause.code))
      return new HubError("CONFLICT", { key: "editing.revision_conflict", args: [] }, { reason: cause.code.toLowerCase() });
    if (["NOTE_NOT_EDITABLE", "UNSAFE_NOTE_PATH", "NOTE_NOT_FOUND", "INVALID_FRONTMATTER", "INVALID_NOTE_DIRECTORY", "NOTE_NOT_CREATED"].includes(cause.code))
      return new HubError("INVALID", { key: "editing.not_editable", args: [] }, { reason: "note_not_editable" });
  }
}
