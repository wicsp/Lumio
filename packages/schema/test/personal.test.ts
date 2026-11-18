import { expect, test } from "bun:test";
import { z } from "zod";
import {
  CAPABILITIES, CONTRACTS, Operation, PERSONAL_CAPABILITIES, PersonalCommand, PersonalCommandProposal,
  PersonalCommandResult, PersonalDateTime, PersonalEvent, PersonalEventCreateArgs, PersonalEventListArgs,
  PersonalEventListResult, PersonalEventUpdateArgs, PersonalJournalCreateArgs, PersonalJournalEntry,
  PersonalJournalListArgs, PersonalTodo, PersonalTodoCreateArgs, PersonalTodoStatusCommand, PersonalTodoUpdateArgs,
  ResourceRef, capability,
} from "../src/index.ts";

const suffix = "00000000000000000000000001";
const event = `pev_${suffix}`;
const todo = `ptd_${suffix}`;
const journal = `jrn_${suffix}`;
const task = `task_${suffix}`;
const owner = `act_${suffix}`;
const conversation = `conv_${suffix}`;
const proposal = `prop_${suffix}`;
const request_id = "personal-test-001";
const timezone = "Asia/Singapore";
const start = "2026-11-19T18:00:00+08:00";
const end = "2026-11-19T11:00:00Z";
const range = { start, end, timezone };
const dateRange = { start: "2026-11-19", end: "2026-11-20", timezone };
const occurred = { kind: "date", date: "2026-11-19" } as const;

test("event schedules distinguish local dates and timed intervals", () => {
  const timed = { kind: "timed", ...range } as const;
  const allDay = { kind: "all_day", ...dateRange } as const;
  expect(PersonalEventCreateArgs.parse({ title: "Run", schedule: timed, todo, task }))
    .toEqual({ title: "Run", schedule: timed, todo, task });
  expect(PersonalEventCreateArgs.safeParse({ title: "Trip", schedule: allDay }).success).toBe(true);
  for (const schedule of [
    { ...allDay, end: allDay.start },
    { ...allDay, start },
    { ...timed, end: "2026-11-19T10:00:00Z" },
    { ...timed, start: "2026-11-19T18:00:00" },
    { ...timed, timezone: "Mars/Olympus" },
    { ...timed, timezone: "+08:00" },
  ]) {
    expect(PersonalEventCreateArgs.safeParse({ title: "Run", schedule }).success).toBe(false);
  }
});

test("event reads validate bounds and busy intervals independently of visible titles", () => {
  expect(PersonalEventListArgs.safeParse({ range, cursor: "next" }).success).toBe(true);
  expect(PersonalEventListArgs.safeParse({ range: { start, timezone } }).success).toBe(false);
  expect(PersonalEventListResult.parse({ items: [], busy: [range] })).toEqual({ items: [], busy: [range] });
  const visible = { id: event, title: "Run", revision: 1, schedule: { kind: "timed", ...range }, read_only: false };
  expect(PersonalEvent.safeParse(visible).success).toBe(true);
  expect(PersonalEvent.safeParse({ ...visible, etag: "remote" }).success).toBe(false);
});

test("updates preserve omitted fields and only clear nullable fields with null", () => {
  expect(PersonalEventUpdateArgs.parse({ event, expected_revision: 1, todo: null }))
    .toEqual({ event, expected_revision: 1, todo: null });
  expect(PersonalEventUpdateArgs.safeParse({ event, expected_revision: 1 }).success).toBe(false);
  expect(PersonalEventUpdateArgs.safeParse({ event, expected_revision: 1, schedule: null }).success).toBe(false);
  expect(PersonalEventUpdateArgs.safeParse({ event, title: "Run" }).success).toBe(false);
  expect(PersonalTodoUpdateArgs.parse({ todo, expected_revision: 1, due: null }))
    .toEqual({ todo, expected_revision: 1, due: null });
  expect(PersonalTodoUpdateArgs.safeParse({ todo, expected_revision: 0, title: "Report" }).success).toBe(false);
  expect(PersonalTodoUpdateArgs.safeParse({ todo, expected_revision: 1, status: "completed" }).success).toBe(false);
});

test("to-dos retain absent dates and distinguish dates, instants and missing completion times", () => {
  expect(PersonalTodoCreateArgs.parse({ title: "Report" })).toEqual({ title: "Report" });
  expect(PersonalDateTime.parse(occurred)).toEqual(occurred);
  expect(PersonalDateTime.safeParse({ kind: "date", date: "2026-02-29" }).success).toBe(false);
  expect(PersonalDateTime.safeParse({ kind: "datetime", at: end, timezone }).success).toBe(true);
  expect(PersonalDateTime.safeParse({ kind: "datetime", at: end }).success).toBe(false);
  const item = { id: todo, revision: 2, title: "Report", status: "completed", read_only: false };
  expect(PersonalTodo.safeParse(item).success).toBe(true);
  expect(PersonalTodo.safeParse({ ...item, status: "open", completed_at: end }).success).toBe(false);
});

