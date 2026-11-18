import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createClient } from "@lumio/api-client";
import { failureText } from "../src/shared.ts";

const previousChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let language = "en";

beforeEach(() => {
  language = "en";
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { i18n: { getUILanguage: () => language } },
  });
});

afterEach(() => {
  if (previousChrome) Object.defineProperty(globalThis, "chrome", previousChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});

const hub = "https://hub.example.test";
const code = "a".repeat(26);

test("the extension posts to the current anonymous join route and distinguishes pairing rejection from session expiration", async () => {
  const fetcher = mock(async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe(hub + "/v2/setup/client/join");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ code }));
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return Response.json({ error: { code: "UNAUTHENTICATED", message: "Pairing rejected" } }, { status: 401 });
  });
  const error = await createClient({ url: hub, fetch: fetcher as unknown as typeof fetch }).clientJoin(code).catch((error: unknown) => error);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(failureText(error, "pairing")).toContain("Pairing was rejected.");
  expect(failureText(error)).toContain("The connection expired.");
  language = "zh-CN";
  expect(failureText(error, "pairing")).toContain("配对请求被拒绝。");
});

test("pairing distinguishes a missing route, invalid input and a network failure", async () => {
  const fetcher = mock(async () => new Response("proxy 404", { status: 404 }));
  const client = createClient({ url: hub, fetch: fetcher as unknown as typeof fetch });
  const invalid = await Promise.resolve().then(() => client.clientJoin("invalid")).catch((error: unknown) => error);
  expect(fetcher).not.toHaveBeenCalled();
  expect(failureText(invalid, "pairing")).toBe("Enter the pairing code exactly as shown in Lumio.");

  const missing = await client.clientJoin(code).catch((error: unknown) => error);
  expect(failureText(missing, "pairing")).toContain("The Hub did not recognize the pairing request.");

  fetcher.mockRejectedValueOnce(new TypeError("fetch failed"));
  const network = await client.clientJoin(code).catch((error: unknown) => error);
  expect(failureText(network, "pairing")).toBe("Can't reach Lumio. Check that the Hub is running.");
});
