import { CONTRACTS, Citekey, ID_PREFIXES, type Entity } from "@lumio/schema";
import { CoreError } from "./errors.ts";
import type { IdPrefix } from "./ids.ts";

export type EntityType = Entity["type"];
export interface Issue { path: string; message: string }
export interface FillInput {
  type: EntityType;
  frontmatter: Record<string, unknown>;
  fileName: string;
  birthtime: Date;
  mtime: Date;
}
export interface FillContext { now: Date; newId: (prefix: IdPrefix) => string; tz: string }

function timestamp(date: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName!.replace("GMT", "");
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
  } catch (cause) {
    throw new CoreError("INVALID_TIMESTAMP", "无法格式化文件时间或本机时区", { cause });
  }
}

/** Fill absent/null metadata only; leave non-null values for schema validation. */
export function fillMetadata(input: FillInput, ctx: FillContext): { patch: Record<string, unknown>; issues: Issue[] } {
  const { frontmatter: fm, type } = input;
  const patch: Record<string, unknown> = {};
  const missing = (key: string) => !Object.hasOwn(fm, key) || fm[key] === null;
  if (missing("id")) patch.id = ctx.newId(ID_PREFIXES[type]);
  if (missing("type")) patch.type = type;
  if (missing("title")) patch.title = input.fileName;
  if (missing("created")) {
    const birth = input.birthtime.getTime();
    patch.created = timestamp(Number.isFinite(birth) && birth !== 0 ? input.birthtime : input.mtime, ctx.tz);
  }
  if (missing("updated")) patch.updated = timestamp(input.mtime, ctx.tz);
  if (type === "paper" && missing("citekey") && Citekey.safeParse(input.fileName).success) {
    patch.citekey = input.fileName;
  }
  // 需要人拨动的开关写进文件，人才知道能改（ADR 0023）；其他默认值仍只在读取时补上。
  if (type === "task" && missing("status")) patch.status = "todo";
  if (type === "routine" && missing("status")) patch.status = "active";
  const assignee = fm.assignee;
  if (type === "task" && missing("turn") && assignee !== null && typeof assignee === "object" && typeof (assignee as { agent?: unknown }).agent === "string") {
    patch.turn = "human";
  }
  const result = CONTRACTS[type].safeParse({ ...fm, ...patch });
  const issues: Issue[] = result.success ? [] : result.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.path[0] === "citekey" && missing("citekey")
      ? "缺失，且文件名不是合法 citekey" : issue.message,
  }));
  return { patch, issues };
}
