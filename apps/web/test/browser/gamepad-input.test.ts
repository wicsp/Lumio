import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_BINDINGS, GamepadInput, HOLD_MS, PAD_COMMANDS, PadInputState, loadBindings, remap, saveBindings,
  type PadSample, type PadInput,
} from "../../src/client/gamepad-input.ts";
import { PAD_LABELS } from "../../src/client/gamepad-settings.ts";
import { ZH } from "../../src/client/i18n.ts";

function pad(index = 0, buttons: number[] = [], axes = [0, 0, 0, 0], timestamp = 0): PadSample {
  return { index, id: `Synthetic controller ${index}`, mapping: "standard", timestamp,
    buttons: Array.from({ length: 17 }, (_, index) => buttons.includes(index)), axes };
}

describe("G1 controller input", () => {
  test("buttons emit a press, one hold, and release, with no action repeat", () => {
    const state = new PadInputState();
    expect(state.update([pad()], 0, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad(0, [0])], 1, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "press" }]);
    expect(state.update([pad(0, [0])], HOLD_MS, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad(0, [0])], HOLD_MS + 1, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "hold" }]);
    expect(state.update([pad(0, [0])], HOLD_MS * 2, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad()], HOLD_MS * 2 + 1, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "release" }]);
  });

  test("early release cancels a hold and each new press starts from zero", () => {
    const state = new PadInputState();
    state.update([pad(0, [0])], 0, DEFAULT_BINDINGS);
    expect(state.update([pad()], 999, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "release" }]);
    expect(state.update([pad(0, [0])], 1000, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "press" }]);
    expect(state.update([pad(0, [0])], 1500, DEFAULT_BINDINGS)).toEqual([]);
  });

  test("only directions repeat, starting after the initial delay", () => {
    const state = new PadInputState();
    expect(state.update([pad(0, [13, 2])], 0, DEFAULT_BINDINGS)).toEqual([
      { command: "down", phase: "press" }, { command: "delegate", phase: "press" },
    ]);
    expect(state.update([pad(0, [13, 2])], 349, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad(0, [13, 2])], 350, DEFAULT_BINDINGS)).toEqual([{ command: "down", phase: "repeat" }]);
    expect(state.update([pad(0, [13, 2])], 400, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad(0, [13, 2])], 460, DEFAULT_BINDINGS)).toEqual([{ command: "down", phase: "repeat" }]);
  });

  test("sticks ignore drift, choose the dominant direction, and cap frame-time scroll jumps", () => {
    const state = new PadInputState();
    expect(state.update([pad(0, [], [0.2, -0.2, 0.23, -0.23])], 0, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.update([pad(0, [], [0.4, -0.9, 0, 0])], 10, DEFAULT_BINDINGS)).toEqual([{ command: "up", phase: "press" }]);
    const result = state.update([pad(0, [], [0.4, -0.9, 1, -1])], 10_000, DEFAULT_BINDINGS);
    expect(result).toContainEqual({ phase: "scroll", x: 40, y: -40 });
  });

  test("two controllers respond only to the last newly active controller, releasing old holds on handover", () => {
    const state = new PadInputState();
    state.update([pad(0), pad(1)], 0, DEFAULT_BINDINGS);
    state.update([pad(0, [0]), pad(1)], 1, DEFAULT_BINDINGS);
    expect(state.active?.index).toBe(0);
    expect(state.update([pad(0, [0]), pad(1, [1])], 2, DEFAULT_BINDINGS)).toEqual([
      { phase: "reset" }, { command: "back", phase: "press" },
    ]);
    expect(state.active?.index).toBe(1);
    expect(state.update([pad(0, [0]), pad(1, [1])], 1100, DEFAULT_BINDINGS))
      .not.toContainEqual({ command: "activate", phase: "hold" });
  });

  test("disconnect, reconnect, and foreground baseline never transfer a pending hold", () => {
    const state = new PadInputState();
    state.update([pad(0, [0])], 0, DEFAULT_BINDINGS);
    expect(state.update([], 500, DEFAULT_BINDINGS)).toEqual([{ phase: "reset" }]);
    state.reset();
    expect(state.update([pad(0, [0])], 1000, DEFAULT_BINDINGS, true)).toEqual([]);
    expect(state.update([pad(0, [0])], 2200, DEFAULT_BINDINGS)).toEqual([]);
    state.update([pad()], 2201, DEFAULT_BINDINGS);
    expect(state.update([pad(0, [0])], 2202, DEFAULT_BINDINGS)).toEqual([{ command: "activate", phase: "press" }]);
  });

  test("unmapped controllers cannot issue commands with guessed button indices", () => {
    const state = new PadInputState();
    const unknown: PadSample = { ...pad(0, [0, 13]), mapping: "" };
    expect(state.update([unknown], 0, DEFAULT_BINDINGS)).toEqual([]);
    expect(state.active).toBeUndefined();
  });

  test("remapping swaps the occupied key and persists through reload", () => {
    const bindings = remap(DEFAULT_BINDINGS, "activate", DEFAULT_BINDINGS.back);
    expect(bindings.activate).toBe(1);
    expect(bindings.back).toBe(0);
    expect(new Set(Object.values(bindings)).size).toBe(PAD_COMMANDS.length);
    let saved = "";
    expect(saveBindings({ setItem: (_key, value) => { saved = value; } }, bindings)).toBe(true);
    expect(loadBindings({ getItem: () => saved })).toEqual(bindings);
    expect(loadBindings({ getItem: () => JSON.stringify(DEFAULT_BINDINGS) })).toEqual(DEFAULT_BINDINGS);
    expect(remap(bindings, "activate", -1)).toBe(bindings);
  });

  test("malformed, duplicated, partial, and denied storage degrade to usable defaults", () => {
    for (const value of ["null", "{}", "[]", "invalid", JSON.stringify({ ...DEFAULT_BINDINGS, up: 0 }),
      JSON.stringify({ ...DEFAULT_BINDINGS, up: 99 }), JSON.stringify({ ...DEFAULT_BINDINGS, up: "12" })]) {
      expect(loadBindings({ getItem: () => value })).toEqual(DEFAULT_BINDINGS);
    }
    expect(loadBindings({ getItem: () => { throw new Error("denied"); } })).toEqual(DEFAULT_BINDINGS);
    expect(saveBindings({ setItem: () => { throw new Error("denied"); } }, DEFAULT_BINDINGS)).toBe(false);
    expect(PAD_COMMANDS.every(command => PAD_LABELS[command] in ZH)).toBe(true);
  });
});

