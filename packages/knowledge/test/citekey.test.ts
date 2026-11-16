import { expect, test } from "bun:test";
import { Citekey } from "@lumio/schema";
import { generateCitekey, type PaperMetadata } from "../src/index.ts";

const metadata: PaperMetadata = { title: "LightGCN: A model", authors: ["Xiangnan He"], year: 2020 };

test("automatically returns a schema-valid citekey string", () => {
  const citekey = generateCitekey(metadata);
  expect(citekey).toBe("He_2020_LightGCN");
  expect(Citekey.parse(citekey)).toBe(citekey);
});

test.each([
  ["Mislav Balunović", "Balunovic_2020_LightGCN"],
  ["A Müller", "Muller_2020_LightGCN"],
  ["A Fernández-López", "FernandezLopez_2020_LightGCN"],
  ["A O'Brien", "OBrien_2020_LightGCN"],
  ["Laurens van der Maaten", "Maaten_2020_LightGCN"],
  ["Anders Søgaard", "Sgaard_2020_LightGCN"],
  ["Jan Łukasiewicz", "Ukasiewicz_2020_LightGCN"],
  ["张三", "Anon_2020_LightGCN"],
])("arXiv full name %s uses the last word then ASCII normalization", (author, citekey) => {
  expect(generateCitekey({ ...metadata, authors: [author] })).toBe(citekey);
});

test("Crossref family takes precedence; only its first character is capitalized", () => {
  expect(generateCitekey({ ...metadata, authors: ["Laurens van der Maaten"], firstAuthorFamily: "van der Maaten" }))
    .toBe("VanderMaaten_2020_LightGCN");
});

test.each([
  ["van der Maaten", "VanderMaaten"],
  ["Fernández-López", "FernandezLopez"],
  ["O'Brien", "OBrien"],
  ["Müller", "Muller"],
  ["Søgaard", "Sgaard"],
  ["Łukasiewicz", "Ukasiewicz"],
  ["张三", "Anon"],
])("Crossref family %s matches the accepted ADR 0004 example %s", (family, expected) => {
  expect(generateCitekey({ ...metadata, firstAuthorFamily: family })).toBe(`${expected}_2020_LightGCN`);
});

test.each([
  ["LightGCN: A model", "LightGCN"], ["AgentDojo: A dynamic environment", "AgentDojo"],
  ["GPT-4: An example", "GPT4"], ["😀GPT-4!: An example", "GPT4"],
  ["Defending Against Indirect Prompt Injection Attacks With Spotlighting", "DAIP"],
  ["A study of the graph and for with on in to model", "SGM"],
  ["中文标题", "Paper"], ["!!!", "Paper"], ["", "Paper"],
  ["!!!: Useful work", "UW"], ["of, the graph and model", "GM"],
  ["GPT-4 models for agents", "GMA"], ["中文of, the graph and model", "GM"],
  ["of the and with on in to", "Paper"],
])("title %j automatically supplies abbreviation %s", (title, abbreviation) => {
  const citekey = generateCitekey({ ...metadata, title });
  expect(citekey).toBe(`He_2020_${abbreviation}`);
  expect(Citekey.safeParse(citekey).success).toBe(true);
});

test.each([["Spotlighting", "Spotlighting"], ["GPT-4!", "GPT4"], ["two words", "twowords"], ["中文A_1", "A1"]])("explicit abbreviation %j is cleaned to %s", (input, cleaned) => {
  expect(generateCitekey(metadata, input)).toBe(`He_2020_${cleaned}`);
});

test.each(["", "!!", " \t", "中文"])("explicit empty-after-cleaning abbreviation is rejected: %j", (abbreviation) => {
  expect(() => generateCitekey(metadata, abbreviation)).toThrow("INVALID_ABBREVIATION");
});

test.each([20, 999, 10000, 2020.5, NaN, Infinity, -2020])("invalid year %s is not hidden by fallbacks", (year) => {
  try { generateCitekey({ ...metadata, year, authors: ["张三"], title: "中文" }); }
  catch (cause) { expect(cause).toMatchObject({ code: "INVALID_PAPER_YEAR" }); return; }
  throw new Error("expected invalid year");
});
