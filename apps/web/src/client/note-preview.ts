/** Keep native external-link navigation while routing note links and editable previews. */
export function activatePreview(event: MouseEvent | KeyboardEvent, activate: () => void): void {
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    // Keep the event out of CodeMirror while preserving the anchor default action.
    event.stopPropagation();
    if (link && !link.hasAttribute("data-note")) return;
    event.preventDefault();
    activate();
}
