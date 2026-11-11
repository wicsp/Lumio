import { drafts } from "./drafts.ts";
import { t } from "./i18n.ts";
import { matchRanges } from "./note-matches.ts";
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

/** 详情区的空白页：一个图标和一句引导。 */
export const placeholder = (iconName: string, text: string) =>
  h("div", { class: "placeholder" }, icon(iconName), h("p", {}, text));

// ───────────── 图标（本地路径，不加载远程资源） ─────────────

const ICONS: Record<string, string> = {
  inbox: "M4 13h4.5l1.5 2.5h4l1.5-2.5H20M4 13l2.5-8h11L20 13v6H4z",
  search: "M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0",
  home: "M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z",
  knowledge: "M5 4h5a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5zM19 4h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5z",
  work: "M9 11.5l2.5 2.5L16 9.5M5 4h14v16H5z",
  execution: "M4 6h16M4 12h10M4 18h6M17 14l4 3-4 3z",
  assistant: "M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z",
  approvals: "M12 3l8 3.5V12c0 4.4-3.4 7.7-8 9-4.6-1.3-8-4.6-8-9V6.5zM8.5 12l2.5 2.5 4.5-4.5",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  chevron: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  back: "M15 6l-6 6 6 6",
  alert: "M12 8v5M12 16.5v.5M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  send: "M12 19V5M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  pause: "M9 6v12M15 6v12",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20.5h4",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8",
  play: "M7 5l12 7-12 7z",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0",
  bot: "M8 9h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3zM12 9V5M10 14h0M14 14h0",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v5M16 3v5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  copy: "M9 9h10v10H9zM5 15V5h10",
  graph: "M7 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.5 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 21.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM9.4 5.6l6.7 1.6M7.8 7.3l1.6 9.3M17.2 9.8l-5.6 7.6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  device: "M4 5h16v11H4zM9 20h6M12 16v4",
  repeat: "M17 3l3 3-3 3M4 11V9a3 3 0 0 1 3-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 0 1-3 3H4",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  restore: "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4",
  memory: "M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3zM9.5 21h5",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  terminal: "M4 5h16v14H4zM8 10l2.5 2L8 14M13 14h3",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 16.8v.4",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  monitor: "M3 5h18v12H3zM8 21h8M12 17v4",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
};

export function icon(name: string, className = "icon"): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] ?? "");
  svg.append(path);
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

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false;
    const button = h("button", { type: "button", class: `btn ${options.danger ? "btn-danger" : "btn-primary"}`, "data-pad-hold": options.danger, onclick: () => { ok = true; dialog.close(); } },
      options.confirm ?? t("Confirm"));
    const dialog = openDialog(options.title, h("div", { class: "confirm-body" }, options.message ? h("p", {}, options.message) : null), [button],
      { narrow: true, cancelLabel: t("Cancel") });
    dialog.classList.add("dialog-confirm");
    dialog.addEventListener("close", () => resolve(ok));
    button.focus();
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

/** 锚定在按钮下方的选择菜单；方向键选择、Enter 确认、Esc 关闭。 */
export function openMenu(anchor: HTMLElement, items: MenuItem[], onPick: (value: string) => void, options: { filter?: boolean; placeholder?: string } = {}): void {
  document.querySelector(".menu")?.remove();
  const list = h("div", { class: "menu-list", role: "listbox" });
  const input = options.filter ? h("input", { class: "menu-filter", placeholder: options.placeholder ?? t("Filter…"), autocomplete: "off" }) : undefined;
  const menu = h("div", { class: "menu" }, input, list);
  let index = Math.max(0, items.findIndex(item => item.selected));
  let visible = items;
  const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); anchor.focus(); };
  const pick = (item: MenuItem | undefined) => { if (!item) return; close(); onPick(item.value); };
  const render = () => {
    const q = input?.value.trim().toLowerCase() ?? "";
    visible = q ? items.filter(item => item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q)) : items;
    index = Math.min(index, Math.max(0, visible.length - 1));
    clear(list, ...visible.map((item, i) => h("button", { type: "button", role: "option", class: `menu-item${i === index ? " is-active" : ""}`, "aria-selected": String(!!item.selected),
      onmousemove: () => { if (index !== i) { index = i; render(); } }, onclick: () => pick(item) },
      item.icon ?? h("span", { class: "menu-gap" }), h("span", { class: "menu-label" }, item.label), item.hint && h("span", { class: "menu-hint" }, item.hint),
      item.selected && icon("check", "icon menu-check"))));
    if (!visible.length) list.append(h("p", { class: "menu-empty" }, t("No matches")));
  };
  const outside = (event: MouseEvent) => { if (!menu.contains(event.target as Node) && event.target !== anchor) close(); };
  menu.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); index = (index + 1) % Math.max(1, visible.length); render(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); index = (index - 1 + visible.length) % Math.max(1, visible.length); render(); }
    else if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); pick(visible[index]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  input?.addEventListener("input", () => { index = 0; render(); });
  render();
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(200, rect.width);
  menu.style.minWidth = `${width}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
  const below = rect.bottom + 4, height = menu.offsetHeight;
  menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below}px`;
  document.addEventListener("mousedown", outside, true);
  (input ?? list.querySelector<HTMLButtonElement>(".is-active") ?? list.querySelector("button"))?.focus();
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
