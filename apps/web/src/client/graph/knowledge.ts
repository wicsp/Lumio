import type { KnowledgeGraph, KnowledgeGraphArgs } from "@lumio/schema";
import type { Client } from "../api.ts";
import { errorText } from "../api.ts";
import { clear, empty, failure, h, loading } from "../dom.ts";
import { t } from "../i18n.ts";
import { knowledgeGraphData, MAX_KNOWLEDGE_NODES } from "./data.ts";
import { forceLayoutAsync } from "./layout.ts";
import { relationGraph } from "./view.ts";

/** Only the human Web client uses the whole graph endpoint. No per-note graph requests. */
export class KnowledgeGraphView {
  private body = h("div", { class: "knowledge-graph-canvas" });
  private status = h("p", { class: "muted", role: "status" });
  private hideIsolated = h("input", { type: "checkbox", name: "hide-isolated" });
  private source?: KnowledgeGraph;
  private args: KnowledgeGraphArgs = {};
  private generation = 0;
  private requestGeneration = 0;
  private active = true;

  constructor(host: HTMLElement, private client: Pick<Client, "knowledgeGraph">, private open: (reference: string) => void) {
    this.hideIsolated.addEventListener("change", () => { if (this.source) void this.draw(++this.generation); });
    host.append(h("div", { class: "graph-toolbar" }, h("label", { class: "graph-islands" }, this.hideIsolated, t("Hide isolated notes"))), this.status, this.body);
  }
  cancel(): void { this.generation++; this.requestGeneration++; }
  dispose(): void { this.active = false; this.cancel(); this.source = undefined; clear(this.body); }
  async load(args: KnowledgeGraphArgs, quiet = false): Promise<void> {
    const request = ++this.requestGeneration, sameArgs = JSON.stringify(args) === JSON.stringify(this.args);
    this.args = args;
    if (!quiet || !sameArgs || !this.source) { this.generation++; this.source = undefined; clear(this.body, loading(t("Loading knowledge graph…"))); this.status.textContent = ""; }
    try {
      const graph = await this.client.knowledgeGraph(args);
      if (!this.active || request !== this.requestGeneration) return;
      if (quiet && sameArgs && this.source && JSON.stringify(graph) === JSON.stringify(this.source)) return;
      this.source = graph;
      await this.draw(++this.generation);
    } catch (cause) {
      if (this.active && request === this.requestGeneration && (!quiet || !this.source)) clear(this.body, failure(errorText(cause), () => this.load(args)));
    }
  }
  private async draw(generation: number): Promise<void> {
    const source = this.source!;
    const graph = knowledgeGraphData(source, this.hideIsolated.checked);
    const isCurrent = () => this.active && generation === this.generation;
    this.status.textContent = t("{0} notes · {1} links", graph.nodes.length, graph.edges.length)
      + (graph.truncated ? ` · ${t("Showing the top {0} of {1} notes. Filter by type to narrow the graph.", MAX_KNOWLEDGE_NODES, graph.total)}` : "")
      + (source.dangling ? ` · ${t("Unresolved links: {0}", source.dangling)}` : "");
    if (!graph.nodes.length) { clear(this.body, empty(t("No notes match this graph view."))); return; }
    clear(this.body, loading(t("Arranging graph…")));
    const size = { width: 960, height: 620 };
    const positions = await forceLayoutAsync(graph.nodes.map(note => note.id), graph.edges, { ...size, isCurrent, batchSize: 2 });
    if (!positions || !isCurrent()) return;
    clear(this.body, relationGraph(graph.nodes, graph.edges, path => this.open(path), size, positions));
  }
}
