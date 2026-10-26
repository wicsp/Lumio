import type { Link } from "@lumio/schema";

export interface RawLink { source: Link["source"]; target: string }

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

export interface Citation { source: "wikilink" | "cite"; target: string }

/** Count citation commands as occurrences, even when a command contains several keys. */
export function extractCitations(body: string): { citations: Citation[]; ignored: number } {
  const text = withoutCode(body);
  const ai = /<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?(?:<!--\s*lumio:ai end\b[^>]*-->|$)/g;
  const commands = /\\(?:cite|citep|citet|parencite|textcite)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g;
  let ignored = 0;
  const human = text.replace(ai, (block) => {
    ignored += extractLinks({}, block.replace(/<!--[^>]*-->/g, "")).length + [...block.matchAll(commands)].length;
    return "";
  });
  const citations: Citation[] = extractLinks({}, human).map((link) => ({ source: "wikilink", target: link.target }));
  for (const match of human.matchAll(commands)) {
    for (const key of match[1]!.split(",")) {
      const target = key.trim();
      if (target) citations.push({ source: "cite", target });
    }
  }
  return { citations, ignored };
}

/** Remove code and AI-owned blocks before extracting human-owned links. */
export function extractLinks(frontmatter: Record<string, unknown>, body: string): RawLink[] {
  // 链接只来自正文的 [[ ]]（ADR 0018）；frontmatter 里遗留的 related 不再计入。
  void frontmatter;
  const links: RawLink[] = [];
  const human = withoutCode(body)
    .replace(/<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?(?:<!--\s*lumio:ai end\b[^>]*-->|$)/g, "");
  for (const match of human.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const target = match[1]!.split(/[|#]/, 1)[0]!.trim();
    if (target) links.push({ source: "wikilink", target });
  }
  return links;
}

/** Search snippets contain text, with Markdown/HTML presentation removed. */
export function plainText(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, name, alias) => alias ?? name)
    .replace(/[`*_~#]/g, "").replace(/\s+/g, " ").trim();
}
