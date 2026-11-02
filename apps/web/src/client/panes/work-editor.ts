/**
 * 任务 / 项目详情。
 * - 属性：点一下就改，立即带 revision 保存；冲突时不覆盖，提示载入最新内容。
 * - 标题、正文、讨论各自独立保存；正文默认显示渲染结果，点击进入编辑。
 * - 派活是单独的明确动作；修改负责人不会派活；运行成功也不会自动完成任务。
 */
import { PROJECT_STATUSES, TASK_STATUSES, type WorkProject, type WorkTask, type WorkTaskDetail, type WorkCommandRequest } from "@lumio/schema";
import { errorText, isConflict, type Client } from "../api.ts";
import { commentCommand, dispatchCommand, engineTargets, formatTime, newRequestId, workPatchCommand } from "../commands.ts";
import { autosize, clear, failure, field, h, icon, openDialog, openMenu, select, statusIcon, toast, type MenuItem } from "../dom.ts";
import { ago, assigneeLabel, dateInputValue, dueLabel, isoFromDateInput } from "../format.ts";
import { PROJECT_LABELS, TASK_LABELS } from "../labels.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import { InlineTitle } from "../inline-title.ts";
import type { Navigate } from "../navigation.ts";

export type EditableWork = WorkTask | WorkProject;
const BARE_AGENTS = ["pi", "codex", "claude-code"];

export interface EditorHooks {
  changed(): void;
  reload(): void;
  back(): void;
  navigate: Navigate;
  openProject(id: string): void;
}

export class WorkEditor {
  private record: EditableWork;
  private title: InlineTitle;
  private note = h("div", { class: "conflict", role: "alert" });
  private props = h("div", { class: "props" });
  private bodyHost = h("div", {});
  private bodyDraft?: HTMLTextAreaElement;
  private commentDraft?: HTMLTextAreaElement;
  private busy = false;
  private active = true;
  private showAdvanced = false;
  private updated = h("p", { class: "detail-sub" });

