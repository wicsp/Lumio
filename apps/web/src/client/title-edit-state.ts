import { t } from "./i18n.ts";
/** Title edits commit independently from the surrounding property/body drafts. */
export class TitleValidationError extends Error {
  readonly code = "INVALID";
  constructor() { super(t("Title can't be empty")); }
}

export class TitleEditState {
  draft: string;
  editing = false;
  saving = false;
  error?: unknown;
  constructor(public saved: string, private commit: (title: string) => Promise<string>) { this.draft = saved; }
  get dirty(): boolean { return this.editing && this.draft !== this.saved; }
  begin(): void { if (!this.saving) { this.draft = this.saved; this.error = undefined; this.editing = true; } }
  cancel(): void { if (!this.saving) { this.draft = this.saved; this.error = undefined; this.editing = false; } }
  async save(): Promise<boolean> {
    if (!this.editing || this.saving) return false;
    const title = this.draft.trim();
    if (!title) { this.error = new TitleValidationError(); return false; }
    if (title === this.saved) { this.cancel(); return true; }
    this.saving = true; this.error = undefined;
    try { this.saved = await this.commit(title); this.draft = this.saved; this.editing = false; return true; }
    catch (error) { this.error = error; return false; }
    finally { this.saving = false; }
  }
}
