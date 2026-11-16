import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRegistered, RuntimeRegistration, RuntimeHeartbeat } from "@lumio/schema";
import { runRuntime } from "../src/runtime.ts";
import { readConfig } from "../src/config.ts";

test("Runtime registers its full capabilities and only reports updates after negotiation", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-old-hub-")), stop = new AbortController();
  const registrations: Record<string, unknown>[] = [], heartbeats: Record<string, unknown>[] = [];
  const fetcher = (async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body));
    if (url.endsWith("/register")) {
      registrations.push(body);
      return Response.json(RuntimeRegistered.parse({ actor: "act_01ARZ3NDEKTSV4RRFFQ69G5FAV", registration: RuntimeRegistration.parse(body), last_seen: new Date().toISOString(), online: true }));
    }
    if (url.endsWith("/sync")) {
      RuntimeHeartbeat.parse(body); heartbeats.push(body); if (heartbeats.length === 2) stop.abort();
      return Response.json({ jobs: [], cancel: [], routines: [] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const env = { PATH: "", LUMIO_RUNTIME_NAME: "synthetic", LUMIO_HUB_URL: "http://synthetic.invalid", LUMIO_TOKEN: "synthetic", LUMIO_RUNTIME_STATE_DIR: root, LUMIO_RUNTIME_POLL_SECONDS: "0.001" };
    await runRuntime(readConfig(env), { env, fetch: fetcher, signal: stop.signal, log: () => {} });
    expect(registrations).toHaveLength(1); expect(registrations[0]!.features).toContain("self_update");
    expect(heartbeats).toHaveLength(2); for (const heartbeat of heartbeats) expect(heartbeat).not.toHaveProperty("update");
  } finally { stop.abort(); await rm(root, { recursive: true, force: true }); }
});
