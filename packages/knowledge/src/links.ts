import type { Link } from "@lumio/schema";
import { posix } from "node:path";

export type RawLink = { source: "wikilink"; target: string }
  | { source: "markdown"; target: string; fromPath: string };

/** Paths are vault-relative POSIX paths, independent of the host filesystem. */
export function resolveMarkdownPath(fromPath: string, target: string): string | undefined {
  const file = posix.extname(target) ? target : `${target}.md`;
  const path = posix.normalize(target.startsWith("/") ? file.slice(1) : posix.join(posix.dirname(fromPath), file));
  return path === ".." || path.startsWith("../") || posix.isAbsolute(path) ? undefined : path;
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Read one inline destination, including balanced parentheses and an optional title. */
function destination(text: string, opening: number): { target: string; end: number } | undefined {
  let cursor = opening + 1;
  while (/\s/.test(text[cursor] ?? "")) cursor++;
  let target: string;
  if (text[cursor] === "<") {
    const start = ++cursor;
    while (cursor < text.length && (text[cursor] !== ">" || escaped(text, cursor))) {
      if (text[cursor] === "\n" || text[cursor] === "<") return;
      cursor++;
    }
    if (cursor === text.length) return;
    target = text.slice(start, cursor++);
  } else {
    const start = cursor;
    let depth = 0;
    while (cursor < text.length) {
      const char = text[cursor]!;
      if (!escaped(text, cursor)) {
        if (/\s/.test(char)) break;
        if (char === "(") depth++;
        if (char === ")") { if (!depth) break; depth--; }
        if (char === "<") return;
      }
      cursor++;
    }
    if (depth) return;
    target = text.slice(start, cursor);
  }
  const afterTarget = cursor;
  while (/\s/.test(text[cursor] ?? "")) cursor++;
  if (text[cursor] !== ")") {
    // A title must be separated from the destination by whitespace.
    const quote = text[cursor];
    if (cursor === afterTarget || (quote !== '"' && quote !== "'" && quote !== "(")) return;
    const closing = quote === "(" ? ")" : quote;
    cursor++;
    while (cursor < text.length && (text[cursor] !== closing || escaped(text, cursor))) cursor++;
    if (cursor === text.length) return;
    cursor++;
    while (/\s/.test(text[cursor] ?? "")) cursor++;
  }
  return text[cursor] === ")" ? { target, end: cursor } : undefined;
}

function markdownLinks(text: string, fromPath: string): RawLink[] {
  const links: RawLink[] = [];
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text[cursor] !== "[" || text[cursor + 1] === "[" || text[cursor - 1] === "[" || escaped(text, cursor)) continue;
    const image = text[cursor - 1] === "!" && !escaped(text, cursor - 1);
    let labelEnd = cursor + 1, depth = 1;
    for (; labelEnd < text.length; labelEnd++) {
      if (escaped(text, labelEnd)) continue;
      if (text[labelEnd] === "[") depth++;
      if (text[labelEnd] === "]" && --depth === 0) break;
    }
    if (depth || text[labelEnd + 1] !== "(") continue;
    const parsed = destination(text, labelEnd + 1);
    if (!parsed) continue;
    cursor = parsed.end;
    if (image) continue;
    let target = parsed.target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1").split(/[?#]/, 1)[0]!;
    try { target = decodeURIComponent(target); } catch { /* Keep malformed URL escapes verbatim. */ }
    if (!target || target.endsWith("/") || target.includes("\0") || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
    const extension = posix.extname(target);
    if (extension && extension !== ".md") continue;
    links.push({ source: "markdown", target, fromPath });
  }
  return links;
}

function withoutCode(body: string): string {
  let fence: { character: string; length: number } | undefined;
  const lines = body.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return "";
    }
    if (marker) { fence = { character: marker[1]![0]!, length: marker[1]!.length }; return ""; }
    return line;
  }).join("\n");
  // Inline code closes only on a backtick run of exactly the opening length.
  let result = "", cursor = 0;
  const runs = [...lines.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i]!;
    const closing = runs.findIndex((run, j) => j > i && run[0].length === opening[0].length);
    if (closing < 0) continue;
    result += lines.slice(cursor, opening.index);
    cursor = runs[closing]!.index + runs[closing]![0].length;
    i = closing;
  }
  return result + lines.slice(cursor);
}

export interface Citation { source: Link["source"] | "cite"; target: string }

/** Count citation commands as occurrences, even when a command contains several keys. */
export function extractCitations(body: string, fromPath = ""): { citations: Citation[]; ignored: number } {
  const text = withoutCode(body);
  const ai = /<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?(?:<!--\s*lumio:ai end\b[^>]*-->|$)/g;
  const commands = /\\(?:cite|citep|citet|parencite|textcite)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g;
  let ignored = 0;
  const human = text.replace(ai, (block) => {
    ignored += extractLinks({}, block.replace(/<!--[^>]*-->/g, ""), fromPath).length + [...block.matchAll(commands)].length;
    return "";
  });
  const citations: Citation[] = extractLinks({}, human, fromPath);
  for (const match of human.matchAll(commands)) {
    for (const key of match[1]!.split(",")) {
      const target = key.trim();
      if (target) citations.push({ source: "cite", target });
    }
  }
  return { citations, ignored };
}

/** Remove code and AI-owned blocks before extracting human-owned links. */
export function extractLinks(frontmatter: Record<string, unknown>, body: string, fromPath = ""): RawLink[] {
  // 链接只来自正文（ADR 0018、0022）；frontmatter 里遗留的 related 不再计入。
  void frontmatter;
  const links: RawLink[] = [];
  const human = withoutCode(body)
    .replace(/<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?(?:<!--\s*lumio:ai end\b[^>]*-->|$)/g, "");
  for (const match of human.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1]!.split(/[|#]/, 1)[0]!.trim();
    if (target) links.push({ source: "wikilink", target });
  }
  return [...links, ...markdownLinks(human, fromPath)];
}

/** Search snippets contain text, with Markdown/HTML presentation removed. */
export function plainText(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, name, alias) => alias ?? name)
    .replace(/[`*_~#]/g, "").replace(/\s+/g, " ").trim();
}
