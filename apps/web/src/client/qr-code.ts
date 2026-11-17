import { encode } from "uqr";

/** 把文字画成二维码 SVG（只用 DOM，不用 innerHTML，符合页面 CSP）。 */
export function qrSvg(content: string, label: string): SVGSVGElement {
  const { data, size } = encode(content, { ecc: "M", border: 2 });
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "qr");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(size)); bg.setAttribute("height", String(size)); bg.setAttribute("class", "qr-bg");
  let d = "";
  data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d); path.setAttribute("class", "qr-fg");
  svg.append(bg, path);
  return svg;
}
