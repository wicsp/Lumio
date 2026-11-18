import { GlanceAssistantReply, type GlanceContextRetention } from "@lumio/schema";

export const captureRetentionInstructions = `
The screen and page focus are candidate context. Being on a page does not mean the speaker is discussing it.
For the final response (no tool calls), return only a JSON object with this shape:
{"reply":"your user-facing answer, or [NOTE_ONLY] when only recording a thought","context":{"text":["exact relevant excerpts"],"image":false,"source":false}}
Choose context in this same response. text may contain up to eight excerpts, each at most 2000 characters. It must contain only verbatim excerpts from the current screen OCR, selection, or pointed paragraph that actually matter to this utterance. Do not summarize, invent, or include unrelated screen details.
Set image true only when the actual image is relevant and worth retaining (for example a photo, chart, or layout). Text-only questions usually need excerpts, not the full screenshot.
Set source true only when the current page, document, app, or URL is genuinely the subject or source of the utterance.
For a self-contained thought unrelated to the screen, use {"text":[],"image":false,"source":false}. Do not attach unrelated task/page information to the idea or quote it in your reply.
`;

export function captureReply(content: string): { content: string; retention?: GlanceContextRetention } {
  const value = content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  try {
    const json: unknown = JSON.parse(value);
    const parsed = GlanceAssistantReply.safeParse(json);
    if (parsed.success) return { content: parsed.data.reply, retention: parsed.data.context };
    if (json && typeof json === "object" && "reply" in json && typeof json.reply === "string") return { content: json.reply };
  } catch { /* Older providers may still produce a plain-text reply. */ }
  // A malformed envelope can contain excerpts. Keep it out of the saved answer.
  return { content: value.startsWith("{") ? "" : content };
}
