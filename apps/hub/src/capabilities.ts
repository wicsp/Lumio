import { CoreError } from "@lumio/foundation";
import type { AiNotes } from "./ai-notes.ts";
import type { ConversationSource, Resources } from "./resources.ts";
import type { WorkCommands } from "./work-commands.ts";
import type { WorkService } from "@lumio/work";
import type { ExecutionRoutines } from "@lumio/execution";
import { assertNoteVisible } from "./trash.ts";
import { AI_NOTE_CAPABILITY_NAMES, KnowledgeAiNoteCommand, capability, RESPONSE_REASONS, CAPABILITIES, toolName, WorkCommandRequest, WorkAttention, type CapabilityChange, type CapabilityNameOf } from "@lumio/schema";
import type { AssistantTool } from "@lumio/assistant";
import { KnowledgeService } from "@lumio/knowledge";
import { FileKnowledgeRepository, readKnowledgeDocument, type SqliteAssistantStore } from "@lumio/storage";
import type { HubStore, Identity } from "./store.ts";
import type { HubConfig } from "./config.ts";
import { authorize } from "./authorize.ts";
import { executionTargets } from "./targets.ts";
import { Jobs } from "./jobs.ts";
import { HubError } from "./errors.ts";
import { text as msg } from "./messages.ts";

interface CapabilityModules {
  workCommands: WorkCommands;
  work: WorkService;
  routines: ExecutionRoutines;
  aiNotes?: AiNotes;
  resources: Resources;
  assistantStore: SqliteAssistantStore;
}
interface CapabilityOptions { includePrivate?: boolean; chronologicalJobs?: boolean; conversation?: ConversationSource }

export function isAiNoteCapability(name: string): boolean {
  return AI_NOTE_CAPABILITY_NAMES.some(value => value === name);
}

export interface CapabilityResult { result: unknown; change?: CapabilityChange; private_read?: boolean }

export function assistantToolDescription(def: (typeof CAPABILITIES)[number]): string {
  if (def.name !== "work.task.update") return def.summary.en;
  return `${def.summary.en} To add, remove, or reorder prerequisites, first read the task with ${toolName("work.task.show")} and use its revision as expected_revision. Set patch.dependencies to the complete list of prerequisite task IDs, preserving any dependencies the user did not ask to change. Use [] to clear all prerequisites. To make A wait for B, put B's ID in A's dependencies. The Hub checks for cycles and stale revisions.`;
}

