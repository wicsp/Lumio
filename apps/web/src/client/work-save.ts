import type { WorkTask, WorkProject, WorkCommandRequest, WorkCommandResult } from "@lumio/schema";
import { workPatchCommand } from "./commands.ts";
export type WorkRecord = WorkTask | WorkProject;
export interface WorkDraft { base: WorkRecord; title: string; description: string; pending?: WorkCommandRequest; properties?: Record<string, unknown> }

/** One queue for title and body; requests are immutable until their outcome is known. */
export class WorkSave {
  title: string;
  description: string;
  pending?: WorkCommandRequest;
  properties: Record<string, unknown> = {};
  error?: unknown;
  private flight?: Promise<boolean>;
  constructor(public base: WorkRecord, private client: { workCommand(request: WorkCommandRequest): Promise<WorkCommandResult> }, private notify: () => void) {
    this.title = base.title; this.description = base.description;
  }
  get dirty(): boolean { return Object.keys(this.properties).length > 0 || !!this.pending || this.title.trim() !== this.base.title || this.description !== this.base.description; }
  get saving(): boolean { return !!this.flight; }
  get snapshot(): WorkDraft { return { base: this.base, title: this.title, description: this.description, properties: this.properties, ...(this.pending ? { pending: this.pending } : {}) }; }
  change(title: string, description: string): void {
    this.title = title; this.description = description;
    if ((this.error as { code?: string })?.code === "INVALID") this.error = undefined;
    this.notify();
  }
  property(key: string, value: unknown): void { this.properties = { ...this.properties, [key]: value }; if ((this.error as {code?:string})?.code === "INVALID") this.error = undefined; this.notify(); }
  accept(base: WorkRecord): void {
    if (this.title.trim() === this.base.title) this.title = base.title;
    if (this.description === this.base.description) this.description = base.description;
    this.base = base; this.notify();
  }
  rebase(base: WorkRecord): void { this.base = base; this.pending = undefined; this.error = undefined; this.notify(); }
  save(): Promise<boolean> {
    if (this.flight) return this.flight;
    this.error = undefined;
    const run = async () => {
      while (this.dirty) {
        if (!this.title.trim()) { this.error = { code: "INVALID", message: "Title can't be empty" }; return false; }
        // The existing contract requires description and structured fields in separate patches.
        this.pending ??= workPatchCommand(this.base, { ...this.properties, title: this.title.trim() }) ?? workPatchCommand(this.base, { description: this.description });
        if (!this.pending) { this.properties = {}; return true; }
        this.notify();
        try {
          const result = await this.client.workCommand(this.pending);
          if (result.kind !== "task" && result.kind !== "project") throw new Error("unexpected result");
          this.base = result.kind === "task" ? result.task : result.project;
          const operation = this.pending.operation;
          if (operation.op === "work.task.update" || operation.op === "work.project.update") {
            for (const [key, value] of Object.entries(this.properties)) {
              if (JSON.stringify(value) === JSON.stringify((operation.args.patch as Record<string, unknown>)[key]) || JSON.stringify(value ?? null) === JSON.stringify((this.base as Record<string, unknown>)[key] ?? null)) delete this.properties[key];
            }
          }
          this.pending = undefined;
          this.notify();
        } catch (error) {
          this.error = error;
          if (["INVALID", "CONFLICT", "FORBIDDEN"].includes((error as { code?: string }).code ?? "")) this.pending = undefined;
          return false;
        }
      }
      return true;
    };
    this.flight = run().finally(() => { this.flight = undefined; this.notify(); });
    this.notify(); return this.flight;
  }
}
