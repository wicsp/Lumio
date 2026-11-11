import { clear, h, isTypingControl, openMenu, type MenuItem } from "./dom.ts";
import { HOLD_MS, type PadCommand, type PadInput } from "./gamepad-input.ts";
import { adjacentFocus, type PadDirection } from "./gamepad-focus.ts";
import { focusListItem, nextListItem, visibleItems } from "./list-keys.ts";
import { t } from "./i18n.ts";
import { speechService } from "./speech-input.ts";

const ROWS = "[data-pad-row], .row[data-id]";
const DETAIL_ACTIONS = '.split.has-detail [data-pad-action="primary"], .split.has-detail [data-pad-action="delegate"], .split.has-detail [data-pad-action="reject"]';
const REGIONS = "[data-pad-region], .bar, .list-pane, .detail-pane";
const PRIMARY = '[data-pad-action="primary"]';
const ACTIONS = "[data-pad-action]";

interface Navigation {
  pane(): HTMLElement | undefined;
  back(): void;
  backLabel(): string | undefined;
  returnFromToast(): boolean;
  section(step: number): void;
  sectionLabel(step: number): string | undefined;
  palette(): void;
  delegate(id: string): void;
  paletteAction(step?: number): void;
  buttonLabel(command: PadCommand): string | undefined;
}

interface Hold {
  target: HTMLElement;
  focus: Element | null;
  started: number;
  progress: HTMLProgressElement;
  tip: HTMLElement;
}
interface Cursor { item: HTMLElement; key?: string; region: string; index: number }
interface Overlay { dialog?: HTMLDialogElement; menu?: HTMLElement }
interface Action { command: PadCommand; label: string; run(): void }

export class GamepadNavigation {
  private active = false;
  private cursors = new WeakMap<HTMLElement, Cursor>();
  private listOrigin?: Cursor;
  private pendingDetail?: HTMLElement;
  private needsFocus = false;
  private marked?: HTMLElement;
  private overlay?: HTMLElement;
  private hints?: HTMLElement;
  private hintSignature = "";
  private observer?: MutationObserver;
  private hold?: Hold;
  private frame?: number;

  constructor(private view: Navigation) {}

  mount(): void {
    this.observer = new MutationObserver(() => this.refresh());
    for (const event of ["pointermove", "pointerdown", "click", "keydown"]) document.addEventListener(event, this.otherInput, true);
    document.addEventListener("focusin", this.focusChanged);
  }

  dispose(): void {
    this.leave();
    for (const event of ["pointermove", "pointerdown", "click", "keydown"]) document.removeEventListener(event, this.otherInput, true);
    document.removeEventListener("focusin", this.focusChanged);
  }

  private readonly otherInput = (event: Event) => {
    // The controller reuses click and keyboard handlers with untrusted events.
    if (event.isTrusted) this.leave(event.type !== "keydown");
  };

  private readonly focusChanged = () => {
    if (this.hold && document.activeElement !== this.hold.focus) this.cancelHold();
    if (this.active) queueMicrotask(() => this.refresh());
  };

  leave(pointer = false): void {
    if (!this.active) return;
    this.active = false;
    this.pendingDetail = undefined;
    this.needsFocus = false;
    this.cancelHold();
    this.observer?.disconnect();
    document.body.removeAttribute("data-gamepad-mode");
    if (pointer && this.marked === document.activeElement) this.marked?.blur();
    this.mark(undefined);
    this.hints?.remove();
    this.hints = undefined;
    this.hintSignature = "";
  }

  routeChanged(focusDetail = false): void {
    this.cancelHold();
    const pane = this.view.pane();
    this.pendingDetail = this.active && focusDetail ? pane : undefined;
    this.needsFocus = this.active && !focusDetail;
    this.listOrigin = undefined;
    this.overlay = undefined;
    if (this.active && pane && !focusDetail) {
      const previous = this.restore(this.items(pane, false), this.cursors.get(pane), true);
      if (previous) this.focus(pane, previous);
    }
    this.refresh();
  }

