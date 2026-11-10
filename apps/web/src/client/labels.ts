import { t, translated } from "./i18n.ts";
export const TASK_LABELS: Record<string,string>= translated({todo:"To do",active:"In progress",waiting:"Waiting",paused:"Paused",done:"Done",cancelled:"Cancelled"});
export const PROJECT_LABELS: Record<string,string>= translated({planning:"Planning",active:"In progress",paused:"Paused",done:"Done"});
export const JOB_LABELS:Record<string,string>= translated({queued:"Queued",assigned:"Accepted by runtime",running:"Running",done:"Done",waiting_for_human:"Needs answer",failed:"Failed",unknown:"Unknown result",cancelled:"Cancelled"});
const EFFORTS: Record<string,string> = translated({minimal:"Minimal",low:"Low",medium:"Medium",high:"High",xhigh:"Extra high",max:"Max"});
/** Thinking-effort option text; values the UI doesn't know yet are shown as sent. */
export function effortLabel(value: string): string { return value === "none" ? t("Thinking off") : t("Effort · {0}", EFFORTS[value] ?? value); }
