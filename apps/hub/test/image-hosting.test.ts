import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, IMAGE_UPLOAD_MAX_BYTES, ImageHostingSettings, ImageHostingUpdate, ImageUploadResult } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";
import type { ImageHostingSend } from "../src/image-hosting.ts";

const settingsPath = "/v2/knowledge/image-hosting";
const note = "idea_00000000000000000000000004";
const uploadPath = "/v2/knowledge/notes/" + note + "/images";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf+QAAAAASUVORK5CYII=", "base64");
const secret = "synthetic-storage-secret";
const preview_origins = ["https://images.example.com", "https://previous.example.com"];

test("only humans can set image hosting; settings, credentials, and preview policy survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-image-settings-"));
  const vault = join(root, "vault"), stateDir = join(root, "state");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const logs: string[] = [];
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";
  const start = () => startHub(readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: stateDir, LUMIO_HUB_LISTEN: "127.0.0.1:0" }), {
    log: (line) => logs.push(line), web: { files: new Map([["/", { type: "text/html", body: "<html><head></head><body></body></html>" }]]), csp },
  });
  let hub = await start();
  try {
    for (const role of ["human", "agent", "runtime"] as const) hub.store.createActor(role, role);
    const human = hub.store.createToken("human", "human");
    const call = (path: string, method = "GET", body?: unknown, token = human) => fetch(new URL(path, hub.server.url), {
      method, headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const initial = await call(settingsPath);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(ImageHostingSettings.parse(await initial.json())).toEqual({ revision: 1, destination: null, credentials_saved: false, preview_origins: [] });
    for (const role of ["agent", "runtime"] as const) {
      const token = hub.store.createToken(role, role);
      expect((await call(settingsPath, "GET", undefined, token)).status).toBe(403);
      expect((await call(settingsPath, "PUT", {}, token)).status).toBe(403);
      expect((await call(uploadPath, "POST", {}, token)).status).toBe(403);
    }
    expect((await call(settingsPath, "PUT", { expected_revision: 1, destination: null, preview_origins: ['https://example.com";script-src'] })).status).toBe(400);
    const draft = ImageHostingUpdate.parse({
      expected_revision: 1, preview_origins,
      destination: { kind: "s3", label: "Cloudflare R2", endpoint: "https://sample.r2.cloudflarestorage.com", public_base: preview_origins[0], bucket: "images", region: "auto", prefix: "lumio", virtual_hosted: false },
      credentials: { kind: "s3", access_key_id: "fake-access-key", secret_access_key: secret },
    });
    const saved = await call(settingsPath, "PUT", draft);
    const view = await saved.text();
    expect(view).not.toContain(secret);
    const first = ImageHostingSettings.parse(JSON.parse(view));
    expect(first).toMatchObject({ revision: 2, credentials_saved: true, preview_origins });
    expect((await stat(join(stateDir, "image-hosting.json"))).mode & 0o777).toBe(0o600);
    const edits = await Promise.all([1, 2].map(() => call(settingsPath, "PUT", { expected_revision: 2, destination: first.destination, preview_origins })));
    expect(edits.map(edit => edit.status).sort()).toEqual([200, 409]);
    expect((await call(settingsPath, "PUT", { expected_revision: 3, destination: { ...first.destination, bucket: "other" }, preview_origins })).status).toBe(400);

    await hub.stop();
    hub = await start();
    expect(ImageHostingSettings.parse(await (await call(settingsPath)).json())).toEqual({ ...first, revision: 3 });
    const html = await fetch(new URL("/", hub.server.url));
    expect(html.headers.get("content-security-policy")).toContain("img-src 'self' data: " + preview_origins.join(" ") + ";");
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await html.text()).toContain('name="lumio-image-origins" content="' + preview_origins.join(" ") + '"');
    const reset = ImageHostingSettings.parse(await (await call(settingsPath, "PUT", { expected_revision: 3, preview_origins, destination: null })).json());
    expect(reset).toEqual({ revision: 4, destination: null, credentials_saved: false, preview_origins });
    expect(await readFile(join(stateDir, "image-hosting.json"), "utf8")).not.toContain(secret);
    const audit = hub.store.db.query("SELECT * FROM audit WHERE operation LIKE 'knowledge.image-%'").all();
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ authorization: "deny" }), expect.objectContaining({ authorization: "allow", execution_result: "applied" })]));
    expect(JSON.stringify(audit) + logs.join("\n")).not.toContain(secret);
  } finally {
    await hub.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("upload transports use validated image bytes, bounded note access and allowlisted delivery URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-image-upload-"));
  const vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const sent: [URL, Parameters<ImageHostingSend>[1]][] = [];
  let upstream: Buffer | Error = Buffer.alloc(0);
  const hub = await startHub(readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }), {
    log() {},
    imageHostingSend: async (url, request) => {
      sent.push([url, request]);
      if (upstream instanceof Error) throw upstream;
      return upstream;
    },
  });
  try {
    hub.store.createActor("human", "human");
    const token = hub.store.createToken("human", "human");
    let revision = 1;
    const configure = async (input: Pick<ImageHostingUpdate, "destination" | "credentials">) => {
      const response = await fetch(new URL(settingsPath, hub.server.url), { method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: revision, preview_origins, ...input }),
      });
      expect(response.status).toBe(200);
      const saved = ImageHostingSettings.parse(await response.json());
      revision = saved.revision;
      return saved;
    };
    const file = new File([new Uint8Array(png)], "untrusted.html", { type: "text/html" });
    const upload = async (image: File, id = note) => {
      const data = new FormData(); data.set("image", image);
      return fetch(new URL("/v2/knowledge/notes/" + id + "/images", hub.server.url), { method: "POST", headers: { Authorization: "Bearer " + token }, body: data });
    };
    const uploadImage = async () => ImageUploadResult.parse(await (await upload(file)).json());
    expect((await upload(file)).status).toBe(400);
    await configure({
      destination: { kind: "s3", label: "R2", endpoint: "https://example.r2.cloudflarestorage.com", bucket: "bucket", region: "auto", virtual_hosted: false, prefix: "笔记", public_base: preview_origins[0]! },
      credentials: { kind: "s3", access_key_id: "testkey", secret_access_key: secret },
    });
    expect((await upload(new File(["<svg/>"], "false.png", { type: "image/png" }))).status).toBe(400);
    expect((await upload(file, "idea_00000000000000000000000000")).status).toBe(400);
    const tooLarge = new File([new Uint8Array(IMAGE_UPLOAD_MAX_BYTES + 1)], "large.png", { type: "image/png" });
    expect((await upload(tooLarge)).status).toBe(400);
    expect((await upload(file, "ast_00000000000000000000000007")).status).toBe(400);
    expect(sent).toHaveLength(0);
    const r2 = await uploadImage();
    const [s3Url, s3Input] = sent[0]!;
    expect(s3Input.method).toBe("PUT");
    expect(s3Input.headers.get("content-type")).toBe("image/png");
    expect(s3Input.body).toEqual(png);
    expect(s3Url.pathname).toContain("/bucket/" + encodeURIComponent("笔记") + "/");
    expect(s3Url.searchParams.get("X-Amz-Credential")).toMatch(/^testkey\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(r2.url).toBe(preview_origins[0] + s3Url.pathname.replace(/^\/bucket/, ""));
    expect(r2).toMatchObject({ media_type: "image/png", size: png.length });

    await configure({
      destination: { kind: "github", label: "GitHub", repository: "owner/images", branch: "images", prefix: "notes", public_base: preview_origins[0]! },
      credentials: { kind: "github", token: secret },
    });
    await uploadImage();
    const [github, gitInput] = sent[1]!;
    expect(github.href).toMatch(/^https:\/\/api\.github\.com\/repos\/owner\/images\/contents\/notes\/[^/]+\.png$/);
    expect(gitInput.headers.get("authorization")).toBe("Bearer " + secret);
    expect(JSON.parse(gitInput.body.toString("utf8"))).toMatchObject({ branch: "images", content: png.toString("base64") });

    const custom = { kind: "http", label: "Custom host", endpoint: "https://uploader.example.com/api", public_base: preview_origins[0]!, prefix: "", method: "POST", file_field: "file", response_path: ["images", 0, "url"] } as const;
    await configure({
      destination: { ...custom, response_path: [...custom.response_path] },
      credentials: { kind: "http", headers: { Authorization: "Bearer " + secret }, query: { format: "json" }, fields: { folder: "images" } },
    });
    upstream = Buffer.from(JSON.stringify({ images: [{ url: "/existing/image.png" }] }));
    expect((await uploadImage()).url).toBe(preview_origins[0] + "/existing/image.png");
    const [http, httpInput] = sent[2]!;
    expect(http.search).toBe("?format=json");
    const payload = await new Response(new Uint8Array(httpInput.body), { headers: httpInput.headers }).formData();
    expect(payload.get("folder")).toBe("images");
    expect(Buffer.from(await (payload.get("file") as File).arrayBuffer())).toEqual(png);

    upstream = Buffer.from(JSON.stringify({ images: [{ url: "https://unapproved.example.com/image.png" }] }));
    expect((await upload(file)).status).toBe(500);
    upstream = new Error("Failed request containing " + secret);
    const failed = await upload(file);
    expect(failed.status).toBe(500);
    const failure = await failed.text();
    expect(ApiError.parse(JSON.parse(failure)).error.code).toBe("INTERNAL");
    expect(failure).not.toContain(secret);

    upstream = Buffer.alloc(0);
    await configure({
      destination: { kind: "http", label: "WebDAV", endpoint: "https://dav.example.com/upload/{key}", public_base: preview_origins[0]!, prefix: "notes", method: "PUT" },
      credentials: null,
    });
    expect((await uploadImage()).url).toMatch(/^https:\/\/images\.example\.com\/notes\/[^/]+\.png$/);
    expect(sent.at(-1)![0].pathname).toMatch(/^\/upload\/notes\/[^/]+\.png$/);
    expect(sent.at(-1)![1].body).toEqual(png);
  } finally {
    await hub.stop();
    await rm(root, { recursive: true, force: true });
  }
});
