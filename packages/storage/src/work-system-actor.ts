import { randomBytes } from "node:crypto";
import { newId } from "@lumio/foundation";
import type { Database } from "bun:sqlite";
import { Actor } from "@lumio/schema";

/** A stable, tokenless identity for automatic Work transitions. */
export function workSystemActor(db: Database): Actor {
  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,role TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS internal_actors(purpose TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES actors(id));`);
    const binding = db.query<{ actor: string }, []>("SELECT actor FROM internal_actors WHERE purpose='work-system'").get();
    if (binding) return Actor.parse(db.query("SELECT * FROM actors WHERE id=?").get(binding.actor));
    const now = new Date(), actor = Actor.parse({ id: newId("act", now, randomBytes), name: `work-system-${randomBytes(6).toString("hex")}`, role: "agent", created: now.toISOString() });
    db.query("INSERT INTO actors VALUES(?,?,?,?)").run(actor.id, actor.name, actor.role, actor.created);
    db.query("INSERT INTO internal_actors(purpose,actor) VALUES('work-system',?)").run(actor.id);
    return actor;
  })();
}
