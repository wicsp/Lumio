import { createHash } from "node:crypto";
import type { CalendarComponent, PersonalCommandStore, PersonalScope, PersonalSync, PersonalWrite } from "@lumio/personal";
import type { PersonalCommandResult, PersonalDateTime } from "@lumio/schema";
import { CaldavError, type CaldavCollection } from "./personal-caldav.ts";
import { decodeCalendarResource } from "./personal-ical.ts";

type Resource = NonNullable<Awaited<ReturnType<CaldavCollection["read"]>>>;
const utc = (value: string) => new Date(value).toISOString().replace(/[-:]|\.\d{3}/g, "");
const cleanText = (value: string) => value.replaceAll("\\", "\\\\").replaceAll(",", "\\,").replaceAll(";", "\\;").replace(/\r\n?|\n/g, "\\n");
const linesOf = (value: string) => value.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter(Boolean);
const nameOf = (line: string) => line.split(/[;:]/, 1)[0]!.toUpperCase();

function fold(line: string): string {
  const parts: string[] = [];
  let current = "", bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 75) { parts.push(current); current = " "; bytes = 1; }
    current += char;
    bytes += size;
  }
  return [...parts, current].join("\r\n");
}

function fingerprint(scope: PersonalScope, write: PersonalWrite): string {
  return createHash("sha256").update(JSON.stringify([scope, write.command])).digest("hex");
}

function dateLine(name: string, value: PersonalDateTime): string {
  return value.kind === "date" ? `${name};VALUE=DATE:${value.date.replaceAll("-", "")}` : `${name}:${utc(value.at)}`;
}

function edit(write: PersonalWrite, mark: string, original?: Resource): string {
  const target = write.target!;
  const operation = write.command.operation;
  const fields = new Map<string, string | null>([
    ["DTSTAMP", `DTSTAMP:${utc(write.queuedAt)}`],
    ["X-LUMIO-WRITE", `X-LUMIO-WRITE:${mark}`],
  ]);
  if ("title" in operation.args && operation.args.title !== undefined) fields.set("SUMMARY", `SUMMARY:${cleanText(operation.args.title)}`);
  if ("schedule" in operation.args && operation.args.schedule) {
    const { kind, start, end, timezone } = operation.args.schedule;
    const value = (input: string): PersonalDateTime => kind === "all_day" ? { kind: "date", date: input } : { kind: "datetime", at: input, timezone };
    fields.set("DTSTART", dateLine("DTSTART", value(start)));
    fields.set("DTEND", dateLine("DTEND", value(end)));
    fields.set("X-LUMIO-TZ", `X-LUMIO-TZ:${timezone}`);
  }
  if ("due" in operation.args && operation.args.due !== undefined) {
    const due = operation.args.due;
    fields.set("DUE", due ? dateLine("DUE", due) : null);
    fields.set("X-LUMIO-TZ", due?.kind === "datetime" ? `X-LUMIO-TZ:${due.timezone}` : null);
  }
  if (operation.op === "personal.todo.create" || operation.op === "personal.todo.reopen") {
    fields.set("STATUS", "STATUS:NEEDS-ACTION");
    fields.set("COMPLETED", null);
    fields.set("PERCENT-COMPLETE", null);
  }
  if (operation.op === "personal.todo.complete") {
    fields.set("STATUS", "STATUS:COMPLETED");
    fields.set("COMPLETED", `COMPLETED:${utc(write.queuedAt)}`);
    fields.set("PERCENT-COMPLETE", "PERCENT-COMPLETE:100");
  }
  const body = [...fields.values()].filter((line): line is string => line !== null);
  const name = target.collection.kind === "event" ? "VEVENT" : "VTODO";
  let lines: string[];
  if (!original) {
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lumio//Personal//EN", `BEGIN:${name}`,
      `UID:${target.uid}`, ...body, `END:${name}`, "END:VCALENDAR"];
  } else {
    lines = [];
    let inside = false;
    for (const line of linesOf(original.text)) {
      if (line.toUpperCase() === `BEGIN:${name}`) inside = true;
      else if (line.toUpperCase() === `END:${name}`) { lines.push(...body); inside = false; }
      if (!inside || !fields.has(nameOf(line))) lines.push(line);
    }
  }
  return lines.map(fold).join("\r\n") + "\r\n";
}

