/**
 * 助手：对话历史、流式回复、停止接收与中断后核查；显式记忆。
 * 中断或结果不明时只核对已保存记录，不自动重发；同样的草稿重发时复用 request_id。
 */
import type { AssistantConversation, AssistantConversationDetail, AssistantMemory, AssistantChatRequest } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { autosize, clear, empty, failure, h, icon, loading, openDialog, toast } from "../dom.ts";
import { ago } from "../format.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { t, translated } from "../i18n.ts";

const TURN_LABEL: Record<string, string> = translated({ running: "Still working", done: "Done", failed: "Didn't finish", unknown: "Result unknown — check before retrying", cancelled: "Cancelled" });
const SUGGESTIONS = ["Help me prioritize what to work on today", "How should I organize this week's experiment results?", "Draft an outline for the rebuttal"];

export class AssistantPane {
  private layout = h("div", { class: "chat" });
  private conversations = h("div", { class: "list-scroll" });
  private scroller = h("div", { class: "chat-scroll" });
  private messages = h("div", { class: "messages", role: "log", "aria-label": t("Conversation messages") });
  private text = autosize(h("textarea", { name: "chat-message", rows: "1", placeholder: t("Ask anything, or think through the next step…"), "aria-label": t("Message") }));
  private model = h("input", { name: "chat-model", class: "model-input", placeholder: t("Default model"), title: t("Applies to this message only; doesn't change the service or permissions"), autocomplete: "off" });
  private send = h("button", { type: "submit", class: "btn btn-primary btn-small", "aria-label": t("Send") }, icon("send"), t("Send"));
  private stop = h("button", { type: "button", class: "btn btn-small", hidden: true, onclick: () => this.controller?.abort() }, icon("stop"), t("Stop"));
  private notice = h("div", { role: "status" });
  private dock: HTMLElement;
  private composer: HTMLFormElement;
  private segChat = h("button", { type: "button", "aria-pressed": "true", onclick: () => this.switchMode("chat") }, t("Chat"));
  private segMemory = h("button", { type: "button", "aria-pressed": "false", onclick: () => this.switchMode("memory") }, t("Memory"));
  private current?: string;
  private controller?: AbortController;
  private sending = false;
  private serverRunning = false;
  private active = true;
  private generation = 0;
  private mode: "chat" | "memory" = "chat";
  private uncertain?: AssistantChatRequest;

