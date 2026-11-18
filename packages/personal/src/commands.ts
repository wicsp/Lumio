import { PersonalCommand, PersonalCommandResult, PersonalJournalEntry, PersonalTodoStatusCommand } from "@lumio/schema";
import { PersonalError, type PersonalCollection, type PersonalScope, type PersonalStore } from "./sync.ts";

type Command = PersonalCommand | PersonalTodoStatusCommand;
type JournalSource = Extract<PersonalJournalEntry, { kind: "entry" }>["source"];
export type CalendarTarget = {
  collection: PersonalCollection;
  id: string;
  uid: string;
} & ({ mode: "create" } | { mode: "update"; href: string; etag: string });

export interface PersonalWrite {
  command: Command;
  queuedAt: string;
  target?: CalendarTarget;
  result: PersonalCommandResult;
}

export interface PersonalCommandStore extends PersonalStore {
  write(scope: PersonalScope, requestId: string): PersonalWrite | undefined;
  putWrite(scope: PersonalScope, write: PersonalWrite): void;
  pendingWrites(scope: PersonalScope): PersonalWrite[];
}

type CalendarCollections = Record<PersonalCollection["kind"], PersonalCollection>;

/** Records only commands already authorized by the calling Hub. */
export class PersonalCommands {
  constructor(
    private readonly store: PersonalCommandStore,
    private readonly id: (prefix: "pev" | "ptd" | "jrn") => string,
    private readonly now: () => string,
  ) {}

  enqueue(
    scope: PersonalScope,
    collections: CalendarCollections,
    input: Command,
    source: JournalSource,
  ): PersonalCommandResult {
    const write = PersonalCommand.safeParse(input);
    const command = write.success ? write.data : PersonalTodoStatusCommand.parse(input);
    const { request_id, operation } = command;
    return this.store.transaction(() => {
      const previous = this.store.write(scope, request_id);
      if (previous) {
        if (JSON.stringify(previous.command) !== JSON.stringify(command)) {
          throw new PersonalError("CONFLICT", "Request ID was used for a different personal command");
        }
        return previous.result;
      }

      if (operation.op === "personal.journal.create") {
        const id = this.id("jrn");
        this.store.appendJournal(scope.owner, PersonalJournalEntry.parse({
          ...operation.args, id, revision: 1, kind: "entry", source, recorded_at: this.now(),
        }));
        return this.remember(scope, command, {
          status: "confirmed", request_id, resource: { module: "personal", id }, revision: 1,
        });
      }

      const collection = operation.op.startsWith("personal.event.") ? collections.event : collections.todo;
      if (operation.op === "personal.event.create" || operation.op === "personal.todo.create") {
        const id = this.id(collection.kind === "event" ? "pev" : "ptd");
        return this.remember(scope, command, { status: "pending_sync", request_id }, { collection, id, uid: id, mode: "create" });
      }

      const args = operation.args;
      const id = "event" in args ? args.event : args.todo;
      const current = this.store.projections(scope, collection).find(value => value.id === id);
      if (!current?.value || current.value.read_only || current.revision !== args.expected_revision) {
        return this.remember(scope, command, { status: "conflict", request_id });
      }
      if ("status" in current.value &&
          ((operation.op === "personal.todo.complete" && current.value.status === "completed") ||
            (operation.op === "personal.todo.reopen" && current.value.status === "open"))) {
        return this.remember(scope, command, {
          status: "confirmed", request_id, resource: { module: "personal", id }, revision: current.revision,
        });
      }
      return this.remember(scope, command, { status: "pending_sync", request_id }, {
        collection, id, uid: current.uid, mode: "update", href: current.href, etag: current.etag,
      });
    });
  }

  private remember(scope: PersonalScope, command: Command, outcome: PersonalCommandResult, target?: CalendarTarget) {
    const result = PersonalCommandResult.parse(outcome);
    this.store.putWrite(scope, { command, queuedAt: this.now(), target, result });
    return result;
  }
}
