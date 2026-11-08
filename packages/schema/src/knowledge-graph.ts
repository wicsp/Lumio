import { z } from "zod";
import { Timestamp } from "./common.ts";
import { NOTE_TYPES, NoteRef } from "./query.ts";

/** Human-only, index-backed whole-vault graph (ADR 0040). Not an agent capability. */
export const KnowledgeGraphArgs = z.strictObject({
  include_private: z.boolean().optional(),
  type: z.enum(NOTE_TYPES).optional(),
  include_legacy: z.boolean().optional(),
});
export const KnowledgeGraphEdge = z.strictObject({ from: z.string(), to: z.string(), count: z.number().int().positive() });
export const KnowledgeGraph = z.strictObject({
  nodes: z.array(NoteRef), edges: z.array(KnowledgeGraphEdge), dangling: z.number().int().nonnegative(), generated_at: Timestamp,
}).superRefine((graph, ctx) => {
  const nodes = new Set(graph.nodes.map(note => note.path)), pairs = new Set<string>();
  if (nodes.size !== graph.nodes.length) ctx.addIssue({ code: "custom", path: ["nodes"], message: "Duplicate node paths" });
  graph.edges.forEach((edge, index) => {
    const key = JSON.stringify([edge.from, edge.to]);
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || pairs.has(key)) {
      ctx.addIssue({ code: "custom", path: ["edges", index], message: "Edges must have distinct existing endpoints and unique directed pairs" });
    }
    pairs.add(key);
  });
});
export type KnowledgeGraphArgs = z.infer<typeof KnowledgeGraphArgs>;
export type KnowledgeGraphEdge = z.infer<typeof KnowledgeGraphEdge>;
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;
