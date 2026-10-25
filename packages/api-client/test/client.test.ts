import { expect, test } from "bun:test";
import { ApiError, LinksResult, NoteDetail, SearchResult } from "@lumio/schema";
import { ApiClientError, createClient } from "../src/index.ts";

const note = { type: "idea", title: "中文 / #", path: "research/ideas/test.md" } as const;
function mock(body: unknown, status = 200, inspect?: (url: URL, init: RequestInit | undefined) => void): typeof fetch {
  return (async (url: URL, init?: RequestInit) => { inspect?.(url, init); return Response.json(body, { status }); }) as typeof fetch;
}

test("client encodes references/options and validates all success schemas", async () => {
  const cases = [
    { method: "search" as const, argument: "中文 &", body: { query: "中文 &", hits: [], total: 0 }, schema: SearchResult },
    { method: "show" as const, argument: "中文 / #", body: { note, frontmatter: {}, body: "text" }, schema: NoteDetail },
    { method: "links" as const, argument: "中文 / #", body: { note, outgoing: [], incoming: [] }, schema: LinksResult },
  ];
  for (const row of cases) {
    const client = createClient({ url: "http://localhost:7420/", token: "synthetic-token", fetch: mock(row.body, 200, (url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token"); expect(init?.redirect).toBe("error");
      expect(url.searchParams.get("include_private")).toBe("true");
      if (row.method === "search") { expect(url.searchParams.get("q")).toBe(row.argument); expect(url.searchParams.get("type")).toBe("idea"); expect(url.searchParams.get("limit")).toBe("2"); }
      else expect(url.pathname).toBe(`/v1/notes/${encodeURIComponent(row.argument)}${row.method === "links" ? "/links" : ""}`);
    }) });
    const result = await client[row.method](row.argument, { includePrivate: true, type: "idea", limit: 2 });
    expect(result).toEqual(row.schema.parse(row.body));
  }
});

test("ApiError becomes a coded error preserving all decision information", async () => {
  const error = ApiError.parse({ error: { code: "FORBIDDEN", message: "Denied", operation: { op: "link.add", args: { from: "idea_00000000000000000000000001", to: "pap_00000000000000000000000001" } }, reason: "agent-cannot-read-private", proposal: "prop_00000000000000000000000001" } });
  const client = createClient({ url: "http://localhost", token: "secret", fetch: mock(error, 403) });
  try { await client.show("Private"); throw new Error("Expected failure"); }
  catch (cause) {
    expect(cause).toBeInstanceOf(ApiClientError);
    expect(cause).toMatchObject({ ...error.error, status: 403 });
  }
});

test("malformed success/error/non-JSON/network responses never escape validation or expose sensitive content", async () => {
  for (const fetcher of [mock({ token: "private-response" }), mock({ error: { code: "unknown", message: "private-response" } }, 500),
    (async () => new Response("private-response")) as unknown as typeof fetch,
    (async () => { throw new Error("private-response secret-token"); }) as unknown as typeof fetch]) {
    const client = createClient({ url: "http://localhost", token: "secret-token", fetch: fetcher });
    for (const method of ["search", "show", "links"] as const) {
      try { await client[method]("ref"); throw new Error("Expected failure"); }
      catch (cause) { expect(cause).toBeInstanceOf(ApiClientError); expect((cause as ApiClientError).code).toBe("INTERNAL"); expect(String(cause)).not.toContain("private-response"); expect(String(cause)).not.toContain("secret-token"); }
    }
  }
});
