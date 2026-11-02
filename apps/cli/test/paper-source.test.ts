import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parsePaperInput } from "@lumio/knowledge";
import { fetchPaperSource, type PaperFetcher } from "../src/paper-source.ts";

const fixture = (name: string) => readFile(new URL(`../../../fixtures/papers/${name}`, import.meta.url), "utf8");

test.each(["2002.02126", "2403.14720", "2406.13352"])("arXiv %s requests metadata and BibTeX through the injected fetcher", async (id) => {
  const calls: string[] = [];
  const xml = await fixture(`${id}.xml`);
  const bib = await fixture(`${id}.bib`);
  const fetcher: PaperFetcher = async (url, init) => {
    calls.push(url);
    expect(new Headers(init.headers).get("User-Agent")).toBe("lumio/0.0.0");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Response(url.startsWith("https://export.arxiv.org/") ? xml : bib);
  };
  expect(await fetchPaperSource(parsePaperInput(`${id}v2`), { version: "0.0.0", fetcher })).toEqual({ kind: "arxiv", metadata: xml, bibtex: bib });
  expect(calls).toEqual([`https://export.arxiv.org/api/query?id_list=${id}`, `https://arxiv.org/bibtex/${id}`]);
});

test("Crossref receives optional mailto; DOI BibTeX uses content negotiation", async () => {
  const calls: string[] = [];
  const json = await fixture("crossref-lightgcn.json");
  const bib = await fixture("crossref-lightgcn.bib");
  const fetcher: PaperFetcher = async (url, init) => {
    calls.push(url);
    const crossref = url.startsWith("https://api.crossref.org/");
    expect(new Headers(init.headers).get("Accept")).toBe(crossref ? "application/json" : "application/x-bibtex");
    expect(new Headers(init.headers).get("User-Agent")).toBe("lumio/0.0.0");
    expect(new URL(url).searchParams.has("mailto")).toBe(crossref);
    return new Response(crossref ? json : bib);
  };
  expect(await fetchPaperSource(parsePaperInput("10.1145/3397271.3401063"), { version: "0.0.0", fetcher, contactEmail: "fixture@example.invalid" }))
    .toEqual({ kind: "doi", metadata: JSON.parse(json), bibtex: bib });
  expect(calls[0]).toContain("mailto=fixture%40example.invalid");
});

test("without configured contact email no mailto is sent", async () => {
  const fetcher: PaperFetcher = async (url) => {
    expect(new URL(url).searchParams.has("mailto")).toBe(false);
    return new Response(url.includes("crossref") ? await fixture("crossref-lightgcn.json") : await fixture("crossref-lightgcn.bib"));
  };
  await fetchPaperSource(parsePaperInput("10.1145/3397271.3401063"), { version: "0.0.0", fetcher });
});

test.each(["arXiv API", "arXiv BibTeX", "Crossref", "DOI BibTeX"])("errors identify the failing source: %s", async (source) => {
  const arxiv = source.startsWith("arXiv");
  const input = parsePaperInput(arxiv ? "2002.02126" : "10.1145/3397271.3401063");
  const fetcher: PaperFetcher = async (url) => {
    const fail = source === "arXiv API" || source === "Crossref" || url.includes("/bibtex/") || url.startsWith("https://doi.org/");
    if (fail) return new Response("failure", { status: 503 });
    return new Response(arxiv ? await fixture("2002.02126.xml") : await fixture("crossref-lightgcn.json"));
  };
  await expect(fetchPaperSource(input, { version: "0.0.0", fetcher })).rejects.toThrow(`${source} 请求失败`);
});

test("timeout is passed to the fetcher and surfaces as a source failure", async () => {
  const fetcher: PaperFetcher = (_url, init) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
  await expect(fetchPaperSource(parsePaperInput("2002.02126"), { version: "0.0.0", fetcher, timeoutMs: 5 })).rejects.toThrow("arXiv API 请求失败");
});

test("invalid Crossref JSON is attributed to its source", async () => {
  await expect(fetchPaperSource(parsePaperInput("10.1145/3397271.3401063"), { version: "0.0.0", fetcher: async () => new Response("not json") }))
    .rejects.toThrow("Crossref JSON 请求失败");
});
