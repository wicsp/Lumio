import { h } from "./dom.ts";
import { t } from "./i18n.ts";

/** One turn's progress, kept across rendering its saved messages. */
export class ChatProgress {
  private status = h("div", { class: "chat-progress-status", role: "status", hidden: true });
  readonly element = h("div", { class: "chat-progress", hidden: true }, this.status);
  private text?: Text;

  constructor(private readonly label: "Thinking process" | "Thinking summary") {}

  waiting(): void {
    this.text = undefined;
    this.show("Waiting for model");
  }

  reasoning(delta: string, active = true): void {
    if (!delta) return;
    if (!this.text) {
      this.text = document.createTextNode("");
      this.element.append(h("details", {}, h("summary", {}, t(this.label)), h("pre", {}, this.text)));
    }
    this.text.appendData(delta);
    this.element.hidden = false;
    if (active) this.show("Thinking");
  }

  finish(): void {
    this.status.hidden = true;
    this.element.hidden = this.element.childElementCount === 1;
    this.text = undefined;
  }

  private show(label: "Waiting for model" | "Thinking"): void {
    const text = t(label);
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.hidden = false;
    this.element.hidden = false;
  }
}
