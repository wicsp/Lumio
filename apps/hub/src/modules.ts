import { authorizeJobAccount, sameJobAccount, type JobAccountSelection } from "./job-accounts.ts";
import { reviewSecurity } from "./security-review.ts";
import { Resources } from "./resources.ts";
import { AssistantWorkbenchAnchors } from "./assistant-workbench-anchors.ts";
import type { AiNotes } from "./ai-notes.ts";
import {AIConfigurationService} from "./ai-config.ts";
import { DecisionGate } from "./decision-gate.ts";
import type { JevFetch } from "./jev.ts";
import {NativeAssistant} from "./native-assistant.ts";
import { SqliteSpeechStore } from "@lumio/storage";
import { FunAsr, type FunAsrOptions } from "./fun-asr.ts";
import { SpeechConfiguration } from "./speech-config.ts";
import { KnowledgeService } from "@lumio/knowledge";
import type { Inbox } from "./inbox.ts";
import type { Trash } from "./trash.ts";
import { stageDispatchOptions, validateTarget } from "./targets.ts";
import { Notifications } from "./notifications.ts";
import { Notices } from "./notices.ts";
import { Explorations, Watchdog } from "./workbench-background.ts";
import { WorkCommands } from "./work-commands.ts";
import { text as msg } from "./messages.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CoreError, newId } from "@lumio/foundation";
import { AgentTarget, RESPONSE_REASONS, type Job, type WorkCommandResult, type AgentRun, type WorkTask } from "@lumio/schema";
import { mergeStageGrant, PlanDispatchUnavailable, WorkService } from "@lumio/work";
import type { AssistantContext, AssistantModel, AssistantTool } from "@lumio/assistant";
import { AssistantMainConversations } from "./assistant-main.ts";
import { glanceChat } from "./glance-chat.ts";
import { VoiceIdeas } from "./voice-ideas.ts";
import { SemanticSearch } from "./semantic-search.ts";
import type { ImageHosting } from "./image-hosting.ts";
import type { Glances } from "./glances.ts";
import { WorkbenchAssistant } from "./workbench-assistant.ts";
import { WorkbenchTools } from "./workbench-tools.ts";
import { FileKnowledgeRepository, SqliteWorkStore, SqliteAssistantStore, SqliteRoutineStore, SqliteArtifacts } from "@lumio/storage";
import { ExecutionRoutines } from "@lumio/execution";
import type { HubConfig } from "./config.ts";
import type { HubStore, Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { JobActivity, checkJobInteraction } from "./job-activity.ts";
import { HubError } from "./errors.ts";
import { configuredModel } from "./assistant-model.ts";
import { Personal } from "./personal.ts";
import type { AssistantConfiguration } from "./assistant-config.ts";
import { Capabilities } from "./capabilities.ts";
import { authorize } from "./authorize.ts";
import { requireLocalInteractiveWorkdir, workdirInVault } from "./execution-policy.ts";

function roundPermissions(sandbox: "os" | "none", permissions: AgentRun["permissions"], planned: boolean): string {
  const access = permissions?.access ?? "write";
  const git = msg(permissions?.git ? "modules.round_git_approved" : "modules.round_git_restricted");
  let scope: string;
  if (sandbox === "none") {
    scope = msg("modules.round_no_sandbox");
    if (planned) scope += ` ${msg("modules.round_advisory", access)} ${git}`;
  } else if (access === "full") {
    scope = `${msg("modules.round_full")} ${git}`;
  } else if (permissions?.git) {
    scope = msg(access === "read" ? "modules.round_read_git" : "modules.round_write_git");
  } else {
    scope = msg(access === "read" ? "modules.round_read" : "modules.round_workspace_write");
  }
  return `${scope} ${msg(permissions?.secrets?.length ? "modules.round_stage_secrets" : "modules.round_no_stage_secrets")}`;
}

/** Composition only: domain rules belong to their modules; adapters share one transaction-capable database. */
export class BusinessModules {
  readonly ai:AIConfigurationService;
  readonly personal?: Personal;
  readonly decisionGate: DecisionGate;
  readonly native:NativeAssistant;
  readonly speech: SpeechConfiguration;
  readonly funAsr: FunAsr;
  readonly knowledge?: KnowledgeService;
  readonly notifications: Notifications;
  readonly jobActivity: JobActivity;
  readonly notices: Notices;
  readonly explorations: Explorations;
  private readonly watchdog: Watchdog;
  readonly workStore: SqliteWorkStore;
  readonly work: WorkService;
  readonly workCommands: WorkCommands;
  readonly assistant: WorkbenchAssistant;
  readonly assistantMain: AssistantMainConversations;
  readonly workbench: WorkbenchTools;
  readonly capabilities: Capabilities;
  readonly resources: Resources;
  aiNotes?: AiNotes;
  trash!: Trash;
  inbox!: Inbox;
  glances!: Glances;
  voiceIdeas!: VoiceIdeas;
  readonly semantic: SemanticSearch;
  imageHosting!: ImageHosting;
  assistantConfig!: AssistantConfiguration;
  readonly assistantStore: SqliteAssistantStore;
  readonly routineStore: SqliteRoutineStore;
  readonly routines: ExecutionRoutines;
  readonly artifacts: SqliteArtifacts;
  private readonly stopped = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  readonly signal = this.stopped.signal;
  workTaskDetail(id: string) {
    return this.notices.withoutPreReadCopies(this.work.detail(id));
  }

  securityReview(request: Request) {
    return reviewSecurity(request, this.config, this.work, this.store);
  }

  constructor(private readonly config: HubConfig, private readonly store: HubStore, options: {
    authorize?: typeof authorize; now?: () => Date; assistantModel?: AssistantModel; assistantTools?: AssistantTool[]; pushFetch?: typeof fetch; quotaFetch?: typeof fetch; jevFetch?: JevFetch; funAsr?: FunAsrOptions;
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
    this.jobActivity = new JobActivity(store, notifications);
    this.workStore = new class extends SqliteWorkStore {
      override putTurn(change: import("@lumio/schema").TaskTurnChange): void {
        super.putTurn(change);
        notifications.turn(this.task(change.task)!, change, this.turns(change.task).length);
      }
    }(store.db);
    store.projectForJob = job => job.project === undefined
      ? (job.spec.source?.task ? this.workStore.task(job.spec.source.task)?.project : undefined)
      : job.project ?? undefined;
    store.projectConcurrency = project => this.workStore.project(project)?.max_concurrent ?? 1;
    store.proposalCreated = proposal => {
      const operation = proposal.operation;
      const taskId = operation.op === "work.command" ? ("task" in operation.args.operation.args ? operation.args.operation.args.task : undefined) : undefined;
      notifications.proposal(proposal, taskId ? this.workStore.task(taskId)?.title : undefined);
      this.notices.proposal(proposal, taskId);
    };
    this.work = new WorkService(this.workStore, { text: msg, now, id, localRuntime: config.localRuntime, systemActor: store.workActor().id, job: id => jobs.get(id),
      auditPlan: (change, plan, checkpoint) => {
        const actor = store.actors().find(actor => actor.id === change.by)!;
        store.audit({ actor, label: actor.name }, JSON.stringify({ op: "work.task.plan.advance", task: change.task, plan,
          from: change.from.stage, stage: change.to.stage, turn: change.to, checkpoint }), "allow", plan.approved.proposal, "applied");
      },
      validateTarget: (target, source) => { validateTarget(this.store, config.localRuntime, target, now(), source); },
      dispatch: (task, input, round, to, previous, grant, interaction, account) => this.dispatch(task, input, round, to, now(), previous, grant, interaction, account),
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
      cancel: (task) => {
        const active = jobs.list(undefined, task).filter(job => !job.result && ["queued", "assigned", "running"].includes(job.status));
        for (const job of active) jobs.cancel(job.spec.id);
        return active[0]?.spec.id;
      },
    });
    this.workCommands = new WorkCommands(store, this.work, options.authorize ?? authorize, config.localRuntime, now);
    this.resources = new Resources(this, store, config, options.authorize ?? authorize);
    this.capabilities = new Capabilities(this, store, config, options.authorize);
    this.assistantStore = new SqliteAssistantStore(store.db);
    this.assistantMain = new AssistantMainConversations(store, this.assistantStore);
    this.workbench = new WorkbenchTools(this.assistantMain, this.assistantStore, this.resources);
    this.ai=new AIConfigurationService(store.aiStore,config.assistantModel);
    this.semantic = new SemanticSearch(config, owner => {
      const id = this.inbox?.embeddingProfile(owner);
      if (!id) return;
      const resolved = this.ai.get(owner, id);
      return { ...resolved, key: this.ai.store.secret(resolved.connection.id) };
    }, this.signal);
    this.ai.migrateLegacy(store.actors().filter(actor => actor.role === "human").map(actor => actor.id));
    this.ai.store.installConversationPurge();
    if (config.personal) {
      const personal = config.personal;
      this.personal = new Personal(store.db, personal, requested => {
        if (requested) return this.ai.model(personal.owner, requested);
        if (options.assistantModel) return { model: options.assistantModel };
        const profile = this.ai.list(personal.owner).profiles.find(item => item.engine === "lumio");
        if (profile) return this.ai.model(personal.owner, profile.id);
        if (config.assistantModel) return { model: configuredModel(config.assistantModel) };
      }, id => !!this.workStore.task(id), now, this.signal);
    }
    this.decisionGate = new DecisionGate(this.ai.decisionGate, {
      signal: this.signal,
      timeoutMs: config.decisionGateTimeoutMs,
      minConfidence: config.decisionGateMinConfidence,
      fetch: options.jevFetch,
      meter: usage => {
        const actor = store.decisionGateActor();
        store.audit({ actor, label: "decision-gate" }, "decision.gate", "allow", undefined, JSON.stringify(usage));
      },
    });
    this.notices = new Notices(store, this, now, this.signal);
    // A1-8 / A1-9：后台巡检与提前探索。探索优先用人的 API Profile，没有时用 Hub 的旧 API 设置。
    this.explorations = new Explorations(store, this,
      () => options.assistantModel ?? (config.assistantModel ? configuredModel(config.assistantModel) : undefined),
      { max_tokens: config.explorationMaxTokens, max_ms: config.explorationMaxMs }, now, this.signal);
    this.watchdog = new Watchdog(store, this.notices, () => this.workStore.tasks(), config.watchdogIntervalMinutes * 60_000, now);
    this.funAsr = new FunAsr(options.funAsr, this.signal);
    // Work's live database projects are public; the knowledge vault is never consulted.
    this.speech = new SpeechConfiguration(new SqliteSpeechStore(store.db), this.ai.store, this.funAsr,
      () => this.work.projects().map(project => project.title), now);
    this.native=new NativeAssistant(this.ai.store,this,store,config,{ fetch: options.quotaFetch, now });
    const assistantContext: AssistantContext = {
      text: msg, now, id, toolActor: store.assistantActor(),
      glance: {
        claim: (owner, glance, message) => { this.glances.claim(glance, owner, "message", message); },
        finish: (owner, glance, message, decision) => this.voiceIdeas.finish(owner, glance, message, decision),
        context: (owner, glance, message) => glanceChat(this.glances.get(glance, owner), message, this.inbox, this.glances),
      },
      allowVoiceActions: true,
      recordIdea: (owner, turn, user, glance) => this.voiceIdeas.record(owner, turn, user, glance),
      resolveModel: (profile, owner) => this.ai.model(owner, profile),
      workbench: new AssistantWorkbenchAnchors(this, store, this.assistantMain, this.notices),
      native: {
        validate: (conversation, request) => this.native.validate(conversation, request),
        run: this.native.run,
        cancel: conversation => this.native.cancelConversation(conversation),
      },
    };
    this.assistant = new WorkbenchAssistant(this.assistantStore, options.assistantModel ?? configuredModel(config.assistantModel),
      [...this.capabilities.tools(), VoiceIdeas.tool(() => this.voiceIdeas),
        ...(config.vault ? [VoiceIdeas.saveTool(() => this.voiceIdeas)] : []), ...(options.assistantTools ?? [])], assistantContext, this.assistantMain, this.workbench);
    this.assistant.recover();
    this.reconcile();
    let nextEmbedding = 0;
    this.personal?.tick();
    this.timer = setInterval(() => {
      this.personal?.tick();
      if (now().getTime() >= nextEmbedding) {
        nextEmbedding = now().getTime() + 10_000;
        void this.semantic.refresh(store.actors().filter(actor => actor.role === "human").map(actor => actor.id));
      }
      try { this.reconcile(); } catch { /* Persisted pending results remain for the next pass. */ }
      try { this.jobActivity.sweep(now()); } catch { /* Retry the next interval. */ }
      try { this.native.usage.tick(); } catch { /* The next tick can retry quota collection. */ }
      void this.notifications.drain().catch(() => {});
      void this.notices.drain().catch(() => { /* Pending sources are retained for the next pass. */ });
      try { this.watchdog.tick(); } catch { /* The next interval reads the current state again. */ }
      void this.explorations.drain().catch(() => { /* Failures are recorded on the exploration. */ });
      void this.assistant.drainWorkbenchSummaries(this.signal).catch(() => { /* The durable queue retains the source range. */ });
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
  private dispatch(task: WorkTask, input: string, round: number, to: string | undefined, now: Date, previousJob?: string | null, grant?: AgentRun["permissions"], interaction?: AgentRun["interaction"], account?: JobAccountSelection) {
    const target = AgentTarget.safeParse(to);
    if (!target.success) throw new HubError("INVALID", { key: "modules.specify_an_agent_e_g_pi_server", args: [] });
    const stage = task.plan?.plan.stages.find(stage => stage.id === task.plan?.stage);
    const agentStage = stage?.kind === "agent" ? stage : undefined;
    const restrictedRound = Boolean(agentStage || grant || task.grants);
    const [agent, device = this.config.localRuntime] = target.data.split("@");
    const runtime = this.store.runtimes(now).find(value => value.registration.name === device);
    if (!runtime) {
      if (restrictedRound) throw new PlanDispatchUnavailable({ key: "target.stage_runtime_missing", args: [to] });
      throw new HubError("INVALID", { key: "modules.the_specified_runtime_is_not_registered_pair_it_first", args: [] });
    }
    const engine = runtime.registration.engines.find(value => value.name === agent);
    if (!engine) {
      if (restrictedRound) throw new PlanDispatchUnavailable({ key: "target.stage_engine_missing", args: [agent, device] });
      throw new HubError("INVALID", { key: "modules.selected_agent_is_not_registered_on_runtime", args: [] });
    }
    const base = agentStage ?? task.grants;
    const permissions = grant ? mergeStageGrant(base, grant) : base;
    const options: Pick<AgentRun, "permissions" | "hooks"> = permissions
      ? stageDispatchOptions({ ...permissions, hooks: agentStage?.hooks }, runtime, engine) : {};
    const mode = interaction ?? agentStage?.interaction;
    const intent: AgentRun = { kind: "agent", engine: engine.name, prompt: input, ...(mode ? { interaction: mode } : {}), ...options };
    const binding = authorizeJobAccount(this.store, runtime, intent, account);
    if (mode && !checkJobInteraction(this.store, runtime.actor, intent, now, Boolean(binding))) {
      throw new PlanDispatchUnavailable({ key: "jobs.interaction_unavailable", args: [] });
    }
    const scope = mode ? this.store.jobActivity.engines(runtime.actor).find(capability => capability.engine === engine.name)?.sandbox ?? engine.sandbox : engine.sandbox;
    const roundScope = roundPermissions(scope, options.permissions, restrictedRound);
    const requestHint = msg(runtime.registration.features?.includes("permission_request") && runtime.registration.features.includes("stage_permissions")
      ? "modules.round_permission_request" : "modules.round_permission_question");
    const project = task.project ? this.work.project(task.project) : undefined;
    const workdir = task.workdir ?? project?.workdir ?? "~";
    const jobs = new Jobs(this.store);
    const priorJobs = jobs.list(undefined, task.id);
    const originalWorkspace = priorJobs.find(job => job.spec.worktree);
    let worktree: import("@lumio/schema").JobSpec["worktree"];
    if (project?.auto_worktree) {
      if (!project.workdir || !project.worktree_base || task.workdir && task.workdir !== project.workdir) {
        throw new PlanDispatchUnavailable({ key: "jobs.worktree_configuration", args: [] });
      }
      if (!runtime.registration.features?.includes("project_worktree")) {
        throw new PlanDispatchUnavailable({ key: "jobs.worktree_unsupported", args: [] });
      }
      worktree = { project: project.id, task: task.id, base: project.worktree_base,
        ...(priorJobs.some(job => job.spec.worktree && job.result?.workspace) ? { reuse: true } : {}) };
    }
    if (originalWorkspace && (!worktree || originalWorkspace.spec.runtime !== runtime.actor
      || originalWorkspace.spec.workdir !== workdir || originalWorkspace.spec.worktree?.project !== worktree.project
      || originalWorkspace.spec.worktree.base !== worktree.base)) {
      throw new PlanDispatchUnavailable({ key: "jobs.worktree_binding_changed", args: [] });
    }
    if (mode) requireLocalInteractiveWorkdir(this.config, runtime.registration.name, workdir);
    else if (this.config.vault && runtime.registration.name === this.config.localRuntime && workdirInVault(this.config.vault, workdir)) {
      throw new HubError("INVALID", { key: "modules.working_directory_must_be_outside_the_knowledge_directory", args: [] });
    }
    const previous = previousJob === undefined ? priorJobs.at(-1) : previousJob ? jobs.get(previousJob) : undefined;
    if (grant && (!previous || previous.spec.runtime !== runtime.actor || previous.spec.run.kind !== "agent"
      || previous.spec.run.engine !== engine.name || previous.spec.workdir !== workdir)) {
      throw new PlanDispatchUnavailable({ key: "work.permission_context_changed", args: [] });
    }
    let session: AgentRun["session"];
    if (previous?.spec.run.kind === "agent" && Boolean(previous.spec.worktree) === Boolean(worktree) && sameJobAccount(this.store, previous, binding) && previous.spec.run.engine === engine.name && previous.spec.run.interaction === mode && previous.spec.runtime === runtime.actor && previous.result?.session_id) {
      session = { id: previous.result.session_id, resume: true };
    } else if (engine.name === "pi" || engine.name === "claude-code") session = { id: randomUUID(), resume: false };
    const prefix = stage?.kind === "agent" ? `Lumio stage ID: ${stage.id}\n` : "";
    const job = jobs.create({ runtime: runtime.actor, project: project?.id ?? null, worktree, workdir, timeout_seconds: (task.timeout_minutes ?? 120) * 60,
      ...(task.gpus ? { gpus: task.gpus } : {}), source: { task: task.id, round, ...(previous ? { previous: previous.spec.id } : {}) },
      run: { kind: "agent", engine: engine.name, ...(mode ? { interaction: mode } : {}), ...(task.model ? { model: task.model } : {}), ...(session ? { session } : {}), ...options,
        prompt: prefix + msg("modules.you_are_completing_round_of_a_user_task_work_only_in_the_working_dir", round, roundScope, input, requestHint) },
    }, now);
    if (binding) this.store.jobActivity.bindAccount({ ...binding, job: job.spec.id });
    return job;
  }
  reconcile(): void {
    const jobs = new Jobs(this.store);
    for (const execution of this.workStore.executions().filter((value) => !value.applied)) {
      try {
        const job = jobs.get(execution.job);
        if (!job.result) {
          this.work.applyResult(job);
          continue;
        }
        this.store.db.transaction(() => {
          const before = this.workStore.turns(execution.task).length;
          this.work.applyResult(job);
          const required = this.workStore.turns(execution.task).slice(before).some(change =>
            change.to.holder === "human" && (RESPONSE_REASONS as readonly string[]).includes(change.to.reason));
          this.notices.round(job, execution.task, required);
        })();
      }
      catch (cause) { if (!(cause instanceof HubError && cause.code === "NOT_FOUND") && !(cause instanceof CoreError)) throw cause; }
    }
  }
  runtimeRound(job: Job): void {
    const task = job.spec.source?.task;
    if (task && this.workStore.executions(task).some(execution => execution.job === job.spec.id)) return;
    this.notices.round(job);
  }
  stop(): void { clearInterval(this.timer); this.stopped.abort(); this.store.proposalCreated = undefined; }
}
