/**
 * 主对话面板（ADR 0059、0060，A1-5）：所有页面常驻，一个对话不按项目切换。
 * 随消息发送焦点快照；执行助手的展示动作（面板、跳转、高亮）；显示话题分隔与提醒。
 * 跳转与高亮由工作台执行（views/workbench.ts）；人正在操作时跳转降级为「带我过去」。
 */
import { WORKBENCH_TOOLS, toolName } from "@lumio/schema";
import type { AssistantChatRequest, AssistantMessage, Notice, ResourceRef, WorkbenchAction, WorkbenchPanel, WorkTask } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { newRequestId } from "./commands.ts";
import { autosize, clear, failure, h, icon, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import type { Navigate, Section } from "./navigation.ts";
import { openResource } from "./resources.ts";
import { renderMarkdown } from "./utils/markdown.ts";
import { toolCallView } from "./tool-call-view.ts";
import { MAX_TASK_NODES, taskGraph } from "./graph/data.ts";
import { dependencyGraph } from "./graph/view.ts";
import { turnGroup, turnText } from "./turn.ts";
import { anchorLabels, buildFocus, mainProfile, navigateRoute, noticePreview, noticeTitle, refOf, type FocusInput } from "./workbench-assist.ts";

const OPEN_KEY = "lumio.web.dock-open";
/** 已在面板里出现过的提醒（本标签页内），避免刷新时重复插入。 */
const SHOWN_KEY = "lumio.web.dock-notices";
const EXPLORABLE = /^(idea|task|prj)_/;
const HISTORY = 40;
const WORKBENCH_TOOL_NAMES = new Set<string>(WORKBENCH_TOOLS.map(name => toolName(name)));

export interface DockHost {
  /** 当前页面：分区、正在查看的对象、页面里选中的文字。 */
  focus(): FocusInput;
  navigate: Navigate;
  /** 跳转与高亮；人正在操作时跳转返回 deferred。 */
  apply(action: Extract<WorkbenchAction, { action: "navigate" | "highlight" }>): "applied" | "deferred";
  clearHighlights(): void;
  /** 面板开合改变布局。 */
  layout(open: boolean): void;
}

type FocusMode = "auto" | "off" | "pinned";

export class MainDock {
  readonly element: HTMLElement;
  readonly launcher: HTMLButtonElement;
  private scroller = h("div", { class: "dock-scroll" });
  private messages = h("div", { class: "messages dock-messages", role: "log", "aria-label": t("Main conversation") });
  private panel = h("section", { class: "dock-panel", hidden: true, "aria-label": t("Shown by the assistant") });
  private notice = h("div", { role: "status" });
  private chip = h("div", { class: "dock-focus" });
  private text = autosize(h("textarea", { name: "dock-message", rows: "1", placeholder: t("Ask about what you're looking at…"), "aria-label": t("Message") }));
  private send = h("button", { type: "submit", class: "btn btn-primary btn-small", "aria-label": t("Send") }, icon("send"));
  private stop = h("button", { type: "button", class: "btn btn-small", hidden: true, onclick: () => this.controller?.abort() }, icon("stop"), t("Stop"));
  private conversation?: string;
  private profile?: string;
  private ready?: Promise<void>;
  private controller?: AbortController;
  private titles = new Map<string, string>();
  private mode: FocusMode = "auto";
  private pinned?: FocusInput;
  private disposed = false;
  private shown = new Set<string>();
  /** 正在探索的对象 ID（来自 Hub，定时刷新）。 */
  private exploring = new Set<string>();

  constructor(private client: Client, private host: DockHost) {
    const collapse = h("button", { type: "button", class: "icon-btn", title: t("Hide the assistant"), "aria-label": t("Hide the assistant"), onclick: () => this.setOpen(false) }, icon("close"));
    const composer = h("form", { class: "dock-composer", onsubmit: (event: Event) => { event.preventDefault(); void this.submit(); } },
      this.chip, h("div", { class: "dock-input" }, this.text, this.stop, this.send));
    this.text.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.submit(); }
    });
    this.scroller.append(this.messages);
    this.element = h("aside", { class: "dock", "aria-label": t("Assistant") },
      h("header", { class: "dock-head" }, icon("assistant"), h("span", { class: "dock-title" }, t("Assistant")), collapse),
      this.panel, this.scroller, this.notice, composer);
    this.launcher = h("button", { type: "button", class: "dock-launcher", title: t("Ask the assistant"), "aria-label": t("Ask the assistant"), onclick: () => this.setOpen(true) }, icon("assistant"));
    // 没记住过时：桌面默认展开，窄屏默认收起（抽屉会挡住内容）。
    let open = globalThis.matchMedia?.("(min-width: 861px)").matches ?? true;
    try { const saved = localStorage.getItem(OPEN_KEY); if (saved !== null) open = saved === "1"; } catch { /* 用默认值 */ }
    try { this.shown = new Set(JSON.parse(sessionStorage.getItem(SHOWN_KEY) ?? "[]") as string[]); } catch { this.shown = new Set(); }
    this.setOpen(open, false);
  }

  private remember(id: string): void {
    this.shown.add(id);
    try { sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...this.shown].slice(-200))); } catch { /* 只影响本次 */ }
  }

  /** 工作台刷新时交来未读提醒：重要的、还没在面板出现过的插进对话（ADR 0059 第 4 节）。 */
  notices(notices: readonly Notice[]): void {
    if (this.disposed || this.controller || !this.conversation) return;
    const fresh = notices.filter(notice => notice.level === "important" && !notice.read && !this.shown.has(notice.id))
      .sort((a, b) => a.created.localeCompare(b.created));
    if (!fresh.length) return;
    this.messages.querySelector(".dock-empty")?.remove();
    for (const notice of fresh) { this.remember(notice.id); this.messages.append(this.noticeCard(notice)); }
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  get busy(): boolean { return !!this.controller; }

  setOpen(open: boolean, remember = true): void {
    this.element.hidden = !open;
    this.launcher.hidden = open;
    this.host.layout(open);
    if (remember) try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* 只影响本次 */ }
    if (open) { void this.start(); this.pageChanged(); if (remember) this.text.focus(); }
  }

  /** 页面变化：去掉焦点的选择只对当时的页面有效；固定的焦点不变。 */
  pageChanged(): void {
    if (this.mode === "off") this.mode = "auto";
    void this.renderChip();
  }

  dispose(): void { this.disposed = true; this.controller?.abort(); }

  private start(): Promise<void> {
    return this.ready ??= (async () => {
      try {
        const [main, config] = await Promise.all([this.client.assistantMain(newRequestId("main")), this.client.aiConfiguration().catch(() => undefined)]);
        this.conversation = main.conversation;
        this.profile = config ? mainProfile(config) : undefined;
        const detail = await this.client.conversation(main.conversation);
        if (this.disposed) return;
        this.renderHistory(detail.messages);
      } catch (cause) {
        this.ready = undefined;
        clear(this.notice, failure(t("Couldn't open the main conversation: {0}", errorText(cause)), () => void this.start()));
      }
    })();
  }

  private renderHistory(messages: AssistantMessage[]): void {
    const shown = messages.filter(message => (message.role === "user" || message.role === "assistant") && message.content.trim()).slice(-HISTORY);
    clear(this.messages, ...(shown.length ? shown.map(message => message.role === "user" ? this.userBubble(message.content) : this.reply(message.content))
      : [h("p", { class: "dock-empty muted" }, t("Ask about the page you're on, or anything else. The conversation keeps going as you move between pages."))]));
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private userBubble(text: string): HTMLElement {
    const body = h("div", { class: "msg-user markdown" }); body.innerHTML = renderMarkdown(text); return body;
  }
  private reply(text: string): HTMLElement {
    const body = h("div", { class: "markdown" }); body.innerHTML = renderMarkdown(text);
    return h("div", { class: "msg-assistant dock-reply" }, body);
  }

  /** 当前要发送的焦点输入；去掉时不发送。 */
  private focusInput(): FocusInput | undefined {
    if (this.mode === "off") return undefined;
    if (this.mode === "pinned" && this.pinned) return this.pinned;
    return this.host.focus();
  }

  private async title(id: string): Promise<string | undefined> {
    const known = this.titles.get(id);
    if (known) return known;
    try {
      const summary = await this.client.resource(id);
      if (summary.status !== "visible") return undefined;
      this.titles.set(id, summary.title);
      return summary.title;
    } catch { return undefined; }
  }

  private async renderChip(): Promise<void> {
    const input = this.focusInput();
    if (this.mode === "off") {
      clear(this.chip, h("span", { class: "muted" }, t("Not sharing this page")),
        h("button", { type: "button", class: "chip-btn", onclick: () => { this.mode = "auto"; void this.renderChip(); } }, t("Share again")));
      return;
    }
    if (!input?.id && !input?.selection) { clear(this.chip); return; }
    const label = input.label ?? (input.id ? await this.title(input.id) ?? input.id : t("Selected text"));
    if (this.disposed) return;
    const pinned = this.mode === "pinned";
    const target = input.id && EXPLORABLE.test(input.id) ? input.id : undefined;
    const explore = target && (this.exploring.has(target)
      ? h("span", { class: "chip-state" }, icon("clock"), t("Exploring…"))
      : h("button", { type: "button", class: "chip-btn", title: t("Have the assistant look into this in the background and report back"),
        onclick: () => void this.explore(target) }, t("Explore for me")));
    clear(this.chip,
      h("span", { class: "focus-label", title: t("The assistant sees this page with your next message") }, icon(pinned ? "lock" : "file"), label),
      h("button", { type: "button", class: "chip-btn", "aria-pressed": String(pinned), title: pinned ? t("Unpin") : t("Keep this as context while you move around"),
        onclick: () => { if (pinned) { this.mode = "auto"; this.pinned = undefined; } else { this.mode = "pinned"; this.pinned = this.host.focus(); } void this.renderChip(); } },
        pinned ? t("Unpin") : t("Pin")),
      h("button", { type: "button", class: "chip-btn", "aria-label": t("Don't share this page"), title: t("Don't share this page"),
        onclick: () => { this.mode = "off"; this.pinned = undefined; void this.renderChip(); } }, icon("close")),
      explore);
  }

  /** 提前探索（ADR 0059 第 5 节，A1-9）：只读、有预算，结果写成 AI 笔记，完成后在待处理里提醒。 */
  private async explore(target: string): Promise<void> {
    const ref = refOf(target);
    if (!ref) return;
    try {
      await this.client.explorationCommand({ op: "start", request_id: newRequestId("explore"), target: ref });
      this.exploring.add(target);
      toast(t("Exploring in the background. You'll find the result under To look at on Today."));
    } catch (cause) { toast(errorText(cause), "error"); }
    void this.renderChip();
  }

  /** 刷新正在探索的对象（工作台定时调用）。 */
  async refreshExplorations(): Promise<void> {
    try {
      const list = await this.client.explorations({ active: true, limit: 50 });
      const next = new Set(list.explorations.map(value => value.target.id));
      const changed = next.size !== this.exploring.size || [...next].some(id => !this.exploring.has(id));
      this.exploring = next;
      if (changed) void this.renderChip();
    } catch { /* 下次再试 */ }
  }

  private async submit(): Promise<void> {
    const message = this.text.value.trim();
    if (!message || this.controller) return;
    await this.start();
    if (!this.conversation) return;
    const input = this.focusInput();
    const focus = input && buildFocus({ ...input, ...(input.id ? { label: input.label ?? this.titles.get(input.id) } : {}) });
    const request: AssistantChatRequest = { request_id: newRequestId("chat"), conversation: this.conversation, message,
      ...(this.profile ? { profile: this.profile } : {}), ...(focus ? { focus } : {}) };
    this.text.value = ""; this.text.dispatchEvent(new Event("input"));
    clear(this.notice);
    this.messages.querySelector(".dock-empty")?.remove();
    const content = h("div", { class: "markdown stream-text streaming" });
    const extras = h("div", { class: "msg-tools", role: "status" });
    const block = h("div", { class: "msg-assistant dock-reply" }, extras, content);
    this.messages.append(this.userBubble(message), block);
    this.scroller.scrollTop = this.scroller.scrollHeight;
    const controller = this.controller = new AbortController();
    this.setBusy(true);
    let streamed = "", started = false;
    const tools = new Map<string, HTMLElement>();
    try {
      for await (const event of this.client.assistantEvents(request, controller.signal)) {
        if (this.disposed) return;
        started = true;
        if (event.type === "token") { streamed += event.delta; content.innerHTML = renderMarkdown(streamed); }
        else if (event.type === "tool") {
          // 展示动作的效果就在页面上，不再列成工具调用；失败时说一句（ADR 0060 第 2 节）。
          if (WORKBENCH_TOOL_NAMES.has(event.tool.name)) {
            if (event.tool.status === "failed" && !tools.has(event.tool.id)) {
              const note = h("p", { class: "muted dock-tool-note" }, t("Couldn't show that on the page."));
              extras.append(note); tools.set(event.tool.id, note);
            }
            continue;
          }
          const view = toolCallView(event.tool, this.client, this.host.navigate);
          const previous = tools.get(event.tool.id);
          if (previous) previous.replaceWith(view); else extras.append(view);
          tools.set(event.tool.id, view);
        }
        else if (event.type === "topic") void this.topic(event.anchors, block);
        else if (event.type === "notice") { this.remember(event.notice.id); this.messages.append(this.noticeCard(event.notice)); }
        else if (event.type === "ui") this.act(event.action, extras);
        else if (event.type === "result") {
          // 以保存的最终回复为准：模型没有逐字输出（或只在工具调用后才回复）时也能显示出来。
          const final = event.messages.filter(message => message.role === "assistant" && message.content.trim()).map(message => message.content).join("\n\n");
          if (final && final !== streamed) { streamed = final; content.innerHTML = renderMarkdown(final); }
        }
        else if (event.type === "error") clear(this.notice, failure(event.error));
        if (this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 160) this.scroller.scrollTop = this.scroller.scrollHeight;
      }
    } catch (cause) {
      // 没有收到任何事件就失败：Hub 没有开始这一轮，把文字还给人。之后的中断不重发（ADR 0005）。
      if (!started && !controller.signal.aborted) { this.text.value = message; this.text.dispatchEvent(new Event("input")); block.remove(); this.messages.lastElementChild?.remove(); }
      clear(this.notice, h("div", { class: "notice" }, icon("alert"), h("span", {}, controller.signal.aborted
        ? t("Stopped receiving. What was already done is saved in the conversation.") : errorText(cause))));
    } finally {
      content.classList.remove("streaming");
      if (!streamed && !content.childElementCount) content.remove();
      this.controller = undefined; this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    this.send.hidden = busy; this.stop.hidden = !busy; this.text.disabled = false;
  }

  /** 话题切换的分隔线（ADR 0059 第 1 节）；名称没有带标签时补读标题。 */
  private async topic(anchors: readonly ResourceRef[], block: HTMLElement): Promise<void> {
    const line = h("div", { class: "topic-divider", role: "separator" }, h("span", {}, t("Topic: {0}", anchorLabels(anchors).join(t(", ")))));
    block.before(line);
    const titles = new Map<string, string>();
    await Promise.all(anchors.filter(ref => !ref.label).map(async ref => { const title = await this.title(ref.id); if (title) titles.set(ref.id, title); }));
    if (titles.size) clear(line, h("span", {}, t("Topic: {0}", anchorLabels(anchors, titles).join(t(", ")))));
  }

  private noticeCard(notice: Notice): HTMLElement {
    const open = notice.subject && h("button", { type: "button", class: "btn btn-quiet btn-small",
      onclick: () => void openResource(this.client, this.host.navigate, notice.subject!.id) }, t("Open"));
    const summary = notice.summary && h("p", { class: "muted" }, noticePreview(notice.summary, 300));
    return h("article", { class: `dock-notice level-${notice.level}` }, icon("bell"),
      h("div", {}, h("strong", {}, noticeTitle(notice)), summary), open);
  }

  /** 执行一个展示动作。面板在这里画；跳转与高亮交给工作台。 */
  private act(action: WorkbenchAction, where: HTMLElement): void {
    if (action.action === "show") { void this.show(action.panel); return; }
    if (action.action === "clear") { this.closePanel(); return; }
    if (this.host.apply(action) === "deferred" && action.action === "navigate") {
      const [section, id] = navigateRoute(action);
      where.append(h("button", { type: "button", class: "btn btn-small take-me", onclick: (event: Event) => {
        (event.currentTarget as HTMLElement).remove(); this.host.navigate(section as Section, id);
      } }, icon("route"), t("Take me there")));
    }
  }

  private closePanel(): void { clear(this.panel); this.panel.hidden = true; this.host.clearHighlights(); }

  private async show(panel: WorkbenchPanel): Promise<void> {
    const close = h("button", { type: "button", class: "icon-btn", "aria-label": t("Close"), onclick: () => this.closePanel() }, icon("close"));
    const body = h("div", { class: "dock-panel-body" });
    const heading = panel.kind === "dependency_graph" ? t("Dependency graph") : panel.title ?? (panel.kind === "search" ? t("Search results") : t("Related"));
    clear(this.panel, h("div", { class: "dock-panel-head" }, h("strong", {}, heading), close), body);
    this.panel.hidden = false;
    if (panel.kind === "search") {
      clear(body, ...panel.results.map(result => {
        let host = result.url; try { host = new URL(result.url).host; } catch { /* 显示原文 */ }
        return h("a", { class: "panel-card", href: result.url, target: "_blank", rel: "noopener noreferrer" },
          h("strong", {}, result.title), h("span", { class: "muted" }, host), result.snippet && h("span", {}, result.snippet));
      }));
      return;
    }
    if (panel.kind === "refs") {
      const rows = panel.refs.map(ref => {
        const label = h("span", {}, ref.label ?? ref.id);
        void this.title(ref.id).then(title => { if (title) label.textContent = title; });
        return h("button", { type: "button", class: "panel-card", onclick: () => void openResource(this.client, this.host.navigate, ref.id) }, label);
      });
      clear(body, ...rows);
      return;
    }
    clear(body, h("p", { class: "muted" }, t("Loading…")));
    try {
      const all = await this.client.workTasks();
      const tasks = all.filter(task => task.project === panel.project.id);
      const open = tasks.filter(task => task.outcome === "open");
      if (!open.length) { clear(body, h("p", { class: "muted" }, t("No unfinished tasks to draw."))); return; }
      if (open.length > MAX_TASK_NODES) { clear(body, h("p", { class: "muted" }, t("This project has {0} unfinished tasks — too many for a readable graph. Use the list instead.", open.length))); return; }
      const { nodes, edges } = taskGraph(tasks, all, (task: WorkTask) => {
        const group = turnGroup(task);
        return { state: group, sub: group === "blocked" ? t("Waiting on {0}", task.blocked_by!.length) : group === "todo" ? t("Ready to start") : turnText(task) };
      });
      clear(body, dependencyGraph(nodes, edges, id => this.host.navigate("work", id)));
    } catch (cause) { clear(body, failure(errorText(cause))); }
  }
}
