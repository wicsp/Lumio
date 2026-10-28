import { isolatedHome } from "./test-home.ts";
import { expect, test } from "bun:test";
import { RuntimeInfo } from "@lumio/schema";
const cliHome = isolatedHome();

const main = new URL("../src/main.ts", import.meta.url).pathname;
const info = RuntimeInfo.parse({ actor: "act_00000000000000000000000001", registration: {
  protocol_version: 2, name: "server", engines: [{ name: "codex", version: "0.42.0", sandbox: "os" }], tags: ["gpu:4", "lab"], max_concurrent: 1,
}, online: true, last_seen: "2026-01-01T00:00:00Z" });

test("runtime list renders online/offline, last_seen, engines and tags, with schema-valid JSON", async () => {
  for (const online of [true, false]) {
    const body = [{ ...info, online }];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/runtimes");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
      return Response.json(body);
    } });
    try {
      for (const json of [false, true]) {
        const child = Bun.spawn([process.execPath, main, "runtime", "list", ...(json ? ["--json"] : [])], {
          env: { ...process.env, HOME: cliHome, LUMIO_HUB_URL: `http://127.0.0.1:${server.port}`, LUMIO_TOKEN: "synthetic-token", LUMIO_VAULT: undefined }, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code).toBe(0); expect(stderr).toBe("");
        if (json) expect(RuntimeInfo.array().parse(JSON.parse(stdout))).toEqual(body);
        else for (const content of ["server", online ? "在线" : "失联", info.last_seen, "codex 0.42.0", "gpu:4", "lab"]) expect(stdout).toContain(content);
      }
    } finally { await server.stop(true); }
  }
});

test("runtime list requires Hub credentials and rejects unrelated arguments/options", () => {
  for (const [args, env] of [
    [["runtime", "list"], { LUMIO_HUB_URL: undefined, LUMIO_TOKEN: undefined }],
    [["runtime", "list"], { LUMIO_HUB_URL: "http://localhost:7420", LUMIO_TOKEN: undefined }],
    [["runtime", "list", "extra"], {}], [["runtime", "list", "--vault", "/tmp"], {}], [["runtime", "unknown"], {}],
  ] as const) {
    const result = Bun.spawnSync([process.execPath, main, ...args], { env: { ...process.env, HOME: cliHome, ...env }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1); expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(args.length === 2 && args[1] === "list" ? "lumio-hub setup" : "runtime list");
  }
});