function reflects(write: PersonalWrite, component: CalendarComponent): boolean {
  const operation = write.command.operation;
  const args = operation.args;
  if (component.uid !== write.target!.uid || component.recurrence || component.item.read_only) return false;
  if ("title" in args && args.title !== undefined && component.item.title !== args.title) return false;
  if (component.kind === "event") {
    if (!("schedule" in args) || !args.schedule) return true;
    const { start, end, kind, timezone } = args.schedule;
    const schedule = component.item.schedule;
    return schedule.kind === kind && schedule.timezone === timezone && (kind === "all_day"
      ? schedule.start === start && schedule.end === end
      : utc(schedule.start) === utc(start) && utc(schedule.end) === utc(end));
  }
  if ("due" in args && args.due !== undefined) {
    const actual = component.item.due;
    const expected = args.due;
    if (expected === null) { if (actual !== undefined) return false; }
    else if (!actual || expected.kind !== actual.kind || dateLine("DUE", expected) !== dateLine("DUE", actual)
      || (expected.kind === "datetime" && actual.kind === "datetime" && expected.timezone !== actual.timezone)) return false;
  }
  if (operation.op === "personal.todo.complete") {
    return component.item.status === "completed" && !!component.item.completed_at && utc(component.item.completed_at) === utc(write.queuedAt);
  }
  if (operation.op === "personal.todo.create" || operation.op === "personal.todo.reopen") return component.item.status === "open";
  return true;
}

/** One serialized worker per account runs this after durable enqueue. */
export class PersonalWriteWorker {
  constructor(private readonly store: PersonalCommandStore, private readonly sync: PersonalSync, private readonly now: () => string) {}

  async flush(scope: PersonalScope, write: PersonalWrite, remote: CaldavCollection, timezone: string, signal?: AbortSignal): Promise<PersonalCommandResult> {
    const target = write.target;
    const request_id = write.command.request_id;
    if (!target || !["pending_sync", "unverified"].includes(write.result.status)) return write.result;
    const href = target.mode === "create" ? `${target.id}.ics` : target.href;
    const mark = fingerprint(scope, write);
    const settle = (result: PersonalCommandResult) => {
      this.store.putWrite(scope, { ...write, result });
      return result;
    };
    const parsed = (resource: Resource) => decodeCalendarResource(resource, target.collection, timezone);
    const confirm = (observed: Resource | undefined) => {
      if (!observed || !linesOf(observed.text).includes(`X-LUMIO-WRITE:${mark}`)) return;
      const value = parsed(observed);
      if (value.components.length !== 1 || !reflects(write, value.components[0]!)) return;
      const args = write.command.operation.args;
      const links = "task" in args || ("todo" in args && write.command.operation.op.startsWith("personal.event."))
        ? { task: "task" in args ? args.task : undefined, todo: "todo" in args ? args.todo : undefined }
        : undefined;
      return this.store.transaction(() => {
        const row = this.sync.observeWrite(scope, target.collection, value, target.id, this.now(), links);
        return settle({ status: "confirmed", request_id, resource: { module: "personal", id: row.id }, revision: row.revision });
      });
    };
    try {
      const current = await remote.read(href, undefined, signal);
      const confirmed = confirm(current);
      if (confirmed) return confirmed;
      if (target.mode === "create" ? !!current : !current || current.etag !== target.etag) {
        return settle({ status: "conflict", request_id });
      }
      if (current) {
        const old = parsed(current).components;
        if (old.length !== 1 || old[0]!.uid !== target.uid || old[0]!.item.read_only) return settle({ status: "conflict", request_id });
      }
      try {
        await remote.write(href, edit(write, mark, current), target, signal);
      } catch (cause) {
        if (!(cause instanceof CaldavError) || cause.code !== "CONFLICT") throw cause;
        return confirm(await remote.read(href, undefined, signal)) ?? settle({ status: "conflict", request_id });
      }
      return confirm(await remote.read(href, undefined, signal)) ?? settle({ status: "unverified", request_id });
    } catch {
      return settle({ status: "unverified", request_id });
    }
  }
}
