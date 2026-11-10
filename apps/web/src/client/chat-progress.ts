import { h, icon } from "./dom.ts";
import { t } from "./i18n.ts";

type Label = "Thinking process" | "Thinking summary";

/**
 * One turn's progress, kept across rendering its saved messages (ADR 0050).
 * Before any reasoning arrives a single status line says "waiting"; once a fragment arrives the
 * collapsed section's own summary carries the live state, so there is never a second status line.
 */
export class ChatProgress {
  private status = h("div", { class: "chat-progress-status", role: "status", hidden: true });
  readonly element = h("div", { class: "chat-progress", hidden: true }, this.status);
  private text?: Text;
  private summary?: HTMLElement;

  constructor(private readonly label: Label) {}

  waiting(): void {
    this.settle();
    this.text = this.summary = undefined;
    this.show("Waiting for model");
  }

  reasoning(delta: string, active = true): void {
    if (!delta) return;
    if (!this.text) {
      this.text = document.createTextNode("");
      this.summary = h("span", { class: "chat-progress-label" }, t(this.label));
      const section = h("details", { class: "chat-thought" },
        h("summary", {}, icon("chevron"), this.summary), h("pre", {}, this.text));
      this.status.before(section);
    }
    this.text.appendData(delta);
    this.element.hidden = false;
    if (active) {
      this.status.hidden = true;
      this.summary!.classList.add("active");
      this.summary!.textContent = t("Thinking");
    }
  }

  finish(): void {
    this.status.hidden = true;
    this.settle();
    this.element.hidden = this.element.childElementCount === 1;
    this.text = this.summary = undefined;
  }

  /** The live label goes back to the section name once this model call stops thinking. */
  private settle(): void {
    if (!this.summary?.classList.contains("active")) return;
    this.summary.classList.remove("active");
    this.summary.textContent = t(this.label);
  }

  private show(label: "Waiting for model"): void {
    const text = t(label);
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.classList.add("active");
    this.status.hidden = false;
    this.element.hidden = false;
  }
}
