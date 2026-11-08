import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";

test("graph client validates filters, serializes booleans and validates graph invariants", async () => {
  const urls: URL[] = [];
  const graph = { nodes: [], edges: [], dangling: 0, generated_at: "2026-11-08T00:00:00Z" };
  const fetcher = Object.assign(async (input: Parameters<typeof fetch>[0]) => { urls.push(new URL(String(input))); return Response.json(graph); }, { preconnect: fetch.preconnect });
  const api = createClient({ url: "https://fixture.invalid", fetch: fetcher });
  expect(await api.knowledgeGraph({ type: "idea", include_private: false, include_legacy: true })).toEqual(graph);
  expect(urls[0]!.pathname).toBe("/v2/knowledge/graph"); expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ type: "idea", include_private: "false", include_legacy: "true" });
  expect(() => api.knowledgeGraph({ type: "invalid" as "idea" })).toThrow(); expect(urls).toHaveLength(1);
  const invalid = createClient({ url: "https://fixture.invalid", fetch: Object.assign(async () => Response.json({ ...graph, edges: [{ from: "absent", to: "missing", count: 1 }] }), { preconnect: fetch.preconnect }) });
  await expect(invalid.knowledgeGraph()).rejects.toMatchObject({ code: "INTERNAL" });
});