  handle(input: PadInput): void {
    if (input.phase === "reset") { this.leave(); return; }
    if (input.phase === "release") {
      if (input.command === "activate") this.cancelHold();
      return;
    }
    if (!this.active && (input.phase === "hold" || input.phase === "repeat" || input.phase === "scroll")) return;
    const test = this.testPanel();
    if (test) {
      if (!this.active) this.enter();
      if (input.phase === "press" && input.command === "back") test.removeAttribute("data-pad-testing");
      this.refresh();
      return;
    }
    const overlay = this.overlays();
    const focused = document.activeElement as HTMLElement | null;
    const typing = isTypingControl(focused);
    if (input.phase === "scroll") {
      if (!typing && !this.hold) this.scroll(input.x, input.y, overlay, this.marked);
      return;
    }
    const direction = "command" in input && this.direction(input.command);
    const entering = !this.active;
    if (entering) this.enter();
    const scope = overlay.dialog ?? this.view.pane();
    const items = scope ? this.items(scope, !!overlay.dialog) : [];
    const saved = scope ? this.cursors.get(scope) : undefined;
    const old = this.restore(items, saved, false);
    const restoring = entering && !overlay.menu && !typing && !!saved;
    const current = restoring ? old : this.current(items, saved);
    let picked = current;
    if (!typing && !overlay.menu && scope && (entering || !current)) {
      picked = current ?? this.restore(items, saved, true);
      if (!picked && !direction) picked = items[0];
      if (picked) this.focus(scope, picked);
    }

    if (input.phase === "activity") { this.refresh(); return; }
    const { command, phase } = input;
    if (typing) {
      if (phase === "press" && command === "back") this.exitInput(focused, scope, items, saved);
      this.refresh();
      return;
    }
    if (phase === "hold") {
      if (command === "activate" && this.hold) {
        const { target, focus } = this.hold;
        const valid = this.canActivate(target) && focused === focus && this.primary(picked) === target
          && !overlay.menu && document.hasFocus() && document.visibilityState === "visible";
        this.cancelHold();
        if (valid) target.click();
      }
      this.refresh();
      return;
    }
    if (this.hold) {
      this.cancelHold();
      if (command === "back") { this.refresh(); return; }
    }
    if (direction) {
      if (!(entering && old && !overlay.dialog && !overlay.menu) && !(picked && picked !== current)) {
        this.moveDirection(direction, scope, items, picked, overlay);
      }
    } else if (phase === "press" && !(picked && picked !== current && (command === "activate" || command === "delegate" || command === "more"))) {
      this.actions(overlay, picked).find(action => action.command === command)?.run();
    }
    this.refresh();
  }

  /** The existing Today keyboard shortcuts keep their linear order and native focus. */
  move(step: number): boolean {
    const pane = this.view.pane();
    if (!pane) return false;
    const items = visibleItems(pane, ROWS);
    const next = nextListItem(items, this.focusedItem(items), step);
    if (!next) return false;
    focusListItem(next);
    return true;
  }

