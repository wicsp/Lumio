import { ImageHostingUpdate, type ImageHostingDestination, type ImageHostingSettings } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { clear, failure, h, loading } from "./dom.ts";
import { t } from "./i18n.ts";

type Kind = ImageHostingDestination["kind"];
type Preset = {
  name: string;
  kind: Kind;
  endpoint?: string;
  publicBase?: string;
  region?: string;
  virtualHosted?: boolean;
  raw?: boolean;
  file?: string;
  path?: (string | number)[];
  query?: Record<string, string>;
  headers?: string;
};

const presets: Preset[] = [
  { name: "Cloudflare R2", kind: "s3", endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com", region: "auto" },
  { name: "AWS S3", kind: "s3", region: "us-east-1", virtualHosted: true },
  { name: "MinIO", kind: "s3", region: "us-east-1" },
  { name: "Backblaze B2", kind: "s3", endpoint: "https://s3.REGION.backblazeb2.com" },
  { name: "DigitalOcean Spaces", kind: "s3", endpoint: "https://REGION.digitaloceanspaces.com", virtualHosted: true },
  { name: "Alibaba Cloud OSS", kind: "s3", endpoint: "https://s3.oss-REGION.aliyuncs.com", virtualHosted: true },
  { name: "Tencent COS", kind: "s3", endpoint: "https://cos.REGION.myqcloud.com", virtualHosted: true },
  { name: "Qiniu Kodo", kind: "s3", endpoint: "https://s3.REGION.qiniucs.com" },
  { name: "S3 compatible", kind: "s3" },
  { name: "GitHub", kind: "github" },
  { name: "Lsky Pro", kind: "http", endpoint: "https://images.example.com/api/v1/upload", file: "file", path: ["data", "links", "url"] },
  { name: "S.EE", kind: "http", endpoint: "https://s.ee/api/v1/file/upload", publicBase: "https://i.see.you", file: "file", path: ["data", "url"], headers: '{"Authorization":"API_KEY"}' },
  { name: "Imgur", kind: "http", endpoint: "https://api.imgur.com/3/image", publicBase: "https://i.imgur.com", file: "image", path: ["data", "link"], headers: '{"Authorization":"Client-ID CLIENT_ID"}' },
  { name: "Cloudflare Images", kind: "http", endpoint: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/images/v1", publicBase: "https://imagedelivery.net", file: "file", path: ["result", "variants", 0] },
  { name: "CloudFlare ImgBed", kind: "http", endpoint: "https://images.example.com/upload", file: "file", path: ["src"], query: { responseFormat: "object", returnFormat: "full" } },
  { name: "WebDAV", kind: "http", endpoint: "https://files.example.com/uploads/{key}", raw: true },
  { name: "Custom HTTP", kind: "http", file: "file" },
];

function entry(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input,
    hint ? h("span", { class: "field-hint" }, hint) : undefined);
}

function optionalObject(value: string): Record<string, string> | undefined {
  return value.trim() ? JSON.parse(value) as Record<string, string> : undefined;
}

export function imageHostingSettings(client: Pick<Client, "imageHostingSettings" | "saveImageHosting">) {
  const element = h("div");
  let active = true;
  async function load() {
    clear(element, loading());
    try {
      const settings = await client.imageHostingSettings();
      if (active) render(settings);
    } catch (cause) {
      if (active) clear(element, failure(errorText(cause), () => void load()));
    }
  }

  function render(settings: ImageHostingSettings, saved = false, needsReload = false) {
    const destination = settings.destination;
    const current = destination ? presets.find(preset => preset.name === destination.label && preset.kind === destination.kind)
      ?? presets.find(preset => preset.kind === destination.kind && ["S3 compatible", "GitHub", "Custom HTTP"].includes(preset.name)) : undefined;
    const provider = h("select", {}, h("option", { value: "" }, t("Uploads disabled")),
      ...presets.map(preset => h("option", { value: preset.name, selected: preset === current },
        preset.name === "S3 compatible" ? t("S3 compatible") : preset.name === "Custom HTTP" ? t("Custom HTTP") : preset.name)));
    const origins = h("textarea", { rows: "2", maxlength: "8192", spellcheck: "false", placeholder: "https://images.example.com" }, settings.preview_origins.join("\n"));
    const fields = h("div", { class: "form-stack" });
    const error = h("div", { role: "alert" });
    const status = h("div", { class: "field-hint", role: "status" });
    if (saved) status.textContent = t("Image hosting settings saved.");
    if (needsReload) status.append(" ", h("button", { type: "button", class: "btn btn-small", onclick: () => location.reload() }, t("Reload to apply image previews")));
    const save = h("button", { type: "submit", class: "btn btn-small" }, t("Save"));
    const form = h("form", { class: "set-form-wrap form-stack", autocomplete: "off" },
      entry(t("Upload destination"), provider), fields,
      entry(t("Image preview domains · one HTTPS origin per line"), origins),
      h("div", {}, save), status, error);
    let read: () => Pick<ImageHostingUpdate, "destination" | "credentials"> = () => ({ destination: null });
    function showFields(existing?: ImageHostingDestination) {
      clear(fields);
      read = () => ({ destination: null });
      error.textContent = "";
      const preset = presets.find(item => item.name === provider.value);
      if (!preset) return;
      const kind = preset.kind;
      const text = (value = "", placeholder = "", required = false, max = 2048) =>
        h("input", { type: "text", value, placeholder, required, maxlength: max, spellcheck: "false", autocomplete: "off" });
      const secret = (placeholder = "") => h("input", { type: "password", placeholder, autocomplete: "new-password", maxlength: 4096 });
      const publicBase = text(existing?.public_base ?? preset.publicBase ?? "", "https://images.example.com", true);
      const prefix = text(existing?.prefix ?? (kind === "http" ? "" : "lumio"), "lumio");
      const label = existing?.label ?? preset.name;
      const base = () => ({ label, public_base: publicBase.value.trim(), prefix: prefix.value.trim() });
      const credentialsHint = settings.credentials_saved && existing ? t("Credentials saved. Leave blank to keep them for this destination.") : undefined;
      fields.append(entry(t("Public HTTPS URL prefix"), publicBase));
      if (kind === "s3") {
        const old = existing?.kind === "s3" ? existing : undefined;
        const endpoint = text(old?.endpoint ?? "", preset.endpoint ?? "https://s3.example.com", preset.name !== "AWS S3");
        const region = text(old?.region ?? preset.region ?? "", "us-east-1", true);
        const bucket = text(old?.bucket ?? "", "", true);
        const virtual = h("input", { type: "checkbox", checked: old?.virtual_hosted ?? !!preset.virtualHosted });
        const keyId = secret(), secretKey = secret();
        fields.append(entry(t("S3 endpoint"), endpoint), h("div", { class: "image-hosting-fields" }, entry(t("Region"), region), entry(t("Bucket"), bucket)),
          h("label", { class: "field-inline" }, virtual, t("Put the bucket name in the upload hostname")),
          entry(t("Object path prefix"), prefix), h("div", { class: "image-hosting-fields" }, entry(t("Access key ID"), keyId, credentialsHint), entry(t("Secret access key"), secretKey)));
        read = () => ({
          destination: { kind, ...base(), endpoint: endpoint.value.trim() || undefined, region: region.value.trim(), bucket: bucket.value.trim(), virtual_hosted: virtual.checked },
          credentials: keyId.value || secretKey.value ? { kind, access_key_id: keyId.value, secret_access_key: secretKey.value } : undefined,
        });
        return;
      }
      if (kind === "github") {
        const old = existing?.kind === "github" ? existing : undefined;
        const repo = text(old?.repository ?? "", "owner/repository", true);
        const branch = text(old?.branch ?? "main", "", true);
        const token = secret();
        fields.append(entry(t("Repository"), repo), entry(t("Branch"), branch), entry(t("Object path prefix"), prefix),
          entry(t("Access token"), token, credentialsHint));
        publicBase.placeholder = "https://raw.githubusercontent.com/OWNER/REPO/BRANCH";
        read = () => ({
          destination: { kind, ...base(), repository: repo.value.trim(), branch: branch.value.trim() },
          credentials: token.value ? { kind, token: token.value } : undefined,
        });
        return;
      }
      const old = existing?.kind === "http" ? existing : undefined;
      const endpoint = text(old?.endpoint ?? "", preset.endpoint ?? "https://images.example.com/upload", true);
      if (!old && preset.endpoint && !/images\.example\.com|files\.example\.com|ACCOUNT_ID/.test(preset.endpoint)) endpoint.value = preset.endpoint;
      const method = h("select", {}, ...["POST", "PUT"].map(option =>
        h("option", { value: option, selected: option === (old?.method ?? (preset.raw ? "PUT" : "POST")) }, option)));
      const field = text(old ? old.file_field ?? "" : preset.file ?? "", t("Raw image bytes"));
      const responsePath = text(old?.response_path ? JSON.stringify(old.response_path) : old || !preset.path ? "" : JSON.stringify(preset.path), '["data","url"]');
      const headers = secret(preset.headers ?? '{"Authorization":"Bearer TOKEN"}');
      const bodyFields = secret('{"album":"123"}');
      const query = secret(preset.query ? JSON.stringify(preset.query) : '{"key":"VALUE"}');
      const clearCredentials = h("input", { type: "checkbox" });
      fields.append(entry(t("Upload endpoint"), endpoint, t("For raw PUT uploads, use {key} in the path for the generated object key.")),
        entry(t("HTTP method"), method), entry(t("Multipart file field"), field),
        entry(t("Object path prefix"), prefix), entry(t("JSON path to the image URL"), responsePath),
        h("details", {}, h("summary", {}, t("Headers, form fields and query parameters")),
          h("div", { class: "form-stack" }, entry(t("Headers as JSON"), headers, credentialsHint),
            entry(t("Extra form fields as JSON"), bodyFields), entry(t("Query parameters as JSON"), query),
            credentialsHint ? h("label", { class: "field-inline" }, clearCredentials, t("Clear saved HTTP parameters")) : undefined)));
      read = () => {
        const hasValues = headers.value.trim() || bodyFields.value.trim() || query.value.trim();
        return {
          destination: {
            kind, ...base(), endpoint: endpoint.value.trim(), method: method.value === "PUT" ? "PUT" : "POST",
            file_field: field.value.trim() || undefined,
            response_path: responsePath.value.trim() ? JSON.parse(responsePath.value) : undefined,
          },
          credentials: clearCredentials.checked ? null : hasValues || (!old && preset.query) ? {
            kind, headers: optionalObject(headers.value), fields: optionalObject(bodyFields.value),
            query: optionalObject(query.value) ?? (!old ? preset.query : undefined),
          } : undefined,
        };
      };
    }
    showFields(destination ?? undefined);
    provider.addEventListener("change", () => showFields());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (save.disabled || !active) return;
      error.textContent = "";
      let input: ImageHostingUpdate;
      try {
        const update = read();
        const previewOrigins = origins.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (update.destination) previewOrigins.push(new URL(update.destination.public_base).origin);
        input = ImageHostingUpdate.parse({ ...update, expected_revision: settings.revision, preview_origins: [...new Set(previewOrigins)] });
      } catch {
        error.textContent = t("Check the image hosting fields and JSON syntax.");
        return;
      }
      save.disabled = true;
      try {
        const updated = await client.saveImageHosting(input);
        if (!active) return;
        const pageOrigins = document.querySelector<HTMLMetaElement>('meta[name="lumio-image-origins"]')?.content.split(" ").filter(Boolean) ?? [];
        const refresh = pageOrigins.length !== updated.preview_origins.length || updated.preview_origins.some(origin => !pageOrigins.includes(origin));
        render(updated, true, refresh);
      } catch (cause) {
        if (active) error.replaceChildren(failure(errorText(cause), () => void load()));
      } finally { save.disabled = false; }
    });
    clear(element, form);
  }

  void load();
  return { element, dispose() { active = false; } };
}
