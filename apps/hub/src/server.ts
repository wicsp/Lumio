import { AiNotes } from "./ai-notes.ts";
import { KNOWLEDGE_ROUTES, KnowledgeAuthoring, type PaperFetch } from "./knowledge-authoring.ts";
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
import { UpdateArtifacts } from "./update-artifacts.ts";
import { notifyRuntimeUpdate } from "./runtime-updates.ts";
import { authorize, PAIRING_OPERATIONS, type PairingOperation } from "./authorize.ts";
import { localHubUrl, networkWarning, rememberLocalRuntime, type HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore, type Identity } from "./store.ts";
import { Jobs } from "./jobs.ts";
import type { RoutineHooks } from "./jobs.ts";
import { BusinessModules } from "./modules.ts";
import { SPEECH_PATH, BINDINGS_PATH, VOCABULARY_PATH } from "./speech-config.ts";
import { SpeechSessions, type SpeechSocketData } from "./speech.ts";
import type { FunAsrOptions } from "./fun-asr.ts";
import type { JevFetch } from "./jev.ts";
import { AssistantConfiguration } from "./assistant-config.ts";
import { InboxProxySettings } from "./inbox-proxy-settings.ts";
import { configuredModel } from "./assistant-model.ts";
import { V2_ROUTES, handleV2 } from "./v2.ts";
import { Inbox, type InboxOptions } from "./inbox.ts";
import { Glances } from "./glances.ts";
import { Trash } from "./trash.ts";
import { WriteCoordinator } from "./coordinator.ts";
import type { AssistantModel, AssistantTool } from "@lumio/assistant";
import { KnowledgeService } from "@lumio/knowledge";
import { FileKnowledgeRepository, acquireStateLease } from "@lumio/storage";

