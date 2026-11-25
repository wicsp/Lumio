import { loadMathRenderer, renderMath } from "./utils/markdown.ts";

/** Render the original source immediately. Only mounted formulas need the MathML renderer. */
export function registerMathElement(onLoadError: () => void): void {
  if (customElements.get("lumio-math")) return;
  let reported = false;
  customElements.define("lumio-math", class extends HTMLElement {
    async connectedCallback(): Promise<void> {
      try { await loadMathRenderer(); }
      catch {
        if (this.isConnected && !reported) { reported = true; onLoadError(); }
        return;
      }
      if (!this.isConnected) return;
      const html = renderMath(this.dataset.tex ?? "", this.hasAttribute("data-display"));
      if (html) this.innerHTML = html;
    }
  });
}
