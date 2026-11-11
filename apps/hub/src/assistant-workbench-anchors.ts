import type { AssistantAnchorResource, AssistantWorkbenchContext, AssistantWorkbenchScope } from "@lumio/assistant";
import {
  Job, LinksResult, MODULE_ID_PREFIXES, NoteDetail, ResourceRef, WorkProject, WorkTaskDetail,
  toolName, type ActorRole, type AssistantConversation, type WorkComment,
} from "@lumio/schema";
import type { AssistantMainConversations } from "./assistant-main.ts";
import type { SqliteAssistantStore, SqliteRoutineStore, SqliteWorkStore } from "@lumio/storage";
import type { Capabilities } from "./capabilities.ts";
import type { ConversationSource, Resources } from "./resources.ts";
import type { HubStore, Identity } from "./store.ts";

interface Modules {
  assistantStore: SqliteAssistantStore;
  capabilities: Capabilities;
  resources: Resources;
  routineStore: SqliteRoutineStore;
  workStore: SqliteWorkStore;
}
const readCapabilities = ["work.task.show", "work.project.show", "execution.job.show", "knowledge.note.show"] as const;
type ReadCapability = typeof readCapabilities[number];
type Neighbor = { id: string | undefined; relation: string };

interface ResourceContent {
  title: string;
  summary: string;
  body?: unknown;
  neighbors?: readonly Neighbor[];
}

const readByPrefix: Readonly<Partial<Record<string, { capability: ReadCapability; arg: string }>>> = {
  task: { capability: "work.task.show", arg: "task" },
  prj: { capability: "work.project.show", arg: "project" },
  job: { capability: "execution.job.show", arg: "job" },
};

const prefixOf = (id: string) => id.slice(0, id.indexOf("_"));
const neighbor = (relation: string, id: string | undefined): Neighbor => ({ id, relation });
function reference(id: string): ResourceRef | undefined {
  for (const [module, prefixes] of Object.entries(MODULE_ID_PREFIXES)) {
    if (!(prefixes as readonly string[]).includes(prefixOf(id))) continue;
    const parsed = ResourceRef.safeParse({ module, id });
    return parsed.success ? parsed.data : undefined;
  }
}

function relatedNotes(links: LinksResult): Neighbor[] {
  return [
    ...[...links.outgoing, ...(links.ai_outgoing ?? [])].map(link => neighbor("Reference", link.note?.id)),
    ...[...links.incoming, ...(links.ai_incoming ?? [])].map(link => neighbor("Backlink", link.note.id)),
  ];
}

function summary(text: string | undefined, fallback: string): string {
  return text?.trim().replace(/\s+/gu, " ").slice(0, 240) || fallback;
}

const commentHistoryBytes = 1600;
const commentBodyBytes = 900;
const recentCommentLimit = 5;

function recentComments(comments: WorkComment[], roles: ReadonlyMap<string, ActorRole>) {
  const recent = [];
  let remaining = commentHistoryBytes - 2; // Array brackets.
  for (const comment of comments.slice(-recentCommentLimit).reverse()) {
    const { id, author, created } = comment;
    const entry = { id, author, author_role: roles.get(author) ?? "unknown", created, body: "" };
    const overhead = Buffer.byteLength(JSON.stringify(entry)) + (recent.length ? 1 : 0);
    const budget = Math.min(commentBodyBytes, remaining - overhead);
    let bodyBytes = 0;
    for (const character of comment.body) {
      // Count escaped JSON bytes, and stop at a Unicode code point boundary.
      const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bodyBytes + bytes > budget) break;
      entry.body += character;
      bodyBytes += bytes;
    }
    if (!entry.body) break;
    recent.push(entry);
    remaining -= overhead + bodyBytes;
  }
  return recent.reverse();
}

/** Every automatic resource read is under the internal assistant agent, without private delegation. */
export class AssistantWorkbenchAnchors implements AssistantWorkbenchContext {
  readonly instructions = "When a discussion reaches a conclusion, suggest recording it as an AI note or a task description update. Use the existing tools and approval rules when the user wants it recorded. Do not save unfinished discussion as knowledge or memory.";

  constructor(private readonly modules: Modules, private readonly hub: HubStore, private readonly main: AssistantMainConversations) {}

  isMain(conversation: AssistantConversation): boolean {
    return !conversation.native_session && this.main.isMain(conversation.owner, conversation.id);
  }

  private identity(agent: string): Identity | undefined {
    const actor = this.hub.assistantActor();
    return actor.id === agent ? { actor, label: "assistant-tools" } : undefined;
  }

  private source(scope: AssistantWorkbenchScope): ConversationSource | undefined {
    if (!this.main.isMain(scope.owner, scope.conversation)) return;
    const source = this.modules.resources.conversationSource(scope.owner, scope.turn);
    if (source?.conversation === scope.conversation) return source;
  }

  private async neighbors(ids: ResourceContent["neighbors"], identity: Identity, source: ConversationSource, signal: AbortSignal) {
    const refs = new Map<string, Set<string>>();
    for (const { id, relation } of ids ?? []) {
      if (!id) continue;
      const labels = refs.get(id) ?? new Set<string>();
      labels.add(relation);
      refs.set(id, labels);
      if (refs.size >= 24) break;
    }
    const summaries = await Promise.all([...refs].map(async ([id, labels]) => {
      signal.throwIfAborted();
      const ref = reference(id);
      if (!ref) return;
      const item = await this.modules.resources.resolve(ref.id, identity, { conversation: source });
      if (item.status === "visible") return { ref, summary: [...labels].join(" / ") + ": " + item.title };
    }));
    return summaries.filter(value => value !== undefined);
  }

