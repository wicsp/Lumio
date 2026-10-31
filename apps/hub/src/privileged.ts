import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { isAbsolute } from "node:path";
import { PrivilegedApproval, PrivilegedReport, PrivilegedStatus, privilegedSigningPayload, type Operation, type Proposal } from "@lumio/schema";
import { Jobs } from "./jobs.ts";
import { HubError } from "./errors.ts";
import type { HubStore, Identity } from "./store.ts";
import type { authorize } from "./authorize.ts";

export class Privileged {
  constructor(private store: HubStore, private now: () => Date = () => new Date()) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS signing_key (id INTEGER PRIMARY KEY CHECK(id=1), private_key TEXT NOT NULL, public_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS privileged_approvals (proposal TEXT PRIMARY KEY REFERENCES proposals(id), approval TEXT NOT NULL, report TEXT);`);
    if (!store.db.query("SELECT 1 FROM signing_key WHERE id=1").get()) {
      const keys = generateKeyPairSync("ed25519");
      const raw = keys.publicKey.export({ format: "jwk" });
      store.db.query("INSERT OR IGNORE INTO signing_key VALUES (1,?,?)").run(
        keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), raw.x!);
    }
  }
  publicKey(): string { return this.store.db.query<{ public_key: string }, []>("SELECT public_key FROM signing_key WHERE id=1").get()!.public_key; }
  private live(runtime: string, id: string): boolean {
    return new Jobs(this.store).live(runtime, id);
  }
  validate(operation: Extract<Operation, { op: "exec.privileged" }>, actor: string) {
    if (operation.args.runtime !== actor) throw new HubError("INVALID", "执行器身份不匹配");
    if (!isAbsolute(operation.args.argv[0]!) || operation.args.argv.some((arg) => arg.includes("\0"))) throw new HubError("INVALID", "程序必须是绝对路径且参数不能含 NUL");
    if (!this.live(actor, operation.args.job)) throw new HubError("CONFLICT", "这一轮未在执行或已取消");
    const pending = this.store.proposals("pending", actor).filter((p) => p.operation.op === "exec.privileged" && p.operation.args.job === operation.args.job);
    if (pending.length >= 5) throw new HubError("CONFLICT", "同一轮最多同时等待 5 个批准");
  }
  approve(proposal: Proposal, approver: Identity) {
    if (proposal.operation.op !== "exec.privileged") throw new HubError("INVALID", "不是高权限命令提议");
    const args = proposal.operation.args;
    if (!this.live(args.runtime, args.job)) {
      this.store.decideProposal(proposal.id, "rejected", approver.actor.id);
      this.store.audit(approver, JSON.stringify(proposal.operation), "allow", proposal.id, "expired");
      throw new HubError("CONFLICT", "这一轮已结束或已取消，提议已失效");
    }
    const now = this.now();
    const grant = { proposal: proposal.id, ...args, approved_by: approver.actor.id, approved_at: now.toISOString(), expires: new Date(now.getTime() + 600_000).toISOString() };
    const key = this.store.db.query<{ private_key: string }, []>("SELECT private_key FROM signing_key WHERE id=1").get()!;
    const approval = PrivilegedApproval.parse({ ...grant, signature: sign(null, Buffer.from(privilegedSigningPayload(grant)), createPrivateKey(key.private_key)).toString("base64url") });
    this.store.db.query("INSERT INTO privileged_approvals(proposal,approval) VALUES (?,?)").run(proposal.id, JSON.stringify(approval));
  }
  private owned(id: string, actor: string) {
    const proposal = this.store.proposal(id);
    if (!proposal || proposal.author !== actor || proposal.operation.op !== "exec.privileged" || proposal.operation.args.runtime !== actor) throw new HubError("NOT_FOUND", "提议不存在");
    return proposal;
  }
  status(id: string, actor: string): PrivilegedStatus {
    const p = this.owned(id, actor);
    if (p.operation.op !== "exec.privileged") throw new HubError("NOT_FOUND", "提议不存在");
    if (!this.live(actor, p.operation.args.job)) return PrivilegedStatus.parse({ proposal: id, status: "expired" });
    if (p.status !== "accepted") return PrivilegedStatus.parse({ proposal: id, status: p.status });
    const approval = PrivilegedApproval.parse(JSON.parse(this.store.db.query<{ approval: string }, [string]>("SELECT approval FROM privileged_approvals WHERE proposal=?").get(id)!.approval));
    return PrivilegedStatus.parse(Date.parse(approval.expires) <= this.now().getTime() ? { proposal: id, status: "expired" } : { proposal: id, status: "accepted", approval });
  }
  report(raw: unknown, identity: Identity) {
    const parsed = PrivilegedReport.safeParse(raw);
    if (!parsed.success) throw new HubError("INVALID", "高权限命令回报不合法");
    const report = parsed.data;
    const p = this.owned(report.proposal, identity.actor.id);
    if (p.operation.op !== "exec.privileged" || p.operation.args.job !== report.job || p.status !== "accepted") throw new HubError("CONFLICT", "回报与批准不匹配");
    this.store.db.transaction(() => {
      const row = this.store.db.query<{ report: string | null }, [string]>("SELECT report FROM privileged_approvals WHERE proposal=?").get(report.proposal);
      if (!row) throw new HubError("CONFLICT", "缺少批准凭据");
      if (row.report) {
        if (row.report !== JSON.stringify(report)) throw new HubError("CONFLICT", "已有不同回报");
        return;
      }
      this.store.db.query("UPDATE privileged_approvals SET report=? WHERE proposal=?").run(JSON.stringify(report), report.proposal);
      // 不把 error 自由文本或任何输出写入审计。
      this.store.audit(identity, JSON.stringify(p.operation), "allow", p.id, JSON.stringify({ status: report.status, exit_code: report.exit_code, started: report.started, finished: report.finished }));
    })();
    return report;
  }
}

export async function handlePrivileged(request: Request, operation: "runtime.privileged.status" | "runtime.privileged.report", id: string | undefined,
  identity: Identity, store: HubStore, decide: typeof authorize, privileged: Privileged) {
  const decision = decide(identity.actor, { operation });
  if (decision.result !== "allow") { store.auditDenied(identity, operation); throw new HubError("FORBIDDEN", "请求未获授权"); }
  if (operation === "runtime.privileged.status") return Response.json(privileged.status(id!, identity.actor.id));
  let body: unknown; try { body = await request.json(); } catch { throw new HubError("INVALID", "请求体必须是 JSON"); }
  return Response.json(privileged.report(body, identity));
}
