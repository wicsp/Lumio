import { XMLParser } from "fast-xml-parser";
import { CoreError } from "@lumio/foundation";
import { parsePaperInput } from "./paper-input.ts";
import { normalizeWhitespace, type PaperMetadata } from "./paper-metadata.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("预期 Atom 对象");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  const scalar = value && typeof value === "object" ? record(value)["#text"] : value;
  if (typeof scalar !== "string") throw new Error("预期 Atom 文本");
  return normalizeWhitespace(scalar);
}

/** Local Atom parsing only: source fetching belongs to apps/cli. */
export function parseArxivMetadata(xml: string): PaperMetadata {
  try {
    if (/<!DOCTYPE\b/i.test(xml)) throw new Error("Atom 响应不应含 DTD");
    const parser = new XMLParser({
      ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false,
      htmlEntities: true, // Also decode numeric Unicode character references.
      trimValues: false, isArray: (name) => ["entry", "author", "link"].includes(name),
    });
    const document: unknown = parser.parse(xml, true);
    const entries = record(record(document).feed).entry;
    if (!Array.isArray(entries) || entries.length !== 1) throw new Error("响应必须包含一篇论文");
    const entry = record(entries[0]);
    const input = parsePaperInput(text(entry.id));
    if (input.kind !== "arxiv") throw new Error("响应不是 arXiv 论文");
    const title = text(entry.title);
    if (!title || !Array.isArray(entry.author) || !entry.author.length) throw new Error("缺少标题或作者");
    const authors = entry.author.map((author: unknown) => {
      const name = text(record(author).name);
      if (!name) throw new Error("缺少作者姓名");
      return name;
    });
    const published = text(entry.published);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(published) || !Number.isFinite(Date.parse(published))) throw new Error("缺少合法的首次发表时间");
    let doi: string | undefined;
    if (entry.doi !== undefined && text(entry.doi)) {
      const identifier = parsePaperInput(text(entry.doi));
      if (identifier.kind !== "doi") throw new Error("arXiv DOI 字段不合法");
      doi = identifier.doi;
    }
    return {
      title, authors, year: Number(published.slice(0, 4)), arxiv: input.id,
      url: `https://arxiv.org/abs/${input.id}`, ...(doi ? { doi } : {}),
    };
  } catch (cause) {
    throw new CoreError("INVALID_ARXIV_METADATA", "arXiv Atom 元数据不完整或不是合法 XML 响应", { cause });
  }
}
