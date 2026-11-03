import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as cli from "../apps/cli/src/messages.ts";
import * as hub from "../apps/hub/src/messages.ts";
import * as runtime from "../apps/runtime/src/messages.ts";

const root = new URL("../", import.meta.url).pathname;
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path, entry.name)) : entry.name.endsWith(".ts") ? [join(path, entry.name)] : []);
}
for (const [name, messages] of Object.entries({ cli, hub, runtime })) {
  test(`${name} message tables have identical keys, value types and parameter counts`, () => {
    expect(Object.keys(messages.zh).sort()).toEqual(Object.keys(messages.en).sort());
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      const en = messages.en[key], zh = messages.zh[key];
      expect(typeof zh, key).toBe(typeof en);
      if (typeof en === "function" && typeof zh === "function") expect(zh.length, key).toBe(en.length);
    }
  });
}
test("application and library source has no Chinese literals outside app message tables", () => {
  const paths = [...["apps/cli/src", "apps/hub/src", "apps/runtime/src", "packages"].flatMap(path => files(join(root, path))), join(root, "scripts/web-demo.ts")]
    .filter(path => !path.includes("/test/") && !path.includes("/schema/") && !path.endsWith("/messages.ts"));
  // api-client is intentionally frozen in this slice except for its optional request header.
  // Its pre-existing fallback strings remain unchanged; apps localize these at their boundary.
  const violations: string[] = [];
  for (const path of paths.filter(path => !path.includes("/api-client/"))) {
    const source = readFileSync(path, "utf8"), tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\p{Script=Han}/u.test(node.text)) {
        violations.push(`${path.slice(root.length)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  expect(violations).toEqual([]);
});
test("every application message reference exists and has the expected argument count", () => {
  for (const [name, messages] of Object.entries({ cli, hub, runtime })) {
    const table = messages.en as Record<string, string | ((...args: unknown[]) => string)>;
    const paths = [...files(join(root, `apps/${name}/src`)), ...files(join(root, "packages"))]
      .filter(path => !path.includes("/test/") && !path.includes("/schema/") && !path.endsWith("/messages.ts"));
    const violations: string[] = [];
    for (const path of paths) {
      const tree = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      function check(key: string, count: number) {
        const value = table[key];
        if (value === undefined || (typeof value === "function" ? value.length : 0) !== count) violations.push(`${path.slice(root.length)}: ${key} (${count})`);
      }
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.getText(tree).match(/^(?:this\.)?msg$/) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text, node.arguments.length - 1);
        if (ts.isObjectLiteralExpression(node)) {
          const key = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(tree) === "key");
          const args = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(tree) === "args");
          if (key && args && ts.isStringLiteral(key.initializer) && ts.isArrayLiteralExpression(args.initializer)) check(key.initializer.text, args.initializer.elements.length);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
    expect(violations).toEqual([]);
  }
});

test("api-client language is optional and covers JSON, artifact and streaming requests", async () => {
  const { createClient } = await import("../packages/api-client/src/index.ts");
  for (const language of [undefined, "en", "zh-CN"]) {
    const seen: Array<{ path: string; language: string | null }> = [];
    const fetcher = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      seen.push({ path, language: new Headers(init?.headers).get("Accept-Language") });
      if (path.endsWith("/content")) return new Response("synthetic artifact");
      if (path.endsWith("/chat")) return new Response(JSON.stringify({ type: "error", turn: "turn_00000000000000000000000001", error: "synthetic failure" }) + "\n");
      return Response.json([]);
    }, { preconnect: fetch.preconnect });
    const client = createClient({ url: "https://synthetic.invalid", token: "synthetic-token", language, fetch: fetcher });
    expect(await client.actors()).toEqual([]);
    expect(await (await client.artifactContent("art_00000000000000000000000001")).text()).toBe("synthetic artifact");
    for await (const event of client.assistantEvents({ request_id: "synthetic-language", message: "test" })) expect(event).toMatchObject({ type: "error" });
    expect(seen).toHaveLength(3);
    expect(seen.map(item => item.language)).toEqual(Array(3).fill(language ?? null));
  }
});

test("installer prompts follow LC_ALL before LANG without invoking installation", async () => {
  for (const [env, expected] of [
    [{ LANG: "en_US.UTF-8" }, "Lumio installation failed: Usage:"],
    [{ LANG: "zh_CN.UTF-8" }, "Lumio 安装失败：用法："],
    [{ LANG: "zh_CN.UTF-8", LC_ALL: "en_US.UTF-8" }, "Lumio installation failed: Usage:"],
    [{ LANG: "en_US.UTF-8", LC_ALL: "zh_CN.UTF-8" }, "Lumio 安装失败：用法："],
  ] as const) {
    const child = Bun.spawn(["/bin/sh", join(root, "install.sh"), "--invalid-flag"], { env, stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1); expect(error).toContain(expected);
  }
});
