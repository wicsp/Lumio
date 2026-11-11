import { typing } from "./dom.ts";

export function visibleItems(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
    .filter(item => item.getClientRects().length > 0 && !item.matches(":disabled"));
}

export function nextListItem(rows: HTMLElement[], current: HTMLElement | undefined, step: number): HTMLElement | undefined {
  const index = current ? rows.indexOf(current) : -1;
  return rows[index < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + step))];
}

export function focusListItem(item: HTMLElement): void {
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * 列表键盘导航：J/K 或 ↑/↓ 在可见行（[data-id]）之间移动并打开。
 * 正在输入或有对话框时不响应。返回解除监听的函数。
 */
export function listKeys(container: HTMLElement, open: (id: string) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (typing(event) || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]") || !container.isConnected) return;
    const step = event.key === "j" || event.key === "ArrowDown" ? 1 : event.key === "k" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    if (event.defaultPrevented || (document.activeElement as HTMLElement | null)?.closest(".detail-pane, .menu")) return;
    const rows = visibleItems(container, "[data-id]");
    const current = rows.find(row => row === document.activeElement) ?? rows.find(row => row.classList.contains("is-selected"));
    const next = nextListItem(rows, current, step);
    if (!next) return;
    event.preventDefault();
    focusListItem(next);
    open(next.dataset.id!);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/** 只标记选中行，不重建列表。 */
export function markSelected(container: HTMLElement, id: string | undefined): void {
  container.querySelectorAll<HTMLElement>("[data-id]").forEach(row => {
    const on = row.dataset.id === id;
    row.classList.toggle("is-selected", on);
    if (on) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
  });
}
