import { CoreError } from "@lumio/foundation";

/**
 * 5 段 cron（分 时 日 月 周），按 IANA 时区计算触发时间（ADR 0019 第 6 节、P2-5）。
 *
 * 支持 `*`、数字、`a-b`、`a,b`、`*\/n`、`a-b/n`；周日写 0 或 7。日与周都限定时，满足其一即可（与常见 cron 一致）。
 * 夏令时跳过的本地时间不触发；重复的本地时间只触发一次。
 */
export interface Cron {
  minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number>;
  anyDay: boolean; anyWeekday: boolean;
}

function field(text: string, min: number, max: number): { values: number[]; any: boolean } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CoreError("INVALID_CRON", `cron 字段不合法：${text}`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    const start = match[1] === "*" ? min : Number(match[2]);
    const end = match[1] === "*" ? max : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : start;
    if (step < 1 || start < min || end > max || start > end) throw new CoreError("INVALID_CRON", `cron 字段超出范围：${text}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values: [...values].sort((a, b) => a - b), any: text === "*" };
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CoreError("INVALID_CRON", "schedule 必须是 5 段 cron 表达式，例如 0 9 * * 1");
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const days = field(day, 1, 31), weekdays = field(weekday, 0, 7);
  return {
    minutes: field(minute, 0, 59).values, hours: field(hour, 0, 23).values, days: new Set(days.values),
    months: new Set(field(month, 1, 12).values), weekdays: new Set(weekdays.values.map((d) => d % 7)),
    anyDay: days.any, anyWeekday: weekdays.any,
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    } catch { throw new CoreError("INVALID_CRON", `未知时区：${timeZone}`); }
    formatters.set(timeZone, f);
  }
  return f;
}
export function validTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true; } catch { return false; }
}
/** 某一时刻在时区里的本地时间，表示成"把本地时间当作 UTC"的毫秒数（分钟精度）。 */
function local(ms: number, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
}
/** 本地时间（同上表示）对应的 UTC 时刻；夏令时跳过的时间返回 undefined。 */
function utc(wall: number, timeZone: string): number | undefined {
  let t = wall - (local(wall, timeZone) - wall);
  t = wall - (local(t, timeZone) - t);
  return local(t, timeZone) === wall ? t : undefined;
}

const MINUTE = 60_000, DAY = 86_400_000;
/** 严格晚于 `after` 的下一次触发；8 年内都不会触发（如 2 月 30 日）时返回 undefined。 */
export function nextFire(cron: Cron, timeZone: string, after: Date): Date | undefined {
  const start = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const wallStart = local(start, timeZone);
  const firstDay = Math.floor(wallStart / DAY) * DAY;
  for (let day = firstDay; day < firstDay + 8 * 366 * DAY; day += DAY) {
    const date = new Date(day);
    if (!cron.months.has(date.getUTCMonth() + 1)) continue;
    const dayOk = cron.days.has(date.getUTCDate()), weekdayOk = cron.weekdays.has(date.getUTCDay());
    if (!(cron.anyDay && cron.anyWeekday ? true : cron.anyDay ? weekdayOk : cron.anyWeekday ? dayOk : dayOk || weekdayOk)) continue;
    for (const hour of cron.hours) for (const minute of cron.minutes) {
      const wall = day + hour * 3_600_000 + minute * MINUTE;
      // 早于起点的本地时间不再考虑：夏令时回拨时，重复的那段本地时间只按第一次算。
      if (wall < wallStart) continue;
      const t = utc(wall, timeZone);
      if (t !== undefined && t >= start) return new Date(t);
    }
  }
  return undefined;
}

/**
 * (after, now] 之间的计划触发：返回最近的一次和总次数。执行器离线后恢复时只补跑最近一次，其余记为跳过。
 * 次数超过 `limit` 时停止计数（最近一次仍然准确）。
 */
export function dueFires(cron: Cron, timeZone: string, after: Date, now: Date, limit = 100_000): { latest?: Date; count: number } {
  let latest: Date | undefined, count = 0, cursor = after;
  while (count < limit) {
    const next = nextFire(cron, timeZone, cursor);
    if (!next || next > now) return { ...(latest ? { latest } : {}), count };
    latest = next; count++; cursor = next;
  }
  // 太多次：直接找 now 之前的最后一次。
  let back = new Date(now.getTime() - DAY);
  let last = latest;
  for (let next = nextFire(cron, timeZone, back); next && next <= now; next = nextFire(cron, timeZone, back)) { last = next; back = next; }
  return { ...(last ? { latest: last } : {}), count };
}
