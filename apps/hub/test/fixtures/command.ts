// Synthetic command used only by dispatch tests. All paths are temporary.
import { appendFileSync, writeFileSync } from "node:fs";
const [mode, path, delay = "0", extra] = process.argv.slice(2);
if (mode === "child") {
  writeFileSync(path!, String(process.pid));
  if (extra === "ignore-term") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  if (path) appendFileSync(path, `start ${process.pid}\n`);
  if (mode === "tree") {
    const child = Bun.spawn([process.execPath, import.meta.path, "child", `${path}.child`, "0", extra ?? ""], { stdout: "inherit", stderr: "inherit" });
    if (extra === "ignore-term") process.on("SIGTERM", () => {});
    await child.exited;
  } else {
    if (mode === "output") {
      console.log("x".repeat(4500) + "中文 stdout");
      console.error("stderr only");
      console.log(`cwd=${process.cwd()} gpu=${process.env.CUDA_VISIBLE_DEVICES} arg=${extra}`);
      console.log(`lumio-env=${Object.keys(process.env).filter((k) => k.startsWith("LUMIO_")).join(",") || "none"}`);
    }
    await Bun.sleep(Number(delay));
    if (path) appendFileSync(path, "end\n");
    if (mode === "fail") process.exit(7);
  }
}
