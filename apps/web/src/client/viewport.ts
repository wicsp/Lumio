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

function acceptsKeyboard(element: Element | null): boolean {
  if (!element || element.getAttribute("inputmode") === "none") return false;
  if ((element as HTMLElement).isContentEditable) return true;
  if (!element.matches("input:not(:disabled, [readonly]), textarea:not(:disabled, [readonly])")) return false;
  return element.tagName === "TEXTAREA" || keyboardInputTypes.has((element as HTMLInputElement).type);
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
  const sync = () => {
    frame = undefined;
    // A transient browser scale change is not a keyboard resize.
    if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
    if (viewport.width !== width) {
      width = viewport.width;
      restingHeight = viewport.height;
    }
    const editing = touch.matches && acceptsKeyboard(doc.activeElement);
    // Some browsers shrink the layout viewport as well. Keep the pre-focus
    // height available in that case. Ignore small shifts from browser chrome.
    const coveredHeight = Math.max(root.clientHeight, restingHeight) - viewport.height;
    const showThreshold = 128;
    const hideThreshold = 96;
    // Keep the nav hidden during dismissal, even if focus has already moved.
    const open = touch.matches && (editing || keyboardOpen)
      && coveredHeight >= (keyboardOpen ? hideThreshold : showThreshold);
    if (!open) restingHeight = editing ? Math.max(restingHeight, viewport.height) : viewport.height;
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