// Routes share authentication, authorization and logging before dispatch.
export const ROUTES = [
  ...KNOWLEDGE_ROUTES,
  { operation: "runtime.invite", method: "POST", pattern: /^\/v2\/setup\/runtime-invites$/, path: "/v2/setup/runtime-invites" },
  { operation: "client.invite", method: "POST", pattern: /^\/v2\/setup\/client-invites$/, path: "/v2/setup/client-invites" },
  { operation: "runtime.join", method: "POST", pattern: /^\/v2\/setup\/runtime\/join$/, path: "/v2/setup/runtime/join" },
  { operation: "client.join", method: "POST", pattern: /^\/v2\/setup\/client\/join$/, path: "/v2/setup/client/join" },
  { operation: "runtime.signing-key", method: "GET", pattern: /^\/v2\/setup\/runtime\/signing-key$/, path: "/v2/setup/runtime/signing-key" },
  { operation: "runtime.remove", method: "DELETE", pattern: /^\/v2\/execution\/runtimes\/([^/]+)$/, path: "/v2/execution/runtimes/<name>" },
  { operation: "runtime.privileged.status", method: "GET", pattern: /^\/v1\/runtime\/privileged\/([^/]+)$/, path: "/v1/runtime/privileged/<id>" },
  { operation: "runtime.privileged.report", method: "POST", pattern: /^\/v1\/runtime\/privileged$/, path: "/v1/runtime/privileged" },
  { operation: "runtime.job-activity", method: "POST", pattern: /^\/v1\/runtime\/job-activity\/sync$/, path: "/v1/runtime/job-activity/sync" },
  { operation: "job.activity.read", method: "GET", pattern: /^\/v2\/execution\/activity\/capabilities$/, path: "/v2/execution/activity/capabilities" },
  { operation: "job.activity.attention", method: "GET", pattern: /^\/v2\/execution\/attention$/, path: "/v2/execution/attention" },
  { operation: "job.activity.read", method: "GET", pattern: /^\/v2\/execution\/jobs\/(job_[0-9A-HJKMNP-TV-Z]{26})\/(live|events)$/, path: "/v2/execution/jobs/<job>/activity" },
  { operation: "job.activity.actions", method: "POST", pattern: /^\/v2\/execution\/jobs\/(job_[0-9A-HJKMNP-TV-Z]{26})\/actions$/, path: "/v2/execution/jobs/<job>/actions" },
  { operation: "job.submit", method: "POST", pattern: /^\/v2\/execution\/jobs$/, path: "/v2/execution/jobs" },
  { operation: "job.cancel", method: "POST", pattern: /^\/v2\/execution\/jobs\/([^/]+)\/cancel$/, path: "/v2/execution/jobs/<job>/cancel" },
  { operation: "runtime.ack", method: "POST", pattern: /^\/v1\/runtime\/ack$/, path: "/v1/runtime/ack" },
  { operation: "runtime.results", method: "POST", pattern: /^\/v1\/runtime\/results$/, path: "/v1/runtime/results" },
  { operation: "runtime.register", method: "POST", pattern: /^\/v1\/runtime\/register$/, path: "/v1/runtime/register" },
  { operation: "runtime.sync", method: "POST", pattern: /^\/v1\/runtime\/sync$/, path: "/v1/runtime/sync" },
  { operation: "runtimes", method: "GET", pattern: /^\/v2\/execution\/runtimes$/, path: "/v2/execution/runtimes" },
  { operation: "operations", method: "POST", pattern: /^\/v2\/approval\/privileged$/, path: "/v2/approval/privileged" },
  // The preceding release of Runtime can still request an elevated command.
  { operation: "operations", method: "POST", pattern: /^\/v1\/operations$/, path: "/v1/operations" },
  { operation: "actors", method: "GET", pattern: /^\/v2\/system\/actors$/, path: "/v2/system/actors" },
  { operation: "proposals", method: "GET", pattern: /^\/v2\/approval\/proposals$/, path: "/v2/approval/proposals" },
  { operation: "proposal.accept", method: "POST", pattern: /^\/v2\/approval\/proposals\/([^/]+)\/accept$/, path: "/v2/approval/proposals/<id>/accept" },
  { operation: "proposal.reject", method: "POST", pattern: /^\/v2\/approval\/proposals\/([^/]+)\/reject$/, path: "/v2/approval/proposals/<id>/reject" },
  { operation: "status", pattern: /^\/v2\/system\/status$/, path: "/v2/system/status" },
  { operation: "health", pattern: /^\/health$/, path: "/health" },
  { operation: "search", pattern: /^\/v2\/knowledge\/search$/, path: "/v2/knowledge/search" },
  { operation: "check", pattern: /^\/v2\/knowledge\/check$/, path: "/v2/knowledge/check" },
  { operation: "links", pattern: /^\/v2\/knowledge\/notes\/([^/]+)\/links$/, path: "/v2/knowledge/notes/<reference>/links" },
  { operation: "show", pattern: /^\/v2\/knowledge\/notes\/([^/]+)$/, path: "/v2/knowledge/notes/<reference>" },
] as const;
const STATUS: Record<ApiErrorCode, number> = { INVALID: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL: 500 };

