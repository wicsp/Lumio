import type { Job } from "@lumio/schema";
import { t, locale } from "./i18n.ts";

/** 界面用的时间与数量格式（不影响契约里的 ISO 时间）。 */

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 截止日期的短写：今天 / 明天 / 周五 / 11月8日；过期时 overdue 为 true。 */
export function dueLabel(iso: string | undefined, now = new Date()): { text: string; overdue: boolean; soon: boolean } | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY);
  const text = days === 0 ? t("today") : days === 1 ? t("tomorrow") : days === -1 ? t("yesterday")
    : days > 1 && days < 7 ? new Intl.DateTimeFormat(locale(), { weekday: "short" }).format(date)
    : new Intl.DateTimeFormat(locale(), { month: "numeric", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(date);
  return { text, overdue: days < 0, soon: days >= 0 && days <= 1 };
}

/** 相对时间：刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 11月2日。 */
export function ago(iso: string | undefined, now = new Date()): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = now.getTime() - date.getTime();
  if (diff < 60_000 && diff > -60_000) return t("just now");
  if (diff > 0 && diff < 3_600_000) return t("{0} min ago", Math.floor(diff / 60_000));
  if (diff > 0 && diff < DAY && startOfDay(date) === startOfDay(now)) return t("{0} h ago", Math.floor(diff / 3_600_000));
  if (startOfDay(now) - startOfDay(date) === DAY) return t("Yesterday {0}", new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(date));
  return new Intl.DateTimeFormat(locale(), { month: "numeric", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(date);
}

/** <input type="date"> 的值 ↔ ISO（本地零点，带时区偏移）。 */
export function dateInputValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function isoFromDateInput(value: string): string | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!, 18, 0, 0);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${value}T18:00:00${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export const assigneeLabel = (assignee: string) => assignee === "human" ? t("Me") : assignee;

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

/** 运行的标题：优先用所属任务的标题。 */
export function jobTitle(job: Job, tasks: Array<{ id: string; title: string }> = []): string {
  const task = job.spec.source?.task;
  if (task) return tasks.find(t => t.id === task)?.title ?? t("Task round {0}", job.spec.source!.round);
  if (job.spec.source?.routine) return t("Routine");
  return job.spec.run.kind === "agent" ? t("{0} run", job.spec.run.engine) : job.spec.run.argv.join(" ");
}

/** 「第 2 轮，codex @ server」：轮次与执行目标。 */
export function jobSubtitle(job: Job, runtimeName = (id: string) => id): string {
  const round = job.spec.source?.task ? t("Round {0}, ", job.spec.source.round) : "";
  const target = job.spec.run.kind === "agent" ? `${job.spec.run.engine} @ ${runtimeName(job.spec.runtime)}` : runtimeName(job.spec.runtime);
  return round + target;
}
