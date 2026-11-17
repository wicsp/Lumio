import { expect, test } from "bun:test";
import { browserChoice } from "../../src/client/browser-preferences.ts";

const definition = {
  key: "lumio.web.sidebar-usage-style",
  label: "Collapsed sidebar usage style",
  options: [{ value: "bars", label: "Bars" }, { value: "arcs", label: "Arcs" }],
  fallback: "bars",
} as const;

function testStorage(initial?: string) {
  const records = new Map<string, string>(initial === undefined ? [] : [[definition.key, initial]]);
  return {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
    clear: () => records.clear(),
  };
}

test("a fresh browser and an unknown future choice use bars without writing over storage", () => {
  for (const initial of [null, "future-style"]) {
    const storage = testStorage(initial ?? undefined);
    const values: string[] = [];
    const choice = browserChoice(definition, () => storage);
    const unsubscribe = choice.subscribe(value => values.push(value));
    expect(values).toEqual(["bars"]);
    expect(choice.choose("future-style")).toBe(false);
    expect(storage.getItem(definition.key)).toBe(initial);
    unsubscribe();
  }
});

test("choosing arcs notifies the current page and persists across reloads", () => {
  const storage = testStorage();
  const values: string[] = [];
  const choice = browserChoice(definition, () => storage);
  const unsubscribe = choice.subscribe(value => values.push(value));
  expect(choice.choose("arcs")).toBe(true);
  expect(values).toEqual(["bars", "arcs"]);
  unsubscribe();
  const reopened = browserChoice(definition, () => storage);
  const stop = reopened.subscribe(value => values.push(value));
  expect(values.at(-1)).toBe("arcs");
  stop();
});

test("changes from other tabs sync only for this local storage key", () => {
  const storage = testStorage();
  const events = new EventTarget();
  const values: string[] = [];
  const choice = browserChoice(definition, () => storage, events);
  const emit = (key: string | null, storageArea = storage) =>
    events.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea }));
  const unsubscribe = choice.subscribe(value => values.push(value));
  storage.setItem(definition.key, "arcs");
  emit("unrelated");
  emit(definition.key, testStorage());
  expect(values).toEqual(["bars"]);
  emit(definition.key);
  storage.clear();
  emit(null);
  expect(values).toEqual(["bars", "arcs", "bars"]);
  unsubscribe();
  storage.setItem(definition.key, "arcs");
  const reopen = choice.subscribe(value => values.push(value));
  expect(values).toEqual(["bars", "arcs", "bars", "arcs"]);
  reopen();
});

test("blocked storage still lets this tab choose a style", () => {
  const choice = browserChoice(definition, () => { throw new Error("Storage blocked"); });
  const values: string[] = [];
  const unsubscribe = choice.subscribe(value => values.push(value));
  expect(choice.choose("arcs")).toBe(false);
  expect(values).toEqual(["bars", "arcs"]);
  unsubscribe();
  const reopen = choice.subscribe(value => values.push(value));
  expect(values.at(-1)).toBe("arcs");
  reopen();
});
