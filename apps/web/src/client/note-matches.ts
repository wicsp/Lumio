import type { KnowledgeContext } from "@lumio/schema";

// Display-only matching for the existing lexical search. Ranking stays on the Hub.
const STOP = new Set("i the a an and or to of in is for with on this that it are be as from by my our your can will how what".split(" "));
function prose(text: string): string {
  return text.replace(/<!--\s*lumio:ai start\b[\s\S]*?<!--\s*lumio:ai end\b[^>]*-->/g, "")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
    .replace(/<!--[^]*?-->/g, "").replace(/^\[\^[^\]]+\]:.*(?:\n(?: {4}|\t).*)*/gm, "")
    .replace(/^\s*#{1,6}\s+.*$/gm, "").replace(/(?:\[\[|【【)[^\]】\n]*$/g, "").replace(/\[\^.*?\]/g, "");
}
function terms(text: string, allowSingle: boolean): string[] {
  const words = text.normalize("NFKC").toLowerCase().replace(/(\p{Script=Han}+)/gu, " $1 ").match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? [];
  const result: string[] = [];
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      if (chars.length === 1) result.push(word);
      else for (let i = 1; i < chars.length; i++) result.push(chars[i - 1]! + chars[i]!);
    } else if (!STOP.has(word) && (allowSingle || word.length > 1)) result.push(word);
  }
  return [...new Set(result)].slice(0, 24);
}
export function matchTerms(query: string | KnowledgeContext): string[] {
  if (typeof query === "string") return terms(prose(query), true);
  return [...new Set([...terms(prose(query.focus), false), ...terms(query.title, false), ...terms(prose(query.text), false)])];
}
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length >= b.length) i++;
    if (b.length >= a.length) j++;
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
/** UTF-16 ranges in the original string; normalization never changes displayed text. */
export function matchRanges(text: string, needles: readonly string[]): Array<[number, number]> {
  if (!text || !needles.length) return [];
  let normalized = "";
  const offsets: Array<[number, number]> = [];
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const folded = segment.normalize("NFKC").toLowerCase();
    normalized += folded;
    for (let i = 0; i < folded.length; i++) offsets.push([index, index + segment.length]);
  }
  const ranges: Array<[number, number]> = [];
  const add = (from: number, length: number) => ranges.push([offsets[from]![0], offsets[from + length - 1]![1]]);
  for (const needle of new Set(needles)) {
    if (!needle) continue;
    let found = false;
    for (let at = normalized.indexOf(needle); at >= 0; at = normalized.indexOf(needle, at + 1)) { add(at, needle.length); found = true; }
    if (!found && needle.length >= 4 && /^[a-z]+$/.test(needle)) {
      for (const word of normalized.matchAll(/[a-z0-9_]+/g)) if (oneEdit(needle, word[0])) add(word.index, word[0].length);
    }
  }
  const merged: Array<[number, number]> = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
