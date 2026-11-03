import { expect, test } from "bun:test";
import { allowsColor, createProgressLine, formatSize, formatSpeed, isTerminal, terminalColors } from "../src/terminal.ts";
import { printChecks } from "../src/diagnostics.ts";

test("terminal and color detection honors explicit overrides and disabled environments", () => {
  expect(isTerminal({})).toBe(false); expect(isTerminal({ isTTY: true })).toBe(true);
  for (const [tty, env, expected] of [
    [true, {}, true], [false, {}, false], [true, { NO_COLOR: "" }, false], [true, { TERM: "dumb" }, false],
    [false, { FORCE_COLOR: "1" }, true], [true, { FORCE_COLOR: "0" }, false],
    [true, { NO_COLOR: "1", FORCE_COLOR: "1", TERM: "dumb" }, true],
  ] as const) expect(allowsColor({ isTTY: tty }, env)).toBe(expected);
  expect(terminalColors(false).green("✓")).toBe("✓");
  expect(terminalColors(true).green("✓")).toBe("\x1b[32m✓\x1b[0m");
  expect(terminalColors(true).yellow("!")).toBe("\x1b[33m!\x1b[0m");
  expect(terminalColors(true).red("✗")).toBe("\x1b[31m✗\x1b[0m");
});
test("sizes and speeds use binary units and one decimal place", () => {
  for (const [size, text] of [[0, "0.0 B"], [1, "1.0 B"], [1023, "1023.0 B"], [1024, "1.0 KB"],
    [1536, "1.5 KB"], [1024 ** 2 * 12.125, "12.1 MB"], [1024 ** 3, "1.0 GB"], [1024 ** 4, "1024.0 GB"]] as const) expect(formatSize(size)).toBe(text);
  expect(formatSpeed(1536)).toBe("1.5 KB/s");
});
for (const tty of [true, false]) test(`download progress snapshot (tty=${tty})`, () => {
  const chunks: string[] = [];
  const report = createProgressLine({ label: "下载 Lumio 0.2.1（darwin-arm64）", tty, columns: () => 100, write: chunk => chunks.push(chunk) });
  for (const downloaded of [0, 1024, 2048]) report({ downloaded, total: 2048, bytesPerSecond: downloaded, done: downloaded === 2048 });
  report({ downloaded: 2048, total: 2048, bytesPerSecond: 2048, done: true });
  expect(chunks.map(chunk => JSON.stringify(chunk))).toMatchSnapshot();
  expect(chunks).toHaveLength(tty ? 3 : 2);
});
test("progress shrinks on resize, omits narrow bars, and ends failed/unknown transfers on a new line", () => {
  let columns = 100;
  const chunks: string[] = [];
  const report = createProgressLine({ label: "下载 Lumio 0.2.1（linux-x64）", tty: true, columns: () => columns, write: chunk => chunks.push(chunk) });
  report({ downloaded: 1024, total: 2048, bytesPerSecond: 1024, done: false });
  columns = 60; report({ downloaded: 1024, total: 2048, bytesPerSecond: 1024, done: false });
  expect(chunks[0]).toContain("[████"); expect(chunks[1]).not.toContain("░"); expect(chunks[1]).toContain("50%");
  columns = 12; report({ downloaded: 1024, bytesPerSecond: 1024, done: true, failed: true });
  expect(chunks.at(-1)).toEndWith("\n");
  for (const [i, width] of [100, 60, 12].entries()) expect(Bun.stringWidth(chunks[i]!.replace(/[\r\n]/g, ""))).toBeLessThan(width);
});
test("diagnostics distinguish pass, warning, failure, summarize and only fail for failures", () => {
  const checks = [{ name: "通过", ok: true }, { name: "提醒", ok: true, warning: true }, { name: "失败", ok: false }];
  const output: string[] = [];
  expect(printChecks(checks, false, line => output.push(line), { output: { isTTY: true }, env: {} })).toBe(1);
  expect(output).toEqual(["\x1b[32m✓\x1b[0m 通过", "\x1b[33m!\x1b[0m 提醒", "\x1b[31m✗\x1b[0m 失败", "\x1b[31m1 passed, 1 warnings, 1 failed\x1b[0m"]);
  output.length = 0;
  expect(printChecks(checks.slice(0, 2), false, line => output.push(line), { output: { isTTY: false }, env: {} })).toBe(0);
  expect(output).toEqual(["✓ 通过", "! 提醒", "1 passed, 1 warnings, 0 failed"]);
  output.length = 0;
  expect(printChecks(checks, true, line => output.push(line), { env: { FORCE_COLOR: "1" } })).toBe(1);
  expect(JSON.parse(output[0]!)).toEqual(checks);
});
