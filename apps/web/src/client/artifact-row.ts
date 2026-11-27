import type { StoredArtifact } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { safeFileName, verifyArtifact } from "./commands.ts";
import { h, icon, toast } from "./dom.ts";
import { bytes } from "./format.ts";
import { t } from "./i18n.ts";
import { observeAction } from "./usage-observations.ts";

const artifactFormats = new Map([
  ["text/csv", "csv"], ["application/pdf", "pdf"], ["application/json", "json"],
  ["image/png", "png"], ["image/jpeg", "jpg"], ["text/markdown", "md"],
  ["application/jsonl", "jsonl"], ["application/x-ndjson", "jsonl"], ["text/plain", "txt"],
]);

export function artifactPresentation(file: Pick<StoredArtifact, "key" | "media_type">) {
  const key = safeFileName(file.key);
  const mime = file.media_type.split(";")[0]!.trim().toLowerCase();
  const extension = artifactFormats.get(mime);
  const stem = key.replace(/\.bin$/, "");
  const filename = extension && key.endsWith(".bin") ? stem + "." + extension : key;
  let label = key;
  if (mime.includes("jsonl") || extension === "jsonl") label = t("Run transcript");
  else if (mime === "text/plain") label = t("Run log");
  else if (extension) label = t("{0} file · {1}", extension.toUpperCase(), stem.slice(-6));
  return { label, filename };
}

export function artifactRow(client: Client, file: StoredArtifact, current: () => boolean, includePrivate: boolean): HTMLElement {
  const message = h("span", { role: "status", class: "muted" });
  const { label, filename } = artifactPresentation(file);
  const button = h("button", { type: "button", class: "btn btn-small", disabled: file.status !== "ready", onclick: async () => {
    button.disabled = true; message.textContent = t("Downloading and verifying…");
    try {
      const response = await client.artifactContent(file.id, { includePrivate });
      const data = await response.arrayBuffer();
      if (!current()) return;
      if (!await verifyArtifact(data, file)) throw new Error("FILE_INTEGRITY");
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([data], { type: file.media_type }));
      h("a", { href: url, download: filename }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.textContent = "";
      if (!includePrivate) observeAction(button, "download", "succeeded");
      toast(t("Verified — download started"));
    } catch (cause) {
      message.textContent = cause instanceof Error && cause.message === "FILE_INTEGRITY" ? t("File verification failed; not saved") : errorText(cause);
    } finally { button.disabled = false; }
  } }, icon("download"), t("Download"));
  return h("div", { class: "file" }, icon("file"),
    h("span", { class: "row-main" }, h("span", { class: "row-title" }, label), h("span", { class: "row-sub" }, t("{0}, {1}", file.status === "ready" ? t("Archived") : t("Delivering"), bytes(file.size)))),
    message, button);
}
