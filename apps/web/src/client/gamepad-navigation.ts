import { clear, h, isTypingControl, openMenu, type MenuItem } from "./dom.ts";
import { HOLD_MS, type PadCommand, type PadInput } from "./gamepad-input.ts";
import { adjacentFocus, type PadDirection } from "./gamepad-focus.ts";
import { focusListItem, nextListItem, visibleItems } from "./list-keys.ts";
import { t } from "./i18n.ts";
import { canDictate, dictate, recordingField, speechService } from "./speech-input.ts";

const ROWS = "[data-pad-row], .row[data-id]";
const DETAIL_ACTIONS = '.split.has-detail [data-pad-action="primary"], .split.has-detail [data-pad-action="delegate"], .split.has-detail [data-pad-action="reject"]';
const REGIONS = "[data-pad-region], .bar, .list-pane, .detail-pane";
const PRIMARY = '[data-pad-action="primary"]';
/** 可以用 A 进入的输入区（助手输入框、任务讨论、卡片里的回答框）。 */
const INPUTS = "[data-pad-input]";
const FIELD = "textarea, input[type=text], input:not([type])";
type Field = HTMLTextAreaElement | HTMLInputElement;
/** 提示条的层级标签（G1-6）：让人一眼看出现在在哪一层，B 退回上一层。 */
type Layer = "page" | "detail" | "menu" | "dialog" | "input" | "recording";
const LAYER_LABEL: Record<Layer, string> = { page: "Browsing", detail: "Details", menu: "Menu", dialog: "Dialog", input: "Typing", recording: "Recording" };
/** 提示条按键顺序固定；空间不够时从后往前省略，A 与 B 始终保留。 */
const HINT_ORDER: PadCommand[] = ["activate", "delegate", "more", "back", "talk", "view", "previous", "next", "palette"];
const MAX_HINTS = 6;
const ACTIONS = "[data-pad-action]";

interface Navigation {
  pane(): HTMLElement | undefined;
  /** 页面层的 B：回到上一个访问过的模块。 */
  back(): void;
  backLabel(): string | undefined;
  /** RT 在当前上下文没有输入框时：打开助手并返回它的输入框。 */
  openAssistant(): Promise<HTMLTextAreaElement | undefined>;
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
interface Action { command: PadCommand; label: string; run(): void; progress?: HTMLProgressElement }

export class GamepadNavigation {
  private active = false;
  private cursors = new WeakMap<HTMLElement, Cursor>();
  private selectionAtExit = new WeakMap<HTMLElement, string | undefined>();
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
  /** RT 按下时开始录音的输入框，松开时结束它。 */
  private talking?: Field;

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
    const pane = this.view.pane();
    if (pane) {
      const selected = this.selectedItem(this.items(pane, false));
      this.selectionAtExit.set(pane, selected && this.key(selected));
    }
    this.active = false;
    this.stopTalking();
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
    if (input.phase === "reset") { this.stopTalking(); this.leave(); return; }
    if ("command" in input && input.command === "talk" && !this.testPanel()) {
      if (input.phase === "press") { if (!this.active) this.enter(); this.talk(); }
      else if (input.phase === "release") this.stopTalking();
      this.refresh();
      return;
    }
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
    const resuming = entering && !overlay.menu && !overlay.dialog && !typing && scope;
    const selected = resuming ? this.selectedItem(items) : undefined;
    const changedSelection = resuming && selected && this.key(selected) !== this.selectionAtExit.get(resuming);
    const current = changedSelection ? selected : resuming && saved ? old : this.current(items, saved);
    let picked = current;
    if (!typing && !overlay.menu && scope && (entering || !current)) {
      picked = current ?? this.restore(items, saved, true);
      if (!picked && !direction) picked = items[0];
      if (picked) this.focus(scope, picked);
    }