test("only observed facts carry CalDAV sources and observation time is not completion time", () => {
  const source = { kind: "caldav", todo, observed_at: end } as const;
  const fields = { id: journal, revision: 1, content: "Marked complete", recorded_at: end };
  const completion = { ...fields, kind: "todo_completed", source } as const;
  expect(PersonalJournalEntry.parse(completion)).toEqual(completion);
  expect(PersonalJournalEntry.safeParse({ ...completion, occurred_at: start }).success).toBe(true);
  const reopen = { ...fields, kind: "todo_reopened", source, corrects: journal };
  expect(PersonalJournalEntry.safeParse(reopen).success).toBe(true);
  expect(PersonalJournalEntry.safeParse({ ...reopen, corrects: todo }).success).toBe(false);
  expect(PersonalJournalCreateArgs.safeParse({ content: "I ran", occurred, source }).success).toBe(false);
  expect(PersonalJournalCreateArgs.safeParse({ content: "I ran", occurred, kind: "todo_completed" }).success).toBe(false);
  expect(PersonalJournalEntry.safeParse({ ...fields, kind: "entry", occurred, source }).success).toBe(false);
  expect(PersonalJournalListArgs.safeParse({ range: dateRange, kind: "todo_reopened" }).success).toBe(true);
  expect(PersonalJournalListArgs.safeParse({ kind: "entry" }).success).toBe(false);
});

test("resource references check module and prefix and omit cached personal titles", () => {
  for (const id of [event, todo, journal]) {
    expect(ResourceRef.parse({ module: "personal", id })).toEqual({ module: "personal", id });
    expect(ResourceRef.safeParse({ module: "personal", id, label: "Private title" }).success).toBe(false);
    expect(ResourceRef.safeParse({ module: "work", id }).success).toBe(false);
  }
  expect(ResourceRef.safeParse({ module: "personal", id: task }).success).toBe(false);
  expect(ResourceRef.safeParse({ module: "work", id: task, label: "Task title" }).success).toBe(true);
});

test("private proposal payloads freeze the request and bind the owner and conversation", () => {
  const command = { request_id, operation: { op: "personal.todo.update", args: { todo, expected_revision: 4, due: null } } } as const;
  const payload = { op: "personal.command", args: { ...command, owner, conversation } } as const;
  expect(PersonalCommandProposal.parse(payload)).toEqual(payload);
  expect(PersonalCommandProposal.safeParse({ ...payload, args: { ...command, owner } }).success).toBe(false);
  expect(PersonalCommand.safeParse(payload.args).success).toBe(false);
  expect(Operation.safeParse(payload).success).toBe(false);
  for (const op of ["personal.todo.complete", "personal.todo.reopen"]) {
    const status = { request_id, operation: { op, args: { todo, expected_revision: 1 } } };
    expect(PersonalTodoStatusCommand.safeParse(status).success).toBe(true);
    expect(PersonalCommand.safeParse(status).success).toBe(false);
  }
});

test("command outcomes distinguish approval from confirmed synchronization", () => {
  const pending = { status: "pending_approval", request_id, proposal_id: proposal } as const;
  const confirmed = { status: "confirmed", request_id, resource: { module: "personal", id: todo }, revision: 2 } as const;
  expect(PersonalCommandResult.parse(pending)).toEqual(pending);
  expect(PersonalCommandResult.parse(confirmed)).toEqual(confirmed);
  expect(PersonalCommandResult.safeParse({ status: "pending_approval", request_id }).success).toBe(false);
  expect(PersonalCommandResult.safeParse({ ...confirmed, resource: { module: "personal", id: task } }).success).toBe(false);
  for (const status of ["pending_sync", "conflict", "unverified"]) {
    expect(PersonalCommandResult.safeParse({ status, request_id }).success).toBe(true);
  }
});

test("owner-scoped tool contracts are exportable and absent from the live agent catalog", () => {
  expect(PERSONAL_CAPABILITIES.map(({ name }) => name).sort()).toEqual([
    "personal.event.create", "personal.event.list", "personal.event.update",
    "personal.journal.create", "personal.journal.list",
    "personal.todo.create", "personal.todo.list", "personal.todo.update",
  ]);
  expect(CAPABILITIES.some(({ name }) => name.startsWith("personal."))).toBe(false);
  for (const { name, kind, args, result } of PERSONAL_CAPABILITIES) {
    expect(capability(name)).toBeUndefined();
    expect(z.toJSONSchema(args, { io: "input" })).toHaveProperty("additionalProperties", false);
    expect(z.toJSONSchema(result, { io: "output" })).toBeDefined();
    if (kind === "write") expect(result).toBe(PersonalCommandResult);
  }
  expect(CONTRACTS["personal-command-proposal"]).toBe(PersonalCommandProposal);
});
