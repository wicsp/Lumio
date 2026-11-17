import { StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { IMAGE_UPLOAD_MAX_BYTES, type ImageHostingSettings, type ImageUploadResult } from "@lumio/schema";
import { errorText } from "./api.ts";
import { h } from "./dom.ts";
import { t } from "./i18n.ts";
import { imageMarkdown, noteImageInsert } from "./utils/markdown-images.ts";

export interface NoteImageUpload {
  settings(): Promise<ImageHostingSettings>;
  send(file: File, signal: AbortSignal): Promise<ImageUploadResult>;
}

const mark = StateEffect.define<number | null>();
const pending = StateField.define<number | null>({
  create: () => null,
  update(position, transaction) {
    for (const effect of transaction.effects) if (effect.is(mark)) return effect.value;
    return position === null ? null : transaction.changes.mapPos(position, 1);
  },
});

export class NoteImages {
  readonly element: HTMLElement;
  private readonly input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", multiple: true, hidden: true });
  private readonly status = h("span", { class: "field-hint", role: "status" });
  private readonly button = h("button", { type: "button", class: "btn btn-small", disabled: true }, t("Insert image"));
  private readonly abort = new AbortController();
  private enabled = false;
  private busy = false;
  private destination = "";

  constructor(private readonly upload: NoteImageUpload, private readonly editor: () => EditorView) {
    this.element = h("div", { class: "note-image-controls" }, this.button, this.input, this.status);
    this.button.addEventListener("click", () => this.input.click());
    this.input.addEventListener("change", () => {
      const files = [...(this.input.files ?? [])];
      this.input.value = "";
      this.start(files, this.editor().state.selection.main.head);
    });
    void upload.settings().then(settings => {
      if (this.abort.signal.aborted) return;
      this.enabled = !!settings.destination;
      this.destination = settings.destination?.label ?? "";
      this.button.disabled = !this.enabled;
      this.status.textContent = this.enabled ? t("Uploads to {0}", this.destination) : t("Configure an upload destination in Image hosting settings.");
    }).catch(cause => {
      if (!this.abort.signal.aborted) this.status.textContent = errorText(cause);
    });
  }

  get extension() {
    return [pending, EditorView.domEventHandlers({
      paste: (event, view) => this.start([...(event.clipboardData?.files ?? [])], view.state.selection.main.head),
      drop: (event, view) => this.start([...(event.dataTransfer?.files ?? [])],
        view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head),
    })];
  }

  dispose(): void { this.abort.abort(); }

  private start(inputs: File[], position: number): boolean {
    const files = inputs.filter(file => file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(file.name));
    if (!files.length || !this.enabled) return false;
    const view = this.editor();
    if (view.state.readOnly || this.abort.signal.aborted) return false;
    if (this.busy) {
      this.status.textContent = t("Wait for the current image upload.");
      return true;
    }
    if (files.some(file => !file.size || file.size > IMAGE_UPLOAD_MAX_BYTES)) {
      this.status.textContent = t("Each image must be between 1 byte and 10 MiB.");
      return true;
    }
    this.busy = true;
    this.button.disabled = true;
    view.dispatch({ effects: mark.of(position) });
    void this.run(files, view);
    return true;
  }

  private async run(files: File[], view: EditorView): Promise<void> {
    const signal = this.abort.signal;
    let completed = 0;
    try {
      for (const file of files) {
        this.status.textContent = t("Uploading image {0} of {1} to {2}…", completed + 1, files.length, this.destination);
        const result = await this.upload.send(file, signal);
        if (signal.aborted || view.state.readOnly) return;
        const at = view.state.field(pending);
        if (at === null) return;
        const change = noteImageInsert(view.state.doc.lineAt(at), at, view.state.doc.length, imageMarkdown(file.name, result.url));
        view.dispatch({ changes: { from: change.from, insert: change.insert }, effects: mark.of(change.next), userEvent: "input.paste" });
        completed++;
      }
      this.status.textContent = t("Images inserted.");
    } catch (cause) {
      if (!signal.aborted) this.status.textContent = t("Inserted {0} of {1}. {2}", completed, files.length, errorText(cause));
    } finally {
      if (!signal.aborted) {
        view.dispatch({ effects: mark.of(null) });
        this.button.disabled = !this.enabled;
        this.busy = false;
      }
    }
  }
}