    if (input.phase === "activity") { this.refresh(); return; }
    const { command, phase } = input;
    if (typing) {
      // 输入层（G1-6）：A 提交，B 退出输入；录音中 A 结束、B 取消这一句。
      const recording = recordingField();
      if (phase === "press" && command === "back") {
        if (recording) dictate(recording, "cancel");
        else this.exitInput(focused, scope, items, saved);
      } else if (phase === "press" && command === "activate") {
        if (recording) dictate(recording, "stop");
        else this.submit(focused);
      }
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
    const focusOnly = changedSelection || (picked && picked !== current);
    if (direction) {
      if (!(resuming && old) && !focusOnly) {
        this.moveDirection(direction, scope, items, picked, overlay);
      }
    } else if (phase === "press" && !(focusOnly && (command === "activate" || command === "delegate" || command === "more"))) {
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
      this.renderHints(document.body, "page", [{ command: "back", label: t("Stop testing"), run() {} }]);
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
    const recording = !!recordingField();
    const level: Layer = recording ? "recording" : typing ? "input" : overlay.menu ? "menu" : overlay.dialog ? "dialog"
      : row?.closest(".detail-pane, .work-detail-layout") ? "detail" : "page";
    this.renderHints(overlay.dialog ?? document.body, level, typing || recording ? this.inputActions(recording) : this.actions(overlay, row));
  }

  private mark(item?: HTMLElement): void {
    if (this.marked === item) return;
    this.marked?.removeAttribute("data-pad-focus");
    this.marked = item;
    item?.setAttribute("data-pad-focus", "");
  }

  private renderHints(host: HTMLElement, layer: Layer, actions: Action[]): void {
    const labelled = actions.flatMap(action => {
      const button = this.view.buttonLabel(action.command);
      return button ? [{ ...action, button }] : [];
    }).sort((a, b) => HINT_ORDER.indexOf(a.command) - HINT_ORDER.indexOf(b.command));
    // A 与 B 始终显示；其余按固定顺序填到上限。
    const keep = labelled.filter(action => action.command === "activate" || action.command === "back");
    const rest = labelled.filter(action => !keep.includes(action)).slice(0, Math.max(0, MAX_HINTS - keep.length));
    const shown = labelled.filter(action => keep.includes(action) || rest.includes(action));
    const signature = JSON.stringify([layer, shown.map(({ command, button, label, progress }) => [command, button, label, !!progress])]);
    this.hints ??= h("div", { class: "pad-hints", role: "group", "aria-label": t("Gamepad controls") });
    if (this.hints.parentElement !== host) host.append(this.hints);
    if (signature === this.hintSignature) return;
    this.hintSignature = signature;
    this.hints.dataset.layer = layer;
    clear(this.hints, h("span", { class: "pad-layer" }, t(LAYER_LABEL[layer])),
      ...shown.map(({ button, label, progress }) => h("span", {}, h("kbd", {}, button), label, progress ?? null)));
  }

  private items(scope: HTMLElement, dialog: boolean): HTMLElement[] {
    if (dialog) return visibleItems(scope, "button, summary");
    const rows = visibleItems(scope, ROWS + ", " + DETAIL_ACTIONS + ", " + INPUTS)
      .filter(item => !item.parentElement?.closest(ROWS));
    // A note opened from a link, or on a narrow screen, can be absent from the visible list.
    const detail = visibleItems(scope, "[data-pad-selection]")[0];
    if (detail && !rows.some(row => row.dataset.id === detail.dataset.padSelection)) rows.push(detail);
    return rows;
  }

  private region(item: HTMLElement, scope: HTMLElement): HTMLElement {
    return item.closest<HTMLElement>(".work-detail-layout") ?? item.closest<HTMLElement>(REGIONS) ?? scope;
  }

  private regionKey(item: HTMLElement, scope: HTMLElement): string {
    const region = this.region(item, scope);
    if (region === scope) return "";
    return region.dataset.padRegion ?? region.className;
  }

  private key(item: HTMLElement): string | undefined { return item.dataset.padRow ?? item.dataset.id ?? item.dataset.padSelection ?? item.dataset.padAction; }

  private selectedItem(items: HTMLElement[]): HTMLElement | undefined {
    return items.find(item => item.dataset.padSelection || (item.dataset.id && item.matches(".row.is-selected")));
  }

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
    const row = input?.closest<HTMLElement>(ROWS) ?? this.selectedItem(items) ?? this.restore(items, saved, true);
    if (row && scope) this.focus(scope, row);
  }

  private inputActions(recording: boolean): Action[] {
    const field = document.activeElement as HTMLElement | null;
    if (recording) {
      return [
        { command: "activate", label: t("Stop and insert"), run() {} },
        { command: "back", label: t("Cancel recording"), run() {} },
        { command: "talk", label: t("Release to finish"), run() {} },
      ];
    }
    const actions: Action[] = [{ command: "back", label: t("Leave input"), run() {} }];
    const submit = this.submitLabel(field);
    if (submit) actions.push({ command: "activate", label: submit, run() {} });
    if (canDictate(field)) actions.push({ command: "talk", label: t("Hold to talk"), run() {} });
    return actions;
  }

  /** 输入层的 A：提交所在的表单（发送、评论、确认）；不在表单里时（如任务说明）退出编辑即保存。 */
  private submit(field: HTMLElement | null): void {
    if (!field) return;
    const form = field.closest("form");
    if (form) {
      const button = this.submitButton(form);
      if (button && button.disabled) return;
      form.requestSubmit();
      return;
    }
    if (field.tagName === "TEXTAREA") field.blur();
  }

  private submitButton(form: HTMLFormElement): HTMLButtonElement | undefined {
    return form.querySelector<HTMLButtonElement>("button[type=submit]")
      ?? (form.id ? document.querySelector<HTMLButtonElement>(`button[type=submit][form="${CSS.escape(form.id)}"]`) : null) ?? undefined;
  }

