import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import {
  AIConfiguration,
  NativeCreate,
  NativeAction,
  NativeSession,
  NativeRuntimeMessage,
  NativeRuntimeCommand,
  NativeMCPRequest,
  NativeConnectionAction,
  type NativeConnectionView,
  type AIConnection,
  type CodexQuotaResult,
  type ClaudeBackgroundResult,
  CAPABILITIES,
  toolName,
  AssistantConversation,
  AssistantToolCall,
  AssistantMessage,
  type NativeEventData,
  type AssistantEvent,
  type AssistantChatRequest,
} from "@lumio/schema";
import { newId } from "@lumio/foundation";
import type { SqliteAIStore } from "@lumio/storage";
import type { AssistantContext } from "@lumio/assistant";
import type { AssistantService } from "@lumio/assistant";
import type { SqliteAssistantStore } from "@lumio/storage";
import type { AIConfigurationService } from "./ai-config.ts";
import { assistantToolDescription, isAiNoteCapability, isTaskProposalCapability, type Capabilities } from "./capabilities.ts";
import { AIUsage } from "./ai-usage.ts";
import type { Notifications } from "./notifications.ts";
import type { SpeechConfiguration } from "./speech-config.ts";
import type { AssistantMainConversations } from "./assistant-main.ts";
import { workbenchSearchCards, workbenchToolSpecs, type WorkbenchTools } from "./workbench-tools.ts";
interface NativeModules {
  ai: AIConfigurationService;
  speech: SpeechConfiguration;
  assistant: AssistantService;
  assistantStore: SqliteAssistantStore;
  assistantMain: AssistantMainConversations;
  workbench: WorkbenchTools;
  capabilities: Capabilities;
  resources: import("./resources.ts").Resources;
  signal: AbortSignal;
  notifications: Notifications;
}
import type { HubStore, Identity } from "./store.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
interface Socket {
  data: {
    runtime: string;
  };
  id: string;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
type Active = {
  turn: string;
  event: (e: AssistantEvent) => void;
  workbenchEvent?: (e: AssistantEvent) => void;
  returnedTools: Map<string, string>;
  resolve: (v: { text: string; status: "done" | "failed" | "unknown" | "cancelled"; error?: string }) => void;
  stopping?: ReturnType<typeof setTimeout>;
};
type AuthCommand = Extract<NativeRuntimeCommand, { type: "connection_auth" }>;
const offline = (): NativeConnectionView => ({ state: "offline", models: [] });
const problem = (reason = "native.unavailable", code: "INVALID" | "CONFLICT" | "NOT_FOUND" | "FORBIDDEN" = "INVALID") =>
  new HubError(code, { key: reason, args: [] });
export class NativeAssistant {
  private sockets = new Map<
    string,
    {
      ws: Socket;
      ready: boolean;
      instance?: string;
      isolation?: string;
      connectionAuth?: boolean;
      connectionUsage?: boolean;
      claudeUsage?: boolean;
    }
  >();
  private active = new Map<string, Active>();
  private authViews = new Map<string, { runtime: string; view: NativeConnectionView }>();
  private authPending = new Map<string, { command: AuthCommand; runtime: string; finish: (view: NativeConnectionView) => void }>();
  private authRequests = new Map<string, Promise<NativeConnectionView>>();
  private authChanges = new Set<string>();
  private usagePending = new Map<string, {
    connection: string;
    runtime: string;
    finish: (result: CodexQuotaResult | { status: "offline" }) => void;
  }>();
  private claudePending = new Map<string, {
    connection: string; runtime: string; generation: string;
    finish: (result: ClaudeBackgroundResult | { status: "offline" }) => void;
  }>();
  readonly usage: AIUsage;
  constructor(
    readonly ai: SqliteAIStore,
    private modules: NativeModules,
    private hub: HubStore,
    private config: HubConfig,
    usageOptions: { fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.usage = new AIUsage(ai, hub, {
      state: runtime => {
        const link = this.sockets.get(runtime);
        return !link?.ready ? "offline" : link.connectionUsage ? "ready" : "unsupported";
      },
      read: (connection, runtime) => this.readQuota(connection, runtime),
      claudeState: runtime => {
        const link = this.sockets.get(runtime);
        return !link?.ready ? "offline" : link.claudeUsage ? "ready" : "unsupported";
      },
      readClaude: (connection, runtime, generation, account) => this.readClaudeQuota(connection, runtime, generation, account),
    }, event => modules.notifications.notify(event), modules.signal, usageOptions.fetch, usageOptions.now);
    for (const s of ai.sessions()) {
      if (
        ["running", "awaiting_approval"].includes(s.view.state) ||
        ai.deliveries(s.id).some((d) => d.state === "sent")
      ) {
        s.quarantined = true;
        s.view = { ...s.view, state: "unknown", approval: undefined, error: "native.unknown" };
        ai.invalidate(s.id);
      } else if (s.view.state !== "closed") s.view = { ...s.view, state: "offline", approval: undefined };
      ai.putSession(s);
    }
  }
  validate(conversation: AssistantConversation, request: AssistantChatRequest) {
    const s = this.owned(conversation.native_session!, conversation.owner);
    this.current(s);
    this.checkAccount(s);
    if (
      this.ai.sessions(s.owner).some((v) => v.quarantined) ||
      !["ready"].includes(s.view.state) ||
      !this.online(s.runtime)
    )
      throw problem(s.quarantined ? "native.unknown" : "native.not_ready", "CONFLICT");
    if (request.profile && request.profile !== s.profile.id) throw problem("native.rebuild_required");
  }
  private owned(id: string, owner: string) {
    const s = this.ai.session(id);
    if (
      !s ||
      s.owner !== owner ||
      !this.modules.assistantStore.conversation(s.conversation) ||
      this.modules.assistantStore.trash(s.conversation)
    )
      throw problem("native.session_missing", "NOT_FOUND");
    return s;
  }
  private current(s: NativeSession) {
    const c = this.ai.connection(s.connection.id);
    if (!c || c.owner !== s.owner || c.host !== s.connection.host || c.kind !== "codex-account")
      throw problem("native.rebuild_required", "CONFLICT");
    const p = this.ai.profile(s.profile.id);
    if (!p || p.connection !== s.connection.id || p.engine !== "codex")
      throw problem("native.rebuild_required", "CONFLICT");
  }
  private checkAccount(s: NativeSession) {
    if (!s.connection_auth) return;
    const current = this.authViews.get(s.connection.id);
    if (this.authChanges.has(s.connection.id) || (current?.runtime === s.runtime && current.view.state !== "ready"))
      throw problem("native.connection_sign_in", "CONFLICT");
    if (current?.runtime === s.runtime && current.view.binding?.account !== s.connection_auth.account)
      throw problem("native.account_changed", "CONFLICT");
  }
  private sessionView(s: NativeSession): NativeSession {
    if (s.quarantined || !["ready", "offline", "failed"].includes(s.view.state)) return s;
    try { this.current(s); this.checkAccount(s); return s; }
    catch (error) { return { ...s, view: { ...s.view, state: "failed", error: error instanceof HubError ? error.params.key : "native.not_ready" } }; }
  }
  private authCommand(connection: AIConnection, action: AuthCommand["action"]): Promise<NativeConnectionView> {
    const runtime = this.hub.runtimes(new Date()).find(r => r.registration.name === connection.host)?.actor;
    if (!runtime || !this.sockets.get(runtime)?.connectionAuth) return Promise.resolve(offline());
    const existing = this.authRequests.get(connection.id);
    if (existing) return action === "status" ? existing : existing.then(() => this.authCommand(connection, action));
    const command: AuthCommand = { type: "connection_auth", command: randomUUID(), connection: connection.id, owner: connection.owner, action };
    const result = new Promise<NativeConnectionView>(resolve => {
      const finish = (view: NativeConnectionView) => {
        clearTimeout(timer);
        this.authPending.delete(command.command);
        this.authViews.set(connection.id, { runtime, view });
        if (view.state === "ready" || view.state === "signed_out" || view.state === "authorizing")
          this.usage.observeCodex(connection, runtime, view.binding);
        resolve(view);
      };
      const timer = setTimeout(() => finish(offline()), 22000);
      this.authPending.set(command.command, { command, runtime, finish });
      try { this.send(runtime, command); } catch { finish(offline()); }
    });
    this.authRequests.set(connection.id, result);
    void result.finally(() => this.authRequests.delete(connection.id));
    return result;
  }
  private readQuota(connection: AIConnection, runtime: string): Promise<CodexQuotaResult | { status: "offline" }> {
    if (this.authChanges.has(connection.id)) return Promise.resolve({ status: "error" });
    const command = randomUUID();
    return new Promise(resolve => {
      const finish = (result: CodexQuotaResult | { status: "offline" }) => {
        clearTimeout(timer);
        this.usagePending.delete(command);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: "error" }), 26000);
      this.usagePending.set(command, { connection: connection.id, runtime, finish });
      try { this.send(runtime, { type: "connection_usage", command, connection: connection.id, owner: connection.owner }); }
      catch { finish({ status: "offline" }); }
    });
  }
  private readClaudeQuota(connection: AIConnection, runtime: string, generation: string, account?: string):
    Promise<ClaudeBackgroundResult | { status: "offline" }> {
    const command = randomUUID();
    return new Promise(resolve => {
      const finish = (result: ClaudeBackgroundResult | { status: "offline" }) => {
        clearTimeout(timer);
        this.claudePending.delete(command);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: "failed", issue: "timeout" }), 36000);
      this.claudePending.set(command, { connection: connection.id, runtime, generation, finish });
      try { this.send(runtime, { type: "claude_usage", command, connection: connection.id, generation, account }); }
      catch { finish({ status: "offline" }); }
    });
  }
  private online(runtime: string) {
    return this.sockets.get(runtime)?.ready === true;
  }
  private put(s: NativeSession) {
    s.updated = new Date().toISOString();
    this.ai.putSession(s);
  }
  private send(runtime: string, message: NativeRuntimeCommand) {
    const socket = this.sockets.get(runtime);
    if (!socket?.ready) throw problem("native.runtime_offline", "CONFLICT");
    socket.ws.send(JSON.stringify(NativeRuntimeCommand.parse(message)));
  }
  async channel(request: Request, identity: Identity): Promise<Response> {
    if (identity.actor.role !== "runtime" || !this.hub.runtimes(new Date()).some((r) => r.actor === identity.actor.id))
      throw problem("native.forbidden", "FORBIDDEN");
    if (request.method === "POST" && new URL(request.url).pathname === "/v2/runtime/native/events") {
      const link = this.sockets.get(identity.actor.id);
      if (!link || link.ws.id !== request.headers.get("x-lumio-native-channel"))
        throw problem("native.runtime_offline", "CONFLICT");
      const body = await request.text();
      if (body.length > 2 * 1024 * 1024) throw problem("ai.invalid");
      this.channelMessage(link.ws, body);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET" || new URL(request.url).pathname !== "/v2/runtime/native")
      throw problem("native.session_missing", "NOT_FOUND");
    const id = randomUUID(),
      encoder = new TextEncoder();
    let peer: Socket | undefined;
    let close = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let ended = false;
        const timer = setInterval(() => {
          if (!ended)
            try {
              controller.enqueue(encoder.encode("\n"));
            } catch {
              close();
            }
        }, 3000);
        close = () => {
          if (ended) return;
          ended = true;
          clearInterval(timer);
          request.signal.removeEventListener("abort", close);
          this.modules.signal.removeEventListener("abort", close);
          if (peer) this.channelClose(peer);
          try {
            controller.close();
          } catch {}
        };
        peer = {
          id,
          data: { runtime: identity.actor.id },
          send: (message) => {
            if (ended) throw problem("native.runtime_offline", "CONFLICT");
            controller.enqueue(encoder.encode(message + "\n"));
          },
          close,
          terminate: close,
        };
        this.channelOpen(peer);
        controller.enqueue(encoder.encode("\n"));
        request.signal.addEventListener("abort", close, { once: true });
        this.modules.signal.addEventListener("abort", close, { once: true });
      },
      cancel: () => close(),
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Lumio-Native-Channel": id,
        "X-Lumio-Native-Connection-Auth": "1", "X-Lumio-Native-Connection-Usage": "1", "X-Lumio-Native-Claude-Usage": "1" },
    });
  }
  channelOpen(ws: Socket) {
    const old = this.sockets.get(ws.data.runtime);
    old?.ws.close(1008, "Superseded");
    this.sockets.set(ws.data.runtime, { ws, ready: false });
  }
  channelClose(ws: Socket) {
    if (this.sockets.get(ws.data.runtime)?.ws !== ws) return;
    this.sockets.delete(ws.data.runtime);
    for (const pending of this.authPending.values()) if (pending.runtime === ws.data.runtime) pending.finish(offline());
    for (const pending of this.usagePending.values()) if (pending.runtime === ws.data.runtime) pending.finish({ status: "offline" });
    for (const pending of this.claudePending.values()) if (pending.runtime === ws.data.runtime) pending.finish({ status: "offline" });
    for (const [connection, current] of this.authViews) if (current.runtime === ws.data.runtime) this.authViews.delete(connection);
    for (const s of this.ai.sessions().filter((s) => s.runtime === ws.data.runtime && s.view.state !== "closed")) {
      const active = this.active.get(s.id);
      if (active || ["running", "awaiting_approval"].includes(s.view.state)) {
        s.quarantined = true;
        s.view = { ...s.view, state: "unknown", approval: undefined, error: "native.unknown" };
        this.ai.invalidate(s.id);
        this.complete(s.id, "unknown", "", "native.unknown");
      } else s.view = { ...s.view, state: "offline", approval: undefined };
      this.put(s);
    }
  }
  channelMessage(ws: Socket, data: string | Buffer) {
    if (String(data).length > 2 * 1024 * 1024) {
      ws.close(1009);
      return;
    }
    const parsed = NativeRuntimeMessage.safeParse(
      (() => {
        try {
          return JSON.parse(String(data));
        } catch {
          return null;
        }
      })(),
    );
    if (!parsed.success) {
      ws.close(1008);
      return;
    }
    const m = parsed.data,
      link = this.sockets.get(ws.data.runtime);
    if (!link || link.ws !== ws) return;
    if (m.type === "hello") {
      if (m.isolation !== "macos-seatbelt") {
        ws.close(1008, "Isolation required");
        return;
      }
      link.ready = true;
      link.instance = m.instance;
      link.isolation = m.isolation;
      link.connectionAuth = m.connection_auth;
      link.connectionUsage = m.connection_auth && m.connection_usage;
      link.claudeUsage = m.claude_usage;
      for (const s of this.ai
        .sessions()
        .filter((s) => s.runtime === ws.data.runtime && s.view.state !== "closed" && !s.quarantined)) {
        try {
          if (!s.connection_auth) this.open(s);
        } catch {}
      }
      return;
    }
    if (m.type === "claude_usage") {
      const pending = this.claudePending.get(m.command);
      if (link.claudeUsage && pending?.runtime === ws.data.runtime && pending.connection === m.connection && pending.generation === m.generation)
        pending.finish(m.result);
      return;
    }
    if (m.type === "connection_usage") {
      const pending = this.usagePending.get(m.command);
      if (link.connectionUsage && pending?.runtime === ws.data.runtime && pending.connection === m.connection)
        pending.finish(m.result);
      return;
    }
    if (m.type === "connection_auth") {
      const pending = this.authPending.get(m.command);
      if (pending?.runtime === ws.data.runtime && pending.command.connection === m.connection && pending.command.owner === m.owner)
        pending.finish(m.view);
      return;
    }
    if (m.type !== "event") return;
    const s = this.ai.session(m.session);
    if (!s && this.ai.retired(m.session, ws.data.runtime)) {
      this.send(ws.data.runtime, { type: "ack", session: m.session, sequence: m.sequence });
      return;
    }
    if (!s || s.runtime !== ws.data.runtime) {
      ws.close(1008);
      return;
    }
    if (m.sequence <= s.sequence) {
      this.send(s.runtime, { type: "ack", session: s.id, sequence: s.sequence });
      return;
    }
    if (m.sequence !== s.sequence + 1) {
      ws.close(1008, "Sequence gap");
      return;
    }
    const terminal = s.view.state === "closed" && !s.quarantined;
    this.ai.db.transaction(() => {
      this.ai.event(s.id, m.sequence, m.turn, m.event);
      s.sequence = m.sequence;
      if (m.event.type === "state" && !terminal) {
        const view = m.event.view;
        if (s.view.account && view.account && s.view.account !== view.account) {
          s.quarantined = true;
          this.ai.invalidate(s.id);
        }
        s.view = {
          ...view,
          ...(view.state === "ready" && this.active.has(s.id) ? { state: "running" as const } : {}),
          ...(s.quarantined ? { state: "unknown" as const, error: "native.unknown" } : {}),
        };
        if (view.state === "unknown") {
          s.quarantined = true;
          this.ai.invalidate(s.id);
        }
      }
      if (m.event.type === "complete" && m.turn) {
        const unknownEffect = m.event.status === "cancelled" && !!this.ai.db.query(
          "SELECT 1 FROM native_operations WHERE session=? AND turn=? AND status IN ('running','unknown') LIMIT 1",
        ).get(s.id, m.turn);
        if ((m.event.status === "done" || (m.event.status === "cancelled" && !unknownEffect)) && !s.quarantined && !terminal)
          s.view = { ...s.view, state: s.view.stopped ? "offline" : "ready", approval: undefined };
        if (m.turn) this.ai.deliveryState(m.turn, "completed");
        if ((m.event.status === "unknown" || unknownEffect) && !terminal) {
          s.quarantined = true;
          s.view = { ...s.view, state: "unknown", error: "native.unknown" };
          this.ai.invalidate(s.id);
        }
      }
      this.put(s);
    })();
    this.send(s.runtime, { type: "ack", session: s.id, sequence: s.sequence });
    const active = this.active.get(s.id);
    if (active && (!m.turn || m.turn === active.turn)) {
      if (m.event.type === "text") active.event({ type: "token", turn: active.turn, delta: m.event.delta });
      else active.event({ type: "native", turn: active.turn, event: m.event });
    }
    if (m.event.type === "complete" && active?.turn === m.turn) {
      const status = s.quarantined ? "unknown" : m.event.status;
      this.complete(s.id, status, m.event.text, s.quarantined ? "native.unknown" : m.event.error);
    }
  }
  private complete(id: string, status: "done" | "failed" | "unknown" | "cancelled", text: string, error?: string) {
    const a = this.active.get(id);
    if (a) {
      clearTimeout(a.stopping);
      this.active.delete(id);
      a.resolve({ text, status, error });
    }
  }
  private open(s: NativeSession) {
    this.current(s);
    this.checkAccount(s);
    const token = `native_${randomBytes(32).toString("base64url")}`;
    const name = `native-${createHash("sha256").update(s.id).digest("hex").slice(0, 20)}`;
    const actor = this.hub.actors().find((a) => a.name === name) ?? this.hub.createActor(name, "agent");
    if (actor.role !== "agent") throw problem("native.forbidden", "FORBIDDEN");
    this.ai.setToken(s.id, createHash("sha256").update(token).digest("hex"), actor.id);
    // The secret is sent once over the authenticated channel, never persisted in the Hub outbox.
    this.send(s.runtime, {
      type: "open",
      command: randomUUID(),
      session: s,
      hub_url: this.config.publicUrl ?? this.hubUrl(),
      mcp_token: token,
    });
  }
  setPort(port: number) {
    this.config.port = port;
  }
  private hubUrl() {
    return `http://${this.config.hostname.includes(":") ? `[${this.config.hostname}]` : this.config.hostname}:${this.config.port}`;
  }
  async create(owner: string, raw: unknown, options: { main?: boolean } = {}) {
    const input = NativeCreate.parse(raw),
      fingerprint = JSON.stringify(options.main ? { input, main: true } : input);
    const receipt = this.ai.receipt(owner, input.request_id, fingerprint);
    if (receipt) {
      if (!receipt.matches) throw problem("ai.conflict", "CONFLICT");
      return this.owned(String(receipt.result), owner);
    }
    const { profile, connection } = this.modules.ai.get(owner, input.profile);
    if (profile.engine !== "codex") throw problem("ai.invalid");
    const runtime = this.hub.runtimes(new Date()).find((r) => r.registration.name === connection.host);
    if (!runtime || !this.online(runtime.actor)) throw problem("native.runtime_offline", "CONFLICT");
    if (this.ai.sessions(owner).some((s) => s.quarantined)) throw problem("native.unknown", "CONFLICT");
    const connectionView = this.sockets.get(runtime.actor)?.connectionAuth ? await this.authCommand(connection, "status") : undefined;
    if (connectionView && (connectionView.state !== "ready" || !connectionView.binding || this.authChanges.has(connection.id)))
      throw problem("native.connection_sign_in", "CONFLICT");
    const time = new Date().toISOString(),
      id = newId("ais", new Date(), randomBytes),
      conversation = newId("conv", new Date(), randomBytes),
      capabilities = [
        ...CAPABILITIES.map((c) => toolName(c.name)),
        ...(options.main ? workbenchToolSpecs.map(spec => spec.name) : []),
      ];
    const memories = await this.modules.assistant.memories(owner),
      context_revision = createHash("sha256")
        .update(JSON.stringify(memories.map((m) => [m.id, m.revision])))
        .digest("hex");
    const again = this.ai.receipt(owner, input.request_id, fingerprint);
    if (again) {
      if (!again.matches) throw problem("ai.conflict", "CONFLICT");
      return this.owned(String(again.result), owner);
    }
    const s = NativeSession.parse({
      id,
      conversation,
      owner,
      runtime: runtime.actor,
      profile,
      connection,
      connection_auth: connectionView?.binding,
      binding: {
        profile: profile.id,
        purpose: "assistant",
        revision: 1,
        workdir: "managed-session",
        approval_policy: "on-request",
        reviewer: "user",
        sandbox: "workspace-write",
        command_network: false,
        tools: capabilities,
        timeout_seconds: 1800,
      },
      capabilities,
      context_revision,
      view: { state: "starting", models: [] },
      sequence: 0,
      created: time,
      updated: time,
      quarantined: false,
    });
    this.checkAccount(s);
    if (!this.online(s.runtime)) throw problem("native.runtime_offline", "CONFLICT");
    this.ai.db.transaction(() => {
      const current = this.modules.ai.get(owner, profile.id);
      if (current.profile.revision !== profile.revision || current.connection.revision !== connection.revision) {
        throw problem("ai.conflict", "CONFLICT");
      }
      this.modules.assistantStore.putConversation(
        AssistantConversation.parse({
          id: conversation,
          title: input.title ?? profile.name,
          owner,
          native_session: id,
          profile: profile.id,
          created: time,
          updated: time,
          revision: 1,
        }),
      );
      if (options.main) this.modules.assistantMain.bindMain(owner, conversation);
      this.ai.putSession(s);
      this.ai.putReceipt(owner, input.request_id, fingerprint, id);
    })();
    this.open(s);
    return s;
  }
  readonly run = async (input: Parameters<NonNullable<AssistantContext["native"]>["run"]>[0],
    workbenchEvent?: (event: AssistantEvent) => void) => {
    const s = this.owned(input.conversation.native_session!, input.conversation.owner);
    this.validate(input.conversation, input.request);
    const context_revision = createHash("sha256")
      .update(JSON.stringify(input.memories.map((m) => [m.id, m.revision])))
      .digest("hex");
    if (context_revision !== s.context_revision) {
      this.ai.invalidate(s.id);
      s.view = { ...s.view, state: "failed", error: "native.context_expired" };
      this.put(s);
      throw problem("native.context_expired", "CONFLICT");
    }
    const p = this.ai.profile(s.profile.id)!;
    const selectedModel =
      input.request.model ?? (p.model === "default" ? (s.view.default_model ?? "default") : p.model);
    const selectedEffort =
      input.request.effort === "default"
        ? s.view.models.find((m) => m.id === selectedModel)?.default_effort
        : (input.request.effort ?? p.effort);
    const command = randomUUID();
    const packet: NativeRuntimeCommand = {
      type: "turn",
      command,
      session: s.id,
      turn: input.turn.id,
      profile_revision: p.revision,
      message: input.request.message,
      model: selectedModel,
      effort: selectedEffort,
      context: input.memories.map((m) => m.content).join("\n"),
      context_revision,
    };
    const result = new Promise<{
      text: string;
      status: "done" | "failed" | "unknown" | "cancelled";
      error?: string;
    }>((resolve) => this.active.set(s.id, {
      turn: input.turn.id, event: input.event, workbenchEvent, returnedTools: new Map(), resolve,
    }));
    const abort = () => {
      void this.interrupt(s.id);
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      this.ai.delivery(s.id, input.turn.id, command, packet);
      this.ai.deliveryState(input.turn.id, "sent");
      s.view = { ...s.view, state: "running" };
      this.put(s);
      this.send(s.runtime, packet);
      return await result;
    } catch {
      s.quarantined = true;
      s.view = { ...s.view, state: "unknown", error: "native.unknown" };
      this.put(s);
      this.complete(s.id, "unknown", "", "native.unknown");
      return await result;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  };
  async interrupt(id: string, confirmedStop = false) {
    const s = this.ai.session(id);
    if (!s) return;
    const uncertain = this.active.has(id) || ["running", "awaiting_approval"].includes(s.view.state);
    const active = this.active.get(id);
    if (confirmedStop && !uncertain) return;
    if (confirmedStop && active && this.sockets.get(s.runtime)?.connectionAuth) {
      if (active.stopping) return;
      active.stopping = setTimeout(() => void this.interrupt(id), 15000);
      try {
        this.send(s.runtime, { type: "action", command: randomUUID(), session: id, input: { action: "interrupt", confirmed: true } });
        return;
      } catch { /* Fall back to an unconfirmed stop. */ }
    }
    if (uncertain) {
      s.quarantined = true;
      s.view = { ...s.view, state: "unknown", approval: undefined, error: "native.unknown" };
      this.ai.invalidate(id);
      this.put(s);
    }
    try {
      this.send(s.runtime, { type: "action", command: randomUUID(), session: id, input: { action: "interrupt" } });
    } catch {
      /* The frozen state does not depend on receiving an interruption acknowledgment. */
    }
    if (uncertain) this.complete(id, "unknown", "", "native.unknown");
  }
  async action(id: string, owner: string, raw: unknown) {
    const a = NativeAction.parse(raw),
      s = this.owned(id, owner);
    if (
      a.action === "approval" &&
      (!s.view.approval ||
        s.view.approval.id !== a.approval ||
        s.view.approval.instance !== a.instance ||
        Date.parse(s.view.approval.expires) < Date.now() ||
        s.quarantined)
    )
      throw problem("native.approval_expired", "CONFLICT");
    if (a.action === "interrupt") {
      await this.interrupt(id, true);
      return this.ai.session(id)!;
    }
    if (a.action === "resolve") {
      if (!s.quarantined || !a.processes_stopped) throw problem("native.not_stopped", "CONFLICT");
      this.hub.audit(
        { actor: this.hub.actors().find((a) => a.id === owner)!, label: "native-review" },
        JSON.stringify({ session: id, ...a }),
        "allow",
        undefined,
        "applied",
      );
      s.quarantined = false;
      s.view = { ...s.view, state: "closed", error: undefined };
      this.put(s);
      this.send(s.runtime, { type: "action", command: randomUUID(), session: id, input: a });
      return s;
    }
    if (s.quarantined && a.action !== "close") throw problem("native.unknown", "CONFLICT");
    if (a.action === "resume") {
      if (!["offline", "failed"].includes(s.view.state)) throw problem("native.not_ready", "CONFLICT");
      if (!this.online(s.runtime)) throw problem("native.runtime_offline", "CONFLICT");
      if (["native.state_lost", "native.context_expired"].includes(s.view.error ?? "")) throw problem(s.view.error, "CONFLICT");
      this.current(s);
      if (s.connection_auth) {
        await this.authCommand(s.connection, "status");
        this.checkAccount(s);
      }
      s.view = { ...s.view, state: "recovering" };
      this.put(s);
      this.open(s);
    } else {
      if (a.action === "approval") {
        s.view = { ...s.view, state: "running", approval: undefined };
        this.put(s);
      }
      if (a.action === "close") this.ai.invalidate(id);
      this.send(s.runtime, { type: "action", command: randomUUID(), session: id, input: a });
    }
    return s;
  }
  async handle(request: Request, identity: Identity) {
    if (identity.actor.role !== "human") throw problem("native.forbidden", "FORBIDDEN");
    const path = new URL(request.url).pathname,
      owner = identity.actor.id;
    if (path === "/v2/ai/config" && request.method === "GET")
      return Response.json(AIConfiguration.parse(this.modules.ai.list(owner)));
    if (path === "/v2/ai/runtimes" && request.method === "GET")
      return Response.json(
        this.hub
          .runtimes(new Date())
          .map((r) => ({
            actor: r.actor,
            name: r.registration.name,
            online: this.online(r.actor),
            isolation: this.sockets.get(r.actor)?.isolation ?? "unsupported",
          })),
      );
    const auth = /^\/v2\/ai\/connections\/(aic_[0-9A-HJKMNP-TV-Z]{26})\/auth$/.exec(path);
    if (auth && ["GET", "POST"].includes(request.method)) {
      const connection = this.ai.connection(auth[1]!);
      if (!connection || connection.owner !== owner || connection.kind !== "codex-account")
        throw problem("native.session_missing", "NOT_FOUND");
      const view = request.method === "GET" ? await this.authCommand(connection, "status")
        : await this.changeAuth(connection, NativeConnectionAction.parse(await request.json()));
      return Response.json(view, { headers: { "Cache-Control": "no-store" } });
    }
    const connection = /^\/v2\/ai\/connections(?:\/(aic_[0-9A-HJKMNP-TV-Z]{26}))?$/.exec(path);
    if (connection && ["POST", "PUT"].includes(request.method)) {
      const body: unknown = await request.json();
      return this.modules.speech.configurationWrite(async () => Response.json(this.modules.ai.connection(owner, body, connection[1])));
    }
    const profile = /^\/v2\/ai\/profiles(?:\/(aip_[0-9A-HJKMNP-TV-Z]{26}))?$/.exec(path);
    if (profile && ["POST", "PUT"].includes(request.method)) {
      const body: unknown = await request.json();
      return this.modules.speech.configurationWrite(async () => Response.json(this.modules.ai.profile(owner, body, profile[1])));
    }
    const deleted = connection?.[1] ?? profile?.[1];
    if (request.method === "DELETE" && deleted) {
      const body: unknown = await request.json().catch(() => undefined);
      return this.modules.speech.configurationWrite(async () => Response.json(await this.modules.ai.remove(
        owner, connection ? "connection" : "profile", deleted, body, value => this.modules.speech.cleanConnection(value),
      )));
    }
    if (path === "/v2/assistant/native-sessions") {
      if (request.method === "POST") return Response.json(await this.create(owner, await request.json()));
      if (request.method === "GET")
        return Response.json(
          this.ai
            .sessions(owner)
            .filter(
              (s) =>
                !(
                  !this.modules.assistantStore.conversation(s.conversation) ||
                  this.modules.assistantStore.trash(s.conversation)
                ),
            ),
        );
    }
    const match = /^\/v2\/assistant\/native-sessions\/(ais_[0-9A-HJKMNP-TV-Z]{26})(?:\/(actions|events))?$/.exec(path);
    if (match) {
      const s = this.owned(match[1]!, owner);
      if (request.method === "POST" && match[2] === "actions")
        return Response.json(await this.action(s.id, owner, await request.json()));
      if (request.method === "GET")
        return Response.json(
          match[2] === "events" ? this.ai.events(s.id, Number(new URL(request.url).searchParams.get("after") ?? 0)) : this.sessionView(s),
        );
    }
    throw problem("native.session_missing", "NOT_FOUND");
  }
  private async changeAuth(connection: AIConnection, input: NativeConnectionAction) {
    const key = `connection-auth:${connection.id}:${input.request_id}`;
    const receipt = this.ai.receipt(connection.owner, key, input.action);
    if (receipt && !receipt.matches) throw problem("ai.conflict", "CONFLICT");
    if (receipt) return this.authCommand(connection, "status");
    if (this.authChanges.has(connection.id) || this.ai.sessions(connection.owner).some(s =>
      s.connection.id === connection.id && (s.quarantined || this.modules.assistantStore.turns(s.conversation).some(t => t.status === "running"))))
      throw problem("native.connection_busy", "CONFLICT");
    this.authChanges.add(connection.id);
    this.usage.suspendCodex(connection.id);
    try {
      this.ai.putReceipt(connection.owner, key, input.action, true);
      const view = await this.authCommand(connection, input.action);
      if (view.state === "signed_out" || view.state === "authorizing") {
        for (const s of this.ai.sessions(connection.owner)) {
          if (s.connection.id !== connection.id || !s.connection_auth || ["closed", "offline"].includes(s.view.state)) continue;
          this.ai.invalidate(s.id);
          this.send(s.runtime, { type: "action", command: randomUUID(), session: s.id, input: { action: "idle" } });
        }
      }
      return view;
    } finally { this.authChanges.delete(connection.id); }
  }
  async mcpHandle(request: Request) {
    const id = /^\/v2\/native-mcp\/(ais_[0-9A-HJKMNP-TV-Z]{26})\/(tools|call)$/.exec(new URL(request.url).pathname);
    if (!id) throw problem("native.forbidden", "FORBIDDEN");
    const s = this.ai.session(id[1]!),
      meta = this.ai.token(id[1]!);
    const supplied = /^Bearer (native_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const digest = createHash("sha256")
      .update(supplied ?? "")
      .digest();
    const expected = meta?.token_hash ? Buffer.from(meta.token_hash, "hex") : Buffer.alloc(32);
    if (
      !s ||
      !meta?.agent ||
      !supplied ||
      !timingSafeEqual(expected, digest) ||
      s.quarantined ||
      s.view.state === "closed" ||
      this.modules.assistantStore.trash(s.conversation) ||
      !this.online(s.runtime)
    )
      throw problem("native.forbidden", "FORBIDDEN");
    const defs = CAPABILITIES.filter((c) => s.capabilities.includes(toolName(c.name)));
    const workbench = this.modules.assistantMain.isMain(s.owner, s.conversation)
      ? workbenchToolSpecs.filter(spec => s.capabilities.includes(spec.name)) : [];
    if (id[2] === "tools" && request.method === "GET")
      return Response.json({
        tools: [
          ...defs.map((c) => ({
            name: toolName(c.name),
            description: assistantToolDescription(c),
            inputSchema: c.args.toJSONSchema(),
          })),
          ...workbench.map(spec => ({ name: spec.name, description: spec.description, inputSchema: spec.input_schema })),
        ],
      });
    if (id[2] !== "call" || request.method !== "POST") throw problem("native.forbidden", "FORBIDDEN");
    const input = NativeMCPRequest.parse({ ...((await request.json()) as object), session: s.id }),
      def = defs.find((c) => toolName(c.name) === input.tool),
      action = workbench.find(spec => spec.name === input.tool),
      name = def?.name ?? action?.name,
      active = this.active.get(s.id);
    if (
      !name ||
      !active ||
      (def?.kind === "write" && this.ai.sessions(s.owner).some((v) => v.quarantined)) ||
      !["running", "awaiting_approval"].includes(s.view.state)
    )
      throw problem("native.forbidden", "FORBIDDEN");
    const aiNote = def && isAiNoteCapability(def.name);
    const conversation = aiNote ? this.modules.resources.conversationSource(s.owner, active.turn) : undefined;
    if (aiNote && !conversation) throw problem("native.forbidden", "FORBIDDEN");
    const old = this.ai.db
      .query<
        {
          name: string;
          args: string;
          turn: string;
          status: string;
          result: string | null;
        },
        [string, string]
      >("SELECT name,args,turn,status,result FROM native_operations WHERE session=? AND request=?")
      .get(s.id, input.request_id);
    if (old) {
      if (old.name !== name || old.args !== JSON.stringify(input.args) || (action && old.turn !== active.turn)) throw problem("ai.conflict", "CONFLICT");
      if (old.status === "done") return Response.json({ result: JSON.parse(old.result!) });
      throw problem("native.unknown", "CONFLICT");
    }
    this.ai.db
      .query("INSERT INTO native_operations VALUES(?,?,?,?,?,'running',NULL)")
      .run(s.id, input.request_id, active.turn, name, JSON.stringify(input.args));
    const actor = this.hub.actors().find((a) => a.id === meta.agent && a.role === "agent");
    if (!actor) throw problem("native.forbidden", "FORBIDDEN");
    const callId = newId("tool", new Date(), randomBytes);
    let call = AssistantToolCall.parse({
      id: callId,
      turn: active.turn,
      name: input.tool,
      args: input.args,
      status: "running",
      capability: def?.name,
      created: new Date().toISOString(),
    });
    this.modules.assistantStore.putCall(call);
    try {
      const identity = { actor, label: `native-${s.id}` };
      const outcome = def
        ? await this.modules.capabilities.execute(def.name, input.args, identity, input.request_id, { conversation })
        : { result: await this.modules.workbench.execute(name, input.args, {
          owner: s.owner, conversation: s.conversation, turn: active.turn, tool: callId, identity,
          returnedTools: active.returnedTools,
          active: () => this.active.get(s.id) === active && !active.stopping,
          emit: active.workbenchEvent,
        }) };
      const content = JSON.stringify(outcome.result ?? null);
      const result = JSON.parse(content);
      this.ai.db.transaction(() => {
        this.ai.db
          .query("UPDATE native_operations SET status='done',result=? WHERE session=? AND request=?")
          .run(content, s.id, input.request_id);
        call = { ...call, status: "succeeded", result, change: outcome.change, finished: new Date().toISOString() };
        this.modules.assistantStore.putCall(call);
        this.modules.assistantStore.putMessage(
          AssistantMessage.parse({
            id: newId("amsg", new Date(), randomBytes),
            conversation: s.conversation,
            turn: active.turn,
            role: "tool",
            tool_call: callId,
            content,
            created: new Date().toISOString(),
          }),
        );
      })();
      const response = Response.json({ result });
      if (active.workbenchEvent) {
        const cards = workbenchSearchCards(result);
        if (cards.length) active.returnedTools.set(callId, JSON.stringify(cards));
      }
      return response;
    } catch (e) {
      const known = e instanceof HubError && ["FORBIDDEN", "INVALID", "NOT_FOUND", "CONFLICT"].includes(e.code);
      this.ai.db
        .query("UPDATE native_operations SET status=? WHERE session=? AND request=?")
        .run(known ? "failed" : "unknown", s.id, input.request_id);
      this.modules.assistantStore.putCall({
        ...call,
        status: known ? "failed" : "unknown",
        error: "native.tool_failed",
        finished: new Date().toISOString(),
      });
      if (!known && def?.kind === "write") {
        const current = this.ai.session(s.id)!;
        current.quarantined = true;
        current.view = { ...current.view, state: "unknown", error: "native.unknown" };
        this.put(current);
        this.ai.invalidate(s.id);
        await this.interrupt(s.id);
      }
      if (known) throw action || aiNote || (def && isTaskProposalCapability(def.name)) ? e : problem("native.tool_failed", "FORBIDDEN");
      throw problem("native.unknown", "CONFLICT");
    }
  }
  beforePurge(conversation: string) {
    if (this.ai.sessions().some((s) => s.conversation === conversation && s.quarantined))
      throw problem("native.unknown", "CONFLICT");
  }
  cancelConversation(id: string) {
    const s = this.ai.sessions().find((s) => s.conversation === id);
    if (!s) return;
    this.ai.invalidate(s.id);
    if (this.active.has(s.id) || ["running", "awaiting_approval"].includes(s.view.state)) void this.interrupt(s.id);
    else
      try {
        this.send(s.runtime, { type: "action", command: randomUUID(), session: s.id, input: { action: "close" } });
      } catch {}
  }

  async stop() {
    for (const s of this.ai.sessions()) if (this.active.has(s.id)) await this.interrupt(s.id);
    const links = [...this.sockets.values()];
    this.sockets.clear();
    for (const c of links) c.ws.terminate();
    for (const pending of this.usagePending.values()) pending.finish({ status: "offline" });
    for (const pending of this.claudePending.values()) pending.finish({ status: "offline" });
    await this.usage.stop();
    for (const [id] of this.active) this.complete(id, "unknown", "", "native.unknown");
    await Bun.sleep(0);
  }
}
