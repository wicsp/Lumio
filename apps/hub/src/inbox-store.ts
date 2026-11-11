import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  Capture, KnowledgeAIBinding, type AIProfile, type CaptureCreate, type CaptureListArgs, type KnowledgeAIBindingUpdate, type ReadingStatus,
} from "@lumio/schema";
import type { CapturePlan } from "./inbox-files.ts";
import { HubError } from "./errors.ts";

export interface StoredCapture {
  capture: Capture;
  input: CaptureCreate;
  plan?: CapturePlan;
  cardId?: string;
  summary?: "card" | "deep";
  ownsEntity?: boolean;
  previousTriage?: ReadingStatus;
}

const state = "json_extract(record,'$.capture.state')";
const card = "json_extract(record,'$.capture.card')";
const triage = "json_extract(record,'$.capture.triage')";
const entity = "json_extract(record,'$.capture.entity.id')";
const read = (row: { record: string }): StoredCapture => {
  const result = JSON.parse(row.record) as StoredCapture;
  result.capture = Capture.parse(result.capture);
  return result;
};
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const inboxConflict = () => new HubError("CONFLICT", { key: "inbox.conflict", args: [] });
export const inboxMissing = () => new HubError("NOT_FOUND", { key: "inbox.missing", args: [] });

export class InboxStore {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_captures (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES actors(id), url TEXT,
        created TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), UNIQUE(owner,url)
      );
      CREATE INDEX IF NOT EXISTS inbox_owner_created ON inbox_captures(owner, created DESC, id DESC);
      CREATE INDEX IF NOT EXISTS inbox_entity ON inbox_captures(${entity});
      CREATE TABLE IF NOT EXISTS inbox_attempts (
        capture TEXT NOT NULL REFERENCES inbox_captures(id), attempt INTEGER NOT NULL,
        record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(capture,attempt)
      );
      CREATE TABLE IF NOT EXISTS inbox_requests (
        actor TEXT NOT NULL REFERENCES actors(id), request TEXT NOT NULL,
        fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor,request)
      );
      CREATE TABLE IF NOT EXISTS knowledge_ai_bindings (
        owner TEXT NOT NULL REFERENCES actors(id), purpose TEXT NOT NULL, profile TEXT,
        revision INTEGER NOT NULL, PRIMARY KEY(owner,purpose)
      );
    `);
  }

  get(id: string, owner?: string): StoredCapture {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM inbox_captures WHERE id=?").get(id);
    const value = row && read(row);
    if (!value || (owner && value.capture.owner !== owner)) throw inboxMissing();
    return value;
  }

  byUrl(owner: string, url: string): StoredCapture | undefined {
    const row = this.db.query<{ record: string }, [string, string]>("SELECT record FROM inbox_captures WHERE owner=? AND url=?").get(owner, url);
    return row ? read(row) : undefined;
  }

  byEntity(id: string): StoredCapture[] {
    return this.db.query<{ record: string }, [string]>(`SELECT record FROM inbox_captures WHERE ${entity}=? ORDER BY created,id`)
      .all(id).map(read);
  }

  list(owner: string, args: CaptureListArgs) {
    const condition = `owner=? AND (?=0 OR ${triage} IS NULL)`;
    const params = [owner, Number(args.untriaged)] as const;
    return {
      captures: this.db.query<{ record: string }, [string, number, number]>(
        `SELECT record FROM inbox_captures WHERE ${condition} ORDER BY created DESC,id DESC LIMIT ?`,
      ).all(...params, args.limit).map(row => read(row).capture),
      total: this.db.query<{ count: number }, [string, number]>(`SELECT count(*) AS count FROM inbox_captures WHERE ${condition}`).get(...params)!.count,
    };
  }

  next() {
    const row = this.db.query<{ record: string }, []>(
      `SELECT record FROM inbox_captures WHERE ${state}='queued' OR (${state}='ready' AND ${card}='pending') ORDER BY created,id LIMIT 1`,
    ).get();
    return row ? read(row) : undefined;
  }

  interrupted() {
    return this.db.query<{ record: string }, []>(
      `SELECT record FROM inbox_captures WHERE ${state}='extracting' OR (${state}='ready' AND ${card}='pending')`,
    ).all().map(read);
  }

  put(value: StoredCapture): Capture {
    const capture = Capture.parse(value.capture);
    this.db.transaction(() => {
      this.db.query(`INSERT INTO inbox_captures VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record`)
        .run(capture.id, capture.owner, capture.url ?? null, capture.created, JSON.stringify({ ...value, capture }));
      this.db.query(`INSERT INTO inbox_attempts VALUES (?,?,?) ON CONFLICT(capture,attempt) DO UPDATE SET record=excluded.record`)
        .run(capture.id, capture.attempt, JSON.stringify(capture));
    })();
    return capture;
  }

  receipt(owner: string, request: string, input: unknown): unknown {
    const row = this.db.query<{ fingerprint: string; result: string }, [string, string]>(
      "SELECT fingerprint,result FROM inbox_requests WHERE actor=? AND request=?",
    ).get(owner, request);
    if (!row) return;
    if (row.fingerprint !== hash(input)) throw inboxConflict();
    return JSON.parse(row.result);
  }

  finish(owner: string, request: string, input: unknown, result: unknown) {
    this.db.query("INSERT INTO inbox_requests VALUES (?,?,?,?)").run(owner, request, hash(input), JSON.stringify(result));
  }

  profileInUse(profile: string, nextEngine?: AIProfile["engine"]): boolean {
    const bindings = this.db.query<{ purpose: string }, [string]>("SELECT purpose FROM knowledge_ai_bindings WHERE profile=?").all(profile);
    return bindings.some(({ purpose }) => nextEngine !== (purpose === "knowledge.summary" ? "lumio" : "embedding"));
  }

  binding(owner: string, purpose: KnowledgeAIBinding["purpose"]): KnowledgeAIBinding | undefined {
    return this.bindings(owner).find(value => value.purpose === purpose);
  }

  bindings(owner: string): KnowledgeAIBinding[] {
    return this.db.query("SELECT purpose,profile,revision FROM knowledge_ai_bindings WHERE owner=? AND profile IS NOT NULL ORDER BY purpose")
      .all(owner).map(row => KnowledgeAIBinding.parse(row));
  }

  bind(owner: string, input: KnowledgeAIBindingUpdate): KnowledgeAIBinding[] {
    const row = this.db.query<{ revision: number; profile: string | null }, [string, string]>(
      "SELECT revision,profile FROM knowledge_ai_bindings WHERE owner=? AND purpose=?",
    ).get(owner, input.purpose);
    if (input.expected_revision !== undefined && row?.revision !== input.expected_revision) throw inboxConflict();
    if (row?.profile !== input.profile) {
      this.db.query(`INSERT INTO knowledge_ai_bindings VALUES (?,?,?,?) ON CONFLICT(owner,purpose)
        DO UPDATE SET profile=excluded.profile, revision=excluded.revision`)
        .run(owner, input.purpose, input.profile, (row?.revision ?? 0) + 1);
    }
    return this.bindings(owner);
  }
}
