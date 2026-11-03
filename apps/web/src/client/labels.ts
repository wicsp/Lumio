import { t, translated } from "./i18n.ts";
export const TASK_LABELS: Record<string,string>= translated({todo:"To do",active:"In progress",waiting:"Waiting",paused:"Paused",done:"Done",cancelled:"Cancelled"});
export const PROJECT_LABELS: Record<string,string>= translated({planning:"Planning",active:"In progress",paused:"Paused",done:"Done"});
export const JOB_LABELS:Record<string,string>= translated({queued:"Queued",assigned:"Accepted by runtime",running:"Running",done:"Done",waiting_for_human:"Needs answer",failed:"Failed",unknown:"Unknown result",cancelled:"Cancelled"});