  private enter(): void {
    this.active = true;
    document.body.setAttribute("data-gamepad-mode", "");
    this.observer?.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["disabled", "hidden", "open", "class", "data-pad-hold", "data-pad-delegate", "data-pad-testing", "data-pad-action"] });
  }

  private overlays(): Overlay {
    return {
      dialog: Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1),
      menu: document.querySelector<HTMLElement>(".menu") ?? undefined,
    };
  }

  private testPanel(): HTMLElement | undefined {
    const panel = this.view.pane()?.querySelector<HTMLElement>("[data-pad-testing]");
    if (panel?.getClientRects().length) return panel;
  }

  private refresh(): void {
    if (!this.active) return;
    if (this.testPanel()) {
      this.mark(undefined);
      this.renderHints(document.body, [{ command: "back", label: t("Stop testing"), run() {} }]);
      return;
    }
    const overlay = this.overlays();
    const scope = overlay.dialog ?? this.view.pane();
    const items = scope ? this.items(scope, !!overlay.dialog) : [];
    const typing = isTypingControl(document.activeElement as HTMLElement | null);
    const layer = overlay.menu ?? overlay.dialog;
    const closed = this.overlay && !layer;
    this.overlay = layer;
    let row = scope ? this.current(items, this.cursors.get(scope)) : undefined;
    if (!layer && !typing && scope) {
      const detail = this.pendingDetail === scope ? items.find(item => item.closest(".detail-pane")) : undefined;
      if (detail) {
        this.pendingDetail = undefined;
        this.focus(scope, detail);
        row = detail;
      } else if (closed || (row && !row.contains(document.activeElement)) || this.needsFocus) {
        const previous = this.restore(items, this.cursors.get(scope), !!closed) ?? row ?? items[0];
        if (previous) { this.focus(scope, previous); row = previous; }
      }
      if (row) this.needsFocus = false;
    }
    const highlighted = overlay.menu?.querySelector<HTMLElement>(".menu-item.is-active")
      ?? (overlay.dialog?.matches(".palette") ? overlay.dialog.querySelector<HTMLElement>(".palette-item.is-active") : row);
    this.mark(typing ? undefined : highlighted ?? undefined);
    this.renderHints(overlay.dialog ?? document.body, typing ? this.inputActions() : this.actions(overlay, row));
  }

  private mark(item?: HTMLElement): void {
    if (this.marked === item) return;
    this.marked?.removeAttribute("data-pad-focus");
    this.marked = item;
    item?.setAttribute("data-pad-focus", "");
  }

  private renderHints(host: HTMLElement, actions: Action[]): void {
    const hints = actions.flatMap(({ command, label }) => {
      const button = this.view.buttonLabel(command);
      return button ? [[button, label] as const] : [];
    }).slice(0, 5);
    const signature = JSON.stringify(hints);
    if (!hints.length) {
      this.hints?.remove();
      this.hints = undefined;
      this.hintSignature = "";
      return;
    }
    this.hints ??= h("div", { class: "pad-hints", role: "group", "aria-label": t("Gamepad controls") });
    if (this.hints.parentElement !== host) host.append(this.hints);
    if (signature === this.hintSignature) return;
    this.hintSignature = signature;
    clear(this.hints, ...hints.map(([button, label]) => h("span", {}, h("kbd", {}, button), label)));
  }

  private items(scope: HTMLElement, dialog: boolean): HTMLElement[] {
    if (dialog) return visibleItems(scope, "button, summary");
    return visibleItems(scope, ROWS + ", " + DETAIL_ACTIONS)
      .filter(item => !item.parentElement?.closest(ROWS));
  }

  private region(item: HTMLElement, scope: HTMLElement): HTMLElement {
    return item.closest<HTMLElement>(".work-detail-layout") ?? item.closest<HTMLElement>(REGIONS) ?? scope;
  }

  private regionKey(item: HTMLElement, scope: HTMLElement): string {
    const region = this.region(item, scope);
    if (region === scope) return "";
    return region.dataset.padRegion ?? region.className;
  }

  private key(item: HTMLElement): string | undefined { return item.dataset.padRow ?? item.dataset.id ?? item.dataset.padAction; }

  private focusedItem(items: HTMLElement[]): HTMLElement | undefined {
    return items.find(item => item === document.activeElement || item.contains(document.activeElement));
  }

  private current(items: HTMLElement[], saved?: Cursor): HTMLElement | undefined {
    const focused = this.focusedItem(items);
    if (focused && (focused !== saved?.item || this.key(focused) === saved.key)) return focused;
    return this.restore(items, saved, false);
  }

  private restore(items: HTMLElement[], cursor: Cursor | undefined, fallback: boolean): HTMLElement | undefined {
    if (!cursor) return undefined;
    if (items.includes(cursor.item) && this.key(cursor.item) === cursor.key) return cursor.item;
    const scope = this.view.pane();
    const sameRegion = scope ? items.filter(item => this.regionKey(item, scope) === cursor.region) : items;
    const sameItem = cursor.key && sameRegion.find(item => this.key(item) === cursor.key);
    return sameItem || (fallback ? sameRegion[Math.min(cursor.index, sameRegion.length - 1)] : undefined);
  }

  private focus(scope: HTMLElement, item: HTMLElement): void {
    const region = this.regionKey(item, scope);
    const index = this.items(scope, scope.matches("dialog")).filter(row => this.regionKey(row, scope) === region).indexOf(item);
    this.cursors.set(scope, { item, key: this.key(item), region, index: Math.max(0, index) });
    if (document.activeElement !== item) focusListItem(item);
  }

  private direction(command: PadCommand): PadDirection | undefined {
    if (command === "up" || command === "down" || command === "left" || command === "right") return command;
  }

  private moveDirection(direction: PadDirection, scope: HTMLElement | undefined, items: HTMLElement[], row: HTMLElement | undefined, { menu, dialog }: Overlay): void {
    const step = direction === "up" || direction === "left" ? -1 : 1;
    const list = menu ?? (dialog?.matches(".palette") ? dialog : undefined);
    if (list) {
      const options = visibleItems(list, menu ? ".menu-item" : ".palette-item");
      const current = options.findIndex(item => item.matches(".is-active"));
      if (current >= 0 && options[current + step]) {
        if (menu) this.menuKey(menu, step < 0 ? "ArrowUp" : "ArrowDown");
        else this.view.paletteAction(step);
      }
      return;
    }
    if (!scope) return;
    const next = row
      ? adjacentFocus(items.map(item => ({ item, region: this.region(item, scope), bounds: item.getBoundingClientRect() })), row, direction)
      : items[step > 0 ? 0 : items.length - 1];
    if (next) this.focus(scope, next);
  }

  private exitInput(input: HTMLElement | null, scope: HTMLElement | undefined, items: HTMLElement[], saved?: Cursor): void {
    input?.blur();
    const row = input?.closest<HTMLElement>(ROWS) ?? this.restore(items, saved, true);
    if (row && scope) this.focus(scope, row);
  }

  private inputActions(): Action[] {
    const actions: Action[] = [{ command: "back", label: t("Leave input"), run() {} }];
    // G1-4：输入框旁有可用的麦克风时提示 RT。
    const field = document.activeElement;
    if (field?.closest("form, .composer, .attn-composer, .form-stack")?.querySelector(".speech-input:not([hidden])")) actions.push({ command: "talk", label: t("Hold to talk"), run() {} });
    return actions;
  }

  private actions({ menu, dialog }: Overlay, row: HTMLElement | undefined): Action[] {
    const actions: Action[] = [];
    const add = (command: PadCommand, label: string, run: () => void) => actions.push({ command, label, run });
    const button = (command: PadCommand, target?: HTMLElement, label?: string) => {
      if (target && this.canActivate(target)) {
        const name = label ?? this.label(target);
        add(command, target.hasAttribute("data-pad-hold") ? t("Hold to {0}", name) : name, () => this.activate(target));
      }
    };
    if (menu || dialog?.matches(".palette")) {
      const selected = (menu ?? dialog)?.querySelector<HTMLElement>(".is-active");
      if (selected) add("activate", this.label(selected), () => menu ? this.menuKey(menu, "Enter") : this.view.paletteAction());
    } else {
      const primary = this.primary(row);
      button("activate", primary, primary === row && row?.matches(".row[data-id], .today-row") ? t("Open details") : undefined);
    }
    const pane = this.view.pane();
    const back = pane?.querySelector<HTMLElement>(".split.has-detail [data-pad-back], [data-pad-back]:not(.mobile-only)");
    if (menu || dialog || back || this.view.backLabel() || this.hold) {
      add("back", this.hold ? t("Cancel") : menu || dialog ? t("Close") : this.view.backLabel() ?? t("Back"), () => {
        if (menu) this.menuKey(menu, "Escape");
        else if (dialog) dialog.close();
        else if (!this.view.returnFromToast()) this.goBack(pane, back ?? undefined);
      });
    }
    if (dialog || menu) return actions;
    if (speechService()?.ready) add("talk", t("Hold to talk"), () => {});

    const toast = Array.from(document.querySelectorAll<HTMLElement>(".toast-action:not(.leaving) .toast-btn")).at(-1);
    button("view", toast);
    if (row) {
      const scope = this.actionScope(row);
      const reject = visibleItems(scope, '[data-pad-action="reject"]')[0];
      const delegate = row.dataset.padAction === "delegate" ? row : visibleItems(scope, '[data-pad-action="delegate"]')[0];
      if (reject) button("delegate", reject);
      else if (delegate) button("delegate", delegate);
      else if (row.hasAttribute("data-pad-delegate") && row.dataset.id) add("delegate", t("Delegate"), () => this.view.delegate(row.dataset.id!));
      const more = this.more(row, scope);
      if (more) add("more", t("More actions"), more);
    }
    for (const [command, step] of [["previous", -1], ["next", 1]] as const) {
      const label = this.view.sectionLabel(step);
      if (label) add(command, label, () => this.view.section(step));
    }
    add("palette", t("Command menu"), () => this.view.palette());
    return actions;
  }

  private goBack(pane: HTMLElement | undefined, back: HTMLElement | undefined): void {
    if (!pane || !back) { this.view.back(); return; }
    const selected = pane.querySelector<HTMLElement>(".list-pane .row.is-selected");
    const origin = this.listOrigin;
    this.listOrigin = undefined;
    this.pendingDetail = undefined;
    back.click();
    const row = this.restore(this.items(pane, false), origin, true) ?? selected;
    if (row && this.canActivate(row)) this.focus(pane, row);
  }

  private primary(row?: HTMLElement): HTMLElement | undefined {
    if (!row) return undefined;
    if (row.matches("button, summary, a, .row[data-id]")) return row;
    return visibleItems(row, PRIMARY)[0];
  }

  private label(item: HTMLElement): string {
    if (item.matches(".group-head")) {
      const title = item.textContent?.trim() ?? "";
      return item.getAttribute("aria-expanded") === "true" ? t("Collapse {0}", title) : t("Expand {0}", title);
    }
    return item.getAttribute("aria-label") ?? item.querySelector(".menu-label, .label")?.textContent?.trim()
      ?? (item.textContent?.trim() || item.getAttribute("title") || t("Open"));
  }

  private canActivate(target: HTMLElement): boolean {
    return target.isConnected && target.getClientRects().length > 0 && !target.matches(":disabled")
      && !target.closest(".is-busy, [inert]");
  }

  private activate(target: HTMLElement): void {
    if (!this.canActivate(target)) return;
    if (target.hasAttribute("data-pad-hold")) { this.startHold(target); return; }
    const pane = this.view.pane();
    if (pane && target.matches(".list-pane .row[data-id]")) {
      this.focus(pane, target);
      this.listOrigin = this.cursors.get(pane);
      if (!pane.querySelector(".split.has-detail")) this.pendingDetail = pane;
    }
    target.click();
  }

  private actionScope(row: HTMLElement): HTMLElement {
    return row.closest<HTMLElement>(".today-row-wrap")
      ?? (row.hasAttribute("data-pad-action") ? row.closest<HTMLElement>(".detail-pane") : undefined)
      ?? row;
  }

  private more(row: HTMLElement, scope: HTMLElement): (() => void) | undefined {
    if (row.hasAttribute("data-pad-menu")) return () => row.dispatchEvent(new Event("lumio-task-menu"));

    const items: MenuItem[] = [];
    const choices: (() => void)[] = [];
    const add = (label: string, action: () => void, selected?: boolean) => {
      items.push({ value: String(choices.length), label, selected });
      choices.push(action);
    };
    for (const action of visibleItems(scope, ACTIONS)) {
      if (action.dataset.padAction !== "primary" && this.canActivate(action)) add(this.label(action), () => this.activate(action));
    }
    for (const control of visibleItems(scope, ".attn-grant input[type=checkbox], .attn-grant select") as (HTMLInputElement | HTMLSelectElement)[]) {
      if (control instanceof HTMLInputElement) {
        add(control.labels?.[0]?.textContent?.trim() ?? control.name, () => control.click(), control.checked);
      } else {
        for (const option of control.options) add(option.text, () => { control.value = option.value; }, option.selected);
      }
    }
    if (items.length) return () => openMenu(row, items, value => {
      if (this.canActivate(row)) choices[Number(value)]?.();
    });
  }

  private menuKey(menu: HTMLElement, key: string): void {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    if (key === "ArrowUp" || key === "ArrowDown") menu.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  private scroll(x: number, y: number, { dialog, menu }: Overlay, row?: HTMLElement): void {
    const pane = this.view.pane();
    const target = menu?.querySelector(".menu-list") ?? dialog?.querySelector(".dialog-body, .palette-list")
      ?? pane?.querySelector(".split.has-detail .work-detail-layout .detail-pane")
      ?? pane?.querySelector(".split.has-detail .detail-pane, .today, .trash-scroll, .set-scroll");
    const text = row?.querySelector("pre");
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
