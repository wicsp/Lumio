/**
 * 最近删除（ADR 0038）：回收站里的任务、项目、笔记和对话，按删除时间倒序。
 * 30 天内可以恢复；也可以立即彻底删除（不可撤销，需要再确认）。
 */
import type { TrashItem, TrashKind } from "@lumio/schema";
import { errorText, type Client } from "../api.ts";
import { formatTime, newRequestId } from "../commands.ts";
import { clear, empty, failure, h, icon, loading, openDialog, toast } from "../dom.ts";
import { ago } from "../format.ts";
import type { Navigate } from "../navigation.ts";
import { t, translated } from "../i18n.ts";
import { restoreItem } from "../trash-actions.ts";

const KIND_LABEL: Record<TrashKind, string> = translated({ task: "Task", project: "Project", note: "Note", conversation: "Conversation" });
const KIND_ICON: Record<TrashKind, string> = { task: "work", project: "folder", note: "knowledge", conversation: "assistant" };
const FILTERS: Array<[TrashKind | "", string]> = [["", "All"], ["task", "Tasks"], ["project", "Projects"], ["note", "Notes"], ["conversation", "Chats"]];

export class TrashPane {
  private list = h("div", { class: "trash-list" });
  private kind: TrashKind | "" = "";
  private generation = 0;
  private active = true;

  constructor(root: HTMLElement, private client: Client, private navigate: Navigate, private changed: () => void) {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": t("Filter by type") });
    for (const [kind, label] of FILTERS) {
      seg.append(h("button", { type: "button", "aria-pressed": String(kind === this.kind), onclick: (event: Event) => {
        this.kind = kind; seg.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === event.currentTarget)));
        void this.load();
      } }, t(label)));
    }
    root.append(
      h("header", { class: "bar" }, h("h1", { class: "bar-title" }, t("Recently deleted"), h("span", { class: "bar-meta hide-narrow" }, t("Kept for 30 days"))),
        h("span", { class: "bar-spacer" }),
        h("button", { type: "button", class: "icon-btn", title: t("Refresh"), "aria-label": t("Refresh"), onclick: () => void this.load() }, icon("refresh"))),
      h("div", { class: "trash-scroll" }, h("div", { class: "trash-page" }, h("div", { class: "trash-filters" }, seg), this.list)));
    void this.load();
  }

  dispose(): void { this.active = false; this.generation++; }
  liveRefresh(): void { void this.load(true); }

  private async load(quiet = false): Promise<void> {
    const generation = ++this.generation;
    if (!quiet) clear(this.list, loading());
    try {
      const { items } = await this.client.trash(this.kind ? { kind: this.kind } : {});
      if (!this.active || generation !== this.generation) return;
      const sorted = items.slice().sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
      if (!sorted.length) { clear(this.list, empty(this.kind ? t("Nothing of this type was deleted in the last 30 days.") : t("Nothing deleted in the last 30 days. Deleted tasks, projects, notes and conversations stay here for 30 days."))); return; }
      clear(this.list, ...sorted.map(item => this.row(item)));
    } catch (cause) {
      if (this.active && generation === this.generation && !quiet) clear(this.list, failure(errorText(cause), () => this.load()));
    }
  }

  private row(item: TrashItem): HTMLElement {
    const days = Math.max(0, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86_400_000));
    const extra = item.kind === "project" && item.detached_tasks?.length ? t("{0} tasks moved to No project", item.detached_tasks.length)
      : item.kind === "note" && item.path ? item.path : "";
    const restore = h("button", { type: "button", class: "btn btn-small", onclick: async () => {
      restore.disabled = purge.disabled = true;
      const ok = await restoreItem(this.client, item, undefined, true);
      if (!this.active) return;
      if (ok) { this.changed(); void this.load(true); this.offerOpen(item); }
      else restore.disabled = purge.disabled = false;
    } }, icon("restore"), t("Restore"));
    const purge = h("button", { type: "button", class: "icon-btn", title: t("Delete permanently"), "aria-label": t("Delete {0} permanently", item.title || KIND_LABEL[item.kind]),
      onclick: () => this.confirmPurge(item) }, icon("trash"));
    return h("article", { class: "trash-row" },
      h("span", { class: "trash-kind", title: KIND_LABEL[item.kind] }, icon(KIND_ICON[item.kind])),
      h("div", { class: "trash-main" },
        h("strong", {}, item.title || t("Untitled")),
        h("span", { class: "muted" }, [KIND_LABEL[item.kind], t("deleted {0}", ago(item.deleted_at)), extra].filter(Boolean).join(" · "))),
      h("span", { class: `trash-expiry${days <= 3 ? " is-soon" : ""}`, title: formatTime(item.expires_at) },
        days <= 1 ? t("Deletes within a day") : t("Deletes in {0} days", days)),
      h("div", { class: "trash-actions" }, restore, purge));
  }

  private offerOpen(item: TrashItem): void {
    if (item.kind === "task" || item.kind === "project") toast(t("Restored “{0}”", item.title), "ok", { label: t("Open"), run: () => this.navigate("work", item.id) });
    else if (item.kind === "note") toast(t("Restored “{0}”", item.title), "ok", { label: t("Open"), run: () => this.navigate("knowledge", item.id) });
  }

  private confirmPurge(item: TrashItem): void {
    const error = h("div", { role: "alert" });
    const requestId = newRequestId("purge");
    const button = h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
      button.disabled = true; clear(error);
      try {
        await this.client.purgeTrash(item.id, { request_id: requestId });
        dialog.close(); toast(t("Deleted permanently"));
        if (this.active) void this.load(true);
      } catch (cause) { clear(error, failure(errorText(cause))); button.disabled = false; }
    } }, t("Delete permanently"));
    const note = item.kind === "task" ? t("Its run records are kept.") : item.kind === "note" ? t("The file is removed from the vault's .trash folder.") : "";
    const dialog = openDialog(t("Delete permanently?"), h("div", { class: "form-stack delete-confirm" },
      h("p", { class: "delete-name" }, item.title || t("Untitled")),
      h("p", { class: "delete-consequence" }, icon("alert"), h("span", {}, t("This can't be undone."))),
      note && h("p", { class: "muted" }, note), error), [button]);
  }
}
