import {AIConfigurationService} from "./ai-config.ts";
import {NativeAssistant} from "./native-assistant.ts";
import {SqliteAIStore} from "@lumio/storage";
import { KnowledgeService } from "@lumio/knowledge";
import type { Trash } from "./trash.ts";
import { validateTarget } from "./targets.ts";
import { Notifications } from "./notifications.ts";
import { WorkCommands } from "./work-commands.ts";
import { text as msg } from "./messages.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CoreError, newId } from "@lumio/foundation";
import { parseAssignee, type WorkCommandResult, type AgentRun, type WorkTask } from "@lumio/schema";
import { WorkService } from "@lumio/work";
import { AssistantService, type AssistantModel, type AssistantTool } from "@lumio/assistant";
import { FileKnowledgeRepository, SqliteWorkStore, SqliteAssistantStore, SqliteRoutineStore, SqliteArtifacts } from "@lumio/storage";
import { ExecutionRoutines } from "@lumio/execution";
import type { HubConfig } from "./config.ts";
import type { HubStore, Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { HubError } from "./errors.ts";
import { configuredModel } from "./assistant-model.ts";
import type { AssistantConfiguration } from "./assistant-config.ts";
import { Capabilities } from "./capabilities.ts";
import { authorize } from "./authorize.ts";
import { workdirInVault } from "./execution-policy.ts";

/** Composition only: domain rules belong to their modules; adapters share one transaction-capable database. */
export class BusinessModules {
  readonly ai:AIConfigurationService;
  readonly native:NativeAssistant;
  readonly knowledge?: KnowledgeService;
  readonly notifications: Notifications;
  readonly workStore: SqliteWorkStore;
  readonly work: WorkService;
  readonly workCommands: WorkCommands;
  readonly assistant: AssistantService;
  readonly capabilities: Capabilities;
  trash!: Trash;
  assistantConfig!: AssistantConfiguration;
  readonly assistantStore: SqliteAssistantStore;
  readonly routineStore: SqliteRoutineStore;
  readonly routines: ExecutionRoutines;
  readonly artifacts: SqliteArtifacts;
  private readonly stopped = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  readonly signal = this.stopped.signal;
  constructor(private readonly config: HubConfig, private readonly store: HubStore, options: {
    authorize?: typeof authorize; now?: () => Date; assistantModel?: AssistantModel; assistantTools?: AssistantTool[]; pushFetch?: typeof fetch;
  } = {}) {
    const now = options.now ?? (() => new Date());
    if (config.vault) this.knowledge = new KnowledgeService(new FileKnowledgeRepository(config.vault, { stateDir: config.stateDir }));
    const id = (prefix: Parameters<typeof newId>[0]) => newId(prefix, now(), randomBytes);
    const jobs = new Jobs(store);
    this.artifacts = new SqliteArtifacts(store.db, join(config.stateDir, "files"));
    this.routineStore = new SqliteRoutineStore(store.db);
    this.routines = new ExecutionRoutines(this.routineStore, jobs, {
      text: msg, now, id: () => id("rtn"), lease: () => randomBytes(32).toString("base64url"),
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
      runtimes: (time) => store.runtimes(time), localRuntime: config.localRuntime,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      validateWorkdir: (runtime, workdir) => {
        if (config.vault && runtime.registration.name === config.localRuntime && workdirInVault(config.vault, workdir)) {
          throw new HubError("INVALID", { key: "modules.working_directory_must_be_outside_the_knowledge_directory", args: [] });
        }
      },
    });
    const notifications = this.notifications = new Notifications(store, config.stateDir, { fetch: options.pushFetch, now, subject: config.publicUrl, signal: this.signal });
    this.workStore = new class extends SqliteWorkStore {
      override putTurn(change: import("@lumio/schema").TaskTurnChange): void {
        super.putTurn(change);
        notifications.turn(this.task(change.task)!, change, this.turns(change.task).length);
      }
    }(store.db);
    store.proposalCreated = proposal => {
      const operation = proposal.operation;
      const taskId = operation.op === "work.command" ? ("task" in operation.args.operation.args ? operation.args.operation.args.task : undefined) : operation.op === "task.dispatch" ? operation.args.task : undefined;
      notifications.proposal(proposal, taskId ? this.workStore.task(taskId)?.title : undefined);
    };
    this.work = new WorkService(this.workStore, { text: msg, now, id, localRuntime: config.localRuntime, systemActor: store.workActor().id, job: id => jobs.get(id),
      auditPlan: (change, plan) => {
        const actor = store.actors().find(actor => actor.id === change.by)!;
        store.audit({ actor, label: actor.name }, JSON.stringify({ op: "work.task.plan.advance", task: change.task, plan,
          from: change.from.stage, stage: change.to.stage, turn: change.to }), "allow", plan.approved.proposal, "applied");
      },
      validateTarget: (target, source) => { validateTarget(this.store, config.localRuntime, target, now(), source); },
      dispatch: (task, input, round, to) => this.dispatch(task, input, round, to, now()),
      agentsForJobs: ids => {
        const jobs = store.executionStore.agentJobs(ids);
        if (!jobs.length) return new Map();
        const runtimes = new Map(store.runtimes(now()).map(runtime => [runtime.actor, runtime.registration.name]));
        const targets = new Map<string, string>();
        for (const job of jobs) {
          const name = runtimes.get(job.runtime);
          if (name) targets.set(job.id, `${job.engine}@${name}`);
        }
        return targets;
      },
      cancel: (task) => { const job = jobs.activeForTask(task); if (job) { jobs.cancel(job.spec.id); return job.spec.id; } },
    });
    this.workCommands = new WorkCommands(store, this.work, options.authorize ?? authorize, config.localRuntime, now);
    this.capabilities = new Capabilities(this, store, config, options.authorize);
    this.assistantStore = new SqliteAssistantStore(store.db);
    this.ai=new AIConfigurationService(new SqliteAIStore(store.db),config.assistantModel);
    this.ai.migrateLegacy(store.actors().filter(actor => actor.role === "human").map(actor => actor.id));
    this.ai.store.installConversationPurge();
    this.native=new NativeAssistant(this.ai.store,this,store,config);
    this.assistant = new AssistantService(this.assistantStore, options.assistantModel ?? configuredModel(config.assistantModel),
      [...this.capabilities.tools(), ...(options.assistantTools ?? [])], { text: msg, now, id, toolActor: store.assistantActor(),resolveModel:(profile,owner)=>this.ai.model(owner,profile),native:{validate:(c,r)=>this.native.validate(c,r),run:this.native.run,cancel:c=>this.native.cancelConversation(c)} });
    this.assistant.recover();
    this.reconcile();
    this.timer = setInterval(() => {
      try { this.reconcile(); } catch { /* Persisted pending results remain for the next pass. */ }
      void this.notifications.drain().catch(() => {});
    }, 1000);
  }
  async undo(callId: string, identity: Identity, requestId: string): Promise<WorkCommandResult> {
    // Resolve only within the owner's conversations; the caller cannot undo another owner's tools.
    const call = this.assistant.conversations(identity.actor.id).flatMap(conversation =>
      this.assistant.detail(conversation.id, identity.actor.id).turns.flatMap(turn => this.assistantStore.calls(turn.id))).find(value => value.id === callId);
    const change = call?.change;
    if (!call || call.status !== "succeeded" || !change?.before || !change.after_revision || !["work.task.update", "work.project.update"].includes(change.capability)) {
      throw new HubError("INVALID", { key: "assistant.undo.unavailable", args: [] });
    }
    const task = change.capability === "work.task.update";
    const outcome = await this.capabilities.execute(change.capability, { [task ? "task" : "project"]: change.target,
      expected_revision: change.after_revision, patch: change.before }, identity, requestId);
    this.assistantStore.putCall({ ...call, change: { ...change, undone: change.undone ?? { at: new Date().toISOString(), by: identity.actor.id } } });
    return outcome.result as WorkCommandResult;
  }
  private dispatch(task: WorkTask, input: string, round: number, to: string | undefined, now: Date) {
    const target = parseAssignee(to ?? "human");
    if (target === "human") throw new HubError("INVALID", { key: "modules.specify_an_agent_e_g_pi_server", args: [] });
    const runtime = this.store.runtimes(now).find((value) => value.registration.name === (target.device ?? this.config.localRuntime));
    if (!runtime) throw new HubError("INVALID", { key: "modules.the_specified_runtime_is_not_registered_pair_it_first", args: [] });
    const engine = runtime.registration.engines.find((value) => value.name === target.agent);
    if (!engine) throw new HubError("INVALID", { key: "modules.selected_agent_is_not_registered_on_runtime", args: [] });
    const workdir = task.workdir ?? (task.project ? this.work.project(task.project).workdir : undefined) ?? "~";
    if (this.config.vault && runtime.registration.name === this.config.localRuntime && workdirInVault(this.config.vault, workdir)) {
      throw new HubError("INVALID", { key: "modules.working_directory_must_be_outside_the_knowledge_directory", args: [] });
    }
    const jobs = new Jobs(this.store);
    const previous = jobs.list(undefined, task.id).at(-1);
    let session: AgentRun["session"];
    if (previous?.spec.run.kind === "agent" && previous.spec.run.engine === target.agent && previous.spec.runtime === runtime.actor && previous.result?.session_id) {
      session = { id: previous.result.session_id, resume: true };
    } else if (target.agent === "pi" || target.agent === "claude-code") session = { id: randomUUID(), resume: false };
    const permissions = msg(engine.sandbox === "os" ? "modules.round_workspace_write" : "modules.round_no_sandbox");
    return jobs.create({ runtime: runtime.actor, workdir, timeout_seconds: (task.timeout_minutes ?? 120) * 60,
      ...(task.gpus ? { gpus: task.gpus } : {}), source: { task: task.id, round, ...(previous ? { previous: previous.spec.id } : {}) },
      run: { kind: "agent", engine: target.agent, ...(task.model ? { model: task.model } : {}), ...(session ? { session } : {}),
        prompt: msg("modules.you_are_completing_round_of_a_user_task_work_only_in_the_working_dir", round, permissions, input) },
    }, now);
  }
  reconcile(): void {
    const jobs = new Jobs(this.store);
    for (const execution of this.workStore.executions().filter((value) => !value.applied)) {
      try { this.work.applyResult(jobs.get(execution.job)); }
      catch (cause) { if (!(cause instanceof HubError && cause.code === "NOT_FOUND") && !(cause instanceof CoreError)) throw cause; }
    }
  }
  stop(): void { clearInterval(this.timer); this.stopped.abort(); this.store.proposalCreated = undefined; }
}
