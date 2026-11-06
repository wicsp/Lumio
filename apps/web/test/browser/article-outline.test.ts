import { expect, test } from "bun:test";
import { markdownHeadings } from "../../src/client/article-outline.ts";

test("article outline keeps heading depth and source positions, including repeated titles", () => {
  const source = "# Introduction\n\nMethods\n-------\n\n### Setup ###\n\n### Setup";
  expect(markdownHeadings(source)).toEqual([
    { level: 1, label: "Introduction", position: 0 },
    { level: 2, label: "Methods", position: source.indexOf("Methods") },
    { level: 3, label: "Setup", position: source.indexOf("### Setup") },
    { level: 3, label: "Setup", position: source.lastIndexOf("### Setup") },
  ]);
});

test("article outline skips fenced code, escaped markers and empty headings", () => {
  const source = ["# Real title", "", "```md", "## Sample code", "```", "", "\\# Escaped", "", "###"].join("\n");
  expect(markdownHeadings(source)).toEqual([{ level: 1, label: "Real title", position: 0 }]);
});
