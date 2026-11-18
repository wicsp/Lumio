import type { CalendarComponent, CalendarResource, PersonalCollection, PersonalScope, PersonalStore, PersonalSync } from "@lumio/personal";
import { PersonalDateTime, PersonalEventSchedule, Timestamp } from "@lumio/schema";
import { CaldavError, type CaldavCollection } from "./personal-caldav.ts";

type Property = { name: string; parameters: ReadonlyMap<string, string>; value: string };
const invalid = (): never => { throw new CaldavError("INVALID"); };
const componentName = { event: "VEVENT", todo: "VTODO" } as const;
const knownProperties = new Set([
  "UID", "SUMMARY", "DTSTAMP", "CREATED", "LAST-MODIFIED", "SEQUENCE", "STATUS", "DESCRIPTION", "LOCATION",
  "TRANSP", "CLASS", "PRIORITY", "DTSTART", "DTEND", "DUE", "COMPLETED", "PERCENT-COMPLETE", "X-LUMIO-TZ", "X-LUMIO-WRITE",
]);

function property(line: string): Property {
  const match = /^([a-z\d-]+)((?:;[a-z\d-]+=(?:"[^"]*"|[^:;]+))*):(.*)$/i.exec(line);
  if (!match) return invalid();
  const parameters = new Map<string, string>();
  for (const parameter of match[2]!.matchAll(/;([a-z\d-]+)=(?:"([^"]*)"|([^:;]+))/gi)) {
    const name = parameter[1]!.toUpperCase();
    if (parameters.has(name)) return invalid();
    parameters.set(name, parameter[2] ?? parameter[3]!);
  }
  return { name: match[1]!.toUpperCase(), parameters, value: match[3]! };
}

const unescapeText = (text: string) => text.replace(/\\([\\,;nN])/g, (_, next: string) =>
  next.toLowerCase() === "n" ? "\n" : next);

function date(property: Property, accountZone: string): PersonalDateTime {
  const timezone = property.parameters.get("TZID");
  const type = property.parameters.get("VALUE");
  const allDay = /^(\d{4})(\d{2})(\d{2})$/.exec(property.value);
  if (allDay && (!type || type === "DATE") && !timezone) {
    return PersonalDateTime.parse({ kind: "date", date: `${allDay[1]}-${allDay[2]}-${allDay[3]}` });
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(property.value);
  if (!timed || (type && type !== "DATE-TIME") || (timed[7] && timezone)) return invalid();
  const wall = `${timed[1]}-${timed[2]}-${timed[3]}T${timed[4]}:${timed[5]}:${timed[6]}`;
  const asUtc = Date.parse(Timestamp.parse(`${wall}Z`));
  const zone = timezone ?? (timed[7] ? "UTC" : accountZone);
  const epoch = timed[7] ? asUtc : localInstant(asUtc, zone);
  return PersonalDateTime.parse({ kind: "datetime", at: new Date(epoch).toISOString(), timezone: zone });
}

/** RFC 5545 uses the first occurrence in a fold and the earlier offset in a gap. */
export function localInstant(asUtc: number, zone: string): number {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, timeZoneName: "longOffset",
  });
  const offset = (epoch: number) => {
    const label = clock.formatToParts(epoch).find(part => part.type === "timeZoneName")?.value;
    if (label === "GMT") return 0;
    const parts = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(label ?? "");
    if (!parts) return invalid();
    return (parts[1] === "+" ? 1 : -1) * (Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4] ?? 0)) * 1000;
  };
  const earlier = offset(asUtc - 24 * 3600 * 1000);
  const later = offset(asUtc + 24 * 3600 * 1000);
  const candidates = [...new Set([earlier, later])].map(seconds => asUtc - seconds);
  const valid = candidates.filter(candidate => candidate + offset(candidate) === asUtc);
  return valid.length ? Math.min(...valid) : asUtc - earlier;
}

