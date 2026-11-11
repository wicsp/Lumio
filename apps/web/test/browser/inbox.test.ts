import { describe, expect, test } from "bun:test";
import { CaptureCreate } from "@lumio/schema";
import { captureInput, sharedCapture } from "../../src/client/panes/inbox.ts";

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
