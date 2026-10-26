import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { JobSpec } from "@lumio/schema";

// The parent releases stdin only after it has durably recorded this process group.
// EOF before release means the parent died; no user command has started.
export async function runWorker() {
  const input = await new Response(Bun.stdin.stream()).text();
  if (!input) return;
  const { spec: raw, argv: rawArgv, completion, env } = JSON.parse(input);
  const spec = JobSpec.parse(raw);
  // argv 由执行器算好：command 类型就是 run.argv，agent 类型由适配器翻译（P2-3）。stdin 一律是 /dev/null。
  const argv: string[] = Array.isArray(rawArgv) && rawArgv.length ? rawArgv : spec.run.kind === "command" ? spec.run.argv : [];
  if (!argv.length) return;
  const command = spawn(argv[0]!, argv.slice(1), { cwd: spec.workdir, env, stdio: ["ignore", "inherit", "inherit"], shell: false });
  await new Promise<void>((resolve) => {
    command.once("error", () => { writeFileSync(completion, JSON.stringify({ error: "无法启动程序" })); resolve(); });
    command.once("exit", (code, signal) => { writeFileSync(completion, JSON.stringify({ exit_code: code ?? undefined, signal: signal ?? undefined })); resolve(); });
  });
}
