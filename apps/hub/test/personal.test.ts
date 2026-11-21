import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PersonalView, PersonalChatResult, PersonalProposal, PersonalJournalEntry, PersonalCommandResult,
  type AssistantModelRequest, type AssistantModelResponse,
} from "@lumio/schema";
import { CaldavCollection } from "../src/personal-caldav.ts";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import { HubStore } from "../src/store.ts";

const timezone = "Asia/Singapore";
const eventStart = "2026-11-19T18:00:00+08:00";
const eventEnd = "2026-11-19T18:45:00+08:00";
const selectedDays = { start: "2026-11-18", end: "2026-11-20", timezone };

class CalendarFixture {
  private revision = 0;
  readonly items = new Map<string, { value: string; etag: string }>();
  writes = 0;
  loseReadBack = false;
  failSubsequentGets = false;
  forceConditionFailure = false;

  update(path: string, value: string) {
    this.items.set(path, { value, etag: `"${++this.revision}"` });
  }

  remote(kind: "events" | "todos") {
    const root = `https://calendar.example.test/personal/${kind}/`;
    return new CaldavCollection(root, "fixture", "fixture-password", (async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (init?.method === "REPORT") {
        const rows = [...this.items].filter(([path]) => path.startsWith(new URL(root).pathname)).map(([href, { etag }]) =>
          `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
        return new Response(`<d:multistatus xmlns:d="DAV:">${rows.join("")}<d:sync-token>sync-${this.revision}</d:sync-token></d:multistatus>`, { status: 207 });
      }
      const item = this.items.get(path);
      if (init?.method === "GET") {
        if (this.failSubsequentGets) return new Response(null, { status: 503 });
        return item ? new Response(item.value, { headers: { ETag: item.etag } }) : new Response(null, { status: 404 });
      }
      if (init?.method !== "PUT") throw new Error("Unexpected fixture request");
      const headers = new Headers(init.headers);
      if (this.forceConditionFailure || (item ? item.etag !== headers.get("if-match") : headers.get("if-none-match") !== "*")) return new Response(null, { status: 412 });
      this.writes++;
      this.update(path, String(init.body));
      if (this.loseReadBack) {
        this.loseReadBack = false;
        this.failSubsequentGets = true;
      }
      return new Response(null, { status: item ? 204 : 201 });
    }) as typeof fetch);
  }
}

async function setup(run: (context: {
  hub: Awaited<ReturnType<typeof startHub>>;
  calendar: CalendarFixture;
  now: (time: string) => void;
  request: (path: string, body?: unknown, actor?: "owner" | "stranger" | "agent") => Promise<Response>;
}) => Promise<void>, model: (input: AssistantModelRequest) => AssistantModelResponse, enabled = true) {
  const temp = await mkdtemp(join(tmpdir(), "lumio-personal-"));
  try {
    const store = await HubStore.open(temp);
    const owner = store.createActor("owner", "human").id;
    store.createActor("stranger", "human");
    store.createActor("agent", "agent");
    const tokens = {
      owner: store.createToken("owner", "owner"),
      stranger: store.createToken("stranger", "stranger"),
      agent: store.createToken("agent", "agent"),
    };
    store.close();
    let time = new Date("2026-11-18T08:00:00Z");
    const calendar = new CalendarFixture();
    const hub = await startHub({
      ...readConfig({ LUMIO_STATE_DIR: temp }), port: 0,
      personal: enabled ? {
        owner, timezone, connection: "fixture",
        remotes: { event: calendar.remote("events"), todo: calendar.remote("todos") },
      } : undefined,
    }, { now: () => time, log() {}, assistantModel: { complete: async input => model(input) } });
    const request = (path: string, body?: unknown, actor: keyof typeof tokens = "owner") =>
      fetch(`http://127.0.0.1:${hub.server.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${tokens[actor]}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try { await run({ hub, calendar, request, now: value => { time = new Date(value); } }); }
    finally { await hub.stop(); }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const tool = (name: string, args: Record<string, unknown>) => ({ id: name, name, args });
const reply = (content: string): AssistantModelResponse => ({ content, tool_calls: [] });

test("owner chat proposes, explicit approval writes, and Apple transitions append exactly two journal facts", async () => {
  await setup(async ({ hub, calendar, request, now }) => {
    const view = async () => {
      const response = await request("/v2/personal");
      expect(response.headers.get("cache-control")).toBe("no-store");
      return PersonalView.parse(await response.json());
    };
    const personal = hub.modules.personal!;
    await personal.drain();
    expect((await view()).sync_ok).toBe(true);
    expect((await request("/v2/personal", undefined, "agent")).status).toBe(403);
    expect((await request("/v2/personal", undefined, "stranger")).status).toBe(404);

    const input = { request_id: "personal-chat-fixture-a", message: "安排跑步并提醒报销" };
    const suggested = PersonalChatResult.parse(await (await request("/v2/personal/chat", input)).json());
    expect(suggested.proposals).toHaveLength(2);
    expect(calendar.writes).toBe(0);
    expect(PersonalChatResult.parse(await (await request("/v2/personal/chat", input)).json())).toEqual(suggested);
    expect((await request("/v2/personal/chat", { ...input, message: "different" })).status).toBe(409);
    expect(await (await request("/v2/approval/proposals")).text()).not.toContain("跑步");
    expect(await (await request("/v2/work/tasks")).text()).not.toContain("报销");

    for (const proposal of suggested.proposals) {
      const action = { proposal: proposal.id, decision: "approve" };
      expect((await request("/v2/personal/decisions", action, "stranger")).status).toBe(404);
      expect(PersonalProposal.parse(await (await request("/v2/personal/decisions", action)).json()).result?.status).toBe("pending_sync");
      await personal.drain();
      expect(PersonalProposal.parse(await (await request("/v2/personal/decisions", action)).json()).result?.status).toBe("confirmed");
      await personal.drain();
    }
    expect(calendar.writes).toBe(2);
    const initial = await view();
    expect(initial.events[0]).toMatchObject({ title: "跑步", schedule: { timezone, start: "2026-11-19T10:00:00.000Z", end: "2026-11-19T10:45:00.000Z" } });
    expect(initial.todos[0]).toMatchObject({ title: "报销", due: { kind: "date", date: "2026-11-20" }, status: "open" });
    expect(initial.journal).toEqual([]);
    const [href, row] = [...calendar.items].find(([path]) => path.includes("/todos/"))!;
    expect(row.value).toContain("STATUS:NEEDS-ACTION");
    const alarm = ["BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER;RELATED=END:-PT15M", "DESCRIPTION:Fixture reminder", "END:VALARM", ""].join("\r\n");
    const withAlarm = row.value.replace("END:VTODO", alarm + "END:VTODO");
    calendar.update(href, withAlarm);
    personal.tick(true);
    await personal.drain();
    expect((await view()).todos[0]).toMatchObject({ status: "open", read_only: false });
    now("2026-11-18T08:20:00Z");
    calendar.update(href, withAlarm.replace("STATUS:NEEDS-ACTION", "STATUS:COMPLETED\r\nCOMPLETED:20261118T081630Z\r\nPERCENT-COMPLETE:100"));
    personal.tick(true);
    await personal.drain();
    personal.tick(true);
    await personal.drain();
    expect((await view()).journal).toEqual([expect.objectContaining({
      kind: "todo_completed", occurred_at: "2026-11-18T08:16:30.000Z", source: expect.objectContaining({ kind: "caldav" }),
    })]);
    const completion = (await view()).journal[0]!;
    calendar.update(href, withAlarm);
    personal.tick(true);
    await personal.drain();
    expect((await view()).journal[0]).toMatchObject({ kind: "todo_reopened", corrects: completion.id });
    expect((await view()).journal).toHaveLength(2);

    const command = { request_id: "personal-app-complete-fixture", operation: {
      op: "personal.todo.complete", args: { todo: initial.todos[0]!.id, expected_revision: (await view()).todos[0]!.revision },
    } };
    expect(PersonalCommandResult.parse(await (await request("/v2/personal/todo-status", command)).json()).status).toBe("pending_sync");
    await personal.drain();
    expect(PersonalCommandResult.parse(await (await request("/v2/personal/todo-status", command)).json()).status).toBe("confirmed");
    expect((await view()).todos[0]?.status).toBe("completed");
    expect(calendar.items.get(href)?.value).toContain("PERCENT-COMPLETE:100\r\n" + alarm);
  }, input => {
    if (input.messages.at(-1)?.role === "tool") return reply("请批准两项安排。");
    return { content: "", tool_calls: [
      tool("personal_event_create", { title: "跑步", schedule: { kind: "timed", start: eventStart, end: eventEnd, timezone } }),
      tool("personal_todo_create", { title: "报销", due: { kind: "date", date: "2026-11-20" } }),
    ] };
  });
});

test("a lost write response is verified before retry, stale ETags and expired approvals cannot overwrite", async () => {
  await setup(async ({ request, hub, calendar, now }) => {
    const personal = hub.modules.personal!;
    await personal.drain();
    const view = async () => PersonalView.parse(await (await request("/v2/personal")).json());
    const propose = async (id: string, message: string) => PersonalChatResult.parse(await (await request("/v2/personal/chat", {
      request_id: id, message,
    })).json()).proposals[0]!;
    const approve = async (proposal: PersonalProposal) => request("/v2/personal/decisions", { proposal: proposal.id, decision: "approve" });

    const create = await propose("personal-fixture-new-1", "new");
    calendar.loseReadBack = true;
    await approve(create);
    await personal.drain();
    expect((await view()).proposals[0]?.result?.status).toBe("unverified");
    expect(calendar.writes).toBe(1);
    calendar.failSubsequentGets = false;
    personal.tick(true);
    await personal.drain();
    expect((await view()).proposals[0]?.result?.status).toBe("confirmed");
    expect(calendar.writes).toBe(1);
    const todo = (await view()).todos[0]!;

    const edit = await propose("personal-fixture-edit-1", JSON.stringify({ todo: todo.id, expected_revision: todo.revision, title: "Edit" }));
    const [path, item] = [...calendar.items][0]!;
    // Other client changes the representation after the projection used to propose the edit.
    calendar.update(path, item.value.replace("SUMMARY:New", "SUMMARY:External"));
    await approve(edit);
    await personal.drain();
    expect((await view()).proposals.find(item => item.id === edit.id)?.result?.status).toBe("conflict");
    expect(calendar.writes).toBe(1);

    const expired = await propose("personal-fixture-expire-1", "new");
    now("2026-11-20T08:00:00Z");
    expect((await view()).proposals.find(item => item.id === expired.id)?.status).toBe("expired");
    expect((await approve(expired)).status).toBe(409);
    expect(calendar.writes).toBe(1);
  }, input => {
    if (input.messages.at(-1)?.role === "tool") return reply("Pending approval");
    const message = input.messages.at(-1)?.content;
    return { content: "", tool_calls: [message === "new" ? tool("personal_todo_create", { title: "New" }) :
      tool("personal_todo_update", JSON.parse(message!))] };
  });
});

test("journal permission is turn-limited, and owner-authored corrections and retractions are append-only", async () => {
  await setup(async ({ request, hub }) => {
    await hub.modules.personal!.drain();
    const journal = (id: string, operation: unknown) => request("/v2/personal/journal", { request_id: id, operation });
    const occurrence = { kind: "date", date: "2026-11-18" };
    const add = { kind: "entry", occurred: occurrence, content: "Fixture-private-fact" };
    const entry = PersonalJournalEntry.parse(await (await journal("fixture-journal-create-1", add)).json());
    expect(PersonalJournalEntry.parse(await (await journal("fixture-journal-create-1", add)).json())).toEqual(entry);
    const correction = PersonalJournalEntry.parse(await (await journal("fixture-journal-correct-1", {
      kind: "correction", corrects: entry.id, occurred: occurrence, content: "Fixture-corrected",
    })).json());
    const retraction = PersonalJournalEntry.parse(await (await journal("fixture-journal-retract-1", {
      kind: "retraction", retracts: correction.id, content: "Fixture retraction",
    })).json());
    expect(retraction).toMatchObject({ kind: "retraction", retracts: correction.id });
    const chat = (request_id: string, extra: Record<string, unknown> = {}) => request("/v2/personal/chat", { request_id, message: "journal", ...extra });
    expect(PersonalChatResult.parse(await (await chat("fixture-chat-hidden")).json()).reply).not.toContain("Fixture-private-fact");
    expect(PersonalChatResult.parse(await (await chat("fixture-chat-selected", { journal_range: selectedDays })).json()).reply).toContain("Fixture-private-fact");
    expect(PersonalChatResult.parse(await (await chat("fixture-chat-next-1", { previous_request_id: "fixture-chat-selected" })).json()).reply).not.toContain("Fixture-private-fact");
  }, input => {
    const previous = input.messages.at(-1)!;
    if (previous.role === "tool") return reply(previous.content);
    expect(input.messages.every(message => !message.content.includes("Fixture-private-fact"))).toBe(true);
    return { content: "", tool_calls: [tool("personal_journal_list", { range: selectedDays })] };
  });
});

test("Personal stays disabled by default, including for humans and for the generic assistant catalog", async () => {
  await setup(async ({ request, hub }) => {
    expect(hub.modules.personal).toBeUndefined();
    expect((await request("/v2/personal")).status).toBe(404);
    const result = await request("/v2/assistant/chat", { request_id: "fixture-generic-chat-1", message: "show personal" });
    expect(result.status).toBe(200);
  }, input => {
    expect(input.tools.some(spec => spec.name.startsWith("personal_"))).toBe(false);
    return reply("No personal data");
  }, false);
});
