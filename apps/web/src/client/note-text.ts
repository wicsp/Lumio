import type { KnowledgeContext } from "@lumio/schema";
export interface TextRange {
    from: number;
    to: number;
}
export function protectedText(text: string): TextRange[] {
    const ranges: TextRange[] = [];
    let pos = 0, fence: {
        from: number;
        char: string;
        length: number;
    } | undefined;
    for (const line of text.split("\n")) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
                ranges.push({ from: fence.from, to: pos + line.length });
                fence = undefined;
            }
        }
        else if (marker)
            fence = { from: pos, char: marker[1]![0]!, length: marker[1]!.length };
        pos += line.length + 1;
    }
    if (fence)
        ranges.push({ from: fence.from, to: text.length });
    for (const m of text.matchAll(/<!--[^]*?(?:-->|$)/g))
        ranges.push({ from: m.index, to: m.index + m[0].length });
    const runs = [...text.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
        const m = runs[i]!;
        if (ranges.some(r => m.index >= r.from && m.index < r.to))
            continue;
        const end = runs.findIndex((n, j) => j > i && n[0].length === m[0].length);
        if (end >= 0) {
            ranges.push({ from: m.index, to: runs[end]!.index + runs[end]![0].length });
            i = end;
        }
    }
    return ranges;
}
export function referenceTrigger(text: string, position: number): {
    from: number;
    to: number;
    query: string;
} | undefined {
    const start = text.lastIndexOf("[[", position);
    if (start < 0 || position < start + 2 || position - start > 202)
        return;
    const query = text.slice(start + 2, position);
    if (/[\]\n]/.test(query) || protectedText(text).some(r => start >= r.from && start < r.to))
        return;
    let slashes = 0;
    for (let i = start - 1; i >= 0 && text[i] === "\\"; i--)
        slashes++;
    if (slashes % 2)
        return;
    return { from: start, to: position, query };
}
export function writingContext(title: string, text: string, position: number): KnowledgeContext {
    const trigger = referenceTrigger(text, position);
    if (trigger) {
        text = text.slice(0, trigger.from) + text.slice(position);
        position = trigger.from;
    }
    const left = text.lastIndexOf("\n\n", position), right = text.indexOf("\n\n", position);
    const from = Math.max(left < 0 ? 0 : left + 2, position - 2000), to = Math.min(right < 0 ? text.length : right, from + 4000);
    return { title: title.slice(0, 500), focus: text.slice(from, to), text: (text.slice(0, from) + "\n" + text.slice(to)).slice(0, 20000) };
}
export interface FootnoteDefinition extends TextRange {
    label: string;
    text: string;
}
export interface FootnoteReference extends TextRange {
    label: string;
    number: number;
}
export function footnotes(text: string): {
    definitions: FootnoteDefinition[];
    references: FootnoteReference[];
    issues: string[];
} {
    const excluded = protectedText(text), definitions: FootnoteDefinition[] = [], references: FootnoteReference[] = [], issues: string[] = [];
    const blocked = (at: number) => excluded.some(r => at >= r.from && at < r.to);
    for (const m of text.matchAll(/^\[\^([^\]\s]+)\]:[ \t]*(.*)(?:\n(?: {4}|\t).*|\n(?=\n(?: {4}|\t)))*/gm)) {
        if (blocked(m.index))
            continue;
        const content = m[0].slice(m[0].indexOf(":") + 1).trim().replace(/\n(?: {4}|\t)/g, "\n");
        definitions.push({ from: m.index, to: m.index + m[0].length, label: m[1]!, text: content });
    }
    const labels = new Map<string, number>();
    for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
        if (blocked(m.index) || definitions.some(d => m.index >= d.from && m.index < d.to) || text[m.index - 1] === "\\")
            continue;
        if (!labels.has(m[1]!))
            labels.set(m[1]!, labels.size + 1);
        references.push({ from: m.index, to: m.index + m[0].length, label: m[1]!, number: labels.get(m[1]!)! });
    }
    for (const label of new Set([...definitions.map(d => d.label), ...labels.keys()])) {
        const count = definitions.filter(d => d.label === label).length;
        if (count !== 1 || !labels.has(label))
            issues.push(label);
    }
    return { definitions, references, issues };
}
/** Stable document-local ULID label. No server entity or user-facing numbering is persisted. */
export function footnoteLabel(): string {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = Date.now(), prefix = "";
    for (let i = 0; i < 10; i++) {
        prefix = alphabet[time % 32] + prefix;
        time = Math.floor(time / 32);
    }
    const random = crypto.getRandomValues(new Uint8Array(16));
    return "lumio-ref-" + prefix + Array.from(random, b => alphabet[b % 32]).join("");
}
export function insertReference(text: string, trigger: {
    from: number;
    to: number;
}, link: string, asFootnote: boolean, label = footnoteLabel()): {
    changes: {
        from: number;
        to?: number;
        insert: string;
    }[];
    cursor: number;
} {
    const to = text.slice(trigger.to, trigger.to + 2) === "]]" ? trigger.to + 2 : trigger.to;
    if (!asFootnote)
        return { changes: [{ from: trigger.from, to, insert: link }], cursor: trigger.from + link.length };
    const model = footnotes(text), reuse = model.definitions.find(d => /^lumio-ref-[0-9A-HJKMNP-TV-Z]{26}$/.test(d.label) && d.text === link && model.definitions.filter(other => other.label === d.label).length === 1);
    const key = reuse?.label ?? label, mark = `[^${key}]`, definition = `${text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}[^${key}]: ${link}\n`;
    const changes = [{ from: trigger.from, to, insert: mark }];
    if (!reuse) {
        if (to === text.length)
            changes[0]!.insert += definition;
        else
            changes.push({ from: text.length, to: text.length, insert: definition });
    }
    return { changes, cursor: trigger.from + mark.length };
}
