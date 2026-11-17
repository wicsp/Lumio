import { Text, type ChangeDesc } from "@codemirror/state";
import type { ImageUploadResult } from "@lumio/schema";
import { imageMarkdown, noteImageInsert } from "./utils/markdown-images.ts";

export interface PendingNoteImage {
  readonly file: File;
  position: number;
  state: "queued" | "uploading" | "failed";
  error?: unknown;
}

type ImageJob = PendingNoteImage & { controller: AbortController };
type ImageChange = ReturnType<typeof noteImageInsert>;

interface ImageEditor {
  redraw(): void;
  insert(change: ImageChange): void;
}

/** One queue per note. It keeps files and positions even when the editor is closed. */
export class NoteImageQueue {
  private readonly jobs = new Set<ImageJob>();
  private editor?: ImageEditor;
  private running = false;
  private disposed = false;

  constructor(
    private readonly upload: (file: File, signal: AbortSignal) => Promise<ImageUploadResult>,
    private readonly readBody: () => string,
    private readonly updateBody: (body: string) => void,
    private readonly inserted: () => void,
    private readonly changed: () => void,
  ) {}

  get pending(): readonly PendingNoteImage[] { return [...this.jobs]; }
  get hasPending(): boolean { return this.jobs.size > 0; }

  connect(editor: ImageEditor): () => void {
    this.editor = editor;
    return () => { if (this.editor === editor) this.editor = undefined; };
  }

  add(files: readonly File[], position: number): void {
    if (this.disposed) return;
    for (const file of files) this.jobs.add({ file, position, state: "queued", controller: new AbortController() });
    this.publish();
    void this.run();
  }

  map(changes: ChangeDesc): void {
    for (const job of this.jobs) job.position = changes.mapPos(job.position, 1);
  }

  retry(image: PendingNoteImage): void {
    const job = image as ImageJob;
    if (!this.jobs.has(job) || job.state !== "failed") return;
    job.state = "queued";
    job.error = undefined;
    this.publish();
    void this.run();
  }

  remove(image: PendingNoteImage): void {
    const job = image as ImageJob;
    if (!this.jobs.delete(job)) return;
    job.controller.abort();
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.editor = undefined;
    for (const job of this.jobs) job.controller.abort();
    this.jobs.clear();
  }

  private publish(): void {
    this.editor?.redraw();
    this.changed();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = [...this.jobs].find(image => image.state === "queued");
        if (!job) return;
        job.state = "uploading";
        this.publish();
        let result: ImageUploadResult;
        try { result = await this.upload(job.file, job.controller.signal); }
        catch (cause) {
          if (this.jobs.has(job)) {
            job.state = "failed";
            job.error = cause;
            this.publish();
          }
          continue;
        }
        if (!this.jobs.has(job)) continue;
        this.insert(job, result.url);
        this.jobs.delete(job);
        this.inserted();
        this.publish();
      }
    } finally { this.running = false; }
  }

  private insert(job: ImageJob, url: string): void {
    const doc = Text.of(this.readBody().split(/\r\n?|\n/));
    const position = Math.min(job.position, doc.length);
    const change = noteImageInsert(doc.lineAt(position), position, doc.length, imageMarkdown(job.file.name, url));
    if (this.editor) {
      this.editor.insert(change);
      return;
    }
    const { from, insert } = change;
    for (const pending of this.jobs) if (pending.position >= from) pending.position += insert.length;
    this.updateBody(doc.sliceString(0, from) + insert + doc.sliceString(from));
  }
}
