import { describe, expect, test } from "bun:test";
import { preventPageZoom, trackViewport } from "../../src/client/viewport.ts";

function browser(coarse = true) {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  const doc = Object.assign(new EventTarget(), { activeElement: null as Element | null, body: null as Element | null });
  const properties = new Map<string, string>();
  const attributes = new Set<string>();
  const writes: string[] = [];
  const root = {
    ownerDocument: doc,
    clientHeight: 844,
    style: {
      setProperty: (name: string, value: string) => { writes.push(name); properties.set(name, value); },
      removeProperty: (name: string) => properties.delete(name),
    },
    toggleAttribute: (name: string, force: boolean) => force ? attributes.add(name) : attributes.delete(name),
    removeAttribute: (name: string) => attributes.delete(name),
  };
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const host = {
    visualViewport: viewport,
    matchMedia: () => ({ matches: coarse }),
    getComputedStyle: (element: { overflowY: string }) => ({ overflowY: element.overflowY }),
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
  const focus = (element: Element | null) => {
    doc.activeElement = element;
    doc.dispatchEvent(new Event(element ? "focusin" : "focusout"));
    flush();
  };
  return { host, root: root as unknown as HTMLElement, doc, layout: root, viewport, properties, writes, attributes, frames, flush, focus, resize };
}

function field({ tagName = "TEXTAREA", type = "text", editable = false, writable = true, inputMode = null as string | null } = {}) {
  return { tagName, type, isContentEditable: editable, matches: () => writable, getAttribute: () => inputMode } as unknown as Element;
}

const keyboardAttribute = "data-keyboard-open";

function scrollPane(height: number, top: () => number, parentElement: HTMLElement | null = null, overflowY = "auto") {
  return {
    parentElement, overflowY, clientTop: 0, clientHeight: height, scrollHeight: 1000, scrollTop: 0,
    getBoundingClientRect: () => ({ top: top() }),
  };
}

function positionedField(pane: ReturnType<typeof scrollPane>, top: () => number, doc: object) {
  return Object.assign(field(), {
    parentElement: pane, ownerDocument: doc,
    getBoundingClientRect: () => ({ top: top(), bottom: top() + 40, height: 40 }),
  });
}

describe("visible app viewport", () => {
  test("keyboard opening, panning and closing keep the frame within the visible area", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    expect(b.properties.get("--viewport-height")).toBe("844px");
    b.focus(field());
    b.resize(390, 50);
    expect(b.properties.get("--viewport-height")).toBe("390px");
    expect(b.properties.get("--viewport-top")).toBe("50px");
    expect(b.attributes.has(keyboardAttribute)).toBe(true);
    b.focus(null);
    b.resize(700);
    expect(b.attributes.has(keyboardAttribute)).toBe(true);
    b.resize(844);
    expect(b.properties.get("--viewport-height")).toBe("844px");
    expect(b.properties.get("--viewport-top")).toBe("0px");
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    stop();
  });

  test("focus and browser toolbar movement leave navigation visible with the keyboard closed", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.focus(field());
    b.resize(760);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    b.resize(440);
    expect(b.attributes.has(keyboardAttribute)).toBe(true);
    b.resize(760);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    b.resize(745);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    stop();
  });

  test("keyboard opening scrolls a covered field into view without moving the document", () => {
    const b = browser();
    const body = scrollPane(844, () => 0);
    b.doc.body = body as unknown as Element;
    const pane = scrollPane(380, () => 48, body as unknown as HTMLElement);
    const input = positionedField(pane, () => 620 - pane.scrollTop, b.doc);
    const stop = trackViewport(b.host, b.root);
    b.focus(input);
    expect(pane.scrollTop).toBe(0);
    b.resize(390);
    expect(pane.scrollTop).toBe(278);
    expect(body.scrollTop).toBe(0);
    expect(b.doc.activeElement).toBe(input);

    // Duplicate viewport events and keyboard dismissal leave manual scrolling alone.
    pane.scrollTop = 100;
    b.resize(390);
    b.resize(844);
    expect(pane.scrollTop).toBe(100);
    stop();
  });

  test("changing focus with the keyboard visible only scrolls if the next field is clipped", () => {
    const b = browser();
    const pane = scrollPane(380, () => 48);
    const stop = trackViewport(b.host, b.root);
    b.focus(positionedField(pane, () => 300 - pane.scrollTop, b.doc));
    b.resize(390, 80);
    expect(pane.scrollTop).toBe(0);
    b.focus(positionedField(pane, () => 460 - pane.scrollTop, b.doc));
    expect(pane.scrollTop).toBe(80);
    b.focus(positionedField(pane, () => 140 - pane.scrollTop, b.doc));
    expect(pane.scrollTop).toBe(52);
    stop();
  });

  test("nested panes reveal a field in an initially offscreen inner pane", () => {
    const b = browser();
    const outer = scrollPane(390, () => 0);
    const inner = scrollPane(160, () => 500 - outer.scrollTop, outer as unknown as HTMLElement);
    const input = positionedField(inner, () => 700 - outer.scrollTop - inner.scrollTop, b.doc);
    const stop = trackViewport(b.host, b.root);
    b.focus(input);
    b.resize(390);
    expect(inner.scrollTop).toBe(88);
    expect(outer.scrollTop).toBe(270);
    expect(input.getBoundingClientRect().bottom).toBe(382);
    stop();
  });

  test("a tall contenteditable field uses the caret position when opening the keyboard", () => {
    const b = browser();
    const pane = scrollPane(390, () => 0);
    const caretNode = {};
    const doc = Object.assign(b.doc, {
      getSelection: () => ({
        isCollapsed: true, rangeCount: 1, focusNode: caretNode,
        getRangeAt: () => ({ getBoundingClientRect: () => ({
          top: 550 - pane.scrollTop, bottom: 568 - pane.scrollTop, height: 18,
        }) }),
      }),
    });
    const editor = Object.assign(field({ tagName: "DIV", editable: true, writable: false }), {
      parentElement: pane, ownerDocument: doc, contains: (node: object) => node === caretNode,
      getBoundingClientRect: () => ({ top: 20 - pane.scrollTop, bottom: 680 - pane.scrollTop, height: 660 }),
    });
    const stop = trackViewport(b.host, b.root);
    b.focus(editor);
    b.resize(390);
    expect(pane.scrollTop).toBe(186);
    stop();
  });

  test("shrinking both viewports still hides navigation for an editable field", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.focus(field({ tagName: "DIV", editable: true, writable: false }));
    b.layout.clientHeight = 440;
    b.resize(440);
    expect(b.attributes.has(keyboardAttribute)).toBe(true);
    b.layout.clientHeight = 844;
    b.resize(844);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    stop();
  });

  test("non-text controls and a desktop window resize leave navigation available", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    for (const control of [field({ tagName: "INPUT", type: "checkbox" }), field({ writable: false }), field({ inputMode: "none" })]) {
      b.focus(control);
      b.resize(440);
      expect(b.attributes.has(keyboardAttribute)).toBe(false);
      b.resize(844);
    }
    stop();
    const desktop = browser(false);
    const stopDesktop = trackViewport(desktop.host, desktop.root);
    desktop.focus(field());
    desktop.resize(440);
    expect(desktop.attributes.has(keyboardAttribute)).toBe(false);
    stopDesktop();
  });

  test("rotation resets the resting height and repeated geometry does not rewrite styles", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.focus(field({ tagName: "INPUT", type: "search" }));
    b.viewport.width = 844;
    b.layout.clientHeight = 390;
    b.resize(390);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    b.writes.length = 0;
    b.resize(390);
    expect(b.writes).toEqual([]);
    b.resize(390, 24);
    expect(b.writes).toEqual(["--viewport-top"]);
    stop();
  });

  test("cleanup removes keyboard state and the document focus listeners", () => {
    const b = browser();
    const stop = trackViewport(b.host, b.root);
    b.focus(field());
    b.resize(440);
    expect(b.attributes.has(keyboardAttribute)).toBe(true);
    stop();
    b.focus(null);
    expect(b.attributes.has(keyboardAttribute)).toBe(false);
    expect(b.properties.size).toBe(0);
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
