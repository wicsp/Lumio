import { test, expect } from "bun:test";
import { mayHaveHeadings } from "../../src/client/article-outline.ts";

test("the outline is offered only when the text may contain a heading", () => {
  expect(mayHaveHeadings("plain text\nmore text")).toBe(false);
  expect(mayHaveHeadings("#hashtag is not a heading")).toBe(false);
  expect(mayHaveHeadings("intro\n\n## Method\nbody")).toBe(true);
  expect(mayHaveHeadings("Title\n=====\n")).toBe(true);
});
