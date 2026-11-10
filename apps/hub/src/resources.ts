import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { StorageError, countKnowledgeReferences, noteById, type SqliteArtifacts, type SqliteAssistantStore, type SqliteRoutineStore, type SqliteWorkStore } from "@lumio/storage";
import { ResourceSummary, RunLogEvent, TRASHED_REASON } from "@lumio/schema";
import type { HubStore, Identity } from "./store.ts";
import type { HubConfig } from "./config.ts";
import type { authorize } from "./authorize.ts";
import { assertNoteVisible } from "./trash.ts";

export interface ConversationSource { owner: string; conversation: string; message?: string }
interface ResourceAccess { includePrivate?: boolean; conversation?: ConversationSource }

interface ResourceModules {
  assistantStore: SqliteAssistantStore;
  workStore: SqliteWorkStore;
  artifacts: SqliteArtifacts;
  routineStore: SqliteRoutineStore;
}

export class Resources {
  constructor(private modules: ResourceModules, private store: HubStore, private config: HubConfig, private decide: typeof authorize) {}

  conversationSource(owner: string, turnId: string): ConversationSource | undefined {
    const store = this.modules.assistantStore, turn = store.turn(turnId);
    if (!turn || store.conversation(turn.conversation)?.owner !== owner || store.trash(turn.conversation)) return;
    const message = store.userMessage(turn.conversation, turnId);
    if (message) return { owner, conversation: turn.conversation, message: message.id };
  }

  async count(id: string, identity: Identity, includePrivate = false): Promise<number> {
    if (!this.config.vault) return 0;
    const { assistantStore: assistant, workStore } = this.modules;
    const ids = id.startsWith("conv_") && assistant.conversation(id)?.owner === identity.actor.id ? assistant.anchorIds(id) : [id];
    if (id.startsWith("task_")) {
      for (const comment of workStore.comments(id)) ids.push(comment.id);
    }
    return countKnowledgeReferences(this.config.vault, ids, { stateDir: this.config.stateDir, includePrivate: identity.actor.role === "human" && includePrivate });
  }

