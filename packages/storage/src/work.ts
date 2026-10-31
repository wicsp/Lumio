import type { Database } from "bun:sqlite";
import { WorkProject, WorkTask, WorkComment, WorkExecution, WorkCommandResult } from "@lumio/schema";
import type { WorkStore } from "@lumio/work";


/** Each adapter owns only its module's tables; no Knowledge, Execution or actor-table joins. */
export class SqliteWorkStore implements WorkStore {
  constructor(private readonly db: Database) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    db.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS platform_migrations (name TEXT PRIMARY KEY, applied TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('planning','active','paused','done')),
        created TEXT NOT NULL, updated TEXT NOT NULL, tags TEXT NOT NULL CHECK(json_valid(tags)), goal TEXT, repo TEXT, deadline TEXT);
      CREATE TABLE IF NOT EXISTS work_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('todo','active','waiting','paused','done','cancelled')),
        assignee TEXT NOT NULL, project TEXT REFERENCES work_projects(id), parent TEXT REFERENCES work_tasks(id), due TEXT,
        created TEXT NOT NULL, updated TEXT NOT NULL, tags TEXT NOT NULL CHECK(json_valid(tags)),
        refs TEXT NOT NULL CHECK(json_valid(refs)), workdir TEXT, model TEXT, gpus TEXT, timeout_minutes INTEGER);
      CREATE INDEX IF NOT EXISTS work_tasks_status ON work_tasks(status,updated);
      CREATE INDEX IF NOT EXISTS work_tasks_project ON work_tasks(project);
      CREATE TABLE IF NOT EXISTS work_dependencies (task TEXT NOT NULL REFERENCES work_tasks(id), dependency TEXT NOT NULL REFERENCES work_tasks(id),
        PRIMARY KEY(task,dependency), CHECK(task<>dependency));
      CREATE TABLE IF NOT EXISTS work_comments (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES work_tasks(id), author TEXT NOT NULL,
        body TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_comments_task ON work_comments(task);
      CREATE TABLE IF NOT EXISTS work_executions (job TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES work_tasks(id),
        round INTEGER NOT NULL CHECK(round>0), input_revision INTEGER NOT NULL CHECK(input_revision>0), input_snapshot TEXT NOT NULL,
        created TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1)), UNIQUE(task,round));
      CREATE TABLE IF NOT EXISTS work_requests (actor TEXT NOT NULL, request TEXT NOT NULL, operation TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor,request));
      INSERT OR IGNORE INTO platform_migrations(name,applied) VALUES ('work-1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `))();
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  private readProject(row: Record<string, unknown> | null): WorkProject | undefined {
    if (!row) return;
    const fields = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    return WorkProject.parse({ ...fields, schema_version: 2, type: "project", tags: JSON.parse(String(row.tags)) });
  }
  project(id: string): WorkProject | undefined {
    return this.readProject(this.db.query<Record<string, unknown>, [string]>("SELECT * FROM work_projects WHERE id=?").get(id));
  }
  projects(): WorkProject[] {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM work_projects ORDER BY created,id").all().map((row) => this.readProject(row)!);
  }
  putProject(input: WorkProject): void {
    const value = WorkProject.parse(input);
    this.db.query(`INSERT INTO work_projects(id,title,description,revision,status,created,updated,tags,goal,repo,deadline)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,revision=excluded.revision,
      status=excluded.status,updated=excluded.updated,tags=excluded.tags,goal=excluded.goal,repo=excluded.repo,deadline=excluded.deadline`).run(
      value.id, value.title, value.description, value.revision, value.status, value.created, value.updated,
      JSON.stringify(value.tags), value.goal ?? null, value.repo ?? null, value.deadline ?? null);
  }

  private readTask(row: Record<string, unknown> | null): WorkTask | undefined {
    if (!row) return;
    const { refs, ...fields } = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    const dependencies = this.db.query<{ dependency: string }, [string]>("SELECT dependency FROM work_dependencies WHERE task=? ORDER BY rowid").all(String(row.id)).map((value) => value.dependency);
    return WorkTask.parse({ ...fields, schema_version: 2, type: "task", tags: JSON.parse(String(row.tags)), references: JSON.parse(String(refs)),
      gpus: row.gpus === null ? undefined : JSON.parse(String(row.gpus)), dependencies });
  }
  task(id: string): WorkTask | undefined { return this.readTask(this.db.query<Record<string, unknown>, [string]>("SELECT * FROM work_tasks WHERE id=?").get(id)); }
  tasks(): WorkTask[] { return this.db.query<Record<string, unknown>, []>("SELECT * FROM work_tasks ORDER BY created,id").all().map((row) => this.readTask(row)!); }
  putTask(input: WorkTask): void {
    const value = WorkTask.parse(input);
    this.transaction(() => {
      this.db.query(`INSERT INTO work_tasks(id,title,description,revision,status,assignee,project,parent,due,created,updated,tags,refs,workdir,model,gpus,timeout_minutes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,revision=excluded.revision,status=excluded.status,
        assignee=excluded.assignee,project=excluded.project,parent=excluded.parent,due=excluded.due,updated=excluded.updated,tags=excluded.tags,
        refs=excluded.refs,workdir=excluded.workdir,model=excluded.model,gpus=excluded.gpus,timeout_minutes=excluded.timeout_minutes`).run(
        value.id, value.title, value.description, value.revision, value.status, value.assignee, value.project ?? null, value.parent ?? null,
        value.due ?? null, value.created, value.updated, JSON.stringify(value.tags), JSON.stringify(value.references),
        value.workdir ?? null, value.model ?? null, value.gpus === undefined ? null : JSON.stringify(value.gpus), value.timeout_minutes ?? null);
      this.db.query("DELETE FROM work_dependencies WHERE task=?").run(value.id);
      const insert = this.db.query("INSERT INTO work_dependencies(task,dependency) VALUES (?,?)");
      for (const dependency of value.dependencies) insert.run(value.id, dependency);
    });
  }
  comments(task: string): WorkComment[] {
    return WorkComment.array().parse(this.db.query("SELECT * FROM work_comments WHERE task=? ORDER BY rowid").all(task));
  }
  putComment(input: WorkComment): void {
    const value = WorkComment.parse(input);
    this.db.query("INSERT INTO work_comments(id,task,author,body,created) VALUES (?,?,?,?,?)").run(value.id, value.task, value.author, value.body, value.created);
  }
  executions(task?: string): WorkExecution[] {
    const rows = task === undefined ? this.db.query<Record<string, unknown>, []>("SELECT * FROM work_executions ORDER BY rowid").all()
      : this.db.query<Record<string, unknown>, [string]>("SELECT * FROM work_executions WHERE task=? ORDER BY round").all(task);
    return rows.map((row) => WorkExecution.parse({ ...row, applied: Boolean(row.applied) }));
  }
  putExecution(input: WorkExecution): void {
    const value = WorkExecution.parse(input);
    this.db.query(`INSERT INTO work_executions(job,task,round,input_revision,input_snapshot,created,applied)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(job) DO UPDATE SET applied=excluded.applied`).run(value.job, value.task, value.round, value.input_revision, value.input_snapshot, value.created, Number(value.applied));
  }
  receipt(actor: string, request: string): { operation: string; result: WorkCommandResult } | undefined {
    const row = this.db.query<{ operation: string; result: string }, [string, string]>("SELECT operation,result FROM work_requests WHERE actor=? AND request=?").get(actor, request);
    return row ? { operation: row.operation, result: WorkCommandResult.parse(JSON.parse(row.result)) } : undefined;
  }
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult): void {
    this.db.query("INSERT INTO work_requests(actor,request,operation,result) VALUES (?,?,?,?)").run(actor, request, operation, JSON.stringify(WorkCommandResult.parse(result)));
  }
}
