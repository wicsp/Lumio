import { stat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentRun, JobEngineActivityCapability, RuntimeRegistration } from "@lumio/schema";
import { PI_ACTIVITY_VERSION } from "./agents.ts";
import { codexExecutable } from "./native/isolation.ts";

type Common = { executable: string; roots: string[]; version: string };
export type PiJobEngine = Common & { engine: "pi"; node: string; provider: string; model: string; key: string; keyEnv: string; packageRoot: string };
export type JobEngineConfig = (Common & { engine: "codex" | "claude-code"; key?: string }) | PiJobEngine;
const piKeys = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", google: "GEMINI_API_KEY" } as const;
const options = {
  codex: { version: "0.166.0", command: "codex", key: "LUMIO_JOB_CODEX_API_KEY" },
  "claude-code": { version: "2.1.322", command: "claude", key: "LUMIO_JOB_CLAUDE_API_KEY" },
} as const;
export function contains(root: string, path: string) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

export async function interactiveEngine(engine: AgentRun["engine"], version: string, env: NodeJS.ProcessEnv, account = false): Promise<JobEngineConfig | undefined> {
  const configuredRoots = env.LUMIO_INTERACTIVE_JOB_ROOTS;
  if (process.platform !== "darwin" || (account ? engine !== "codex" : !configuredRoots)) return;
  const expected = engine === "pi" ? { version: PI_ACTIVITY_VERSION, command: "pi", key: "LUMIO_JOB_PI_API_KEY" } : options[engine];
  if (version !== expected.version) return;
  const executable = Bun.which(expected.command, { PATH: env.PATH ?? "" });
  if (!executable) return;
  try {
    const path = engine === "codex" ? await codexExecutable(executable) : await realpath(executable);
    const roots = await Promise.all((configuredRoots ? configuredRoots.split(delimiter) : []).map(async root => {
      if (!isAbsolute(root)) throw new Error("Expected an absolute project root");
      const location = await realpath(root);
      if (!(await stat(location)).isDirectory() || contains(location, homedir())) throw new Error("Use a dedicated project directory");
      return location;
    }));
    if (roots.some(root => contains(root, path))) return;
    if (engine === "pi") {
      const model = env.LUMIO_JOB_PI_MODEL?.trim() ?? "";
      const [provider] = model.split("/");
      if (!provider || !Object.hasOwn(piKeys, provider) || !/^[a-z]+\/[A-Za-z0-9][A-Za-z0-9_./:-]{0,195}$/.test(model)) return;
      const keyEnv = piKeys[provider as keyof typeof piKeys];
      const key = (env[expected.key] ?? env[keyEnv])?.trim();
      const nodePath = Bun.which("node", { PATH: env.PATH ?? "" });
      if (!key || key.length > 2048 || !nodePath) return;
      const node = await realpath(nodePath);
      const packageRoot = path.endsWith("/dist/bundle/cli.js") ? dirname(dirname(dirname(path))) : dirname(path);
      if (roots.some(root => contains(root, node) || contains(root, packageRoot) || contains(packageRoot, root))) return;
      const detected = Bun.spawnSync([node, path, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty", PI_OFFLINE: "1" }, timeout: 5000, stderr: "ignore" });
      if (detected.exitCode !== 0 || detected.stdout.toString().trim() !== version) return;
      return { engine, executable: path, roots, version, node, provider, model, key, keyEnv, packageRoot };
    }
    const key = account ? undefined : env[expected.key]?.trim();
    if (!account && (!key || key.length > 2048)) return;
    const detected = Bun.spawnSync([path, "--version"], { env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" }, timeout: 5000, stderr: "ignore" });
    const actual = detected.stdout.toString().trim();
    if (detected.exitCode !== 0 || actual !== (engine === "codex" ? `codex-cli ${version}` : `${version} (Claude Code)`)) return;
    return { engine, executable: path, key, roots, version };
  } catch { return; }
}

const privateHomeDirectories = [
  ".ssh", ".gnupg", ".aws", ".kube", ".codex", ".claude", ".pi",
  ".config/lumio", ".config/lumio-runtime", ".config/gcloud", ".local/share/lumio", ".local/share/lumio-runtime",
  "Library/Keychains", "Library/LaunchAgents",
];

/** With no administrator roots, only a human-authorized Codex account Job can use its own workspace. */
export async function interactiveWorkspace(workdir: string, stateDir: string, provider: JobEngineConfig, gitPaths: string[], accountBound: boolean, homeDirectory = homedir()) {
  if (!isAbsolute(workdir) || (!provider.roots.length && (provider.engine !== "codex" || !accountBound))) return;
  try {
    const [cwd, state, ...git] = await Promise.all([workdir, stateDir, ...gitPaths].map(path => realpath(path)));
    if (!cwd || !state || !(await stat(cwd)).isDirectory()) return;
    const fold = (path: string) => process.platform === "darwin" ? path.toLowerCase() : path;
    const overlaps = (left: string, right: string) => contains(fold(left), fold(right)) || contains(fold(right), fold(left));
    if ([cwd, ...git].some(path => overlaps(path, state))) return;
    if (provider.roots.length) return provider.roots.some(root => contains(root, cwd)) ? { cwd, gitPaths: git } : undefined;

    const home = await realpath(homeDirectory);
    const protectedPaths = [dirname(provider.executable), dirname(process.execPath), ...privateHomeDirectories.map(path => join(home, path))];
    const privatePaths = await Promise.all(protectedPaths.map(path => realpath(path).catch(() => path)));
    if ([cwd, ...git].some(path => contains(fold(path), fold(home)) || privatePaths.some(other => overlaps(path, other)))) return;
    return { cwd, gitPaths: git };
  } catch { return; }
}

export async function jobEngineCapabilities(engines: RuntimeRegistration["engines"], env: NodeJS.ProcessEnv, account = false): Promise<JobEngineActivityCapability[]> {
  return Promise.all(engines.map(async engine => {
    const config = await interactiveEngine(engine.name, engine.version, env);
    const reuse = account && engine.name === "codex" && (config || await interactiveEngine(engine.name, engine.version, env, true));
    return {
      engine: engine.name, version: engine.version, progress: engine.name !== "pi" || engine.version === PI_ACTIVITY_VERSION, sandbox: config || reuse ? "os" : engine.sandbox,
      approvals: !!config, questions: !!config, steer: config?.engine === "codex", ...(reuse ? { account_reuse: true as const } : {}),
    };
  }));
}
