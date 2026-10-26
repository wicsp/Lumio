import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { JobSpec } from "@lumio/schema";

// The parent releases stdin only after it has durably recorded this process group.
// EOF before release means the parent died; no user command has started.
export async function runWorker() {
  const input = await new Response(Bun.stdin.stream()).text();
  if (!input) return;
  const { spec: raw, completion, env } = JSON.parse(input);
  const spec = JobSpec.parse(raw);
  if (spec.run.kind !== "command") return;
  const command = spawn(spec.run.argv[0]!, spec.run.argv.slice(1), { cwd: spec.workdir, env, stdio: ["ignore", "inherit", "inherit"], shell: false });
  await new Promise<void>((resolve) => {
    command.once("error", () => { writeFileSync(completion, JSON.stringify({ error: "无法启动程序" })); resolve(); });
    command.once("exit", (code, signal) => { writeFileSync(completion, JSON.stringify({ exit_code: code ?? undefined, signal: signal ?? undefined })); resolve(); });
  });
}
