import { expect, test } from "bun:test";
import { downloadRelease } from "../src/download.ts";

test("download refreshes on a terminal and reports only start/end in logs, including unknown sizes", async () => {
  for (const tty of [true, false]) for (const known of [true, false]) {
    const lines: string[] = [];
    const bytes = await downloadRelease("https://synthetic.example/release", { tty, progress: (line) => lines.push(line),
      fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2048)); controller.close(); } }), { headers: known ? { "Content-Length": "2048" } : {} })) as unknown as typeof fetch });
    expect(bytes.byteLength).toBe(2048);
    if (tty) { expect(lines.at(-1)).toContain(known ? "100%  2.0 KB / 2.0 KB" : "?%  2.0 KB / 未知"); }
    else { expect(lines).toHaveLength(2); expect(lines[0]).toContain("0.0 B"); expect(lines[1]).toContain("2.0 KB"); }
  }
});
test("connection and low-speed deadlines abort without exposing URLs or response errors", async () => {
  for (const phase of ["connect", "body"]) {
    let signal: AbortSignal | undefined, cancelled = false;
    const result = downloadRelease("https://synthetic.example/secret", { connectMs: 15, windowMs: 15, tty: false,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        if (phase === "connect") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      }) as unknown as typeof fetch });
    await expect(result).rejects.toThrow("下载太慢或卡住，请检查网络或代理（https_proxy）后重试");
    expect(signal?.aborted).toBe(true); if (phase === "body") expect(cancelled).toBe(true);
  }
});
test("a slow but active stream refreshes progress once per second without a fixed total download deadline", async () => {
  const lines: string[] = [];
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2048)); setTimeout(() => { c.enqueue(new Uint8Array(2048)); c.close(); }, 2300); } }); // 每秒的刷新恰好落在 1 秒边界时可能少一次，留出两个刷新周期
  await downloadRelease("https://synthetic.example/release", { tty: true, progress: (line) => lines.push(line), fetch: (async () => new Response(stream)) as unknown as typeof fetch });
  expect(lines.length).toBeGreaterThanOrEqual(2); expect(lines[0]).toContain("0.0 B"); expect(lines.at(-1)).toContain("4.0 KB");
});
