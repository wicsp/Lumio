/**
 * 应用图标（ADR 0027）：石墨底上一盏灯。PNG 在构建时生成，不提交二进制文件，也不需要图像依赖。
 */
import { deflateSync } from "node:zlib";

export const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#1c2220"/><circle cx="16" cy="16" r="7" fill="#f2b705"/></svg>';

const INK = [0x1c, 0x22, 0x20], LUMEN = [0xf2, 0xb7, 0x05];

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
 * 满版正方形图标（可用作 maskable 与 apple-touch-icon）：石墨底，中心灯光圆点带柔和光晕。
 * 圆点半径为边长的 0.2，落在 maskable 的安全区内。
 */
export function iconPng(size: number): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  const c = (size - 1) / 2, r = size * 0.2, glow = size * 0.42;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // 圆点边缘 1px 抗锯齿；圆外按距离衰减的光晕。
      const core = Math.min(1, Math.max(0, r + 0.5 - d));
      const halo = d > r ? 0.38 * Math.max(0, 1 - (d - r) / (glow - r)) ** 2 : 0;
      const t = Math.max(core, halo);
      const i = row + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[i + k] = Math.round(INK[k]! + (LUMEN[k]! - INK[k]!) * t);
      raw[i + 3] = 255;
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
