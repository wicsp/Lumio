import { CAPABILITIES } from "@lumio/schema";

/** Executable spellings shared by command parsing, --help and generated skill documentation. */
export const WORK_OPTIONS = {
  query: { type: "string" }, json: { type: "boolean" }, legacy: { type: "boolean" }, to: { type: "string" }, description: { type: "string" },
  file: { type: "string" }, status: { type: "string" }, project: { type: "string" }, parent: { type: "string" },
  depends: { type: "string" }, due: { type: "string" }, workdir: { type: "string" }, model: { type: "string" }, gpus: { type: "string" },
  timeout: { type: "string" }, patch: { type: "string" }, revision: { type: "string" }, "request-id": { type: "string" },
  comment: { type: "string" }, turn: { type: "string" }, note: { type: "string" },
  from: { type: "string" }, stage: { type: "string" }, action: { type: "string" }, "back-to": { type: "string" },
  goal: { type: "string" }, repo: { type: "string" }, deadline: { type: "string" },
} as const;
export interface CommandDefinition { path: string; positional?: string; options?: string[]; required?: string[]; capability?: string; aliases?: string[]; tail?: string }
const write = ["request-id"], body = ["description", "file"], taskFields = ["project", "parent", "depends", "due", "workdir", "model", "gpus", "timeout"], projectFields = ["goal", "repo", "deadline", "workdir"];
const def = (path: string, positional = "", options: string[] = [], capability?: string, extra: Partial<CommandDefinition> = {}): CommandDefinition => ({ path, positional, options, capability, ...extra });
export const COMMANDS: CommandDefinition[] = [
  def("search", "<query>", ["type", "limit", "include-private", "vault"], "knowledge.note.search"),
  def("show", "<ref>", ["include-private", "vault"], "knowledge.note.show"), def("links", "<ref>", ["include-private", "vault"], "knowledge.note.links"),
  def("check", "", ["include-private", "vault"]), def("export bib", "<ref>", ["from", "out", "vault"]),
  def("sync", "", ["vault", "dry-run"]), def("new idea", "<title>", ["vault"]), def("new paper", "<arxiv-or-doi>", ["vault", "abbr"]),
  def("targets", "", ["online"], "execution.target.list"), def("attention", "", [], "work.attention.list"),
  def("task new", "<title>", [...body, ...taskFields, ...write], "work.task.create", { aliases: ["task create"] }),
  def("task update", "<id>", ["patch", "revision", ...body, ...taskFields, ...write], "work.task.update"),
  def("task list", "", ["project", "status", "turn", "query"], "work.task.list"), def("task show", "<id>", ["legacy"], "work.task.show"),
  def("task edit", "<id>", ["file", "revision", ...write]),
  def("task continue", "<id>", ["to", "comment", "revision", "legacy", ...write]),
  def("task hand", "<id>", ["to", "note", "revision", ...write], "work.task.hand", { required: ["to"] }),
  ...["finish", "cancel", "reopen"].map(action => def(`task ${action}`, "<id>", ["revision", ...write])),
  def("task comment", "<id> [<text>]", ["file", ...write], "work.task.comment"),
  def("task plan show", "<id>"), def("task plan set", "<id>", ["file", "from", "revision", ...write], undefined, { required: ["file"] }),
  def("task checkpoint", "<id>", ["stage", "action", "back-to", "comment", ...write], undefined, { required: ["stage", "action"] }),
  def("project new", "<title>", [...body, ...projectFields, ...write], "work.project.create", { aliases: ["project create"] }),
  def("project list", "", ["status"], "work.project.list"), def("project show", "<id>", [], "work.project.show"),
  def("project update", "<id>", ["patch", "revision", ...body, ...projectFields, ...write], "work.project.update"),
  def("project edit", "<id>", ["file", "revision", ...write]), def("project status", "<id> [<status>]", ["status", "revision", ...write]),
  def("plan-template list"), def("plan-template save", "<name>", ["file", "template", ...write], undefined, { required: ["file"] }), def("plan-template delete", "<id>", write),
  def("job list", "", ["status", "task", "routine", "limit"], "execution.job.list"), def("job show", "<id>", [], "execution.job.show"),
  def("job submit", "", ["runtime", "workdir", "timeout", "gpus", "agent", "model", "session", "resume"], undefined, { required: ["runtime"], tail: "-- <program-or-prompt> [args...]" }),
  def("job cancel", "<id>"), def("job artifacts", "<id>", ["include-private"]), def("job download", "<id>", ["output", "include-private"], undefined, { required: ["output"] }),
  def("routine list", "", ["legacy"], "execution.routine.list"),
  def("routine new", "<title>", ["schedule", "timezone", "to", "context", ...body, ...write], undefined, { aliases: ["routine create"], required: ["schedule", "to"] }),
  def("routine show", "<id>"), def("routine update", "<id>", ["patch", "revision", ...write]), def("routine edit", "<id>", ["file", "revision", ...write]),
  def("routine status", "<id> [<status>]", ["status", "revision", ...write]), def("routine followup", "<id> <job-or-date>", ["legacy", ...write]),
  def("proposals", "", ["status"], "approval.proposal.list"),
  def("proposals withdraw", "<id>", [], "approval.proposal.withdraw"), def("proposals accept", "<id>"), def("proposals reject", "<id>"),
  def("chat", "<message>", ["conversation", "model", "stream", ...write]), def("chat list"), def("chat show", "<id>"),
  def("chat memory list"), def("chat memory remember", "<content>", ["sources", ...write]), def("chat memory forget", "<id>", write),
  def("agent list"), def("agent add", "<name>", ["label"]), def("agent revoke", "<name>", ["label"]), def("skill install", "", ["for"]),
  def("doctor"), def("selftest", "", ["runtime", "agents", "notes"]), def("upgrade", "", ["version"]),
  def("login", "<hub-url>", ["code", "vault"], undefined, { required: ["code"] }), def("login-code", "", ["name"]), def("logout"),
  def("runtime list"), def("runtime add", "<name>"), def("runtime remove", "<name>"), def("runtime serve"),
  def("runtime join", "", ["hub", "code"], undefined, { required: ["hub", "code"] }), def("runtime doctor"), def("runtime upgrade", "", ["version"]),
  def("runtime prepare-migration", "", ["state-dir"], undefined, { required: ["state-dir"] }), def("runtime install-service"), def("runtime install-sudo-helper", "", ["uninstall"]),
  def("runtime sudo", "", [], undefined, { tail: "-- <absolute-program> [args...]" }),
  def("hub serve"), def("hub status"), def("hub setup", "", ["vault", "server", "public-url", "yes"]), def("hub switch", "", ["retire-legacy"], undefined, { required: ["retire-legacy"] }),
  def("hub actor create", "<name>", ["role"], undefined, { required: ["role"] }), def("hub actor list"), def("hub token create", "<label>", ["actor"], undefined, { required: ["actor"] }), def("hub token list"), def("hub token revoke", "<label>"), def("hub signing-key"),
  def("hub backup", "<destination>"), def("hub backup business", "<new-directory>"), def("hub backup verify", "<directory>"), def("hub restore business", "<backup-directory> <new-state-directory>"),
  def("hub assistant setup", "", ["base-url", "model", "api-key-stdin", "skip-check"]), def("hub assistant status"), def("hub assistant clear"),
  def("hub migrate plan", "", ["vault", "output"], undefined, { required: ["vault"] }),
  def("hub migrate apply", "", ["vault", "plan", "backup", "runtimes-prepared"], undefined, { required: ["vault", "plan", "backup", "runtimes-prepared"] }),
  def("hub migrate retire", "", ["vault"], undefined, { required: ["vault"] }), def("hub migrate sources"), def("hub migrate source", "<id>", ["output"], undefined, { required: ["output"] }), def("hub migrate task-v3"),
];
const booleans = new Set(["json", "help", "online", "legacy", "include-private", "dry-run", "resume", "stream", "notes", "server", "yes", "retire-legacy", "runtimes-prepared", "api-key-stdin", "skip-check", "uninstall"]);
export function commandUsage(command: CommandDefinition, json = true): string {
  return [command.path, command.positional, ...(command.options ?? []).map(name => {
    const option = `--${name}${booleans.has(name) ? "" : ` <${name}>`}`;
    return command.required?.includes(name) ? option : `[${option}]`;
  }), ...(json ? ["[--json]"] : []), command.tail].filter(Boolean).join(" ");
}
export const CAPABILITY_COMMANDS: Record<string, string> = Object.fromEntries(COMMANDS.filter(command => command.capability).map(command => [command.capability!, commandUsage(command, false)]));
export function definitionSummary(command: CommandDefinition, language: "en" | "zh"): string | undefined {
  return CAPABILITIES.find(value => value.name === command.capability)?.summary[language];
}
