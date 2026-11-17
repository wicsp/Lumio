import { describe, expect, test } from "bun:test";
import { preventPageZoom, trackViewport } from "../../src/client/viewport.ts";

function browser() {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const properties = new Map<string, string>();
  const root = { style: {
    setProperty: (name: string, value: string) => properties.set(name, value),
    removeProperty: (name: string) => properties.delete(name),
  } } as unknown as HTMLElement;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const host = {
    visualViewport: viewport,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  } as unknown as Window;
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  const resize = (height: number, offsetTop = 0, scale = 1) => {
    Object.assign(viewport, { height, offsetTop, scale });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    flush();
  };
  return { host, root, viewport, properties, frames, flush, resize };
}

describe("visible app viewport", () => {
  test("keyboard opening, panning and closing keep the frame within the visible area", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    expect(b.properties.get("--viewport-height")).toBe("844px");
    b.resize(390, 50);
    expect(b.properties.get("--viewport-height")).toBe("390px");
    expect(b.properties.get("--viewport-top")).toBe("50px");
    b.resize(844);
    expect(b.properties.get("--viewport-height")).toBe("844px");
    expect(b.properties.get("--viewport-top")).toBe("0px");
    stop();
  });

  test("an unexpected browser scale change cannot shrink or reposition the app frame", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.resize(422, 100, 2);
    expect(b.properties.get("--viewport-height")).toBe("844px");
    expect(b.properties.get("--viewport-top")).toBe("0px");
    b.resize(390, 40);
    expect(b.properties.get("--viewport-height")).toBe("390px");
    expect(b.properties.get("--viewport-top")).toBe("40px");
    stop();
  });

  test("rotation and bursts of viewport events use the final geometry once per frame", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.viewport.height = 390;
    b.viewport.dispatchEvent(new Event("resize"));
    b.viewport.height = 370;
    b.viewport.dispatchEvent(new Event("resize"));
    b.viewport.dispatchEvent(new Event("scroll"));
    expect(b.frames.size).toBe(1);
    b.flush();
    expect(b.properties.get("--viewport-height")).toBe("370px");
    b.resize(0);
    expect(b.properties.get("--viewport-height")).toBe("370px");
    stop();
  });

  test("cleanup cancels queued work and detaches listeners", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.viewport.dispatchEvent(new Event("resize"));
    stop();
    expect(b.frames.size).toBe(0);
    expect(b.properties.size).toBe(0);
    b.resize(390, 50);
    expect(b.frames.size).toBe(0);
    expect(b.properties.size).toBe(0);
  });

  test("browsers without VisualViewport keep the CSS viewport fallback", () => {
    const b = browser();
    trackViewport({ visualViewport: null } as Window, b.root)();
    expect(b.properties.size).toBe(0);
  });
});

describe("page zoom prevention", () => {
  const touch = (fingers: number) => Object.defineProperty(new Event("touchmove", { cancelable: true }), "touches", { value: { length: fingers } });

  test("WebKit pinch gestures are canceled even when viewport limits are ignored", () => {
    const target = new EventTarget();
    const stop = preventPageZoom(target);
    for (const type of ["gesturestart", "gesturechange"]) {
      const event = new Event(type, { cancelable: true });
      expect(target.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    stop();
  });

  test("multi-touch cannot zoom the page, while a single finger can still scroll", () => {
    const target = new EventTarget();
    const stop = preventPageZoom(target);
    for (const fingers of [2, 3]) {
      const event = touch(fingers);
      expect(target.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(target.dispatchEvent(touch(1))).toBe(true);
    expect(target.dispatchEvent(new Event("click", { cancelable: true }))).toBe(true);
    expect(target.dispatchEvent(new Event("touchend", { cancelable: true }))).toBe(true);
    stop();
  });

  test("cleanup restores gesture and multi-touch defaults", () => {
    const target = new EventTarget();
    const stop = preventPageZoom(target);
    stop();
    expect(target.dispatchEvent(new Event("gesturestart", { cancelable: true }))).toBe(true);
    expect(target.dispatchEvent(new Event("gesturechange", { cancelable: true }))).toBe(true);
    expect(target.dispatchEvent(touch(2))).toBe(true);
  });
});
