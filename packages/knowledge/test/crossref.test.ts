import { expect, test } from "bun:test";
import response from "../../../fixtures/papers/crossref-lightgcn.json";
import { parseCrossrefMetadata } from "../src/index.ts";

test("parses the captured Crossref response and preserves author order", () => {
  const result = parseCrossrefMetadata(response);
  expect(result).toMatchObject({
    title: "LightGCN: Simplifying and Powering Graph Convolution Network for Recommendation",
    firstAuthorFamily: "He", authors: ["Xiangnan He", "Kuan Deng", "Xiang Wang", "Yan Li", "YongDong Zhang", "Meng Wang"],
    year: 2020, doi: "10.1145/3397271.3401063",
    venue: "Proceedings of the 43rd International ACM SIGIR Conference on Research and Development in Information Retrieval",
  });
});

test("collapses whitespace and omits empty optional fields", () => {
  const result = parseCrossrefMetadata({ message: {
    title: ["  A\n  title\twith   spaces "], author: [{ name: "  Example   Group " }],
    issued: { "date-parts": [[2024]] }, "container-title": ["  "], DOI: "", URL: "",
  } });
  expect(result).toEqual({ title: "A title with spaces", authors: ["Example Group"], year: 2024 });
});

test.each([null, {}, { message: {} }, { message: { title: ["Title"], author: [] } }, { message: { title: ["Title"], author: [{ family: "He" }] } }])("incomplete Crossref response is rejected", (value) => {
  expect(() => parseCrossrefMetadata(value)).toThrow("INVALID_CROSSREF_METADATA");
});
