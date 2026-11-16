import { GLANCE_LIMITS, GlancePointing, type GlanceBox, type GlanceCreate, type GlancePoint } from "@lumio/schema";

const regionSpan = 20;
const closureRatio = 0.35;

export function readingOrder(ocr: GlanceCreate["ocr"], indices = ocr.map((_, index) => index)): number[] {
  return [...indices].sort((first, second) => {
    const a = ocr[first]!.box, b = ocr[second]!.box;
    return a.y - b.y || a.x - b.x || first - second;
  });
}

function regionOf(trail: GlanceCreate["trail"]): GlanceBox | undefined {
  if (trail.length < 4) return;
  const xs = trail.map(point => point.x), ys = trail.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  const first = trail[0]!, last = trail.at(-1)!;
  if (w >= regionSpan && h >= regionSpan && Math.hypot(first.x - last.x, first.y - last.y) <= Math.min(w, h) * closureRatio) return { x, y, w, h };
}

function distance(point: GlancePoint, box: GlanceBox): number {
  return Math.hypot(Math.max(box.x - point.x, 0, point.x - box.x - box.w),
    Math.max(box.y - point.y, 0, point.y - box.y - box.h));
}

function paragraph(pointer: GlancePoint, ocr: GlanceCreate["ocr"]): number[] {
  const order = readingOrder(ocr);
  const nearest = order.reduce((best, index) =>
    best === undefined || distance(pointer, ocr[index]!.box) < distance(pointer, ocr[best]!.box) ? index : best, undefined as number | undefined);
  if (nearest === undefined) return [];
  const anchor = ocr[nearest]!.box;
  const column = order.filter(index => Math.abs(ocr[index]!.box.x - anchor.x) <= Math.max(14, anchor.h));
  const position = column.indexOf(nearest);
  const close = (a: GlanceBox, b: GlanceBox) => b.y - (a.y + a.h) <= Math.max(a.h, b.h) * 0.8;
  let start = position, end = position;
  while (start > 0 && close(ocr[column[start - 1]!]!.box, ocr[column[start]!]!.box)) start--;
  while (end + 1 < column.length && close(ocr[column[end]!]!.box, ocr[column[end + 1]!]!.box)) end++;
  return column.slice(start, end + 1);
}

export function pointGlance({ ocr, selection_text, trail, pointer }: GlanceCreate): GlancePointing {
  if (selection_text?.trim()) return { method: "selection", text: selection_text, blocks: [] };
  const region = regionOf(trail);
  const blocks = region ? readingOrder(ocr, ocr.flatMap(({ box }, index) => {
    const x = box.x + box.w / 2, y = box.y + box.h / 2;
    return x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h ? [index] : [];
  })) : pointer ? paragraph(pointer, ocr) : [];
  const text = blocks.map(index => ocr[index]!.text).join("\n").slice(0, GLANCE_LIMITS.max_selection_chars);
  return GlancePointing.parse(region ? { method: "region", region, blocks, text: text || undefined }
    : blocks.length ? { method: "point", blocks, text } : { method: "none" });
}
