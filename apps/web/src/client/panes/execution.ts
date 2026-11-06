/**
 * 执行：运行记录（Job）、例行任务（Routine）与设备。
 * 运行列表每 5 秒静默刷新；正在运行的详情状态变化时自动更新。
 * 产物下载前核对大小与 SHA-256；取消要确认，不自动重跑。
 */
import { JOB_STATUSES, type Job, type StoredArtifact, type ExecutionRoutineInfo, type RuntimeInfo, type WorkTask } from "@lumio/schema";
import { errorText, type Client, type HubExtras } from "../api.ts";
import { executionGroups, type ExecutionGroup } from "../execution-groups.ts";
import { attentionCard, attentionFor } from "../attention-card.ts";
import { formatTime, safeFileName, verifyArtifact, routineStatusCommand } from "../commands.ts";
import { clear, empty, failure, h, icon, loading, openDialog, openMenu, placeholder, statusIcon, toast } from "../dom.ts";
import { ago, bytes, jobSubtitle, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import type { Navigate } from "../navigation.ts";
import { editRoutine } from "./routine-editor.ts";
import { t } from "../i18n.ts";

type Mode = "jobs" | "routines" | "devices";
const LIVE = ["queued", "assigned", "running"];
const GROUPS: Array<[string, ExecutionGroup]> = [["Needs attention", "needs"], ["In progress", "live"], ["Finished", "history"]];

export class ExecutionPane {
  private mode: Mode = "jobs";
  private body = h("div", { class: "pane" });
  private split = h("div", { class: "split" });
  private list = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private statusFilter = "";
  private statusButton = h("button", { type: "button", class: "filter-btn" });
  private createButton = h("button", { type: "button", class: "btn btn-primary", hidden: true, onclick: () => this.newRoutine() }, icon("plus"), h("span", { class: "hide-narrow" }, t("New routine")));
  private segments = new Map<Mode, HTMLButtonElement>();
  private listGeneration = 0;
  private detailGeneration = 0;
  private active = true;
  private timer: ReturnType<typeof setInterval>;
  private selected?: string;
  private currentJob?: Job;
  private routines: ExecutionRoutineInfo[] = [];
  private tasks?: WorkTask[];
  private taskTitles: Array<{ id: string; title: string }> = [];
  private runtimeNames = new Map<string, string>();
  private runtimeName = (id: string) => this.runtimeNames.get(id) ?? id;
  private cancellationRequested = new Set<string>();
  private unbindKeys: () => void;

  constructor(private root: HTMLElement, private client: Client, private hub: HubExtras, initialJob: string | undefined, private navigate: Navigate, private changed: () => void = () => {}) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": t("Execution view") });
    for (const [mode, label] of [["jobs", t("Runs")], ["routines", t("Routine")], ["devices", t("Devices")]] as const) {
      const button = h("button", { type: "button", "aria-pressed": String(mode === this.mode), onclick: () => this.switchMode(mode) }, label);
      this.segments.set(mode, button); seg.append(button);
    }
    this.statusButton.addEventListener("click", () => openMenu(this.statusButton,
      [{ value: "", label: t("All statuses"), selected: !this.statusFilter }, ...JOB_STATUSES.map(s => ({ value: s, label: JOB_LABELS[s]!, icon: statusIcon(s), selected: this.statusFilter === s }))],
      value => { this.statusFilter = value; this.renderFilter(); void this.load(); }));
    root.append(h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Execution")), seg, h("span", { class: "bar-spacer" }),
      h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => this.refresh() }, icon("refresh")), this.createButton), this.body);
    this.split.append(h("div", { class: "list-pane" }, h("div", { class: "list-tools" }, this.statusButton), this.list), this.detail);
    this.unbindKeys = listKeys(this.list, id => void (this.mode === "jobs" ? this.openJob(id) : this.openRoutine(id)));
    this.renderFilter();
    this.layout();
    if (initialJob) { this.selected = initialJob; this.split.classList.add("has-detail"); clear(this.detail, loading()); }
    void this.load().then(() => { if (initialJob && this.active && this.selected === initialJob) void this.openJob(initialJob); });
    this.timer = setInterval(() => {
      if (document.visibilityState !== "visible" || this.mode !== "jobs") return;
      void this.load(true);
      if (this.currentJob && LIVE.includes(this.currentJob.status) && this.selected) void this.pollJob(this.selected);
    }, 5000);
  }

  dispose(): void { this.active = false; this.listGeneration++; this.detailGeneration++; clearInterval(this.timer); this.unbindKeys(); }
  intent(name: string): void { if (name === "new-routine") { this.switchMode("routines"); this.newRoutine(); } }
  open(id: string): void { if (this.mode !== "jobs") this.switchMode("jobs"); void this.openJob(id); }

  private newRoutine(): void { void editRoutine(this.root, this.client, () => { toast(t("Routine saved")); void this.load(); }); }

  private switchMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode; this.selected = undefined; this.currentJob = undefined; this.detailGeneration++;
    for (const [key, button] of this.segments) button.setAttribute("aria-pressed", String(key === mode));
    this.createButton.hidden = mode !== "routines";
    this.layout(); clear(this.list); void this.load();
  }

  private layout(): void {
    this.statusButton.hidden = this.mode !== "jobs";
    this.statusButton.parentElement!.hidden = this.mode !== "jobs";
    if (this.mode === "devices") clear(this.body, this.list);
    else { clear(this.body, this.split); this.split.querySelector(".list-pane")!.append(this.list); this.showPlaceholder(); }
    this.list.className = this.mode === "devices" ? "list-scroll cards" : "list-scroll";
  }

  private renderFilter(): void {
    clear(this.statusButton, this.statusFilter ? statusIcon(this.statusFilter) : icon("down"), this.statusFilter ? JOB_LABELS[this.statusFilter]! : t("All statuses"));
    this.statusButton.classList.toggle("is-set", !!this.statusFilter);
  }

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder(this.mode === "jobs" ? "execution" : "repeat", this.mode === "jobs" ? t("Select a run to see its report, logs and files.") : t("Select a routine to see its schedule and last result.")));
  }

  private refresh(): void {
    void this.load();
    if (this.selected && this.mode === "jobs") void this.openJob(this.selected);
    if (this.selected && this.mode === "routines") void this.openRoutine(this.selected);
  }

  private async pollJob(id: string): Promise<void> {
    try {
      const job = await this.client.job(id);
      if (this.active && this.selected === id && this.currentJob && job.status !== this.currentJob.status) void this.openJob(id, true);
    } catch { /* 下次刷新可恢复；短暂失败不清空正在阅读的内容 */ }
  }

  private async load(quiet = false): Promise<void> {
    const generation = ++this.listGeneration;
    if (!quiet && !this.list.childElementCount) clear(this.list, loading());
    try {
      if (this.mode === "jobs") {
        const [jobs, tasks, runtimes, attention] = await Promise.all([
          this.client.jobs(),
          this.client.workTasks().catch(() => undefined),
          this.client.runtimes().catch(() => undefined),
          this.hub.attention().catch(() => undefined)]);
        if (!this.active || generation !== this.listGeneration) return;
        if (tasks) { this.tasks = tasks; this.taskTitles = tasks.map(t => ({ id: t.id, title: t.title })); }
        if (runtimes) this.runtimeNames = new Map(runtimes.map(r => [r.actor, r.registration.name]));
        const sorted = jobs.slice().sort((a, b) => b.spec.created.localeCompare(a.spec.created));
        const groups = executionGroups(sorted, this.tasks, attention, (this.statusFilter || undefined) as Job["status"] | undefined);
        if (!Object.values(groups).some(items => items.length)) { clear(this.list, empty(this.statusFilter ? t("No runs with this status.") : t("No runs yet. Click Delegate on a task and each round shows up here."))); return; }
        clear(this.list, ...GROUPS.map(([label, group]) => {
          const items = groups[group];
          if (!items.length) return null;
          return h("section", { class: "group" }, h("div", { class: "group-head" }, t(label), h("span", { class: "count" }, items.length)),
            h("div", { class: "group-body" }, ...items.map(job => this.jobRow(job))));
        }));
        markSelected(this.list, this.selected);
      } else if (this.mode === "routines") {
        const routines = await this.client.executionRoutines();
        if (!this.active || generation !== this.listGeneration) return;
        this.routines = routines;
        if (!routines.length) { clear(this.list, empty(t("No routines yet. Have an agent repeat something on a schedule — for example, summarize experiment results every Monday."), { label: t("New routine"), run: () => this.newRoutine() })); return; }
        clear(this.list, ...routines.map(info => this.routineRow(info)));
        markSelected(this.list, this.selected);
      } else {
        const runtimes = await this.client.runtimes();
        if (!this.active || generation !== this.listGeneration) return;
        if (!runtimes.length) { clear(this.list, empty(t("No runtimes connected. Run lumio runtime add in a configured terminal to add a device."))); return; }
        clear(this.list, ...runtimes.map(runtime => this.deviceCard(runtime)));
      }
    } catch (cause) {
      if (this.active && generation === this.listGeneration && !quiet) clear(this.list, failure(errorText(cause), () => this.load()));
    }
  }

  private jobRow(job: Job): HTMLElement {
    return h("div", { class: "row", "data-id": job.spec.id, role: "button", tabindex: "0", onclick: () => void this.openJob(job.spec.id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.openJob(job.spec.id); } },
      statusIcon(job.status),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, jobTitle(job, this.taskTitles)), h("span", { class: "row-sub" }, jobSubtitle(job, this.runtimeName))),
      h("span", { class: "row-meta", title: formatTime(job.spec.created) }, ago(job.spec.created)));
  }

  private routineRow(info: ExecutionRoutineInfo): HTMLElement {
    const r = info.routine;
    return h("div", { class: "row", "data-id": r.id, role: "button", tabindex: "0", onclick: () => void this.openRoutine(r.id),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === "Enter") void this.openRoutine(r.id); } },
      statusIcon(r.status === "active" ? "active" : "paused"),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, r.title),
        h("span", { class: "row-sub" }, info.problem ?? (info.next ? t("Next: {0}", formatTime(info.next, r.timezone)) : t("No upcoming run")))),
      h("span", { class: "row-meta" }, h("span", { class: "cron" }, r.schedule)));
  }

  private deviceCard(runtime: RuntimeInfo): HTMLElement {
    const reg = runtime.registration;
    return h("article", { class: "card" },
      h("div", { class: "card-head" }, icon("device"), h("strong", {}, reg.name), h("span", { class: `pill ${runtime.online ? "pill-green" : ""}` }, runtime.online ? t("Online") : t("Offline"))),
      h("p", { class: "muted" }, t("Last seen {0} · up to {1} at a time", ago(runtime.last_seen), reg.max_concurrent)),
      reg.engines.length
        ? h("ul", {}, ...reg.engines.map(engine => h("li", {}, icon("bot"), h("span", {}, engine.name), h("span", { class: "mono" }, `${engine.version}${engine.sandbox === "os" ? "，系统隔离" : ""}`))))
        : h("p", { class: "muted" }, t("No engines registered")),
      reg.tags.length > 0 && h("div", { class: "button-row" }, ...reg.tags.map(tag => h("span", { class: "pill" }, tag))));
  }

  // ───────────── 运行详情 ─────────────

  private async openJob(id: string, quiet = false): Promise<void> {
    const generation = ++this.detailGeneration;
    this.selected = id; markSelected(this.list, id);
    this.split.classList.add("has-detail");
    if (!quiet) clear(this.detail, loading());
    try {
      const job = await this.client.job(id);
      if (!this.active || generation !== this.detailGeneration) return;
      this.currentJob = job;
      const report = h("div", { class: "markdown" });
      report.innerHTML = renderMarkdown(job.result?.report ?? "");
      const artifacts = h("div", {});
      const includePrivate = h("input", { type: "checkbox", name: "private-artifacts" });
      let artifactGeneration = 0;
      const readArtifacts = async () => {
        const request = ++artifactGeneration;
        const privateScope = includePrivate.checked;
        clear(artifacts, loading(t("Looking for files…")));
        try {
          const files = await this.client.jobArtifacts(id, { includePrivate: privateScope });
          if (!this.active || generation !== this.detailGeneration || request !== artifactGeneration || privateScope !== includePrivate.checked) return;
          clear(artifacts, files.length
            ? h("div", { class: "files" }, ...files.map(file => this.artifactRow(file, () => privateScope === includePrivate.checked && generation === this.detailGeneration, privateScope)))
            : h("p", { class: "muted" }, t("No archived files yet. Results and files may arrive separately.")));
        } catch (cause) {
          if (this.active && generation === this.detailGeneration && request === artifactGeneration) clear(artifacts, failure(errorText(cause)));
        }
      };
      includePrivate.addEventListener("change", () => { artifactGeneration++; clear(artifacts); void readArtifacts(); });

      const meta: Array<[string, Node | string]> = [
        [t("Runtime"), this.runtimeName(job.spec.runtime)],
        [t("Engine"), job.spec.run.kind === "agent" ? job.spec.run.engine : t("Command")],
        [t("Working directory"), h("span", { class: "mono" }, job.spec.workdir)],
        [t("Created"), formatTime(job.spec.created)],
        [t("Time limit"), t("{0} min", Math.round(job.spec.timeout_seconds / 60))],
      ];
      if (job.result?.finished) meta.push([t("Finished"), formatTime(job.result.finished)]);
      if (job.result?.exit_code !== undefined) meta.push([t("Exit code"), String(job.result.exit_code)]);
      const live = LIVE.includes(job.status);
      const cancelling = this.cancellationRequested.has(id) && live;
      const task = job.spec.source?.task;
      // 这一轮还在等你（ADR 0030）：直接在这里回答、验收或标为已查看；旧轮次只显示原来的问题。
      const question = h("div", { class: "markdown" });
      question.innerHTML = renderMarkdown(job.result?.question ?? "");
      const attentionSlot = h("div", { class: "attn-slot" },
        job.result?.question ? h("section", { class: "question" }, h("h3", {}, t("Waiting for you")), question) : null);
      if (task && !live) void attentionFor(this.hub, task).then(item => {
        if (!item || item.job !== job.spec.id || !this.active || generation !== this.detailGeneration) return;
        clear(attentionSlot, attentionCard(item, { client: this.client, hub: this.hub, navigate: this.navigate,
          changed: () => { this.changed(); void this.load(true); void this.openJob(job.spec.id, true); } }, "job"));
      }).catch(() => { /* 旧 Hub 或网络问题：保留原来的问题显示 */ });

      clear(this.detail, h("div", { class: "detail" },
        h("div", { class: "detail-crumbs" },
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          task ? h("button", { type: "button", onclick: () => this.navigate("work", task) }, icon("work"), t("View task")) : h("span", {}, job.spec.source?.routine ? t("Routine") : t("Standalone run")),
          h("div", { class: "detail-actions" },
            live && h("button", { type: "button", class: "btn btn-small", disabled: cancelling, onclick: () => this.cancel(job) }, icon("stop"), cancelling ? t("Cancelling…") : t("Cancel run")))),
        h("div", { class: "detail-head" },
          h("h2", { class: "inline-title" }, h("span", { class: "button-row" }, statusIcon(job.status), jobTitle(job, this.taskTitles))),
          h("p", { class: "detail-sub button-row" }, h("span", { class: `pill ${pillFor(job.status)}` }, JOB_LABELS[job.status]), h("span", {}, jobSubtitle(job, this.runtimeName)), h("span", { class: "mono" }, job.spec.id))),
        job.status === "unknown" && h("div", { class: "notice" }, icon("alert"), h("span", {}, t("This run's result can't be confirmed. Check the device and files first; it won't be rerun automatically."))),
        job.result?.error && failure(job.result.error),
        cancelling && h("p", { class: "success", role: "status" }, t("Cancellation requested. Waiting for the device to confirm.")),
        attentionSlot,
        h("dl", { class: "meta-grid" }, ...meta.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
        job.spec.run.kind === "command" && h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Command"))),
          h("pre", { class: "code-block" }, job.spec.run.argv.map(arg => JSON.stringify(arg)).join(" "))),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Report"))),
          job.result?.report ? report : h("p", { class: "muted" }, live ? t("The report appears here when the run finishes.") : t("This run has no report."))),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Files and logs")), h("div", { class: "detail-actions" }, h("label", { class: "check" }, includePrivate, t("Include private files")))), artifacts)));
      void readArtifacts();
    } catch (cause) {
      if (this.active && generation === this.detailGeneration) clear(this.detail, failure(errorText(cause)));
    }
  }

  private artifactRow(file: StoredArtifact, current: () => boolean, includePrivate: boolean): HTMLElement {
    const message = h("span", { role: "status", class: "muted" });
    const label = file.media_type.includes("jsonl") ? t("Run transcript") : file.media_type === "text/plain" ? t("Run log") : safeFileName(file.key);
    const button = h("button", { type: "button", class: "btn btn-small", disabled: file.status !== "ready", onclick: async () => {
      button.disabled = true; message.textContent = t("Downloading and verifying…");
      try {
        const response = await this.client.artifactContent(file.id, { includePrivate });
        const data = await response.arrayBuffer();
        if (!this.active || !current()) return;
        if (!await verifyArtifact(data, file)) throw new Error("FILE_INTEGRITY");
        if (!this.active || !current()) return;
        const url = URL.createObjectURL(new Blob([data], { type: file.media_type }));
        h("a", { href: url, download: safeFileName(file.key) }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.textContent = "";
        toast(t("Verified — download started"));
      } catch (cause) {
        message.textContent = cause instanceof Error && cause.message === "FILE_INTEGRITY" ? t("File verification failed; not saved") : errorText(cause);
      } finally { button.disabled = false; }
    } }, icon("download"), t("Download"));
    return h("div", { class: "file" }, icon("file"),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, label), h("span", { class: "row-sub" }, t("{0}, {1}", file.status === "ready" ? t("Archived") : t("Delivering"), bytes(file.size)))),
      message, button);
  }

  private cancel(job: Job): void {
    const error = h("div", { role: "alert" });
    const button = h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      button.disabled = true;
      try {
        await this.client.cancelJob(job.spec.id);
        this.cancellationRequested.add(job.spec.id);
        dialog.close(); toast(t("Cancellation requested"));
        this.refresh();
      } catch (cause) { clear(error, failure(t("{0} Refresh to check the current state first.", errorText(cause)))); button.disabled = false; }
    } }, t("Cancel run"));
    const dialog = openDialog(t("Cancel this run?"), h("div", { class: "form-stack" }, h("p", {}, t("The device running it will be asked to stop, which may take a moment. Changes it already made won't be undone.")), h("p", { class: "mono muted" }, job.spec.id), error), [button]);
  }

  // ───────────── 例行任务详情 ─────────────

  private async openRoutine(id: string): Promise<void> {
    const generation = ++this.detailGeneration;
    this.selected = id; markSelected(this.list, id);
    this.split.classList.add("has-detail");
    clear(this.detail, loading());
    try {
      const routine = await this.client.executionRoutine(id);
      if (!this.active || generation !== this.detailGeneration) return;
      const info = this.routines.find(r => r.routine.id === id);
      const description = h("div", { class: "markdown" });
      description.innerHTML = renderMarkdown(routine.description || "");
      const toggle = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
        toggle.disabled = true;
        try {
          await this.client.executionCommand(routineStatusCommand(routine, routine.status === "active" ? "paused" : "active"));
          toast(routine.status === "active" ? t("Paused") : t("Enabled"));
          await this.load(); void this.openRoutine(id);
        } catch (cause) { toast(t("{0} Refresh to check.", errorText(cause)), "error"); toggle.disabled = false; }
      } }, icon(routine.status === "active" ? "stop" : "play"), routine.status === "active" ? t("Pause") : t("Enable"));
      clear(this.detail, h("div", { class: "detail" },
        h("div", { class: "detail-crumbs" },
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": t("Back to list"), onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          h("span", {}, t("Routine")),
          h("div", { class: "detail-actions" }, toggle,
            h("button", { type: "button", class: "btn btn-small", onclick: () => void editRoutine(this.root, this.client, () => { toast(t("Routine saved")); void this.load(); void this.openRoutine(id); }, routine) }, icon("edit"), t("Edit")))),
        h("div", { class: "detail-head" }, h("h2", { class: "inline-title" }, routine.title),
          h("p", { class: "detail-sub" }, h("span", { class: `pill ${routine.status === "active" ? "pill-green" : ""}` }, routine.status === "active" ? t("Enabled") : t("Paused")))),
        info?.problem && h("div", { class: "notice" }, icon("alert"), h("span", {}, info.problem)),
        h("dl", { class: "meta-grid" },
          ...([[t("Schedule"), h("span", { class: "cron" }, routine.schedule)], [t("Time zone"), routine.timezone], [t("Target"), routine.assignee],
            [t("Next run"), info?.next ? formatTime(info.next, routine.timezone) : "—"], [t("Context"), routine.context === "previous" ? t("Include a summary of the last result") : t("Run independently each time")],
            [t("Working directory"), routine.workdir ?? "~"]] as Array<[string, Node | string]>).map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("What to do each time"))), routine.description ? description : h("p", { class: "muted" }, t("No description."))),
        info?.last && h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, t("Last run"))),
          h("div", { class: "runs" }, h("button", { type: "button", class: "run", onclick: () => { this.switchMode("jobs"); void this.openJob(info.last!.job); } },
            icon("execution"), h("span", { class: "mono" }, info.last.job), h("span", { class: "row-meta" }, icon("chevron")))))));
    } catch (cause) {
      if (this.active && generation === this.detailGeneration) clear(this.detail, failure(errorText(cause)));
    }
  }
}

function pillFor(status: string): string {
  if (LIVE.includes(status)) return "pill-blue";
  if (status === "done") return "pill-green";
  if (status === "waiting_for_human") return "pill-ochre";
  if (status === "failed" || status === "unknown") return "pill-red";
  return "";
}
