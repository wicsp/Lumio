import { AiNotes } from "./ai-notes.ts";
import { KNOWLEDGE_ROUTES, KnowledgeAuthoring, type PaperFetch } from "./knowledge-authoring.ts";
import { migrateTaskModel } from "@lumio/storage";
import { withLanguage, errorMessage, text as msg } from "./messages.ts";
import { language, type Language } from "@lumio/platform";
import { browserAllowed, browserDenied, webResponse, webFileResponse, type HubWeb } from "./web.ts";
import { Pairing, handlePairing } from "./pairing.ts";
import { Privileged, handlePrivileged } from "./privileged.ts";
import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { CoreError } from "@lumio/foundation";
import { checkLinks, noteLinks, searchNotes, showNote, type SearchOptions } from "@lumio/storage";
import { ApiError, NOTE_TYPES, type ApiErrorCode } from "@lumio/schema";
import { version } from "./version.ts";
import { startVaultWatch, type WatchOptions } from "./watch.ts";
import { handleOperation, type OperationOptions } from "./operations.ts";
import { handleJobs } from "./jobs.ts";
import { handleRuntime } from "./runtime.ts";
import { authorize, PAIRING_OPERATIONS, type PairingOperation } from "./authorize.ts";
import { networkWarning, rememberLocalRuntime, type HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore, type Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import { TaskRounds, type TaskOptions } from "./tasks.ts";
import { Routines, type RoutineOptions } from "./routines.ts";
import type { RoutineHooks } from "./jobs.ts";
import { BusinessModules } from "./modules.ts";
import { SPEECH_PATH, BINDINGS_PATH, VOCABULARY_PATH } from "./speech-config.ts";
import { SpeechSessions, type SpeechSocketData } from "./speech.ts";
import type { FunAsrOptions } from "./fun-asr.ts";
import { AssistantConfiguration } from "./assistant-config.ts";
import { configuredModel } from "./assistant-model.ts";
import { V2_ROUTES, handleV2 } from "./v2.ts";
import { Trash } from "./trash.ts";
import { WriteCoordinator } from "./coordinator.ts";
import type { AssistantModel, AssistantTool } from "@lumio/assistant";
import { KnowledgeService } from "@lumio/knowledge";
import { FileKnowledgeRepository, acquireStateLease, isMigratedSource, legacyControlDisabled } from "@lumio/storage";

// Routes share authentication, authorization and logging before dispatch.
export const ROUTES = [
  ...KNOWLEDGE_ROUTES,
  { operation: "runtime.invite", method: "POST", pattern: /^\/v1\/runtime-invites$/ },
  { operation: "client.invite", method: "POST", pattern: /^\/v1\/client-invites$/ },
  { operation: "runtime.join", method: "POST", pattern: /^\/v1\/runtime\/join$/ },
  { operation: "client.join", method: "POST", pattern: /^\/v1\/client\/join$/ },
  { operation: "runtime.signing-key", method: "GET", pattern: /^\/v1\/runtime\/signing-key$/ },
  { operation: "runtime.remove", method: "DELETE", pattern: /^\/v1\/runtimes\/([^/]+)$/ },
  { operation: "runtime.privileged.status", method: "GET", pattern: /^\/v1\/runtime\/privileged\/([^/]+)$/ },
  { operation: "runtime.privileged.report", method: "POST", pattern: /^\/v1\/runtime\/privileged$/ },
  { operation: "job.submit", method: "POST", pattern: /^\/v1\/jobs$/ },
  { operation: "jobs", method: "GET", pattern: /^\/v1\/jobs$/ },
  { operation: "job.show", method: "GET", pattern: /^\/v1\/jobs\/([^/]+)$/ },
  { operation: "job.cancel", method: "POST", pattern: /^\/v1\/jobs\/([^/]+)\/cancel$/ },
  { operation: "runtime.ack", method: "POST", pattern: /^\/v1\/runtime\/ack$/ },
  { operation: "runtime.results", method: "POST", pattern: /^\/v1\/runtime\/results$/ },
  { operation: "runtime.register", method: "POST", pattern: /^\/v1\/runtime\/register$/ },
  { operation: "runtime.sync", method: "POST", pattern: /^\/v1\/runtime\/sync$/ },
  { operation: "runtimes", method: "GET", pattern: /^\/v1\/runtimes$/ },
  { operation: "routines", method: "GET", pattern: /^\/v1\/routines$/ },
  { operation: "operations", method: "POST", pattern: /^\/v1\/operations$/ },
  { operation: "actors", method: "GET", pattern: /^\/v1\/actors$/ },
  { operation: "proposals", method: "GET", pattern: /^\/v1\/proposals$/ },
  { operation: "proposal.accept", method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/accept$/ },
  { operation: "proposal.reject", method: "POST", pattern: /^\/v1\/proposals\/([^/]+)\/reject$/ },
  { operation: "status", pattern: /^\/v1\/status$/ },
  { operation: "health", pattern: /^\/health$/ },
  { operation: "search", pattern: /^\/v1\/search$/ },
  { operation: "check", pattern: /^\/v1\/check$/ },
  { operation: "links", pattern: /^\/v1\/notes\/([^/]+)\/links$/ },
  { operation: "show", pattern: /^\/v1\/notes\/([^/]+)$/ },
] as const;
const STATUS: Record<ApiErrorCode, number> = { INVALID: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL: 500 };

async function startHubInstance(config: HubConfig, options: {
  web?: HubWeb;
  log?: (line: string) => void;
  now?: () => Date;
  authorize?: typeof authorize;
  watch?: WatchOptions;
  operations?: OperationOptions;
  tasks?: TaskOptions;
  routines?: RoutineOptions;
  assistantHome?: string;
  assistantFetch?: typeof fetch;
  paperFetch?: PaperFetch;
  pushFetch?: typeof fetch;
  quotaFetch?: typeof fetch;
  funAsr?: FunAsrOptions;
  assistantModel?: AssistantModel;
  assistantTools?: AssistantTool[];
} = {}) {
  if (config.vault && !(await stat(config.vault)).isDirectory()) throw new HubError("INVALID", { key: "server.lumio_vault_must_be_a_directory", args: [] });
  config = { ...config, localRuntime: await rememberLocalRuntime(config.stateDir, config.localRuntime) };
  const store = await HubStore.open(config.stateDir);
  const knowledge = config.vault ? new KnowledgeService(new FileKnowledgeRepository(config.vault, { stateDir: config.stateDir })) : undefined;
  const privileged = new Privileged(store, options.now);
  const pairing = new Pairing(store, config, options.now);
  const log = options.log ?? console.log;
  const warning = networkWarning(config);
  if (warning) log(warning);
  const decide = options.authorize ?? authorize;
  let server: Bun.Server<SpeechSocketData>;
  let vaultWatch: Awaited<ReturnType<typeof startVaultWatch>> | undefined;
  let tasks: TaskRounds | undefined;
  let routines: Routines | undefined;
  let modules: BusinessModules | undefined;
  const hooks: RoutineHooks = {
    plans: (actor) => [...(legacyControlDisabled(store.db) ? [] : routines?.plans(actor) ?? []).filter((plan) => !modules?.routineStore.get(plan.routine)), ...(modules?.routines.plans(actor) ?? [])],
    adopt: (actor, id, now, lease) => modules?.routines.adopt(actor, id, now, lease) ?? (legacyControlDisabled(store.db) ? undefined : routines?.adopt(actor, id, now)),
  };
  try {
    const assistantConfig = new AssistantConfiguration({ home: options.assistantHome ?? config.assistantHome, external: config.assistantModel, fetch: options.assistantFetch,
      reload: model => modules!.assistant.setModel(configuredModel(model)) });
    const model = await assistantConfig.load();
    await migrateTaskModel(store.db, config.stateDir, store.workActor().id, options.now?.() ?? new Date());
    modules = new BusinessModules({ ...config, assistantModel: model }, store, options);
    modules.assistantConfig = assistantConfig;
    await modules.artifacts.recover();
    const writes = new WriteCoordinator();
    vaultWatch = config.vault ? await startVaultWatch(config, { ...options.watch, log,
      onNote: async (path) => { await options.watch?.onNote?.(path); await tasks?.noteChanged(path); await routines?.noteChanged(path); } }) : {
        exclusive: <T>(action: () => Promise<T>) => writes.exclusive(action),
        notify: (_path: string) => {}, issue: (_path: string, line: string) => log(line), drain: () => writes.drain(),
        status: async () => ({ watching: false, last_full_sync: null, pending_files: 0, issues: [] }), stop: () => writes.drain(),
      };
    const watch = vaultWatch;
    if (config.vault) modules.aiNotes = new AiNotes(config, store, modules.resources,
      action => watch.exclusive(action), (path, message) => watch.issue(path, message), options.now ?? (() => new Date()));
    modules.trash = new Trash(config, store, modules, action => watch.exclusive(action), options.now ?? (() => new Date()), (path, message) => watch.issue(path, message));
    await modules.trash.sweep();
    modules.trash.start();
    const authoring = new KnowledgeAuthoring(config, store, action => watch.exclusive(action), (path, message) => watch.issue(path, message), options.paperFetch);
    tasks = new TaskRounds(config, store, new Jobs(store, hooks), (action) => watch.exclusive(action), (path, line) => watch.issue(path, line), { ...options.tasks,
      isManaged: (path, id) => legacyControlDisabled(store.db) || isMigratedSource(store.db, path) || !!(id && modules!.workStore.task(id)) || !!options.tasks?.isManaged?.(path, id) });
    routines = new Routines(config, store, new Jobs(store, hooks), (action) => watch.exclusive(action), (path, line) => watch.issue(path, line), { ...options.routines,
      isManaged: (path, id) => legacyControlDisabled(store.db) || isMigratedSource(store.db, path) || !!(id && modules!.routineStore.get(id)) || !!options.routines?.isManaged?.(path, id) });
    if (config.vault) {
      await watch.exclusive(() => tasks!.start());
      await watch.exclusive(() => routines!.start());
    }
    const speech = new SpeechSessions(modules.speech, modules.funAsr, store, options.now ?? (() => new Date()), log);
    const handle = async (request: Request, server: Bun.Server<SpeechSocketData>, lang: Language): Promise<Response | undefined> => {
        const start = performance.now();
        const time = new Date().toISOString();
        const url = new URL(request.url);
        let identity: Identity | null = null;
        let status = 500;
        // Logging uses route templates, so references (or secrets in a URL) cannot leak.
        const v2 = V2_ROUTES.find((route) => request.method === route.method && route.pattern.test(url.pathname));
        const route = v2 ?? ROUTES.find((route) => request.method === ("method" in route ? route.method : "GET") && route.pattern.test(url.pathname));
        const speechPath = [SPEECH_PATH, VOCABULARY_PATH, BINDINGS_PATH].includes(url.pathname);
        const path = speechPath ? url.pathname : route?.operation.startsWith("knowledge.") ? `/v2/knowledge/${route.operation.split(".")[1]}` : v2 ? v2.path : route && (PAIRING_OPERATIONS as readonly string[]).includes(route.operation) ? `/pairing/${route.operation}` : route?.operation === "runtime.privileged.status" ? "/v1/runtime/privileged/<id>" : route?.operation === "runtime.privileged.report" ? "/v1/runtime/privileged" : route?.operation === "job.submit" || route?.operation === "jobs" ? "/v1/jobs" : route?.operation === "job.show" ? "/v1/jobs/<id>" : route?.operation === "job.cancel" ? "/v1/jobs/<id>/cancel" : route?.operation === "runtime.ack" ? "/v1/runtime/ack" : route?.operation === "runtime.results" ? "/v1/runtime/results" : route?.operation === "runtime.register" ? "/v1/runtime/register" : route?.operation === "runtime.sync" ? "/v1/runtime/sync" : route?.operation === "runtimes" ? "/v1/runtimes" : route?.operation === "routines" ? "/v1/routines" : route?.operation === "status" ? "/v1/status" : route?.operation === "health" ? "/health" : route?.operation === "search" ? "/v1/search"
          : route?.operation === "check" ? "/v1/check" : route?.operation === "show" ? "/v1/notes/<reference>" : route?.operation === "links" ? "/v1/notes/<reference>/links" : route?.operation === "operations" ? "/v1/operations"
            : route?.operation === "actors" ? "/v1/actors" : route?.operation === "proposals" ? "/v1/proposals"
              : route?.operation === "proposal.accept" ? "/v1/proposals/<id>/accept" : route?.operation === "proposal.reject" ? "/v1/proposals/<id>/reject" : "<unmatched>";
        let clientIp = server.requestIP(request)?.address ?? null;
        if (config.trustedProxy && clientIp === config.trustedProxy) {
          const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
          if (forwarded && isIP(forwarded)) clientIp = forwarded;
        }
        try {
          if (!browserAllowed(request, config, server.port!)) { status = 403; return browserDenied(); }
          if (url.pathname === SPEECH_PATH && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            if (!server.upgrade(request, { data: { lang } })) {
              throw new HubError("INVALID", { key: "speech.upgrade_failed", args: [] });
            }
            status = 101;
            return undefined;
          }
          const file = options.web?.files.get(url.pathname);
          if (file && ["GET", "HEAD"].includes(request.method)) {
            status = 200;
            return webFileResponse(file, request.method, options.web!.csp);
          }
          if (url.pathname === "/" && !options.web) { status = 404; return Response.json(ApiError.parse({ error: { code: "NOT_FOUND", message: msg("server.endpoint_not_found") } }), { status }); }
          if(url.pathname.startsWith("/v2/native-mcp/")){const response=await modules!.native.mcpHandle(request);status=response.status;return response;}
          if (route?.operation === "health") identity = store.authenticate(request.headers.get("authorization"), (options.now ?? (() => new Date()))());
          if (route?.operation !== "health" && route?.operation !== "runtime.join" && route?.operation !== "client.join") {
            identity = store.authenticate(request.headers.get("authorization"), (options.now ?? (() => new Date()))());
            if (!identity) throw new HubError("UNAUTHENTICATED", { key: "server.a_valid_bearer_token_is_required", args: [] });
          }
          if (speechPath) {
            const response = await modules!.speech.handle(request, identity!);
            status = response.status;
            return response;
          }
          if(url.pathname.startsWith("/v2/runtime/native")){const response=await modules!.native.channel(request,identity!);status=response.status;return response;}
          if(url.pathname==="/v2/runtime/claude-usage"){const response=await modules!.native.usage.claude(request,identity!);status=response.status;return response;}
          if(url.pathname==="/v2/ai/usage"||/^\/v2\/ai\/connections\/[^/]+\/usage\//.test(url.pathname)){
            const response=await modules!.native.usage.human(request,identity!);
            store.audit(identity!,"assistant.config","allow",undefined,"applied");status=response.status;return response;
          }
          if(url.pathname.startsWith("/v2/ai/")||url.pathname.startsWith("/v2/assistant/native-sessions")){const response=await modules!.native.handle(request,identity!);store.audit(identity!,"assistant.config","allow",undefined,"applied");status=response.status;return response;}
          if (!route) throw new HubError("NOT_FOUND", { key: "server.endpoint_not_found", args: [] });
          const knowledgeRoute = KNOWLEDGE_ROUTES.find(item => item.operation === route.operation);
          if (knowledgeRoute) {
            const response = await authoring.handle(request, knowledgeRoute.operation, identity!, decide, (options.now ?? (() => new Date()))());
            status = response.status; return response;
          }
          if (v2) {
            const response = await handleV2(request, server, v2, identity!, store, modules!, decide, (options.now ?? (() => new Date()))());
            status = response.status; return response;
          }
          if ((PAIRING_OPERATIONS as readonly string[]).includes(route.operation)) {
            const response = await handlePairing(request, route.operation as PairingOperation, route.pattern.exec(url.pathname)?.[1], identity, store, decide, pairing, privileged);
            status = response.status; return response;
          }
          if (route.operation === "runtime.privileged.status" || route.operation === "runtime.privileged.report") {
            const response = await handlePrivileged(request, route.operation, route.pattern.exec(url.pathname)?.[1], identity!, store, decide, privileged);
            status = response.status; return response;
          }
          if (route.operation === "jobs" || route.operation === "job.show") {
            // Keep runtime rejection ahead of v1 argument parsing, including malformed references.
            const decision = decide(identity!.actor, { operation: route.operation });
            if (decision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : msg("v2.approval_required") });
            const reference = route.pattern.exec(url.pathname)?.[1];
            if (route.operation === "job.show" && !/^job_[0-9A-HJKMNP-TV-Z]{26}$/.test(reference ?? "")) throw new HubError("NOT_FOUND", { key: "jobs.job_not_found", args: [] });
            const args = route.operation === "job.show" ? { job: reference } : Object.fromEntries([...url.searchParams].map(([key, value]) => [key, key === "limit" ? Number(value) : value]));
            status = 200; return Response.json((await modules!.capabilities.execute(route.operation === "jobs" ? "execution.job.list" : "execution.job.show", args, identity!, undefined, { chronologicalJobs: true })).result);
          }
          if (route.operation === "job.submit" || route.operation === "job.cancel") {
            const response = await handleJobs(request, route.operation, route.pattern.exec(url.pathname)?.[1], identity!, store, decide, (options.now ?? (() => new Date()))());
            status = response.status; return response;
          }
          if (route.operation === "runtime.register" || route.operation === "runtime.sync" || route.operation === "runtime.ack" || route.operation === "runtime.results" || route.operation === "runtimes") {
            const response = await handleRuntime(request, route.operation, identity!, store, decide, (options.now ?? (() => new Date()))(), hooks);
            status = response.status;
            // 结果到了就尽快写回笔记（失败的留给定时任务重试）。
            if (route.operation === "runtime.results" && response.status === 200) {
              modules!.reconcile();
              void vaultWatch!.exclusive(async () => { await tasks!.writeResults(); await routines!.writeResults(); }).catch(() => {});
            }
            return response;
          }
          if (route.operation === "routines") {
            const decision = decide(identity!.actor, { operation: "routines" });
            if (decision.result !== "allow") {
              store.auditDenied(identity!, route.operation);
              throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : "Approval required" });
            }
            status = 200; return Response.json(routines!.list());
          }
          // Reject runtime access before reading operation bodies or querying the vault.
          if (identity?.actor.role === "runtime" && ["actors", "proposals", "proposal.accept", "proposal.reject"].includes(route.operation)) {
            const decision = decide(identity.actor, { operation: route.operation });
            if (decision.result !== "allow") {
              store.auditDenied(identity, route.operation);
              throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] }, { reason: decision.result === "deny" ? decision.reason : "Approval required" });
            }
          }
          if (route.operation === "proposals" && (!url.searchParams.has("status") || url.searchParams.get("status") === "pending")) {
            status = 200; return Response.json((await modules!.capabilities.execute("approval.proposal.list", {}, identity!)).result);
          }
          if (route.operation === "operations" || route.operation === "actors" || route.operation === "proposals" || route.operation === "proposal.accept" || route.operation === "proposal.reject") {
            const response = await vaultWatch!.exclusive(() => handleOperation(request,
              route.operation,
              route.pattern.exec(url.pathname)?.[1], identity!, store, config, decide, { ...options.operations, tasks, routines, privileged, workCommands: modules!.workCommands,
                isManagedTask: (id) => legacyControlDisabled(store.db) || modules!.workStore.task(id) !== undefined,
                isManagedRoutine: (id) => legacyControlDisabled(store.db) || modules!.routineStore.get(id) !== undefined }));
            status = response.status;
            return response;
          }
          const privateValue = url.searchParams.get("include_private");
          const includePrivate = privateValue === "true";
          const decision = decide(identity?.actor ?? null, { operation: route.operation, includePrivate: route.operation === "health" ? false : includePrivate });
          if (decision.result !== "allow") {
            if (identity) store.auditDenied(identity, route.operation);
            status = 403;
            return Response.json(ApiError.parse({ error: { code: "FORBIDDEN", message: msg("server.request_not_authorized"), reason: decision.result === "deny" ? decision.reason : "Approval required" } }), { status });
          }
          if (route.operation === "health") { status = 200; return Response.json({ ok: true, version }); }
          if (privateValue !== null && privateValue !== "true" && privateValue !== "false") throw new HubError("INVALID", { key: "server.include_private_must_be_true_or_false", args: [] });
          const queryOptions: SearchOptions = { stateDir: config.stateDir, includePrivate };
          if (!config.vault && ["search", "show", "links", "check"].includes(route.operation)) throw new HubError("INVALID", { key: "server.no_knowledge_directory_configured_work_and_execution_are_available_i", args: [] });
          let result: unknown;
          if (route.operation === "status") {
            result = await vaultWatch!.status(includePrivate);
          } else if (route.operation === "check") {
            result = await knowledge!.check(queryOptions);
          } else if (route.operation === "search") {
            const type = url.searchParams.get("type");
            const limit = url.searchParams.get("limit");
            if (type !== null && !NOTE_TYPES.includes(type as SearchOptions["type"] & string)) throw new HubError("INVALID", { key: "query.unknown_note_type", args: [] });
            if (limit !== null && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)))) throw new HubError("INVALID", { key: "query.limit_must_be_a_positive_integer", args: [] });
            const query = url.searchParams.get("q") ?? "";
            // v1 also supports listing all notes and unbounded limits, outside the catalog's search arguments.
            result = !query || (limit !== null && Number(limit) > 100) ? await knowledge!.search(query, { ...queryOptions,
              ...(type !== null ? { type: type as SearchOptions["type"] } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) })
              : (await modules!.capabilities.execute("knowledge.note.search", { query,
                ...(type !== null ? { type } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) }, identity!, undefined, { includePrivate })).result;
          } else {
            let reference: string;
            try { reference = decodeURIComponent(route.pattern.exec(url.pathname)![1]!); }
            catch { throw new HubError("INVALID", { key: "server.invalid_url_encoding_in_reference", args: [] }); }
            result = (await modules!.capabilities.execute(route.operation === "show" ? "knowledge.note.show" : "knowledge.note.links", { ref: reference }, identity!, undefined, { includePrivate })).result;
          }
          status = 200;
          return Response.json(result);
        } catch (cause) {
          let code: ApiErrorCode = "INTERNAL", message = msg("server.hub_could_not_process_the_request");
          let details: Omit<ApiError["error"], "code" | "message"> = {};
          if (cause instanceof HubError) { code = cause.code; message = errorMessage(cause); details = cause.details; }
          else if(cause instanceof Error&&cause.name==="ZodError"){code="INVALID";message=msg("ai.invalid");}
          else if (cause instanceof CoreError) {
            if (cause.code === "NOTE_NOT_FOUND") { code = "NOT_FOUND"; message = errorMessage(cause); }
            else if (["INVALID_QUERY", "INVALID_LIMIT", "AMBIGUOUS_REFERENCE"].includes(cause.code)) { code = "INVALID"; message = errorMessage(cause); }
          }
          status = STATUS[code];
          return Response.json(ApiError.parse({ error: { code, message, ...details } }), { status });
        } finally {
          if (identity && status < 400) store.activity(identity);
          log(JSON.stringify({ time, actor_id: identity?.actor.id ?? null, token_label: identity?.label ?? null,
            method: request.method, path, status, duration_ms: performance.now() - start, client_ip: clientIp }));
        }
    };
    server = Bun.serve<SpeechSocketData>({ hostname: config.hostname, port: config.port,
      websocket: speech.handlers(),
      async fetch(request, server) {
        const lang = language({ LUMIO_LANG: request.headers.get("Accept-Language") ?? undefined });
        const response = await withLanguage(lang, () => handle(request, server, lang));
        return response && webResponse(response, options.web?.csp);
      },
    });
    modules.native.setPort(server.port!);
  } catch (cause) { modules?.stop(); await modules?.trash?.stop(); await modules?.notifications.stop(); tasks?.stop(); routines?.stop(); await vaultWatch?.stop(); store.close(); throw cause; }
  return { server, store, tasks: tasks!, routines: routines!, modules: modules!, async stop() { modules?.stop(); await modules?.native.stop(); await server.stop(true); await modules?.speech.drain(); await modules?.trash?.stop(); await modules?.notifications.stop(); await modules?.artifacts.drain(); tasks?.stop(); routines?.stop(); await vaultWatch?.stop(); store.close(); } };
}

/** One Hub or offline migration owns a state directory. OS locks disappear on crashes, without deleting lock files. */
export async function startHub(config: HubConfig, options: Parameters<typeof startHubInstance>[1] = {}) {
  const lease = await acquireStateLease(config.stateDir);
  try {
    const hub = await withLanguage("en", () => startHubInstance(config, options)); let stopped: Promise<void> | undefined;
    return { ...hub, stop() { stopped ??= hub.stop().finally(() => lease.close()); return stopped; } };
  } catch (cause) { lease.close(); throw cause; }
}
