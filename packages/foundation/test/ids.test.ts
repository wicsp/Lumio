import { expect, test } from "bun:test";
import { Id, ID_PREFIXES, idOf } from "@lumio/schema";
import { CoreError, newId } from "../src/index.ts";

test("ULIDs use the schema prefixes and exact 48-bit time / 80-bit entropy", () => {
  for (const prefix of Object.values(ID_PREFIXES)) {
    const id = newId(prefix, new Date(0), (n) => new Uint8Array(n));
    expect(id).toBe(`${prefix}_00000000000000000000000000`);
    expect(Id.parse(id)).toBe(id);
    expect(idOf(prefix).parse(id)).toBe(id);
  }
  expect(newId("pap", new Date(0xffffffffffff), (n) => new Uint8Array(n).fill(255)))
    .toBe("pap_7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
});

test("lexical order follows time regardless of randomness", () => {
  const earlier = newId("idea", new Date(1000), (n) => new Uint8Array(n).fill(255));
  const later = newId("idea", new Date(1001), (n) => new Uint8Array(n));
  expect(earlier < later).toBe(true);
  expect(newId("idea", new Date(1000), (n) => new Uint8Array(n))).not.toBe(earlier);
});

test.each([new Date(NaN), new Date(-1), new Date(0x1000000000000)])("rejects invalid ID time %s", (date) => {
  expect(() => newId("idea", date, (n) => new Uint8Array(n))).toThrow(CoreError);
});

test("invalid random sources have coded errors", () => {
  try { newId("idea", new Date(0), () => new Uint8Array(1)); }
  catch (cause) { expect(cause).toMatchObject({ code: "INVALID_ID_SOURCE" }); return; }
  throw new Error("expected error");
});
