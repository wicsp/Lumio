import { type AssistantTool } from "@lumio/assistant";
import { DerivedFrom, Idea, idOf, toolName, type AssistantMessage, type AssistantTurn, type Glance, type GlanceContextRetention } from "@lumio/schema";
import { FileKnowledgeRepository, noteById, readKnowledgeDocument, type SqliteAssistantStore } from "@lumio/storage";
import { parsePaperInput } from "@lumio/knowledge";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { Glances } from "./glances.ts";
import type { KnowledgeAuthoring } from "./knowledge-authoring.ts";
import { text } from "./messages.ts";
import type { HubStore } from "./store.ts";
import { assertNoteVisible } from "./trash.ts";

const ideaId = idOf("idea");
const unavailable = () => new HubError("NOT_FOUND", { key: "voice_idea.discussion_unavailable", args: [] });
const normalizedTitle = (value: string) => value.replace(/\.pdf$/i, "").normalize("NFKC").trim().toLowerCase();

export class VoiceIdeas {
  constructor(private readonly config: HubConfig, private readonly store: HubStore, private readonly assistant: SqliteAssistantStore,
    private readonly glances: Glances, private readonly authoring: KnowledgeAuthoring) {}

  private async source(glance: Glance): Promise<string | undefined> {
    if (glance.lumio?.module === "knowledge") {
      const note = await noteById(this.config.vault, glance.lumio.id, { stateDir: this.config.stateDir }).catch(() => undefined);
      return note?.id;
    }
    if (!glance.url && !glance.window_title) return;
    const papers = await new FileKnowledgeRepository(this.config.vault, { stateDir: this.config.stateDir }).papers().catch(() => []);
    let identifier: ReturnType<typeof parsePaperInput> | undefined;
    try { if (glance.url) identifier = parsePaperInput(glance.url); } catch { /* A regular webpage or PDF viewer. */ }
    const matches = papers.filter(({ frontmatter: note }) => {
      if (glance.url && note.url === glance.url) return true;
      if (identifier?.kind === "arxiv" && typeof note.arxiv === "string" && note.arxiv.split("v")[0] === identifier.id.split("v")[0]) return true;
      if (identifier?.kind === "doi" && typeof note.doi === "string" && note.doi.toLowerCase() === identifier.doi.toLowerCase()) return true;
      return typeof note.title === "string" && !!glance.window_title && normalizedTitle(note.title) === normalizedTitle(glance.window_title);
    });
    return matches.length === 1 && typeof matches[0]!.frontmatter.id === "string" ? matches[0]!.frontmatter.id : undefined;
  }

  private body(user: AssistantMessage): string {
    return `${user.content}\n\n[Lumio](lumio:${user.id})\n`;
  }

  async record(owner: string, turn: AssistantTurn, user: AssistantMessage, glanceId: string): Promise<string> {
    if (!this.config.vault) throw new HubError("INVALID", { key: "knowledge.no_vault", args: [] });
    if (this.glances.get(glanceId, owner).used_by.message !== user.id) throw unavailable();
    const note = await this.authoring.create(this.store.recoveryIdentity(owner), {
      request_id: turn.id, note: { kind: "idea", tags: [], derived_from: [user.id] }, body: this.body(user),
    }, new Date(user.created));
    return note.id;
  }

  async finish(owner: string, glanceId: string, messageId: string, decision?: GlanceContextRetention): Promise<void> {
    const user = this.assistant.message(messageId);
    if (!user || this.assistant.conversation(user.conversation)?.owner !== owner) throw unavailable();
    const glance = await this.glances.retainContext(glanceId, owner, messageId, decision);
    const turn = user.turn ? this.assistant.turn(user.turn) : undefined;
    if (turn && !glance.context_retention?.source) {
      this.store.db.transaction(() => {
        for (const message of this.assistant.messages(user.conversation).filter(message => message.turn === turn.id)) {
          this.assistant.replaceMessageAnchors(message.id, turn.idea ? [{ module: "knowledge", id: turn.idea }] : []);
        }
      })();
    }
    await this.enrich(owner, turn, user, glance);
    this.glances.completeContext(glanceId, owner, messageId);
  }

