export type PadDirection = "up" | "down" | "left" | "right";

export interface FocusBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FocusItem<T> {
  item: T;
  region: unknown;
  bounds: FocusBounds;
}

/** Keep movement local to the region until there is no item in that direction. */
export function adjacentFocus<T>(items: FocusItem<T>[], current: T, direction: PadDirection): T | undefined {
  const origin = items.find(entry => entry.item === current);
  if (!origin) return items[0]?.item;
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  const axis = (rect: FocusBounds) => vertical ? [rect.top, rect.bottom] as const : [rect.left, rect.right] as const;
  const cross = (rect: FocusBounds) => vertical ? [rect.left, rect.right] as const : [rect.top, rect.bottom] as const;
  const [start, end] = axis(origin.bounds);
  const [sideStart, sideEnd] = cross(origin.bounds);
  const candidates = items.flatMap(entry => {
    if (entry === origin) return [];
    const [near, far] = axis(entry.bounds);
    const [sideNear, sideFar] = cross(entry.bounds);
    const distance = sign * (near + far - start - end) / 2;
    if (distance <= 1) return [];
    const gap = Math.max(0, sideStart - sideFar, sideNear - sideEnd);
    const overlap = Math.min(sideEnd, sideFar) - Math.max(sideStart, sideNear);
    // Vertically stacked lists often have different card widths. Horizontal moves
    // within the same list require actual side-by-side items.
    if (entry.region === origin.region && !vertical && (overlap <= 0 || (near < end && far > start))) return [];
    const centerOffset = Math.abs(sideNear + sideFar - sideStart - sideEnd) / 2;
    return [{ entry, distance, gap, centerOffset }];
  });
  const local = candidates.filter(({ entry }) => entry.region === origin.region);
  const pool = local.length ? local : candidates;
  return pool.sort((a, b) => a.gap - b.gap || a.distance - b.distance || a.centerOffset - b.centerOffset)[0]?.entry.item;
}
