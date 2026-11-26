import { describe, expect, test } from "bun:test";
import { ExecutionRoutineCommandRequest, WorkCommandRequest, type ExecutionRoutine, type WorkTask } from "@lumio/schema";
import { renderMarkdown, safeExternalUrl } from "../src/client/utils/markdown.ts";
import { verifyArtifact, sha256Hex, formatTime, dispatchCommand, routineCreateCommand, routineUpdateCommand, safeFileName, taskDescriptionCommand, workPatchCommand } from "../src/client/commands.ts";
import type { WebAssets } from "../src/build.ts";
import { WEB_CSP, webFiles } from "../src/page.ts";

describe("markdown", () => {
  test("escapes raw HTML", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });
  test("drops unsafe link schemes", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "JaVaScRiPt:1", "vbscript:x"]) {
      const html = renderMarkdown(`[x](${url})`);
      expect(html).not.toContain("href=\"" + url);
      expect(html).not.toMatch(/href="(javascript|data|vbscript)/i);
    }
    expect(safeExternalUrl("https://user:pw@example.com")).toBeUndefined();
  });
  test("external http(s) links are safe", () => {
    expect(renderMarkdown("[a](https://example.com/?q=\"x\")")).toContain('rel="noopener noreferrer nofollow"');
  });
  test("images are not fetched", () => expect(renderMarkdown("![p](https://example.com/a.png)")).not.toContain("<img"));
  test("wikilinks and .md links navigate in app", () => {
    const html = renderMarkdown("[[He_2020_LightGCN#Intro|论文]] and [b](../ideas/b.md)");
    expect(html).toContain('data-note="He_2020_LightGCN"');
    expect(html).toContain('data-note="../ideas/b.md"');
    expect(html).not.toContain('href="../');
  });
  test("attribute injection via wikilink is escaped", () => expect(renderMarkdown('[[a" onclick="x]]')).not.toContain('onclick="x"'));
  test("code blocks are escaped", () => expect(renderMarkdown("```\n<b>[[x]]</b>\n```")).toContain("&lt;b&gt;[[x]]&lt;/b&gt;"));
});

const task: WorkTask = { schema_version: 3, type: "task", created_by: "act_00000000000000000000000001", updated_by: "act_00000000000000000000000001", id: "task_01JABCDEFGHJKMNPQRSTVWXYZ0", title: "T", description: "old", revision: 3, outcome: "open", turn: { holder: "human", reason: "todo", since: "2026-11-01T00:00:00Z" }, created: "2026-11-01T00:00:00+08:00", updated: "2026-11-01T00:00:00+08:00", tags: [], dependencies: [], references: [] };

describe("work commands", () => {
  test("structural patch excludes description and carries revision", () => {
    const cmd = workPatchCommand(task, { title: "T2", project: null })!;
    expect(WorkCommandRequest.safeParse(cmd).success).toBe(true);
    const args = (cmd.operation as { args: { expected_revision: number; patch: Record<string, unknown> } }).args;
    expect(args.expected_revision).toBe(3);
    expect(args.patch).toEqual({ title: "T2" });
    expect(cmd.operation.op).toBe("work.task.update");
  });
  test("description patch is alone and schema-valid", () => {
    const cmd = taskDescriptionCommand(task, "new body")!;
    expect(WorkCommandRequest.safeParse(cmd).success).toBe(true);
    expect((cmd.operation as { args: { patch: object } }).args.patch).toEqual({ description: "new body" });
    expect(taskDescriptionCommand(task, "old")).toBeUndefined();
  });
  test("no-op structural edit returns undefined", () => expect(workPatchCommand(task, { title: "T", project: null })).toBeUndefined());
  test("dispatch is explicit with target and revision", () => {
    const cmd = dispatchCommand(task, "codex@mac");
    expect(WorkCommandRequest.safeParse(cmd).success).toBe(true);
    expect(cmd.operation).toEqual({ op: "work.task.dispatch", args: { task: task.id, to: "codex@mac", expected_revision: 3 } });
  });
  test("request ids are unique and valid", () => {
    const a = dispatchCommand(task, "pi").request_id, b = dispatchCommand(task, "pi").request_id;
    expect(a).not.toBe(b);
  });
});

