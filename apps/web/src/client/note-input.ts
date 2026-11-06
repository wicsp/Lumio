import { EditorState, type ChangeSpec, type Text } from "@codemirror/state";
import { protectedText } from "./note-text.ts";

/** Only a just-completed line prefix is an input shortcut, never arbitrary prose. */
export function chineseQuoteChange(doc: Text, position: number): ChangeSpec | undefined {
    const line = doc.lineAt(position);
    const prefix = doc.sliceString(line.from, position);
    if (!/^ {0,3}》 $/.test(prefix)) return;
    const from = position - 2;
    if (protectedText(doc.toString()).some(range => from >= range.from && from < range.to)) return;
    return { from, to: from + 1, insert: ">" };
}

export const chineseQuoteInput = EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || transaction.startState.readOnly ||
        !transaction.isUserEvent("input.type") || transaction.isUserEvent("input.type.compose")) return transaction;
    const changes: ChangeSpec[] = [];
    transaction.changes.iterChanges((_from, _to, _fromB, toB, inserted) => {
        if (!inserted.toString().endsWith(" ")) return;
        const change = chineseQuoteChange(transaction.newDoc, toB);
        if (change) changes.push(change);
    });
    // Keep the typed space and marker conversion in one undoable transaction.
    return changes.length ? [transaction, { changes, sequential: true }] : transaction;
});