  private submitLabel(field: HTMLElement | null): string | undefined {
    if (!field || field.isContentEditable) return undefined;
    const form = field.closest("form");
    // 表单里的空输入框没有可提交的内容，不显示 A。
    if (form && "value" in field && !String((field as Field).value).trim()) return undefined;
    if (!form) return field.tagName === "TEXTAREA" ? t("Finish editing") : undefined;
    const button = this.submitButton(form);
    if (button?.disabled) return undefined;
    return button ? this.label(button) : t("Submit");
  }

  /** RT 的目标（G1-6）：当前输入框 → 焦点条目里的输入框 → 本页的主输入框 → 助手。弹层打开时只用弹层里的输入框。 */
  private talkTarget(): { field?: Field; assistant?: boolean } | undefined {
    if (!speechService()?.ready) return undefined;
    const focused = document.activeElement;
    if (canDictate(focused)) return { field: focused };
    const { dialog, menu } = this.overlays();
    if (menu) return undefined;
    if (dialog) {
      const field = visibleItems(dialog, FIELD).find(canDictate);
      return field ? { field } : undefined;
    }
    const inside = (root: Element | undefined) => {
      if (!root) return undefined;
      const area = root.matches(INPUTS) ? root : root.querySelector(INPUTS);
      return area ? visibleItems(area as HTMLElement, FIELD).find(canDictate) : undefined;
    };
    const field = inside(this.marked) ?? visibleItems(this.view.pane() ?? document.body, INPUTS)
      .filter(area => !area.parentElement?.closest(ROWS)).map(area => inside(area)).find(Boolean);
    return field ? { field } : { assistant: true };
  }

  private talk(): void {
    if (this.talking) return;
    const target = this.talkTarget();
    if (!target) return;
    const start = (field: Field) => {
      if (document.activeElement !== field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
      if (dictate(field, "start")) this.talking = field;
    };
    if (target.field) { start(target.field); return; }
    void this.view.openAssistant().then(field => { if (field && canDictate(field) && this.active) start(field); this.refresh(); });
  }

  private stopTalking(): void {
    const field = this.talking;
    this.talking = undefined;
    if (field) dictate(field, "stop");
  }

  private actions({ menu, dialog }: Overlay, row: HTMLElement | undefined): Action[] {
    const actions: Action[] = [];
    const add = (command: PadCommand, label: string, run: () => void) => actions.push({ command, label, run });
    const button = (command: PadCommand, target?: HTMLElement, label?: string) => {
      if (target && this.canActivate(target)) {
        const name = label ?? this.label(target);
        add(command, target.hasAttribute("data-pad-hold") ? t("Hold to {0}", name) : name, () => this.activate(target));
        if (this.hold?.target === target) actions.at(-1)!.progress = this.hold.progress;
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
      add("back", this.hold ? t("Cancel") : menu || dialog ? t("Close") : back ? t("Back to list") : this.view.backLabel() ?? t("Back"), () => {
        if (menu) this.menuKey(menu, "Escape");
        else if (dialog) dialog.close();
        else this.goBack(pane, back ?? undefined);
      });
    }
    const talk = this.talkTarget();
    if (talk) add("talk", talk.assistant ? t("Hold to talk to the assistant") : t("Hold to talk"), () => {});
    if (dialog || menu) return actions;

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
    if (row.matches(INPUTS) || row.matches("button, summary, a, .row[data-id]")) return row;
    // 卡片里展开了回答框时，A 先进入输入（在输入层再按 A 提交）。
    return visibleItems(row, INPUTS)[0] ?? visibleItems(row, PRIMARY)[0];
  }

  private label(item: HTMLElement): string {
    if (item.matches(INPUTS)) return t("Type");
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
    if (target.matches(INPUTS)) {
      const field = visibleItems(target, FIELD)[0] as Field | undefined;
      if (field && !field.disabled) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
      return;
    }
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
      // 需要长按确认的操作不进菜单，只能在卡片上按住 A，避免从菜单绕过（G1-6）。
      if (this.canActivate(action) && !action.hasAttribute("data-pad-hold")) add(this.label(action), () => this.activate(action));
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
    // 进度显示在提示条里，不往页面插元素，避免布局跳动（G1-6）。
    const progress = h("progress", { class: "pad-hold", max: HOLD_MS, value: 0, "aria-label": t("Hold to confirm") });
    this.hold = { target, focus: document.activeElement, started: performance.now(), progress, tip: progress };
    this.frame = window.requestAnimationFrame(this.updateHold);
    this.refresh();
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
    const had = !!this.hold;
    this.hold = undefined;
    if (had) this.refresh();
  }
}
