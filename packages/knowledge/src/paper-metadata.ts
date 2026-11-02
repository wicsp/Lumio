import { CoreError } from "@lumio/foundation";

export interface PaperMetadata {
  title: string;
  authors: string[];
  year: number;
  firstAuthorFamily?: string;
  arxiv?: string;
  doi?: string;
  url?: string;
  venue?: string;
}

export const normalizeWhitespace = (value: string): string => value.replace(/\s+/gu, " ").trim();

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("预期对象");
  return value as Record<string, unknown>;
}

function firstText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? normalizeWhitespace(first) || undefined : undefined;
}

export function parseCrossrefMetadata(json: unknown): PaperMetadata {
  try {
    const message = record(record(json).message);
    const mainTitle = firstText(message.title);
    const subtitle = firstText(message.subtitle);
    const title = mainTitle && subtitle && subtitle !== mainTitle ? `${mainTitle}: ${subtitle}` : mainTitle;
    if (!title || !Array.isArray(message.author) || !message.author.length) throw new Error("缺少标题或作者");
    const authors = message.author.map((value) => {
      const author = record(value);
      const name = [firstText(author.given), firstText(author.family)].filter(Boolean).join(" ") || firstText(author.name);
      if (!name) throw new Error("缺少作者姓名");
      return name;
    });
    let year: number | undefined;
    for (const key of ["published", "published-print", "published-online", "issued"]) {
      const value = message[key];
      if (!value) continue;
      const parts = record(value)["date-parts"];
      const date = Array.isArray(parts) ? parts[0] : undefined;
      const candidate = Array.isArray(date) ? date[0] : undefined;
      if (typeof candidate === "number" && Number.isInteger(candidate)) { year = candidate; break; }
    }
    if (year === undefined) throw new Error("缺少发表年份");
    const family = firstText(record(message.author[0]).family);
    const doi = firstText(message.DOI);
    const url = firstText(message.URL);
    const venue = firstText(message["container-title"]);
    return {
      title, authors, year,
      ...(family ? { firstAuthorFamily: family } : {}),
      ...(doi ? { doi } : {}), ...(url ? { url } : {}), ...(venue ? { venue } : {}),
    };
  } catch (cause) {
    throw new CoreError("INVALID_CROSSREF_METADATA", "Crossref 元数据不完整或不是合法响应", { cause });
  }
}
