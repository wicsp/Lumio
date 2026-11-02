import { RuntimeInfo, RuntimeRegistration, idOf } from "@lumio/schema";
import { ExecutionError } from "./jobs.ts";

export type RuntimeRecord = Pick<RuntimeInfo, "actor" | "registration" | "last_seen">;
export interface RuntimeRegistryStore {
  byActor(actor: string): RuntimeRecord | undefined;
  byName(name: string): RuntimeRecord | undefined;
  list(): RuntimeRecord[];
  save(record: RuntimeRecord): void;
  touch(actor: string, time: string): boolean;
  transaction<T>(action: () => T): T;
}
/** Execution owns device names, capabilities and online status; authentication remains with the host. */
export class ExecutionRuntimes {
  constructor(private readonly store: RuntimeRegistryStore) {}
  register(actor: string, input: unknown, now: Date): RuntimeInfo {
    const parsed = RuntimeRegistration.safeParse(input);
    if (!parsed.success || !idOf("act").safeParse(actor).success) throw new ExecutionError("INVALID", "执行器登记内容不合法");
    const registration = parsed.data;
    return this.store.transaction(() => {
      const existing = this.store.byActor(actor);
      if (existing && existing.registration.name !== registration.name) throw new ExecutionError("CONFLICT", "同一执行器身份不能更换名称");
      const named = this.store.byName(registration.name);
      if (named && named.actor !== actor) throw new ExecutionError("CONFLICT", "执行器名称已被另一身份使用");
      const value = { actor, registration, last_seen: now.toISOString() }; this.store.save(value);
      return RuntimeInfo.parse({ ...value, online: true });
    });
  }
  sync(actor: string, now: Date): void {
    if (!this.store.touch(actor, now.toISOString())) throw new ExecutionError("NOT_FOUND", "执行器尚未登记");
  }
  list(now: Date): RuntimeInfo[] {
    return this.store.list().sort((a, b) => a.registration.name < b.registration.name ? -1 : a.registration.name > b.registration.name ? 1 : 0)
      .map((value) => RuntimeInfo.parse({ ...value, online: now.getTime() - Date.parse(value.last_seen) <= 180_000 }));
  }
}
