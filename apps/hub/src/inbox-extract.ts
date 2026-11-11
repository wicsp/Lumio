import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import TurndownService from "turndown";
import { parseArxivMetadata, parseCrossrefMetadata, paperIdentity, rewriteBibtexKey, generateCitekey } from "@lumio/knowledge";
import { CAPTURE_LIMITS, type CaptureContent, type CaptureKind, type KnowledgeCreateRequest } from "@lumio/schema";
import { CaptureFailure, fetchCapture, validateCaptureUrl, type CaptureNetwork } from "./inbox-fetch.ts";

const tracking = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|mkt_tok)$/i;
const arxivPath = /^\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i;
const hosts = (host: string, candidates: readonly string[]) => candidates.some(domain => host === domain || host.endsWith("." + domain));

export function normalizeCaptureUrl(raw: string): string {
  const url = new URL(raw);
  // Validate the submitted authority before it could be replaced by a canonical one.
  if (url.username || url.password) throw new CaptureFailure("blocked");
  url.hostname = url.hostname.replace(/\.$/, "");
  const host = url.hostname;
  if (!url.port && ["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(host)) {
    const match = arxivPath.exec(url.pathname);
    try {
      if (match) return `https://arxiv.org/abs/${paperIdentity(decodeURIComponent(match[1]!), "arxiv")}`;
    } catch { /* Treat unrelated paths as regular URLs. */ }
  }
  if (!url.port && ["doi.org", "dx.doi.org"].includes(host)) {
    try {
      const doi = paperIdentity(decodeURIComponent(url.pathname.slice(1)), "doi")!;
      return "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/");
    } catch { /* Treat unrelated paths as regular URLs. */ }
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
  // Keep the byte representation when no query parameters need rewriting.
  return url.href;
}

export function captureKind(raw?: string): CaptureKind {
  if (!raw) return "text";
  const url = new URL(raw);
  if (!url.port && (url.hostname === "arxiv.org" && arxivPath.test(url.pathname) ||
      url.hostname === "doi.org" && /^\/10\.\d{4,9}\//.test(url.pathname))) return "paper";
  if (hosts(url.hostname, ["youtube.com", "youtu.be", "bilibili.com", "b23.tv", "vimeo.com"])) return "video";
  if (hosts(url.hostname, ["podcasts.apple.com", "xiaoyuzhoufm.com"])) return "podcast";
  return "web";
}

function documentFrom(html: string, url?: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (url) Object.defineProperties(doc, { baseURI: { value: url }, documentURI: { value: url } });
  return doc;
}

type HtmlElement = NonNullable<ReturnType<ReturnType<typeof documentFrom>["querySelector"]>>;

function markdown(element: HtmlElement, url?: string): string {
  for (const node of element.querySelectorAll("script,style,form,iframe,object,embed,button,nav,template,noscript,[hidden]")) node.remove();
  for (const node of element.querySelectorAll("[href],[src]")) {
    for (const key of ["href", "src"]) {
      const value = node.getAttribute(key);
      if (!value) continue;
      if (key === "href" && value.startsWith("#")) continue;
      try {
        const resolved = new URL(value, url);
        if (!["http:", "https:"].includes(resolved.protocol) || resolved.username || resolved.password) throw new Error();
        node.setAttribute(key, resolved.href.replaceAll("(", "%28").replaceAll(")", "%29"));
      } catch { node.removeAttribute(key); }
    }
  }
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  converter.addRule("math", {
    filter: "math",
    replacement: (_, node) => {
      const math = node as unknown as HtmlElement;
      const formula = math.getAttribute("alttext") ?? math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (!formula) return math.textContent ?? "";
      return math.getAttribute("display") === "block" ? `\n\n$$\n${formula}\n$$\n\n` : `$${formula}$`;
    },
  });
  return converter.turndown(element).trim();
}

function htmlText(html: string, url?: string, paper = false, supplied = false) {
  const doc = documentFrom(html, url);
  if (doc.querySelectorAll("*").length > 100_000) throw new CaptureFailure("too_large");
  const lang = doc.documentElement?.getAttribute("lang")?.trim();
  const fallback = doc.querySelector("article,main,[role=main]") ?? doc.body;
  const meta = (name: string) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? undefined;
  const fallbackTitle = meta("citation_title") ?? doc.querySelector("title,h1")?.textContent ?? undefined;
  let body: string, title = fallbackTitle;
  if (paper || supplied) {
    // arXiv uses LaTeXML. Retain equations, figures and bibliography from the article.
    const content = paper ? doc.querySelector("article.ltx_document,article,main") : fallback;
    if (!content) throw new CaptureFailure("extract_failed");
    body = markdown(content, url);
  } else {
    for (const node of doc.querySelectorAll("base,script,style,form,iframe,object,embed,template,noscript")) node.remove();
    const shortArticle = fallback?.cloneNode(true);
    const article = new Readability(doc, { maxElemsToParse: 100_000, charThreshold: 80, serializer: node => node }).parse();
    const element = article?.content as unknown as HtmlElement | undefined;
    const candidate = element ?? (fallback && fallback !== doc.body ? shortArticle as HtmlElement : undefined);
    if (!candidate) throw new CaptureFailure("extract_failed");
    body = markdown(candidate, url);
    title = article?.title || fallbackTitle;
  }
  return { body, title, lang: lang && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang) ? lang.toLowerCase() : undefined };
}

type NoteInput = KnowledgeCreateRequest["note"];
export interface Extracted {
  note: NoteInput;
  body: string;
  extractor: string;
  lang?: string;
}

const titleOf = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 500).replace(/[\uD800-\uDBFF]$/, "");
const titleFallback = (value: string) => titleOf(value).slice(0, 100) || "Captured text";

export async function extractCapture(
  url: string | undefined, kind: CaptureKind, title: string | undefined, content: CaptureContent | undefined,
  signal: AbortSignal, network?: CaptureNetwork,
): Promise<Extracted> {
  if (url) validateCaptureUrl(new URL(url));
  let body = content?.body.trim() ?? "", extractor = "pasted@1", lang: string | undefined;
  if (content?.format === "html") {
    const pasted = htmlText(/<html[\s>]/i.test(body) ? body : `<html><body>${body}</body></html>`, url, false, true);
    ({ body, lang } = pasted);
    title ??= pasted.title;
  }
  if (kind === "paper") {
    const paperUrl = new URL(url!);
    const arxiv = paperUrl.hostname === "arxiv.org";
    const id = paperIdentity(url, arxiv ? "arxiv" : "doi")!;
    const provider = arxiv ? "export.arxiv.org" : "api.crossref.org";
    const metadata = await fetchCapture(arxiv
      ? `https://${provider}/api/query?id_list=${encodeURIComponent(id)}`
      : `https://${provider}/works/${encodeURIComponent(id)}`,
    signal, network, type => /^(?:application\/(?:atom\+xml|json)|text\/xml)(?:;|$)/i.test(type),
    target => target.protocol === "https:" && !target.port && target.hostname === provider);
    const parsed = arxiv ? parseArxivMetadata(metadata.body) : parseCrossrefMetadata(JSON.parse(metadata.body));
    if (paperIdentity(arxiv ? parsed.arxiv : parsed.doi, arxiv ? "arxiv" : "doi") !== id) throw new CaptureFailure("extract_failed");
    if (!content) {
      if (arxiv) {
        const html = await fetchCapture(`https://arxiv.org/html/${id}`, signal, network,
          type => /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type),
          target => target.protocol === "https:" && !target.port && target.hostname === "arxiv.org");
        ({ body, lang } = htmlText(html.body, html.url, true));
        extractor = "arxiv-html@1";
      } else {
        const raw = JSON.parse(metadata.body) as { message?: { abstract?: unknown } };
        const abstract = typeof raw.message?.abstract === "string" ? documentFrom(`<html><body>${raw.message.abstract}</body></html>`).body.textContent?.trim() : undefined;
        body = abstract ? `## Abstract\n\n${abstract}` : "Bibliographic metadata only.";
        extractor = "metadata@1";
      }
    }
    let bibtex: string | undefined;
    const bibHost = arxiv ? "arxiv.org" : provider;
    try {
      const raw = await fetchCapture(arxiv ? `https://${bibHost}/bibtex/${id}`
        : `https://${bibHost}/works/${encodeURIComponent(id)}/transform/application/x-bibtex`,
      signal, network, type => /^(?:application\/x-bibtex|text\/plain)(?:;|$)/i.test(type),
      target => target.protocol === "https:" && !target.port && target.hostname === bibHost);
      if (raw.body.length <= 100_000) bibtex = rewriteBibtexKey(raw.body, generateCitekey(parsed));
    } catch {
      signal.throwIfAborted();
      // Metadata and the original remain useful when a provider has no BibTeX.
    }
    const { title: resolvedTitle, authors, year, arxiv: arxivId, doi, venue, firstAuthorFamily } = parsed;
    return checked({
      note: { kind: "paper", title: titleOf(title ?? resolvedTitle) || resolvedTitle, authors, year, arxiv: arxivId, doi, venue,
        url, firstAuthorFamily, bibtex, tags: [] },
      body, extractor, lang,
    });
  }
  if (!content) {
    if (kind === "video" || kind === "podcast") throw new CaptureFailure("runtime_unavailable");
    const response = await fetchCapture(url!, signal, network);
    if (response.type.toLowerCase().startsWith("text/plain")) {
      body = response.body.trim();
      extractor = "plain-text@1";
    } else {
      const article = htmlText(response.body, response.url);
      ({ body, lang } = article);
      title ??= article.title;
      extractor = "readability@1";
    }
  }
  return checked({ note: { kind: kind === "video" ? "video" : "web", title: titleOf(title ?? "") || titleFallback(body.split("\n")[0]!),
    url, site: url ? new URL(url).hostname : undefined, tags: [] }, body, extractor, lang });
}

function checked(extracted: Extracted): Extracted {
  if (!extracted.body.trim()) throw new CaptureFailure("extract_failed");
  if (extracted.body.length > CAPTURE_LIMITS.max_content_chars) throw new CaptureFailure("too_large");
  return extracted;
}
