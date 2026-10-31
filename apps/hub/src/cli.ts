import { signingKey } from "./pairing.ts";
import { Privileged } from "./privileged.ts";
import { parseArgs } from "node:util";
import { ActorRole } from "@lumio/schema";
import { backupHub } from "./backup.ts";
import { stateDirectory } from "./config.ts";
import { HubError } from "./errors.ts";
import { HubStore } from "./store.ts";
import { backupBusiness, restoreBusiness, verifyBusinessBackup, StorageError } from "@lumio/storage";

export async function runManagement(args: string[], log: (line: string) => void = console.log): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { role: { type: "string" }, actor: { type: "string" } } });
  const [kind, action, name] = positionals;
  if ((kind === "backup" && ["business", "verify"].includes(action ?? "")) || kind === "restore") {
    if (Object.keys(values).length || !name || (kind === "backup" ? positionals.length !== 3 : action !== "business" || positionals.length !== 4)) throw new HubError("INVALID", "用法：backup business <新备份目录>；backup verify <备份目录>；restore business <备份目录> <新状态目录>");
    try {
      const manifest = kind === "restore" ? await restoreBusiness(name, positionals[3]!) : action === "verify" ? await verifyBusinessBackup(name) : await backupBusiness(stateDirectory(), name);
      log(JSON.stringify(manifest)); return;
    } catch (cause) {
      if (cause instanceof StorageError) throw new HubError(cause.code === "CORRUPT" ? "INVALID" : cause.code, cause.message);
      throw cause;
    }
  }
  if (kind === "backup") {
    if (positionals.length !== 2 || !action || Object.keys(values).length) throw new HubError("INVALID", "用法：backup <目标文件>");
    await backupHub(stateDirectory(), action);
    log(action);
    return;
  }
  if (kind === "signing-key" && positionals.length === 1 && !Object.keys(values).length) {
    const store = await HubStore.open(stateDirectory());
    try { const key = signingKey(new Privileged(store).publicKey()); log(`${key.public_key}\n指纹：${key.fingerprint}`); } finally { store.close(); }
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
