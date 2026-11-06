import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";
import { TrashItem } from "@lumio/schema";

const ulid = "01JC0000000000000000000000";
const item = TrashItem.parse({ kind: "note", id: `idea_${ulid}`, title: "Synthetic", deleted_at: "2026-11-06T22:00:00Z", deleted_by: `act_${ulid}`, expires_at: "2026-12-06T22:00:00Z", path: "ideas/synthetic.md" });

test("trash methods use the ADR 0038 endpoints, methods and validated bodies", async () => {
  const seen: string[] = [];
  const client = createClient({ url: "http://localhost", fetch: (async (url: URL, init: RequestInit) => {
    seen.push(`${init.method} ${url.pathname}${url.search} ${init.body ?? ""}`);
    const request_id = init.body ? JSON.parse(String(init.body)).request_id : undefined;
    if (url.pathname === "/v2/trash") return Response.json({ items: [item] });
    if (url.pathname.endsWith("/restore")) return Response.json({ request_id, kind: "note", id: item.id, path: "ideas/synthetic (2).md", renamed: true });
    if (url.pathname.startsWith("/v2/trash/")) return Response.json({ request_id, kind: "note", id: item.id });
    return Response.json({ request_id, item });
  }) as unknown as typeof fetch });
  const request_id = "trash-test-000000001";
  expect((await client.deleteNote(item.id, { request_id, expected_revision: "a".repeat(64) })).item).toEqual(item);
  await client.deleteConversation(`conv_${ulid}`, { request_id });
  expect((await client.trash({ kind: "note" })).items).toEqual([item]);
  expect((await client.restoreTrash(item.id, { request_id })).renamed).toBe(true);
  expect((await client.purgeTrash(item.id, { request_id })).id).toBe(item.id);
  expect(seen.map(line => line.split(" ").slice(0, 2).join(" "))).toEqual([
    `DELETE /v2/knowledge/notes/${item.id}`, `DELETE /v2/assistant/conversations/conv_${ulid}`, "GET /v2/trash?kind=note",
    `POST /v2/trash/${item.id}/restore`, `DELETE /v2/trash/${item.id}`]);
  expect(() => client.deleteConversation(`task_${ulid}`, { request_id })).toThrow();
  expect(() => client.deleteNote(item.id, { request_id } as never)).toThrow();
});
