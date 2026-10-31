import { expect, test } from "bun:test";
import { RuntimeInfo } from "@lumio/schema";
import { ExecutionRuntimes, type RuntimeRecord, type RuntimeRegistryStore } from "../src/runtimes.ts";

class MemoryRegistry implements RuntimeRegistryStore {
  records = new Map<string, RuntimeRecord>();
  byActor(actor: string) { return this.records.get(actor); }
  byName(name: string) { return [...this.records.values()].find((record) => record.registration.name === name); }
  list() { return [...this.records.values()]; }
  save(record: RuntimeRecord) { this.records.set(record.actor, structuredClone(record)); }
  touch(actor: string, time: string) { const record = this.records.get(actor); if (!record) return false; this.save({ ...record, last_seen: time }); return true; }
  transaction<T>(action: () => T): T { const previous = new Map(this.records); try { return action(); } catch (cause) { this.records = previous; throw cause; } }
}
const first = "act_00000000000000000000000001", second = "act_00000000000000000000000002";
const registration = { protocol_version: 2, name: "server", engines: [], tags: [], max_concurrent: 1 };
const now = new Date("2026-10-31T00:00:00Z");

test("Execution owns runtime names, capability replacement and online facts through a pure store without Work, Knowledge or network", () => {
  const store = new MemoryRegistry(), runtimes = new ExecutionRuntimes(store);
  expect(RuntimeInfo.parse(runtimes.register(first, registration, now))).toMatchObject({ actor: first, online: true });
  runtimes.register(second, { ...registration, name: "lab" }, now);
  expect(runtimes.list(now).map((value) => value.registration.name)).toEqual(["lab", "server"]);
  expect(runtimes.list(new Date(now.getTime() + 180_000)).every((value) => value.online)).toBe(true);
  expect(runtimes.list(new Date(now.getTime() + 180_001)).every((value) => !value.online)).toBe(true);
  const changed = runtimes.register(first, { ...registration, engines: [{ name: "pi", version: "1.4.0", sandbox: "none" }], tags: ["gpu:4"], max_concurrent: 2 }, now);
  expect(changed.registration).toMatchObject({ max_concurrent: 2, tags: ["gpu:4"], engines: [{ name: "pi" }] });
  runtimes.sync(first, new Date(now.getTime() + 200_000));
  expect(runtimes.list(new Date(now.getTime() + 200_001)).filter((value) => value.online).map((value) => value.actor)).toEqual([first]);
  expect(() => runtimes.sync("act_00000000000000000000000003", now)).toThrow("尚未登记");
});

test("an identity cannot rename itself or occupy another device name; malformed protocol never alters registry state", () => {
  const store = new MemoryRegistry(), runtimes = new ExecutionRuntimes(store); runtimes.register(first, registration, now);
  const before = structuredClone(store.list());
  expect(() => runtimes.register(first, { ...registration, name: "another" }, now)).toThrow("不能更换名称");
  expect(() => runtimes.register(second, registration, now)).toThrow("另一身份");
  for (const input of [{ ...registration, protocol_version: 1 }, { ...registration, extra: "synthetic private text" }, { ...registration, max_concurrent: 0 }]) {
    try { runtimes.register(first, input, now); throw new Error("expected failure"); }
    catch (cause) { expect(cause).toHaveProperty("code", "INVALID"); expect(String(cause)).not.toContain("synthetic private text"); }
  }
  expect(store.list()).toEqual(before);
});
