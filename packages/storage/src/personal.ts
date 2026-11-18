import type { Database } from "bun:sqlite";
import type { PersonalCollection, PersonalCommandStore, PersonalProjection, PersonalScope, PersonalWrite } from "@lumio/personal";
import { PersonalChatResult, PersonalEvent, PersonalJournalEntry, PersonalProposal, PersonalTodo } from "@lumio/schema";

type CollectionKey = [owner: string, connection: string, collection: string, kind: PersonalCollection["kind"]];
const key = (scope: PersonalScope, collection: PersonalCollection): CollectionKey =>
  [scope.owner, scope.connection, collection.id, collection.kind];

type ProjectionRow = {
  id: string;
  uid: string;
  recurrence: string;
  href: string;
  etag: string;
  revision: number;
  value: string | null;
  completion_entry: string | null;
};

/** Personal tables are created additively. They share the Hub's SQLite backup. */
export class SqlitePersonalStore implements PersonalCommandStore {
  constructor(private readonly db: Database) {
    this.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS personal_calendar_cursors (
        owner TEXT NOT NULL, connection TEXT NOT NULL, collection TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('event','todo')), token TEXT NOT NULL,
        PRIMARY KEY(owner, connection, collection, kind));
      CREATE TABLE IF NOT EXISTS personal_calendar_projections (
        owner TEXT NOT NULL, connection TEXT NOT NULL, collection TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('event','todo')),
        uid TEXT NOT NULL, recurrence TEXT NOT NULL DEFAULT '',
        id TEXT NOT NULL UNIQUE, href TEXT NOT NULL, etag TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        value TEXT CHECK(value IS NULL OR json_valid(value)), completion_entry TEXT,
        PRIMARY KEY(owner, connection, collection, kind, uid, recurrence));
      CREATE TABLE IF NOT EXISTS personal_journal (
        owner TEXT NOT NULL, id TEXT NOT NULL UNIQUE, recorded_at TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)));
      CREATE INDEX IF NOT EXISTS personal_journal_owner ON personal_journal(owner, recorded_at, id);
      CREATE TABLE IF NOT EXISTS personal_calendar_writes (
        owner TEXT NOT NULL, connection TEXT NOT NULL, request TEXT NOT NULL,
        record TEXT NOT NULL CHECK(json_valid(record)),
        PRIMARY KEY(owner, connection, request));
      CREATE UNIQUE INDEX IF NOT EXISTS personal_create_uid
        ON personal_calendar_writes(owner, connection, json_extract(record,'$.target.uid'))
        WHERE json_extract(record,'$.target.mode') = 'create';
      CREATE TABLE IF NOT EXISTS personal_proposals (
        owner TEXT NOT NULL, connection TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(owner, connection, id));
      CREATE TABLE IF NOT EXISTS personal_chat_receipts (
        owner TEXT NOT NULL, connection TEXT NOT NULL, request TEXT NOT NULL,
        fingerprint TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
        PRIMARY KEY(owner, connection, request));
      CREATE TABLE IF NOT EXISTS personal_journal_receipts (
        owner TEXT NOT NULL, request TEXT NOT NULL, fingerprint TEXT NOT NULL, entry TEXT NOT NULL,
        PRIMARY KEY(owner, request));
    `));
  }

  transaction<T>(action: () => T): T { return this.db.transaction(action).immediate(); }

  token(scope: PersonalScope, collection: PersonalCollection): string | null {
    const row = this.db.query<{ token: string }, CollectionKey>(`
      SELECT token FROM personal_calendar_cursors WHERE owner=? AND connection=? AND collection=? AND kind=?
    `).get(...key(scope, collection));
    return row?.token ?? null;
  }

  setToken(scope: PersonalScope, collection: PersonalCollection, token: string): void {
    this.db.query(`
      INSERT INTO personal_calendar_cursors(owner, connection, collection, kind, token) VALUES (?,?,?,?,?)
      ON CONFLICT(owner, connection, collection, kind) DO UPDATE SET token=excluded.token
    `).run(...key(scope, collection), token);
  }

  projections(scope: PersonalScope, collection: PersonalCollection): PersonalProjection[] {
    const schema = collection.kind === "event" ? PersonalEvent : PersonalTodo;
    return this.db.query<ProjectionRow, CollectionKey>(`
      SELECT id, uid, recurrence, href, etag, revision, value, completion_entry
      FROM personal_calendar_projections WHERE owner=? AND connection=? AND collection=? AND kind=?
    `).all(...key(scope, collection)).map(row => ({
      id: row.id,
      uid: row.uid,
      recurrence: row.recurrence || undefined,
      href: row.href,
      etag: row.etag,
      revision: row.revision,
      value: row.value === null ? undefined : schema.parse(JSON.parse(row.value)),
      completionEntry: row.completion_entry ?? undefined,
    }));
  }

  putProjection(scope: PersonalScope, collection: PersonalCollection, projection: PersonalProjection): void {
    const { uid, recurrence, href, etag, id, revision, value, completionEntry } = projection;
    this.db.query(`
      INSERT INTO personal_calendar_projections
        (owner, connection, collection, kind, uid, recurrence, id, href, etag, revision, value, completion_entry)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner, connection, collection, kind, uid, recurrence) DO UPDATE SET
        href=excluded.href, etag=excluded.etag, revision=excluded.revision,
        value=excluded.value, completion_entry=excluded.completion_entry
    `).run(...key(scope, collection), uid, recurrence ?? "", id, href, etag, revision,
      value === undefined ? null : JSON.stringify(value), completionEntry ?? null);
  }

  reservedId(scope: PersonalScope, collection: PersonalCollection, uid: string): string | undefined {
    return this.db.query<{ id: string }, [string, string, string, string, string]>(`
      SELECT json_extract(record,'$.target.id') AS id
      FROM personal_calendar_writes
      WHERE owner=? AND connection=? AND json_extract(record,'$.target.mode') = 'create'
        AND json_extract(record,'$.target.uid')=?
        AND json_extract(record,'$.target.collection.id')=? AND json_extract(record,'$.target.collection.kind')=?
    `).get(scope.owner, scope.connection, uid, collection.id, collection.kind)?.id;
  }

  write(scope: PersonalScope, requestId: string): PersonalWrite | undefined {
    const row = this.db.query<{ record: string }, [string, string, string]>(`
      SELECT record FROM personal_calendar_writes WHERE owner=? AND connection=? AND request=?
    `).get(scope.owner, scope.connection, requestId);
    return row ? JSON.parse(row.record) as PersonalWrite : undefined;
  }

  putWrite(scope: PersonalScope, write: PersonalWrite): void {
    this.db.query(`
      INSERT INTO personal_calendar_writes(owner, connection, request, record) VALUES (?,?,?,?)
      ON CONFLICT(owner, connection, request) DO UPDATE SET record=excluded.record
    `).run(scope.owner, scope.connection, write.command.request_id, JSON.stringify(write));
  }

  pendingWrites(scope: PersonalScope): PersonalWrite[] {
    return this.db.query<{ record: string }, [string, string]>(`
      SELECT record FROM personal_calendar_writes WHERE owner=? AND connection=?
        AND json_extract(record,'$.result.status') IN ('pending_sync','unverified')
      ORDER BY rowid
    `).all(scope.owner, scope.connection).map(row => JSON.parse(row.record) as PersonalWrite);
  }

  proposal(scope: PersonalScope, id: string): PersonalProposal | undefined {
    const row = this.db.query<{ value: string }, [string, string, string]>(`
      SELECT value FROM personal_proposals WHERE owner=? AND connection=? AND id=?
    `).get(scope.owner, scope.connection, id);
    return row ? this.readProposal(scope, row.value) : undefined;
  }

  proposals(scope: PersonalScope): PersonalProposal[] {
    return this.db.query<{ value: string }, [string, string]>(`
      SELECT value FROM personal_proposals WHERE owner=? AND connection=?
      ORDER BY rowid DESC LIMIT 100
    `).all(scope.owner, scope.connection).map(row => this.readProposal(scope, row.value));
  }

  private readProposal(scope: PersonalScope, value: string): PersonalProposal {
    const proposal = PersonalProposal.parse(JSON.parse(value));
    if (proposal.status !== "approved") return proposal;
    const write = this.write(scope, proposal.operation.args.request_id);
    return { ...proposal, result: write?.result };
  }

  putProposal(scope: PersonalScope, input: PersonalProposal): void {
    const proposal = PersonalProposal.parse(input);
    if (proposal.operation.args.owner !== scope.owner) throw new Error("Personal proposal owner mismatch");
    this.db.query(`
      INSERT INTO personal_proposals(owner, connection, id, value) VALUES (?,?,?,?)
      ON CONFLICT(owner, connection, id) DO UPDATE SET value=excluded.value
    `).run(scope.owner, scope.connection, proposal.id, JSON.stringify(proposal));
  }

  chatReceipt(scope: PersonalScope, request: string): { fingerprint: string; result: PersonalChatResult; history: { user: string; assistant: string }[] } | undefined {
    const row = this.db.query<{ fingerprint: string; value: string }, [string, string, string]>(`
      SELECT fingerprint, value FROM personal_chat_receipts WHERE owner=? AND connection=? AND request=?
    `).get(scope.owner, scope.connection, request);
    if (!row) return;
    const { result, history } = JSON.parse(row.value);
    return { fingerprint: row.fingerprint, result: PersonalChatResult.parse(result), history };
  }

  putChatReceipt(scope: PersonalScope, request: string, fingerprint: string, result: PersonalChatResult,
    history: { user: string; assistant: string }[]): void {
    this.db.query(`
      INSERT INTO personal_chat_receipts(owner, connection, request, fingerprint, value) VALUES (?,?,?,?,?)
    `).run(scope.owner, scope.connection, request, fingerprint, JSON.stringify({ result: PersonalChatResult.parse(result), history }));
  }

  journalReceipt(owner: string, request: string): { fingerprint: string; entry: string } | undefined {
    return this.db.query<{ fingerprint: string; entry: string }, [string, string]>(`
      SELECT fingerprint, entry FROM personal_journal_receipts WHERE owner=? AND request=?
    `).get(owner, request) ?? undefined;
  }

  putJournalReceipt(owner: string, request: string, fingerprint: string, entry: string): void {
    this.db.query("INSERT INTO personal_journal_receipts(owner, request, fingerprint, entry) VALUES (?,?,?,?)")
      .run(owner, request, fingerprint, entry);
  }

  appendJournal(owner: string, draft: PersonalJournalEntry): void {
    const entry = PersonalJournalEntry.parse(draft);
    this.db.query("INSERT INTO personal_journal(owner, id, recorded_at, value) VALUES (?,?,?,?)")
      .run(owner, entry.id, entry.recorded_at, JSON.stringify(entry));
  }

  journal(owner: string): PersonalJournalEntry[] {
    return this.db.query<{ value: string }, [string]>(`
      SELECT value FROM personal_journal WHERE owner=? ORDER BY recorded_at ASC, rowid ASC
    `).all(owner).map(row => PersonalJournalEntry.parse(JSON.parse(row.value)));
  }
}
