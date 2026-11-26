import { errorText } from "./api.ts";
import { drafts } from "./drafts.ts";
import { t } from "./i18n.ts";
import { matchRanges } from "./note-matches.ts";
import { icons } from "./reicon.ts";
/**
 * DOM 与界面基础件：动态文本一律走 textContent，不拼接 HTML。
 * 所有样式来自 styles.css（CSP 不允许内联 style 属性；需要的尺寸用 CSSOM 设置）。
 */

type Attr = string | number | boolean | undefined | null | ((event: Event) => void);
export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, Attr> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") el.addEventListener(name.replace(/^on/, ""), value);
    else if (name === "class") el.className = String(value);
    else if (value === true) el.setAttribute(name, "");
    else el.setAttribute(name, String(value));
  }
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

/** Search text always remains text, including HTML-like input. */
export function highlightedText(text: string, terms: readonly string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let at = 0;
  for (const [from, to] of matchRanges(text, terms)) {
    fragment.append(text.slice(at, from), h("mark", { class: "note-match" }, text.slice(from, to)));
    at = to;
  }
  fragment.append(text.slice(at));
  return fragment;
}

// ───────────── 状态占位 ─────────────

export const loading = (text = t("Loading…")) =>
  h("div", { class: "state state-loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));

export const empty = (text: string, action?: { label: string; run: () => void }) =>
  h("div", { class: "state state-empty" }, h("p", {}, text),
    action && h("button", { type: "button", class: "btn btn-small", onclick: action.run }, action.label));

export const failure = (text: string, retry?: () => void) =>
  h("div", { class: "state state-error", role: "alert" }, icon("alert"), h("span", {}, text),
    retry && h("button", { type: "button", class: "btn btn-small", onclick: retry }, t("Retry")));

/** 详情区没有选中条目时的占位。 */
export const placeholder = (iconName: string) =>
  h("div", { class: "placeholder", "aria-hidden": "true" }, icon(iconName));

// ───────────── 图标（本地路径，不加载远程资源） ─────────────

export function icon(name: string, className = "icon"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "-2 -2 28 28");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.setAttribute("fill", "none");
  for (const [tag, attributes] of Object.hasOwn(icons, name) ? icons[name]! : []) {
    const shape = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

/** 状态图标：形状本身区分状态，颜色只做加强（不依赖颜色传达含义）。 */
export function statusIcon(status: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `status-icon s-${status}`);
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  const ring = { cx: "8", cy: "8", r: "6", class: "ring" };
  switch (status) {
    case "active": case "running": case "assigned":
      add("circle", ring); add("path", { d: "M8 2a6 6 0 0 1 0 12z", class: "fill" }); break;
    case "waiting": case "waiting_for_human": case "queued": case "planning":
      add("circle", { ...ring, class: "ring dashed" }); break;
    case "blocked":
      add("circle", { ...ring, class: "ring dashed" }); add("path", { d: "M5.5 8h5", class: "mark" }); break;
    case "paused":
      add("circle", ring); add("path", { d: "M6.5 5.5v5M9.5 5.5v5", class: "mark" }); break;
    case "done":
      add("circle", { cx: "8", cy: "8", r: "6.5", class: "fill" }); add("path", { d: "M5.2 8.2l1.9 1.9 3.8-3.9", class: "mark inverse" }); break;
    case "cancelled":
      add("circle", ring); add("path", { d: "M6 6l4 4M10 6l-4 4", class: "mark" }); break;
    case "needs":
      add("circle", { cx: "8", cy: "8", r: "6.5", class: "fill" }); add("path", { d: "M8 4.8v3.8M8 10.8v.4", class: "mark inverse" }); break;
    case "failed": case "unknown":
      add("circle", { cx: "8", cy: "8", r: "6.5", class: "fill" }); add("path", { d: "M8 4.8v3.8M8 10.8v.4", class: "mark inverse" }); break;
    default: add("circle", ring);
  }
  return svg;
}

// ───────────── 对话框 ─────────────

/** 原生对话框；内容草稿按账户与用途恢复，关闭不触发提交。 */
export function openDialog(title: string, body: Node, actions: Node[], options: { wide?: boolean; narrow?: boolean; draftKey?: string; cancelLabel?: string } = {}): HTMLDialogElement {
  const dialog = h("dialog", { class: `dialog${options.wide ? " dialog-wide" : ""}${options.narrow ? " dialog-narrow" : ""}`, "aria-label": title },
    h("header", { class: "dialog-head" }, h("h2", {}, title),
      h("button", { type: "button", class: "icon-btn", "aria-label": t("Close"), onclick: () => { dialog.close(); } }, icon("close"))),
    h("div", { class: "dialog-body" }, body),
    h("footer", { class: "dialog-foot" },
      h("button", { type: "button", class: "btn btn-quiet", onclick: () => { dialog.close(); } }, options.cancelLabel ?? t("Close")), ...actions));
  dialog.addEventListener("input", () => { dialog.dataset.dirty = "true"; });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  const store = drafts(), key = options.draftKey ? `form:${options.draftKey}` : undefined;
  type FormDraft = { fields: Record<string, { value: string; checked: boolean }>; requestId?: string; previous?: string };
  const saved = key ? store.read<FormDraft>(key) : undefined;
  if (saved?.requestId) dialog.dataset.requestId = saved.requestId;
  if (saved?.previous) dialog.dataset.previous = saved.previous;
  const restored = new Set<string>();
  const controls = () => [...dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input[name],textarea[name],select[name]")]
    .filter(el => !["password", "file", "hidden"].includes(el.type) && !/token|secret|credential|api.?key/i.test(el.name));
  const restore = () => {
    for (const control of controls()) {
      if (restored.has(control.name)) continue;
      restored.add(control.name);
      const value = saved?.fields?.[control.name];
      if (!value || typeof value.value !== "string") continue;
      control.value = value.value;
      if (control instanceof HTMLInputElement) control.checked = value.checked;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const capture = () => {
    if (!key || dialog.dataset.dirty !== "true") return;
    store.write(key, { fields: Object.fromEntries(controls().map(control => [control.name, { value: control.value, checked: control instanceof HTMLInputElement && control.checked }])), requestId: dialog.dataset.requestId, previous: dialog.dataset.previous });
  };
  dialog.addEventListener("input", capture);
  dialog.addEventListener("change", () => { dialog.dataset.dirty = "true"; capture(); });
  dialog.addEventListener("submit", capture);
  const observer = new MutationObserver(restore);
  if (key) { observer.observe(dialog, { childList: true, subtree: true }); queueMicrotask(restore); }
  dialog.addEventListener("close", () => { if (key && dialog.dataset.dirty === "false") store.remove(key); else capture(); observer.disconnect(); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// ───────────── 确认与输入 ─────────────
// 代替浏览器自带的 confirm()/prompt()：样式与应用一致，出现在页面中间，Esc、点遮罩或「取消」都算取消。

export interface ConfirmOptions {
  title: string;
  /** Longer explanation under the title. */
  message?: string;
  /** Label of the confirming button (default "Confirm"). */
  confirm?: string;
  /** Red button for destructive actions. */
  danger?: boolean;
}

interface ConfirmationOptions<T> {
  title: string;
  body: HTMLElement;
  confirm?: string;
  danger?: boolean;
  hold?: boolean;
  compact?: boolean;
  icon?: Node;
  run(): T | Promise<T>;
  completed?(result: T): void;
}

/** A confirmation owns its submit state and uses native modal dismissal and focus restoration. */
export function openConfirmation<T>(options: ConfirmationOptions<T>): HTMLDialogElement {
  const error = h("div", { role: "alert" });
  const button = h("button", {
    type: "button", autofocus: true, class: `btn ${options.danger ? "btn-danger" : "btn-primary"}`,
    "data-pad-hold": options.hold,
    onclick: async () => {
      if (!dialog.open || button.disabled) return;
      button.disabled = true;
      clear(error);
      let result: T;
      try {
        result = await options.run();
      } catch (cause) {
        if (!dialog.open) return;
        options.body.append(error);
        clear(error, failure(errorText(cause)));
        button.disabled = false;
        if (document.activeElement === document.body || document.activeElement === dialog) button.focus();
        return;
      }
      dialog.close();
      options.completed?.(result);
    },
  }, options.icon, options.confirm ?? t("Confirm"));
  const dialog = openDialog(options.title, options.body, [button], { narrow: options.compact, cancelLabel: t("Cancel") });
  if (options.compact) dialog.classList.add("dialog-confirm");
  dialog.addEventListener("keydown", event => {
    // Enter follows focus. Cancel, inputs and any other controls keep their native behavior.
    if (event.key !== "Enter" || event.target !== button || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) button.click();
  });
  return dialog;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false;
    const dialog = openConfirmation({
      ...options, compact: true, hold: options.danger,
      body: h("div", { class: "confirm-body" }, options.message ? h("p", {}, options.message) : null),
      run: () => { ok = true; },
    });
    dialog.addEventListener("close", () => resolve(ok));
  });
}

export interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  confirm?: string;
  multiline?: boolean;
}

/** 多行输入对话框旁的语音按钮（S1-4）；由 speech-input 注册，避免 dom.ts 反向依赖语音模块。 */
let promptSpeech: ((field: HTMLTextAreaElement) => HTMLElement) | undefined;
export function setPromptSpeech(factory: typeof promptSpeech): void { promptSpeech = factory; }

/** Resolves to the trimmed text, or undefined when cancelled or left empty. */
export function promptDialog(options: PromptOptions): Promise<string | undefined> {
  return new Promise(resolve => {
    let result: string | undefined;
    const input = options.multiline
      ? h("textarea", { rows: 3, placeholder: options.placeholder, "aria-label": options.label ?? options.title })
      : h("input", { type: "text", autocomplete: "off", placeholder: options.placeholder, "aria-label": options.label ?? options.title });
    input.value = options.value ?? "";
    const id = `prompt-${Math.random().toString(36).slice(2)}`;
    const button = h("button", { type: "submit", form: id, class: "btn btn-primary", disabled: !input.value.trim() }, options.confirm ?? t("Confirm"));
    input.addEventListener("input", () => { button.disabled = !input.value.trim(); });
    if (input instanceof HTMLTextAreaElement)
      input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); } });
    const form = h("form", { id, class: "form-stack confirm-body" },
      options.message ? h("p", {}, options.message) : null,
      options.label ? field(options.label, input) : input,
      input instanceof HTMLTextAreaElement && promptSpeech ? h("div", { class: "prompt-speech" }, promptSpeech(input)) : null);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      result = text; dialog.dataset.dirty = "false"; dialog.close();
    });
    const dialog = openDialog(options.title, form, [button], { narrow: true, cancelLabel: t("Cancel") });
    dialog.addEventListener("close", () => resolve(result));
    input.focus();
    if (input instanceof HTMLInputElement) input.select();
  });
}

