import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Capture, CaptureCreate, CaptureCreateResult, CaptureProxySettings, CaptureProxyUpdate } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

test("human capture proxy settings take effect on the next fetch and survive a restart without disclosing credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-capture-proxy-"));
  const vault = join(root, "vault"), state = join(root, "state"), file = join(state, "capture-proxy.json");
  const html = await readFile(new URL("../../../fixtures/i1-inbox/article.html", import.meta.url), "utf8");
  const seen: { url: string; auth: string | undefined }[] = [], logs: string[] = [];
  const proxy = createServer((request, response) => {
    seen.push({ url: request.url!, auth: request.headers["proxy-authorization"] });
    if (request.url?.endsWith("/redirect")) {
      response.writeHead(302, { Location: "http://127.0.0.1/private" }).end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" }).end(html);
    }
  });
  let hub: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP proxy");
    const proxy_origin = "http://127.0.0.1:" + address.port;
    const password = "synthetic-test-password";
    const proxy_url = "http://synthetic:" + password + "@127.0.0.1:" + address.port;
    await mkdir(vault);
    const start = () => startHub(readConfig({
      HOME: root, LUMIO_STATE_DIR: state, LUMIO_VAULT: vault, LUMIO_HUB_LISTEN: "127.0.0.1:0",
    }), { log: line => logs.push(line) });
    hub = await start();
    const token = (name: string, role: "human" | "agent" | "runtime") => {
      hub!.store.createActor(name, role);
      return hub!.store.createToken(name, name);
    };
    const human = token("human", "human"), agent = token("agent", "agent"), runtime = token("runtime", "runtime");
    const api = (path: string, method = "GET", body?: unknown, credential = human) =>
      fetch(new URL(path, hub!.server.url), { method, proxy: false,
        headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const path = "/v2/inbox/proxy-settings";
    const custom = CaptureProxyUpdate.parse({ mode: "custom", expected_revision: 1, proxy_url, no_proxy: "" });
    const initial = await api(path);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(CaptureProxySettings.parse(await initial.json())).toEqual({ revision: 1, mode: "environment" });
    for (const credential of [agent, runtime]) {
      expect((await api(path, "GET", undefined, credential)).status).toBe(403);
      expect((await api(path, "PUT", custom, credential)).status).toBe(403);
    }
    for (const invalid of ["malformed", "socks5://127.0.0.1:1080", proxy_url + "/ignored"]) {
      const response = await api(path, "PUT", { ...custom, proxy_url: invalid });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(password);
    }
    const saved = await api(path, "PUT", custom);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const view = await saved.text();
    expect(view).not.toContain(password);
    expect(CaptureProxySettings.parse(JSON.parse(view))).toEqual({ revision: 2, mode: "custom", proxy_origin, no_proxy: "" });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const capture = async (url: string) => {
      const input = CaptureCreate.parse({ url, channel: "web", request_id: randomUUID() });
      const created = await api("/v2/inbox/captures", "POST", input);
      const result = CaptureCreateResult.parse(await created.json());
      for (let i = 0; i < 100; i++) {
        const item = Capture.parse(await (await api("/v2/inbox/captures/" + result.capture.id)).json());
        if (item.state === "ready" || item.state === "failed") return item;
        await Bun.sleep(20);
      }
      throw new Error("Synthetic capture did not finish");
    };
    expect(await capture("http://article.example/first")).toMatchObject({ state: "ready" });
    expect(await capture("http://article.example/redirect")).toMatchObject({ state: "failed", error: { code: "blocked" } });

    const edit = (no_proxy: string) => api(path, "PUT", CaptureProxyUpdate.parse({ mode: "custom", expected_revision: 2, no_proxy }));
    const changes = await Promise.all([edit("other.example"), edit("outside.example")]);
    expect(changes.map(response => response.status).sort()).toEqual([200, 409]);
    const updated = CaptureProxySettings.parse(await changes.find(response => response.ok)!.json());
    expect(updated).toMatchObject({ revision: 3, mode: "custom", proxy_origin });

    await hub.stop();
    hub = undefined;
    hub = await start();
    expect(CaptureProxySettings.parse(await (await api(path)).json())).toEqual(updated);
    expect(await capture("http://article.example/after-restart")).toMatchObject({ state: "ready" });
    const auth = "Basic " + Buffer.from("synthetic:" + password).toString("base64");
    expect(seen).toEqual([
      { url: "http://article.example/first", auth },
      { url: "http://article.example/redirect", auth },
      { url: "http://article.example/after-restart", auth },
    ]);

    const reset = CaptureProxyUpdate.parse({ mode: "environment", expected_revision: 3 });
    expect(CaptureProxySettings.parse(await (await api(path, "PUT", reset)).json())).toEqual({ revision: 4, mode: "environment" });
    expect(await readFile(file, "utf8")).not.toContain(password);
    const audit = hub.store.db.query("SELECT * FROM audit WHERE operation = 'inbox.proxy-settings'").all();
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorization: "allow", execution_result: "applied" }),
      expect.objectContaining({ authorization: "deny" }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(logs.join("\n")).not.toContain(password);
  } finally {
    await hub?.stop();
    if (proxy.listening) {
      const closed = once(proxy, "close");
      proxy.close();
      proxy.closeAllConnections();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
