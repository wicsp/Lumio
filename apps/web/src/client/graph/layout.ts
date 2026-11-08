/**
 * 图的布局（纯函数，不碰 DOM；不引入图形依赖）。
 * - layered：有向无环图自左向右分层（任务依赖图）。层 = 从源点出发的最长路径；层内顺序用重心法几轮扫描减少交叉。
 * - force：无向图的力导向布局（笔记关系图）。初始位置由序号决定，结果可复现；中心节点固定在画布中央。
 */
export type Edge = readonly [from: string, to: string];

export interface Layered { layers: string[][]; position: Map<string, { layer: number; order: number }> }

/** 分层布局。边 from → to 表示 to 依赖 from（from 在左）。遇到环时不死循环：环上的点留在已算出的层。 */
export function layeredLayout(nodes: readonly string[], edges: readonly Edge[]): Layered {
  const known = new Set(nodes);
  const valid = edges.filter(([from, to]) => from !== to && known.has(from) && known.has(to));
  const incoming = new Map<string, string[]>(nodes.map(id => [id, []]));
  const outgoing = new Map<string, string[]>(nodes.map(id => [id, []]));
  for (const [from, to] of valid) { incoming.get(to)!.push(from); outgoing.get(from)!.push(to); }
  const layer = new Map<string, number>(nodes.map(id => [id, 0]));
  // Longest path by relaxation; at most |V| rounds, so a cycle cannot loop forever.
  for (let round = 0; round < nodes.length; round++) {
    let changed = false;
    for (const [from, to] of valid) {
      const next = layer.get(from)! + 1;
      if (next > layer.get(to)! && next < nodes.length) { layer.set(to, next); changed = true; }
    }
    if (!changed) break;
  }
  const depth = Math.max(0, ...layer.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of nodes) layers[layer.get(id)!]!.push(id);
  const order = new Map<string, number>();
  const index = () => layers.forEach(list => list.forEach((id, i) => order.set(id, i)));
  index();
  const barycenter = (id: string, neighbours: string[], fallback: number) =>
    neighbours.length ? neighbours.reduce((sum, other) => sum + order.get(other)!, 0) / neighbours.length : fallback;
  for (let sweep = 0; sweep < 4; sweep++) {
    const forward = sweep % 2 === 0;
    const sequence = forward ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const list of sequence) {
      const scored = list.map((id, i) => ({ id, score: barycenter(id, forward ? incoming.get(id)! : outgoing.get(id)!, i), i }));
      scored.sort((a, b) => a.score - b.score || a.i - b.i);
      list.splice(0, list.length, ...scored.map(entry => entry.id));
      index();
    }
  }
  const position = new Map<string, { layer: number; order: number }>();
  layers.forEach((list, l) => list.forEach((id, o) => position.set(id, { layer: l, order: o })));
  return { layers, position };
}

export interface Point { x: number; y: number }

