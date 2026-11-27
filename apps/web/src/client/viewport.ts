/** Block page magnification, including WebKit gestures that can ignore viewport limits. */
export function preventPageZoom(target: EventTarget = document): () => void {
  const gesture = (event: Event) => event.preventDefault();
  const move = (event: Event) => {
    if ((event as TouchEvent).touches.length > 1) event.preventDefault();
  };
  const options = { capture: true, passive: false };
  target.addEventListener("gesturestart", gesture, options);
  target.addEventListener("gesturechange", gesture, options);
  target.addEventListener("touchmove", move, options);
  return () => {
    target.removeEventListener("gesturestart", gesture, options);
    target.removeEventListener("gesturechange", gesture, options);
    target.removeEventListener("touchmove", move, options);
  };
}

const keyboardInputTypes = new Set(["email", "number", "password", "search", "tel", "text", "url"]);

function acceptsKeyboard(element: Element | null): element is HTMLElement {
  if (!element || element.getAttribute("inputmode") === "none") return false;
  if ((element as HTMLElement).isContentEditable) return true;
  if (!element.matches("input:not(:disabled, [readonly]), textarea:not(:disabled, [readonly])")) return false;
  return element.tagName === "TEXTAREA" || keyboardInputTypes.has((element as HTMLInputElement).type);
}

function revealField(field: HTMLElement, host: Window, viewport: VisualViewport): void {
  const doc = field.ownerDocument;
  for (let pane = field.parentElement; pane && pane !== doc.body; pane = pane.parentElement) {
    if (pane.scrollHeight <= pane.clientHeight || !/^(auto|scroll|overlay)$/.test(host.getComputedStyle(pane).overflowY)) continue;
    const paneTop = pane.getBoundingClientRect().top + pane.clientTop;
    const paneBottom = paneTop + pane.clientHeight;
    const clippedTop = Math.max(paneTop, viewport.offsetTop);
    const clippedBottom = Math.min(paneBottom, viewport.offsetTop + viewport.height);
    // An outer scroller may bring a currently offscreen pane into view.
    const top = clippedBottom > clippedTop ? clippedTop : paneTop;
    const bottom = clippedBottom > clippedTop ? clippedBottom : paneBottom;
    if (bottom <= top) continue;

    const margin = Math.min(8, (bottom - top) / 4);
    const visibleHeight = bottom - top - 2 * margin;
    let rect = field.getBoundingClientRect();
    if (field.isContentEditable && rect.height > visibleHeight) {
      const selection = doc.getSelection();
      if (selection?.isCollapsed && selection.rangeCount && field.contains(selection.focusNode)) {
        const caret = selection.getRangeAt(0).getBoundingClientRect();
        if (caret.height > 0) rect = caret;
      }
    }
    const fieldBottom = Math.min(rect.bottom, rect.top + visibleHeight);
    if (fieldBottom > bottom - margin) {
      pane.scrollTop += fieldBottom - (bottom - margin);
    } else if (rect.top < top + margin && rect.bottom <= bottom) {
      pane.scrollTop -= top + margin - rect.top;
    }
  }
}

/** Keep the app inside the visible area when a phone keyboard pans/shrinks it. */
export function trackViewport(host: Window = window, root: HTMLElement = document.documentElement): () => void {
  const viewport = host.visualViewport;
  if (!viewport) return () => {};
  const doc = root.ownerDocument;
  const touch = host.matchMedia("(any-pointer: coarse)");
  let frame: number | undefined;
  let width = viewport.width;
  let restingHeight = viewport.height;
  let height: number | undefined;
  let top: number | undefined;
  let keyboardOpen = false;
  let focusedField: HTMLElement | null = null;
  const sync = () => {
    frame = undefined;
    // A transient browser scale change is not a keyboard resize.
    if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
    if (viewport.width !== width) {
      width = viewport.width;
      restingHeight = viewport.height;
    }
    const active = doc.activeElement;
    const field = touch.matches && acceptsKeyboard(active) ? active : null;
    // Some browsers shrink the layout viewport as well. Keep the pre-focus
    // height available in that case. Ignore small shifts from browser chrome.
    const coveredHeight = Math.max(root.clientHeight, restingHeight) - viewport.height;
    const showThreshold = 128;
    const hideThreshold = 96;
    // Keep the nav hidden during dismissal, even if focus has already moved.
    const open = touch.matches && (field !== null || keyboardOpen)
      && coveredHeight >= (keyboardOpen ? hideThreshold : showThreshold);
    if (!open) restingHeight = field ? Math.max(restingHeight, viewport.height) : viewport.height;
    const shouldReveal = open && field && (!keyboardOpen || field !== focusedField
      || viewport.height !== height || viewport.offsetTop !== top);
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      root.toggleAttribute("data-keyboard-open", open);
    }
    if (viewport.height !== height) {
      height = viewport.height;
      root.style.setProperty("--viewport-height", `${height}px`);
    }
    if (viewport.offsetTop !== top) {
      top = viewport.offsetTop;
      root.style.setProperty("--viewport-top", `${top}px`);
    }
    // Layout has adapted to the keyboard. Reveal the field inside its scroll
    // panes without panning the page or reacting to manual pane scrolling.
    if (shouldReveal) revealField(field, host, viewport);
    focusedField = field;
  };
  const schedule = () => { frame ??= host.requestAnimationFrame(sync); };
  sync();
  viewport.addEventListener("resize", schedule, { passive: true });
  viewport.addEventListener("scroll", schedule, { passive: true });
  doc.addEventListener("focusin", schedule);
  doc.addEventListener("focusout", schedule);
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    doc.removeEventListener("focusin", schedule);
    doc.removeEventListener("focusout", schedule);
    if (frame !== undefined) host.cancelAnimationFrame(frame);
    root.removeAttribute("data-keyboard-open");
    root.style.removeProperty("--viewport-height");
    root.style.removeProperty("--viewport-top");
  };
}