  constructor(private root: HTMLElement, private client: Client, intent?: string) {
    this.composer = h("form", { class: "composer" }, this.text,
      h("div", { class: "composer-foot" }, this.model, h("span", { class: "hint hide-narrow" }, t("↵ send · ⇧↵ new line")), this.stop, this.send));
    this.composer.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.text.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.composer.requestSubmit(); } });
    this.dock = h("div", { class: "chat-dock" }, this.notice, this.composer);
    this.scroller.append(this.messages);
    this.layout.append(
      h("aside", { class: "chat-side" },
        h("div", { class: "list-tools" }, h("button", { type: "button", class: "btn", onclick: () => this.newConversation() }, icon("plus"), t("New chat"))),
        this.conversations),
      h("section", { class: "chat-main" }, this.scroller, this.dock));
    root.append(
      h("header", { class: "bar" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Conversations"), onclick: () => this.layout.classList.toggle("show-side") }, icon("assistant")),
        h("h1", { class: "bar-title" }, t("Assistant")),
        h("div", { class: "segmented", role: "group", "aria-label": t("View") }, this.segChat, this.segMemory),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.refresh() }, icon("refresh"))),
      this.layout);
    this.showWelcome();
    void this.loadConversations();
    if (intent?.startsWith("ask:")) { this.text.value = intent.slice(4); this.text.dispatchEvent(new Event("input")); void this.submit(); }
    else this.text.focus();
  }

  dispose(): void { this.active = false; this.generation++; this.controller?.abort(); }
  intent(name: string): void { if (name === "new") this.newConversation(); }
  get dirty(): boolean { return this.mode === "chat" ? !!this.text.value.trim() : !!this.messages.querySelector<HTMLTextAreaElement>("textarea[name=memory-content]")?.value.trim(); }
  canLeave(): boolean {
    return this.sending ? confirm(t("The assistant is still replying. Leaving stops this page from receiving it; you can find what was saved in the history later. Leave anyway?"))
      : !this.dirty || confirm(t("You have an unsent draft that will be discarded. Continue?"));
  }

  private setBusy(busy: boolean): void {
    this.sending = busy;
    this.send.disabled = busy || this.serverRunning;
    this.text.disabled = busy;
    this.stop.hidden = !busy; this.send.hidden = busy;
    this.segChat.disabled = busy; this.segMemory.disabled = busy;
    this.root.querySelectorAll<HTMLButtonElement>(".chat-side button").forEach(button => button.disabled = busy);
  }

  private showWelcome(): void {
    clear(this.messages, h("div", { class: "welcome" },
      h("span", { class: "brand-mark", "aria-hidden": "true" }),
      h("h2", {}, t("What would you like to think through?")),
      h("p", {}, t("The assistant uses the model configured on your Hub. It can't see your tasks or private notes unless you explicitly give it those tools.")),
      h("div", { class: "suggestions" }, ...SUGGESTIONS.map(key => t(key)).map(text => h("button", { type: "button", class: "suggestion", onclick: () => { this.text.value = text; this.text.dispatchEvent(new Event("input")); this.text.focus(); } }, text)))));
  }

  private newConversation(): void {
    if (this.sending) return;
    if (this.mode !== "chat") this.switchMode("chat");
    if (this.mode !== "chat") return;
    this.generation++; this.serverRunning = false; this.setBusy(false);
    this.current = undefined; this.uncertain = undefined;
    clear(this.notice); this.showWelcome(); this.markCurrent();
    this.layout.classList.remove("show-side");
    this.text.focus();
  }

  private switchMode(mode: "chat" | "memory"): void {
    if (this.sending || mode === this.mode) return;
    if (this.mode === "memory" && this.dirty && !confirm(t("You have an unsaved memory draft that will be discarded. Continue?"))) return;
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
      clear(this.conversations, ...conversations.map(c => h("button", { type: "button", class: "convo", "data-id": c.id, disabled: this.sending, onclick: () => void this.openConversation(c.id) },
        h("strong", {}, c.title), h("span", { title: formatTime(c.updated) }, ago(c.updated)))),
        !conversations.length && h("p", { class: "state" }, t("No conversations yet")));
      this.markCurrent();
      return conversations;
    } catch (cause) {
      if (this.active) clear(this.conversations, failure(errorText(cause), () => this.loadConversations()));
      return [];
    }
  }

  private async openConversation(id: string): Promise<void> {
    if (this.sending) return;
    if (this.mode !== "chat") this.switchMode("chat");
    if (this.mode !== "chat") return;
    const generation = ++this.generation;
    this.current = id; this.markCurrent();
    this.layout.classList.remove("show-side");
    clear(this.messages, loading()); clear(this.notice);
    try {
      const detail = await this.client.conversation(id);
      if (!this.active || generation !== this.generation || this.mode !== "chat") return;
      this.renderDetail(detail);
    } catch (cause) {
      if (this.active && generation === this.generation) clear(this.messages, failure(errorText(cause)));
    }
  }

  private userBubble(text: string): HTMLElement { return h("div", { class: "msg-user" }, text); }
  private assistantBlock(content: Node): HTMLElement {
    return h("div", { class: "msg-assistant" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("div", {}, content));
  }

  private renderDetail(detail: AssistantConversationDetail): void {
    this.current = detail.conversation.id;
    clear(this.messages, ...detail.messages.map(message => {
      if (message.role === "user") return this.userBubble(message.content);
      const content = h("div", { class: "markdown" });
      content.innerHTML = renderMarkdown(message.content);
      return message.role === "assistant" ? this.assistantBlock(content) : h("div", { class: "msg-tool" }, icon("terminal"), t(" Tool result"), content);
    }));
    const turn = detail.turns.at(-1);
    this.serverRunning = turn?.status === "running";
    this.setBusy(this.sending);
    if (turn && turn.status !== "done") clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, `${TURN_LABEL[turn.status]}${turn.error ? `：${turn.error}` : ""}`)));
    else clear(this.notice);
    this.markCurrent();
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private async refresh(): Promise<void> {
    if (this.sending) return;
    if (this.mode === "memory") {
      if (this.dirty && !confirm(t("Refreshing discards your unsaved memory draft. Continue?"))) return;
      await this.loadMemories();
    } else { await this.loadConversations(); if (this.current) await this.openConversation(this.current); }
  }

  private async submit(): Promise<void> {
    if (this.sending || this.serverRunning || !this.text.value.trim()) return;
    const input = { conversation: this.current, message: this.text.value.trim(), ...(this.model.value.trim() ? { model: this.model.value.trim() } : {}) };
    const previous = this.uncertain;
    const same = previous && previous.message === input.message && previous.conversation === input.conversation && previous.model === input.model;
    const request: AssistantChatRequest = { ...input, request_id: same ? previous.request_id : newRequestId("chat") };
    this.uncertain = request;
    this.setBusy(true);
    this.controller = new AbortController();
    clear(this.notice);
    this.text.value = ""; this.text.dispatchEvent(new Event("input"));
    if (!this.current) clear(this.messages);
    const content = h("div", { class: "stream-text streaming" });
    const tools = h("div", { class: "tool-status", role: "status" });
    this.messages.append(this.userBubble(request.message), this.assistantBlock(h("div", {}, content, tools)));
    this.scroller.scrollTop = this.scroller.scrollHeight;
    let complete = false;
    try {
      for await (const event of this.client.assistantEvents(request, this.controller.signal)) {
        if (!this.active) return;
        if (event.type === "token") content.textContent = (content.textContent ?? "") + event.delta;
        else if (event.type === "tool") tools.textContent = t("{0}: {1}", event.tool.name, event.tool.status === "succeeded" ? t("Done") : event.tool.status === "unknown" ? t("Unknown result") : event.tool.status === "failed" ? t("Didn't finish") : t("Working"));
        else if (event.type === "result") { complete = true; this.current = event.messages[0]?.conversation ?? this.current; }
        else clear(this.notice, failure(event.error));
        const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 120;
        if (nearBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
      }
    } catch (cause) {
      if (this.active) clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, this.controller.signal.aborted ? t("Stopped receiving. Checking what was saved…") : t("{0} Checking what was saved…", errorText(cause)))));
    } finally {
      content.classList.remove("streaming");
      if (this.active) {
        await this.inspect(request, complete);
        this.setBusy(false); this.controller = undefined;
        void this.loadConversations();
        this.text.focus();
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
        this.renderDetail(detail);
        const turn = detail.turns.find(value => value.request_id === request.request_id)!;
        if (turn.status === "running") clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, t("The Hub is still working on it. Refresh later to see the result. The request was not sent again."))));
        else this.uncertain = undefined;
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
              h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.forget(memory) }, t("Forget")))))
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
