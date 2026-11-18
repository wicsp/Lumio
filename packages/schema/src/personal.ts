import { z } from "zod";
import { RequestId, Revision, Timestamp, idOf } from "./common.ts";
import { PersonalResourceRef, ResourceRef } from "./work.ts";

/** ADR 0080: public Personal contracts contain no remote paths, ETags or credentials. */
const Title = z.string().trim().min(1);
const DateOnly = z.iso.date();
const TimeZone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/).refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Expected an IANA time zone");
const Cursor = z.string().min(1);
const Limit = z.number().int().min(1).max(100);

const CalendarDate = z.strictObject({ kind: z.literal("date"), date: DateOnly });
const CalendarTime = z.strictObject({ kind: z.literal("datetime"), at: Timestamp, timezone: TimeZone });
export const PersonalDateTime = z.discriminatedUnion("kind", [CalendarDate, CalendarTime]);

const TimeRange = z.strictObject({ start: Timestamp, end: Timestamp, timezone: TimeZone })
  .refine(({ start, end }) => Date.parse(start) < Date.parse(end), { path: ["end"], message: "End must follow start" });
const DateRange = z.strictObject({ start: DateOnly, end: DateOnly, timezone: TimeZone })
  .refine(({ start, end }) => start < end, { path: ["end"], message: "Exclusive end date must follow start" });

export const PersonalEventSchedule = z.discriminatedUnion("kind", [
  TimeRange.safeExtend({ kind: z.literal("timed") }),
  DateRange.safeExtend({ kind: z.literal("all_day") }),
]);

const EventFields = {
  title: Title,
  schedule: PersonalEventSchedule,
  todo: idOf("ptd").optional(),
  task: idOf("task").optional(),
};
export const PersonalEvent = z.strictObject({
  id: idOf("pev"),
  revision: Revision,
  ...EventFields,
  read_only: z.boolean(),
});
export const PersonalEventListArgs = z.strictObject({
  range: TimeRange,
  cursor: Cursor.optional(),
  limit: Limit.optional(),
});
export const PersonalEventListResult = z.strictObject({
  items: z.array(PersonalEvent),
  busy: z.array(TimeRange),
  next_cursor: Cursor.optional(),
});
export const PersonalEventCreateArgs = z.strictObject(EventFields);
export const PersonalEventUpdateArgs = z.strictObject({
  event: idOf("pev"),
  expected_revision: Revision,
  title: Title.optional(),
  schedule: PersonalEventSchedule.optional(),
  todo: idOf("ptd").nullable().optional(),
  task: idOf("task").nullable().optional(),
}).refine(
  ({ title, schedule, todo, task }) => [title, schedule, todo, task].some((value) => value !== undefined),
  "Nothing to update",
);

const TodoStatus = z.enum(["open", "completed"]);
const TodoFields = {
  title: Title,
  due: PersonalDateTime.optional(),
};
export const PersonalTodo = z.strictObject({
  id: idOf("ptd"),
  revision: Revision,
  ...TodoFields,
  status: TodoStatus,
  completed_at: Timestamp.optional(),
  read_only: z.boolean(),
}).refine(
  ({ completed_at, status }) => completed_at === undefined || status === "completed",
  { path: ["completed_at"], message: "Only a completed to-do can have a completion time" },
);
export const PersonalTodoListArgs = z.strictObject({
  range: DateRange.optional(),
  status: TodoStatus.optional(),
  include_undated: z.boolean().optional(),
  cursor: Cursor.optional(),
  limit: Limit.optional(),
});
export const PersonalTodoListResult = z.strictObject({ items: z.array(PersonalTodo), next_cursor: Cursor.optional() });
export const PersonalTodoCreateArgs = z.strictObject(TodoFields);
export const PersonalTodoUpdateArgs = z.strictObject({
  todo: idOf("ptd"),
  expected_revision: Revision,
  title: Title.optional(),
  due: PersonalDateTime.nullable().optional(),
}).refine(({ title, due }) => title !== undefined || due !== undefined, "Nothing to update");

