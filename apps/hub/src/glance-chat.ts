import type { AssistantContext } from "@lumio/assistant";
import { CaptureGlanceToolArgs, CaptureGlanceToolResult, toolName, type Glance } from "@lumio/schema";
import { windowText } from "./glances.ts";
import type { Inbox } from "./inbox.ts";
import { HubError } from "./errors.ts";

function clip(value: string | undefined, size: number): string | undefined {
  if (value === undefined || Buffer.byteLength(value) <= size) return value;
  const bytes = Buffer.from(value);
  while ((bytes[size]! & 0xc0) === 0x80) size--;
  return bytes.subarray(0, size).toString("utf8") + "\n[…truncated]";
}

export function glanceChat(glance: Glance, message: string, inbox: Inbox): ReturnType<NonNullable<AssistantContext["glance"]>["context"]> {
  if (glance.lumio) return { focus: { selected: [glance.lumio], primary: glance.lumio, section: glance.lumio.module } };
  const data = {
    captured: glance.captured,
    app: glance.app,
    window: glance.window_title,
    url: glance.url,
    pointing: glance.pointing.method,
    selection: clip(glance.selection_text, 2500),
    pointed_paragraph: clip(glance.pointing.text, 5500),
    window_text: clip(windowText(glance), 4000),
  };
  return {
    data,
    tool: {
      spec: { name: toolName("capture.glance"), description: "Save the screen capture attached to this message when the person asks to save it.",
        input_schema: CaptureGlanceToolArgs.toJSONSchema({ io: "input" }) },
      effect: "write",
      async execute(raw, context) {
        if (context.owner !== glance.owner || glance.used_by.message !== message) {
          throw new HubError("FORBIDDEN", { key: "server.request_not_authorized", args: [] });
        }
        const args = CaptureGlanceToolArgs.safeParse(raw);
        if (!args.success) throw new HubError("INVALID", { key: "glance.invalid", args: [] });
        context.signal?.throwIfAborted();
        return CaptureGlanceToolResult.parse(await inbox.captureGlance(context.owner, glance.id, message, context.request, args.data));
      },
    },
  };
}
