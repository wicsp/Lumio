import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PersonalSync } from "@lumio/personal";
import { PersonalJournalEntry } from "@lumio/schema";
import { SqlitePersonalStore } from "@lumio/storage";
import { CaldavCollection } from "../src/personal-caldav.ts";
import { decodeCalendarResource, reconcilePersonalCalendar } from "../src/personal-ical.ts";

const collection = "https://calendar.example.test/owner/todos/";
const href = "/owner/todos/run.ics";
const item = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:synthetic\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
const property = (path: string, etag: string) =>
  `<x:response><x:href>${path}</x:href><x:propstat><x:prop><x:getetag>${etag}</x:getetag></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response>`;
const status = (path: string, code: number) =>
  `<x:response><x:href>${path}</x:href><x:status>HTTP/1.1 ${code} Status</x:status></x:response>`;
const report = (token: string, ...changes: string[]) =>
  new Response(`<?xml version="1.0"?><x:multistatus xmlns:x="DAV:">${changes.join("")}<x:sync-token>${token}</x:sync-token></x:multistatus>`, { status: 207 });

function setup(...results: Response[]) {
  const calls: { path: string; method: string; body: RequestInit["body"]; headers: Headers; redirect: RequestInit["redirect"] }[] = [];
  const fetcher = (async (input: string | URL | Request, options: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("https://calendar.example.test");
    calls.push({ path: url.pathname, method: options.method ?? "", body: options.body, headers: new Headers(options.headers), redirect: options.redirect });
    return results.shift() ?? new Response(null, { status: 500 });
  }) as typeof fetch;
  const caldav = new CaldavCollection(collection, "fixture", "fixture-password", fetcher);
  return { caldav, calls };
}

test("CalDAV collects every report page before reading changed resources", async () => {
  const { caldav, calls } = setup(
    report("next&amp;one", property(href, '"old"'), status("/owner/todos/", 507)),
    report("final", property(href, '"new"'), status("/owner/todos/removed.ics", 404)),
    new Response(item, { headers: { ETag: '"new"' } }),
  );
  expect(await caldav.pull("previous")).toEqual({
    mode: "incremental", token: "final", resources: [{ href, etag: '"new"', text: item }], deleted: ["/owner/todos/removed.ics"],
  });
  expect(calls.map(call => call.method)).toEqual(["REPORT", "REPORT", "GET"]);
  expect(calls[1]!.body).toContain("<d:sync-token>next&amp;one</d:sync-token>");
  expect(calls[2]!.headers.get("if-match")).toBe('"new"');
  expect(calls.every(call => call.redirect === "error" && call.headers.has("authorization"))).toBe(true);
});

test("an invalid cursor triggers a full sync and changed ETags abort before reconciliation", async () => {
  const expired = new Response('<error xmlns="DAV:"><valid-sync-token/></error>', { status: 403 });
  const { caldav, calls } = setup(expired, report("baseline", property(href, '"1"')), new Response(item, { headers: { ETag: '"1"' } }));
  expect(await caldav.pull("expired")).toMatchObject({ mode: "full", token: "baseline" });
  expect(calls[1]!.body).toContain("<d:sync-token></d:sync-token>");

  const failed = setup(report("advanced", property(href, '"1"')), new Response(item, { headers: { ETag: '"2"' } }));
  await expect(failed.caldav.pull("previous")).rejects.toMatchObject({ code: "CONFLICT" });
});

test("refuses unsolicited DAV resource paths before sending credentials", async () => {
  for (const path of [
    "https://outside.example.test/owner/todos/run.ics",
    "/owner/events/run.ics",
    "/owner/todos/%2e%2e/elsewhere.ics",
    "/owner/todos/%2felsewhere.ics",
  ]) {
    const { caldav, calls } = setup(report("next", property(path, '"1"')));
    await expect(caldav.pull(null)).rejects.toMatchObject({ code: "INVALID" });
    expect(calls).toHaveLength(1);
  }
});

