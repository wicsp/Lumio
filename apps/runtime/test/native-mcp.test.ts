import { expect, test } from "bun:test";
import { AI_NOTE_CAPABILITY_NAMES, toolName } from "@lumio/schema";

test("native MCP reports a rejected AI note update separately from an unknown outcome", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { args: { known: boolean } };
    return Response.json({ error: body.args.known
      ? { code: "CONFLICT", message: "The note changed.", reason: "revision_conflict" }
      : { code: "CONFLICT", message: "Outcome unknown." },
    }, { status: 409 });
  } });
  try {
    const input = [true, false].map((known, id) => JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName(AI_NOTE_CAPABILITY_NAMES[1]), arguments: { known } },
    })).join("\n") + "\n";
    const adapter = new URL("../src/native/mcp.ts", import.meta.url);
    const child = Bun.spawn([process.execPath, "-e", `import { runNativeMCP } from ${JSON.stringify(adapter.pathname)}; await runNativeMCP();`], {
      env: { LUMIO_NATIVE_MCP_URL: server.url.origin, LUMIO_NATIVE_MCP_TOKEN: "synthetic" },
      stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line)).sort((a, b) => a.id - b.id);
    expect(replies[0].result.isError).toBe(true);
    expect(JSON.parse(replies[0].result.content[0].text)).toMatchObject({ code: "CONFLICT", reason: "revision_conflict" });
    expect(replies[1].result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("outcome unknown") }] });
  } finally { await server.stop(true); }
});
