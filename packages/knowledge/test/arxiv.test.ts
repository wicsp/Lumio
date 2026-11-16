import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Paper } from "@lumio/schema";
import { generateCitekey, parseArxivMetadata, parseFrontmatter, renderPaper } from "../src/index.ts";

const fixture = (name: string) => readFile(new URL(`../../../fixtures/papers/${name}`, import.meta.url), "utf8");

test.each([
  ["2002.02126", "He_2020_LightGCN", "Xiangnan He"],
  ["2403.14720", "Hines_2024_DAIP", "Keegan Hines"],
  ["2406.13352", "Debenedetti_2024_AgentDojo", "Edoardo Debenedetti"],
])("real Atom %s generates the recorded citekey and a schema-valid note", async (id, citekey, firstAuthor) => {
  const metadata = parseArxivMetadata(await fixture(`${id}.xml`));
  expect(metadata.authors[0]).toBe(firstAuthor);
  expect(metadata.arxiv).toBe(id);
  expect(metadata.url).toBe(`https://arxiv.org/abs/${id}`);
  expect(metadata).not.toHaveProperty("venue");
  const generated = generateCitekey(metadata);
  expect(generated).toBe(citekey);
  const note = renderPaper(metadata, generated, await fixture(`${id}.bib`), {
    now: new Date("2026-10-22T23:00:00+08:00"), tz: "Asia/Singapore",
    newId: (prefix) => `${prefix}_01J9Z3K8M2N4P6Q8R0S2T4V6W8`,
  });
  expect(Paper.safeParse(parseFrontmatter(note.content).data).success).toBe(true);
  if (id === "2406.13352") {
    expect(metadata.authors).toEqual(["Edoardo Debenedetti", "Jie Zhang", "Mislav Balunović", "Luca Beurer-Kellner", "Marc Fischer", "Florian Tramèr"]);
  }
});

test("Atom entities, namespaces, whitespace, DOI and old-style versioned IDs are handled", () => {
  const xml = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
    <atom:entry><atom:id>https://arxiv.org/abs/hep-th/9901001v2</atom:id>
    <atom:title>  A &amp; B:\n  multiple   spaces </atom:title>
    <atom:author><atom:name>Mislav Balunovi&#263;</atom:name></atom:author>
    <atom:published>1999-01-01T01:00:00Z</atom:published>
    <atom:updated>2026-10-22T01:00:00Z</atom:updated>
    <arxiv:doi>10.1145/3397271.3401063</arxiv:doi>
    <arxiv:journal_ref>Do not populate venue from this field</arxiv:journal_ref>
    </atom:entry></atom:feed>`;
  expect(parseArxivMetadata(xml)).toEqual({
    title: "A & B: multiple spaces", authors: ["Mislav Balunović"], year: 1999,
    arxiv: "hep-th/9901001", url: "https://arxiv.org/abs/hep-th/9901001", doi: "10.1145/3397271.3401063",
  });
});

test.each([
  "<feed><entry></feed>", "<feed/>", "<html>unavailable</html>",
  "<feed><entry><id>http://arxiv.org/abs/2403.14720</id></entry></feed>",
  "<!DOCTYPE feed [<!ENTITY x 'x'>]><feed/>",
])("invalid or incomplete Atom is a coded error: %j", (xml) => {
  try { parseArxivMetadata(xml); }
  catch (cause) { expect(cause).toMatchObject({ code: "INVALID_ARXIV_METADATA" }); return; }
  throw new Error("expected failure");
});