test("truncated XML never becomes a complete empty calendar report", async () => {
  const truncated = new Response('<multistatus xmlns="DAV:"><sync-token>advanced</sync-token>', { status: 207 });
  const { caldav } = setup(truncated);
  await expect(caldav.pull(null)).rejects.toMatchObject({ code: "INVALID" });
});

test("uses conditional writes and distinguishes 412 from an unavailable service", async () => {
  const { caldav, calls } = setup(new Response(null, { status: 201 }), new Response(null, { status: 412 }));
  await caldav.write(href, item, { mode: "create" });
  await expect(caldav.write(href, item, { mode: "update", etag: '"2"' })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(calls[0]!.headers.get("if-none-match")).toBe("*");
  expect(calls[0]!.headers.has("if-match")).toBe(false);
  expect(calls[1]!.headers.get("if-match")).toBe('"2"');
  const failed = setup(new Response(null, { status: 503 }));
  await expect(failed.caldav.write(href, item, { mode: "create" })).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

test("iCalendar reads Apple-compatible local times, exclusive all-day bounds and recurrence IDs", () => {
  const eventCollection = { id: "/owner/events/", kind: "event" } as const;
  const text = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:fixture-meeting", "SUMMARY:Team\\, lunch",
    "DTSTART;TZID=Asia/Singapore:20261118T120000", "DTEND;TZID=Asia/Singapore:20261118T130000",
    "END:VEVENT", "BEGIN:VEVENT", "UID:fixture-trip", "SUMMARY:Trip", "RECURRENCE-ID;VALUE=DATE:20261119",
    "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261122", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  expect(decodeCalendarResource({ href, etag: '"1"', text }, eventCollection, "Asia/Singapore").components).toEqual([
    { kind: "event", uid: "fixture-meeting", recurrence: undefined, item: {
      title: "Team, lunch", read_only: false, schedule: { kind: "timed", start: "2026-11-18T04:00:00.000Z", end: "2026-11-18T05:00:00.000Z", timezone: "Asia/Singapore" },
    } },
    { kind: "event", uid: "fixture-trip", recurrence: "20261119", item: {
      title: "Trip", read_only: true, schedule: { kind: "all_day", start: "2026-11-20", end: "2026-11-22", timezone: "Asia/Singapore" },
    } },
  ]);
});

test("a CalDAV completion reaches the SQLite journal through the entire read path", async () => {
  using db = new Database(":memory:");
  const store = new SqlitePersonalStore(db);
  let next = 0;
  const sync = new PersonalSync(store, prefix => `${prefix}_${String(++next).padStart(26, "0")}`);
  const completed = item.replace("END:VTODO", "SUMMARY:Run\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261118T081630Z\r\nEND:VTODO");
  const { caldav } = setup(
    report("base", property(href, '"1"')), new Response(item, { headers: { ETag: '"1"' } }),
    report("second", property(href, '"2"')), new Response(completed, { headers: { ETag: '"2"' } }),
    report("third", property(href, '"3"')), new Response(item, { headers: { ETag: '"3"' } }),
  );
  const scope = { owner: "fixture-owner", connection: "fixture-connection" };
  const todoCollection = { id: "/owner/todos/", kind: "todo" } as const;
  const run = () => reconcilePersonalCalendar(scope, todoCollection, "Asia/Singapore", store, sync, caldav, () => "2026-11-18T08:18:00Z");
  await run();
  await run();
  await run();
  const journal = store.journal(scope.owner).map(entry => PersonalJournalEntry.parse(entry));
  expect(journal.map(entry => entry.kind)).toEqual(["todo_completed", "todo_reopened"]);
  expect(journal[0]).toMatchObject({ occurred_at: "2026-11-18T08:16:30.000Z", source: { kind: "caldav" } });
  expect(journal[1]).toMatchObject({ corrects: journal[0]!.id });
  expect(store.token(scope, todoCollection)).toBe("third");
});
