/**
 * 生成 iPhone 快捷指令文件（未签名）到 `apps/mobile/dist/`。
 * iOS 只导入签名过的快捷指令：在 macOS 上加 `--sign`，用系统的 `shortcuts sign --mode anyone` 签名，输出到 `dist/signed/`。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toPlist } from "./src/plist.ts";
import { SHORTCUTS } from "./src/shortcuts.ts";

const dist = join(import.meta.dir, "dist");
mkdirSync(join(dist, "signed"), { recursive: true });
for (const item of SHORTCUTS) {
  const path = join(dist, item.file);
  writeFileSync(path, toPlist(item.build().toPlist(item.icon)));
  console.log(path);
  if (process.argv.includes("--sign")) {
    const out = join(dist, "signed", item.file);
    const signed = Bun.spawnSync(["shortcuts", "sign", "--mode", "anyone", "--input", path, "--output", out], { stdout: "inherit", stderr: "inherit" });
    if (signed.exitCode !== 0) throw new Error(`签名失败：${item.file}`);
    console.log(out);
  }
}
