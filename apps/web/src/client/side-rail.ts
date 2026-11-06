import { clear, h } from "./dom.ts";

/**
 * A slim rail of ticks on the side of a scrolling view: messages in a thread or chat, or an article's headings.
 * Collapsed it is a column of short marks whose widths follow the level (the "wave"); hovering or focusing it
 * opens a small panel with the labels. The current position is tracked while scrolling; clicks scroll smoothly.
 */
export interface RailEntry {
  label: string;
  /** Accessible name when it should say more than the visible label. */
  description?: string;
  /** 1 = widest mark. Headings use their level; messages use 1–3 from their length. */
  level: number;
  /** Viewport y of the entry's top edge. */
  top(): number;
  jump(): void;
}

const MIN_ENTRIES = 2;

export class SideRail {
  readonly element: HTMLElement;
  private list = h("ol", {});
  private items: Array<{ entry: RailEntry; button: HTMLButtonElement }> = [];
  private selected = -1;
  private frame = 0;
  private resize: ResizeObserver;
  /**
   * After a click the clicked entry stays current through the smooth scroll and until the reader scrolls again,
   * even if the target can't reach the top (e.g. a short last section at the end of the page).
   */
  private pinned?: { index: number; settled: boolean; timer?: ReturnType<typeof setTimeout> };

  constructor(private scroller: HTMLElement, private entries: () => RailEntry[], label: string, kind: "messages" | "outline") {
    this.element = h("nav", { class: `side-rail side-rail-${kind}`, hidden: true, "aria-label": label }, this.list);
    this.resize = new ResizeObserver(this.schedule);
    this.resize.observe(scroller);
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    this.refresh();
  }

  refresh(): void {
    const entries = this.entries();
    this.items = entries.map((entry, index) => {
      const button = h("button", { type: "button", class: "side-rail-item", "data-level": String(Math.min(Math.max(entry.level, 1), 3)), "aria-label": entry.description ?? entry.label,
        onclick: () => { this.pin(index); entry.jump(); } },
      h("span", { class: "side-rail-label" }, entry.label), h("span", { class: "side-rail-tick", "aria-hidden": "true" }));
      return { entry, button };
    });
    this.element.hidden = this.items.length < MIN_ENTRIES;
    this.selected = -1;
    if (this.pinned && this.pinned.index >= this.items.length) this.pinned = undefined;
    clear(this.list, ...this.items.map(({ button }) => h("li", {}, button)));
    this.schedule();
  }

  private pin(index: number): void {
    clearTimeout(this.pinned?.timer);
    this.pinned = { index, settled: false };
    this.select(index);
  }

  private onScroll = (): void => {
    const pinned = this.pinned;
    if (pinned) {
      if (pinned.settled) { this.pinned = undefined; }
      else { clearTimeout(pinned.timer); pinned.timer = setTimeout(() => { pinned.settled = true; }, 160); }
    }
    this.schedule();
  };

  private schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  };

  private update(): void {
    if (this.element.hidden || !this.scroller.clientHeight || !this.items.length) return;
    if (this.pinned) { this.select(this.pinned.index); return; }
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    if (scrollTop > 0 && scrollTop >= scrollHeight - clientHeight - 2) { this.select(this.items.length - 1); return; }
    const line = this.scroller.getBoundingClientRect().top + Math.min(96, clientHeight / 3);
    let index = 0;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i]!.entry.top() > line) break;
      index = i;
    }
    this.select(index);
  }

  private select(index: number): void {
    if (this.selected === index) return;
    this.items[this.selected]?.button.removeAttribute("aria-current");
    const button = this.items[index]?.button;
    if (!button) return;
    button.setAttribute("aria-current", "location");
    this.selected = index;
    // Keep the current mark visible when the rail itself has to scroll (long threads).
    const rail = this.list.getBoundingClientRect(), mark = button.getBoundingClientRect();
    if (mark.top < rail.top) this.list.scrollTop += mark.top - rail.top;
    else if (mark.bottom > rail.bottom) this.list.scrollTop += mark.bottom - rail.bottom;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    clearTimeout(this.pinned?.timer);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.element.remove();
  }
}

/** Scroll so that `target` sits a little below the scroller's top edge. */
export function scrollToTarget(scroller: HTMLElement, target: HTMLElement, offset = 16): void {
  const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  scroller.scrollTo({ top: Math.max(0, top), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/** Message rail over a list whose children come and go (streaming chat, thread refresh). */
export class MessageRail {
  private rail: SideRail;
  private observer: MutationObserver;
  constructor(scroller: HTMLElement, messages: HTMLElement, selector: string, label: string, describe: (index: number, excerpt: string) => string) {
    this.rail = new SideRail(scroller, () => [...messages.querySelectorAll<HTMLElement>(selector)].map((target, index) => {
      const text = (target.querySelector(".markdown") ?? target).textContent?.trim().replace(/\s+/g, " ") ?? "";
      return { label: text.slice(0, 80), description: describe(index, text.slice(0, 80)), level: text.length > 240 ? 1 : text.length > 60 ? 2 : 3,
        top: () => target.getBoundingClientRect().top, jump: () => scrollToTarget(scroller, target) };
    }), label, "messages");
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => this.rail.refresh(), 60); });
    this.observer.observe(messages, { childList: true });
  }
  get element(): HTMLElement { return this.rail.element; }
  dispose(): void { this.observer.disconnect(); this.rail.dispose(); }
}
