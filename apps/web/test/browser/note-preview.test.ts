import { expect, test } from "bun:test";
import { activatePreview } from "../../src/client/note-preview.ts";

function activate(kind: "external" | "note" | "text", type: "click" | "keydown") {
    // EventTarget supplies real propagation/default-prevention semantics without a browser DOM.
    const target = new EventTarget();
    Object.assign(target, { closest: () => kind === "text" ? null : { hasAttribute: (name: string) => name === "data-note" && kind === "note" } });
    let activations = 0, bubbled = false;
    target.addEventListener(type, event => activatePreview(event as MouseEvent | KeyboardEvent, () => activations++));
    target.addEventListener(type, event => { bubbled = !event.cancelBubble; });
    const event = new Event(type, { cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    return { activations, prevented: event.defaultPrevented, bubbled };
}

test("external preview links retain browser navigation for mouse and Enter activation", () => {
    for (const type of ["click", "keydown"] as const)
        expect(activate("external", type)).toEqual({ activations: 0, prevented: false, bubbled: false });
});

test("note links keep app navigation and non-link previews keep source editing", () => {
    for (const kind of ["note", "text"] as const)
        for (const type of ["click", "keydown"] as const)
            expect(activate(kind, type)).toEqual({ activations: 1, prevented: true, bubbled: false });
});
