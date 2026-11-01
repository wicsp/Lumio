import { errorText } from "./api.ts";
import { h } from "./dom.ts";
import { TitleEditState, TitleValidationError } from "./title-edit-state.ts";

/** A heading remains a heading; pointer, keyboard and touch each have an edit entry. */
export class InlineTitle {
  readonly element = h("div", { class: "inline-title" });
  private state: TitleEditState;
  private input = h("input", { name: "edit-title", required: true, "aria-label": "标题", autocomplete: "off" });
  private label = h("button", { type: "button", class: "title-label", title: "双击修改标题，也可按 Enter 或 F2" });
  private edit = h("button", { type: "button", class: "btn btn-ghost btn-small", "aria-label": "编辑标题", onclick: () => this.begin() }, "编辑");
  private heading = h("div", { class: "title-display" }, h("h2", {}, this.label), this.edit);
  private save = h("button", { type: "submit", class: "btn btn-small btn-primary" }, "保存标题");
  private cancel = h("button", { type: "button", class: "btn btn-small", onclick: () => this.discard() }, "取消");
  private message = h("p", { class: "title-message", role: "alert", hidden: true });
  private form = h("form", { class: "title-form", hidden: true }, this.input,
    h("div", { class: "button-row" }, this.save, this.cancel, h("span", { class: "field-hint" }, "Enter 保存 · Esc 取消")), this.message);
  private externalBusy = false;
  constructor(value: string, commit: (title: string) => Promise<string>) {
    this.state = new TitleEditState(value, commit);
    this.label.addEventListener("dblclick", () => this.begin());
    this.label.addEventListener("click", event => { if (event.detail === 0) this.begin(); });
    this.label.addEventListener("keydown", event => { if (event.key === "F2") { event.preventDefault(); this.begin(); } });
    this.input.addEventListener("input", () => { this.state.draft = this.input.value; });
    this.input.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.discard(); }
      if (event.key === "Enter" && event.isComposing) event.preventDefault();
    });
    this.form.addEventListener("submit", async event => {
      event.preventDefault(); if (this.externalBusy || this.state.saving) return;
      this.state.draft = this.input.value;
      const pending = this.state.save(); this.render();
      const saved = await pending; this.render();
      if (saved) this.label.focus(); else this.input.focus();
    });
    this.element.append(this.heading, this.form); this.render();
  }
  get value(): string { return this.state.editing ? this.state.draft : this.state.saved; }
  get dirty(): boolean { return this.state.dirty; }
  setBusy(value: boolean): void { this.externalBusy = value; this.render(); }
  discard(): void { if (!this.externalBusy && !this.state.saving) { this.state.cancel(); this.render(); this.label.focus(); } }
  private begin(): void {
    if (this.externalBusy || this.state.saving || this.state.editing) return;
    this.state.begin(); this.render(); this.input.focus(); this.input.select();
  }
  private render(): void {
    this.label.textContent = this.state.saved;
    this.heading.hidden = this.state.editing; this.form.hidden = !this.state.editing;
    if (this.input.value !== this.state.draft) this.input.value = this.state.draft;
    this.input.disabled = this.state.saving;
    this.save.disabled = this.cancel.disabled = this.edit.disabled = this.label.disabled = this.externalBusy || this.state.saving;
    this.message.hidden = !this.state.error;
    this.message.textContent = this.state.error instanceof TitleValidationError ? this.state.error.message : this.state.error ? `${errorText(this.state.error)}。标题草稿已保留。` : "";
  }
}
