import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { readConfig } from "../../../apps/hub/src/config.ts";
import { WEB_CSP } from "../../../apps/web/src/page.ts";

const path = "/v2/speech/transcribe";
const browserMode = Bun.argv.includes("--serve");
Object.assign(globalThis, {
  speechProbeSocket: {
    message(ws: Bun.ServerWebSocket<undefined>, message: string | Buffer) {
      ws.send(typeof message === "string" ? "ready" : message);
    },
  },
});

function replace(source: string, target: string, replacement: string) {
  assert.equal(source.split(target).length, 2, "Hub source changed; review the insertion point");
  return source.replace(target, replacement);
}

// Instrument the actual Hub at import time without editing its source files.
Bun.plugin({
  name: "S1-1 speech upgrade probe",
  setup(build) {
    build.onLoad({ filter: /\/apps\/hub\/src\/server\.ts$/ }, async ({ path: filename }) => {
      let source = await Bun.file(filename).text();
      const guard = 'if (!browserAllowed(request, config, server.port!)) { status = 403; return browserDenied(); }';
      source = replace(source, guard, guard + '\n' +
        'if (request.method === "GET" && url.pathname === "/v2/speech/transcribe" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {\n' +
        '  if (!server.upgrade(request)) { status = 400; return new Response(null, { status }); }\n' +
        '  status = 101; return undefined;\n' +
        '}');
      source = replace(source, "const handle = async (request: Request, server: Bun.Server<undefined>): Promise<Response> => {",
        "const handle = async (request: Request, server: Bun.Server<undefined>): Promise<Response | undefined> => {");
      source = replace(source, 'async fetch(request, server) {return webResponse(await withLanguage(language({LUMIO_LANG:request.headers.get("Accept-Language")??undefined}),()=>handle(request,server)),options.web?.csp);},',
        'async fetch(request, server) {\n' +
        '  const response = await withLanguage(language({ LUMIO_LANG: request.headers.get("Accept-Language") ?? undefined }), () => handle(request, server));\n' +
        '  return response === undefined ? undefined : webResponse(response, options.web?.csp);\n' +
        '},\n' +
        'websocket: globalThis.speechProbeSocket,');
      return { contents: source, loader: "ts" };
    });
  },
});
const { startHub } = await import("../../../apps/hub/src/server.ts");

const publicUrl = "https://hub.example.test";
const extra = "https://extra.example.test:8443";
const peer = browserMode ? Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("WebSocket peer is reachable");
  },
  websocket: {
    open(ws) {
      console.log("Unexpected cross-origin upgrade reached the CSP peer");
      ws.close();
    },
    message() {},
  },
}) : undefined;
const web = {
  csp: WEB_CSP,
  files: new Map([
    ["/", { body: (await Bun.file(new URL("./browser.html", import.meta.url)).text()).replace("PEER_PORT", String(peer?.port ?? 1)), type: "text/html; charset=utf-8" }],
    ["/probe.js", { body: await Bun.file(new URL("./browser.js", import.meta.url)).text(), type: "text/javascript" }],
    ["/pcm-worklet.js", { body: await Bun.file(new URL("./pcm-worklet.js", import.meta.url)).text(), type: "text/javascript" }],
    ["/manifest.webmanifest", { body: JSON.stringify({
      name: "Lumio Speech Spike", short_name: "Speech Spike", start_url: "/", display: "standalone",
    }), type: "application/manifest+json" }],
  ]),
};

function handshake(port: number, host: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setTimeout(2000, () => socket.destroy(new Error("handshake timeout")));
    socket.on("error", reject);
    socket.on("connect", () => {
      const headers = [
        "GET " + path + " HTTP/1.1", "Host: " + host, "Connection: Upgrade", "Upgrade: websocket",
        "Sec-WebSocket-Key: " + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        "Sec-WebSocket-Version: 13",
      ];
      if (origin !== undefined) headers.push("Origin: " + origin);
      socket.write(headers.join("\r\n") + "\r\n\r\n");
    });
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      if (!buffer.includes("\r\n")) return;
      resolve(Number(buffer.split(" ")[1]));
      socket.destroy();
    });
    socket.on("end", () => reject(new Error("handshake ended without status")));
  });
}

const state = await mkdtemp(join(tmpdir(), "lumio-s1-hub-"));
try {
  const hub = await startHub({
    ...readConfig({ LUMIO_STATE_DIR: state, LUMIO_PUBLIC_URL: publicUrl, LUMIO_WEB_ORIGINS: extra }),
    port: 0,
  }, { web, log: browserMode ? console.log : () => {} });
  const port = hub.server.port!;
  const address = "127.0.0.1:" + port;
  const base = "http://" + address;
  try {
    assert.equal((await fetch(base + "/")).headers.get("content-security-policy")?.includes("connect-src 'self'"), true);
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + "/v2/work/tasks")).status, 401);
    const token = hub.store.createToken("synthetic", hub.store.createActor("synthetic", "human").name);
    assert.equal((await fetch(base + "/v2/work/tasks", { headers: { Authorization: "Bearer " + token } })).status, 200);
    assert.equal((await fetch(base + "/health")).status, 200);
    const cases = [
      ["loopback", address, base, 101], ["public", new URL(publicUrl).host, publicUrl, 101],
      ["extra", new URL(extra).host, extra, 101], ["foreign origin", address, "https://foreign.example.test", 403],
      ["wrong host", "foreign.example.test", base, 403], ["null origin", address, "null", 403],
      ["non-browser, missing Origin", address, undefined, 101],
    ] as const;
    for (const [name, host, origin, expected] of cases) {
      const status = await handshake(port, host, origin);
      assert.equal(status, expected, name);
      console.log(name, status);
    }
    if (browserMode) {
      console.log("BROWSER_URL=" + base);
      await new Promise<void>(resolve => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
  } finally {
    await hub.stop();
  }
} finally {
  await peer?.stop(true);
  await rm(state, { recursive: true, force: true });
}
