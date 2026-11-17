import { NativeAccountBinding, type AgentRun, type Job, type JobAccount, type RuntimeInfo } from "@lumio/schema";
import { HubError } from "./errors.ts";
import type { HubStore } from "./store.ts";

export type JobAccountSelection = { owner: string; connection?: string };
type Binding = Omit<JobAccount, "job">;
const unavailable = (key: "jobs.interaction_unavailable" | "jobs.account_unavailable" | "jobs.choose_account") =>
  new HubError("INVALID", { key, args: [] });

function accountBinding(store: HubStore, runtime: RuntimeInfo, owner: string, id: string): Binding | undefined {
  const connection = store.aiStore.connection(id);
  if (!connection || connection.owner !== owner || connection.kind !== "codex-account" || connection.host !== runtime.registration.name) return;
  const value = store.aiStore.quota(id).binding;
  if (!value) return;
  let stored: unknown;
  try { stored = JSON.parse(value); } catch { return; }
  if (!Array.isArray(stored) || stored.length !== 3) return;
  const [actor, account, generation] = stored;
  const binding = NativeAccountBinding.safeParse({ account, generation });
  if (actor !== runtime.actor || !binding.success) return;
  return { ...binding.data, connection: id, owner, revision: connection.revision };
}

function accounts(store: HubStore, runtime: RuntimeInfo, owner: string) {
  return store.aiStore.connections(owner).flatMap(connection => {
    const binding = accountBinding(store, runtime, owner, connection.id);
    return binding ? [{ binding, id: connection.id, name: connection.name }] : [];
  });
}

export function jobCodexConnections(store: HubStore, runtime: RuntimeInfo, owner: string) {
  if (!runtime.online || !store.jobActivity.engines(runtime.actor).some(cap => cap.engine === "codex" && cap.account_reuse)) return;
  return accounts(store, runtime, owner).map(({ id, name }) => ({ id, name }));
}

export function authorizeJobAccount(store: HubStore, runtime: RuntimeInfo, run: AgentRun, selection?: JobAccountSelection): Binding | undefined {
  if (!run.interaction || run.engine !== "codex") {
    if (selection?.connection) throw unavailable("jobs.account_unavailable");
    return;
  }
  const cap = store.jobActivity.engines(runtime.actor).find(value => value.engine === run.engine &&
    value.version === runtime.registration.engines.find(engine => engine.name === run.engine)?.version);
  if (cap?.account_reuse && selection && runtime.online && run.permissions?.access !== "full") {
    if (selection.connection) {
      const binding = accountBinding(store, runtime, selection.owner, selection.connection);
      if (!binding) throw unavailable("jobs.account_unavailable");
      return binding;
    }
    const candidates = accounts(store, runtime, selection.owner);
    if (candidates.length > 1) throw unavailable("jobs.choose_account");
    if (candidates.length === 1) return candidates[0]!.binding;
  }
  if (selection?.connection || (cap?.account_reuse && !cap.approvals && selection)) throw unavailable("jobs.account_unavailable");
}

export function jobAccountCurrent(store: HubStore, binding: JobAccount, runtime: RuntimeInfo) {
  if (store.jobActivity.accountRevoked(binding.job)) return false;
  const current = accountBinding(store, runtime, binding.owner, binding.connection);
  return !!current && current.revision === binding.revision && current.account === binding.account && current.generation === binding.generation;
}

export function sameJobAccount(store: HubStore, previous: Job, binding?: Binding): boolean {
  const prior = store.jobActivity.account(previous.spec.id);
  if (!binding) return !prior;
  return !!prior && !store.jobActivity.accountRevoked(previous.spec.id)
    && prior.connection === binding.connection && prior.owner === binding.owner
    && prior.account === binding.account && prior.generation === binding.generation;
}
