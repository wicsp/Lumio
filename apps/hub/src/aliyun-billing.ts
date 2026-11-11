import { createHmac, randomUUID } from "node:crypto";
import { AliyunBalanceSnapshot, type AliyunBillingCredentials } from "@lumio/schema";

const ENDPOINTS = {
  china: "https://business.aliyuncs.com/",
  international: "https://business.ap-southeast-1.aliyuncs.com/",
} as const;

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function aliyunBalanceUrl(credentials: AliyunBillingCredentials, time: Date, nonce = randomUUID()): string {
  const parameters = {
    AccessKeyId: credentials.access_key_id,
    Action: "QueryAccountBalance",
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: nonce,
    SignatureVersion: "1.0",
    Timestamp: time.toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-12-14",
  };
  const query = Object.entries(parameters).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([key, value]) => `${key}=${encode(value)}`).join("&");
  // BSS RPC signs the method, root path and RFC 3986 encoded canonical query.
  const signature = createHmac("sha1", `${credentials.access_key_secret}&`)
    .update(`GET&%2F&${encode(query)}`).digest("base64");
  return `${ENDPOINTS[credentials.site]}?${query}&Signature=${encode(signature)}`;
}

const CREDENTIAL_ERRORS = new Set([
  "NotAuthorized", "NoPermission", "Forbidden", "Forbidden.RAM", "Forbidden.RiskControl",
  "InvalidAccessKeyId.NotFound", "InvalidAccessKeyId.Inactive", "SignatureDoesNotMatch",
]);

export function aliyunBalanceResult(input: unknown, time: Date) {
  const response = input as { Code?: unknown; Success?: unknown; Data?: Record<string, unknown> } | null;
  if (typeof response?.Code === "string" && CREDENTIAL_ERRORS.has(response.Code))
    return { status: "credentials" } as const;
  if (response?.Success !== true || response.Code !== "200") return { status: "error" } as const;
  const parsed = AliyunBalanceSnapshot.safeParse({
    source: "aliyun-billing", sampled_at: time.toISOString(), currency: response.Data?.Currency,
    cash_balance: response.Data?.AvailableCashAmount, available_amount: response.Data?.AvailableAmount,
  });
  return parsed.success ? { status: "ready", snapshot: parsed.data } as const : { status: "error" } as const;
}
