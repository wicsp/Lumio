import type { PaperInput } from "@lumio/knowledge";

export type PaperFetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface SourceOptions {
  version: string;
  fetcher?: PaperFetcher;
  contactEmail?: string;
  timeoutMs?: number;
}
export type PaperSource = { kind: "arxiv"; metadata: string; bibtex: string }
  | { kind: "doi"; metadata: unknown; bibtex: string };

export class PaperSourceError extends Error {
  readonly code = "PAPER_SOURCE_FAILED";
  constructor(source: string, cause: unknown) {
    super(`${source} 请求失败：${cause instanceof Error ? cause.message : "未知错误"}`, { cause });
    this.name = "PaperSourceError";
  }
}

export async function fetchPaperSource(input: PaperInput, options: SourceOptions): Promise<PaperSource> {
  const fetcher = options.fetcher ?? fetch;
  async function request(url: string, source: string, accept: string): Promise<string> {
    try {
      const response = await fetcher(url, {
        headers: { "User-Agent": `lumio/${options.version}`, Accept: accept },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (cause) { throw new PaperSourceError(source, cause); }
  }
  if (input.kind === "arxiv") {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("id_list", input.id);
    const metadata = await request(url.href, "arXiv API", "application/atom+xml");
    const bibtex = await request(`https://arxiv.org/bibtex/${input.id}`, "arXiv BibTeX", "application/x-bibtex");
    return { kind: "arxiv", metadata, bibtex };
  }
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(input.doi)}`);
  if (options.contactEmail) url.searchParams.set("mailto", options.contactEmail);
  const text = await request(url.href, "Crossref", "application/json");
  let metadata: unknown;
  try { metadata = JSON.parse(text); }
  catch (cause) { throw new PaperSourceError("Crossref JSON", cause); }
  const doiPath = input.doi.split("/").map(encodeURIComponent).join("/");
  const bibtex = await request(`https://doi.org/${doiPath}`, "DOI BibTeX", "application/x-bibtex");
  return { kind: "doi", metadata, bibtex };
}