/** 力导向布局（Fruchterman–Reingold 的简化版）。center 固定在中央；输出坐标落在 [0,width]×[0,height] 内。 */
function* forceSteps(nodes: readonly string[], edges: readonly Edge[], options: { width: number; height: number; center?: string; iterations?: number }): Generator<void, Map<string, Point>> {
  if (!nodes.length) return new Map();
  const { width, height } = options, iterations = options.iterations ?? 300;
  const pos = new Map<string, Point>();
  const cx = width / 2, cy = height / 2;
  const n = Math.max(1, nodes.length);
  nodes.forEach((id, i) => {
    if (id === options.center) { pos.set(id, { x: cx, y: cy }); return; }
    // Golden-angle spiral: deterministic and evenly spread.
    const angle = i * 2.399963, radius = Math.min(width, height) * 0.42 * Math.sqrt((i + 0.5) / n);
    pos.set(id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  const known = new Set(nodes);
  const links = edges.filter(([a, b]) => a !== b && known.has(a) && known.has(b));
  const k = Math.sqrt((width * height) / n) * 0.75;
  let temperature = Math.min(width, height) / 8;
  for (let step = 0; step < iterations; step++) {
    const move = new Map<string, Point>(nodes.map(id => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = pos.get(nodes[i]!)!, b = pos.get(nodes[j]!)!;
      let dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
      if (d < 0.01) { dx = 0.01 * (i - j); dy = 0.01; d = Math.hypot(dx, dy); }
      const force = (k * k) / d;
      const ma = move.get(nodes[i]!)!, mb = move.get(nodes[j]!)!;
      ma.x += (dx / d) * force; ma.y += (dy / d) * force; mb.x -= (dx / d) * force; mb.y -= (dy / d) * force;
    }
    for (const [from, to] of links) {
      const a = pos.get(from)!, b = pos.get(to)!;
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.max(0.01, Math.hypot(dx, dy));
      const force = (d * d) / k;
      const ma = move.get(from)!, mb = move.get(to)!;
      ma.x -= (dx / d) * force; ma.y -= (dy / d) * force; mb.x += (dx / d) * force; mb.y += (dy / d) * force;
    }
    for (const id of nodes) {
      if (id === options.center) continue;
      const m = move.get(id)!, p = pos.get(id)!, d = Math.max(0.01, Math.hypot(m.x, m.y));
      // A weak pull to the middle keeps disconnected pieces on screen.
      p.x += (m.x / d) * Math.min(d, temperature) + (cx - p.x) * 0.01;
      p.y += (m.y / d) * Math.min(d, temperature) + (cy - p.y) * 0.01;
    }
    temperature *= 0.985;
    yield;
  }
  // Fit into the canvas with a margin, keeping the aspect ratio and the center node centred.
  const margin = 40, xs = [...pos.values()].map(p => p.x), ys = [...pos.values()].map(p => p.y);
  const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs)), spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const scale = Math.min(1.6, (width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2, midY = (Math.max(...ys) + Math.min(...ys)) / 2;
  const origin = options.center && pos.has(options.center) ? pos.get(options.center)! : { x: midX, y: midY };
  const anchorX = options.center ? origin.x : midX, anchorY = options.center ? origin.y : midY;
  const out = new Map<string, Point>();
  for (const [id, p] of pos) {
    out.set(id, { x: clamp(cx + (p.x - anchorX) * scale, margin / 2, width - margin / 2), y: clamp(cy + (p.y - anchorY) * scale, margin / 2, height - margin / 2) });
  }
  return out;
}

export function forceLayout(nodes: readonly string[], edges: readonly Edge[], options: { width: number; height: number; center?: string; iterations?: number }): Map<string, Point> {
  const steps = forceSteps(nodes, edges, options);
  let next = steps.next(); while (!next.done) next = steps.next();
  return next.value;
}

/** Share the same deterministic simulation, yielding between small batches for input and cancellation. */
export async function forceLayoutAsync(nodes: readonly string[], edges: readonly Edge[], options: {
  width: number; height: number; center?: string; iterations?: number; batchSize?: number;
  isCurrent?: () => boolean; yieldFrame?: () => Promise<void>;
}): Promise<Map<string, Point> | undefined> {
  // Message tasks yield to input without animation/timer throttling in background tabs.
  const channel = !options.yieldFrame && typeof MessageChannel !== "undefined" ? new MessageChannel() : undefined;
  const yieldFrame = options.yieldFrame ?? (() => new Promise<void>(resolve => {
    if (channel) { channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); }
    else setTimeout(resolve, 0);
  }));
  const steps = forceSteps(nodes, edges, options), batch = Math.max(1, options.batchSize ?? 2);
  let count = 0;
  try {
    for (;;) {
      if (options.isCurrent && !options.isCurrent()) return;
      const next = steps.next();
      if (next.done) return next.value;
      if (++count % batch === 0) await yieldFrame();
    }
  } finally { channel?.port1.close(); channel?.port2.close(); }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