  constructor(private root: HTMLElement, private client: Client, input: WorkProject | WorkTaskDetail, private projects: WorkProject[], private hooks: EditorHooks) {
    this.record = "task" in input ? input.task : input;
    const isTask = this.record.type === "task";
    this.title = new InlineTitle(this.record.title, title => this.saveTitle(title));
    const rec = this.record;
    this.showAdvanced = rec.type === "task" && !!(rec.workdir || rec.model || rec.timeout_minutes);
    const project = rec.type === "task" && rec.project ? projects.find(p => p.id === rec.project) : undefined;
    const crumbs = h("div", { class: "detail-crumbs" },
      h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "返回列表", onclick: () => hooks.back() }, icon("back")),
      isTask ? (project ? h("button", { type: "button", onclick: () => hooks.openProject(project.id) }, icon("folder"), project.title) : h("span", {}, "独立任务")) : h("span", {}, "项目"),
      h("div", { class: "detail-actions" },
        h("button", { type: "button", class: "icon-btn", title: "复制编号", "aria-label": "复制编号", onclick: () => void navigator.clipboard?.writeText(this.record.id).then(() => toast("已复制编号")) }, icon("link")),
        isTask && h("button", { type: "button", class: "btn btn-primary btn-small", onclick: () => void this.dispatch() }, icon("play"), "派出")));

    const detail = h("div", { class: "detail" }, crumbs, h("div", { class: "detail-head" }, this.title.element, this.updated), this.note, this.props,
      h("div", { class: "divider" }), this.bodyHost);
    root.append(detail);
    this.renderMeta();
    this.renderProps();
    this.renderBody();
    if ("task" in input) {
      detail.append(this.executions(input), this.comments(input));
      if (input.task.dependencies.length || input.task.parent) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, "任务关系")),
        h("p", { class: "muted" }, input.task.parent ? `父任务 ${input.task.parent}` : ""),
        input.task.dependencies.length ? h("p", { class: "muted" }, `需要先完成：${input.task.dependencies.join("、")}`) : null));
      if (input.task.references.length) detail.append(h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h3", {}, "关联资料"), h("span", { class: "count" }, input.task.references.length)),
        h("ul", {}, ...input.task.references.map(ref => h("li", {}, ref.label ?? ref.id)))));
    }
  }

  dispose(): void { this.active = false; }
  get dirty(): boolean {
    return this.title.dirty || (!!this.bodyDraft && this.bodyDraft.value !== this.record.description) || !!this.commentDraft?.value.trim();
  }
  canLeave(): boolean {
    if (this.busy) return false;
    return !this.dirty || confirm("有尚未保存的修改，离开会丢弃这些修改。确定离开吗？");
  }

  private renderMeta(): void { this.updated.textContent = `更新于 ${ago(this.record.updated)}`; this.updated.title = formatTime(this.record.updated); }

  // ───────────── 属性 ─────────────

  private renderProps(): void {
    const r = this.record;
    const rows: Node[] = [];
    const row = (label: string, iconName: string, value: Node) => rows.push(h("div", { class: "prop-label" }, icon(iconName), label), h("div", { class: "prop-value" }, value));
    const labels = r.type === "task" ? TASK_LABELS : PROJECT_LABELS;

    const statusBtn = h("button", { type: "button", class: "prop-btn" }, statusIcon(r.status), h("span", {}, labels[r.status] ?? r.status));
    statusBtn.addEventListener("click", () => openMenu(statusBtn,
      (r.type === "task" ? TASK_STATUSES : PROJECT_STATUSES).map(s => ({ value: s, label: labels[s]!, icon: statusIcon(s), selected: s === r.status })),
      value => void this.patch({ status: value }, statusBtn, `状态已改为「${labels[value]}」`)));
    row("状态", "clock", statusBtn);

    if (r.type === "task") {
      const who = h("button", { type: "button", class: "prop-btn", title: "修改负责人不会自动派活" }, icon(r.assignee === "human" ? "user" : "bot"), h("span", {}, assigneeLabel(r.assignee)));
      who.addEventListener("click", () => void this.pickAssignee(who));
      row("负责人", "user", who);

      const project = this.projects.find(p => p.id === r.project);
      const projectBtn = h("button", { type: "button", class: `prop-btn${project ? "" : " placeholder-value"}` }, icon("folder"), h("span", {}, project?.title ?? "未归属"));
      projectBtn.addEventListener("click", () => openMenu(projectBtn,
        [{ value: "", label: "不归属项目", selected: !r.project }, ...this.projects.map(p => ({ value: p.id, label: p.title, icon: icon("folder"), selected: p.id === r.project }))],
        value => void this.patch({ project: value || null }, projectBtn, "已更新所属项目"), { filter: this.projects.length > 6, placeholder: "查找项目" }));
      row("项目", "folder", projectBtn);
      row("截止", "calendar", this.dateInput("due", r.due));

      if (this.showAdvanced) {
        row("工作目录", "terminal", this.textInput("workdir", r.workdir, "~（执行器主目录）"));
        row("模型", "bot", this.textInput("model", r.model, "使用执行引擎的默认模型"));
        row("最长运行", "clock", this.textInput("timeout_minutes", r.timeout_minutes?.toString(), "120 分钟", "number"));
      } else rows.push(h("button", { type: "button", class: "text-btn advanced-toggle", onclick: () => { this.showAdvanced = true; this.renderProps(); } }, "＋ 执行设置（工作目录、模型、时限）"));
    } else {
      row("目标", "check", this.textInput("goal", r.goal, "这一阶段要达成什么？"));
      row("截止", "calendar", this.dateInput("deadline", r.deadline));
      row("代码仓库", "link", this.textInput("repo", r.repo, "路径或 URL"));
    }
    if (r.tags.length) row("标签", "more", h("span", { class: "button-row" }, ...r.tags.map(tag => h("span", { class: "pill" }, tag))));
    clear(this.props, ...rows);
  }

  private textInput(key: string, value: string | undefined, placeholder: string, type = "text"): HTMLInputElement {
    const input = h("input", { class: "prop-input", name: `prop-${key}`, type, placeholder, autocomplete: "off", ...(type === "number" ? { min: "1", step: "1" } : {}) });
    input.value = value ?? "";
    const commit = () => {
      const raw = input.value.trim();
      const next = !raw ? null : type === "number" ? Number(raw) : raw;
      if (type === "number" && next !== null && (!Number.isInteger(next) || (next as number) < 1)) { toast("请输入正整数分钟数", "error"); input.value = value ?? ""; return; }
      void this.patch({ [key]: next }, input, "已保存");
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { input.value = value ?? ""; input.blur(); }
    });
    return input;
  }

  private dateInput(key: "due" | "deadline", value: string | undefined): HTMLElement {
    const input = h("input", { class: "prop-input", type: "date", name: `prop-${key}` });
    input.value = dateInputValue(value);
    input.addEventListener("change", () => void this.patch({ [key]: isoFromDateInput(input.value) }, input, input.value ? "已设置截止日期" : "已清除截止日期"));
    const due = dueLabel(value);
    return h("span", { class: "button-row" }, input, due?.overdue && this.record.status !== "done" ? h("span", { class: "pill pill-red" }, "已过期") : null);
  }

  private async pickAssignee(anchor: HTMLElement): Promise<void> {
    if (this.record.type !== "task") return;
    const current = this.record.assignee;
    const items: MenuItem[] = [{ value: "human", label: "我", icon: icon("user"), selected: current === "human" }];
    const seen = new Set(["human"]);
    const add = (value: string, hint?: string) => { if (seen.has(value)) return; seen.add(value); items.push({ value, label: value, hint, icon: icon("bot"), selected: current === value }); };
    try {
      for (const target of engineTargets(await this.client.runtimes())) add(target.target, target.online ? undefined : "离线");
    } catch { /* 执行器列表暂不可用时，仍可选择本机 agent */ }
    for (const agent of BARE_AGENTS) add(agent, "Hub 所在设备");
    add(current);
    if (!this.active || !anchor.isConnected) return;
    openMenu(anchor, items, value => void this.patch({ assignee: value }, anchor, value === "human" ? "负责人改为我" : `负责人改为 ${value}（尚未派出）`), { filter: true, placeholder: "查找执行器" });
  }

  private async patch(patch: Record<string, unknown>, control: HTMLElement, done: string): Promise<void> {
    if (this.busy) return;
    const request = workPatchCommand(this.record, patch);
    if (!request) return;
    this.setBusy(true); control.classList.add("prop-saving");
    try {
      await this.commit(request);
      toast(done);
    } catch (cause) {
      this.showFailure(cause);
    } finally {
      control.classList.remove("prop-saving");
      this.setBusy(false);
      if (this.active) this.renderProps();
    }
  }

  private async commit(request: WorkCommandRequest): Promise<void> {
    clear(this.note);
    const result = await this.client.workCommand(request);
    if (result.kind !== "task" && result.kind !== "project") throw new Error("unexpected result");
    this.record = result.kind === "task" ? result.task : result.project;
    this.renderMeta();
    this.hooks.changed();
  }

  private setBusy(value: boolean): void { this.busy = value; this.title.setBusy(value); }

  private showFailure(cause: unknown): void {
    const text = isConflict(cause) ? "这条记录已在别处更新。你的修改没有覆盖它；可以先下载草稿，再载入最新内容。" : `${errorText(cause)}。修改仍保留在页面上；如果是连接中断，请先核对是否已保存。`;
    clear(this.note, failure(text), h("div", { class: "button-row" },
      h("button", { type: "button", class: "btn btn-small", onclick: () => this.exportDraft() }, icon("download"), "下载草稿"),
      h("button", { type: "button", class: "btn btn-small", onclick: () => {
        if (!this.dirty || confirm("载入最新内容会放弃当前未保存修改，确定继续吗？")) {
          if (this.bodyDraft) this.bodyDraft.value = this.record.description;
          if (this.commentDraft) this.commentDraft.value = "";
          this.title.discard();
          this.hooks.reload();
        }
      } }, icon("refresh"), "载入最新内容")));
    this.note.scrollIntoView({ block: "nearest" });
  }

  private exportDraft(): void {
    const r = this.record;
    const fields = r.type === "task" ? `状态：${r.status}\n负责人：${r.assignee}\n项目：${r.project ?? ""}\n工作目录：${r.workdir ?? ""}\n模型：${r.model ?? ""}\n最长时间：${r.timeout_minutes ?? ""}` : `状态：${r.status}\n项目目标：${r.goal ?? ""}`;
    const blob = new Blob([`# ${this.title.value}\n\n${this.bodyDraft?.value ?? r.description}\n\n---\n${fields}\n\n未提交讨论：\n${this.commentDraft?.value ?? ""}`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    h("a", { href: url, download: `lumio-draft-${r.id}.md` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async saveTitle(title: string): Promise<string> {
    this.setBusy(true);
    try {
      const request = workPatchCommand(this.record, { title });
      if (request) await this.commit(request);
      toast("标题已保存");
      return this.record.title;
    } catch (cause) { this.showFailure(cause); throw cause; }
    finally { this.setBusy(false); }
  }

  // ───────────── 正文 ─────────────

  private renderBody(): void {
    if (this.bodyDraft) { this.renderBodyEditor(this.bodyDraft.value); return; }
    const has = this.record.description.trim().length > 0;
    const view = h("div", { class: "body-view markdown", role: "button", tabindex: "0", title: "点击编辑说明" });
    if (has) view.innerHTML = renderMarkdown(this.record.description); // renderMarkdown 已转义全部原文
    else view.append(h("p", { class: "body-empty" }, "添加说明：背景、做法或完成标准…"));
    view.addEventListener("click", event => { if (!(event.target as Element).closest("a")) this.renderBodyEditor(this.record.description); });
    view.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === view) { event.preventDefault(); this.renderBodyEditor(this.record.description); } });
    clear(this.bodyHost, view);
  }

  private renderBodyEditor(value: string): void {
    const area = this.bodyDraft ?? autosize(h("textarea", { name: "edit-description", placeholder: "支持 Markdown", "aria-label": "说明" }));
    area.value = value;
    this.bodyDraft = area;
    const save = h("button", { type: "button", class: "btn btn-primary btn-small", onclick: () => void this.saveBody() }, "保存", h("kbd", {}, "⌘↵"));
    const cancel = h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => {
      if (area.value === this.record.description || confirm("放弃对说明的修改？")) { this.bodyDraft = undefined; this.renderBody(); }
    } }, "取消");
    area.onkeydown = event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void this.saveBody(); }
      if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
    };
    clear(this.bodyHost, h("div", { class: "body-editor" }, area, h("div", { class: "button-row" }, save, cancel, h("span", { class: "field-hint" }, "Markdown · Esc 取消"))));
    area.focus();
  }

  private async saveBody(): Promise<void> {
    if (this.busy || !this.bodyDraft) return;
    const description = this.bodyDraft.value;
    if (description === this.record.description) { this.bodyDraft = undefined; this.renderBody(); return; }
    this.setBusy(true);
    try {
      const request = workPatchCommand(this.record, { description });
      if (request) await this.commit(request);
      this.bodyDraft = undefined;
      this.renderBody();
      toast("说明已保存");
    } catch (cause) { this.showFailure(cause); }
    finally { this.setBusy(false); }
  }

  // ───────────── 执行 ─────────────

  private executions(input: WorkTaskDetail): HTMLElement {
    const runs = input.executions.slice().sort((a, b) => b.round - a.round);
    return h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h3", {}, "执行"), h("span", { class: "count" }, runs.length || ""),
        h("div", { class: "detail-actions" }, h("button", { type: "button", class: "btn btn-small", onclick: () => void this.dispatch() }, icon("play"), runs.length ? "继续下一轮" : "派出"))),
      runs.length
        ? h("div", { class: "runs" }, ...runs.map(run => h("button", { type: "button", class: "run", onclick: () => this.hooks.navigate("execution", run.job) },
            statusIcon(run.applied ? "done" : "running"), h("span", { class: "run-round" }, `第 ${run.round} 轮`),
            h("span", { class: "muted" }, run.applied ? "进展已记录" : "等待结果"),
            h("span", { class: "row-meta" }, h("span", { title: formatTime(run.created) }, ago(run.created)), icon("chevron")))))
        : h("p", { class: "muted" }, "还没有派出过。准备好后点「派出」，选择执行器运行这一轮；运行成功不会自动完成任务。"));
  }

  private async dispatch(): Promise<void> {
    if (this.record.type !== "task" || this.busy) return;
    if (this.dirty) { clear(this.note, failure("请先保存或取消正在编辑的内容，再派出这一轮。")); this.note.scrollIntoView({ block: "nearest" }); return; }
    this.setBusy(true);
    try {
      const targets = engineTargets(await this.client.runtimes());
      if (!this.active || !this.root.isConnected) return;
      const task = this.record;
      const preferred = targets.find(t => t.target === task.assignee)?.target ?? targets.find(t => t.online)?.target ?? "";
      const target = select("dispatch-target", [["", "选择执行器与引擎"], ...targets.map(t => [t.target, t.label] as [string, string])], preferred);
      target.required = true;
      const formId = `dispatch-${newRequestId()}`, error = h("div", { role: "alert" });
      const form = h("form", { id: formId, class: "form-stack" },
        h("p", {}, "将把「", h("strong", {}, task.title), "」当前已保存的内容交给执行器。"),
        field("执行目标", target),
        h("dl", { class: "meta-grid" }, h("div", {}, h("dt", {}, "工作目录"), h("dd", {}, task.workdir ?? "~")), h("div", {}, h("dt", {}, "最长运行"), h("dd", {}, `${task.timeout_minutes ?? 120} 分钟`))),
        !targets.length && h("div", { class: "notice" }, icon("alert"), h("span", {}, "还没有登记执行引擎的设备。先在终端运行 lumio runtime add 连接一台。")),
        error);
      const submit = h("button", { type: "submit", form: formId, class: "btn btn-primary", disabled: !targets.length }, icon("play"), "确认派出");
      const dialog = openDialog("派出新的一轮", form, [submit]);
      let pending = false, requestId = newRequestId(), previousTarget = "";
      form.addEventListener("submit", async event => {
        event.preventDefault();
        if (pending) return;
        if (previousTarget && previousTarget !== target.value) requestId = newRequestId();
        previousTarget = target.value; pending = true; submit.disabled = true;
        try {
          await this.client.workCommand(dispatchCommand(task, target.value, requestId));
          dialog.close();
          toast(`已派给 ${target.value}`);
          if (this.active) { this.hooks.changed(); this.hooks.reload(); }
        } catch (cause) {
          clear(error, failure(`${errorText(cause)}。请先查看执行记录，确认是否已派出。`));
          submit.disabled = false; pending = false;
        }
      });
    } catch (cause) { if (this.active) this.showFailure(cause); }
    finally { this.setBusy(false); }
  }

  // ───────────── 讨论 ─────────────

  private comments(input: WorkTaskDetail): HTMLElement {
    const entry = (comment: { body: string; created: string }) => {
      const body = h("div", { class: "markdown" });
      body.innerHTML = renderMarkdown(comment.body);
      return h("article", { class: "comment" }, h("span", { class: "comment-avatar", "aria-hidden": "true" }, icon("user")),
        h("div", {}, h("p", { class: "comment-meta", title: formatTime(comment.created) }, ago(comment.created)), body));
    };
    const timeline = h("div", { class: "timeline" }, ...input.comments.map(entry));
    const count = h("span", { class: "count" }, input.comments.length || "");
    const text = autosize(h("textarea", { name: "comment", rows: "1", placeholder: "补充想法、反馈，或下一轮要回答的问题…", "aria-label": "讨论" }));
    this.commentDraft = text;
    const error = h("div", { role: "alert" });
    const submit = h("button", { type: "submit", class: "btn btn-primary btn-small" }, "发表");
    const form = h("form", { class: "composer" }, text, h("div", { class: "composer-foot" }, h("span", { class: "hint" }, "⌘↵ 发表 · 支持 Markdown"), submit));
    text.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); form.requestSubmit(); } });
    let requestId = newRequestId(), previous = "";
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (this.busy || !text.value.trim()) return;
      this.setBusy(true); submit.disabled = true; clear(error);
      if (previous && previous !== text.value) requestId = newRequestId();
      previous = text.value;
      try {
        const result = await this.client.workCommand(commentCommand(input.task.id, text.value, requestId));
        if (result.kind !== "comment") throw new Error("unexpected result");
        timeline.append(entry(result.comment));
        count.textContent = String(timeline.childElementCount);
        text.value = ""; text.dispatchEvent(new Event("input"));
        requestId = newRequestId(); previous = "";
      } catch (cause) {
        clear(error, failure(`${errorText(cause)}。输入已保留，请先刷新核对是否已发表。`));
      } finally { this.setBusy(false); submit.disabled = false; }
    });
    return h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "讨论"), count),
      timeline, form, error);
  }
}
