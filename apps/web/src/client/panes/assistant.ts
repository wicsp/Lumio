import { NativeSessionPanel } from "../native-session.ts";
import { assistantProfiles, defaultAssistantProfile } from "../assistant-profile.ts";
import { ChatProgress } from "../chat-progress.ts";
import { effortLabel } from "../labels.ts";
/**
 * 助手：对话历史、流式回复、停止接收与中断后核查；显式记忆。
 * 中断或结果不明时只核对已保存记录，不自动重发；同样的草稿重发时复用 request_id。
 */
import type { AIConnection, AIProfile, NativeCreate, NativeEventRecord, AssistantConversation, AssistantConversationDetail, AssistantMemory, AssistantChatRequest, AssistantToolCall } from "@lumio/schema";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { autosize, clear, empty, failure, h, icon, loading, openDialog, toast } from "../dom.ts";
import { speechButton } from "../speech-input.ts";
import { ago } from "../format.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { toolCallView } from "../tool-call-view.ts";
import type { Navigate } from "../navigation.ts";
import { referenceInput } from "../reference-input.ts";
import { drafts, textDraft } from "../drafts.ts";
import { t, translated } from "../i18n.ts";
import { MessageRail } from "../side-rail.ts";
import { confirmDelete } from "../trash-actions.ts";
import { MESSAGE_SEPARATOR, knowledgeReferences, referenceConsequence } from "../resources.ts";

const TURN_LABEL: Record<string, string> = translated({ running: "Still working", done: "Done", failed: "Didn't finish", unknown: "Result unknown — check before retrying", cancelled: "Cancelled" });
const SUGGESTIONS = ["Help me prioritize what to work on today", "How should I organize this week's experiment results?", "Draft an outline for the rebuttal"];
const DEEPSEEK_MODELS = ["deepseek-flash", "deepseek-v4-pro"];
const DEEPSEEK_EFFORTS = ["low", "high", "max"];

export class AssistantPane {
  private layout = h("div", { class: "chat" });
  private conversations = h("div", { class: "list-scroll" });
  private scroller = h("div", { class: "chat-scroll" });
  private messages = h("div", { class: "messages", role: "log", "aria-label": t("Conversation messages") });
  private text = autosize(h("textarea", { name: "chat-message", rows: "1", placeholder: t("Ask anything, or think through the next step…"), "aria-label": t("Message") }));
  private profiles: AIProfile[] = [];
  private connections: AIConnection[] = [];
  private profile = h("select", { "aria-label": t("AI profile"), disabled: true });
  private apiModel = h("select", { "aria-label": t("Model") });
  private apiEffort = h("select", { "aria-label": t("Thinking effort") });
  private apiControls = h("div", { class: "chat-turn-controls", hidden: true }, this.apiModel, this.apiEffort);
  private apiControlsProfile?: string;
  private progress = new Map<string, ChatProgress>();
  private nativeTurn?: string;
  private profileStatus = h("div", { role: "status" });
  private profileLoad?: Promise<void>;
  private profilesLoaded = false;
  private selectedProfile?: string;
  private boundProfile?: string;
  private conversationLoading = false;
  private native: NativeSessionPanel;
  private nativeReady = true;
  private send = h("button", { type: "submit", class: "btn btn-primary btn-small", disabled: true, "aria-label": t("Send"), title: t("↵ send · ⇧↵ new line") }, icon("send"), t("Send"));
  private stop = h("button", { type: "button", class: "btn btn-small", hidden: true, onclick: () => void this.stopTurn() }, icon("stop"), t("Stop"));
  private notice = h("div", { role: "status" });
  private dock: HTMLElement;
  private composer: HTMLFormElement;
  private messageNav: MessageRail;
  private scrollOnResume = false;
  private segChat = h("button", { type: "button", "aria-pressed": "true", onclick: () => this.switchMode("chat") }, t("Chat"));
  private segMemory = h("button", { type: "button", "aria-pressed": "false", onclick: () => this.switchMode("memory") }, t("Memory"));
  private current?: string;
  private store = drafts();
  private disposeReferences: () => void;
  private controller?: AbortController;
  private sending = false;
  private serverRunning = false;
  private active = true;
  private generation = 0;
  private mode: "chat" | "memory" = "chat";
  private uncertain?: AssistantChatRequest;
  private nativeCreate?: NativeCreate;
  private firstNativeSend?: { conversation: string; message: string };

