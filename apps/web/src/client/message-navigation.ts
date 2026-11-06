import { clear, h } from "./dom.ts";
import { t } from "./i18n.ts";

/** A rail of message jumps alongside an independently scrolling conversation. */
export class MessageNavigation {
  readonly element = h("nav", { class: "message-nav", hidden: true, "aria-label": t("Jump to a message") });
  private entries: Array<{ target: HTMLElement; button: HTMLButtonElement }> = [];
  private selected = -1;
  private observer: MutationObserver;
  private resize: ResizeObserver;

  constructor(private scroller: HTMLElement, private messages: HTMLElement, private selector: string) {
    this.observer = new MutationObserver(() => this.render());
    this.observer.observe(messages, { childList: true });
    this.resize = new ResizeObserver(this.update);
    this.resize.observe(scroller);
    this.resize.observe(messages);
    scroller.addEventListener("scroll", this.update, { passive: true });
    this.render();
  }

  private render(): void {
    this.entries = [...this.messages.querySelectorAll<HTMLElement>(this.selector)].map((target, index) => {
      const content = target.querySelector(".markdown") ?? target;
      const excerpt = content.textContent?.trim().replace(/\s+/g, " ").slice(0, 100) ?? "";
      const label = t("Message {0}: {1}", index + 1, excerpt);
      const button = h("button", { type: "button", title: label, "aria-label": label, onclick: () => {
        this.scroller.scrollTop = this.position(target);
        this.select(index);
      } });
      return { target, button };
    });
    this.element.hidden = this.entries.length < 2;
    this.selected = -1;
    clear(this.element, ...this.entries.map(({ button }) => button));
    this.update();
  }

  private update = (): void => {
    if (this.element.hidden || !this.scroller.clientHeight) return;
    const current = this.entries[this.selected]?.target;
    if (current && Math.abs(this.position(current) - this.scroller.scrollTop) < 1) return;
    if (this.scroller.scrollTop > 0 && this.scroller.scrollTop >= this.scroller.scrollHeight - this.scroller.clientHeight - 1) {
      this.select(this.entries.length - 1);
      return;
    }
    const top = this.scroller.getBoundingClientRect().top + 16;
    let index = 0;
    for (let i = 1; i < this.entries.length; i++) {
      if (this.entries[i]!.target.getBoundingClientRect().top > top) break;
      index = i;
    }
    this.select(index);
  };

  private position(target: HTMLElement): number {
    const offset = target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
    return Math.max(0, Math.min(this.scroller.scrollTop + offset - 12, this.scroller.scrollHeight - this.scroller.clientHeight));
  }

  private select(index: number): void {
    if (this.selected === index) return;
    this.entries[this.selected]?.button.removeAttribute("aria-current");
    const button = this.entries[index]!.button;
    button.setAttribute("aria-current", "location");
    const rail = this.element.getBoundingClientRect(), marker = button.getBoundingClientRect();
    if (marker.top < rail.top) this.element.scrollTop += marker.top - rail.top;
    else if (marker.bottom > rail.bottom) this.element.scrollTop += marker.bottom - rail.bottom;
    this.selected = index;
  }

  dispose(): void {
    this.observer.disconnect();
    this.resize.disconnect();
    this.scroller.removeEventListener("scroll", this.update);
    this.element.remove();
  }
}
