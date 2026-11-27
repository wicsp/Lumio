import { expect, mock, test } from "bun:test";
import { ImageHostingSettings } from "@lumio/schema";
import { NoteImages } from "../../src/client/note-images.ts";

test("image paste reveals setup on demand and works after enabling hosting", async () => {
  let hosting = ImageHostingSettings.parse({ revision: 1, destination: null, preview_origins: [], credentials_saved: false });
  const settings = { hidden: true };
  const status = { textContent: "" };
  const add = mock(() => {});
  const image = new File(["synthetic PNG"], "sample.png", { type: "image/png" });
  const controls = Object.assign(Object.create(NoteImages.prototype), {
    upload: { settings: async () => hosting, queue: { add } }, settings, status, enabled: false, disposed: false, settingsRequest: 0,
    editor: () => ({ state: { readOnly: false, doc: { lineAt: () => ({ from: 0, to: 12 }) } } }),
  }) as { refreshSettings(): Promise<void>; start(files: File[], position: number): boolean };

  await controls.refreshSettings();
  expect(settings.hidden).toBe(true);
  expect(controls.start([image], 4)).toBe(false);
  expect(settings.hidden).toBe(false);
  expect(add).not.toHaveBeenCalled();

  hosting = ImageHostingSettings.parse({
    revision: 2, credentials_saved: true, preview_origins: ["https://images.example.test"],
    destination: { kind: "s3", label: "Cloudflare R2", region: "auto", bucket: "synthetic-bucket",
      virtual_hosted: false, prefix: "notes", public_base: "https://images.example.test" },
  });
  await controls.refreshSettings();
  expect(settings.hidden).toBe(true);
  expect(status.textContent).toBe("");
  expect(controls.start([image], 4)).toBe(true);
  expect(add).toHaveBeenCalledWith([image], 12);
});
