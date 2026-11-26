import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { IMAGE_UPLOAD_MAX_BYTES, type ImageHostingSettings } from "@lumio/schema";
import { errorText } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n.ts";
import type { NoteImageQueue, PendingNoteImage } from "./note-image-queue.ts";

export interface NoteImageUpload {
  settings(): Promise<ImageHostingSettings>;
  queue: NoteImageQueue;
}

const redraw = StateEffect.define<null>();

class LocalImagePreview extends WidgetType {
  private readonly state: PendingNoteImage["state"];
  private readonly error: unknown;

  constructor(private readonly image: PendingNoteImage, private readonly queue: NoteImageQueue) {
    super();
    this.state = image.state;
    this.error = image.error;
  }

  override eq(other: LocalImagePreview): boolean {
    return other.image === this.image && other.state === this.state && other.error === this.error;
  }

  toDOM(): HTMLElement {
    const label = this.image.file.name || t("Image preview");
    const canvas = h("canvas", { class: "note-image-preview-canvas", role: "img", "aria-label": label, hidden: true });
    const alt = h("span", { class: "muted" }, label);
    // Decode directly into a canvas so the local file needs no URL or CSP exception.
    if (typeof createImageBitmap === "function") void createImageBitmap(this.image.file).then(bitmap => {
      try {
        const context = canvas.getContext("2d");
        if (!context) return;
        const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        canvas.hidden = false;
        alt.hidden = true;
      } finally { bitmap.close(); }
    }).catch(() => { /* The filename remains visible if this format cannot be decoded locally. */ });
    const status = this.state === "failed" ? t("Image upload failed: {0}", errorText(this.error))
      : this.state === "queued" ? t("Image waiting to upload") : t("Uploading image in the background…");
    const controls = h("div", { class: "note-image-preview-actions" },
      h("span", { class: "field-hint", role: "status" }, status),
      this.state === "failed" && h("button", { type: "button", class: "btn btn-small", onclick: () => this.queue.retry(this.image) }, t("Retry upload")),
      h("button", { type: "button", class: "btn btn-small", onclick: () => this.queue.remove(this.image) }, t("Remove image")));
    return h("div", { class: "note-image-preview" }, canvas, alt, controls);
  }

  override ignoreEvent(): boolean { return true; }
}

export class NoteImages {
  readonly element: HTMLElement;
  private readonly input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", multiple: true, hidden: true });
  private readonly status = h("span", { class: "field-hint", role: "status" });
  private readonly settings = h("a", { class: "btn btn-small", href: "#settings/data", hidden: true }, t("Configure image hosting"));
  private readonly button = h("button", { type: "button", class: "btn btn-small", disabled: true }, t("Insert image"));
  private enabled = false;
  private disposed = false;
  private settingsRequest = 0;
  private disconnect?: () => void;

  constructor(private readonly upload: NoteImageUpload, private readonly editor: () => EditorView) {
    this.element = h("div", { class: "note-image-controls" }, this.button, this.input, this.settings, this.status);
    this.button.addEventListener("click", () => this.input.click());
    this.input.addEventListener("change", () => {
      const files = [...(this.input.files ?? [])];
      this.input.value = "";
      this.start(files, this.editor().state.selection.main.head);
    });
    void this.refreshSettings();
  }

  async refreshSettings(): Promise<void> {
    if (this.disposed) return;
    const request = ++this.settingsRequest;
    try {
      const settings = await this.upload.settings();
      if (this.disposed || request !== this.settingsRequest) return;
      this.enabled = !!settings.destination;
      this.button.disabled = !this.enabled;
      this.button.hidden = !this.enabled;
      this.settings.hidden = this.enabled;
      this.status.textContent = "";
    } catch (cause) {
      if (!this.disposed && request === this.settingsRequest) this.status.textContent = errorText(cause);
    }
  }

  connect(): void {
    const view = this.editor();
    this.disconnect = this.upload.queue.connect({
      redraw: () => view.dispatch({ effects: redraw.of(null) }),
      insert: ({ from, insert, next }) => {
        const selection = view.state.selection.main;
        view.dispatch({
          changes: { from, insert },
          ...(selection.empty && selection.head === from ? { selection: { anchor: next } } : {}),
          userEvent: "input.paste",
        });
      },
    });
  }

  get extension() {
    const queue = this.upload.queue;
    const decorations = () => {
      const ranges: Range<Decoration>[] = queue.pending.map(image =>
        Decoration.widget({ widget: new LocalImagePreview(image, queue), block: true, side: 1 }).range(image.position));
      return Decoration.set(ranges, true);
    };
    const field = StateField.define<DecorationSet>({
      create: decorations,
      update: (value, transaction) => transaction.effects.some(effect => effect.is(redraw)) ? decorations() : value.map(transaction.changes),
      provide: field => EditorView.decorations.from(field),
    });
    return [
      field,
      EditorView.updateListener.of(update => { if (update.docChanged) queue.map(update.changes); }),
      EditorView.domEventHandlers({
        paste: (event, view) => this.start([...(event.clipboardData?.files ?? [])], view.state.selection.main.head),
        drop: (event, view) => this.start([...(event.dataTransfer?.files ?? [])],
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head),
      }),
    ];
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect?.();
  }

  private start(inputs: File[], position: number): boolean {
    const files = inputs.filter(file => file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(file.name));
    if (!files.length || !this.enabled || this.disposed) return false;
    const view = this.editor();
    if (view.state.readOnly) return false;
    if (files.some(file => !file.size || file.size > IMAGE_UPLOAD_MAX_BYTES)) {
      this.status.textContent = t("Each image must be between 1 byte and 10 MiB.");
      return true;
    }
    this.status.textContent = "";
    const line = view.state.doc.lineAt(position);
    this.upload.queue.add(files, position === line.from ? line.from : line.to);
    return true;
  }
}