  async readResource(ref: ResourceRef, agent: string, signal: AbortSignal, scope: AssistantWorkbenchScope): Promise<AssistantAnchorResource | undefined> {
    const identity = this.identity(agent), source = this.source(scope);
    if (!identity || !source) return;
    signal.throwIfAborted();
    const item = await this.modules.resources.resolve(ref.id, identity, { conversation: source });
    if (item.status !== "visible") return;
    const lookup = ref.module === "knowledge" ? { capability: "knowledge.note.show" as const, arg: "ref" } : readByPrefix[prefixOf(ref.id)];
    let content: ResourceContent | undefined;
    if (lookup) {
      const { result } = await this.modules.capabilities.execute(lookup.capability, { [lookup.arg]: ref.id }, identity);
      content = await this.project(lookup.capability, result, identity);
    } else {
      const message = ref.id.startsWith("amsg_") ? this.modules.assistantStore.message(ref.id) : undefined;
      if (message?.turn && this.modules.assistantStore.calls(message.turn).some(call => call.private_read)) return;
      const comment = ref.id.startsWith("wmsg_") ? this.modules.workStore.comment(ref.id) : undefined;
      const routine = ref.id.startsWith("rtn_") ? this.modules.routineStore.get(ref.id) : undefined;
      const body = message?.role === "tool" ? undefined : message?.content ?? comment?.body ?? routine?.description;
      content = { title: item.title, summary: summary(body, item.title), body, neighbors: [neighbor("Parent", item.parent)] };
    }
    if (!content) return;
    return {
      title: content.title,
      summary: content.summary,
      ...(content.body === undefined ? {} : { content: typeof content.body === "string" ? content.body : JSON.stringify(content.body) }),
      related: await this.neighbors(content.neighbors, identity, source, signal),
    };
  }

  async expandReadResult(tool: string, _args: Record<string, unknown>, result: unknown, agent: string, signal: AbortSignal, scope: AssistantWorkbenchScope) {
    const identity = this.identity(agent), source = this.source(scope);
    if (!identity || !source) return result;
    if (tool === toolName("knowledge.note.links")) {
      const links = LinksResult.parse(result);
      return { note: links.note.id, related: await this.neighbors(relatedNotes(links), identity, source, signal) };
    }
    const capability = readCapabilities.find(name => toolName(name) === tool);
    if (!capability) return result;
    const item = await this.project(capability, result, identity);
    if (!item) return result;
    return { item: item.body, related: await this.neighbors(item.neighbors, identity, source, signal) };
  }

  private async project(capability: ReadCapability, result: unknown, identity: Identity): Promise<ResourceContent | undefined> {
    switch (capability) {
      case "work.task.show": {
        const { task, dependents, children, executions, comments, turns } = WorkTaskDetail.parse(result);
        const { id, title, description, revision, outcome, turn, tags, due } = task;
        const roles = new Map(comments.length ? this.hub.actors().map(actor => [actor.id, actor.role]) : []);
        const handoff = turns.at(-1);
        return {
          title, summary: summary(description, title),
          body: {
            id, title, description, revision, outcome, turn: { holder: turn.holder, reason: turn.reason }, tags, due,
            comments: recentComments(comments, roles),
            ...(handoff ? { latest_handoff: {
              at: handoff.at, from: handoff.from.holder, to: handoff.to.holder,
              reason: handoff.to.reason, note: handoff.to.note,
            } } : {}),
          },
          neighbors: [
            neighbor("Project", task.project), neighbor("Parent", task.parent),
            ...task.dependencies.map(id => neighbor("Prerequisite", id)),
            ...dependents.map(id => neighbor("Dependent", id)),
            ...children.map(id => neighbor("Subtask", id)),
            ...task.references.map(ref => neighbor("Reference", ref.id)),
            ...executions.map(execution => neighbor("Execution round", execution.job)),
          ],
        };
      }
      case "work.project.show": {
        const { id, title, description, status, revision, goal, tags, deadline } = WorkProject.parse(result);
        return { title, summary: summary(description, title), body: { id, title, description, status, revision, goal, tags, deadline } };
      }
      case "execution.job.show": {
        const { spec, status, result: outcome } = Job.parse(result);
        const { id, created, source } = spec;
        const report = outcome?.report ?? outcome?.question ?? outcome?.error;
        const title = id + " (" + status + ")";
        return { title, summary: summary(report, title), body: { id, status, created, report },
          neighbors: [neighbor("Task", source?.task), neighbor("Routine", source?.routine), neighbor("Previous run", source?.previous)] };
      }
      case "knowledge.note.show": {
        const { note, body, frontmatter, revision } = NoteDetail.parse(result);
        const origins = Array.isArray(frontmatter.derived_from) ? frontmatter.derived_from.filter(id => typeof id === "string") : [];
        // Link lookup is optional and uses the public agent view even for an explicit, delegated private read.
        const links = note.id ? await this.modules.capabilities.execute("knowledge.note.links", { ref: note.id }, identity)
          .then(value => relatedNotes(LinksResult.parse(value.result)), () => []) : [];
        return { title: note.title, summary: summary(body, note.title), body: { id: note.id, title: note.title, type: note.type, citekey: note.citekey, revision, body },
          neighbors: [...origins.map(id => neighbor("Source", id)), ...links] };
      }
    }
  }
}
