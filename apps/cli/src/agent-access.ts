import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { ApiClientError, createClient } from "@lumio/api-client";
import { CliConfig } from "@lumio/schema";
import { language } from "@lumio/platform";
import { hubCredentials } from "./config.ts";
import { text as msg } from "./messages.ts";
import { installSkill, prepareSkillDirectory, privateWrite, SKILL_PATHS } from "../../../skills/lumio/install.ts";

export async function runAgents(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { label: { type: "string" }, json: { type: "boolean" } } });
  const [action, name] = positionals;
  if (action === "list" ? positionals.length !== 1 || values.label !== undefined : !["add", "revoke"].includes(action ?? "") || positionals.length !== 2 || !name) throw new Error(msg("agents.usage"));
  const client = createClient({ ...hubCredentials(), language: language() });
  if (action === "list") {
    const agents = await client.agents();
    if (values.json) log(JSON.stringify(agents));
    else for (const agent of agents) log(`${agent.actor.name}  ${agent.actor.id}\n${agent.tokens.map(token => `  ${token.label}  ${token.kind}  ${token.last_used ?? token.created}`).join("\n")}`);
  } else if (action === "add") {
    const issued = await client.issueAgentToken({ name: name!, label: values.label });
    if (values.json) log(JSON.stringify(issued));
    else { log(msg("agents.token_once", issued.actor.name, issued.label)); log(issued.token); }
  } else { await client.revokeAgent({ name: name!, label: values.label }); log(values.json ? "null" : msg("agents.revoked")); }
  return 0;
}

export async function runSkillInstall(args: string[], log: (line: string) => void): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { for: { type: "string" } } });
  if (positionals.length !== 1 || positionals[0] !== "install" || (values.for !== undefined && !Object.hasOwn(SKILL_PATHS, values.for))) throw new Error(msg("skill.usage"));
  const targets = values.for ? [values.for as keyof typeof SKILL_PATHS] : Object.keys(SKILL_PATHS) as (keyof typeof SKILL_PATHS)[];
  for (const target of targets) {
    const directory = join(process.env.HOME ?? homedir(), SKILL_PATHS[target]), connection = join(directory, "connection.json");
    await prepareSkillDirectory(directory);
    try { CliConfig.parse(JSON.parse(await readFile(connection, "utf8"))); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(msg("skill.invalid_connection"));
      const credentials = hubCredentials(), client = createClient({ ...credentials, language: language() });
      let token: string;
      const engine = target === "claude" ? "claude-code" : target;
      const machine = hostname().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 63 - engine.length) || "local";
      try { token = (await client.issueAgentToken({ name: `${engine}@${machine}` })).token; }
      catch (error) {
        if (!(error instanceof ApiClientError) || error.status !== 403) throw error;
        // Agent credentials cannot issue tokens; runtime credentials cannot read Work.
        await client.workTasks(); token = credentials.token;
      }
      await privateWrite(connection, JSON.stringify(CliConfig.parse({ hub_url: credentials.url, token })) + "\n");
    }
    const path = await installSkill(directory); log(msg("skill.installed", path));
  }
  return 0;
}
