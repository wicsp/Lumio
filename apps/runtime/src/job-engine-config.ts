import { stat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import type { AgentRun, JobEngineActivityCapability, RuntimeRegistration } from "@lumio/schema";
import { codexExecutable } from "./native/isolation.ts";

export type JobEngineConfig = { engine: "codex" | "claude-code"; executable: string; key: string; roots: string[]; version: string };
const options = {
  codex: { version: "0.166.0", command: "codex", key: "LUMIO_JOB_CODEX_API_KEY" },
  "claude-code": { version: "2.1.322", command: "claude", key: "LUMIO_JOB_CLAUDE_API_KEY" },
} as const;
export function contains(root: string, path: string) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

export async function interactiveEngine(engine: AgentRun["engine"], version: string, env: NodeJS.ProcessEnv): Promise<JobEngineConfig | undefined> {
  if (process.platform !== "darwin" || engine === "pi") return;
  const expected = options[engine], key = env[expected.key]?.trim();
  if (version !== expected.version || !key || key.length > 2048 || !env.LUMIO_INTERACTIVE_JOB_ROOTS) return;
  const executable = Bun.which(expected.command, { PATH: env.PATH ?? "" });
  if (!executable) return;
  try {
    const path = engine === "codex" ? await codexExecutable(executable) : await realpath(executable);
    const roots = await Promise.all(env.LUMIO_INTERACTIVE_JOB_ROOTS.split(delimiter).map(async root => {
      if (!isAbsolute(root)) throw new Error("Expected an absolute project root");
      const location = await realpath(root);
      if (!(await stat(location)).isDirectory() || contains(location, homedir())) throw new Error("Use a dedicated project directory");
      return location;
    }));
    if (roots.some(root => contains(root, path))) return;
    const detected = Bun.spawnSync([path, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }, timeout: 5000, stderr: "ignore" });
    const actual = detected.stdout.toString().trim();
    if (detected.exitCode !== 0 || actual !== (engine === "codex" ? `codex-cli ${version}` : `${version} (Claude Code)`)) return;
    return { engine, executable: path, key, roots, version };
  } catch { return; }
}

export async function jobEngineCapabilities(engines: RuntimeRegistration["engines"], env: NodeJS.ProcessEnv): Promise<JobEngineActivityCapability[]> {
  return Promise.all(engines.map(async engine => {
    const config = await interactiveEngine(engine.name, engine.version, env);
    return {
      engine: engine.name, version: engine.version, progress: engine.name !== "pi", sandbox: config ? "os" : engine.sandbox,
      approvals: !!config, questions: !!config, steer: config?.engine === "codex",
    };
  }));
}
