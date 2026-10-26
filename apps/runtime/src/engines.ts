import type { RuntimeRegistration } from "@lumio/schema";

const ENGINES = [
  { command: "codex", name: "codex", sandbox: "os" },
  { command: "claude", name: "claude-code", sandbox: "none" },
  { command: "pi", name: "pi", sandbox: "none" },
] as const;

export function parseVersion(output: string): string | undefined {
  return /^\s*(?:(?:codex(?:-cli)?|claude(?:-code)?|pi)\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s.*)?\s*$/i.exec(output)?.[1];
}

export async function detectEngines(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeRegistration["engines"]> {
  const detected = await Promise.all(ENGINES.map(async ({ command, name, sandbox }) => {
    const executable = Bun.which(command, { PATH: env.PATH ?? "" });
    if (!executable) return undefined;
    try {
      const child = Bun.spawn([executable, "--version"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const version = parseVersion(stdout.trim() || stderr.trim());
      return code === 0 && version ? { name, version, sandbox } : undefined;
    } catch { return undefined; }
  }));
  return detected.filter((engine) => engine !== undefined);
}
