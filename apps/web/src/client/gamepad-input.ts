export const BUTTONS = ["A / ✕", "B / ○", "X / □", "Y / △", "LB / L1", "RB / R1", "LT / L2", "RT / R2",
  "View / Share", "Menu / Options", "L3", "R3", "↑", "↓", "←", "→"] as const;

export const DEFAULT_BINDINGS = {
  up: 12, down: 13, left: 14, right: 15, activate: 0, back: 1, delegate: 2, more: 3,
  previous: 4, next: 5, palette: 9, talk: 7,
};

export type PadCommand = keyof typeof DEFAULT_BINDINGS;
export type PadBindings = Record<PadCommand, number>;
export const PAD_COMMANDS = Object.keys(DEFAULT_BINDINGS) as PadCommand[];
export const HOLD_MS = 1000;

const STORAGE_KEY = "lumio.web.gamepad";
const REPEAT_DELAY = 350;
const REPEAT_MS = 110;
const DEAD_ZONE = 0.24;
const DIRECTIONS = ["up", "down", "left", "right"] as const;

export function loadBindings(storage: Pick<Storage, "getItem">): PadBindings {
  try {
    const saved: Partial<PadBindings> | null = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (saved && PAD_COMMANDS.every(command => Number.isInteger(saved[command]) && saved[command]! >= 0 && saved[command]! < BUTTONS.length)
      && new Set(PAD_COMMANDS.map(command => saved[command])).size === PAD_COMMANDS.length) {
      return Object.fromEntries(PAD_COMMANDS.map(command => [command, saved[command]])) as PadBindings;
    }
  } catch { /* Use the defaults if storage is inaccessible or the value is malformed. */ }
  return { ...DEFAULT_BINDINGS };
}

export function saveBindings(storage: Pick<Storage, "setItem">, bindings: PadBindings): boolean {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(bindings)); return true; }
  catch { return false; }
}

export function remap(bindings: PadBindings, command: PadCommand, button: number): PadBindings {
  if (!Number.isInteger(button) || button < 0 || button >= BUTTONS.length) return bindings;
  const occupied = PAD_COMMANDS.find(key => bindings[key] === button);
  const next = { ...bindings };
  if (occupied) next[occupied] = bindings[command];
  next[command] = button;
  return next;
}

export type PadSample = Pick<Gamepad, "index" | "id" | "mapping" | "timestamp"> & {
  buttons: readonly boolean[];
  axes: readonly number[];
};

export type PadInput = {
  command: PadCommand;
  phase: "press" | "release" | "hold" | "repeat";
} | { phase: "scroll"; x: number; y: number } | { phase: "reset" };

type Controls = { pad: PadSample; stick?: PadCommand };
type Press = { started: number; repeatAt: number; held: boolean };

function direction(axes: readonly number[]): PadCommand | undefined {
  const [x = 0, y = 0] = axes;
  if (Math.max(Math.abs(x), Math.abs(y)) < 0.55) return;
  return Math.abs(x) > Math.abs(y) ? (x < 0 ? "left" : "right") : (y < 0 ? "up" : "down");
}

function scrollAxis(value = 0): number {
  return Math.sign(value) * Math.max(0, (Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE));
}

function readCommands(controls: Controls | undefined, bindings: PadBindings): Set<PadCommand> {
  if (!controls) return new Set();
  const result = new Set(PAD_COMMANDS.filter(command => controls.pad.buttons[bindings[command]]));
  if (controls.stick) result.add(controls.stick);
  return result;
}

export class PadInputState {
  active?: PadSample;
  private previous = new Map<number, Controls>();
  private presses = new Map<PadCommand, Press>();
  private lastFrame?: number;

  reset(): void {
    this.active = undefined;
    this.previous.clear();
    this.presses.clear();
    this.lastFrame = undefined;
  }

