import { z } from "zod";

export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const small = z.string().min(1).max(256);
const secret = z.string().min(1).max(4096).regex(/^[^\r\n]+$/);
const options = z.record(z.string().min(1).max(100), secret).refine(values => Object.keys(values).length <= 24);

function https(value: string): URL | undefined {
  if (!/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.hash && /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)) return url;
  } catch { /* invalid URL */ }
}

const imageUrl = z.string().max(4096).refine(value => Boolean(https(value)), "Expected an HTTPS URL");
const baseUrl = imageUrl.refine(value => !value.includes("?"), "Expected an HTTPS URL without a query");
const origin = baseUrl.refine(value => https(value)?.pathname === "/", "Expected an HTTPS origin");
const origins = z.array(origin).max(24);
const prefix = z.string().max(512).refine(value =>
  value.split("/").every(part => part !== "." && part !== ".." && !/[\x00-\x1f\\]/.test(part)));
const field = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const endpoint = baseUrl.refine(value =>
  !value.includes("{key}") || (https(value)?.pathname.includes("%7Bkey%7D") || https(value)?.pathname.includes("{key}")));
const jsonPath = z.array(z.union([small, z.number().int().min(0).max(1000)])).min(1).max(12);
const destination = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("s3"),
    label: small,
    endpoint: baseUrl.optional(),
    region: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    bucket: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    virtual_hosted: z.boolean(),
    prefix,
    public_base: baseUrl,
  }),
  z.strictObject({
    kind: z.literal("http"),
    label: small,
    endpoint,
    method: z.enum(["POST", "PUT"]),
    file_field: field.optional(),
    prefix,
    response_path: jsonPath.optional(),
    public_base: baseUrl,
  }),
  z.strictObject({
    kind: z.literal("github"),
    label: small,
    repository: z.string().regex(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/).max(256),
    branch: small,
    prefix,
    public_base: baseUrl,
  }),
]);
export type ImageHostingDestination = z.infer<typeof destination>;

const credentials = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("s3"), access_key_id: secret, secret_access_key: secret }),
  z.strictObject({ kind: z.literal("http"), headers: options.optional(), fields: options.optional(), query: options.optional() }),
  z.strictObject({ kind: z.literal("github"), token: secret }),
]);
const shared = {
  preview_origins: origins,
  destination: destination.nullable(),
};

export const ImageHostingSettings = z.strictObject({ ...shared, revision: version, credentials_saved: z.boolean() });
export type ImageHostingSettings = z.infer<typeof ImageHostingSettings>;
export const ImageHostingUpdate = z.strictObject({
  ...shared,
  expected_revision: version,
  credentials: credentials.nullable().optional(),
});
export type ImageHostingUpdate = z.infer<typeof ImageHostingUpdate>;

/** Private installation configuration. Never return or log it. */
export const ImageHostingRecord = z.strictObject({ ...shared, revision: version, credentials: credentials.nullable() });
export type ImageHostingRecord = z.infer<typeof ImageHostingRecord>;

export const ImageUploadResult = z.strictObject({
  url: imageUrl,
  media_type: z.enum(IMAGE_UPLOAD_TYPES),
  size: z.number().int().min(1).max(IMAGE_UPLOAD_MAX_BYTES),
});
export type ImageUploadResult = z.infer<typeof ImageUploadResult>;
