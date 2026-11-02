/**
 * 执行：运行记录（Job）、例行任务（Routine）与设备。
 * 运行列表每 5 秒静默刷新；正在运行的详情状态变化时自动更新。
 * 产物下载前核对大小与 SHA-256；取消要确认，不自动重跑。
 */
import { JOB_STATUSES, type Job, type StoredArtifact, type ExecutionRoutineInfo, type RuntimeInfo } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime, safeFileName, verifyArtifact, routineStatusCommand } from "../commands.ts";
import { clear, empty, failure, h, icon, loading, openDialog, openMenu, placeholder, statusIcon, toast } from "../dom.ts";
import { ago, bytes, jobSubtitle, jobTitle } from "../format.ts";
import { JOB_LABELS } from "../labels.ts";
import { listKeys, markSelected } from "../list-keys.ts";
import { renderMarkdown } from "../utils/markdown.ts";
import type { Navigate } from "../navigation.ts";
import { editRoutine } from "./routine-editor.ts";

type Mode = "jobs" | "routines" | "devices";
const LIVE = ["queued", "assigned", "running"];
const GROUPS: Array<[string, string[]]> = [["需要处理", ["waiting_for_human", "failed", "unknown"]], ["进行中", LIVE], ["已结束", ["done", "cancelled"]]];

export class ExecutionPane {
  private mode: Mode = "jobs";
  private body = h("div", { class: "pane" });
  private split = h("div", { class: "split" });
  private list = h("div", { class: "list-scroll" });
  private detail = h("section", { class: "detail-pane", "aria-live": "polite" });
  private statusFilter = "";
  private statusButton = h("button", { type: "button", class: "filter-btn" });
  private createButton = h("button", { type: "button", class: "btn btn-primary", hidden: true, onclick: () => this.newRoutine() }, icon("plus"), h("span", { class: "hide-narrow" }, "新建例行任务"));
  private segments = new Map<Mode, HTMLButtonElement>();
  private listGeneration = 0;
  private detailGeneration = 0;
  private active = true;
  private timer: ReturnType<typeof setInterval>;
  private selected?: string;
  private currentJob?: Job;
  private routines: ExecutionRoutineInfo[] = [];
  private taskTitles: Array<{ id: string; title: string }> = [];
  private runtimeNames = new Map<string, string>();
  private runtimeName = (id: string) => this.runtimeNames.get(id) ?? id;
  private cancellationRequested = new Set<string>();
  private unbindKeys: () => void;

  constructor(private root: HTMLElement, private client: Client, initialJob: string | undefined, private navigate: Navigate) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": "执行视图" });
    for (const [mode, label] of [["jobs", "运行"], ["routines", "例行任务"], ["devices", "设备"]] as const) {
      const button = h("button", { type: "button", "aria-pressed": String(mode === this.mode), onclick: () => this.switchMode(mode) }, label);
      this.segments.set(mode, button); seg.append(button);
    }
    this.statusButton.addEventListener("click", () => openMenu(this.statusButton,
      [{ value: "", label: "全部状态", selected: !this.statusFilter }, ...JOB_STATUSES.map(s => ({ value: s, label: JOB_LABELS[s]!, icon: statusIcon(s), selected: this.statusFilter === s }))],
      value => { this.statusFilter = value; this.renderFilter(); void this.load(); }));
    root.append(h("header", { class: "bar" }, h("h1", { class: "bar-title" }, "执行"), seg, h("span", { class: "bar-spacer" }),
      h("button", { type: "button", class: "icon-btn", title: "刷新", "aria-label": "刷新", onclick: () => this.refresh() }, icon("refresh")), this.createButton), this.body);
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