// ───────────── 表单 ─────────────

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "field-hint" }, hint));
}

export function select(name: string, options: Array<[string, string]>, value?: string): HTMLSelectElement {
  const el = h("select", { name });
  for (const [v, text] of options) el.append(h("option", { value: v, selected: v === value }, text));
  return el;
}

/** 文本框随内容增高（上限由 CSS max-height 控制）。 */
export function autosize(area: HTMLTextAreaElement): HTMLTextAreaElement {
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
  area.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return area;
}

// ───────────── 提示 ─────────────

let toastHost: HTMLElement | undefined;
/** 短暂提示：成功操作的确认。失败信息仍留在原处，便于对照处理。 */
/** 底部提示；带 action 时多一个按钮（如「撤销」），停留更久，点过一次即关闭。 */
export function toast(text: string, kind: "ok" | "error" = "ok", action?: { label: string; run: () => void }): void {
  if (!toastHost?.isConnected) { toastHost = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(toastHost); }
  const leave = () => { item.classList.add("leaving"); setTimeout(() => item.remove(), 200); };
  const item = h("div", { class: `toast toast-${kind}${action ? " toast-action" : ""}` }, icon(kind === "ok" ? "check" : "alert"), h("span", {}, text),
    action && h("button", { type: "button", class: "toast-btn", onclick: () => { leave(); action.run(); } }, action.label));
  toastHost.append(item);
  setTimeout(leave, action ? 8000 : kind === "ok" ? 2400 : 5000);
}

