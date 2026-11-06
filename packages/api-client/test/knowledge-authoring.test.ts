import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";
import { KnowledgeCreateRequest } from "@lumio/schema";
import fixtures from "../../../fixtures/knowledge-authoring/notes.json";
test("authoring client validates inputs, routes and success payloads", async () => {
  const routes: string[] = [];
  const client = createClient({ url: "https://hub.invalid", fetch: (async (input: URL, init: RequestInit) => {
    routes.push(input.pathname);
    if (input.pathname.endsWith("templates")) { expect(input.searchParams.get("kind")).toBe("video"); return Response.json({ kind: "video", locale: "zh", version: "1", body: "## 内容摘要" }); }
    if (input.pathname.endsWith("resolve")) { expect(JSON.parse(String(init.body))).toEqual({ input: "2002.02126" }); return Response.json({ title: "Fixture", authors: ["A"], year: 2026 }); }
    expect(KnowledgeCreateRequest.parse(JSON.parse(String(init.body))).body).toBe(fixtures[0]!.body);
    return Response.json({ id: "bad-result" });
  }) as unknown as typeof fetch });
  await client.knowledgeTemplate({ kind: "video", locale: "zh" }); await client.resolvePaper({ input: "2002.02126" });
  await expect(client.createNote(KnowledgeCreateRequest.parse(fixtures[0]))).rejects.toMatchObject({ code: "INTERNAL" });
  expect(routes).toEqual(["/v2/knowledge/templates", "/v2/knowledge/papers/resolve", "/v2/knowledge/notes"]);
  expect(() => client.resolvePaper({ input: "" })).toThrow();
});