  async resolve(id: string, identity: Identity, access: ResourceAccess = {}): Promise<ResourceSummary> {
    const unavailable = { id, status: "unavailable" } as const;
    const visible = (title: string, timestamp?: string, parent?: string): ResourceSummary =>
      ({ id, status: "visible", title, timestamp, parent });
    const human = identity.actor.role === "human";
    const includePrivate = human && access.includePrivate === true;
    const allowed = (operation: string, privateRead = false) =>
      this.decide(identity.actor, { operation, includePrivate: privateRead }).result === "allow";
    const { assistantStore: assistant, workStore, artifacts } = this.modules;
    const prefix = id.slice(0, id.indexOf("_"));
    try {
      switch (prefix) {
        case "conv": case "amsg": case "turn": case "tool": {
          const message = prefix === "amsg" ? assistant.message(id) : undefined;
          const call = prefix === "tool" ? assistant.call(id) : undefined;
          const turn = prefix === "turn" || call ? assistant.turn(call?.turn ?? id) : undefined;
          const conversationId = prefix === "conv" ? id : message?.conversation ?? turn?.conversation;
          const conversation = conversationId ? assistant.conversation(conversationId) : undefined;
          if (!conversation) return human && allowed("assistant.read") && assistant.purgedAnchorOwner(id) === identity.actor.id
            ? { id, status: "deleted" } : unavailable;
          const owns = human && allowed("assistant.read") && conversation.owner === identity.actor.id;
          const active = conversation.id === access.conversation?.conversation && conversation.owner === access.conversation.owner;
          if (!owns && !active) return unavailable;
          if (assistant.trash(conversation.id)) return owns ? { id, status: "trashed" } : unavailable;
          return visible(conversation.title, message?.created ?? call?.created ?? turn?.created ?? conversation.updated,
            conversation.id === id ? undefined : conversation.id);
        }
        case "mem": {
          if (!human || !allowed("assistant.memory.read")) return unavailable;
          const memory = assistant.memory(id);
          return memory?.owner === identity.actor.id && (!memory.private || includePrivate) ? visible(memory.content.slice(0, 80), memory.created) : unavailable;
        }
        case "task": case "prj": case "wmsg": {
          if (!allowed("work.read")) return unavailable;
          const comment = prefix === "wmsg" ? workStore.comment(id) : undefined;
          if (prefix === "wmsg" && !comment) return unavailable;
          const target = comment?.task ?? id;
          if (workStore.trash(target)) return human ? { id, status: "trashed" } : unavailable;
          const item = prefix === "prj" ? workStore.project(target) : workStore.task(target);
          if (item) return visible(item.title, comment?.created ?? item.updated, comment?.task);
          if (comment) return unavailable;
          if (prefix === "task" && workStore.purgedTask(id)) return human ? { id, status: "deleted" } : unavailable;
          break; // Legacy vault notes can use the same IDs as database tasks and projects.
        }
        case "job": {
          if (!allowed("job.show")) return unavailable;
          const job = this.store.executionStore.get(id);
          if (!job) return unavailable;
          const parent = job.spec.source?.task ?? job.spec.source?.routine;
          return visible(job.spec.run.kind === "agent" ? job.spec.run.engine : id, job.spec.created, parent);
        }
        case "rtn": {
          if (!allowed("execution.read")) return unavailable;
          const routine = this.modules.routineStore.get(id);
          if (routine) return visible(routine.title, routine.updated);
          break;
        }
        case "art": {
          if (!allowed("execution.read", includePrivate)) return unavailable;
          const artifact = artifacts.get(id);
          if (artifact.owner.module !== "execution" || artifact.status !== "ready" || (artifact.private && !includePrivate)
            || !this.store.executionStore.get(artifact.owner.id)) return unavailable;
          return visible(artifact.media_type, artifact.created, artifact.owner.id);
        }
        case "evt": {
          if (!allowed("execution.read", includePrivate)) return unavailable;
          for (const artifact of artifacts.list()) {
            if (artifact.owner.module !== "execution" || artifact.status !== "ready" || (artifact.private && !includePrivate)
              || artifact.media_type !== "application/vnd.lumio.runlog+jsonl" || !this.store.executionStore.get(artifact.owner.id)) continue;
            const stream = createReadStream(await artifacts.path(artifact.id));
            const lines = createInterface({ input: stream, crlfDelay: Infinity });
            try {
              for await (const line of lines) {
                if (!line.includes(id)) continue;
                let raw: unknown;
                try { raw = JSON.parse(line); } catch { continue; }
                const event = RunLogEvent.safeParse(raw);
                if (event.success && event.data.id === id && event.data.run === artifact.owner.id)
                  return visible(event.data.type, event.data.time, event.data.run);
              }
            } finally { lines.close(); stream.destroy(); }
          }
          return unavailable;
        }
        case "act": {
          if (!allowed("actors")) return unavailable;
          const actor = this.store.actors().find(value => value.id === id);
          return actor ? visible(actor.name, actor.created) : unavailable;
        }
        case "prop": {
          if (!allowed("proposals")) return unavailable;
          const proposal = this.store.proposal(id);
          return proposal && (human || proposal.author === identity.actor.id) ? visible(proposal.operation.op, proposal.created) : unavailable;
        }
      }
      if (!this.config.vault || !allowed("show", includePrivate)) return unavailable;
      assertNoteVisible(this.store.db, id);
      const note = await noteById(this.config.vault, id, { stateDir: this.config.stateDir, includePrivate });
      return note ? visible(note.title) : unavailable;
    } catch (cause) {
      if (cause instanceof Error && "reason" in cause && cause.reason === TRASHED_REASON && human) return { id, status: "trashed" };
      if (cause instanceof StorageError && cause.code === "NOT_FOUND") return unavailable;
      throw cause;
    }
  }
}