  update(pads: readonly PadSample[], now: number, bindings: PadBindings, baseline = false): PadInput[] {
    const events: PadInput[] = [];
    const controls = pads.filter(pad => pad.mapping === "standard").map(pad => ({ pad, stick: direction(pad.axes) }));
    const previous = this.previous;
    this.previous = new Map(controls.map(entry => [entry.pad.index, entry]));
    const oldControls = (pad: PadSample) => {
      const old = previous.get(pad.index);
      return old?.pad.id === pad.id ? old : undefined;
    };
    const last = controls.find(({ pad }) => pad.index === this.active?.index && pad.id === this.active.id);
    const touched = controls.filter(({ pad, stick }) => {
      const old = oldControls(pad);
      return pad.buttons.some((down, index) => down && !old?.pad.buttons[index])
        || (stick && stick !== old?.stick)
        || (Math.max(Math.abs(pad.axes[2] ?? 0), Math.abs(pad.axes[3] ?? 0)) >= 0.55
          && Math.max(Math.abs(old?.pad.axes[2] ?? 0), Math.abs(old?.pad.axes[3] ?? 0)) < 0.55);
    }).sort((a, b) => b.pad.timestamp - a.pad.timestamp);
    const next = (baseline ? last : touched[0] ?? last) ?? controls[0];
    if (!next || next !== last) {
      if (this.active) events.push({ phase: "reset" });
      this.presses.clear();
    }
    this.active = next?.pad;
    const elapsed = this.lastFrame === undefined ? 0 : Math.min(40, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    if (!next || baseline) return events;

    const down = readCommands(next, bindings);
    const wasDown = readCommands(oldControls(next.pad), bindings);
    for (const command of PAD_COMMANDS) {
      const press = this.presses.get(command);
      if (!down.has(command)) {
        if (press) events.push({ command, phase: "release" });
        this.presses.delete(command);
      } else if (!wasDown.has(command)) {
        this.presses.set(command, { started: now, repeatAt: now + REPEAT_DELAY, held: false });
        events.push({ command, phase: "press" });
      } else if (press) {
        if (!press.held && now - press.started >= HOLD_MS) {
          press.held = true;
          events.push({ command, phase: "hold" });
        }
        if (DIRECTIONS.some(direction => direction === command) && now >= press.repeatAt) {
          press.repeatAt = now + REPEAT_MS;
          events.push({ command, phase: "repeat" });
        }
      }
    }
    const x = scrollAxis(next.pad.axes[2]) * elapsed;
    const y = scrollAxis(next.pad.axes[3]) * elapsed;
    if (x || y) events.push({ phase: "scroll", x, y });
    return events;
  }
}

export type PadStatus = { state: "unavailable" | "waiting" | "connected"; pad?: PadSample };

export class GamepadInput {
  private state = new PadInputState();
  private frame?: number;
  private baseline = false;
  private polling = false;
  private disposed = false;
  private bindings = loadBindings({
    getItem: key => window.localStorage.getItem(key),
  });
  private listeners = new Set<(status: PadStatus) => void>();
  private status: PadStatus = { state: "waiting" };

  constructor(private dispatch: (input: PadInput) => void) {
    window.addEventListener("gamepadconnected", this.wake);
    window.addEventListener("gamepaddisconnected", this.wake);
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("blur", this.pause);
    window.addEventListener("focus", this.wake);
    this.wake();
  }

  get mapping(): PadBindings { return this.bindings; }

  configure(bindings: PadBindings): boolean {
    this.bindings = bindings;
    this.baseline = true;
    this.state.reset();
    this.dispatch({ phase: "reset" });
    return saveBindings({ setItem: (key, value) => window.localStorage.setItem(key, value) }, bindings);
  }

  subscribe(listener: (status: PadStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
    window.removeEventListener("gamepadconnected", this.wake);
    window.removeEventListener("gamepaddisconnected", this.wake);
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("blur", this.pause);
    window.removeEventListener("focus", this.wake);
    this.listeners.clear();
  }

  private readonly visibility = () => {
    if (document.visibilityState === "visible") this.wake();
    else this.pause();
  };

  private readonly pause = () => {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.state.reset();
    this.baseline = true;
    this.dispatch({ phase: "reset" });
  };

  private readonly wake = (event?: Event) => {
    if (this.disposed || this.polling || document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (event?.type === "gamepaddisconnected" && this.state.active?.index === (event as GamepadEvent).gamepad.index) {
      this.pause();
    }
    if (this.frame === undefined) this.poll(performance.now());
  };

  private readonly poll = (now: number) => {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      this.frame = undefined;
      if (document.visibilityState !== "visible" || !document.hasFocus()) { this.pause(); return; }
      let raw: Gamepad[];
      try {
        if (typeof navigator.getGamepads !== "function") throw new Error("Gamepad API unavailable");
        raw = Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => !!pad?.connected);
      } catch {
        this.publish({ state: "unavailable" });
        this.pause();
        return;
      }
      const pads = raw.map(({ index, id, mapping, timestamp, buttons, axes }) =>
        ({ index, id, mapping, timestamp, buttons: Array.from(buttons, button => button.pressed || button.value >= 0.6), axes: Array.from(axes) }));
      const inputs = this.state.update(pads, now, this.bindings, this.baseline);
      this.baseline = false;
      for (const input of inputs) {
        if (this.disposed || document.visibilityState !== "visible" || !document.hasFocus()) break;
        this.dispatch(input);
      }
      if (this.disposed) return;
      this.publish({ state: pads.length ? "connected" : "waiting", pad: this.state.active ?? pads[0] });
      if (!this.disposed && pads.length && document.visibilityState === "visible" && document.hasFocus()) {
        this.frame = window.requestAnimationFrame(this.poll);
      }
    } finally {
      this.polling = false;
    }
  };

  private publish(status: PadStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
