import { expect, test } from "bun:test";
import { Glance } from "@lumio/schema";
import { ApiClientError, createClient } from "../src/index.ts";

const id = "gln_01JZ0000000000000000000001";
const glance = Glance.parse({
  id, owner: "act_00000000000000000000000001", captured: "2026-11-16T08:00:00+08:00",
  app: { bundle_id: "com.apple.Safari", name: "Safari" }, window_title: "Synthetic page", url: "https://example.com/post",
  image: { file: "art_00000000000000000000000001", format: "jpeg", width: 20, height: 10, bytes: 3, sha256: "a".repeat(64) },
  trail: [], ocr: [], pointing: { method: "none", blocks: [] }, used_by: { capture: "cap_00000000000000000000000001" }, created: "2026-11-16T08:00:01+08:00",
});

test("glance reads the record with the human token and validates it", async () => {
  const client = createClient({ url: "http://localhost:7420", token: "synthetic-token", fetch: (async (url: URL, init?: RequestInit) => {
    expect(url.pathname).toBe(`/v2/glances/${id}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
    return Response.json(glance);
  }) as unknown as typeof fetch });
  expect(await client.glance(id)).toEqual(glance);
  expect(() => client.glance("gln_bad")).toThrow(ApiClientError);
});

test("glanceImage returns only JPEG or PNG bytes and maps Hub errors", async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
  const ok = createClient({ url: "http://localhost:7420", token: "t", fetch: (async (url: URL, init?: RequestInit) => {
    expect(url.pathname).toBe(`/v2/glances/${id}/image`);
    expect(init?.redirect).toBe("error");
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
  }) as unknown as typeof fetch });
  const blob = await ok.glanceImage(id);
  expect(blob.type).toBe("image/jpeg");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

  const html = createClient({ url: "http://localhost:7420", token: "t", fetch: (async () => new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } })) as unknown as typeof fetch });
  await expect(html.glanceImage(id)).rejects.toBeInstanceOf(ApiClientError);

  const gone = createClient({ url: "http://localhost:7420", token: "t", fetch: (async () => Response.json({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 })) as unknown as typeof fetch });
  await expect(gone.glanceImage(id)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
});
