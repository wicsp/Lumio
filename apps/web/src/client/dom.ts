/**
 * 极简 DOM 构造工具：动态文本一律走 textContent，不拼接 HTML。
 */

type Attr = string | number | boolean | undefined | null | ((event: Event) => void);
type Child = Node | string | number | null | undefined | false;

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

export function clear(el: Element, ...children: Child[]): void { el.replaceChildren(); append(el, ...children); }

export const loading = (text = "载入中…") => h("p", { class: "state state-loading", role: "status" }, text);
export const empty = (text: string) => h("p", { class: "state state-empty" }, text);
export const failure = (text: string, retry?: () => void) =>
  h("div", { class: "state state-error", role: "alert" }, h("span", {}, text), retry && h("button", { type: "button", class: "btn btn-small", onclick: retry }, "重试"));

/** 内联 SVG 图标（本地路径数据，不加载远程资源）。 */
const ICONS: Record<string, string> = {
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  brand: "M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3M12 8l4 4-4 4-4-4z",
  workspace: "M3 5h18v14H3zM3 10h18M8 10v9",
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  knowledge: "M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z",
  work: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  execution: "M5 4l14 8-14 8z",
  assistant: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z",
  approvals: "M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
};

export function icon(name: keyof typeof ICONS | string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name] ?? ""); svg.append(path);
  return svg;
}

/** 弹出原生 <dialog>，关闭后自动移除。返回 dialog 以便调用方填充表单。 */
export function openDialog(title: string, body: Node, actions: Node[]): HTMLDialogElement {
  const dialog = h("dialog", { class: "dialog", "aria-label": title },
    h("header", { class: "dialog-head" }, h("h2", {}, title), h("button", { type: "button", class: "btn btn-ghost", "aria-label": "关闭", onclick: () => {if(dialog.dataset.dirty!=="true"||confirm("有尚未保存的修改，确定关闭吗？"))dialog.close();} }, "×")),
    h("div", { class: "dialog-body" }, body), h("footer", { class: "dialog-foot" }, ...actions));
  dialog.addEventListener("input",()=>{dialog.dataset.dirty="true";});
  dialog.addEventListener("cancel",event=>{if(dialog.dataset.dirty==="true"&&!confirm("有尚未保存的修改，确定关闭吗？"))event.preventDefault();});
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog); dialog.showModal();
  return dialog;
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "field-hint" }, hint));
}

export function select(name: string, options: Array<[string, string]>, value?: string): HTMLSelectElement {
  const el = h("select", { name });
  for (const [v, text] of options) el.append(h("option", { value: v, selected: v === value }, text));
  return el;
}
