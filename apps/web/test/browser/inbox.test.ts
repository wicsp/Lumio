import { describe, expect, test } from "bun:test";
import { WorkbenchView } from "../../src/client/views/workbench.ts";
import { Capture, CaptureCreate } from "@lumio/schema";
import { captureInput, collectionCaptures, sharedCapture } from "../../src/client/panes/inbox.ts";

describe("inbox capture input (I1-5)", () => {
  test("a lone URL is saved as a link, anything else as pasted text", () => {
    const link = captureInput("  https://example.com/post?a=1  ", "web")!;
    expect(link.url).toBe("https://example.com/post?a=1");
    expect(link.content).toBeUndefined();
    const text = captureInput("Some notes\nhttps://example.com", "web")!;
    expect(text.url).toBeUndefined();
    expect(text.content).toEqual({ format: "text", body: "Some notes\nhttps://example.com" });
    expect(captureInput("   ", "web")).toBeUndefined();
    for (const value of [link, text]) expect(CaptureCreate.safeParse(value).success).toBe(true);
  });

  test("shared links and text become one capture", () => {
    expect(sharedCapture(new URLSearchParams("url=https://a.example/x&title=T"))).toEqual({ url: "https://a.example/x", title: "T" });
    // Many apps put the link in text.
    expect(sharedCapture(new URLSearchParams("text=https://a.example/x"))).toEqual({ url: "https://a.example/x" });
    expect(sharedCapture(new URLSearchParams("text=Look at this https://a.example/x&title=T"))).toEqual({ url: "https://a.example/x", title: "T" });
    expect(sharedCapture(new URLSearchParams(`text=${"long text ".repeat(40)}`))?.text).toBeDefined();
    expect(sharedCapture(new URLSearchParams("foo=bar"))).toBeUndefined();
  });

});


test("collection keeps every reading state, removes discarded items and sorts failures before newer captures", () => {
  const item = (index: number, patch: Record<string, unknown> = {}) => Capture.parse({
    id: `cap_${String(index).padStart(26, "0")}`, owner: "act_00000000000000000000000001", channel: "web", revision: 1,
    created: `2026-11-${String(index).padStart(2, "0")}T00:00:00Z`, updated: "2026-11-12T00:00:00Z", attempt: 1,
    state: "ready", card: "none", ...patch,
  });
  const values = [item(1, { state: "failed" }), item(2, { triage: "read" }), item(3, { triage: "reference" }), item(4, { triage: "discard" }), item(5)];
  expect(collectionCaptures(values).map(c => c.id)).toEqual([values[0]!.id, values[4]!.id, values[2]!.id, values[1]!.id]);
  expect(values).toHaveLength(5);
});


test("the collection does not request or show a triage badge", async () => {
  let calls = 0;
  const badge = () => ({ textContent: "stale", classList: { toggle() {} } });
  const counts = new Map(["work", "inbox", "approvals", "execution", "overview"].map(key => [key, badge()]));
  const view = Object.assign(Object.create(WorkbenchView.prototype), {
    counts, applyNotices() {}, session: { hub: { attention: async () => [] }, client: {
      workTasks: async () => [], proposals: async () => [], jobs: async () => [], notices: async () => ({ notices: [] }),
      captures: async () => { calls++; return { captures: [], total: 9 }; },
    } },
  }) as { refreshCounts(): Promise<void> };
  await view.refreshCounts();
  expect(calls).toBe(0);
  expect(counts.get("inbox")!.textContent).toBe("");
});
