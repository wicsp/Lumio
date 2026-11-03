import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ZH, setLang, t } from "../src/client/i18n.ts";

const root = join(import.meta.dir, "../src/client");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") && name !== "i18n.ts" ? [path] : [];
  });
}
// 只收集字面量调用：t("…") / tParts("…")
const CALL = /\b(?:t|tParts)\(\s*"((?:[^"\\]|\\.)*)"/g;
const used = new Set<string>();
for (const file of files(root)) {
  for (const m of readFileSync(file, "utf8").matchAll(CALL)) used.add(JSON.parse(`"${m[1]}"`));
}
const holes = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort().join(",");

describe("web i18n", () => {
  test("every literal key has a Chinese translation", () => {
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter(k => !(k in ZH))).toEqual([]);
  });
  test("translations keep the same placeholders", () => {
    expect(Object.entries(ZH).filter(([en, zh]) => holes(en) !== holes(zh)).map(([en]) => en)).toEqual([]);
  });
  test("t falls back to English and fills placeholders", () => {
    setLang("en", false);
    expect(t("{0} min ago", 5)).toBe("5 min ago");
    setLang("zh", false);
    expect(t("{0} min ago", 5)).toBe("5 分钟前");
    expect(t("not a key {0}", 1)).toBe("not a key 1");
    setLang("en", false);
  });
});