const JournalFields = {
  id: idOf("jrn"),
  revision: Revision,
  recorded_at: Timestamp,
  content: z.string().trim().min(1),
};
const JournalAuthoredSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human"), actor: idOf("act") }),
  z.strictObject({ kind: z.literal("chat"), proposal: idOf("prop") }),
]);
const JournalObservedSource = z.strictObject({
  kind: z.literal("caldav"),
  todo: idOf("ptd"),
  observed_at: Timestamp,
});
export const PersonalJournalEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    ...JournalFields,
    kind: z.literal("entry"),
    occurred: PersonalDateTime,
    source: JournalAuthoredSource,
    reference: ResourceRef.optional(),
  }),
  z.strictObject({
    ...JournalFields,
    kind: z.literal("todo_completed"),
    occurred_at: Timestamp.optional().describe("Completion time reported by CalDAV, when available"),
    source: JournalObservedSource,
  }),
  z.strictObject({
    ...JournalFields,
    kind: z.literal("todo_reopened"),
    source: JournalObservedSource,
    corrects: idOf("jrn"),
  }),
  z.strictObject({
    ...JournalFields,
    kind: z.literal("correction"),
    occurred: PersonalDateTime,
    source: JournalAuthoredSource,
    corrects: idOf("jrn"),
  }),
  z.strictObject({
    ...JournalFields,
    kind: z.literal("retraction"),
    source: JournalAuthoredSource,
    retracts: idOf("jrn"),
  }),
]);
export const PersonalJournalListArgs = z.strictObject({
  range: DateRange,
  kind: z.enum(PersonalJournalEntry.options.map((entry) => entry.shape.kind.value)).optional(),
  cursor: Cursor.optional(),
  limit: Limit.optional(),
});
export const PersonalJournalListResult = z.strictObject({
  items: z.array(PersonalJournalEntry),
  next_cursor: Cursor.optional(),
});
export const PersonalJournalCreateArgs = z.strictObject({
  occurred: PersonalDateTime,
  content: JournalFields.content,
  reference: ResourceRef.optional(),
});

const EventCreate = z.strictObject({ op: z.literal("personal.event.create"), args: PersonalEventCreateArgs });
const EventUpdate = z.strictObject({ op: z.literal("personal.event.update"), args: PersonalEventUpdateArgs });
const TodoCreate = z.strictObject({ op: z.literal("personal.todo.create"), args: PersonalTodoCreateArgs });
const TodoUpdate = z.strictObject({ op: z.literal("personal.todo.update"), args: PersonalTodoUpdateArgs });
const JournalCreate = z.strictObject({ op: z.literal("personal.journal.create"), args: PersonalJournalCreateArgs });
export const PersonalWriteOperation = z.discriminatedUnion("op", [EventCreate, EventUpdate, TodoCreate, TodoUpdate, JournalCreate]);
export const PersonalCommand = z.strictObject({ request_id: RequestId, operation: PersonalWriteOperation });

const TodoStatusArgs = z.strictObject({ todo: idOf("ptd"), expected_revision: Revision });
export const PersonalTodoStatusCommand = z.strictObject({
  request_id: RequestId,
  operation: z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("personal.todo.complete"), args: TodoStatusArgs }),
    z.strictObject({ op: z.literal("personal.todo.reopen"), args: TodoStatusArgs }),
  ]),
});

/** Scope is supplied by Hub from the authenticated conversation. This payload is private. */
export const PersonalCommandProposal = z.strictObject({
  op: z.literal("personal.command"),
  args: PersonalCommand.safeExtend({ owner: idOf("act"), conversation: idOf("conv") }),
});

export const PersonalCommandResult = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending_approval"), request_id: RequestId, proposal_id: idOf("prop") }),
  z.strictObject({ status: z.literal("pending_sync"), request_id: RequestId }),
  z.strictObject({ status: z.literal("confirmed"), request_id: RequestId, resource: PersonalResourceRef, revision: Revision }),
  z.strictObject({ status: z.literal("conflict"), request_id: RequestId }),
  z.strictObject({ status: z.literal("unverified"), request_id: RequestId }),
]);

export type PersonalDateTime = z.infer<typeof PersonalDateTime>;
export type PersonalEvent = z.infer<typeof PersonalEvent>;
export type PersonalTodo = z.infer<typeof PersonalTodo>;
export type PersonalJournalEntry = z.infer<typeof PersonalJournalEntry>;
export type PersonalCommand = z.infer<typeof PersonalCommand>;
export type PersonalTodoStatusCommand = z.infer<typeof PersonalTodoStatusCommand>;
export type PersonalCommandProposal = z.infer<typeof PersonalCommandProposal>;
export type PersonalCommandResult = z.infer<typeof PersonalCommandResult>;