  private newRoutine(): void { void editRoutine(this.root, this.client, () => { toast("例行任务已保存"); void this.load(); }); }

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
    clear(this.statusButton, this.statusFilter ? statusIcon(this.statusFilter) : icon("down"), this.statusFilter ? JOB_LABELS[this.statusFilter]! : "全部状态");
    this.statusButton.classList.toggle("is-set", !!this.statusFilter);
  }

  private showPlaceholder(): void {
    this.split.classList.remove("has-detail");
    clear(this.detail, placeholder(this.mode === "jobs" ? "execution" : "repeat", this.mode === "jobs" ? "选择一次运行，查看报告、日志与产物。" : "选择一个例行任务，查看计划与上次结果。"));
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
        const [jobs, tasks, runtimes] = await Promise.all([
          this.client.jobs((this.statusFilter || undefined) as Job["status"] | undefined),
          this.client.workTasks().catch(() => this.taskTitles),
          this.client.runtimes().catch(() => undefined)]);
        if (!this.active || generation !== this.listGeneration) return;
        this.taskTitles = tasks.map(t => ({ id: t.id, title: t.title }));
        if (runtimes) this.runtimeNames = new Map(runtimes.map(r => [r.actor, r.registration.name]));
        const sorted = jobs.slice().sort((a, b) => b.spec.created.localeCompare(a.spec.created));
        if (!sorted.length) { clear(this.list, empty(this.statusFilter ? "没有这个状态的运行。" : "还没有运行记录。在任务详情里点「派出」，每一轮都会出现在这里。")); return; }
        clear(this.list, ...GROUPS.map(([label, statuses]) => {
          const items = sorted.filter(j => statuses.includes(j.status));
          if (!items.length) return null;
          return h("section", { class: "group" }, h("div", { class: "group-head" }, label, h("span", { class: "count" }, items.length)),
            h("div", { class: "group-body" }, ...items.map(job => this.jobRow(job))));
        }));
        markSelected(this.list, this.selected);
      } else if (this.mode === "routines") {
        const routines = await this.client.executionRoutines();
        if (!this.active || generation !== this.listGeneration) return;
        this.routines = routines;
        if (!routines.length) { clear(this.list, empty("还没有例行任务。让 agent 按计划重复做一件事，比如每周一整理实验结果。", { label: "新建例行任务", run: () => this.newRoutine() })); return; }
        clear(this.list, ...routines.map(info => this.routineRow(info)));
        markSelected(this.list, this.selected);
      } else {
        const runtimes = await this.client.runtimes();
        if (!this.active || generation !== this.listGeneration) return;
        if (!runtimes.length) { clear(this.list, empty("还没有连接执行器。在已配置的终端运行 lumio runtime add 添加一台设备。")); return; }
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
        h("span", { class: "row-sub" }, info.problem ?? (info.next ? `下次 ${formatTime(info.next, r.timezone)}` : "暂无下一次运行"))),
      h("span", { class: "row-meta" }, h("span", { class: "cron" }, r.schedule)));
  }

  private deviceCard(runtime: RuntimeInfo): HTMLElement {
    const reg = runtime.registration;
    return h("article", { class: "card" },
      h("div", { class: "card-head" }, icon("device"), h("strong", {}, reg.name), h("span", { class: `pill ${runtime.online ? "pill-green" : ""}` }, runtime.online ? "在线" : "离线")),
      h("p", { class: "muted" }, `最近连接 ${ago(runtime.last_seen)}，最多同时运行 ${reg.max_concurrent} 项`),
      reg.engines.length
        ? h("ul", {}, ...reg.engines.map(engine => h("li", {}, icon("bot"), h("span", {}, engine.name), h("span", { class: "mono" }, `${engine.version}${engine.sandbox === "os" ? "，系统隔离" : ""}`))))
        : h("p", { class: "muted" }, "没有登记执行引擎"),
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
        clear(artifacts, loading("正在查找产物…"));
        try {
          const files = await this.client.jobArtifacts(id, { includePrivate: privateScope });
          if (!this.active || generation !== this.detailGeneration || request !== artifactGeneration || privateScope !== includePrivate.checked) return;
          clear(artifacts, files.length
            ? h("div", { class: "files" }, ...files.map(file => this.artifactRow(file, () => privateScope === includePrivate.checked && generation === this.detailGeneration, privateScope)))
            : h("p", { class: "muted" }, "暂无已归档的产物。结果与文件归档可能分别到达。"));
        } catch (cause) {
          if (this.active && generation === this.detailGeneration && request === artifactGeneration) clear(artifacts, failure(errorText(cause)));
        }
      };
      includePrivate.addEventListener("change", () => { artifactGeneration++; clear(artifacts); void readArtifacts(); });

      const meta: Array<[string, Node | string]> = [
        ["执行器", this.runtimeName(job.spec.runtime)],
        ["引擎", job.spec.run.kind === "agent" ? job.spec.run.engine : "命令"],
        ["工作目录", h("span", { class: "mono" }, job.spec.workdir)],
        ["创建", formatTime(job.spec.created)],
        ["最长运行", `${Math.round(job.spec.timeout_seconds / 60)} 分钟`],
      ];
      if (job.result?.finished) meta.push(["结束", formatTime(job.result.finished)]);
      if (job.result?.exit_code !== undefined) meta.push(["退出码", String(job.result.exit_code)]);
      const live = LIVE.includes(job.status);
      const cancelling = this.cancellationRequested.has(id) && live;
      const task = job.spec.source?.task;

      clear(this.detail, h("div", { class: "detail" },
        h("div", { class: "detail-crumbs" },
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "返回列表", onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          task ? h("button", { type: "button", onclick: () => this.navigate("work", task) }, icon("work"), "查看任务") : h("span", {}, job.spec.source?.routine ? "例行任务" : "独立运行"),
          h("div", { class: "detail-actions" },
            live && h("button", { type: "button", class: "btn btn-small", disabled: cancelling, onclick: () => this.cancel(job) }, icon("stop"), cancelling ? "正在取消…" : "取消运行"))),
        h("div", { class: "detail-head" },
          h("h2", { class: "inline-title" }, h("span", { class: "button-row" }, statusIcon(job.status), jobTitle(job, this.taskTitles))),
          h("p", { class: "detail-sub button-row" }, h("span", { class: `pill ${pillFor(job.status)}` }, JOB_LABELS[job.status]), h("span", {}, jobSubtitle(job, this.runtimeName)), h("span", { class: "mono" }, job.spec.id))),
        job.status === "unknown" && h("div", { class: "notice" }, icon("alert"), h("span", {}, "这次运行的结果无法确认。请先核查设备和产物；不会自动重跑。")),
        job.result?.error && failure(job.result.error),
        cancelling && h("p", { class: "success", role: "status" }, "取消请求已提交，正在等待设备确认。"),
        job.result?.question && h("section", { class: "question" }, h("h3", {}, "等你回答"), h("p", {}, job.result.question)),
        h("dl", { class: "meta-grid" }, ...meta.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
        job.spec.run.kind === "command" && h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "命令")),
          h("pre", { class: "code-block" }, job.spec.run.argv.map(arg => JSON.stringify(arg)).join(" "))),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "报告")),
          job.result?.report ? report : h("p", { class: "muted" }, live ? "运行结束后在这里显示报告。" : "这次运行没有报告。")),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "文件与日志"), h("div", { class: "detail-actions" }, h("label", { class: "check" }, includePrivate, "包含私密产物"))), artifacts)));
      void readArtifacts();
    } catch (cause) {
      if (this.active && generation === this.detailGeneration) clear(this.detail, failure(errorText(cause)));
    }
  }

  private artifactRow(file: StoredArtifact, current: () => boolean, includePrivate: boolean): HTMLElement {
    const message = h("span", { role: "status", class: "muted" });
    const label = file.media_type.includes("jsonl") ? "运行过程记录" : file.media_type === "text/plain" ? "运行日志" : safeFileName(file.key);
    const button = h("button", { type: "button", class: "btn btn-small", disabled: file.status !== "ready", onclick: async () => {
      button.disabled = true; message.textContent = "正在下载并校验…";
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
        toast("已校验并开始下载");
      } catch (cause) {
        message.textContent = cause instanceof Error && cause.message === "FILE_INTEGRITY" ? "文件校验未通过，已停止保存" : errorText(cause);
      } finally { button.disabled = false; }
    } }, icon("download"), "下载");
    return h("div", { class: "file" }, icon("file"),
      h("span", { class: "row-main" }, h("span", { class: "row-title" }, label), h("span", { class: "row-sub" }, `${file.status === "ready" ? "已归档" : "交付中"}，${bytes(file.size)}`)),
      message, button);
  }

  private cancel(job: Job): void {
    const error = h("div", { role: "alert" });
    const button = h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      button.disabled = true;
      try {
        await this.client.cancelJob(job.spec.id);
        this.cancellationRequested.add(job.spec.id);
        dialog.close(); toast("已提交取消请求");
        this.refresh();
      } catch (cause) { clear(error, failure(`${errorText(cause)}。请先刷新核对当前状态。`)); button.disabled = false; }
    } }, "取消运行");
    const dialog = openDialog("取消这次运行？", h("div", { class: "form-stack" }, h("p", {}, "取消请求会交给正在执行的设备，停止可能需要片刻。已经产生的修改不会被撤销。"), h("p", { class: "mono muted" }, job.spec.id), error), [button]);
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
          toast(routine.status === "active" ? "已暂停" : "已启用");
          await this.load(); void this.openRoutine(id);
        } catch (cause) { toast(`${errorText(cause)}。请刷新后核对。`, "error"); toggle.disabled = false; }
      } }, icon(routine.status === "active" ? "stop" : "play"), routine.status === "active" ? "暂停" : "启用");
      clear(this.detail, h("div", { class: "detail" },
        h("div", { class: "detail-crumbs" },
          h("button", { type: "button", class: "icon-btn mobile-only", "aria-label": "返回列表", onclick: () => { this.selected = undefined; markSelected(this.list, undefined); this.showPlaceholder(); } }, icon("back")),
          h("span", {}, "例行任务"),
          h("div", { class: "detail-actions" }, toggle,
            h("button", { type: "button", class: "btn btn-small", onclick: () => void editRoutine(this.root, this.client, () => { toast("例行任务已保存"); void this.load(); void this.openRoutine(id); }, routine) }, icon("edit"), "编辑"))),
        h("div", { class: "detail-head" }, h("h2", { class: "inline-title" }, routine.title),
          h("p", { class: "detail-sub" }, h("span", { class: `pill ${routine.status === "active" ? "pill-green" : ""}` }, routine.status === "active" ? "已启用" : "已暂停"))),
        info?.problem && h("div", { class: "notice" }, icon("alert"), h("span", {}, info.problem)),
        h("dl", { class: "meta-grid" },
          ...([["计划", h("span", { class: "cron" }, routine.schedule)], ["时区", routine.timezone], ["执行目标", routine.assignee],
            ["下次运行", info?.next ? formatTime(info.next, routine.timezone) : "—"], ["上下文", routine.context === "previous" ? "带上上次结果摘要" : "每次独立执行"],
            ["工作目录", routine.workdir ?? "~"]] as Array<[string, Node | string]>).map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "每次要做的事")), routine.description ? description : h("p", { class: "muted" }, "没有填写说明。")),
        info?.last && h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", {}, "上次运行")),
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
