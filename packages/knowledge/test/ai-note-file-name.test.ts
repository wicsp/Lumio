import { expect, test } from "bun:test";
import { aiNoteFileName } from "../src/authoring.ts";

// ADR 0053：AI 笔记文件名 = 标题 + ID。只用合成数据。
const id = "ain_01JA0000000000000000000000";

test("title comes first and the ID keeps the name unique", () => {
  expect(aiNoteFileName("LightGCN 摘要", id)).toBe(`LightGCN 摘要 ${id}`);
  expect(aiNoteFileName("  多个   空格  ", id)).toBe(`多个 空格 ${id}`);
});

test("path, link and control characters never reach the file name", () => {
  const name = aiNoteFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n\u0000o\nq', id);
  expect(name).toBe(`a b c d e f g h i j k l m n o q ${id}`);
  expect(aiNoteFileName("../../etc", id)).toBe(`etc ${id}`);
  expect(aiNoteFileName(".hidden", id)).toBe(`hidden ${id}`);
});

test("empty or symbol-only titles fall back to the ID, long titles are cut", () => {
  expect(aiNoteFileName("///", id)).toBe(id);
  expect(aiNoteFileName("", id)).toBe(id);
  const long = aiNoteFileName("长".repeat(100), id);
  expect(long).toBe(`${"长".repeat(60)} ${id}`);
});
