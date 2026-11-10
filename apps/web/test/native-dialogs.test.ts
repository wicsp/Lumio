import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 浏览器自带的 alert/confirm/prompt 风格与应用不一致、出现在页面顶部；一律改用 dom.ts 的 confirmDialog / promptDialog。
const root = join(import.meta.dir, "../src/client");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
const NATIVE = /(?:^|[^.\w$])(?:window\.|globalThis\.)?(alert|confirm|prompt)\s*\(/;

describe("in-app dialogs", () => {
  test("the web client never calls the browser's alert, confirm or prompt", () => {
    const hits = files(root).flatMap(file => readFileSync(file, "utf8").split("\n")
      .map((line, i) => ({ line: line.replace(/\/\/.*$/, ""), at: `${relative(root, file)}:${i + 1}` }))
      .filter(({ line }) => NATIVE.test(line)).map(({ at }) => at));
    expect(hits).toEqual([]);
  });
});
