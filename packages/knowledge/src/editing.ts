import { Entity, type KnowledgeContext, type NoteRef, type ReadingStatus } from "@lumio/schema";
import { CoreError } from "@lumio/foundation";
import { parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";
import { posix } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
export const EDITABLE_KNOWLEDGE_TYPES = ["paper", "source", "idea", "experiment", "post", "ai-note"] as const;
export function editableMetadata(data: Record<string, unknown>, type: string): boolean {
    return (EDITABLE_KNOWLEDGE_TYPES as readonly string[]).includes(type) && data.type === type && Entity.safeParse(data).success;
}
export interface KnowledgeMetadataEdits {
    tags?: string[];
    derived_from?: string[];
    status?: ReadingStatus;
    model?: string;
}
export function editKnowledgeDocument(bytes: Buffer, title: string, body: string, updated: string, metadata: KnowledgeMetadataEdits = {}): Buffer {
    const parsed = parseFrontmatter(bytes), raw = bytes.toString("utf8");
    const fields = Object.entries(metadata).filter(([key, value]) => !isDeepStrictEqual(parsed.data[key], value));
    if (!fields.length && parsed.data.title === title && parsed.body.toString("utf8") === body)
        return bytes;
    const match = /^(\uFEFF?---[^\S\r\n]*\r?\n)([\s\S]*?)(^---[^\S\r\n]*(?:\r?\n|$))/m.exec(raw);
    if (!match || match.index !== 0)
        throw new CoreError("NOTE_NOT_EDITABLE", { key: "frontmatter.frontmatter_is_not_valid_yaml", args: [] });
    const doc = parseDocument(match[2]!, { keepSourceTokens: true });
    doc.set("title", title);
    doc.set("updated", updated);
    for (const [key, value] of fields)
        doc.set(key, value);
    const expected = { ...parsed.data, ...metadata, title, updated };
    if (doc.errors.length || !isDeepStrictEqual(doc.toJS({ maxAliasCount: 100 }), expected))
        throw new CoreError("NOTE_NOT_EDITABLE", { key: "frontmatter.could_not_generate_frontmatter", args: [] });
    const header = doc.toString({ lineWidth: 0 });
    const newline = match[1]!.endsWith("\r\n") ? "\r\n" : "\n";
    const closing = match[3]! + (body && !match[3]!.endsWith("\n") ? newline : "");
    const result = Buffer.from(match[1] + header.replace(/\r?\n/g, newline) + closing + body);
    if (!isDeepStrictEqual(parseFrontmatter(result).data, expected))
        throw new CoreError("NOTE_NOT_EDITABLE", { key: "frontmatter.could_not_generate_frontmatter", args: [] });
    return result;
}
const STOP = new Set("i the a an and or to of in is for with on this that it are be as from by my our your can will how what".split(" "));
export function searchableText(text: string): string {
    return text.replace(/<!--\s*lumio:ai start\b[\s\S]*?<!--\s*lumio:ai end\b[^>]*-->/g, "")
        .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, "")
        .replace(/<!--[^]*?-->/g, "").replace(/^\[\^[^\]]+\]:.*(?:\n(?: {4}|\t).*)*/gm, "").replace(/^\s*#{1,6}\s+.*$/gm, "").replace(/\[\[[^\]\n]*$/g, "").replace(/\[\^.*?\]/g, "");
}
export function lexicalTerms(text: string, allowSingle = false): string[] {
    const normalized = text.normalize("NFKC").toLowerCase().replace(/(\p{Script=Han}+)/gu, " $1 ");
    const terms: string[] = [];
    for (const word of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
        if (/\p{Script=Han}/u.test(word)) {
            if (word.length === 1)
                terms.push(word);
            else
                for (let i = 0; i < word.length - 1; i++)
                    terms.push(word.slice(i, i + 2));
        }
        else if (!STOP.has(word) && (allowSingle || word.length > 1))
            terms.push(word);
    }
    return [...new Set(terms)].slice(0, 24);
}
function oneEdit(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1)
        return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (++edits > 1)
            return false;
        if (a.length >= b.length)
            i++;
        if (b.length >= a.length)
            j++;
    }
    return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}
function score(text: string, terms: string[]): number {
    const s = text.normalize("NFKC").toLowerCase(), words = s.match(/[a-z0-9_]+/g) ?? [];
    return terms.reduce((sum, word) => sum + (s.includes(word) ? Math.min(word.length, 8) : word.length >= 4 && /^[a-z]+$/.test(word) && words.some(candidate => oneEdit(word, candidate)) ? Math.min(word.length, 8) * .5 : 0), 0);
}
export interface RankedNote {
    note: NoteRef;
    body: string;
}
export function rankRelated(notes: RankedNote[], context: KnowledgeContext, query?: string): Array<{
    note: NoteRef;
    snippet: string;
}> {
    const focus = lexicalTerms(searchableText(query ?? context.focus), !!query), title = query ? [] : lexicalTerms(context.title), rest = query ? [] : lexicalTerms(searchableText(context.text));
    const terms = [...new Set([...focus, ...title, ...rest])];
    if (!terms.length)
        return [];
    const rank = (text: string) => score(text, focus) * 12 + score(text, title) * 4 + score(text, rest);
    return notes.map(({ note, body }) => {
        const paragraphs = searchableText(body).split(/\n\s*\n/).slice(0, 2000);
        const best = paragraphs.map(text => ({ text, score: rank(text) })).sort((a, b) => b.score - a.score)[0];
        const nameScore = rank(note.title) * 1.5 + rank(note.citekey ?? "") + rank(posix.basename(note.path, ".md"));
        let snippet = "";
        if (best && best.score > 0) {
            const compact = best.text.replace(/\s+/g, " ").trim();
            const lower = compact.toLowerCase();
            const positions = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
            const start = positions.length ? Math.max(0, Math.min(...positions) - 40) : 0;
            snippet = (start ? "…" : "") + compact.slice(start, start + 196) + (compact.length > start + 196 ? "…" : "");
        }
        return { note, snippet, score: nameScore + (best?.score ?? 0) };
    }).filter(v => v.score > 0).sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path)).map(({ note, snippet }) => ({ note, snippet }));
}
export function referenceText(sourcePath: string, note: NoteRef, uniqueFilename: boolean): string {
    const file = posix.basename(note.path, ".md");
    if (uniqueFilename && !/[\[\]|#\r\n]/.test(file) && !/[\[\]|\r\n]/.test(note.title))
        return `[[${file}${file === note.title ? "" : "|" + note.title}]]`;
    const relative = posix.relative(posix.dirname(sourcePath), note.path).split("/").map(encodeURIComponent).join("/");
    return `[${note.title.replace(/[\\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ")}](${relative})`;
}
