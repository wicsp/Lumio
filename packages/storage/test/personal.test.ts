import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type CalendarResource, type CalendarSync, PersonalCommands, PersonalError, PersonalSync } from "@lumio/personal";
import { PersonalCommand, PersonalJournalEntry, PersonalTodo } from "@lumio/schema";
import { SqlitePersonalStore } from "../src/personal.ts";

const scope = { owner: "synthetic-owner", connection: "synthetic-account" };
const todos = { id: "/fixture/todos/", kind: "todo" } as const;
const events = { id: "/fixture/events/", kind: "event" } as const;
const completedAt = "2026-11-18T08:16:30Z";
const observedAt = "2026-11-18T08:17:00Z";
const href = "/fixture/todos/run.ics";

function fixture(db: Database) {
  let sequence = 0;
  const store = new SqlitePersonalStore(db);
  const id = (prefix: string) => `${prefix}_${String(++sequence).padStart(26, "0")}`;
  const sync = new PersonalSync(store, id);
  const commands = new PersonalCommands(store, id, () => observedAt);
  return { store, sync, commands };
}

function todo(status: "open" | "completed", options: {
  href?: string; etag?: string; uid?: string; recurrence?: string; completedAt?: string;
} = {}): CalendarResource {
  return {
    href: options.href ?? href,
    etag: options.etag ?? '"1"',
    components: [{
      kind: "todo", uid: options.uid ?? "synthetic-run", recurrence: options.recurrence,
      item: { title: "Run", status, completed_at: options.completedAt, read_only: false },
    }],
  };
}

function batch(expectedToken: string | null, token: string, resources: readonly CalendarResource[], deleted: readonly string[] = []): CalendarSync {
  return { mode: expectedToken === null ? "full" : "incremental", expectedToken, token, resources, deleted, observedAt };
}

test("a completion is recorded exactly once with its actual time and reopens link to it", () => {
  using db = new Database(":memory:");
  const { store, sync } = fixture(db);
  sync.apply(scope, todos, batch(null, "baseline", [todo("open")]));
  const projection = store.projections(scope, todos)[0]!;
  const completed = todo("completed", { etag: '"2"', completedAt });
  sync.apply(scope, todos, batch("baseline", "completed", [completed]));
  sync.apply(scope, todos, batch("completed", "repeat", [completed]));
  expect(PersonalTodo.parse(store.projections(scope, todos)[0]!.value)).toMatchObject({
    id: projection.id, revision: 2, status: "completed", completed_at: completedAt,
  });
  const journal = store.journal(scope.owner);
  expect(journal).toHaveLength(1);
  const first = PersonalJournalEntry.parse(journal[0]);
  expect(first).toMatchObject({
    kind: "todo_completed", content: "Run", occurred_at: completedAt,
    source: { kind: "caldav", observed_at: observedAt, todo: projection.id },
  });
  sync.apply(scope, todos, batch("repeat", "reopened", [todo("open", { etag: '"3"' })]));
  expect(store.journal(scope.owner)).toHaveLength(2);
  expect(store.journal(scope.owner)[1]).toMatchObject({ kind: "todo_reopened", corrects: first.id });
  expect(store.journal("another-owner")).toEqual([]);
  expect(store.projections({ ...scope, owner: "another-owner" }, todos)).toEqual([]);
});

test("baseline completions, deletions and recurring to-dos do not invent journal facts", () => {
  using db = new Database(":memory:");
  const { store, sync } = fixture(db);
  const occurrence = { uid: "recurring", recurrence: "20261119T071000Z", href: "/fixture/todos/repeat.ics" };
  sync.apply(scope, todos, batch(null, "baseline", [
    todo("completed", { completedAt }), todo("open", occurrence),
  ]));
  sync.apply(scope, todos, batch("baseline", "updated", [todo("completed", { ...occurrence, etag: '"2"' })], [href]));
  expect(store.journal(scope.owner)).toEqual([]);
  const all = store.projections(scope, todos);
  expect(all.find(item => item.uid === "synthetic-run")?.value).toBeUndefined();
  expect(all.find(item => item.uid === occurrence.uid)?.value?.read_only).toBe(true);
});

test("moves, full rescans and restoration preserve the mapped ID and keep accounts separate", () => {
  using db = new Database(":memory:");
  const { store, sync } = fixture(db);
  sync.apply(scope, todos, batch(null, "baseline", [todo("open")]));
  const original = store.projections(scope, todos)[0]!;
  const moved = "/fixture/todos/renamed.ics";
  sync.apply(scope, todos, batch("baseline", "moved", [todo("open", { href: moved })], [href]));
  expect(store.projections(scope, todos)[0]).toMatchObject({ id: original.id, href: moved, revision: 2 });
  sync.apply(scope, todos, { ...batch("moved", "rescan", []), mode: "full" });
  expect(store.projections(scope, todos)[0]).toMatchObject({ id: original.id, revision: 3, value: undefined });
  const reopenedStore = new SqlitePersonalStore(db);
  expect(reopenedStore.token(scope, todos)).toBe("rescan");
  sync.apply(scope, todos, batch("rescan", "restored", [todo("open", { href: moved })]));
  expect(reopenedStore.projections(scope, todos)[0]).toMatchObject({ id: original.id, revision: 4 });
  const other = { ...scope, connection: "another-account" };
  sync.apply(other, todos, batch(null, "another-baseline", [todo("open")]));
  expect(reopenedStore.projections(other, todos)[0]!.id).not.toBe(original.id);
});

