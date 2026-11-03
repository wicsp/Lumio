import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { rewriteBibtexKey } from "../src/index.ts";

test.each(["2002.02126", "2403.14720", "2406.13352", "crossref-lightgcn"])("rewrites only the key in captured BibTeX %s", async (name) => {
  const source = await readFile(new URL(`../../../fixtures/papers/${name}.bib`, import.meta.url), "utf8");
  const original = /^(\s*@[a-z]+\s*[{(]\s*)([^,\s]+)(\s*,)/i.exec(source)!;
  const output = rewriteBibtexKey(source, "He_2020_LightGCN");
  expect(output).toBe(original[1] + "He_2020_LightGCN" + source.slice(original[1]!.length + original[2]!.length));
});

test.each(["<html>error</html>", "@misc{missing", "@comment{a comment}", ""])("rejects invalid BibTeX %j", (source) => {
  expect(() => rewriteBibtexKey(source, "He_2020_LightGCN")).toThrow("INVALID_BIBTEX");
});
