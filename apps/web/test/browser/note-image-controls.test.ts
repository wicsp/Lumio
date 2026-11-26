import { expect, test } from "bun:test";
import { ImageHostingSettings } from "@lumio/schema";
import { NoteImages } from "../../src/client/note-images.ts";

test("the retained editor updates its image action after visiting settings", async () => {
  let hosting = ImageHostingSettings.parse({ revision: 1, destination: null, preview_origins: [], credentials_saved: false });
  const button = { hidden: false, disabled: true };
  const settings = { hidden: true };
  const status = { textContent: "" };
  const controls = Object.assign(Object.create(NoteImages.prototype), {
    upload: { settings: async () => hosting }, button, settings, status, enabled: false, disposed: false, settingsRequest: 0,
  }) as NoteImages;

  await controls.refreshSettings();
  expect(button.hidden).toBe(true);
  expect(settings.hidden).toBe(false);

  hosting = ImageHostingSettings.parse({
    revision: 2, credentials_saved: true, preview_origins: ["https://images.example.test"],
    destination: { kind: "s3", label: "Cloudflare R2", region: "auto", bucket: "synthetic-bucket",
      virtual_hosted: false, prefix: "notes", public_base: "https://images.example.test" },
  });
  await controls.refreshSettings();
  expect(button).toEqual({ hidden: false, disabled: false });
  expect(settings.hidden).toBe(true);
  expect(status.textContent).toBe("");
});
