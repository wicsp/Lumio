import { h, isTypingControl, openMenu, type MenuItem } from "./dom.ts";
import { HOLD_MS, type PadInput } from "./gamepad-input.ts";
import { focusListItem, nextListItem, visibleItems } from "./list-keys.ts";
import { t } from "./i18n.ts";

const ROWS = "[data-pad-row], .row[data-id]";
const DIALOG_ITEMS = "button, summary";
const ACTIONS = "[data-pad-action]";

interface Navigation {
  pane(): HTMLElement | undefined;
  back(): void;
  section(step: number): void;
  palette(): void;
  delegate(id: string): void;
  paletteAction(step?: number): void;
}

interface Hold {
  target: HTMLElement;
  focus: Element | null;
  started: number;
  progress: HTMLProgressElement;
  tip: HTMLElement;
}

export class GamepadNavigation {
  private cursor?: { scope: HTMLElement; key: string };
  private detail?: HTMLElement;
  private hold?: Hold;
  private frame?: number;

  constructor(private view: Navigation) {}

  reset(): void {
    this.cancelHold();
    this.cursor = undefined;
    this.detail = undefined;
  }

  handle(input: PadInput): void {
    if (input.phase === "reset") { this.reset(); return; }
    const active = document.activeElement as HTMLElement | null;
    const dialog = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
    const menu = document.querySelector<HTMLElement>(".menu");
    const typing = isTypingControl(active);
    if (input.phase === "scroll") {
      if (!typing && !this.hold) this.scroll(input.x, input.y, dialog);
      return;
    }

    const { command, phase } = input;
    if (phase === "release") {
      if (command === "activate") this.cancelHold();
      return;
    }
    if (typing) {
      this.cancelHold();
      if (phase === "press" && command === "back") {
        active?.blur();
        // Keep the decision card in focus when leaving its reason/answer field.
        const row = active?.closest<HTMLElement>(ROWS);
        if (row) focusListItem(row);
      }
      return;
    }

    if (phase === "hold") {
      if (command !== "activate" || !this.hold) return;
      const { target, focus } = this.hold;
      const valid = this.canActivate(target) && active === focus && this.primary(dialog) === target
        && !menu && document.hasFocus() && document.visibilityState === "visible";
      this.cancelHold();
      if (valid) target.click();
      return;
    }
    if (this.hold) this.cancelHold();
    if (command === "back") {
      if (menu) this.menuKey(menu, "Escape");
      else if (dialog) dialog.close();
      else {
        const pane = this.view.pane();
        const back = pane?.querySelector<HTMLElement>(".split.has-detail [data-pad-back], [data-pad-back]:not(.mobile-only)");
        if (back) {
          const row = pane && visibleItems(pane, ".row.is-selected")[0];
          this.detail = undefined;
          back.click();
          if (row && this.canActivate(row)) focusListItem(row);
        } else this.view.back();
      }
      return;
    }

    const step = command === "up" || command === "left" ? -1 : command === "down" || command === "right" ? 1 : 0;
    if (menu) {
      if (step) this.menuKey(menu, step < 0 ? "ArrowUp" : "ArrowDown");
      else if (command === "activate") this.menuKey(menu, "Enter");
      return;
    }
    if (dialog?.classList.contains("palette")) {
      if (step) this.view.paletteAction(step);
      else if (command === "activate") this.view.paletteAction();
      return;
    }
    if (step) { this.move(step, dialog); return; }
    if (command === "activate") { this.activate(this.primary(dialog)); return; }
    if (dialog) return;
    if (command === "previous" || command === "next") this.view.section(command === "previous" ? -1 : 1);
    else if (command === "palette") this.view.palette();
    else if (command === "more") this.more();
    else if (command === "delegate") {
      const row = this.current();
      const root = row?.closest(".today-row-wrap") ?? row ?? this.view.pane();
      const action = root?.querySelector<HTMLElement>('[data-pad-action="delegate"]');
      if (action) this.activate(action);
      else if (row?.dataset.id?.startsWith("task_")) this.view.delegate(row.dataset.id);
    }
  }

  move(step: number, dialog?: HTMLDialogElement): boolean {
    const pane = this.view.pane();
    const scope = dialog ?? pane;
    if (!scope) return false;
    const items = this.items(scope, !!dialog);
    const next = nextListItem(items, this.current(dialog, items), step);
    if (!next) return false;
    if (!dialog && this.detail && !this.detail.contains(next)) this.detail = undefined;
    this.focus(scope, next);
    return true;
  }

  private items(scope: HTMLElement, dialog: boolean): HTMLElement[] {
    if (dialog) return visibleItems(scope, DIALOG_ITEMS);
    const detail = scope.querySelector<HTMLElement>(".split.has-detail .detail-pane, .split.has-detail .work-detail-layout");
    if (detail && (this.detail === scope || detail.contains(document.activeElement))) {
      const items = visibleItems(detail, ROWS);
      if (items.length) return items;
      const primary = visibleItems(detail, '[data-pad-action="primary"], [data-pad-action="delegate"]');
      return primary;
    }
    return visibleItems(scope, ROWS);
  }

