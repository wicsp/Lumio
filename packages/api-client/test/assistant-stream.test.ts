import { expect, test } from "bun:test";
import { createClient } from "../src/index.ts";

const turn = "turn_00000000000000000000000001";
test("assistant stream handles UTF-8 chunks and refuses truncation without a terminal result", async () => {
  const encoder = new TextEncoder();
  const lines = [{ type: "token", turn, delta: "中文" }, { type: "result", turn, messages: [] }].map((value) => `${JSON.stringify(value)}\n`).join("");
  const bytes = encoder.encode(lines);
  const client = createClient({ url: "http://synthetic", token: "synthetic", fetch: (async (_url, init) => {
    expect(new Headers(init?.headers).get("Accept")).toBe("application/x-ndjson");
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } }));
  }) as typeof fetch });
  const events = [];
  for await (const event of client.assistantEvents({ request_id: "synthetic-stream-001", message: "合成问题" })) events.push(event);
  expect(events[0]).toMatchObject({ type: "token", delta: "中文" }); expect(events.at(-1)?.type).toBe("result");
  const truncated = createClient({ url: "http://synthetic", fetch: (async () => new Response(`${JSON.stringify({ type: "token", turn, delta: "partial" })}\n`)) as unknown as typeof fetch });
  await expect((async () => { for await (const _event of truncated.assistantEvents({ request_id: "synthetic-stream-002", message: "合成问题" })) {} })()).rejects.toMatchObject({ code: "INTERNAL" });
});
