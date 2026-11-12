import { extractKnowledgeLinks } from "@lumio/knowledge";

/** The standalone paragraph shape used by Web AI embeds; resolve targets with the normal link parser. */
export function embeddedLinks(body: string, path: string) {
  let fence: { marker: string; length: number } | undefined;
  const text = body.replace(/<!--\s*lumio:ai start\b[^>]*-->[\s\S]*?(?:<!--\s*lumio:ai end\b[^>]*-->|$)/g, "")
    .split("\n").map(line => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
        return "";
      }
      if (marker) { fence = { marker: marker[1]![0]!, length: marker[1]!.length }; return ""; }
      return line;
    }).join("\n");
  return text.split(/\n\s*\n/).flatMap(paragraph => {
    // No surrounding prose, list/heading marker, image, or code indentation.
    if (/^(?:\r?\n)*(?: {4}|\t)/.test(paragraph)) return [];
    const line = paragraph.trim();
    if (!/^\[\[[^\]\n]+\]\]$/.test(line) && !/^\[[^\]\n]+\]\((?:<[^<>\n]+>|[^\s()]+)(?:\s+"[^"\n]*")?\)$/.test(line)) return [];
    const links = extractKnowledgeLinks(line, path).links;
    return links.length === 1 ? links : [];
  });
}
