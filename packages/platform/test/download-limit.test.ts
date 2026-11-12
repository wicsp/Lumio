import { expect, test } from "bun:test";
import { downloadRelease, DownloadLimitError } from "../src/download.ts";
test("bounded update downloads reject excessive headers and chunked bodies", async () => {
  for (const headers of [{ "Content-Length": "10" }, {}]) {
    const fetcher = (async (_input: string | URL | Request) => new Response("1234567890", { headers })) as typeof fetch;
    await expect(downloadRelease("https://synthetic.invalid/manifest", { fetch: fetcher, maxBytes: 5 })).rejects.toBeInstanceOf(DownloadLimitError);
  }
});
