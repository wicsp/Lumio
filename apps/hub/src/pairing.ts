import { createHash, randomBytes } from "node:crypto";
import { ClientInvite, ClientInviteRequest, ClientJoin, ClientJoinRequest, HubSigningKey, RuntimeInvite, RuntimeInviteRequest, RuntimeJoin, RuntimeJoinRequest, RuntimeName, signingKeyFingerprint } from "@lumio/schema";
import type { authorize, PairingOperation } from "./authorize.ts";
import type { HubConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import type { Privileged } from "./privileged.ts";
import type { HubStore, Identity } from "./store.ts";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
const quote = (value: string) => /^[a-zA-Z0-9:/._-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
function pairingCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, result = "";
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
export function signingKey(publicKey: string): HubSigningKey {
  return HubSigningKey.parse({ public_key: publicKey, fingerprint: signingKeyFingerprint(createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex")) });
}

/** Shared, atomic single-use credentials; never retain the plaintext pairing code. */
export class Pairing {
  private failures: number[] = [];
  private blockedUntil = 0;
  constructor(private store: HubStore, private config: Pick<HubConfig, "publicUrl">, private now: () => Date = () => new Date()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS pairing_codes (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      actor TEXT NOT NULL REFERENCES actors(id), expires TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);`);
  }
  invite(kind: "runtime" | "client", name: string, identity: Identity) {
    const url = this.config.publicUrl;
    if (!url) throw new HubError("INVALID", "Hub 还没有对外地址：服务器模式用 lumio-hub setup --server 设置；单机模式想让别的机器连进来，也需要先设置一个它们能访问的地址（如 Tailscale 地址）");
    return this.store.db.transaction(() => {
      let actor = identity.actor;
      if (kind === "runtime") {
        const existing = this.store.actors().find((a) => a.name === name);
        if (existing && existing.role !== "runtime") throw new HubError("CONFLICT", "名称已被其他角色的身份使用");
        actor = existing ?? this.store.createActor(name, "runtime");
        const registered = this.store.runtimes(this.now()).find((r) => r.registration.name === name || r.actor === actor.id);
        if (registered && (registered.actor !== actor.id || registered.registration.name !== name)) throw new HubError("CONFLICT", "执行器登记名称与身份不一致");
      }
      const code = pairingCode(), expires = new Date(this.now().getTime() + 600_000).toISOString();
      this.store.db.query("UPDATE pairing_codes SET used=1 WHERE kind=? AND actor=? AND name=? AND used=0").run(kind, actor.id, name);
      this.store.db.query("INSERT INTO pairing_codes(hash,kind,name,actor,expires) VALUES (?,?,?,?,?)").run(hash(code), kind, name, actor.id, expires);
      this.store.audit(identity, JSON.stringify({ operation: `${kind}.invite`, name, actor: actor.id }), "allow", undefined, "applied");
      const common = { name, code, expires, hub_url: url };
      return kind === "runtime" ? RuntimeInvite.parse({ ...common, actor: actor.id,
        command: `curl -fsSL https://raw.githubusercontent.com/wicsp/Lumio/main/install.sh | sh -s -- runtime --hub ${quote(url)} --code ${code}` })
        : ClientInvite.parse({ ...common, command: `lumio login ${quote(url)} --code ${code}` });
    })();
  }
  join(kind: "runtime" | "client", code?: string) {
    const now = this.now().getTime();
    const invalid = () => new HubError("UNAUTHENTICATED", "配对失败：请生成新的配对码后重试");
    if (now < this.blockedUntil) throw invalid();
    this.failures = this.failures.filter((at) => at > now - 60_000);
    return this.store.db.transaction(() => {
      const row = code ? this.store.db.query<{ name: string; actor: string; expires: string; used: number }, [string, string]>(
        "SELECT name,actor,expires,used FROM pairing_codes WHERE hash=? AND kind=?").get(hash(code), kind) : null;
      if (!row || row.used || Date.parse(row.expires) <= now) {
        this.failures.push(now);
        if (this.failures.length >= 10) this.blockedUntil = now + 60_000;
        throw invalid();
      }
      this.store.db.query("UPDATE pairing_codes SET used=1 WHERE hash=?").run(hash(code!));
      const actor = this.store.actors().find((a) => a.id === row.actor)!;
      if (kind === "runtime") this.revokeActor(actor.id);
      const label = kind === "runtime" ? `runtime-${row.name}-${this.now().toISOString().slice(0, 10)}` : row.name;
      // A label is not an identity: another human's identically named client must keep its credential.
      const collision = this.store.tokens().find((t) => t.label === label);
      if (collision) this.store.db.query("UPDATE tokens SET label=? WHERE label=?").run(`${label}#${crypto.randomUUID()}`, label);
      const token = this.store.createToken(label, actor.name);
      this.store.audit({ actor, label }, `${kind}.join`, "allow", undefined, "applied");
      return kind === "runtime" ? RuntimeJoin.parse({ name: row.name, actor: actor.id, token }) : ClientJoin.parse({ actor: actor.id, token });
    })();
  }
  private revokeActor(actor: string) {
    for (const token of this.store.tokens().filter((t) => t.actor_id === actor && !t.revoked)) this.store.revokeToken(token.label);
  }
  remove(name: string, identity: Identity) {
    this.store.db.transaction(() => {
      const actor = this.store.actors().find((a) => a.name === name && a.role === "runtime");
      if (!actor) throw new HubError("NOT_FOUND", "执行器身份不存在");
      this.revokeActor(actor.id);
      this.store.db.query("UPDATE pairing_codes SET used=1 WHERE actor=? AND kind='runtime'").run(actor.id);
      this.store.audit(identity, JSON.stringify({ operation: "runtime.remove", name, actor: actor.id }), "allow", undefined, "applied");
    })();
  }
}

export async function handlePairing(request: Request, operation: PairingOperation, name: string | undefined,
  identity: Identity | null, store: HubStore, decide: typeof authorize, pairing: Pairing, privileged: Privileged) {
  const decision = decide(identity?.actor ?? null, { operation });
  if (decision.result !== "allow") {
    if (identity) store.auditDenied(identity, operation);
    throw new HubError("FORBIDDEN", "请求未获授权");
  }
  if (operation === "runtime.signing-key") return Response.json(signingKey(privileged.publicKey()));
  if (operation === "runtime.remove") {
    let decoded: string;
    try { decoded = decodeURIComponent(name!); } catch { throw new HubError("INVALID", "执行器名称不合法"); }
    if (!RuntimeName.safeParse(decoded).success) throw new HubError("INVALID", "执行器名称不合法");
    pairing.remove(decoded, identity!); return new Response(null, { status: 204 });
  }
  let body: unknown; try { body = await request.json(); } catch { /* joins always use the same 401 */ }
  if (operation === "runtime.join" || operation === "client.join") {
    const kind = operation === "runtime.join" ? "runtime" : "client";
    const parsed = (kind === "runtime" ? RuntimeJoinRequest : ClientJoinRequest).safeParse(body);
    return Response.json(pairing.join(kind, parsed.success ? parsed.data.code : undefined));
  }
  const kind = operation === "runtime.invite" ? "runtime" : "client";
  const parsed = (kind === "runtime" ? RuntimeInviteRequest : ClientInviteRequest).safeParse(body);
  if (!parsed.success) throw new HubError("INVALID", "配对邀请内容不合法");
  return Response.json(pairing.invite(kind, parsed.data.name, identity!));
}