  /** 打开对话后要定位的消息（来自 lumio:amsg_… 链接，ADR 0051）。 */
  private targetMessage?: string;

  constructor(private root: HTMLElement, private client: Client, private hub: HubExtras, private navigate: Navigate = () => {}, initial?: string) {
    this.disposeReferences = referenceInput(this.text,client);
    this.native = new NativeSessionPanel(client, ready => {
      this.nativeReady = ready;
      this.updateComposer();
      if (ready && !this.sending && this.serverRunning) void this.refresh();
      if (ready && !this.sending && this.firstNativeSend?.conversation === this.current && this.firstNativeSend) {
        const unchanged = this.text.value.trim() === this.firstNativeSend.message;
        this.firstNativeSend = undefined;
        if (unchanged) void this.submit();
      }
    }, () => this.navigate("settings", "ai"), record => this.onNativeProgress(record));
    this.profile.addEventListener("change", () => {
      this.selectedProfile = this.profile.value;
      this.renderApiControls();
      this.updateComposer();
    });
    this.composer = h("form", { class: "composer" }, this.text,
      h("div", { class: "composer-foot" },
        h("div", { class: "chat-turn-controls" }, this.profile, this.apiControls, this.native.controls, this.native.advanced),
        speechButton(this.text), this.stop, this.send));
    this.composer.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.text.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.composer.requestSubmit(); } });
    this.dock = h("div", { class: "chat-dock" }, this.native.element, this.notice, this.profileStatus, this.composer);
    this.scroller.append(this.messages, this.native.activity);
    this.messageNav = new MessageRail(this.scroller, this.messages, ".msg-user", t("Jump to a message"), (index, excerpt) => t("Message {0}: {1}", index + 1, excerpt));
    this.layout.append(
      h("aside", { class: "chat-side" },
        h("div", { class: "list-tools" }, h("button", { type: "button", class: "btn", onclick: () => this.newConversation() }, icon("plus"), t("New chat"))),
        this.conversations),
      h("section", { class: "chat-main" }, h("div", { class: "message-layout" }, this.scroller, this.messageNav.element), this.dock));
    root.append(
      h("header", { class: "bar" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Conversations"), onclick: () => this.layout.classList.toggle("show-side") }, icon("assistant")),
        h("h1", { class: "bar-title" }, t("Assistant")),
        h("div", { class: "segmented", role: "group", "aria-label": t("View") }, this.segChat, this.segMemory),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.refresh() }, icon("refresh"))),
      this.layout);
    this.restoreDraft();
    this.text.addEventListener("input", () => this.captureDraft());
    void this.loadProfiles();
    this.showWelcome();
    void this.loadConversations();
    // Shoulder navigation keeps controller focus on the module.
    if (!document.body.hasAttribute("data-gamepad-mode")) this.text.focus();
    if (initial) this.open(initial);
  }

  /** `conv_…` 或 `conv_…@amsg_…`：打开对话，并定位到那条消息。 */
  open(reference: string): void {
    const [conversation, message] = reference.split(MESSAGE_SEPARATOR, 2);
    if (!conversation?.startsWith("conv_")) return;
    if (this.sending) { toast(t("The current reply is still streaming.")); return; }
    this.targetMessage = message;
    if (this.current === conversation && !message) return;
    void this.openConversation(conversation, true);
  }

  dispose(): void { this.native.dispose();this.messageNav.dispose(); this.disposeReferences(); this.captureDraft(); this.active = false; this.generation++; this.controller?.abort(); }
  resume(): void {
    if (this.scrollOnResume) this.scrollToLatest();
    void this.loadProfiles();
  }
  intent(name: string): void {
    if (name === "new") this.newConversation();
    else if (name.startsWith("ask:")) {
      if (this.sending) { toast(t("The current reply is still streaming.")); return; }
      this.newConversation();
      if (this.text.value.trim()) { toast(t("Finish or clear the current chat draft first.")); return; }
      this.text.value = name.slice(4);
      this.text.dispatchEvent(new Event("input"));
      void this.submit();
    }
  }
  get dirty(): boolean { return this.mode === "chat" ? !!this.text.value.trim() : !!this.messages.querySelector<HTMLTextAreaElement>("textarea[name=memory-content]")?.value.trim(); }
  canLeave(): boolean { this.captureDraft(); return true; }
  private captureDraft(): void {
    const key = `chat:${this.current ?? "new"}`;
    if (this.text.value || this.uncertain) this.store.write(key, { text: this.text.value, uncertain: this.uncertain, nativeCreate: this.nativeCreate }); else this.store.remove(key);
  }
  private restoreDraft(): void {
    const draft = this.store.read<{text:string;uncertain?:AssistantChatRequest;nativeCreate?:NativeCreate}>(`chat:${this.current ?? "new"}`);
    this.text.value = draft?.text ?? ""; this.uncertain = draft?.uncertain; this.nativeCreate = draft?.nativeCreate;
    if (!this.text.value && this.uncertain) this.text.value = this.uncertain.message;
  }

  private loadProfiles(): Promise<void> {
    return this.profileLoad ??= this.client.aiConfiguration().then(config => {
      if (!this.active) return;
      this.profiles = config.profiles.filter(profile => profile.engine !== "speech"); // 语音 Profile 不能用于聊天（ADR 0055）
      this.connections = config.connections;
      this.profilesLoaded = true;
      this.renderProfiles();
    }).catch(cause => {
      if (this.active && !this.profilesLoaded) clear(this.profileStatus, failure(errorText(cause), () => this.loadProfiles()));
    }).finally(() => { this.profileLoad = undefined; });
  }

  private renderProfiles(): void {
    const options = assistantProfiles(this.profiles, !!this.current, this.boundProfile);
    // Without a saved default nothing is preselected; say so instead of showing an empty pill.
    clear(this.profile, h("option", { value: "", disabled: true, hidden: true }, t("Choose a profile")),
      ...options.map(profile => h("option", { value: profile.id }, profile.name)));
    this.profile.value = this.selectedProfile ?? (this.current ? "" : defaultAssistantProfile(options));
    this.profile.hidden = !options.length;
    this.renderApiControls();
    this.updateComposer();
  }

  private renderApiControls(): void {
    const profile = this.profiles.find(value => value.id === this.profile.value);
    const connection = this.connections.find(value => value.id === profile?.connection);
    this.apiControls.hidden = profile?.engine !== "lumio";
    if (!profile || this.apiControls.hidden) {
      this.apiControlsProfile = undefined;
      return;
    }
    const deepseek = connection?.kind === "deepseek" && !!connection.base_url
      && new URL(connection.base_url).origin === "https://api.deepseek.com";
    const models = [...new Set([profile.model, ...(deepseek ? DEEPSEEK_MODELS : []),
      ...this.profiles.filter(value => value.connection === profile.connection).map(value => value.model)])];
    const same = this.apiControlsProfile === profile.id;
    const model = same && models.includes(this.apiModel.value) ? this.apiModel.value : profile.model;
    const effort = same ? this.apiEffort.value : "";
    this.apiControlsProfile = profile.id;
    clear(this.apiModel, ...models.map(value => h("option", { value, selected: value === model }, value)));
    clear(this.apiEffort, h("option", { value: "" }, profile.effort
      ? t("Default effort ({0})", effortLabel(profile.effort)) : t("Default effort")),
      ...(deepseek ? DEEPSEEK_EFFORTS.map(value => h("option", { value, selected: value === effort }, effortLabel(value))) : []));
    this.apiModel.disabled = models.length < 2;
    this.apiEffort.disabled = !deepseek;
  }

  private updateComposer(): void {
    const nativeRunning = ["running", "awaiting_approval"].includes(this.native.session?.view.state ?? "");
    const blocked = this.sending || this.serverRunning || this.conversationLoading || nativeRunning;
    this.profile.disabled = blocked || this.native.bound || !this.profile.options.length;
    this.send.disabled = blocked || !this.nativeReady || !this.profile.value;
    this.stop.hidden = this.native.bound ? !nativeRunning : !this.controller;
    this.send.hidden = this.sending || nativeRunning;
    if (this.stop.hidden) this.stop.disabled = false;
    if (!this.profilesLoaded) return;
    clear(this.profileStatus);
    if (this.profile.value || this.conversationLoading) return;
    const hint = this.native.bound ? "The profile for this conversation is unavailable."
      : this.current ? "Choose an API profile to continue this chat." : "Choose a profile to start chatting.";
    this.profileStatus.append(h("p", { class: "notice" }, t(hint), " ",
      h("a", { href: "#settings/ai" }, t("Set up AI"))));
  }

  private setBusy(busy: boolean): void {
    this.sending = busy;
    this.updateComposer();
    this.text.disabled = busy;
    this.segChat.disabled = busy; this.segMemory.disabled = busy;
    this.root.querySelectorAll<HTMLButtonElement>(".chat-side button").forEach(button => button.disabled = busy);
  }

  private showWelcome(): void {
    clear(this.messages, h("div", { class: "welcome" },
      h("span", { class: "brand-mark", "aria-hidden": "true" }),
      h("h2", {}, t("What would you like to think through?")),
      h("p", {}, t("Ask about your tasks, notes and runs. The assistant can create tasks, comment and change task fields; each change shows here and can be undone. It can't dispatch, approve, or mark tasks done.")),
      h("div", { class: "suggestions" }, ...SUGGESTIONS.map(key => t(key)).map(text => h("button", { type: "button", class: "suggestion", onclick: () => { this.text.value = text; this.text.dispatchEvent(new Event("input")); this.text.focus(); } }, text)))));
  }

  private scrollToLatest(): void {
    this.scrollOnResume = this.root.hidden;
    if (!this.scrollOnResume) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private newConversation(): void {
    if (this.sending) return;
    if (this.mode !== "chat") this.switchMode("chat");
    if (this.mode !== "chat") return;
    this.generation++; this.serverRunning = false; this.conversationLoading = false;
    this.firstNativeSend = undefined;
    this.captureDraft();
    this.current = this.selectedProfile = this.boundProfile = undefined;
    this.apiControlsProfile = undefined;
    this.native.bind(undefined);
    this.progress.clear();
    this.nativeTurn = undefined;
    this.restoreDraft();
    this.renderProfiles();
    this.setBusy(false);
    clear(this.notice); this.showWelcome(); this.markCurrent();
    this.layout.classList.remove("show-side");
    this.text.focus();
  }

  private switchMode(mode: "chat" | "memory"): void {
    if (this.sending || mode === this.mode) return;
    this.captureDraft();
    this.mode = mode;
    this.segChat.setAttribute("aria-pressed", String(mode === "chat"));
    this.segMemory.setAttribute("aria-pressed", String(mode === "memory"));
    this.generation++;
    this.dock.hidden = mode === "memory";
    if (mode === "memory") void this.loadMemories();
    else if (this.current) void this.openConversation(this.current);
    else this.showWelcome();
  }

  private markCurrent(): void {
    this.conversations.querySelectorAll<HTMLElement>("[data-id]").forEach(el => el.classList.toggle("is-selected", el.dataset.id === this.current));
  }

  private async loadConversations(): Promise<AssistantConversation[]> {
    try {
      const conversations = (await this.client.conversations()).slice().sort((a, b) => b.updated.localeCompare(a.updated));
      if (!this.active) return [];
      clear(this.conversations, ...conversations.map(c => h("div", { class: "convo-row", "data-id": c.id },
        h("button", { type: "button", class: "convo", disabled: this.sending, onclick: () => void this.openConversation(c.id) },
          h("strong", {}, c.title), h("span", { title: formatTime(c.updated) }, ago(c.updated))),
        h("button", { type: "button", class: "icon-btn row-delete", title: t("Delete conversation"), "aria-label": t("Delete conversation {0}", c.title),
          disabled: this.sending, onclick: () => void this.confirmDelete(c) }, icon("trash")))),
        !conversations.length && h("p", { class: "state" }, t("No conversations yet")));
      this.markCurrent();
      return conversations;
    } catch (cause) {
      if (this.active) clear(this.conversations, failure(errorText(cause), () => this.loadConversations()));
      return [];
    }
  }

  /** 删除对话（ADR 0038）：移入回收站；从中保存的记忆不受影响；提示被多少知识引用（ADR 0051）。 */
  private async confirmDelete(conversation: AssistantConversation): Promise<void> {
    if (this.sending) return;
    const references = await knowledgeReferences(this.client, conversation.id);
    if (!this.active || this.sending || document.querySelector("dialog[open]")) return;
    confirmDelete(this.client, {
      title: t("Delete this conversation?"), name: conversation.title,
      consequences: [t("Memories saved from it are kept."), ...referenceConsequence(references)],
      run: async requestId => (await this.client.deleteConversation(conversation.id, { request_id: requestId })).item,
      deleted: () => {
        this.store.remove(`chat:${conversation.id}`);
        if (this.current === conversation.id) this.newConversation();
        void this.loadConversations();
      },
      restored: () => void this.loadConversations(),
    });
  }

  private async openConversation(id: string, keepTarget = false): Promise<void> {
    if (this.sending) return;
    if (!keepTarget) this.targetMessage = undefined;
    if (this.mode !== "chat") this.switchMode("chat");
    if (this.mode !== "chat") return;
    const generation = ++this.generation;
    this.captureDraft();
    if (this.current !== id) {
      this.firstNativeSend = undefined;
      this.selectedProfile = this.boundProfile = undefined;
      this.apiControlsProfile = undefined;
      this.native.bind(undefined);
      this.progress.clear();
      this.nativeTurn = undefined;
    }
    this.current = id;
    this.conversationLoading = true;
    this.updateComposer();
    this.restoreDraft(); this.markCurrent();
    this.layout.classList.remove("show-side");
    clear(this.messages, loading()); clear(this.notice);
    try {
      const [detail, tools] = await Promise.all([this.client.conversation(id), this.hub.assistantTools(id).catch(() => [])]);
      if (!this.active || generation !== this.generation || this.mode !== "chat") return;
      this.renderDetail(detail, tools);
    } catch (cause) {
      if (this.active && generation === this.generation) clear(this.messages, failure(errorText(cause)));
    }
  }

  private userBubble(text: string, id?: string): HTMLElement { const body=h("div",{class:"msg-user markdown",...(id?{"data-message":id}:{})});body.innerHTML=renderMarkdown(text);return body; }
  private assistantBlock(content: Node): HTMLElement {
    return h("div", { class: "msg-assistant" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("div", {}, content));
  }

  private turnProgress(turn: string, native: boolean): ChatProgress {
    let progress = this.progress.get(turn);
    if (!progress) {
      progress = new ChatProgress(native ? "Thinking summary" : "Thinking process");
      this.progress.set(turn, progress);
    }
    return progress;
  }

  private onNativeProgress({ turn, event }: NativeEventRecord): void {
    if (event.type === "state" && event.view.state !== "running" && this.nativeTurn) {
      this.progress.get(this.nativeTurn)?.finish();
    }
    if (!turn) return;
    const progress = this.turnProgress(turn, true);
    if (event.type === "reasoning") progress.reasoning(event.delta, turn === this.nativeTurn && this.native.session?.view.state === "running");
    else if (event.type === "text" || event.type === "complete" || (event.type === "tool" && event.status === "running")) progress.finish();
  }

  private renderDetail(detail: AssistantConversationDetail, tools: AssistantToolCall[] = []): void {
    this.current = detail.conversation.id;
    this.conversationLoading = false;
    this.selectedProfile ??= detail.conversation.profile;
    this.boundProfile = detail.conversation.native_session ? detail.conversation.profile : undefined;
    this.native.bind(detail.conversation.native_session);
    const turn = detail.turns.at(-1);
    this.nativeTurn = detail.conversation.native_session && turn?.status === "running" ? turn.id : undefined;
    this.renderProfiles();
    const calls = new Map(tools.map(call => [call.id, call]));
    let toolGroup: HTMLElement | undefined;
    clear(this.messages, ...detail.messages.flatMap(message => {
      const call = message.tool_call ? calls.get(message.tool_call) : undefined;
      if (call) {
        // 连续的工具调用放在同一组里，读起来像一串步骤。
        const view = toolCallView(call, this.client, this.navigate);
        if (toolGroup) { toolGroup.append(view); return []; }
        toolGroup = h("div", { class: "msg-tools" }, view);
        return [toolGroup];
      }
      if (message.role === "assistant" && !message.content.trim()) return [];
      toolGroup = undefined;
      if (message.role === "user") return [this.userBubble(message.content, message.id),
        ...(message.turn ? [this.turnProgress(message.turn, !!detail.conversation.native_session).element] : [])];
      // 工具调用之间的中间回复可以没有文字（ADR 0025）；不显示空气泡。
      if (message.role === "assistant" && !message.content.trim()) return [];
      const content = h("div", { class: "markdown" });
      content.innerHTML = renderMarkdown(message.content);
      const block = message.role === "assistant" ? this.assistantBlock(content) : h("div", { class: "msg-tool" }, icon("terminal"), t(" Tool result"), content);
      block.dataset.message = message.id;
      return [block];
    }));
    this.serverRunning = turn?.status === "running";
    this.setBusy(this.sending);
    if (turn && turn.status !== "done") clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, `${TURN_LABEL[turn.status]}${turn.error ? `：${turn.error}` : ""}`)));
    else clear(this.notice);
    this.markCurrent();
    const wanted = this.targetMessage;
    this.targetMessage = undefined;
    const target = wanted ? this.messages.querySelector<HTMLElement>(`[data-message="${CSS.escape(wanted)}"]`) : null;
    if (wanted && !target) toast(t("That message isn't shown in this conversation."));
    if (target) {
      target.classList.add("is-target");
      target.scrollIntoView({ block: "center" });
      setTimeout(() => target.classList.remove("is-target"), 2400);
    } else this.scrollToLatest();
  }

  private async refresh(): Promise<void> {
    if (this.sending) return;
    if (this.mode === "memory") {
      await this.loadMemories();
    } else { await Promise.all([this.loadProfiles(), this.loadConversations()]); if (this.current) await this.openConversation(this.current); }
  }

  private async stopTurn() {
    if (this.stop.disabled) return;
    const session = this.native.session;
    this.stop.disabled = true;
    if (!session) { this.controller?.abort(); return; }
    try { await this.client.nativeAction(session.id, { action: "interrupt" }); }
    catch (error) { this.stop.disabled = false; clear(this.notice, failure(errorText(error))); }
  }

  private async submit(): Promise<void> {
    const generation = this.generation;
    if (this.profileLoad && !this.profilesLoaded) await this.profileLoad;
    if (!this.active || generation !== this.generation || this.mode !== "chat" || this.send.disabled || !this.text.value.trim()) return;
    const selected = this.profiles.find(profile => profile.id === this.profile.value);
    if (!selected) return;
    this.selectedProfile = selected.id;
    if (!this.current && selected.engine === "codex") {
      this.setBusy(true);
      this.nativeCreate = this.nativeCreate?.profile === selected.id ? this.nativeCreate
        : { request_id: newRequestId("native"), profile: selected.id };
      this.captureDraft();
      try {
        const session = await this.client.createNativeSession(this.nativeCreate);
        if (!this.active) return;
        this.store.remove("chat:new");
        this.nativeCreate = undefined;
        this.current = session.conversation;
        this.boundProfile = selected.id;
        if (session.connection_auth) this.firstNativeSend = { conversation: session.conversation, message: this.text.value.trim() };
        this.native.bind(session.id);
        this.renderProfiles();
        this.captureDraft();
        void this.loadConversations();
        clear(this.notice, h("p", { class: "notice" }, t(session.connection_auth ? "Starting Codex" : "Sign in to continue. Your message is kept as a draft.")));
      } catch (error) {
        if (this.active) clear(this.notice, failure(errorText(error)),
          h("button", { type: "button", class: "btn btn-small", onclick: () => this.navigate("settings", "ai") }, t("Open AI settings")));
      } finally { this.setBusy(false); }
      return;
    }
    const input: Omit<AssistantChatRequest, "request_id"> = {
      profile: selected.id, conversation: this.current, message: this.text.value.trim(),
      ...(selected.engine === "codex" ? this.native.settings() : {
        ...(this.apiModel.value && this.apiModel.value !== selected.model ? { model: this.apiModel.value } : {}),
        ...(this.apiEffort.value ? { effort: this.apiEffort.value } : {}),
      }),
    };
    const previous = this.uncertain;
    const same = previous && previous.message === input.message && previous.conversation === input.conversation
      && previous.profile === input.profile && previous.model === input.model && previous.effort === input.effort;
    const request: AssistantChatRequest = { ...input, request_id: same ? previous.request_id : newRequestId("chat") };
    this.uncertain = request; this.captureDraft();
    this.controller = new AbortController();
    this.setBusy(true);
    clear(this.notice);
    this.text.value = ""; this.text.dispatchEvent(new Event("input"));
    if (!this.current) clear(this.messages);
    const content = h("div", { class: "markdown stream-text streaming" });
    const tools = h("div", { class: "msg-tools", role: "status" });
    const shown = new Map<string, HTMLElement>();
    const native = selected.engine === "codex";
    let progress = new ChatProgress(native ? "Thinking summary" : "Thinking process");
    let streamTurn: string | undefined;
    progress.waiting();
    // Progress sits in the reply's own row, so waiting and thinking line up with the answer that follows.
    this.messages.append(this.userBubble(request.message), this.assistantBlock(h("div", {}, progress.element, content, tools)));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    let complete = false, streamedText = "";
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    const renderStream = () => {
      renderTimer = undefined;
      if (!this.active) return;
      const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 120;
      content.innerHTML = renderMarkdown(streamedText);
      if (nearBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
    };
    try {
      for await (const event of this.client.assistantEvents(request, this.controller.signal, true)) {
        if (!this.active) return;
        if (!streamTurn) {
          streamTurn = event.turn;
          const existing = this.progress.get(streamTurn);
          if (existing) {
            progress.element.replaceWith(existing.element);
            progress = existing;
          } else this.progress.set(streamTurn, progress);
          if (native) this.nativeTurn = streamTurn;
        }
        if (event.type === "model_waiting") progress.waiting();
        else if (event.type === "reasoning") progress.reasoning(event.delta);
        if (event.type === "token") {
          if (!native && event.delta) progress.finish();
          streamedText += event.delta;
          if (!renderTimer) renderTimer = setTimeout(renderStream, 80);
        }
        else if (event.type === "tool") {
          progress.finish();
          const view = toolCallView(event.tool, this.client, this.navigate);
          const previous = shown.get(event.tool.id);
          if (previous) previous.replaceWith(view); else tools.append(view);
          shown.set(event.tool.id, view);
        }
        else if (event.type === "result") { complete = true; this.current = event.messages[0]?.conversation ?? this.current; }
        else if(event.type==="error")clear(this.notice, failure(event.error));
        const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 120;
        if (nearBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
      }
    } catch (cause) {
      if (this.active) clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, this.controller.signal.aborted ? t("Stopped receiving. Checking what was saved…") : t("{0} Checking what was saved…", errorText(cause)))));
    } finally {
      progress.finish();
      this.nativeTurn = undefined;
      clearTimeout(renderTimer); renderStream();
      content.classList.remove("streaming");
      if (this.active) {
        await this.inspect(request, complete);
        this.controller = undefined; this.setBusy(false);
        void this.loadConversations();
        if (this.active && !this.root.hidden) this.text.focus();
      }
    }
  }

  /** 以服务端记录为准：找到这次 request_id 的轮次才算已保存，否则保留草稿，不自动重发。 */
  private async inspect(request: AssistantChatRequest, complete: boolean): Promise<void> {
    try {
      let detail: AssistantConversationDetail | undefined;
      if (this.current) detail = await this.client.conversation(this.current);
      else {
        const conversations = await this.client.conversations();
        for (const conversation of conversations.slice().sort((a, b) => b.updated.localeCompare(a.updated))) {
          const candidate = await this.client.conversation(conversation.id);
          if (candidate.turns.some(turn => turn.request_id === request.request_id)) { detail = candidate; break; }
          if (!this.active) return;
        }
      }
      if (!this.active) return;
      if (detail && detail.turns.some(turn => turn.request_id === request.request_id)) {
        const tools = await this.hub.assistantTools(detail.conversation.id).catch(() => []);
        if (!this.active) return;
        this.selectedProfile = request.profile;
        this.renderDetail(detail, tools);
        const turn = detail.turns.find(value => value.request_id === request.request_id)!;
        if (turn.status === "running") clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, t("The Hub is still working on it. Refresh later to see the result. The request was not sent again."))));
        else { this.uncertain = undefined; this.store.remove(`chat:${request.conversation ?? "new"}`); this.captureDraft(); }
      } else if (!complete) {
        this.text.value = request.message; this.text.dispatchEvent(new Event("input"));
        clear(this.notice, failure(t("This message wasn't found in the saved history. Your draft is back in the box — check the conversation list before sending again.")));
      }
    } catch {
      if (this.active) {
        this.text.value = request.message; this.text.dispatchEvent(new Event("input"));
        clear(this.notice, failure(t("Couldn't check the saved history. Your draft is back in the box; once you're reconnected, check the history first. Nothing is resent automatically.")));
      }
    }
  }

  // ───────────── 记忆 ─────────────

  private async loadMemories(): Promise<void> {
    if (!this.active || this.mode !== "memory") return;
    const generation = ++this.generation;
    clear(this.messages, loading());
    try {
      const memories = await this.client.memories();
      if (!this.active || generation !== this.generation || this.mode !== "memory") return;
      const text = autosize(h("textarea", { name: "memory-content", rows: "2", placeholder: t("For example: lead with the conclusion, then explain; answer in English."), "aria-label": t("New memory") }));
      const captureMemory = textDraft(text, "memory:new");
      const message = h("div", { role: "alert" });
      const save = h("button", { type: "submit", class: "btn btn-primary btn-small" }, t("Save memory"));
      const form = h("form", { class: "composer" }, text, h("div", { class: "composer-foot" }, h("span", { class: "hint" }, t("Only what you write here is saved")), save));
      let requestId = newRequestId("memory"), previous = "";
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (save.disabled || !text.value.trim()) return;
        save.disabled = true;
        if (previous && previous !== text.value) requestId = newRequestId("memory");
        previous = text.value;
        try {
          await this.client.memoryCommand({ request_id: requestId, operation: { op: "assistant.memory.remember", args: { content: text.value } } });
          text.value = ""; captureMemory();
          toast(t("Memory saved"));
          if (this.active) void this.loadMemories();
        } catch (cause) { clear(message, failure(t("{0} Your input is kept; check the list first.", errorText(cause)))); }
        finally { save.disabled = false; }
      });
      clear(this.messages, h("div", { class: "memory-page" },
        h("h2", {}, t("What the assistant remembers")),
        h("p", {}, t("Nothing is extracted from chats automatically. Forgotten items are no longer used; existing conversations are kept separately.")),
        form, message,
        memories.length
          ? h("div", { class: "memory-list" }, ...memories.map(memory => h("article", { class: "memory-item" }, icon("memory"), h("p", {}, memory.content),
              h("span", { title: formatTime(memory.created) }, ago(memory.created)),
              h("button", { type: "button", class: "icon-btn row-delete", title: t("Forget"), "aria-label": t("Forget memory {0}", memory.content.slice(0, 80)), onclick: () => this.forget(memory) }, icon("trash")))))
          : empty(t("No memories yet. Write down preferences or facts you want the assistant to keep in mind."))));
    } catch (cause) {
      if (this.active && generation === this.generation) clear(this.messages, failure(errorText(cause), () => this.loadMemories()));
    }
  }

  private forget(memory: AssistantMemory): void {
    const message = h("div", { role: "alert" });
    const button = h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      button.disabled = true;
      try {
        await this.client.memoryCommand({ request_id: newRequestId("forget"), operation: { op: "assistant.memory.forget", args: { memory: memory.id } } });
        dialog.close(); toast(t("Forgotten"));
        if (this.active) void this.loadMemories();
      } catch (cause) { clear(message, failure(errorText(cause))); button.disabled = false; }
    } }, t("Forget"));
    const dialog = openDialog(t("Forget this memory?"), h("div", { class: "form-stack" }, h("p", {}, memory.content), message), [button]);
  }
}
