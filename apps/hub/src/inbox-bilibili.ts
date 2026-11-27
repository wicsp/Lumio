import { CAPTURE_LIMITS, type Capture, type CaptureContent } from "@lumio/schema";
import type { SqliteArtifacts } from "@lumio/storage";
import type { HubConfig } from "./config.ts";
import { CaptureFailure, fetchCapture, type CaptureNetwork } from "./inbox-fetch.ts";
import type { Extracted } from "./inbox-extract.ts";
import { Jobs } from "./jobs.ts";
import { bilibiliExtensionText, text as msg } from "./messages.ts";
import type { HubStore } from "./store.ts";

const videoPath = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]{1,20})\/?$/;
const timeoutSeconds = 7200;
const archiveWaitMs = 10 * 60_000;
const maxArchiveBytes = 4 * CAPTURE_LIMITS.max_content_chars;

// The installed extension sends its description with this exact marker when it finds no track.
export function bilibiliDescription(content?: CaptureContent): string | undefined {
  if (content?.format !== "markdown") return;
  const { missing: marker, descriptionPrefix } = bilibiliExtensionText;
  if (content.body === marker) return "";
  if (content.body.startsWith(descriptionPrefix) && content.body.endsWith(`\n\n${marker}`)) {
    return content.body.slice(0, -marker.length).trimEnd();
  }
}

function bilibiliVideoUrl(url: URL): string | undefined {
  if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) return;
  if (!["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(url.hostname)) return;
  const id = videoPath.exec(url.pathname)?.[1];
  const part = url.searchParams.get("p");
  if (id && (part === null || /^[1-9][0-9]{0,5}$/.test(part))) {
    return `https://www.bilibili.com/video/${id}${part && part !== "1" ? `?p=${part}` : ""}`;
  }
}

const shortUrl = (url: URL) => url.origin === "https://b23.tv" && !url.username && !url.password && /^\/[a-z\d]{1,32}\/?$/i.test(url.pathname);

export async function bilibiliJobUrl(raw: string, signal: AbortSignal, network: CaptureNetwork) {
  const source = new URL(raw);
  const direct = bilibiliVideoUrl(source);
  if (direct || !shortUrl(source)) return direct;
  // Only follow a b23.tv share to another share or a recognized video URL.
  const resolved = await fetchCapture(`https://b23.tv${source.pathname}`, signal, network,
    undefined, url => shortUrl(url) || !!bilibiliVideoUrl(url));
  return bilibiliVideoUrl(new URL(resolved.url));
}

export function startBilibiliJob(store: HubStore, config: NonNullable<HubConfig["bilibiliTranscription"]>, url: string, now: Date) {
  const runtime = store.runtimes(now).find(value => value.registration.name === config.runtime && value.online);
  if (!runtime) throw new CaptureFailure("runtime_unavailable");
  return new Jobs(store).create({
    runtime: runtime.actor, run: { kind: "command", argv: [config.command, url] }, workdir: "~", timeout_seconds: timeoutSeconds,
  }, now);
}

export async function readBilibiliJob(jobs: Jobs, artifacts: SqliteArtifacts, id: string, capture: Capture, now: Date, description?: string): Promise<Extracted | undefined> {
  const job = jobs.get(id);
  if (job.status === "cancelled" || job.result && job.status !== "done") throw new CaptureFailure("extract_failed");
  if (!job.result) {
    // Queueing and disconnected Runtime time are outside its execution timer.
    if (now.getTime() - Date.parse(job.spec.created) <= 2 * timeoutSeconds * 1000) return;
    jobs.cancel(id);
    throw new CaptureFailure("timeout");
  }
  const archive = artifacts.list({ module: "execution", id }).find(value => value.status === "ready" && value.media_type === "text/plain" && !value.private);
  if (!archive) {
    const deadline = Math.min(Date.parse(job.result.finished), Date.parse(job.spec.created) + 2 * timeoutSeconds * 1000) + archiveWaitMs;
    if (now.getTime() <= deadline) return;
    throw new CaptureFailure("timeout");
  }
  if (archive.size > maxArchiveBytes) throw new CaptureFailure("too_large");
  return readTranscript(await Bun.file(await artifacts.path(archive.id)).text(), capture, description);
}

function readTranscript(raw: string, capture: Capture, description?: string): Extracted {
  const [header, titleJson, ...vtt] = raw.replaceAll("\r\n", "\n").split("\n");
  if (header !== "LUMIO-BILIBILI-TRANSCRIPT 1" || !titleJson || vtt[0] !== "WEBVTT") throw new CaptureFailure("extract_failed");
  const reportedTitle: unknown = JSON.parse(titleJson);
  const title = (typeof reportedTitle === "string" ? reportedTitle.replace(/\s+/g, " ").trim().slice(0, 500).replace(/[\uD800-\uDBFF]$/, "") : "")
    || capture.title || new URL(capture.url!).pathname.split("/").filter(Boolean).at(-1) || "Bilibili";
  const cues: string[] = [];
  for (const block of vtt.join("\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex(line => /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/.test(line));
    if (timeIndex === -1) continue;
    const text = lines.slice(timeIndex + 1).join(" ").trim().replace(/[&<>`*_[\]\\]/g, token => token === "&" ? "&amp;" : token === "<" ? "&lt;" : token === ">" ? "&gt;" : `\\${token}`);
    if (text) cues.push(`**${lines[timeIndex]!.slice(0, 8)}** ${text}`);
  }
  if (!cues.length) throw new CaptureFailure("extract_failed");
  const body = [description, `## ${msg("inbox.bilibili_asr_heading")}\n\n${cues.join("\n\n")}`].filter(Boolean).join("\n\n");
  if (body.length > CAPTURE_LIMITS.max_content_chars) throw new CaptureFailure("too_large");
  return { note: { kind: "video", title, url: capture.url, site: "www.bilibili.com", tags: [] }, body, extractor: "bilibili-asr@1" };
}
