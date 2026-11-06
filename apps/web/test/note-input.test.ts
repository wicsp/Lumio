import { test, expect } from "bun:test";
import { EditorState, type Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { chineseQuoteInput, chineseQuoteChange } from "../src/client/note-input.ts";

function type(doc: string, text: string, event = "input.type") {
    const state = EditorState.create({ doc, extensions: [chineseQuoteInput] });
    return state.update({ changes: { from: doc.length, insert: text }, selection: { anchor: doc.length + text.length }, userEvent: event }).state;
}

test("Chinese quote plus space becomes a Markdown blockquote at the current line start", () => {
    for (const prefix of ["", "\n", "Earlier paragraph\n\n", "   "]) {
        const state = type(prefix + "》", " ");
        expect(state.doc.toString()).toBe(prefix + "> ");
        expect(state.selection.main.head).toBe(prefix.length + 2);
    }
    expect(type("", "》 ").doc.toString()).toBe("> ");
});

test("prose, protected text, pasted content and programmatic updates remain verbatim", () => {
    for (const doc of ["书名》", "正文 》", "    》", "\t》", "```md\n》", "~~~\n》", "<!--\n》"]) {
        expect(type(doc, " ").doc.toString()).toBe(doc + " ");
    }
    for (const event of ["input.paste", "input.drop", "input.complete", "undo"]) {
        expect(type("", "》 ", event).doc.toString()).toBe("》 ");
    }
    const loaded = EditorState.create({ doc: "》 ", extensions: [chineseQuoteInput] });
    expect(loaded.doc.toString()).toBe("》 ");
    expect(loaded.update({ changes: { from: 2, insert: "literal" } }).newDoc.toString()).toBe("》 literal");
    expect(type("》", "").doc.toString()).toBe("》");
    const inlineCode = EditorState.create({ doc: "`code\n》`", extensions: [chineseQuoteInput] });
    expect(inlineCode.update({ changes: { from: 7, insert: " " }, userEvent: "input.type" }).newDoc.toString()).toBe("`code\n》 `");
});

test("conversion shares the typed space's undo and redo step", () => {
    let state = EditorState.create({ doc: "》", selection: { anchor: 1 }, extensions: [history(), chineseQuoteInput] });
    state = state.update({ changes: { from: 1, insert: " " }, selection: { anchor: 2 }, userEvent: "input.type" }).state;
    const target = () => ({ state, dispatch: (transaction: Transaction) => { state = transaction.state; } });
    expect(undo(target())).toBe(true);
    expect(state.doc.toString()).toBe("》");
    expect(redo(target())).toBe(true);
    expect(state.doc.toString()).toBe("> ");
});

test("IME preedit stays intact and the committed prefix can be converted after composition", () => {
    const composing = type("", "》 ", "input.type.compose");
    expect(composing.doc.toString()).toBe("》 ");
    const change = chineseQuoteChange(composing.doc, composing.selection.main.head)!;
    expect(composing.update({ changes: change, userEvent: "input.type" }).newDoc.toString()).toBe("> ");
    expect(chineseQuoteChange(type("书名》", " ").doc, 4)).toBeUndefined();
    const locked = EditorState.create({ doc: "》", extensions: [chineseQuoteInput, EditorState.readOnly.of(true)] });
    expect(locked.update({ changes: { from: 1, insert: " " }, userEvent: "input.type" }).newDoc.toString()).toBe("》 ");
});
