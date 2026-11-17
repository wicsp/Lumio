import { type AssistantTool } from "@lumio/assistant";
import { DerivedFrom, Idea, idOf, toolName, type AssistantMessage, type AssistantTurn, type Glance } from "@lumio/schema";
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

  async record(owner: string, turn: AssistantTurn, user: AssistantMessage, glanceId: string): Promise<string> {
    if (!this.config.vault) throw new HubError("INVALID", { key: "knowledge.no_vault", args: [] });
    const glance = this.glances.get(glanceId, owner);
    if (glance.used_by.message !== user.id) throw unavailable();
    const source = await this.source(glance);
    const origin = DerivedFrom.safeParse(glance.url);
    const sources = [...new Set([user.id, ...(source ? [source] : []), ...(origin.success ? [origin.data] : [])])];
    const sections = [user.content];
    const excerpt = glance.selection_text ?? glance.pointing.text;
    if (excerpt?.trim()) sections.push(`## ${text("voice_idea.selected_passage")}\n\n${excerpt.split(/\r?\n/u).map(line => `> ${line}`).join("\n")}`);
    const links = [source ? `[${text("voice_idea.source")}](lumio:${source})` : undefined,
      origin.success ? `<${encodeURI(origin.data)}>` : undefined, `[${text("voice_idea.discussion")}](lumio:${user.id})`];
    const window = [glance.app.name, glance.window_title].filter(Boolean).join(" · ");
    sections.push(`## ${text("voice_idea.source")}\n\n${window}\n\n${links.filter(Boolean).join("\n\n")}`);
    const note = await this.authoring.create(this.store.recoveryIdentity(owner), {
      request_id: turn.id, note: { kind: "idea", tags: [], derived_from: sources }, body: sections.join("\n\n") + "\n",
    }, new Date(user.created));
    return note.id;
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
