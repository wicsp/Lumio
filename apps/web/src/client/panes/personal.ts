import type { PersonalDateTime, PersonalJournalCommand, PersonalJournalEntry, PersonalProposal, PersonalTodo } from "@lumio/schema";
import type { HubExtras } from "../api.ts";
import { newRequestId } from "../commands.ts";
import { clear, h, icon } from "../dom.ts";
import { locale, t } from "../i18n.ts";

type View = NonNullable<Awaited<ReturnType<NonNullable<HubExtras["personalView"]>>>>;
const date = (value: PersonalDateTime) => value.kind === "date" ? value.date : format(value.at, value.timezone);
const format = (value: string, timeZone: string) => new Intl.DateTimeFormat(locale(), {
  dateStyle: "medium", timeStyle: "short", timeZone,
}).format(new Date(value));
const day = (value: number) => new Date(value).toISOString().slice(0, 10);

export function personalSchedule(value: View["events"][number]["schedule"]) {
  if (value.kind === "timed") return `${format(value.start, value.timezone)} – ${format(value.end, value.timezone)}`;
  const last = day(Date.parse(value.end) - 86_400_000);
  return value.start === last ? value.start : `${value.start} – ${last}`;
}

export class PersonalPane {
  private view?: View;
  private loading = false;
  private editing = false;
  private disposed = false;
  private request?: { fingerprint: string; id: string };
  private lastRequest?: string;
  private journalEditor?: HTMLDialogElement;
  private signature?: string;
  private readonly pendingItems = new Set<string>();
  private readonly history = h("div", { class: "personal-history", role: "log", "aria-live": "polite" });
  private readonly message = h("textarea", { rows: 3, maxlength: 12000, id: "personal-message", required: true });
  private readonly from = h("input", { type: "date", "aria-label": t("First journal date") });
  private readonly to = h("input", { type: "date", "aria-label": t("Last journal date") });
  private readonly send = h("button", { type: "submit", class: "btn btn-primary" }, t("Send"));
  private readonly status = h("p", { role: "status", class: "personal-status muted" }, t("Loading…"));
  private readonly content = h("div");
  private readonly chat = h("form", { class: "personal-chat", onsubmit: event => { event.preventDefault(); void this.submit(); } },
    h("label", { for: "personal-message" }, t("Ask the personal assistant")),
    this.message,
    h("details", {}, h("summary", {}, t("Share journal dates for this message")),
      h("div", { class: "personal-actions" }, this.from, this.to)),
    this.send,
  );

  constructor(private readonly root: HTMLElement, private readonly api: HubExtras) {
    this.root.append(
      h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Personal")), h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.refresh() }, icon("refresh"))),
      h("div", { class: "personal-scroll" }, h("div", { class: "personal-layout" }, this.status, this.history, this.chat, this.content)));
    this.chat.hidden = true;
    void this.refresh();
  }

  dispose() { this.disposed = true; this.journalEditor?.remove(); }
  resume() { void this.refresh(); }
  liveRefresh() { void this.refresh(); }