test("a stale token or malformed component cannot partially advance projections or journal", () => {
  using db = new Database(":memory:");
  const { store, sync } = fixture(db);
  sync.apply(scope, todos, batch(null, "baseline", [todo("open")]));
  expect(() => sync.apply(scope, todos, batch("stale", "bad", []))).toThrow(PersonalError);
  const invalid = todo("open", { uid: "invalid", href: "/fixture/todos/invalid.ics", completedAt });
  expect(() => sync.apply(scope, todos, batch("baseline", "broken", [
    todo("completed", { completedAt, etag: '"2"' }), invalid,
  ]))).toThrow();
  expect(store.token(scope, todos)).toBe("baseline");
  expect(store.projections(scope, todos)).toHaveLength(1);
  expect(store.projections(scope, todos)[0]!.value).toMatchObject({ revision: 1, status: "open" });
  expect(store.journal(scope.owner)).toEqual([]);
  expect(store.token(scope, events)).toBeNull();
});

test("a resource retains distinct recurring event instances and tracks exceptions removed by Apple", () => {
  using db = new Database(":memory:");
  const { store, sync } = fixture(db);
  const master: CalendarResource = {
    href: "/fixture/events/meet.ics", etag: '"1"',
    components: [{
      kind: "event", uid: "synthetic-meet",
      item: { title: "Meet", read_only: true, schedule: { kind: "all_day", start: "2026-11-19", end: "2026-11-20", timezone: "Asia/Singapore" } },
    }],
  };
  const exception = { ...master.components[0]!, recurrence: "20261119" };
  sync.apply(scope, events, batch(null, "baseline", [{ ...master, components: [...master.components, exception] }]));
  const first = store.projections(scope, events);
  expect(new Set(first.map(item => item.id)).size).toBe(2);
  sync.apply(scope, events, batch("baseline", "removed-exception", [{ ...master, etag: '"2"' }]));
  const remaining = store.projections(scope, events);
  expect(remaining.filter(item => item.value)).toHaveLength(1);
  expect(remaining.find(item => item.recurrence === "20261119")?.value).toBeUndefined();
});

const source = { kind: "human", actor: "act_00000000000000000000000001" } as const;
const collections = { event: events, todo: todos };

test("writes are queued once and their reserved ID survives a calendar pull before the write receipt", () => {
  using db = new Database(":memory:");
  const { store, sync, commands } = fixture(db);
  const create = PersonalCommand.parse({
    request_id: "fixture-command-001", operation: { op: "personal.todo.create", args: { title: "Run" } },
  });
  expect(commands.enqueue(scope, collections, create, source).status).toBe("pending_sync");
  expect(commands.enqueue(scope, collections, create, source).status).toBe("pending_sync");
  expect(() => commands.enqueue(scope, collections, PersonalCommand.parse({
    ...create, operation: { op: "personal.todo.create", args: { title: "Swim" } },
  }), source)).toThrow(PersonalError);
  const pending = new SqlitePersonalStore(db).pendingWrites(scope);
  expect(pending).toHaveLength(1);
  expect(store.pendingWrites({ ...scope, owner: "another-owner" })).toEqual([]);
  const target = pending[0]!.target!;
  sync.apply(scope, todos, batch(null, "baseline", [todo("open", { uid: target.uid })]));
  expect(store.projections(scope, todos)[0]!.value).toMatchObject({ id: target.id, revision: 1 });
});

test("updates persist the observed ETag and reject optimistic revision mismatches", () => {
  using db = new Database(":memory:");
  const { store, sync, commands } = fixture(db);
  sync.apply(scope, todos, batch(null, "baseline", [todo("open", { etag: '"known"' })]));
  const id = store.projections(scope, todos)[0]!.id;
  const update = (request_id: string, expected_revision: number) => PersonalCommand.parse({
    request_id,
    operation: { op: "personal.todo.update", args: { todo: id, expected_revision, due: null } },
  });
  expect(commands.enqueue(scope, collections, update("fixture-command-001", 2), source).status).toBe("conflict");
  expect(commands.enqueue(scope, collections, update("fixture-command-002", 1), source).status).toBe("pending_sync");
  expect(store.pendingWrites(scope)[0]!.target).toMatchObject({ mode: "update", id, href, etag: '"known"' });
});

test("a journal command atomically creates an owner-scoped entry and returns the same receipt on retry", () => {
  using db = new Database(":memory:");
  const { store, commands } = fixture(db);
  const entry = PersonalCommand.parse({
    request_id: "fixture-command-001",
    operation: { op: "personal.journal.create", args: {
      content: "Ran around the park", occurred: { kind: "date", date: "2026-11-18" },
    } },
  });
  const answer = commands.enqueue(scope, collections, entry, source);
  expect(answer.status).toBe("confirmed");
  expect(commands.enqueue(scope, collections, entry, source)).toEqual(answer);
  expect(store.journal(scope.owner)).toHaveLength(1);
  expect(store.journal(scope.owner)[0]).toMatchObject({ kind: "entry", source, content: "Ran around the park" });
  expect(store.pendingWrites(scope)).toEqual([]);
});
