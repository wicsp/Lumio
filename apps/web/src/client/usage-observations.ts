/** Local UX observations. Only closed vocabularies may cross the recording boundary. */
import type { Section } from "./navigation.ts";

const PAGES = ["overview", "work", "knowledge", "inbox", "execution", "approvals", "assistant"] as const;
export const ACTIONS = ["page", "decision-focus", "return-to-writing", "search", "open-result", "decision-review", "decision-question", "decision-failed", "capture",
  "task-from-source", "evidence-list", "download", "source-preview", "insert-reference", "run-history", "routine-followup"] as const;
export type ObservationAction = typeof ACTIONS[number];
type Outcome = "opened" | "succeeded" | "failed";
type ObservationPage = typeof PAGES[number];
export const OBSERVATION_LIMIT = 5000;

export function observation(page: Section, action: ObservationAction, outcome: Outcome, elapsed: number) {
  if (!PAGES.includes(page as ObservationPage) || !ACTIONS.includes(action)
    || !["opened", "succeeded", "failed"].includes(outcome) || !Number.isFinite(elapsed)) return;
  return { page: page as ObservationPage, action, outcome, elapsed_ms: Math.max(0, Math.round(elapsed)), at: new Date().toISOString() };
}

export function observeAction(node: HTMLElement, action: ObservationAction, outcome: Outcome) {
  node.dispatchEvent?.(new CustomEvent("lumio-observation", { bubbles: true, detail: { action, outcome } }));
}

export class UsageObservations {
  private database?: Promise<IDBDatabase>;
  private started = performance.now();
  private visit = 0;
  private tab = crypto.randomUUID();
  private page: Section = "settings";
  private closed = false;
  constructor(private scope: string) {}

  private db(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("closed"));
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("lumio.usage.v1:" + this.scope, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("events", { autoIncrement: true });
          request.result.createObjectStore("preferences");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }
  enter(page: Section) {
    this.page = page;
    this.started = performance.now();
    this.visit++;
    this.record("page", "opened");
  }
  record(action: ObservationAction, outcome: Outcome) {
    const sample = observation(this.page, action, outcome, performance.now() - this.started);
    if (!sample || this.closed) return;
    const event = { ...sample, session: this.tab, visit: this.visit };
    void this.db().then(db => {
      if (this.closed) return;
      const tx = db.transaction(["events", "preferences"], "readwrite");
      const enabled = tx.objectStore("preferences").get("enabled");
      enabled.onsuccess = () => {
        if (enabled.result === false) return;
        const events = tx.objectStore("events");
        const add = events.add(event);
        add.onsuccess = () => {
          const last = Number(add.result);
          if (last > OBSERVATION_LIMIT) events.delete(IDBKeyRange.upperBound(last - OBSERVATION_LIMIT));
        };
      };
    }).catch(() => { /* Unavailable browser storage must never interrupt work. */ });
  }
  private async read<T>(store: string, query: (s: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const req = query(db.transaction(store).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async enabled() { return (await this.read("preferences", s => s.get("enabled"))) !== false; }
  count() { return this.read("events", s => s.count()); }
  async export() { return { format: 1, surface: "web", events: await this.read("events", s => s.getAll()) }; }
  async change(enabled: boolean | "clear") {
    const db = await this.db();
    const store = enabled === "clear" ? "events" : "preferences";
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      if (enabled === "clear") tx.objectStore(store).clear();
      else tx.objectStore(store).put(enabled, "enabled");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  close() { this.closed = true; void this.database?.then(db => db.close(), () => {}); }
}
