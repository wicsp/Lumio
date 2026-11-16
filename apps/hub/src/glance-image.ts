import { decode, encode } from "jpeg-js";
import { PNG } from "pngjs";
import { GLANCE_LIMITS, type GlanceImageMeta, type GlancePoint } from "@lumio/schema";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegLimits = {
  tolerantDecoding: false,
  maxResolutionInMP: GLANCE_LIMITS.max_image_edge ** 2 / 1_000_000,
  maxMemoryUsageInMB: 64,
};

function pixels(bytes: Buffer, meta: GlanceImageMeta) {
  if (meta.format === "png") {
    // Limit dimensions before the decoder allocates any pixel buffers.
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== meta.width || bytes.readUInt32BE(20) !== meta.height) throw new Error("Invalid PNG dimensions");
    return PNG.sync.read(bytes);
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid JPEG signature");
  return decode(bytes, jpegLimits);
}

export function checkGlanceImage(bytes: Buffer, meta: GlanceImageMeta): boolean {
  if (!bytes.length || bytes.length > GLANCE_LIMITS.max_image_bytes) return false;
  try {
    const image = pixels(bytes, meta);
    return image.width === meta.width && image.height === meta.height;
  } catch { return false; }
}

export function withPointer(bytes: Buffer, meta: GlanceImageMeta, point?: GlancePoint): { format: string; bytes: Buffer } {
  if (!point) return { format: meta.format, bytes };
  const image = pixels(bytes, meta);
  const radius = Math.max(6, Math.round(Math.max(meta.width, meta.height) / 70));
  for (let y = Math.max(0, point.y - radius - 3); y < Math.min(meta.height, point.y + radius + 4); y++) {
    for (let x = Math.max(0, point.x - radius - 3); x < Math.min(meta.width, point.x + radius + 4); x++) {
      const distance = Math.abs(Math.hypot(x - point.x, y - point.y) - radius);
      if (distance > 3) continue;
      image.data.set(distance > 1.5 ? [255, 255, 255, 255] : [222, 33, 61, 255], (y * meta.width + x) * 4);
    }
  }
  return { format: "jpeg", bytes: Buffer.from(encode(image, 84).data) };
}
