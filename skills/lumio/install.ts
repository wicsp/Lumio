/// <reference path="./text.d.ts" />
import { chmod, lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import skill from "./SKILL.md" with { type: "text" };

export const SKILL_TEXT = skill;
export const SKILL_PATHS = { codex: ".agents/skills/lumio", claude: ".claude/skills/lumio", pi: ".pi/agent/skills/lumio" } as const;
export async function privateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path); await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
/** Old installations linked this directory to a checkout; never put connection secrets there. */
export async function prepareSkillDirectory(directory: string): Promise<void> {
  try { if ((await lstat(directory)).isSymbolicLink()) await unlink(directory); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
}
export async function installSkill(directory: string): Promise<string> {
  await prepareSkillDirectory(directory);
  const path = join(directory, "SKILL.md");
  await privateWrite(path, skill); return path;
}