  private current(dialog?: HTMLDialogElement, items?: HTMLElement[]): HTMLElement | undefined {
    const scope = dialog ?? this.view.pane();
    if (!scope) return undefined;
    const rows = items ?? this.items(scope, !!dialog);
    const active = rows.find(row => row === document.activeElement || row.contains(document.activeElement));
    if (active) return active;
    // When a silent refresh replaces a row, recover only that row by its stable ID.
    const key = this.cursor?.scope === scope ? this.cursor.key : undefined;
    if (document.activeElement !== document.body && document.activeElement !== scope && document.activeElement?.id !== "content") return undefined;
    return key ? rows.find(row => this.key(row) === key) : undefined;
  }

  private key(item: HTMLElement): string | undefined { return item.dataset.padRow || item.dataset.id; }

  private focus(scope: HTMLElement, row: HTMLElement): void {
    const key = this.key(row);
    this.cursor = key ? { scope, key } : undefined;
    focusListItem(row);
  }

  private primary(dialog?: HTMLDialogElement): HTMLElement | undefined {
    let target = this.current(dialog);
    if (!target && !dialog && this.detail === this.view.pane()) {
      const pane = this.view.pane()!;
      target = this.items(pane, false)[0];
      if (target) this.focus(pane, target);
    }
    if (!target) return undefined;
    if (target.matches("button, summary, a, .row[data-id]")) return target;
    return visibleItems(target, '[data-pad-action="primary"]')[0];
  }

  private canActivate(target: HTMLElement): boolean {
    return target.isConnected && target.getClientRects().length > 0 && !target.matches(":disabled")
      && !target.closest(".is-busy, [inert]");
  }

  private activate(target?: HTMLElement): void {
    if (!target || !this.canActivate(target)) return;
    if (target.hasAttribute("data-pad-hold")) {
      this.startHold(target);
      return;
    }
    const pane = this.view.pane();
    if (pane && target.matches(".list-pane .row[data-id]")) this.detail = pane;
    target.click();
  }

  private more(): void {
    const row = this.current();
    if (!row) return;
    const scope = row.closest<HTMLElement>(".today-row-wrap")
      ?? (row.hasAttribute("data-pad-action") ? row.closest<HTMLElement>(".detail-pane") : undefined)
      ?? row;
    const anchor = visibleItems(scope, '[data-pad-action="more"]')[0];
    if (anchor) { this.activate(anchor); return; }

    const actions = visibleItems(scope, ACTIONS).filter(el => el.dataset.padAction !== "primary");
    const items: MenuItem[] = [];
    const choices: (() => void)[] = [];
    const add = (label: string, action: () => void, selected?: boolean) => {
      items.push({ value: String(choices.length), label, selected });
      choices.push(action);
    };
    for (const action of actions) {
      add(action.getAttribute("aria-label") ?? action.textContent?.trim() ?? "", () => this.activate(action));
    }
    for (const control of scope.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".attn-grant input[type=checkbox], .attn-grant select")) {
      if (control instanceof HTMLInputElement) {
        add(control.labels?.[0]?.textContent?.trim() ?? control.name, () => control.click(), control.checked);
      } else {
        for (const option of control.options) add(option.text, () => { control.value = option.value; }, option.selected);
      }
    }
    if (items.length) openMenu(row, items, value => {
      if (this.canActivate(row)) choices[Number(value)]?.();
    });
  }

  private menuKey(menu: HTMLElement, key: string): void {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }

  private scroll(x: number, y: number, dialog?: HTMLDialogElement): void {
    const pane = this.view.pane();
    const target = dialog?.querySelector(".dialog-body, .palette-list")
      ?? pane?.querySelector(".split.has-detail .work-detail-layout .detail-pane")
      ?? pane?.querySelector(".split.has-detail .detail-pane, .today, .trash-scroll, .set-scroll");
    const text = this.current(dialog)?.querySelector("pre");
    if (text && x) text.scrollBy(x, 0);
    target?.scrollBy(text ? 0 : x, y);
  }

  private startHold(target: HTMLElement): void {
    const progress = h("progress", { max: HOLD_MS, value: 0, "aria-label": t("Hold to confirm") });
    const tip = h("span", { class: "pad-hold" }, h("span", { role: "status" }, t("Hold to confirm")), progress);
    this.hold = { target, focus: document.activeElement, started: performance.now(), progress, tip };
    target.after(tip);
    tip.scrollIntoView({ block: "nearest" });
    this.frame = window.requestAnimationFrame(this.updateHold);
  }

  private readonly updateHold = (now: number) => {
    const hold = this.hold;
    if (!hold || !this.canActivate(hold.target) || hold.focus !== document.activeElement) { this.cancelHold(); return; }
    hold.progress.value = Math.min(HOLD_MS, now - hold.started);
    this.frame = window.requestAnimationFrame(this.updateHold);
  };

  private cancelHold(): void {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.hold?.tip.remove();
    this.hold = undefined;
  }
}