async function startHubInstance(config: HubConfig, options: {
  web?: HubWeb;
  log?: (line: string) => void;
  now?: () => Date;
  authorize?: typeof authorize;
  watch?: WatchOptions;
  operations?: OperationOptions;
  assistantHome?: string;
  assistantFetch?: typeof fetch;
  paperFetch?: PaperFetch;
  inbox?: InboxOptions;
  pushFetch?: typeof fetch;
  quotaFetch?: typeof fetch;
  jevFetch?: JevFetch;
  funAsr?: FunAsrOptions;
  assistantModel?: AssistantModel;
  assistantTools?: AssistantTool[];
} = {}) {
  if (config.vault && !(await stat(config.vault)).isDirectory()) throw new HubError("INVALID", { key: "server.lumio_vault_must_be_a_directory", args: [] });
  config = { ...config, localRuntime: await rememberLocalRuntime(config.stateDir, config.localRuntime) };
  const store = await HubStore.open(config.stateDir);
  const knowledge = config.vault ? new KnowledgeService(new FileKnowledgeRepository(config.vault, { stateDir: config.stateDir })) : undefined;
  const privileged = new Privileged(store, options.now);
  const log = options.log ?? console.log;
  const warning = networkWarning(config);
  if (warning) log(warning);
  const decide = options.authorize ?? authorize;
  let server: Bun.Server<SpeechSocketData>;
  const pairing = new Pairing(store, config, () => localHubUrl(config.hostname, server.port!), options.now);
  let vaultWatch: Awaited<ReturnType<typeof startVaultWatch>> | undefined;
  let modules: BusinessModules | undefined;
  const hooks: RoutineHooks = {
    plans: (actor) => modules?.routines.plans(actor) ?? [],
    adopt: (actor, id, now, lease) => modules?.routines.adopt(actor, id, now, lease),
  };
  try {
    const assistantConfig = new AssistantConfiguration({ home: options.assistantHome ?? config.assistantHome, external: config.assistantModel, fetch: options.assistantFetch,
      reload: model => modules!.assistant.setModel(configuredModel(model)) });
    const model = await assistantConfig.load();
    modules = new BusinessModules({ ...config, assistantModel: model }, store, options);
    modules.assistantConfig = assistantConfig;
    await modules.artifacts.recover();
    const writes = new WriteCoordinator();
    vaultWatch = config.vault ? await startVaultWatch(config, { ...options.watch, log }) : {
        exclusive: <T>(action: () => Promise<T>) => writes.exclusive(action),
        notify: (_path: string) => {}, issue: (_path: string, line: string) => log(line), drain: () => writes.drain(),
        status: async () => ({ watching: false, last_full_sync: null, pending_files: 0, issues: [] }), stop: () => writes.drain(),
      };
    const watch = vaultWatch;
    if (config.vault) modules.aiNotes = new AiNotes(config, store, modules.resources,
      action => watch.exclusive(action), (path, message) => watch.issue(path, message), options.now ?? (() => new Date()));
    const now = options.now ?? (() => new Date());
    const inboxProxy = await InboxProxySettings.open(config.stateDir);
    modules.glances = new Glances(config, store, modules.artifacts, action => watch.exclusive(action), () => server.port!, now);
    const inbox = modules.inbox = new Inbox(config, store, modules.ai, () => modules!.trash,
      action => watch.exclusive(action), now, (path, message) => watch.issue(path, message), inboxProxy, options.inbox,
      capture => modules!.notices.capture(capture), modules.glances);
    modules.trash = new Trash(config, store, modules, action => watch.exclusive(action), now, (path, message) => watch.issue(path, message), inbox);
    await modules.trash.sweep();
    modules.trash.start();
    const authoring = new KnowledgeAuthoring(config, store, action => watch.exclusive(action), (path, message) => watch.issue(path, message), options.paperFetch);
    const speech = new SpeechSessions(modules.speech, modules.funAsr, store, options.now ?? (() => new Date()), log);
    const updateArtifacts = new UpdateArtifacts(config.stateDir, store.runtimeVersion);
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
        const path = speechPath ? url.pathname : route && "path" in route ? route.path
          : route ? `/v2/knowledge/${route.operation.split(".")[1]}` : "<unmatched>";
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
          if (url.pathname.startsWith("/v2/execution/updates/")) { const response = await updateArtifacts.handle(request, identity!); status = response.status; return response; }
          if(url.pathname==="/v2/runtime/claude-usage"){const response=await modules!.native.usage.claude(request,identity!);status=response.status;return response;}
          if(url.pathname==="/v2/ai/usage"||/^\/v2\/ai\/connections\/[^/]+\/usage\//.test(url.pathname)){
            const response=await modules!.native.usage.human(request,identity!);
            store.audit(identity!,"assistant.config","allow",undefined,"applied");status=response.status;return response;
          }
          if((url.pathname.startsWith("/v2/ai/") && url.pathname !== "/v2/ai/knowledge-bindings")||url.pathname.startsWith("/v2/assistant/native-sessions")){const response=await modules!.native.handle(request,identity!);store.audit(identity!,"assistant.config","allow",undefined,"applied");status=response.status;return response;}
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
          if (route.operation === "runtime.job-activity" || route.operation === "job.activity.attention"
            || route.operation === "job.activity.read" || route.operation === "job.activity.actions") {
            const decision = decide(identity!.actor, { operation: route.operation });
            if (decision.result !== "allow") throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
            const match = route.pattern.exec(url.pathname);
            const kind = url.pathname === "/v2/execution/activity/capabilities" ? "capabilities" : route.operation === "job.activity.attention" ? "attention" : route.operation === "job.activity.actions" ? "actions"
              : match?.[2] === "events" ? "events" : "live";
            const response = route.operation === "runtime.job-activity"
              ? await modules!.jobActivity.runtime(request, identity!, now())
              : await modules!.jobActivity.human(request, identity!, match?.[1], kind, now());
            status = response.status;
            return response;
          }
          if (route.operation === "job.submit" || route.operation === "job.cancel") {
            const response = await handleJobs(request, route.operation, route.pattern.exec(url.pathname)?.[1], identity!, store, decide, (options.now ?? (() => new Date()))());
            status = response.status; return response;
          }
          if (route.operation === "runtime.register" || route.operation === "runtime.sync" || route.operation === "runtime.ack" || route.operation === "runtime.results" || route.operation === "runtimes") {
            const response = await handleRuntime(request, route.operation, identity!, store, decide, (options.now ?? (() => new Date()))(), hooks,
              job => modules!.runtimeRound(job));
            status = response.status;
            if (route.operation === "runtime.sync") {
              const now = (options.now ?? (() => new Date()))();
              const runtime = store.runtimes(now).find(value => value.actor === identity!.actor.id);
              if (runtime) notifyRuntimeUpdate(store, modules!.notifications, runtime, now);
            }
            if (route.operation === "runtime.results" && response.status === 200) {
              modules!.reconcile();
            }
            return response;
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
              route.pattern.exec(url.pathname)?.[1], identity!, store, config, decide, { ...options.operations, privileged, workCommands: modules!.workCommands }));
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
            // The human client can list all notes and request more than the capability limit.
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
    modules.inbox.start();
    modules.glances.start();
  } catch (cause) { modules?.stop(); await modules?.glances?.stop(); await modules?.inbox?.stop(); await modules?.trash?.stop(); await modules?.notices.stop(); await modules?.explorations.stop(); await modules?.notifications.stop(); await vaultWatch?.stop(); store.close(); throw cause; }
  return { server, store, modules: modules!, async stop() { modules?.stop(); await modules?.native.stop(); await server.stop(true); await modules?.glances?.stop(); await modules?.inbox.stop(); await modules?.speech.drain(); await modules?.trash?.stop(); await modules?.notices.stop(); await modules?.explorations.stop(); await modules?.notifications.stop(); await modules?.artifacts.drain(); await vaultWatch?.stop(); store.close(); } };
}

/** One Hub or offline migration owns a state directory. OS locks disappear on crashes, without deleting lock files. */
export async function startHub(config: HubConfig, options: Parameters<typeof startHubInstance>[1] = {}) {
  const lease = await acquireStateLease(config.stateDir);
  try {
    const hub = await withLanguage("en", () => startHubInstance(config, options)); let stopped: Promise<void> | undefined;
    return { ...hub, stop() { stopped ??= hub.stop().finally(() => lease.close()); return stopped; } };
  } catch (cause) { lease.close(); throw cause; }
}
