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

/** Keep the app inside the visible area when an iPhone keyboard pans/shrinks it. */
export function trackViewport(host: Window = window, root: HTMLElement = document.documentElement): () => void {
  const viewport = host.visualViewport;
  if (!viewport) return () => {};
  let frame: number | undefined;
  const sync = () => {
    frame = undefined;
    // A transient browser scale change is not a keyboard resize.
    if (Math.abs(viewport.scale - 1) > 0.01 || viewport.height <= 0) return;
    root.style.setProperty("--viewport-height", `${viewport.height}px`);
    root.style.setProperty("--viewport-top", `${viewport.offsetTop}px`);
  };
  const schedule = () => { frame ??= host.requestAnimationFrame(sync); };
  sync();
  viewport.addEventListener("resize", schedule, { passive: true });
  viewport.addEventListener("scroll", schedule, { passive: true });
  return () => {
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    if (frame !== undefined) host.cancelAnimationFrame(frame);
    root.style.removeProperty("--viewport-height");
    root.style.removeProperty("--viewport-top");
  };
}
