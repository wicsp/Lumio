/**
 * 助手对话里的工具调用（ADR 0029）：读了什么显示成一行；改了什么显示成变更卡片，可以撤回。
 * 私密读取有标记。撤回是一次普通修改，带写入后的 revision；之后有人改过就说明冲突，不覆盖。
 */
import type { AssistantToolCall } from "@lumio/schema";
import { capabilityFromTool } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { undoCommand } from "./commands.ts";
import { clear, failure, h, icon } from "./dom.ts";
import { locale, t } from "./i18n.ts";
import { TASK_LABELS } from "./labels.ts";
import type { Navigate } from "./navigation.ts";

const READ_LABEL: Record<string, string> = {
  "knowledge.note.search": "Searched notes",
  "knowledge.note.show": "Read a note",
  "knowledge.note.links": "Checked a note's links",
  "work.task.list": "Looked at tasks",
  "work.task.show": "Opened a task",
  "work.project.list": "Looked at projects",
  "work.project.show": "Opened a project",
  "work.attention.list": "Checked what needs you",
  "execution.job.list": "Looked at runs",
  "execution.job.show": "Opened a run",
  "execution.routine.list": "Looked at routines",
  "approval.proposal.list": "Looked at pending approvals",
};
const WRITE_LABEL: Record<string, string> = {
  "work.task.create": "Created a task",
  "work.task.update": "Changed a task",
  "work.task.comment": "Commented on a task",
  "work.project.create": "Created a project",
  "work.project.update": "Changed a project",
};
const FIELD_LABEL: Record<string, string> = {
  title: "Title", description: "Description", status: "Status", assignee: "Assignee", due: "Due", project: "Project",
  tags: "Tags", dependencies: "Blocked by", parent: "Parent", goal: "Goal", deadline: "Deadline", repo: "Repository",
};

const show = (key: string, value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (key === "status" && typeof value === "string") return TASK_LABELS[value as keyof typeof TASK_LABELS] ?? value;
  if ((key === "due" || key === "deadline") && typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", weekday: "short" }).format(date);
  }
  if (key === "description" && typeof value === "string") return value.length > 60 ? `${value.slice(0, 60)}…` : value;
  return Array.isArray(value) ? value.join(t(", ")) || "—" : String(value);
};

/** 结果里取标题与对象 ID（创建、更新时有）。 */
function resultTarget(call: AssistantToolCall): { id?: string; title?: string } {
  const result = call.result as { kind?: string; task?: { id: string; title: string }; project?: { id: string; title: string }; comment?: { task: string } } | undefined;
  if (result?.task) return result.task;
  if (result?.project) return result.project;
  if (result?.comment) return { id: result.comment.task };
  return { id: call.change?.target };
}

export function toolCallView(call: AssistantToolCall, client: Client, navigate: Navigate): HTMLElement {
  const capability = capabilityFromTool(call.name);
  const name = call.capability ?? capability?.name;
  const failed = call.status === "failed" || call.status === "unknown";
  const running = call.status === "prepared" || call.status === "running";
  const privateTag = call.private_read ? h("span", { class: "tool-private", title: t("This step read private notes") }, icon("lock"), t("Private")) : null;
  const state = running ? h("span", { class: "spinner" }) : failed ? h("span", { class: "tool-failed" }, call.status === "unknown" ? t("Unknown result") : t("Didn't finish")) : null;

  if (!name || capability?.kind !== "write") {
    const query = typeof call.args.query === "string" ? `“${call.args.query}”` : "";
    return h("div", { class: `tool-line${failed ? " is-failed" : ""}` }, icon(capability ? "search" : "terminal"),
      h("span", {}, name && READ_LABEL[name] ? t(READ_LABEL[name]!) : t("Used {0}", call.name), query ? ` ${query}` : ""), privateTag, state,
      call.error ? h("span", { class: "tool-error" }, call.error) : null);
  }

  // 写入：变更卡片
  const target = resultTarget(call);
  const isTask = name.startsWith("work.task.");
  const open = target.id ? h("button", { type: "button", class: "text-btn", onclick: () => navigate("work", target.id) }, isTask ? t("Open task") : t("Open project")) : null;
  const patch = (call.args.patch ?? {}) as Record<string, unknown>;
  const before = call.change?.before ?? {};
  const rows = name.endsWith(".update")
    ? Object.keys(patch).map(key => h("li", {}, h("span", { class: "change-field" }, t(FIELD_LABEL[key] ?? key)),
        h("span", { class: "change-old" }, show(key, before[key])), icon("chevron"), h("span", { class: "change-new" }, show(key, patch[key]))))
    : name === "work.task.comment" && typeof call.args.body === "string" ? [h("li", { class: "change-comment" }, call.args.body.length > 160 ? `${call.args.body.slice(0, 160)}…` : call.args.body)] : [];
  const message = h("div", { role: "status", class: "change-status" });
  const undo = call.change && !call.change.undone && undoCommand(call.change) ? h("button", { type: "button", class: "btn btn-small" }, icon("back"), t("Undo")) : null;
  undo?.addEventListener("click", async () => {
    const request = undoCommand(call.change!);
    if (!request) return;
    undo.disabled = true;
    try {
      await client.workCommand(request);
      undo.remove(); clear(message, h("span", { class: "success" }, t("Undone.")));
    } catch (cause) {
      undo.disabled = false;
      clear(message, failure(isConflict(cause) ? t("Someone changed this since, so it wasn't undone. Open it to check.") : errorText(cause)));
    }
  });
  return h("article", { class: `change-card${failed ? " is-failed" : ""}` },
    h("header", { class: "change-head" }, icon(name.endsWith(".comment") ? "assistant" : name.endsWith(".create") ? "plus" : "edit"),
      h("span", { class: "change-title" }, t(WRITE_LABEL[name] ?? name), target.title ? h("strong", {}, ` ${target.title}`) : null),
      state, h("span", { class: "bar-spacer" }), open),
    rows.length ? h("ul", { class: "change-rows" }, ...rows) : null,
    call.error ? failure(call.error) : null,
    call.change?.undone ? h("p", { class: "change-status muted" }, t("Undone.")) : null,
    undo ? h("div", { class: "change-foot" }, undo, message) : message);
}