let restore = () => {};
afterEach(() => restore());

function browser() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  const frames = new Map<number, FrameRequestCallback>();
  let focused = true;
  let pads: (Gamepad | null)[] = [];
  let nextFrame = 0;
  let reads = 0;
  const nav = { getGamepads: () => { reads++; return pads; } };
  Object.assign(win, {
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const descriptors = ["window", "document", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries({ window: win, document: doc, navigator: nav })) Object.defineProperty(globalThis, key, { value, configurable: true });
  restore = () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    win, doc, frames, nav,
    get reads() { return reads; },
    setFocus: (value: boolean) => { focused = value; },
    setPads: (value: PadSample[]) => {
      pads = value.map(pad => ({ ...pad, connected: true, axes: [...pad.axes], vibrationActuator: null, buttons: pad.buttons.map(pressed => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })) })) as unknown as Gamepad[];
    },
    frame(now: number) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    },
  };
}

describe("G1 visible-page polling lifecycle", () => {
  test("no controller means no animation loop, and connect/disconnect starts/stops it", () => {
    const page = browser();
    const inputs: PadInput[] = [];
    const input = new GamepadInput(event => inputs.push(event));
    expect(page.reads).toBe(1);
    expect(page.frames.size).toBe(0);
    page.setPads([pad()]);
    page.win.dispatchEvent(new Event("gamepadconnected"));
    expect(page.frames.size).toBe(1);
    page.win.dispatchEvent(new Event("gamepadconnected"));
    expect(page.frames.size).toBe(1);
    page.setPads([]);
    page.frame(20);
    expect(page.frames.size).toBe(0);
    expect(inputs).toContainEqual({ phase: "reset" });
    input.dispose();
    page.setPads([pad()]);
    page.win.dispatchEvent(new Event("gamepadconnected"));
    expect(page.frames.size).toBe(0);
  });

  test("hidden and unfocused pages cancel polling, and held inputs must be released after returning", () => {
    const page = browser();
    page.setPads([pad()]);
    const inputs: PadInput[] = [];
    const input = new GamepadInput(event => inputs.push(event));
    page.setPads([pad(0, [0])]);
    page.frame(10);
    expect(inputs).toContainEqual({ command: "activate", phase: "press" });
    page.doc.visibilityState = "hidden";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(page.frames.size).toBe(0);
    const reads = page.reads;
    page.win.dispatchEvent(new Event("gamepadconnected"));
    expect(page.reads).toBe(reads);
    page.doc.visibilityState = "visible";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    inputs.length = 0;
    page.frame(2000);
    expect(inputs).toEqual([]);
    page.setFocus(false);
    page.win.dispatchEvent(new Event("blur"));
    expect(page.frames.size).toBe(0);
    input.dispose();
  });

  test("focusing a row from inside a frame cannot start a second polling loop", () => {
    const page = browser();
    page.setPads([pad()]);
    const input = new GamepadInput(event => {
      if (event.phase === "press") page.win.dispatchEvent(new Event("focus"));
    });
    page.setPads([pad(0, [13])]);
    page.frame(10);
    expect(page.frames.size).toBe(1);
    input.dispose();
  });

  test("blocked or missing APIs report unavailable and never schedule a frame", () => {
    const page = browser();
    page.nav.getGamepads = () => { throw new Error("SecurityError"); };
    const input = new GamepadInput(() => {});
    let state = "";
    input.subscribe(status => { state = status.state; });
    expect(state).toBe("unavailable");
    expect(page.frames.size).toBe(0);
    input.dispose();
  });
});