function normalize(fields: ReadonlyMap<string, Property>, collection: PersonalCollection, zone: string, complex: boolean): CalendarComponent {
  const uid = fields.get("UID")?.value || invalid();
  const recurrence = fields.get("RECURRENCE-ID")?.value;
  const title = unescapeText(fields.get("SUMMARY")?.value ?? "").trim() || (collection.kind === "todo" ? "Untitled to-do" : "Untitled event");
  const read_only = complex || [...fields.keys()].some(key => !knownProperties.has(key)) ||
    [...fields.values()].some(value => ["DTSTART", "DTEND", "DUE"].includes(value.name) &&
      /T\d{6}$/.test(value.value) && !value.parameters.has("TZID"));
  const getDate = (name: string) => {
    const property = fields.get(name);
    return property ? date(property, zone) : undefined;
  };
  const configuredZone = fields.get("X-LUMIO-TZ")?.value;
  if (collection.kind === "todo") {
    const complete = fields.get("STATUS")?.value.toUpperCase() === "COMPLETED";
    const completed = complete ? getDate("COMPLETED") : undefined;
    if (completed?.kind === "date") return invalid();
    const due = getDate("DUE");
    return {
      kind: "todo", uid, recurrence,
      item: { title, due: due?.kind === "datetime" && configuredZone ? PersonalDateTime.parse({ ...due, timezone: configuredZone }) : due,
        status: complete ? "completed" : "open", completed_at: completed?.at, read_only },
    };
  }

  const start = getDate("DTSTART") ?? invalid();
  const end = getDate("DTEND");
  if (start.kind === "date") {
    if (end?.kind === "datetime") return invalid();
    const next = end?.date ?? new Date(Date.parse(`${start.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return {
      kind: "event", uid, recurrence, item: {
        title, read_only, schedule: PersonalEventSchedule.parse({ kind: "all_day", start: start.date, end: next, timezone: configuredZone ?? zone }),
      },
    };
  }
  if (end?.kind !== "datetime") return invalid();
  return {
    kind: "event", uid, recurrence, item: {
      title, read_only,
      schedule: PersonalEventSchedule.parse({ kind: "timed", start: start.at, end: end.at, timezone: configuredZone ?? start.timezone }),
    },
  };
}

export function decodeCalendarResource(resource: { href: string; etag: string; text: string }, collection: PersonalCollection, zone: string): CalendarResource {
  const components: CalendarComponent[] = [];
  const stack: string[] = [];
  let fields: Map<string, Property> | undefined;
  let complex = false;
  let calendarCount = 0;
  try {
    for (const line of resource.text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
      if (!line) continue;
      const part = property(line);
      if (part.name === "BEGIN") {
        const name = part.value.toUpperCase();
        if (!stack.length && (name !== "VCALENDAR" || ++calendarCount !== 1)) return invalid();
        if (stack.length === 1 && name === componentName[collection.kind]) {
          fields = new Map();
          complex = false;
        } else if (fields) complex = true;
        stack.push(name);
      } else if (part.name === "END") {
        if (stack.pop() !== part.value.toUpperCase()) return invalid();
        if (stack.length === 1 && fields) {
          components.push(normalize(fields, collection, zone, complex));
          fields = undefined;
        }
      } else if (stack.length === 2 && fields) {
        if (fields.has(part.name)) {
          if (["UID", "DTSTART", "DTEND", "DUE", "RECURRENCE-ID", "COMPLETED", "STATUS"].includes(part.name)) return invalid();
          complex = true;
        } else fields.set(part.name, part);
      } else if (!stack.length) return invalid();
    }
    if (stack.length || !components.length) return invalid();
  } catch (cause) {
    if (cause instanceof CaldavError) throw cause;
    return invalid();
  }
  return { href: resource.href, etag: resource.etag, components };
}

export async function reconcilePersonalCalendar(
  scope: PersonalScope,
  collection: PersonalCollection,
  timezone: string,
  store: PersonalStore,
  sync: PersonalSync,
  remote: CaldavCollection,
  now: () => string,
  signal?: AbortSignal,
): Promise<void> {
  const expectedToken = store.token(scope, collection);
  const report = await remote.pull(expectedToken, signal);
  const resources = report.resources.map(resource => decodeCalendarResource(resource, collection, timezone));
  sync.apply(scope, collection, { ...report, expectedToken, resources, observedAt: now() });
}
