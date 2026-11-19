import type { Database } from "bun:sqlite";
import { WorkProject, WorkTask, WorkComment, WorkExecution, TaskTurnChange, WorkCommandResult, PlanTemplate, TrashItem, StagePermissions } from "@lumio/schema";
import { type PendingStageGrant, type WorkStore } from "@lumio/work";


/** Each adapter owns only its module's tables; no Knowledge, Execution or actor-table joins. */
export class SqliteWorkStore implements WorkStore {
  constructor(private readonly db: Database) {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    db.transaction(() => {
      db.exec(`
      CREATE TABLE IF NOT EXISTS work_projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), status TEXT NOT NULL CHECK(status IN ('planning','active','paused','done')),
        created TEXT NOT NULL, updated TEXT NOT NULL, tags TEXT NOT NULL CHECK(json_valid(tags)), goal TEXT, repo TEXT, deadline TEXT,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL, workdir TEXT, default_target TEXT, default_plan TEXT);
      CREATE TABLE IF NOT EXISTS work_project_execution (
        project TEXT PRIMARY KEY REFERENCES work_projects(id) ON DELETE CASCADE,
        settings TEXT NOT NULL CHECK(json_valid(settings)));
      CREATE TABLE IF NOT EXISTS work_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), outcome TEXT NOT NULL CHECK(outcome IN ('open','done','cancelled')),
        turn TEXT NOT NULL CHECK(json_valid(turn)), plan TEXT CHECK(plan IS NULL OR json_valid(plan)),
        grants TEXT CHECK(grants IS NULL OR json_valid(grants)), project TEXT REFERENCES work_projects(id), parent TEXT REFERENCES work_tasks(id), due TEXT,
        created TEXT NOT NULL, updated TEXT NOT NULL, tags TEXT NOT NULL CHECK(json_valid(tags)),
        refs TEXT NOT NULL CHECK(json_valid(refs)), workdir TEXT, model TEXT, gpus TEXT, timeout_minutes INTEGER,
        created_by TEXT, updated_by TEXT);
      CREATE INDEX IF NOT EXISTS work_tasks_project ON work_tasks(project);
      CREATE TABLE IF NOT EXISTS work_dependencies (task TEXT NOT NULL REFERENCES work_tasks(id), dependency TEXT NOT NULL REFERENCES work_tasks(id),
        PRIMARY KEY(task,dependency), CHECK(task<>dependency));
      CREATE TABLE IF NOT EXISTS work_comments (id TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES work_tasks(id), author TEXT NOT NULL,
        body TEXT NOT NULL, created TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_comments_task ON work_comments(task);
      CREATE TABLE IF NOT EXISTS work_plan_templates (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS work_executions (job TEXT PRIMARY KEY, task TEXT NOT NULL REFERENCES work_tasks(id),
        round INTEGER NOT NULL CHECK(round>0), input_revision INTEGER NOT NULL CHECK(input_revision>0), input_snapshot TEXT NOT NULL,
        created TEXT NOT NULL, applied INTEGER NOT NULL CHECK(applied IN (0,1)), UNIQUE(task,round));
      CREATE TABLE IF NOT EXISTS work_trash (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE TABLE IF NOT EXISTS work_purged_tasks (id TEXT PRIMARY KEY REFERENCES work_tasks(id));
      CREATE TABLE IF NOT EXISTS work_requests (actor TEXT NOT NULL, request TEXT NOT NULL, operation TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor,request));
      CREATE TABLE IF NOT EXISTS work_turns(task TEXT NOT NULL REFERENCES work_tasks(id),record TEXT NOT NULL CHECK(json_valid(record)));
      CREATE INDEX IF NOT EXISTS work_turns_task ON work_turns(task);
      CREATE TABLE IF NOT EXISTS work_pending_grants (
        task TEXT PRIMARY KEY REFERENCES work_tasks(id), job TEXT NOT NULL, stage TEXT,
        permissions TEXT NOT NULL CHECK(json_valid(permissions)));
      `);
      this.ensureKnowledgeReferences();
    }).immediate();
  }
  private ensureKnowledgeReferences(): void {
    // The table's presence records a completed backfill because setup runs in the same transaction.
    const exists = this.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='work_task_knowledge_refs'").get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_task_knowledge_refs (
        knowledge TEXT NOT NULL, task TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(knowledge,task));
      CREATE INDEX IF NOT EXISTS work_task_knowledge_refs_task ON work_task_knowledge_refs(task);
      CREATE TRIGGER IF NOT EXISTS work_task_knowledge_refs_insert AFTER INSERT ON work_tasks
      BEGIN
        INSERT OR IGNORE INTO work_task_knowledge_refs(knowledge,task)
        SELECT json_extract(ref.json,ref.fullkey || '.id'), NEW.id FROM json_each(NEW.refs) AS ref
        WHERE json_extract(ref.json,ref.fullkey || '.module')='knowledge';
      END;
      CREATE TRIGGER IF NOT EXISTS work_task_knowledge_refs_update AFTER UPDATE OF refs ON work_tasks
      WHEN NEW.refs IS NOT OLD.refs
      BEGIN
        DELETE FROM work_task_knowledge_refs WHERE task=NEW.id;
        INSERT OR IGNORE INTO work_task_knowledge_refs(knowledge,task)
        SELECT json_extract(ref.json,ref.fullkey || '.id'), NEW.id FROM json_each(NEW.refs) AS ref
        WHERE json_extract(ref.json,ref.fullkey || '.module')='knowledge';
      END;
    `);
    if (!exists) this.db.exec(`
      INSERT OR IGNORE INTO work_task_knowledge_refs(knowledge,task)
      SELECT json_extract(ref.json,ref.fullkey || '.id'), task.id
      FROM work_tasks AS task, json_each(task.refs) AS ref
      WHERE json_extract(ref.json,ref.fullkey || '.module')='knowledge'
        AND NOT EXISTS (SELECT 1 FROM work_purged_tasks WHERE id=task.id);
    `);
  }
  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
  private readProject(row: Record<string, unknown> | null): WorkProject | undefined {
    if (!row) return;
    const { execution_settings, ...fields } = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    const settings = typeof execution_settings === "string" ? JSON.parse(execution_settings) : {};
    return WorkProject.parse({ ...fields, ...settings, schema_version: 2, type: "project", tags: JSON.parse(String(row.tags)) });
  }
  project(id: string): WorkProject | undefined {
    return this.readProject(this.db.query<Record<string, unknown>, [string]>("SELECT p.*, e.settings AS execution_settings FROM work_projects p LEFT JOIN work_project_execution e ON e.project=p.id WHERE p.id=?").get(id));
  }
  projects(): WorkProject[] {
    return this.db.query<Record<string, unknown>, []>("SELECT p.*, e.settings AS execution_settings FROM work_projects p LEFT JOIN work_project_execution e ON e.project=p.id ORDER BY p.created,p.id").all().map((row) => this.readProject(row)!);
  }
  putProject(input: WorkProject): void {
    const value = WorkProject.parse(input);
    this.transaction(() => {
      this.db.query(`INSERT INTO work_projects(id,title,description,revision,status,created,updated,tags,goal,repo,deadline,created_by,updated_by,workdir,default_target,default_plan)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,revision=excluded.revision,
        status=excluded.status,updated=excluded.updated,tags=excluded.tags,goal=excluded.goal,repo=excluded.repo,workdir=excluded.workdir,default_target=excluded.default_target,default_plan=excluded.default_plan,deadline=excluded.deadline,updated_by=excluded.updated_by`).run(
        value.id, value.title, value.description, value.revision, value.status, value.created, value.updated,
        JSON.stringify(value.tags), value.goal ?? null, value.repo ?? null, value.deadline ?? null, value.created_by, value.updated_by, value.workdir ?? null, value.default_target ?? null, value.default_plan ?? null);
      const { auto_worktree, worktree_base, max_concurrent } = value;
      if (auto_worktree === undefined && worktree_base === undefined && max_concurrent === undefined) {
        this.db.query("DELETE FROM work_project_execution WHERE project=?").run(value.id);
      } else {
        this.db.query(`INSERT INTO work_project_execution(project,settings) VALUES(?,?)
          ON CONFLICT(project) DO UPDATE SET settings=excluded.settings`).run(value.id, JSON.stringify({ auto_worktree, worktree_base, max_concurrent }));
      }
    });
  }

  private readTask(row: Record<string, unknown> | null, batchDependencies?: Map<string, string[]>): WorkTask | undefined {
    if (!row) return;
    const { refs, turn, plan, grants, ...fields } = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
    const dependencies = batchDependencies?.get(String(row.id)) ?? (batchDependencies ? [] : this.db.query<{ dependency: string }, [string]>("SELECT dependency FROM work_dependencies WHERE task=? ORDER BY rowid").all(String(row.id)).map((value) => value.dependency));
    return WorkTask.parse({ ...fields, schema_version: 3, type: "task", turn: JSON.parse(String(turn)), plan: plan ? JSON.parse(String(plan)) : undefined,
      grants: grants ? JSON.parse(String(grants)) : undefined, tags: JSON.parse(String(row.tags)), references: JSON.parse(String(refs)),
      gpus: row.gpus === null ? undefined : JSON.parse(String(row.gpus)), dependencies });
  }
  purgedTask(id: string): boolean {
    return !!this.db.query("SELECT 1 FROM work_purged_tasks WHERE id=?").get(id);
  }
  task(id: string): WorkTask | undefined { return this.readTask(this.db.query<Record<string, unknown>, [string]>("SELECT * FROM work_tasks WHERE id=? AND id NOT IN (SELECT id FROM work_purged_tasks)").get(id)); }
  tasksReferencingKnowledge(id: string): Pick<WorkTask, "id" | "title">[] {
    return this.db.query<Pick<WorkTask, "id" | "title">, [string]>(`
      SELECT task.id, task.title FROM work_task_knowledge_refs AS ref
      JOIN work_tasks AS task ON task.id=ref.task
      WHERE ref.knowledge=?
        AND NOT EXISTS (SELECT 1 FROM work_trash WHERE id=ref.task)
        AND NOT EXISTS (SELECT 1 FROM work_purged_tasks WHERE id=ref.task)
      ORDER BY ref.task
    `).all(id);
  }
  tasks(): WorkTask[] {
    const dependencies = new Map<string, string[]>();
    for (const row of this.db.query<{ task: string; dependency: string }, []>("SELECT task,dependency FROM work_dependencies ORDER BY rowid").all()) {
      const ids = dependencies.get(row.task) ?? []; ids.push(row.dependency); dependencies.set(row.task, ids);
    }
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM work_tasks WHERE id NOT IN (SELECT id FROM work_purged_tasks) ORDER BY created,id")
      .all().map(row => this.readTask(row, dependencies)!);
  }
  putTask(input: WorkTask): void {
    const { blocked_by: _blocked, next_target: _target, ...value } = WorkTask.parse(input);
    this.transaction(() => {
      this.db.query(`INSERT INTO work_tasks(id,title,description,revision,outcome,turn,plan,grants,project,parent,due,created,updated,tags,refs,workdir,model,gpus,timeout_minutes,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,revision=excluded.revision,outcome=excluded.outcome,turn=excluded.turn,plan=excluded.plan,grants=excluded.grants,
        project=excluded.project,parent=excluded.parent,due=excluded.due,updated=excluded.updated,tags=excluded.tags,
        refs=excluded.refs,workdir=excluded.workdir,model=excluded.model,gpus=excluded.gpus,timeout_minutes=excluded.timeout_minutes,updated_by=excluded.updated_by`).run(
        value.id, value.title, value.description, value.revision, value.outcome, JSON.stringify(value.turn), value.plan ? JSON.stringify(value.plan) : null, value.grants ? JSON.stringify(value.grants) : null, value.project ?? null, value.parent ?? null,
        value.due ?? null, value.created, value.updated, JSON.stringify(value.tags), JSON.stringify(value.references),
        value.workdir ?? null, value.model ?? null, value.gpus === undefined ? null : JSON.stringify(value.gpus), value.timeout_minutes ?? null, value.created_by, value.updated_by);
      this.db.query("DELETE FROM work_dependencies WHERE task=?").run(value.id);
      const insert = this.db.query("INSERT INTO work_dependencies(task,dependency) VALUES (?,?)");
      for (const dependency of value.dependencies) insert.run(value.id, dependency);
    });
  }
  comment(id: string): WorkComment | undefined {
    const row = this.db.query("SELECT * FROM work_comments WHERE id=?").get(id);
    return row ? WorkComment.parse(row) : undefined;
  }
  pendingGrant(task: string): PendingStageGrant | undefined {
    const row = this.db.query<{ job: string; stage: string | null; permissions: string }, [string]>(
      "SELECT job,stage,permissions FROM work_pending_grants WHERE task=?").get(task);
    return row ? { job: row.job, stage: row.stage ?? undefined, permissions: StagePermissions.parse(JSON.parse(row.permissions)) } : undefined;
  }
  putPendingGrant(task: string, grant?: PendingStageGrant): void {
    if (!grant) { this.db.query("DELETE FROM work_pending_grants WHERE task=?").run(task); return; }
    this.db.query(`INSERT INTO work_pending_grants(task,job,stage,permissions) VALUES(?,?,?,?)
      ON CONFLICT(task) DO UPDATE SET job=excluded.job,stage=excluded.stage,permissions=excluded.permissions`)
      .run(task, grant.job, grant.stage ?? null, JSON.stringify(StagePermissions.parse(grant.permissions)));
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
  latestJobs(): Map<string, string> {
    const rows = this.db.query<{ task: string; job: string }, []>(`SELECT execution.task, execution.job
      FROM work_executions AS execution
      JOIN (SELECT task, MAX(round) AS round FROM work_executions GROUP BY task) AS latest
      ON execution.task=latest.task AND execution.round=latest.round`).all();
    return new Map(rows.map(({ task, job }) => [task, job]));
  }
  putExecution(input: WorkExecution): void {
    const value = WorkExecution.parse(input);
    this.db.query(`INSERT INTO work_executions(job,task,round,input_revision,input_snapshot,created,applied)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(job) DO UPDATE SET applied=excluded.applied`).run(value.job, value.task, value.round, value.input_revision, value.input_snapshot, value.created, Number(value.applied));
  }
  turns(task: string): TaskTurnChange[] {
    return this.db.query<{ record: string }, [string]>("SELECT record FROM work_turns WHERE task=? ORDER BY rowid").all(task).map(row => TaskTurnChange.parse(JSON.parse(row.record)));
  }
  putTurn(input: TaskTurnChange): void {
    const value = TaskTurnChange.parse(input);
    this.db.query("INSERT INTO work_turns(task,record) VALUES (?,?)").run(value.task, JSON.stringify(value));
  }
  planTemplates(): PlanTemplate[] {
    return this.db.query<{ record: string }, []>("SELECT record FROM work_plan_templates ORDER BY rowid").all().map(row => PlanTemplate.parse(JSON.parse(row.record)));
  }
  putPlanTemplate(input: PlanTemplate): void {
    const value = PlanTemplate.parse(input);
    this.db.query("INSERT INTO work_plan_templates(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(value.id, JSON.stringify(value));
  }
  deletePlanTemplate(id: string): void { this.db.query("DELETE FROM work_plan_templates WHERE id=?").run(id); }
  trash(id: string): TrashItem | undefined {
    const row = this.db.query<{ record: string }, [string]>("SELECT record FROM work_trash WHERE id=?").get(id);
    return row ? TrashItem.parse(JSON.parse(row.record)) : undefined;
  }
  trashed(): TrashItem[] {
    return this.db.query<{ record: string }, []>("SELECT record FROM work_trash").all().map(row => TrashItem.parse(JSON.parse(row.record)));
  }
  putTrash(item: TrashItem): void {
    this.db.query("INSERT INTO work_trash VALUES (?,?)").run(item.id, JSON.stringify(TrashItem.parse(item)));
  }
  removeTrash(id: string): void { this.db.query("DELETE FROM work_trash WHERE id=?").run(id); }
  purge(item: TrashItem): void {
    const { id, kind } = item;
    this.db.query(`DELETE FROM work_requests WHERE json_extract(result,'$.kind') <> 'trashed' AND
      (json_extract(operation,'$.args.task')=? OR json_extract(operation,'$.args.project')=?
        OR json_extract(result,'$.task.id')=? OR json_extract(result,'$.project.id')=?)`).run(id, id, id, id);
    if (kind === "project") this.db.query("DELETE FROM work_projects WHERE id=?").run(id);
    else {
      // Preserve incoming foreign keys and round associations with a scrubbed, invisible ID row.
      for (const table of ["work_comments", "work_turns", "work_dependencies"]) this.db.query(`DELETE FROM ${table} WHERE task=?`).run(id);
      const epoch = "1970-01-01T00:00:00.000Z";
      this.db.query(`UPDATE work_tasks SET title='',description='',revision=1,outcome='cancelled',turn=?,plan=NULL,grants=NULL,
        project=NULL,parent=NULL,due=NULL,created=?,updated=?,tags='[]',refs='[]',workdir=NULL,model=NULL,gpus=NULL,
        timeout_minutes=NULL,created_by=NULL,updated_by=NULL WHERE id=?`)
        .run(JSON.stringify({ holder: "nobody", reason: "on_hold", since: epoch }), epoch, epoch, id);
      this.putPendingGrant(id);
      this.db.query("INSERT INTO work_purged_tasks VALUES (?)").run(id);
    }
    this.removeTrash(id);
  }
  receipt(actor: string, request: string): { operation: string; result: WorkCommandResult } | undefined {
    const row = this.db.query<{ operation: string; result: string }, [string, string]>("SELECT operation,result FROM work_requests WHERE actor=? AND request=?").get(actor, request);
    return row ? { operation: row.operation, result: WorkCommandResult.parse(JSON.parse(row.result)) } : undefined;
  }
  saveTrashReferenceCount(actor: string, request: string, count: number): void {
    this.db.query(`UPDATE work_requests SET result=json_set(result,'$.knowledge_references',?)
      WHERE actor=? AND request=? AND json_extract(result,'$.kind')='trashed'`).run(count, actor, request);
  }
  putReceipt(actor: string, request: string, operation: string, result: WorkCommandResult): void {
    const parsed = WorkCommandResult.parse(result);
    if (parsed.kind === "task") {
      const { blocked_by: _blocked, next_target: _target, ...task } = parsed.task;
      parsed.task = task;
    }
    this.db.query("INSERT INTO work_requests(actor,request,operation,result) VALUES (?,?,?,?)").run(actor, request, operation, JSON.stringify(parsed));
  }
}
