import { Database } from "bun:sqlite";
import { join } from "node:path";
import { JobAccess, JobResult, JobSpec, NativeRuntimeMessage, NativeRuntimeView, NativeSession, RoutineSpec } from "@lumio/schema";
/** Read-only compatibility preflight. It never initializes or migrates a state database. */
export async function updateCheck(stateDir: string): Promise<void> {
  for (const name of ["runtime.sqlite", "native.sqlite"]) {
    const file = join(stateDir, name);
    if (!await Bun.file(file).exists()) continue;
    const db = new Database(file, { readonly: true, strict: true });
    try {
      if (db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("State integrity check failed");
      const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (name === "runtime.sqlite") {
        for (const row of db.query<{ spec: string; state: string; acked: number }, []>("SELECT spec,state,acked FROM queue").all()) {
          JobSpec.parse(JSON.parse(row.spec));
          if (!["queued", "running", "finished"].includes(row.state) || ![0, 1].includes(row.acked)) throw new Error("Unknown queue format");
        }
        for (const row of db.query<{ result: string }, []>("SELECT result FROM outbox").all()) JobResult.parse(JSON.parse(row.result));
        if (tables.has("job_access")) for (const row of db.query<{ access: string }, []>("SELECT access FROM job_access").all()) JobAccess.parse(JSON.parse(row.access));
        if (tables.has("routines")) for (const row of db.query<{ spec: string }, []>("SELECT spec FROM routines").all()) RoutineSpec.parse(JSON.parse(row.spec));
      } else {
        for (const row of db.query<{ record: string }, []>("SELECT record FROM sessions").all()) { const value = JSON.parse(row.record); NativeSession.parse(value.session); NativeRuntimeView.parse(value.view); }
        for (const row of db.query<{ record: string }, []>("SELECT record FROM events").all()) NativeRuntimeMessage.parse(JSON.parse(row.record));
      }
    } finally { db.close(); }
  }
}
