import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { MANIFEST, WEB_CSP, renderPage, webFiles } from "../src/page.ts";
import { iconPng } from "../src/icons.ts";
import * as entry from "../src/entry.ts";

const assets = { js: "console.log(1)", css: ":root{--lumen:#f2b705}" };

describe("page", () => {
  test("Hub-served page uses the same-origin root and carries no fixed Hub", () => {
    const html = renderPage({ apiBase: "" });
    expect(html).toContain('<meta name="lumio-api-base" content="">');
    expect(html).not.toContain('name="lumio-hub"');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">');
  });
  test("standalone Web server page keeps the /hub proxy and escapes the Hub origin", () => {
    const html = renderPage({ apiBase: "/hub", hub: 'http://h"<x>' });
    expect(html).toContain('content="/hub"');
    expect(html).toContain('content="http://h&quot;&lt;x&gt;"');
  });
  test("apiBase is restricted to empty or one path segment", () => {
    for (const bad of ["hub", "/hub/x", "//evil.example", '/hub"']) expect(() => renderPage({ apiBase: bad })).toThrow();
  });
});

describe("files", () => {
  const files = webFiles(assets, { apiBase: "" });
  test("every manifest icon and every page link is served with the right type", () => {
    for (const icon of MANIFEST.icons) expect(files.get(icon.src)?.type).toBe(icon.type);
    for (const path of ["/", "/assets/app.js", "/assets/app.css", "/manifest.webmanifest", "/favicon.svg", "/assets/apple-touch-icon.png"]) expect(files.has(path)).toBe(true);
    expect(files.get("/assets/app.js")?.body).toBe(assets.js);
    expect(JSON.parse(String(files.get("/manifest.webmanifest")!.body))).toMatchObject({ name: "Lumio", display: "standalone", start_url: "/" });
  });
  test("CSP allows the manifest but no inline script, framing or remote origins", () => {
    expect(WEB_CSP).toContain("manifest-src 'self'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
    expect(WEB_CSP).not.toContain("unsafe-inline");
    expect(WEB_CSP).not.toMatch(/https?:/);
  });
  test("entry module exposes only the build and file-table functions", () => {
    expect(Object.keys(entry).sort()).toEqual(["WEB_CSP", "buildWebAssets", "webFiles"]);
  });
});

describe("icons", () => {
  test("PNG icons are valid RGBA images of the requested size with the lamp in the centre", () => {
    for (const size of [180, 192, 512]) {
      const png = iconPng(size);
      expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(png.buffer, png.byteOffset);
      expect([view.getUint32(16), view.getUint32(20), png[24], png[25]]).toEqual([size, size, 8, 6]);
      // 解出像素：中心是灯光黄，角落是石墨色，全部不透明。
      const idatLength = view.getUint32(33);
      const raw = inflateSync(png.subarray(41, 41 + idatLength));
      const pixel = (x: number, y: number) => Array.from(raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 5 + x * 4));
      expect(pixel(size >> 1, size >> 1)).toEqual([0xf2, 0xb7, 0x05, 255]);
      expect(pixel(0, 0)).toEqual([0x1c, 0x22, 0x20, 255]);
    }
  });
});
