/**
 * 图的 SVG 渲染：依赖图（分层、自左向右）与关系图（力导向）。只用浏览器自带的 SVG，不加载外部资源。
 * 节点可点击 / 回车打开；滚轮缩放、拖动平移；颜色全部来自 CSS 变量，跟随主题。
 */
import { forceLayout, layeredLayout, type Edge, type Point } from "./layout.ts";

const SVG = "http://www.w3.org/2000/svg";
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: Array<Node | string | null | undefined | false>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  for (const child of children) if (child) el.append(child);
  return el;
}

/** 估算文字宽度（中日韩字符按全角计）后截断，避免依赖测量 API。 */
export function fitLabel(text: string, maxWidth: number, fontSize = 13): string {
  let width = 0, out = "";
  for (const char of text) {
    const w = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? fontSize : fontSize * 0.56;
    if (width + w > maxWidth) return `${out.trimEnd()}…`;
    width += w; out += char;
  }
  return out;
}

/** 滚轮缩放、拖动平移（作用在 viewBox 上，不改变节点坐标）。 */
function panZoom(svg: SVGSVGElement, width: number, height: number, wheelNeedsModifier = false): void {
  let view = { x: 0, y: 0, w: width, h: height };
  const apply = () => svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  apply();
  svg.addEventListener("wheel", event => {
    // Inside a scrolling page the wheel keeps scrolling; zoom needs ⌘ / Ctrl (pinch on a trackpad sends ctrlKey).
    if (wheelNeedsModifier && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = view.x + ((event.clientX - rect.left) / Math.max(1, rect.width)) * view.w;
    const py = view.y + ((event.clientY - rect.top) / Math.max(1, rect.height)) * view.h;
    const factor = Math.min(4, Math.max(0.25, Math.exp(event.deltaY * 0.0015)));
    const w = Math.min(width * 4, Math.max(width / 6, view.w * factor)), scale = w / view.w;
    view = { x: px - (px - view.x) * scale, y: py - (py - view.y) * scale, w, h: view.h * scale };
    apply();
  }, { passive: false });
  let drag: { x: number; y: number; view: typeof view } | undefined;
  svg.addEventListener("pointerdown", event => {
    if ((event.target as Element).closest(".gnode")) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...view } };
    svg.setPointerCapture(event.pointerId); svg.classList.add("is-panning");
  });
  svg.addEventListener("pointermove", event => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    view = { ...drag.view, x: drag.view.x - ((event.clientX - drag.x) / Math.max(1, rect.width)) * drag.view.w, y: drag.view.y - ((event.clientY - drag.y) / Math.max(1, rect.height)) * drag.view.h };
    apply();
  });
  const end = () => { drag = undefined; svg.classList.remove("is-panning"); };
  svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
}

function activate(node: SVGGElement, open: () => void): void {
  node.setAttribute("tabindex", "0"); node.setAttribute("role", "button");
  node.addEventListener("click", open);
  node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
}

function arrowMarker(id: string): SVGDefsElement {
  return s("defs", {}, s("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
    s("path", { d: "M0 1L9 5L0 9z", class: "garrow" })));
}

let markerSeq = 0;

// ───────────── 依赖图 ─────────────

export interface DagNode { id: string; label: string; sub?: string; state: string; ready?: boolean; external?: boolean }