// ───────────── 弹出菜单 ─────────────

export interface MenuItem { value: string; label: string; icon?: Node; hint?: string; selected?: boolean }

let activeMenu: { anchor: HTMLElement; close: (restoreFocus?: boolean) => void } | undefined;

export function dismissMenu(): void {
  activeMenu?.close();
}

/** 锚定选择菜单。打开时优先向下，空间不足时向上。 */
export function openMenu(anchor: HTMLElement, items: MenuItem[], onPick: (value: string) => void, options: { filter?: boolean; placeholder?: string } = {}): void {
  if (activeMenu?.anchor === anchor) { activeMenu.close(true); return; }
  dismissMenu();
  const list = h("div", { class: "menu-list", role: "listbox" });
  const input = options.filter ? h("input", { class: "menu-filter", placeholder: options.placeholder ?? t("Filter…"), autocomplete: "off" }) : undefined;
  const menu = h("div", { class: "menu" }, input, list);
  let index = Math.max(0, items.findIndex(item => item.selected));
  let visible = items;
  let buttons: HTMLButtonElement[] = [];
  const close = (restoreFocus = false) => {
    activeMenu = undefined;
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", place);
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus) anchor.focus();
  };
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const pick = (item: MenuItem | undefined) => { if (item) { close(true); onPick(item.value); } };
  const setActive = (next: number, keyboard = false) => {
    buttons[index]?.classList.remove("is-active");
    index = next;
    const button = buttons[index];
    button?.classList.add("is-active");
    if (keyboard && button) {
      button.scrollIntoView({ block: "nearest" });
      if (!input) button.focus({ preventScroll: true });
    }
  };
  const render = () => {
    const q = input?.value.trim().toLowerCase() ?? "";
    visible = q ? items.filter(item => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)) : items;
    buttons = visible.map((item, i) => h("button", { type: "button", role: "option", class: "menu-item", tabindex: "-1", "aria-selected": String(!!item.selected),
      onpointerenter: (event: Event) => { if ((event as PointerEvent).pointerType === "mouse") setActive(i); },
      onclick: () => pick(item) },
      item.icon ?? h("span", { class: "menu-gap" }), h("span", { class: "menu-label" }, item.label), item.hint && h("span", { class: "menu-hint" }, item.hint),
      item.selected && icon("check", "icon menu-check")));
    clear(list, ...buttons);
    if (!visible.length) list.append(h("p", { class: "menu-empty" }, t("No matches")));
    setActive(Math.min(index, Math.max(0, visible.length - 1)));
  };
  const place = () => {
    const gutter = 8, gap = 4;
    const rect = anchor.getBoundingClientRect();
    menu.style.minWidth = `${Math.min(Math.max(200, rect.width), window.innerWidth - 2 * gutter)}px`;
    menu.style.left = `${Math.max(gutter, Math.min(rect.left, window.innerWidth - menu.offsetWidth - gutter))}px`;
    const below = window.innerHeight - rect.bottom - gap - gutter;
    const above = rect.top - gap - gutter;
    const opensUp = menu.offsetHeight > below && above > below;
    list.style.maxHeight = `${Math.max(40, Math.min(320, (opensUp ? above : below) - (input?.offsetHeight ?? 0) - 16))}px`;
    menu.style.top = `${Math.max(gutter, opensUp ? rect.top - gap - menu.offsetHeight : rect.bottom + gap)}px`;
  };
  menu.addEventListener("keydown", event => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step && visible.length) { event.preventDefault(); setActive((index + step + visible.length) % visible.length, true); }
    else if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); pick(visible[index]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") close(true);
  });
  input?.addEventListener("input", () => { index = 0; render(); place(); });
  render();
  document.body.append(menu);
  place();
  activeMenu = { anchor, close };
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", place);
  (input ?? buttons[index] ?? list).focus({ preventScroll: true });
}

/** 防抖：输入停顿后再执行。 */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms = 220): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: T) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/** 键盘快捷键是否应忽略（正在输入时）。 */
export function isTypingControl(target: HTMLElement | null): boolean {
  return !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export const typing = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement | null;
  return isTypingControl(target);
};
