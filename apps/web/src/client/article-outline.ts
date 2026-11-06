import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { clear, h } from "./dom.ts";
import { t } from "./i18n.ts";

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

/** Cheap pre-check run on every edit; the full parse only happens when the outline is opened. */
export function mayHaveHeadings(source: string): boolean {
  return /^ {0,3}#{1,6}[ \t]+\S/m.test(source) || /\S[^\n]*\n {0,3}(?:=+|-+)[ \t]*$/m.test(source);
}

type OutlineEntry = { level: number; label: string; jump(): void };

/** A collapsed outline that stays out of the way (hidden) while the article has no headings. */
export function articleOutline(entries: () => OutlineEntry[], available: () => boolean = () => true): { element: HTMLDetailsElement; refresh(): void } {
  const list = h("ol", {});
  const element = h("details", { class: "article-outline" }, h("summary", {}, t("Article outline")), list);
  const refresh = () => {
    element.hidden = !available();
    if (element.hidden) { element.open = false; return; }
    if (!element.open) return;
    const items = entries();
    clear(list, ...items.map(({ level, label, jump }) => h("li", { "data-level": level },
      h("button", { type: "button", onclick: () => { element.open = false; jump(); } }, label))),
    !items.length && h("li", { class: "muted" }, t("No headings yet.")));
  };
  element.addEventListener("toggle", refresh);
  refresh();
  return { element, refresh };
}
