import { expect, test } from "bun:test";
import { language, renderMessage } from "../src/language.ts";

test("locale uses the first non-empty override, falling back to English", () => {
  for (const value of ["zh", "zh_CN.UTF-8", "zh-Hans", "zh-CN"]) expect(language({ LANG: value })).toBe("zh");
  for (const value of [undefined, "", "en_US.UTF-8", "C.UTF-8", "fr_FR", "ZH"]) expect(language({ LANG: value })).toBe("en");
  expect(language({ LUMIO_LANG: "en", LC_ALL: "zh", LC_MESSAGES: "zh", LANG: "zh" })).toBe("en");
  expect(language({ LUMIO_LANG: "", LC_ALL: "en", LC_MESSAGES: "zh", LANG: "zh" })).toBe("en");
  expect(language({ LUMIO_LANG: "", LC_ALL: "", LC_MESSAGES: "zh", LANG: "en" })).toBe("zh");
  expect(language({ LUMIO_LANG: "zh", LANG: "en" })).toBe("zh");
});
test("formatting resolves nested message parameters without translating user content", () => {
  const table = { label: "Runtime", failure: (label: unknown, detail: unknown) => `${label}: ${detail}` };
  expect(renderMessage(table, { key: "failure", args: [{ key: "label", args: [] }, "synthetic user content"] })).toBe("Runtime: synthetic user content");
});
