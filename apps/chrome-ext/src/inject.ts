/**
 * 注入到当前页面运行的函数（chrome.scripting.executeScript 会把函数源码序列化后执行）。
 * 因此每个函数都必须自成一体：不能引用外部变量、import 或其他函数，只能用参数和页面全局。
 * 返回值必须是可结构化克隆的普通数据。
 */
import type { PageSnapshot, TranscriptResult } from "./page.ts";

/** 普通网页：整页 HTML 交给 Hub 抽正文；同时带上纯文本，HTML 太大时用。 */
export function snapshotPage(): PageSnapshot {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="description"], meta[property="og:description"]');
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    text: document.body?.innerText ?? "",
    ...(meta?.content ? { description: meta.content } : {}),
  };
}

/**
 * YouTube（在页面的 MAIN world 运行，才能读到播放器数据）。
 * 先用播放器里的字幕轨道下载 json3；拿不到时读已经展开的"显示文字记录"面板。
 * 优先人工字幕，其次中文、英文，最后自动字幕。
 */
export async function youtubeTranscript(): Promise<TranscriptResult> {
  type Track = { baseUrl?: string; languageCode?: string; kind?: string };
  type Response = { videoDetails?: { title?: string; shortDescription?: string }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } } };
  const player = document.querySelector("#movie_player") as unknown as { getPlayerResponse?: () => Response } | null;
  const response: Response | undefined = player?.getPlayerResponse?.() ?? (window as unknown as { ytInitialPlayerResponse?: Response }).ytInitialPlayerResponse;
  const result: TranscriptResult = {};
  const title = response?.videoDetails?.title, description = response?.videoDetails?.shortDescription;
  if (title) result.title = title;
  if (description) result.description = description;
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const score = (track: Track) => (track.kind === "asr" ? 0 : 10) + (/^zh/i.test(track.languageCode ?? "") ? 2 : /^en/i.test(track.languageCode ?? "") ? 1 : 0);
  const track = [...tracks].sort((a, b) => score(b) - score(a))[0];
  if (track?.baseUrl) {
    try {
      const url = new URL(track.baseUrl, location.href);
      url.searchParams.set("fmt", "json3");
      const reply = await fetch(url, { credentials: "include" });
      const body = reply.ok ? await reply.text() : "";
      if (body.trim()) {
        result.json3 = body;
        if (track.languageCode) result.lang = track.languageCode;
        if (track.kind === "asr") result.auto = true;
        return result;
      }
    } catch { /* 改读字幕面板 */ }
  }
  const segments = [...document.querySelectorAll("ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer yt-formatted-string")]
    .map(node => node.textContent ?? "").filter(text => text.trim());
  if (segments.length) result.segments = segments;
  return result;
}

/**
 * B 站（MAIN world）：用页面里的 aid / cid 查字幕列表，再下载字幕文件。需要登录才有的字幕，用的是你在页面里的登录状态。
 * 优先中文、人工字幕。
 */
export async function bilibiliTranscript(): Promise<TranscriptResult> {
  type State = { aid?: number; cid?: number; p?: number; videoData?: { aid?: number; cid?: number; title?: string; desc?: string; pages?: Array<{ cid?: number }> } };
  const state = (window as unknown as { __INITIAL_STATE__?: State }).__INITIAL_STATE__;
  const video = state?.videoData;
  const result: TranscriptResult = {};
  if (video?.title) result.title = video.title;
  if (video?.desc) result.description = video.desc;
  const aid = state?.aid ?? video?.aid;
  const page = Math.max(1, Number(new URLSearchParams(location.search).get("p")) || state?.p || 1);
  const cid = video?.pages?.[page - 1]?.cid ?? state?.cid ?? video?.cid;
  if (!aid || !cid) return result;
  type Subtitle = { lan?: string; subtitle_url?: string; ai_type?: number };
  let subtitles: Subtitle[] = [];
  for (const endpoint of ["https://api.bilibili.com/x/player/wbi/v2", "https://api.bilibili.com/x/player/v2"]) {
    try {
      const reply = await fetch(`${endpoint}?aid=${aid}&cid=${cid}`, { credentials: "include" });
      const data = await reply.json() as { data?: { subtitle?: { subtitles?: Subtitle[] } } };
      subtitles = data.data?.subtitle?.subtitles ?? [];
      if (subtitles.some(item => item.subtitle_url)) break;
    } catch { /* 试下一个接口 */ }
  }
  const score = (item: Subtitle) => (/^ai-/i.test(item.lan ?? "") || item.ai_type ? 0 : 10) + (/zh/i.test(item.lan ?? "") ? 2 : 0);
  const pick = [...subtitles].filter(item => item.subtitle_url).sort((a, b) => score(b) - score(a))[0];
  if (!pick?.subtitle_url) return result;
  try {
    const reply = await fetch(pick.subtitle_url.startsWith("//") ? `https:${pick.subtitle_url}` : pick.subtitle_url);
    const body = reply.ok ? await reply.text() : "";
    if (body.trim()) {
      result.bilibili = body;
      if (pick.lan) result.lang = pick.lan.replace(/^ai-/i, "");
      if (/^ai-/i.test(pick.lan ?? "") || pick.ai_type) result.auto = true;
    }
  } catch { /* 没有字幕 */ }
  return result;
}