describe("routine commands", () => {
  const draft = { title: "日报", description: "总结", schedule: "0 9 * * 1", timezone: "Asia/Shanghai", assignee: "codex@mac", context: "none" as const, workdir: "~/w", timeout_minutes: "30" };
  test("create is schema-valid", () => expect(ExecutionRoutineCommandRequest.safeParse(routineCreateCommand(draft)).success).toBe(true));
  test("update carries revision and clears workdir with null", () => {
    const routine: ExecutionRoutine = { schema_version: 2, id: "rtn_01JABCDEFGHJKMNPQRSTVWXYZ0", title: "日报", description: "总结", revision: 2, status: "active", schedule: "0 9 * * 1",
      timezone: "Asia/Shanghai", assignee: "codex@mac", context: "none", created: "2026-11-01T00:00:00+08:00", updated: "2026-11-01T00:00:00+08:00", workdir: "~/w", timeout_minutes: 30 };
    const cmd = routineUpdateCommand(routine, { ...draft, workdir: "" })!;
    expect(ExecutionRoutineCommandRequest.safeParse(cmd).success).toBe(true);
    expect((cmd.operation as { args: { expected_revision: number; patch: object } }).args).toMatchObject({ expected_revision: 2, patch: { workdir: null } });
  });
});

test("safe download names", () => {
  expect(safeFileName("jobs/x/../../etc/passwd")).toBe("passwd");
  expect(safeFileName("a/..")).toBe("download");
  expect(safeFileName("r/报告 v1.txt")).toBe("报告_v1.txt");
});

test("browser bundle builds without server-only modules", async () => {
  // Exercise the real build in a clean Bun process, outside Bun.test's module registry.
  const buildUrl=new URL("../src/build.ts",import.meta.url).href;
  const child=Bun.spawn([process.execPath,"-e",`import {buildAssets} from ${JSON.stringify(buildUrl)}; process.stdout.write(JSON.stringify(await buildAssets()));`],{stdout:"pipe",stderr:"pipe"});
  const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(0);if(code!==0)throw new Error(errors);
  const assets = JSON.parse(output) as WebAssets;
  const files = new Map(Object.entries(assets.chunks ?? {}).map(([name, body]) => ["/assets/" + name, body]));
  files.set("/assets/app.js", assets.js);
  for (const body of files.values()) {
    for (const [, path] of body.matchAll(/"(\/assets\/chunk-[a-z0-9]+\.js)"/g)) expect(files.has(path!)).toBe(true);
  }
  // Follow static ESM imports only. Editor and formula code must stay off the initial request path.
  const initial = new Set(["/assets/app.js"]);
  for (const path of initial) {
    for (const [, dependency] of files.get(path)!.matchAll(/(?:from|import)\s*"(\/assets\/chunk-[a-z0-9]+\.js)"/g)) initial.add(dependency!);
  }
  expect([...files.values()].some(body => body.includes("katex-error"))).toBe(true);
  expect([...files.values()].some(body => body.includes("cm-editor"))).toBe(true);
  expect(assets.preloads?.map(name => "/assets/" + name).sort()).toEqual([...initial].filter(path => path !== "/assets/app.js").sort());
  for (const path of initial) {
    const body = files.get(path)!;
    expect(body).not.toContain("katex-error");
    expect(body).not.toContain("cm-editor");
  }
  expect(assets.js.length).toBeGreaterThan(1000);
  expect(assets.js).not.toMatch(/from\s*["'](node:|bun:|fs["']|child_process)/);
  expect(assets.js).not.toContain("Bun.serve");
  expect(assets.css).toContain("--lumen");
  expect(assets.css).toContain(':root[data-theme="dark"]');
  // The real build is serialized into the compiled CLI. Its stylesheet and
  // immutable font must agree after that round trip.
  const fontName = /url\("(geist-[a-f0-9]{16}\.woff2)"\)/.exec(assets.css)?.[1];
  expect(fontName).toBeDefined();
  const font = webFiles(assets, { apiBase: "" }).get("/assets/" + fontName);
  expect(font).toMatchObject({ type: "font/woff2", immutable: true });
  expect(Buffer.from(font!.body).subarray(0, 4).toString()).toBe("wOF2");
  expect(WEB_CSP).toContain("font-src 'self'");
}, 30000);

test("time labels include timezone without incompatible Intl style options",()=>{expect(formatTime("2026-11-01T00:00:00+08:00","Asia/Singapore")).toContain("2026");expect(formatTime(undefined)).toBe("—");});

test("artifact downloads require both exact size and digest",async()=>{
 const bytes=new TextEncoder().encode("合成文件").buffer,sha256=await sha256Hex(bytes);
 expect(await verifyArtifact(bytes,{size:bytes.byteLength,sha256})).toBe(true);
 expect(await verifyArtifact(bytes,{size:bytes.byteLength+1,sha256})).toBe(false);
 expect(await verifyArtifact(new TextEncoder().encode("损坏文件").buffer,{size:bytes.byteLength,sha256})).toBe(false);
});
test("invalid nonempty Routine timeout is rejected rather than silently using a default",()=>{
 for(const timeout of ["oops","0","1.5"]){const command=routineCreateCommand({title:"合成",description:"",schedule:"0 9 * * 1",timezone:"UTC",assignee:"pi@lab",context:"none",workdir:"~",timeout_minutes:timeout});expect(ExecutionRoutineCommandRequest.safeParse(command).success).toBe(false);}
});
