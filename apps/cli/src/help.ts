import { language } from "@lumio/platform";
import { COMMANDS, commandUsage, definitionSummary } from "./command-definitions.ts";
import { text as msg } from "./messages.ts";

/** Inspect help before config, filesystem, networking, or command execution. A -- tail belongs to the child. */
export function printHelp(args: string[], log: (line: string) => void): boolean {
  const tail = args.indexOf("--"), own = tail < 0 ? args : args.slice(0, tail);
  if (!own.includes("--help") && own[0] !== "help") return false;
  const words = own.filter(arg => arg !== "--help" && arg !== "--json");
  if (words[0] === "help") words.shift();
  const matches = COMMANDS.filter(command => [command.path, ...(command.aliases ?? [])].some(path => path.split(" ").every((word, index) => words[index] === word)));
  const requested = words.join(" ");
  const namespace = requested && COMMANDS.some(command => command.path.startsWith(`${requested} `));
  const exact = namespace ? COMMANDS.find(command => command.path === requested) : matches.sort((a, b) => b.path.length - a.path.length)[0];
  const path = namespace ? requested : exact?.path ?? requested;
  const children = COMMANDS.filter(command => !path || command.path.startsWith(`${path} `));
  const usage = exact ? `lumio ${commandUsage(exact)}` : `lumio${path ? ` ${path}` : ""} <command> [--help] [--json]`;
  const result = { command: `lumio${path ? ` ${path}` : ""}`, usage, ...(exact?.capability ? { capability: exact.capability } : {}),
    ...(exact ? { options: [...(exact.options ?? []), "json", "help"].map(name => `--${name}`), summary: definitionSummary(exact, language()) } : {}),
    subcommands: children.map(command => ({ command: command.path, usage: `lumio ${commandUsage(command)}` })) };
  if (own.includes("--json")) log(JSON.stringify(result));
  else log([`${msg("help.usage")}: ${usage}`, ...(result.summary ? [result.summary] : []), ...result.subcommands.map(command => `  ${command.usage}`)].join("\n"));
  return true;
}
