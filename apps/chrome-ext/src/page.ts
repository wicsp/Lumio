/**
 * 决定怎么存当前页面，并把页面送来的原始数据整理成捕获请求（ADR 0057 第 3 节：插件是主路径）。
 * 这里都是纯函数，不碰 chrome.* 与 DOM，便于测试。
 */
import { CAPTURE_LIMITS, type CaptureCreate, type ReadingStatus } from "@lumio/schema";

/** 存页面的方式：只送链接（Hub 自己下载），送页面 HTML，或送视频字幕。 */
export type Strategy = "link" | "page" | "youtube" | "bilibili" | "unsupported";

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function strategyFor(raw: string | undefined): Strategy {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { return "unsupported"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unsupported";
  const host = url.hostname.toLowerCase();
  // 论文：Hub 有更好的来源（arXiv 全文 HTML、元数据），页面本身只有摘要。
  if (hostIs(host, "arxiv.org") || hostIs(host, "doi.org")) return "link";
  // 浏览器里打开的 PDF：插件读不到内容，交给 Hub 下载。
  if (/\.pdf$/i.test(url.pathname)) return "link";
  if ((hostIs(host, "youtube.com") && url.pathname === "/watch" && url.searchParams.has("v")) || hostIs(host, "youtu.be")) return "youtube";
  if (hostIs(host, "bilibili.com") && /^\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(url.pathname)) return "bilibili";
  return "page";
}

/** 页面快照：注入脚本返回的内容。 */
export interface PageSnapshot { url: string; title: string; html: string; text: string; description?: string }

/** 视频字幕：注入脚本返回的原始数据（YouTube json3 / 字幕面板文本，B 站字幕 JSON）。 */
export interface TranscriptResult {
  title?: string;
  description?: string;
  /** 字幕语言，如 zh-CN、en。 */
  lang?: string;
  /** 自动生成的字幕。 */
  auto?: boolean;
  /** YouTube 的 json3 字幕。 */
  json3?: string;
  /** B 站字幕文件（JSON）。 */
  bilibili?: string;
  /** 从字幕面板读到的分段文字。 */
  segments?: string[];
}

/** YouTube json3：events[].segs[].utf8，按事件拼成行。 */
export function json3Text(raw: string): string {
  let data: { events?: Array<{ segs?: Array<{ utf8?: string }> }> };
  try { data = JSON.parse(raw); } catch { return ""; }
  return lines((data.events ?? []).map(event => (event.segs ?? []).map(seg => seg.utf8 ?? "").join("")));
}

/** B 站字幕：body[].content。 */
export function bilibiliText(raw: string): string {
  let data: { body?: Array<{ content?: string }> };
  try { data = JSON.parse(raw); } catch { return ""; }
  return lines((data.body ?? []).map(item => item.content ?? ""));
}

/** 去掉空行和连续重复（自动字幕常见），每行一句。 */
function lines(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    const line = part.replace(/\s+/g, " ").trim();
    if (line && line !== out[out.length - 1]) out.push(line);
  }
  return out.join("\n");
}

export function transcriptText(result: TranscriptResult): string {
  if (result.json3) { const text = json3Text(result.json3); if (text) return text; }
  if (result.bilibili) { const text = bilibiliText(result.bilibili); if (text) return text; }
  return lines(result.segments ?? []);
}

interface BuildInput {
  strategy: Exclude<Strategy, "unsupported">;
  url: string;
  title?: string;
  page?: PageSnapshot;
  transcript?: TranscriptResult;
  triage?: ReadingStatus;
  requestId: string;
}

/** 结果里 `note` 说明这次存了什么，给弹窗显示。 */
export interface Built { request: CaptureCreate; note: "link" | "page" | "page-text" | "transcript" | "no-transcript" }

const clip = (value: string | undefined, max: number) => value?.trim().slice(0, max) || undefined;

export function buildCapture(input: BuildInput): Built {
  const base = {
    request_id: input.requestId, channel: "extension" as const, url: input.url,
    ...(clip(input.transcript?.title ?? input.page?.title ?? input.title, 500) ? { title: clip(input.transcript?.title ?? input.page?.title ?? input.title, 500) } : {}),
    ...(input.triage ? { triage: input.triage } : {}),
  };
  const max = CAPTURE_LIMITS.max_content_chars;
  if (input.strategy === "youtube" || input.strategy === "bilibili") {
    const text = input.transcript ? transcriptText(input.transcript) : "";
    const description = clip(input.transcript?.description, 20_000);
    if (text) {
      const head = [description ? `## 简介\n\n${description}` : "", `## 字幕${input.transcript?.auto ? "（自动生成）" : ""}`].filter(Boolean).join("\n\n");
      return { request: { ...base, content: { format: "markdown", body: `${head}\n\n${text}`.slice(0, max) } }, note: "transcript" };
    }
    // 没取到字幕：只存简介，标明没有字幕，避免 Hub 去找执行器。
    const body = `${description ? `## 简介\n\n${description}\n\n` : ""}（没有取到字幕）`;
    return { request: { ...base, content: { format: "markdown", body } }, note: "no-transcript" };
  }
  if (input.strategy === "page" && input.page) {
    if (input.page.html && input.page.html.length <= max) return { request: { ...base, content: { format: "html", body: input.page.html } }, note: "page" };
    if (input.page.text.trim()) return { request: { ...base, content: { format: "text", body: input.page.text.slice(0, max) } }, note: "page-text" };
  }
  return { request: base, note: "link" };
}

/** Hub 地址：补全协议，只保留 origin。 */
export function normalizeHub(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return undefined;
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch { return undefined; }
}
