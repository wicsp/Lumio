import { protectedText } from "../note-text.ts";

export interface MathSpan { from: number; to: number; tex: string; display: boolean }
export interface TableBlock { from: number; to: number; kind: "table"; header: string[]; rows: string[][]; align: Array<"left" | "center" | "right" | undefined> }
export type RichBlock = TableBlock | (MathSpan & { kind: "math" });

export function escapedAt(text: string, at: number): boolean {
  let count = 0;
  while (at > 0 && text[--at] === "\\") count++;
  return count % 2 === 1;
}

/** Closed delimiters only: streaming/incomplete expressions remain literal text. */
export function mathAt(text: string, from: number): MathSpan | undefined {
  if (escapedAt(text, from)) return;
  const open = text.startsWith("$$", from) ? "$$" : text.startsWith("\\[", from) ? "\\["
    : text.startsWith("\\(", from) ? "\\(" : text[from] === "$" && text[from - 1] !== "$" ? "$" : undefined;
  if (!open) return;
  const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
  const display = open === "$$" || open === "\\[";
  const start = from + open.length;
  if (open === "$" && (!text[start] || /\s|\$/.test(text[start]!))) return;
  for (let end = start; end < text.length; end++) {
    if (!display && text[end] === "\n") return;
    if (!text.startsWith(close, end) || escapedAt(text, end)) continue;
    if (open === "$" && (/\s/.test(text[end - 1] ?? "") || /[\d$]/.test(text[end + 1] ?? ""))) continue;
    const tex = text.slice(start, end);
    if (!tex.trim()) return;
    return { from, to: end + close.length, tex, display };
  }
  return;
}

/** Pipes inside code, wiki aliases and formulas are cell content, not separators. */
export function tableCells(line: string): string[] | undefined {
  const text = line.trim(), cells: string[] = [];
  let start = 0, separators = 0;
  for (let i = 0; i < text.length; i++) {
    if (escapedAt(text, i)) continue;
    if (text[i] === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      const end = text.indexOf(run, i + run.length);
      if (end >= 0) { i = end + run.length - 1; continue; }
    }
    if ((text.startsWith("[[", i) || text.startsWith("【【", i))) {
      const end = text.indexOf(text.startsWith("【【", i) ? "】】" : "]]", i + 2);
      if (end >= 0) { i = end + 1; continue; }
    }
    const math = mathAt(text, i);
    if (math) { i = math.to - 1; continue; }
    if (text[i] === "|") { cells.push(text.slice(start, i).trim()); start = i + 1; separators++; }
  }
  if (!separators) return;
  cells.push(text.slice(start).trim());
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !escapedAt(text, text.length - 1)) cells.pop();
  return cells;
}

/** Shared source ranges keep reader and live-editor previews consistent. */
export function richBlocks(source: string): RichBlock[] {
  const lines = source.split("\n"), offsets: number[] = [], blocks: RichBlock[] = [];
  const protectedRanges = protectedText(source);
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const blocked = (at: number) => protectedRanges.some(range => at >= range.from && at < range.to);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, from = offsets[i]!;
    if (/^(?: {4}|\t)/.test(line) || blocked(from)) continue;
    const prefix = /^ {0,3}(?=\$\$|\\\[)/.exec(line);
    const math = prefix ? mathAt(source, from + prefix[0].length) : undefined;
    if (math?.display && !blocked(math.from)) {
      let endLine = i;
      while (endLine + 1 < lines.length && offsets[endLine + 1]! < math.to) endLine++;
      if (!source.slice(math.to, offsets[endLine]! + lines[endLine]!.length).trim()) {
        blocks.push({ ...math, from, to: offsets[endLine]! + lines[endLine]!.length, kind: "math" });
        i = endLine; continue;
      }
    }
    const header = tableCells(line), separator = lines[i + 1] && tableCells(lines[i + 1]!);
    if (!header?.length || !separator || separator.length !== header.length || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) continue;
    if (blocked(offsets[i + 1]!)) continue;
    const align = separator.map(cell => cell.startsWith(":") ? cell.endsWith(":") ? "center" as const : "left" as const : cell.endsWith(":") ? "right" as const : undefined);
    const rows: string[][] = [];
    let endLine = i + 1;
    while (endLine + 1 < lines.length) {
      const next = lines[endLine + 1]!;
      if (!next.trim() || /^(?: {4}|\t| {0,3}(?:#{1,6}\s|>|`{3,}|~{3,}|\$\$|\\\[))/.test(next) || blocked(offsets[endLine + 1]!)) break;
      const row = tableCells(next);
      if (!row) break;
      rows.push(header.map((_, column) => row[column] ?? "")); endLine++;
    }
    blocks.push({ from, to: offsets[endLine]! + lines[endLine]!.length, kind: "table", header, rows, align });
    i = endLine;
  }
  return blocks;
}

export function inlineMath(source: string, blocks: RichBlock[] = richBlocks(source)): MathSpan[] {
  const excluded = [...protectedText(source), ...blocks], spans: MathSpan[] = [];
  for (const match of source.matchAll(/^(?: {4}|\t).*$/gm)) excluded.push({ from: match.index, to: match.index + match[0].length });
  for (const match of source.matchAll(/\[\[[^\]\n]+\]\]|【【[^】\n]+】】|!?\[[^\]\n]+\]\([^\s)]+\)/g)) excluded.push({ from: match.index, to: match.index + match[0].length });
  for (let i = 0; i < source.length; i++) {
    const blocked = excluded.find(range => i >= range.from && i < range.to);
    if (blocked) { i = blocked.to - 1; continue; }
    const math = mathAt(source, i);
    if (math) { spans.push(math); i = math.to - 1; }
  }
  return spans;
}
