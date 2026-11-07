/**
 * 应用图标：像素风日出（ADR 0027 规定提供图标，图形本身是界面设计，不需 ADR）。
 * 夜色底上，像素太阳从米白地平线升起，下方一道淡倒影。
 * SVG 与 PNG 共用同一组像素块（100×100 坐标）；PNG 在构建时生成，不提交二进制文件，也不需要图像依赖。
 */
import { deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];
const NIGHT: Rgb = [0x1b, 0x1d, 0x2a], SUN: Rgb = [0xff, 0xb5, 0x47], CREAM: Rgb = [0xf4, 0xf1, 0xea];
const CORNER_RADIUS = 23;

/** 像素块：x、y、宽、高、颜色、不透明度。后画的盖住先画的。 */
const BLOCKS: ReadonlyArray<readonly [number, number, number, number, Rgb, number]> = [
  [47, 26, 6, 6, SUN, 1], [26, 34, 6, 6, SUN, 1], [68, 34, 6, 6, SUN, 1], // 光芒
  [44, 40, 12, 6, SUN, 1], [38, 46, 24, 6, SUN, 1], [32, 52, 36, 6, SUN, 1], // 太阳
  [20, 58, 60, 6, CREAM, 1], // 地平线
  [38, 70, 24, 6, CREAM, 0.4], // 倒影
];

const hex = (c: Rgb) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
export const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="crispEdges">'
  + `<rect width="100" height="100" rx="${CORNER_RADIUS}" fill="${hex(NIGHT)}" shape-rendering="geometricPrecision"/>`
  + BLOCKS.map(([x, y, w, h, c, a]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${hex(c)}"${a < 1 ? ` fill-opacity="${a}"` : ""}/>`).join("")
  + "</svg>";

/** 100×100 坐标下某点的颜色。 */
function colorAt(u: number, v: number): [number, number, number] {
  const out: [number, number, number] = [NIGHT[0], NIGHT[1], NIGHT[2]];
  for (const [x, y, w, h, c, a] of BLOCKS) {
    if (u >= x && u < x + w && v >= y && v < y + h) for (let k = 0; k < 3; k++) out[k] = out[k]! + (c[k]! - out[k]!) * a;
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * 普通安装图标与 SVG 一样带透明圆角；maskable 与 apple-touch-icon 保持满版，由系统裁切。
 * 图形都落在中心半径 0.4 边长的 maskable 安全区内。每个像素 4×4 超采样，边缘平滑。
 */
export function iconPng(size: number, options: { maskable?: boolean } = {}): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  const S = 4, scale = 100 / size;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const u = (x + (sx + 0.5) / S) * scale, v = (y + (sy + 0.5) / S) * scale;
        const dx = Math.max(CORNER_RADIUS - u, 0, u - (100 - CORNER_RADIUS));
        const dy = Math.max(CORNER_RADIUS - v, 0, v - (100 - CORNER_RADIUS));
        if (!options.maskable && dx * dx + dy * dy > CORNER_RADIUS * CORNER_RADIUS) continue;
        const c = colorAt(u, v);
        covered++;
        for (let k = 0; k < 3; k++) sum[k]! += c[k]!;
      }
      const i = row + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[i + k] = covered ? Math.round(sum[k]! / covered) : 0;
      raw[i + 3] = Math.round(255 * covered / (S * S));
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size); view.setUint32(4, size);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}
