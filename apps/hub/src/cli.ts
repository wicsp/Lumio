import { parseArgs } from "node:util";
import { ActorRole } from "@lumio/schema";
import { backupHub } from "./backup.ts";
import { stateDirectory } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore } from "./store.ts";

export async function runManagement(args: string[], log: (line: string) => void = console.log): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { role: { type: "string" }, actor: { type: "string" } } });
  const [kind, action, name] = positionals;
  if (kind === "backup") {
    if (positionals.length !== 2 || !action || Object.keys(values).length) throw new HubError("INVALID", "用法：backup <目标文件>");
    await backupHub(stateDirectory(), action);
    log(action);
    return;
  }
  const actorCreate = kind === "actor" && action === "create" && positionals.length === 3 && values.actor === undefined && ActorRole.safeParse(values.role).success;
  const tokenCreate = kind === "token" && action === "create" && positionals.length === 3 && values.actor !== undefined && values.role === undefined;
  const list = (kind === "actor" || kind === "token") && action === "list" && positionals.length === 2 && !Object.keys(values).length;
  const revoke = kind === "token" && action === "revoke" && positionals.length === 3 && !Object.keys(values).length;
  if (!actorCreate && !tokenCreate && !list && !revoke) throw new HubError("INVALID", "用法：actor create <名称> --role human|agent|runtime；actor list；token create <标签> --actor <身份名称>；token list；token revoke <标签>");
  const store = await HubStore.open(stateDirectory());
  try {
    if (actorCreate) log(JSON.stringify(store.createActor(name!, ActorRole.parse(values.role))));
    else if (tokenCreate) log(store.createToken(name!, values.actor!));
    else if (revoke) store.revokeToken(name!);
    else log(JSON.stringify(kind === "actor" ? store.actors() : store.tokens()));
  } finally { store.close(); }
}