/** 分层依赖图：边 from → to 表示 to 等 from 完成。 */
export function dependencyGraph(nodes: readonly DagNode[], edges: readonly Edge[], open: (id: string) => void): SVGSVGElement {
  const W = 188, H = 46, COL = 72, ROW = 14, PAD = 20;
  const { layers, position } = layeredLayout(nodes.map(n => n.id), edges);
  const rows = Math.max(1, ...layers.map(list => list.length));
  const width = PAD * 2 + layers.length * W + (layers.length - 1) * COL;
  const height = PAD * 2 + rows * H + (rows - 1) * ROW;
  const at = (id: string) => {
    const p = position.get(id)!, count = layers[p.layer]!.length;
    const offset = ((rows - count) * (H + ROW)) / 2;
    return { x: PAD + p.layer * (W + COL), y: PAD + offset + p.order * (H + ROW) };
  };
  const marker = `garrow-${++markerSeq}`;
  const svg = s("svg", { class: "graph graph-dag", role: "img", preserveAspectRatio: "xMidYMid meet", width, height }, arrowMarker(marker));
  // Natural size: labels stay readable; a wide graph scrolls sideways in its frame.
  svg.style.width = `${width}px`; svg.style.height = `${height}px`;
  const known = new Set(nodes.map(n => n.id));
  const edgeLayer = s("g", { class: "gedges" });
  for (const [from, to] of edges) {
    if (!known.has(from) || !known.has(to) || from === to) continue;
    const a = at(from), b = at(to);
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, bend = Math.max(24, (x2 - x1) / 2);
    edgeLayer.append(s("path", { d: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`, class: "gedge", "marker-end": `url(#${marker})`, "data-from": from, "data-to": to }));
  }
  const nodeLayer = s("g", { class: "gnodes" });
  for (const node of nodes) {
    const { x, y } = at(node.id);
    const g = s("g", { class: `gnode dag-node state-${node.state}${node.ready ? " is-ready" : ""}${node.external ? " is-external" : ""}`, transform: `translate(${x} ${y})`, "data-id": node.id, "aria-label": node.label },
      s("title", {}, [node.label, node.sub].filter(Boolean).join(" · ")),
      s("rect", { width: W, height: H, rx: 8, class: "gbox" }),
      s("circle", { cx: 14, cy: node.sub ? 16 : H / 2, r: 4, class: "gdot" }),
      s("text", { x: 26, y: node.sub ? 20 : H / 2 + 4.5, class: "glabel" }, fitLabel(node.label, W - 36)),
      node.sub ? s("text", { x: 26, y: 36, class: "gsub" }, fitLabel(node.sub, W - 36, 11)) : null);
    activate(g, () => open(node.id));
    // Hover shows the node's direct prerequisites and dependents.
    g.addEventListener("pointerenter", () => highlight(svg, node.id));
    g.addEventListener("pointerleave", () => highlight(svg));
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  panZoom(svg, width, height, true);
  return svg;
}

function highlight(svg: SVGSVGElement, id?: string): void {
  svg.classList.toggle("is-focus", !!id);
  const near = new Set(id ? [id] : []);
  for (const edge of svg.querySelectorAll<SVGElement>(".gedge")) {
    const on = !!id && (edge.dataset.from === id || edge.dataset.to === id);
    edge.classList.toggle("is-near", on);
    if (on) { near.add(edge.dataset.from!); near.add(edge.dataset.to!); }
  }
  for (const node of svg.querySelectorAll<SVGElement>(".gnode")) node.classList.toggle("is-near", near.has(node.dataset.id!));
}

// ───────────── 关系图 ─────────────

export interface NetNode { id: string; label: string; kind: string; center?: boolean; distance?: number; weight?: number }

/** 力导向关系图（笔记链接）。边 from → to 表示 from 的正文链接到 to。 */
export function relationGraph(nodes: readonly NetNode[], edges: readonly Edge[], open: (id: string) => void, size = { width: 680, height: 460 }, positions?: Map<string, Point>): SVGSVGElement {
  const center = nodes.find(n => n.center)?.id;
  const pos = positions ?? forceLayout(nodes.map(n => n.id), edges, { ...size, center });
  const degree = new Map<string, number>();
  for (const [a, b] of edges) { degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1); }
  const marker = `garrow-${++markerSeq}`;
  const svg = s("svg", { class: "graph graph-net", role: "img", preserveAspectRatio: "xMidYMid meet" }, arrowMarker(marker));
  svg.style.aspectRatio = `${size.width} / ${size.height}`;
  const known = new Set(nodes.map(n => n.id));
  const edgeLayer = s("g", { class: "gedges" });
  const weights = new Map(nodes.map(node => [node.id, node.weight]));
  const radius = (id: string, isCenter?: boolean) => isCenter ? 10 : Math.min(weights.get(id) === undefined ? 9 : 18, 4.5 + Math.sqrt(weights.get(id) ?? degree.get(id) ?? 0));
  for (const [from, to] of edges) {
    if (!known.has(from) || !known.has(to) || from === to) continue;
    const a = pos.get(from)!, b = pos.get(to)!, d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const r = radius(to, to === center) + 3;
    edgeLayer.append(s("line", { x1: a.x, y1: a.y, x2: b.x - ((b.x - a.x) / d) * r, y2: b.y - ((b.y - a.y) / d) * r, class: "gedge", "marker-end": `url(#${marker})`, "data-from": from, "data-to": to }));
  }
  const nodeLayer = s("g", { class: "gnodes" });
  for (const node of nodes) {
    const p = pos.get(node.id)!, r = radius(node.id, node.center);
    const g = s("g", { class: `gnode net-node kind-${node.kind}${node.center ? " is-center" : ""}${(node.distance ?? 0) > 1 ? " is-far" : ""}`, transform: `translate(${p.x} ${p.y})`, "data-id": node.id, "aria-label": node.label },
      s("title", {}, node.label),
      s("circle", { r, class: "gdot" }),
      s("text", { y: r + 13, "text-anchor": "middle", class: "glabel" }, fitLabel(node.label, 150, 12)));
    activate(g, () => open(node.id));
    g.addEventListener("pointerenter", () => highlight(svg, node.id));
    g.addEventListener("pointerleave", () => highlight(svg));
    nodeLayer.append(g);
  }
  svg.append(edgeLayer, nodeLayer);
  panZoom(svg, size.width, size.height);
  return svg;
}
