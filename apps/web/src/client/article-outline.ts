import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { scrollToTarget, type RailEntry } from "./side-rail.ts";

/** Headings deeper than ### stay out of the outline. */
export const OUTLINE_DEPTH = 3;

export function markdownHeadings(source: string): Array<{ level: number; label: string; position: number }> {
  const headings: ReturnType<typeof markdownHeadings> = [];
  commonmarkLanguage.parser.parse(source).iterate({ enter(node) {
    const heading = /^(ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!heading) return;
    const markers = node.node.getChildren("HeaderMark");
    const start = heading[1] === "ATX" ? markers[0]?.to ?? node.from : node.from;
    const end = heading[1] === "Setext" || markers.length > 1 ? markers.at(-1)?.from ?? node.to : node.to;
    const label = source.slice(start, end).trim().replace(/\s+/g, " ");
    if (label) headings.push({ level: Number(heading[2]), label, position: node.from });
  } });
  return headings;
}

/** Cheap pre-check run on every edit; the full parse only happens when it may find something. */
export function mayHaveHeadings(source: string): boolean {
  return /^ {0,3}#{1,6}[ \t]+\S/m.test(source) || /\S[^\n]*\n {0,3}(?:=+|-+)[ \t]*$/m.test(source);
}

/**
 * Outline entries for rendered Markdown. renderMarkdown shifts heading tags down one level (# → h2),
 * so the Markdown level is the tag level minus one.
 */
export function renderedOutline(scroller: HTMLElement, body: HTMLElement): RailEntry[] {
  return [...body.querySelectorAll<HTMLElement>("h2, h3, h4")].map(heading => ({
    level: Number(heading.tagName.slice(1)) - 1, label: heading.textContent?.trim() ?? "",
    top: () => heading.getBoundingClientRect().top,
    jump: () => scrollToTarget(scroller, heading, 12),
  })).filter(entry => entry.label && entry.level <= OUTLINE_DEPTH);
}