/** Hub composition: schemas and authorization precede every module invocation. No HTTP input grants private delegation. */
export class Capabilities {
  private readonly knowledge?: KnowledgeService;
  constructor(private readonly modules: CapabilityModules, private readonly store: HubStore, private readonly config: HubConfig,
    private readonly decide: typeof authorize = authorize) {
    this.knowledge = config.vault ? new KnowledgeService(new FileKnowledgeRepository(config.vault, { stateDir: config.stateDir })) : undefined;
  }
  async execute(name: string, raw: unknown, identity: Identity, requestId?: string, options: CapabilityOptions = {}): Promise<CapabilityResult> {
    return this.invoke(name, raw, identity, requestId, options.includePrivate, false, options.chronologicalJobs, options.conversation);
  }
  tools(): AssistantTool[] {
    return CAPABILITIES.map(def => ({
      spec: { name: toolName(def.name), description: assistantToolDescription(def), input_schema: def.args.toJSONSchema() },
      capability: def.name, effect: def.kind,
      execute: async (args, context) => {
        const actor = this.store.assistantActor();
        if (actor.id !== context.actor) throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
        const humanOwner = this.store.actors().some(value => value.id === context.owner && value.role === "human");
        // This closure is assembled in process. Owner/delegation never comes from capability arguments or an HTTP token.
        let conversation: ConversationSource | undefined;
        if (isAiNoteCapability(def.name)) {
          const turn = this.modules.assistantStore.call(context.request)?.turn;
          conversation = humanOwner && turn ? this.modules.resources.conversationSource(context.owner, turn) : undefined;
          if (!conversation) throw new HubError("FORBIDDEN", { key: "knowledge.ai_note_source_unavailable", args: [] });
        }
        const outcome = await this.invoke(def.name, args, { actor, label: "assistant-tools" }, context.request, false, humanOwner, false, conversation);
        context.record?.({ capability: def.name, change: outcome.change, private_read: outcome.private_read });
        return outcome.result;
      },
    }));
  }
  private async invoke(name: string, raw: unknown, identity: Identity, requestId?: string, includePrivate = false, humanConversation = false, chronologicalJobs = false, conversation?: ConversationSource): Promise<CapabilityResult> {
    const def = capability(name);
    if (!def) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
    const parsed = def.args.safeParse(raw);
    if (!parsed.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
    const args = parsed.data as Record<string, unknown>;
    const aiNote = isAiNoteCapability(name);
    const operation = aiNote ? "knowledge.ai-note" : def.kind === "write" ? "work.command" : name.startsWith("knowledge.") ? name.split(".")[2]!
      : name.startsWith("work.") ? "work.read" : name === "execution.job.list" ? "jobs" : name === "execution.job.show" ? "job.show" : name === "approval.proposal.list" ? "proposals" : "execution.read";
    const decision = this.decide(identity.actor, { operation, ...(def.kind === "write" ? { command: name, args } : {}), includePrivate });
    if (decision.result !== "allow") {
      this.store.audit(identity, name, decision.result, undefined, "FORBIDDEN");
      throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : msg("v2.approval_required") });
    }
    if (aiNote) {
      const input = KnowledgeAiNoteCommand.safeParse({ request_id: requestId, operation: { op: name, args } });
      if (!input.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      if (!this.modules.aiNotes) throw new HubError("INVALID", { key: "knowledge.no_vault", args: [] });
      const result = await this.modules.aiNotes.execute(input.data, identity, conversation);
      return { result, change: { capability: name, target: result.note.id! } };
    }
    if (name === "approval.proposal.withdraw") return { result: def.result.parse(this.store.withdrawProposal(String(args.proposal), identity)) };
    if (def.kind === "write") {
      const input = WorkCommandRequest.safeParse({ request_id: requestId, operation: { op: name, args } });
      if (!input.success) throw new HubError("INVALID", { key: "capability.invalid", args: [] });
      return this.store.db.transaction(() => {
        let before: Record<string, unknown> | undefined;
        if (name.endsWith(".update")) {
          const current = name === "work.task.update" ? this.modules.work.task(String(args.task)) : this.modules.work.project(String(args.project));
          before = Object.fromEntries(Object.keys(args.patch as object).map(key => [key, (current as unknown as Record<string, unknown>)[key] ?? null]));
        }
        const result = this.modules.workCommands.execute(input.data, identity);
        const entity = result.kind === "task" ? result.task : result.kind === "project" ? result.project : undefined;
        const change: CapabilityChange = { capability: name, target: entity?.id ?? (result.kind === "comment" ? result.comment.task : ""),
          ...(before ? { before } : {}), ...(entity ? { after_revision: entity.revision } : {}) };
        this.store.audit(identity, name, "allow", undefined, "applied");
        return { result: def.result.parse(result), change };
      })();
    }
    let result: unknown, privateRead = false;
    if (name.startsWith("knowledge.")) {
      if (!this.knowledge) throw new HubError("INVALID", { key: "server.no_knowledge_directory_configured_work_and_execution_are_available_i", args: [] });
      const read = async (privateAllowed: boolean) => {
        const options = { includePrivate: privateAllowed };
        if (name === "knowledge.note.search") return this.knowledge!.search(String(args.query), { ...options, type: args.type as never, limit: args.limit as number | undefined });
        assertNoteVisible(this.store.db, String(args.ref));
        if (name === "knowledge.note.show") {
          const detail = await this.knowledge!.show(String(args.ref), options);
          if (detail.note.id) assertNoteVisible(this.store.db, detail.note.id);
          if (detail.note.type !== "ai-note" || !detail.note.id) return detail;
          try {
            const { document, revision } = await readKnowledgeDocument(this.config.vault, detail.note.id, { stateDir: this.config.stateDir });
            return { ...document, revision };
          } catch (cause) {
            if (cause instanceof CoreError && cause.code === "NOTE_NOT_EDITABLE") return detail;
            throw cause;
          }
        }
        return this.knowledge!.links(String(args.ref), options);
      };
      result = await read(includePrivate || humanConversation);
      // Compare the public projection so private link targets, titles, snippets and counts are audited too.
      if (humanConversation) {
        try { privateRead = JSON.stringify(result) !== JSON.stringify(await read(false)); } catch { privateRead = true; }
        if (privateRead) this.store.audit(identity, name, "allow", undefined, "private-read");
      }
    } else {
      const work = this.modules.work, jobs = new Jobs(this.store);
      switch (name as CapabilityNameOf) {
        case "work.task.list": result = work.tasks(args); break;
        case "work.task.show": result = work.detail(String(args.task)); break;
        case "work.project.list": result = work.projects().filter(value => !args.status || value.status === args.status); break;
        case "work.project.show": result = work.project(String(args.project)); break;
        case "work.attention.list": result = this.attention(); break;
        case "execution.target.list": result = executionTargets(this.store).filter(target => args.online !== true || target.online); break;
        case "execution.job.list": {
          const list = jobs.list(args.status as string | undefined, args.task as string | undefined, args.routine as string | undefined);
          // The v1 compatibility route keeps its unbounded chronological presentation.
          result = chronologicalJobs ? list : list.slice().reverse().slice(0, (args.limit as number | undefined) ?? 20); break;
        }
        case "execution.job.show": result = jobs.get(String(args.job)); break;
        case "execution.routine.list": result = this.modules.routines.list(); break;
        case "approval.proposal.list": {
          const activeTasks = new Set(work.tasks().map(task => task.id));
          result = this.store.proposals("pending", identity.actor.role === "agent" ? identity.actor.id : undefined)
            .filter(proposal => proposal.operation.op !== "work.command" || !("task" in proposal.operation.args.operation.args) || activeTasks.has(proposal.operation.args.operation.args.task));
          break;
        }
      }
    }
    return { result: def.result.parse(result), ...(privateRead ? { private_read: true } : {}) };
  }
  attention(): WorkAttention[] {
    const jobs = new Jobs(this.store);
    return this.modules.work.tasks().flatMap(task => {
      if (task.outcome !== "open" || task.turn.holder !== "human" || !(RESPONSE_REASONS as readonly string[]).includes(task.turn.reason)) return [];
      const kind = task.turn.reason === "answer" ? "question" : task.turn.reason === "review" ? "review" : "failed";
      if (!task.turn.job || !task.turn.round) return [];
      const job = jobs.get(task.turn.job!);
      const stage = task.plan?.plan.stages.find(stage => stage.id === task.turn.stage);
      const runtime = this.store.runtimes(new Date()).find(value => value.actor === job.spec.runtime)?.registration.name;
      return [WorkAttention.parse({ task: task.id, title: task.title, kind, job: task.turn.job, round: task.turn.round,
        ...(job.spec.run.kind === "agent" ? { agent: `${job.spec.run.engine}${runtime ? `@${runtime}` : ""}` } : {}),
        since: task.turn.since, stage: task.turn.stage, ...(stage?.kind === "checkpoint" ? { prompt: stage.prompt } : {}),
        ...(kind === "question" && job.result?.question?.trim() ? { question: job.result?.question } : {}), summary: (task.turn.note || job.result?.report || job.result?.error || "").slice(0, 500) })];
    });
  }
}
