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

const TURN_LABEL: Record<string, string> = { running: "仍在处理", done: "已完成", failed: "没有完成", unknown: "结果不明，请先核查", cancelled: "已取消" };
const SUGGESTIONS = ["帮我把今天要推进的任务排个优先级", "这周的实验结果应该怎么整理？", "给 rebuttal 列一个提纲"];

export class AssistantPane {
  private layout = h("div", { class: "chat" });
  private conversations = h("div", { class: "list-scroll" });
  private scroller = h("div", { class: "chat-scroll" });
  private messages = h("div", { class: "messages", role: "log", "aria-label": "对话消息" });
  private text = autosize(h("textarea", { name: "chat-message", rows: "1", placeholder: "问点什么，或一起梳理下一步…", "aria-label": "消息" }));
  private model = h("input", { name: "chat-model", class: "model-input", placeholder: "默认模型", title: "只对这一轮生效；不改变服务地址或权限", autocomplete: "off" });
  private send = h("button", { type: "submit", class: "btn btn-primary btn-small", "aria-label": "发送" }, icon("send"), "发送");
  private stop = h("button", { type: "button", class: "btn btn-small", hidden: true, onclick: () => this.controller?.abort() }, icon("stop"), "停止");
  private notice = h("div", { role: "status" });
  private dock: HTMLElement;
  private composer: HTMLFormElement;
  private segChat = h("button", { type: "button", "aria-pressed": "true", onclick: () => this.switchMode("chat") }, "对话");
  private segMemory = h("button", { type: "button", "aria-pressed": "false", onclick: () => this.switchMode("memory") }, "记忆");
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
      h("div", { class: "composer-foot" }, this.model, h("span", { class: "hint hide-narrow" }, "↵ 发送 · ⇧↵ 换行"), this.stop, this.send));
    this.composer.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    this.text.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.composer.requestSubmit(); } });
    this.dock = h("div", { class: "chat-dock" }, this.notice, this.composer);
    this.scroller.append(this.messages);
    this.layout.append(
      h("aside", { class: "chat-side" },
        h("div", { class: "list-tools" }, h("button", { type: "button", class: "btn", onclick: () => this.newConversation() }, icon("plus"), "新对话")),
        this.conversations),
      h("section", { class: "chat-main" }, this.scroller, this.dock));
    root.append(
      h("header", { class: "bar" },
        h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "对话列表", onclick: () => this.layout.classList.toggle("show-side") }, icon("assistant")),
        h("h1", { class: "bar-title" }, "助手"),
        h("div", { class: "segmented", role: "group", "aria-label": "视图" }, this.segChat, this.segMemory),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: "刷新", "aria-label": "刷新", onclick: () => void this.refresh() }, icon("refresh"))),
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
    return this.sending ? confirm("助手仍在回复。离开会停止本页接收，之后可以在历史里查看已保存的内容。确定离开吗？")
      : !this.dirty || confirm("有尚未发送的草稿，离开会丢弃它。确定继续吗？");
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
      h("h2", {}, "想一起理清什么？"),
      h("p", {}, "助手使用 Hub 上配置的模型。它看不到你的任务和私密笔记，除非之后明确开放相应工具。"),
      h("div", { class: "suggestions" }, ...SUGGESTIONS.map(text => h("button", { type: "button", class: "suggestion", onclick: () => { this.text.value = text; this.text.dispatchEvent(new Event("input")); this.text.focus(); } }, text)))));
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
    if (this.mode === "memory" && this.dirty && !confirm("有尚未保存的记忆草稿，切换会丢弃它。确定继续吗？")) return;
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
        !conversations.length && h("p", { class: "state" }, "还没有对话"));
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
      return message.role === "assistant" ? this.assistantBlock(content) : h("div", { class: "msg-tool" }, icon("terminal"), " 工具结果", content);
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
      if (this.dirty && !confirm("刷新会丢弃尚未保存的记忆草稿，确定继续吗？")) return;
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
        else if (event.type === "tool") tools.textContent = `${event.tool.name}：${event.tool.status === "succeeded" ? "已完成" : event.tool.status === "unknown" ? "结果不明" : event.tool.status === "failed" ? "没有完成" : "处理中"}`;
        else if (event.type === "result") { complete = true; this.current = event.messages[0]?.conversation ?? this.current; }
        else clear(this.notice, failure(event.error));
        const nearBottom = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 120;
        if (nearBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
      }
    } catch (cause) {
      if (this.active) clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, this.controller.signal.aborted ? "已停止接收，正在核对已保存的记录…" : `${errorText(cause)}。正在核对已保存的记录…`)));
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
        if (turn.status === "running") clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, "服务端仍在处理，可以稍后刷新查看。没有重新提交这次请求。")));
        else this.uncertain = undefined;
      } else if (!complete) {
        this.text.value = request.message; this.text.dispatchEvent(new Event("input"));
        clear(this.notice, failure("没有找到这次消息的保存记录。草稿已放回输入框，请先核对对话列表，再决定是否重发。"));
      }
    } catch {
      if (this.active) {
        this.text.value = request.message; this.text.dispatchEvent(new Event("input"));
        clear(this.notice, failure("暂时无法核对保存记录。草稿已放回输入框；恢复连接后先查看历史，不会自动重发。"));
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
      const text = autosize(h("textarea", { name: "memory-content", rows: "2", placeholder: "例如：先给结论，再解释理由；回答用中文。", "aria-label": "新记忆" }));
      const message = h("div", { role: "alert" });
      const save = h("button", { type: "submit", class: "btn btn-primary btn-small" }, "保存记忆");
      const form = h("form", { class: "composer" }, text, h("div", { class: "composer-foot" }, h("span", { class: "hint" }, "只保存你在这里明确写下的内容"), save));
      let requestId = newRequestId("memory"), previous = "";
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (save.disabled || !text.value.trim()) return;
        save.disabled = true;
        if (previous && previous !== text.value) requestId = newRequestId("memory");
        previous = text.value;
        try {
          await this.client.memoryCommand({ request_id: requestId, operation: { op: "assistant.memory.remember", args: { content: text.value } } });
          toast("已保存记忆");
          if (this.active) void this.loadMemories();
        } catch (cause) { clear(message, failure(`${errorText(cause)}。输入已保留，请先核对列表。`)); }
        finally { save.disabled = false; }
      });
      clear(this.messages, h("div", { class: "memory-page" },
        h("h2", {}, "助手会记住的事"),
        h("p", {}, "不会从对话里自动提取。遗忘后不再使用，已有对话记录仍独立保留。"),
        form, message,
        memories.length
          ? h("div", { class: "memory-list" }, ...memories.map(memory => h("article", { class: "memory-item" }, icon("memory"), h("p", {}, memory.content),
              h("span", { title: formatTime(memory.created) }, ago(memory.created)),
              h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.forget(memory) }, "遗忘"))))
          : empty("还没有记忆。写下你希望助手一直遵循的偏好或事实。")));
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
        dialog.close(); toast("已遗忘");
        if (this.active) void this.loadMemories();
      } catch (cause) { clear(message, failure(errorText(cause))); button.disabled = false; }
    } }, "遗忘");
    const dialog = openDialog("遗忘这条记忆？", h("div", { class: "form-stack" }, h("p", {}, memory.content), message), [button]);
  }
}