  private async enrich(owner: string, turn: AssistantTurn | undefined, user: AssistantMessage, glance: Glance): Promise<void> {
    if (!turn?.idea || glance.context_retention?.status !== "retained" || !this.config.vault) return;
    const retained = glance.context_retention;
    const current = await readKnowledgeDocument(this.config.vault, turn.idea, { stateDir: this.config.stateDir });
    // Human edits win. The separate retained Glance remains linked by this message.
    if (current.document.body !== this.body(user)) return;
    const sections = [this.body(user).trimEnd()];
    if (retained.text.length) sections.push(`## ${text("voice_idea.selected_passage")}\n\n${retained.text.join("\n\n").split(/\r?\n/u).map(line => `> ${line}`).join("\n")}`);
    if (retained.source) {
      const source = await this.source(glance);
      const origin = DerivedFrom.safeParse(glance.url);
      const window = [glance.app.name, glance.window_title].filter(Boolean).join(" · ");
      const links = [source ? `[${text("voice_idea.source")}](lumio:${source})` : undefined, origin.success ? `<${encodeURI(origin.data)}>` : undefined].filter(Boolean);
      sections.push(`## ${text("voice_idea.source")}\n\n${[window, ...links].filter(Boolean).join("\n\n")}`);
    }
    const body = sections.join("\n\n") + "\n";
    if (body === current.document.body) return;
    try {
      await this.authoring.update(this.store.recoveryIdentity(owner), turn.idea, {
        request_id: `${turn.id}-context`, expected_revision: current.revision, title: current.document.note.title!, body,
      }, new Date());
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "REVISION_CONFLICT") return;
      throw cause;
    }
  }

  async recoverPending(): Promise<void> {
    for (const pending of this.glances.pendingContexts()) {
      const message = this.assistant.message(pending.message);
      if (!message) {
        await this.glances.retainContext(pending.id, pending.owner, pending.message);
        this.glances.completeContext(pending.id, pending.owner, pending.message);
      } else if (!message.turn || this.assistant.turn(message.turn)?.status !== "running") {
        await this.finish(pending.owner, pending.id, pending.message);
      }
    }
  }

  static tool(current: () => VoiceIdeas): AssistantTool {
    return {
      effect: "read",
      spec: { name: toolName("knowledge.idea.discussion"), description: "Read the owner's original discussion and follow-up replies for a saved voice idea. Search knowledge for the idea ID first.",
        input_schema: { type: "object", properties: { idea: { type: "string" } }, required: ["idea"], additionalProperties: false } },
      execute: async (args, context) => {
        const self = current();
        const id = ideaId.safeParse(args.idea);
        if (!id.success || !self.config.vault) throw unavailable();
        assertNoteVisible(self.store.db, id.data);
        const { document } = await readKnowledgeDocument(self.config.vault, id.data, { stateDir: self.config.stateDir });
        const parsed = Idea.safeParse(document.frontmatter);
        const origin = parsed.success ? parsed.data.derived_from?.find(ref => ref.startsWith("amsg_")) : undefined;
        const message = origin ? self.assistant.message(origin) : undefined;
        const turn = message?.turn ? self.assistant.turn(message.turn) : undefined;
        if (!message || !turn || turn.idea !== id.data || self.assistant.conversation(message.conversation)?.owner !== context.owner || self.assistant.trash(message.conversation)) throw unavailable();
        const anchors = self.assistant.messageAnchors(message.conversation);
        const following = self.assistant.messages(message.conversation).filter(item => item.created >= message.created);
        const start = following.findIndex(item => item.id === message.id);
        if (start < 0) throw unavailable();
        const discussion = [];
        for (const item of following.slice(start)) {
          if (item.role === "user" && item.id !== message.id && !anchors.get(item.id)?.some(ref => ref.id === id.data)) break;
          if ((item.role === "user" || item.role === "assistant") && item.turn && !self.assistant.calls(item.turn).some(call => call.private_read)) {
            discussion.push({ role: item.role, message: item.id, content: item.content.slice(0, 2000) });
          }
          if (discussion.length >= 12) break;
        }
        return { idea: id.data, discussion };
      },
    };
  }
}