  private async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    try {
      const view = await this.api.personalView?.();
      if (this.disposed) return;
      this.view = view;
      const signature = JSON.stringify(view ?? null);
      if (signature !== this.signature) this.render();
      this.signature = signature;
    } catch {
      this.signature = undefined;
      if (!this.disposed) this.status.textContent = t("Unable to load personal activity.");
    } finally {
      this.loading = false;
    }
  }

  private render() {
    const view = this.view;
    this.chat.hidden = !view?.model_ready;
    this.status.textContent = !view
      ? t("Personal scheduling is not configured for this account.")
      : !view.sync_ok ? t("Calendar sync is pending or unavailable.")
      : !view.model_ready ? t("Set up a Lumio API profile to use personal chat.") : "";
    if (!view) return clear(this.content);
    const list = (title: string, items: HTMLElement[], action?: HTMLElement) => h("section", { class: "personal-card" },
      h("div", { class: "personal-title" }, h("h2", {}, title), action), items.length ? h("ul", {}, ...items) : h("p", { class: "muted" }, t("Nothing to show.")));
    const amended = new Set(view.journal.flatMap(entry =>
      entry.kind === "correction" ? [entry.corrects] : entry.kind === "retraction" ? [entry.retracts] : []));
    clear(this.content,
      h("div", { class: "personal-columns" },
        list(t("Next seven days"), view.events.map(event =>
          h("li", {}, h("strong", {}, event.title), h("div", { class: "muted" }, personalSchedule(event.schedule))))),
        list(t("Personal to-dos"), view.todos.map(todo => this.todo(todo, view.timezone))),
        list(t("Journal · last seven days"), view.journal.map(entry => this.entry(entry, view.timezone, amended.has(entry.id))),
          h("button", { type: "button", class: "btn btn-small", onclick: () => this.editJournal("entry") }, t("New entry"))),
      ),
      view.proposals.length ? list(t("Personal proposals"), view.proposals.map(proposal => this.proposal(proposal))) : null,
    );
  }

  private todo(todo: PersonalTodo, timezone: string) {
    const completed = todo.status === "completed";
    const click = async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (this.pendingItems.has(todo.id)) return;
      this.pendingItems.add(todo.id);
      const result = await this.perform(button, () => this.api.personalTodoStatus?.({
        request_id: newRequestId(), operation: {
          op: completed ? "personal.todo.reopen" : "personal.todo.complete",
          args: { todo: todo.id, expected_revision: todo.revision },
        },
      }));
      this.pendingItems.delete(todo.id);
      if (result && !this.disposed) this.history.append(h("p", {}, this.outcome(result.status)));
    };
    return h("li", {},
      h("strong", {}, todo.title),
      h("div", { class: "muted" }, [
        completed && (todo.completed_at ? `${t("Completed")} ${format(todo.completed_at, timezone)}` : t("Completed")),
        todo.due && `${t("Due")} ${date(todo.due)}`,
        todo.read_only && t("Read only"),
      ].filter(Boolean).join(" · ")),
      todo.read_only ? null : h("button", { type: "button", class: "btn btn-small", onclick: click }, completed ? t("Reopen") : t("Mark complete")));
  }

  private entry(entry: PersonalJournalEntry, timezone: string, amended: boolean) {
    const when = "occurred" in entry ? date(entry.occurred) :
      format(entry.kind === "todo_completed" ? entry.occurred_at ?? entry.recorded_at : entry.recorded_at, timezone);
    const source = entry.source.kind === "caldav" ? `${when} · CalDAV` : when;
    const action = (kind: "correction" | "retraction", label: string) =>
      h("button", { type: "button", class: "btn btn-small", onclick: () => this.editJournal(kind, entry) }, label);
    const kind = entry.kind === "todo_completed" ? t("Marked complete") : entry.kind === "todo_reopened" ? t("Completion undone") :
      entry.kind === "correction" ? t("Journal correction") : entry.kind === "retraction" ? t("Journal retraction") : "";
    return h("li", {}, h("div", {}, entry.content), h("div", { class: "muted" }, [source, kind, amended ? t("Amended") : ""].filter(Boolean).join(" · ")),
      !amended && entry.kind !== "retraction"
        ? h("div", { class: "personal-actions" }, action("correction", t("Correct")), action("retraction", t("Retract entry"))) : null);
  }

  private editJournal(kind: "entry" | "correction" | "retraction", target?: PersonalJournalEntry) {
    if (!this.view || !this.api.personalJournal || this.journalEditor) return;
    const timezone = this.view.timezone;
    const dateInput = h("input", { type: "date", name: "occurrence", required: kind !== "retraction" });
    const dateFormat = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: timezone });
    dateInput.value = target && "occurred" in target && target.occurred.kind === "date"
      ? target.occurred.date : dateFormat.format(new Date(target && "occurred" in target && target.occurred.kind === "datetime"
        ? target.occurred.at : target?.recorded_at ?? Date.now()));
    const content = h("textarea", { rows: 4, name: "content", required: true, maxlength: 12000 });
    if (kind === "correction") content.value = target!.content;
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, t("Save"));
    const title = kind === "entry" ? t("New entry") : kind === "correction" ? t("Correct") : t("Retract entry");
    const request = { id: newRequestId(), hash: "" };
    const dialog = h("dialog", { class: "dialog dialog-narrow", "aria-label": title });
    dialog.append(h("form", { class: "personal-journal-form", onsubmit: event => {
      event.preventDefault();
      const text = content.value.trim();
      if (!text) return;
      const occurred = { kind: "date" as const, date: dateInput.value };
      const operation: ReturnType<typeof PersonalJournalCommand.parse>["operation"] = kind === "entry"
        ? { kind, content: text, occurred }
        : kind === "correction" ? { kind, corrects: target!.id, content: text, occurred }
        : { kind, retracts: target!.id, content: text };
      const hash = JSON.stringify(operation);
      if (request.hash && request.hash !== hash) request.id = newRequestId();
      request.hash = hash;
      void this.perform(submit, () => this.api.personalJournal?.({ request_id: request.id, operation }))
        .then(result => { if (result) dialog.close(); });
    } }, h("header", { class: "dialog-head" }, h("h2", {}, title)),
      h("div", { class: "dialog-body form-stack" }, target ? h("p", { class: "muted" }, target.content) : null,
        kind !== "retraction" ? h("label", { class: "field" }, t("Date"), dateInput) : null,
        h("label", { class: "field" }, kind === "retraction" ? t("Reason") : t("Journal entry"), content)),
      h("footer", { class: "dialog-foot" },
        h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, t("Cancel")), submit)));
    dialog.addEventListener("close", () => { dialog.remove(); this.journalEditor = undefined; }, { once: true });
    this.journalEditor = dialog;
    this.root.append(dialog);
    dialog.showModal();
  }

  private proposal(proposal: PersonalProposal) {
    const operation = proposal.operation.args.operation;
    const args = operation.args;
    const label = "title" in args ? args.title : "content" in args ? args.content : undefined;
    const resource = operation.op === "personal.event.update" ? operation.args.event :
      operation.op === "personal.todo.update" ? operation.args.todo : undefined;
    const current = resource && [...this.view!.events, ...this.view!.todos].find(item => item.id === resource)?.title;
    const when = "schedule" in args && args.schedule ? personalSchedule(args.schedule) :
      "due" in args && args.due ? date(args.due) : "occurred" in args ? date(args.occurred) : "";
    const kind = operation.op.startsWith("personal.event.") ? t("Calendar event") :
      operation.op.startsWith("personal.todo.") ? t("Personal to-do") : t("Journal entry");
    const state = proposal.result ? this.outcome(proposal.result.status) :
      proposal.status === "rejected" ? t("Rejected") : proposal.status === "expired" ? t("Expired") : t("Pending approval");
    const button = (decision: "approve" | "reject", label: string) => h("button", {
      type: "button", class: decision === "approve" ? "btn btn-small btn-primary" : "btn btn-small",
      onclick: event => {
        if (this.pendingItems.has(proposal.id)) return;
        this.pendingItems.add(proposal.id);
        void this.perform(event.currentTarget as HTMLButtonElement, () => this.api.personalDecide?.({ proposal: proposal.id, decision }))
          .finally(() => this.pendingItems.delete(proposal.id));
      },
    }, label);
    const links = "task" in args || "todo" in args && operation.op.startsWith("personal.event.")
      ? [("task" in args && args.task === null) ? t("Clear work task link") : ("task" in args && args.task) || "",
        ("todo" in args && args.todo === null) ? t("Clear to-do link") : ("todo" in args && args.todo) || ""]
      : [];
    if ("reference" in args && args.reference) links.push(args.reference.id);
    return h("li", {}, h("div", { class: "muted" }, kind), h("strong", {}, label ?? (current || resource) ?? kind),
      when ? h("div", {}, when) : null,
      links.some(Boolean) ? h("div", { class: "muted" }, links.filter(Boolean).join(" · ")) : null,
      "due" in args && args.due === null ? h("div", {}, t("Clear due date")) : null,
      h("div", { class: "muted" }, state),
      proposal.status === "pending" ? h("div", { class: "personal-actions" }, button("approve", t("Approve")), button("reject", t("Reject"))) : null);
  }

  private outcome(status: NonNullable<PersonalProposal["result"]>["status"]) {
    switch (status) {
      case "pending_approval": return t("Pending approval");
      case "pending_sync": return t("Waiting for calendar sync");
      case "confirmed": return t("Confirmed");
      case "unverified": return t("Calendar write unverified");
      case "conflict": return t("Calendar changed. Refresh and try again.");
    }
  }

  private async perform<T>(button: HTMLButtonElement, action: () => Promise<T> | undefined) {
    if (button.disabled || this.disposed) return;
    button.disabled = true;
    try {
      return await action();
    } catch {
      if (!this.disposed) this.history.append(h("p", {}, t("Personal request failed. Please try again.")));
    } finally {
      button.disabled = false;
      await this.refresh();
    }
  }

  private async submit() {
    if (this.editing || !this.view || !this.api.personalChat) return;
    const message = this.message.value.trim();
    if (!message) return;
    const start = this.from.value, last = this.to.value;
    if ((start || last) && !(start && last && start <= last && last < "9999-12-31")) {
      this.history.append(h("p", {}, t("Choose both journal dates in order.")));
      return;
    }
    const journal_range = start && last ? {
      start, end: day(Date.parse(last) + 86_400_000), timezone: this.view.timezone,
    } : undefined;
    const fingerprint = JSON.stringify([message, journal_range]);
    if (this.request?.fingerprint !== fingerprint) this.request = { fingerprint, id: newRequestId() };
    const request = this.request;
    this.editing = true;
    try {
      const result = await this.perform(this.send, () => this.api.personalChat?.({ request_id: request.id, message, journal_range, previous_request_id: this.lastRequest }));
      if (!result || this.disposed) return;
      this.history.append(h("p", {}, message), result.reply ? h("p", {}, result.reply) : "");
      if (this.message.value.trim() === message) this.message.value = "";
      this.from.value = "";
      this.to.value = "";
      this.lastRequest = request.id;
      this.request = undefined;
    } finally {
      this.editing = false;
    }
  }
}
