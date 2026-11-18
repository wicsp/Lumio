import { PersonalEvent, PersonalJournalEntry, PersonalTodo, Timestamp } from "@lumio/schema";

export type PersonalScope = { owner: string; connection: string };
export type PersonalCollection = { id: string; kind: "event" | "todo" };
type EventFields = Omit<PersonalEvent, "id" | "revision" | "todo" | "task">;
type TodoFields = Omit<PersonalTodo, "id" | "revision">;

export type CalendarComponent = {
  uid: string;
  recurrence?: string;
} & ({ kind: "event"; item: EventFields } | { kind: "todo"; item: TodoFields });

export type CalendarResource = {
  href: string;
  etag: string;
  /** Includes all supported components at this href, including recurrence exceptions. */
  components: readonly CalendarComponent[];
};

export type CalendarSync = {
  mode: "full" | "incremental";
  expectedToken: string | null;
  token: string;
  resources: readonly CalendarResource[];
  deleted: readonly string[];
  observedAt: string;
};

export type PersonalProjection = {
  uid: string;
  recurrence?: string;
  id: string;
  href: string;
  etag: string;
  revision: number;
  value?: PersonalEvent | PersonalTodo;
  completionEntry?: string;
};

export interface PersonalEventLinks { todo?: string | null; task?: string | null }

export interface PersonalStore {
  transaction<T>(action: () => T): T;
  token(scope: PersonalScope, collection: PersonalCollection): string | null;
  setToken(scope: PersonalScope, collection: PersonalCollection, token: string): void;
  projections(scope: PersonalScope, collection: PersonalCollection): PersonalProjection[];
  reservedId(scope: PersonalScope, collection: PersonalCollection, uid: string): string | undefined;
  putProjection(scope: PersonalScope, collection: PersonalCollection, projection: PersonalProjection): void;
  appendJournal(owner: string, entry: PersonalJournalEntry): void;
}

export class PersonalError extends Error {
  constructor(readonly code: "INVALID" | "CONFLICT", message: string) {
    super(message);
    this.name = "PersonalError";
  }
}

const identity = (component: { uid: string; recurrence?: string }) =>
  JSON.stringify([component.uid, component.recurrence ?? null]);

export class PersonalSync {
  constructor(private readonly store: PersonalStore, private readonly id: (prefix: "pev" | "ptd" | "jrn") => string) {}

  apply(scope: PersonalScope, collection: PersonalCollection, batch: CalendarSync): void {
    if (!batch.token || (batch.mode === "incremental" && batch.expectedToken === null)) {
      throw new PersonalError("INVALID", "A complete baseline is required before incremental sync");
    }
    if (!Timestamp.safeParse(batch.observedAt).success) {
      throw new PersonalError("INVALID", "Calendar observation time requires an offset");
    }
    const returned = new Set<string>();
    const deleted = new Set(batch.deleted);
    const incoming = new Set<string>();
    for (const resource of batch.resources) {
      if (!resource.href || !resource.etag || returned.has(resource.href) || deleted.has(resource.href)) {
        throw new PersonalError("INVALID", "Invalid or conflicting calendar resource");
      }
      returned.add(resource.href);
      for (const component of resource.components) {
        const key = identity(component);
        if (!component.uid || component.recurrence === "" || component.kind !== collection.kind || incoming.has(key)) {
          throw new PersonalError("INVALID", "Invalid or duplicate calendar component");
        }
        incoming.add(key);
      }
    }

    this.store.transaction(() => {
      if (this.store.token(scope, collection) !== batch.expectedToken) {
        throw new PersonalError("CONFLICT", "Calendar sync cursor advanced");
      }
      const existing = new Map(this.store.projections(scope, collection).map(item => [identity(item), item]));
      for (const resource of batch.resources) for (const component of resource.components) {
        this.project(scope, collection, resource, component, existing.get(identity(component)), batch.observedAt);
      }
      for (const [key, prior] of existing) {
        if (!prior.value || incoming.has(key)) continue;
        if (batch.mode === "full" || returned.has(prior.href) || deleted.has(prior.href)) {
          this.store.putProjection(scope, collection, { ...prior, value: undefined, completionEntry: undefined, revision: prior.revision + 1 });
        }
      }
      this.store.setToken(scope, collection, batch.token);
    });
  }

  observeWrite(scope: PersonalScope, collection: PersonalCollection, resource: CalendarResource, id: string, observedAt: string,
    links?: PersonalEventLinks): PersonalProjection {
    return this.store.transaction(() => {
      const component = resource.components.length === 1 ? resource.components[0] : undefined;
      if (!component || component.kind !== collection.kind || component.recurrence !== undefined) {
        throw new PersonalError("CONFLICT", "Calendar read-back has an unexpected component");
      }
      const prior = this.store.projections(scope, collection).find(item => identity(item) === identity(component));
      if ((prior?.id ?? this.store.reservedId(scope, collection, component.uid)) !== id) {
        throw new PersonalError("CONFLICT", "Calendar write does not match the stored resource");
      }
      return this.project(scope, collection, resource, component, prior, observedAt, links);
    });
  }

  private project(scope: PersonalScope, collection: PersonalCollection, { href, etag }: CalendarResource,
    remote: CalendarComponent, prior: PersonalProjection | undefined, observedAt: string, links?: PersonalEventLinks): PersonalProjection {
    const reserved = prior || remote.recurrence !== undefined ? undefined : this.store.reservedId(scope, collection, remote.uid);
    const id = prior?.id ?? reserved ?? this.id(remote.kind === "event" ? "pev" : "ptd");
    const revision = (prior?.revision ?? 0) + 1;
    const read_only = remote.item.read_only || remote.recurrence !== undefined;
    const previous = prior?.value && "schedule" in prior.value ? prior.value : undefined;
    const association = (key: "todo" | "task") => links?.[key] === undefined ? previous?.[key] : links[key] ?? undefined;
    const value = remote.kind === "event"
      ? PersonalEvent.parse({ ...remote.item, id, revision, read_only, todo: association("todo"), task: association("task") })
      : PersonalTodo.parse({ ...remote.item, id, revision, read_only });
    if (prior?.value && prior.etag === etag && prior.href === href
      && JSON.stringify(prior.value) === JSON.stringify({ ...value, revision: prior.revision })) return prior;
    const completionEntry = this.recordCompletion(scope.owner, prior, value, observedAt);
    const projected = { uid: remote.uid, recurrence: remote.recurrence, href, etag, id, revision, value, completionEntry };
    this.store.putProjection(scope, collection, projected);
    return projected;
  }

  private recordCompletion(owner: string, prior: PersonalProjection | undefined, value: PersonalEvent | PersonalTodo, observedAt: string): string | undefined {
    const previous = prior?.value;
    if (!previous || !("status" in previous) || !("status" in value)) return prior?.completionEntry;
    if (value.read_only || previous.read_only || value.status === previous.status) return prior?.completionEntry;

    const source = { kind: "caldav", todo: value.id, observed_at: observedAt };
    const fields = { revision: 1, recorded_at: observedAt, source };
    if (value.status === "completed") {
      const id = this.id("jrn");
      this.store.appendJournal(owner, PersonalJournalEntry.parse({
        ...fields, id, kind: "todo_completed", content: value.title, occurred_at: value.completed_at,
      }));
      return id;
    }
    const corrects = prior?.completionEntry;
    if (corrects) {
      this.store.appendJournal(owner, PersonalJournalEntry.parse({
        ...fields, id: this.id("jrn"), kind: "todo_reopened", content: value.title, corrects,
      }));
    }
    return undefined;
  }
}
