import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { Operation, PrivilegedApproval, PrivilegedReport, PrivilegedStatus, privilegedSigningPayload } from "../src/index.ts";

// ADR 0020：批准凭据的格式与签名内容。
const U = "01M5AAAAAAAAAAAAAAAAAAAAA1";
const grant = { proposal: `prop_${U}`, runtime: `act_${U}`, job: `job_${U}`, argv: ["/usr/bin/apt-get", "install", "-y", "htop"],
  approved_by: `act_01M5AAAAAAAAAAAAAAAAAAAAH1`, approved_at: "2026-10-26T10:00:00Z", expires: "2026-10-26T10:10:00Z" };

test("exec.privileged is a strict operation", () => {
  expect(Operation.parse({ op: "exec.privileged", args: { runtime: grant.runtime, job: grant.job, argv: grant.argv } }).op).toBe("exec.privileged");
  expect(Operation.safeParse({ op: "exec.privileged", args: { runtime: grant.runtime, job: grant.job, argv: [] } }).success).toBe(false);
  expect(Operation.safeParse({ op: "exec.privileged", args: { runtime: grant.runtime, job: grant.job, argv: ["x"], shell: true } }).success).toBe(false);
});

test("the signing payload is fixed-order and covers every field; signatures verify only for the exact grant", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = privilegedSigningPayload(grant);
  expect(payload).toBe(JSON.stringify(["lumio-privileged-v1", grant.proposal, grant.runtime, grant.job, grant.argv, grant.approved_by, grant.approved_at, grant.expires]));
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  const approval = PrivilegedApproval.parse({ ...grant, signature });
  expect(verify(null, Buffer.from(privilegedSigningPayload(approval)), publicKey, Buffer.from(approval.signature, "base64url"))).toBe(true);
  for (const changed of [{ argv: ["/bin/sh", "-c", "id"] }, { runtime: `act_01M5AAAAAAAAAAAAAAAAAAAAB2` }, { expires: "2026-10-27T10:10:00Z" }]) {
    expect(verify(null, Buffer.from(privilegedSigningPayload({ ...grant, ...changed })), publicKey, Buffer.from(signature, "base64url"))).toBe(false);
  }
  expect(PrivilegedApproval.safeParse({ ...grant, signature: "short" }).success).toBe(false);
  expect(PrivilegedApproval.safeParse({ ...grant, signature, extra: 1 }).success).toBe(false);
});

test("status carries an approval only when accepted; reports never carry output", () => {
  expect(PrivilegedStatus.safeParse({ proposal: grant.proposal, status: "accepted" }).success).toBe(false);
  expect(PrivilegedStatus.safeParse({ proposal: grant.proposal, status: "pending", approval: {} }).success).toBe(false);
  expect(PrivilegedStatus.parse({ proposal: grant.proposal, status: "expired" }).status).toBe("expired");
  expect(PrivilegedReport.parse({ proposal: grant.proposal, job: grant.job, status: "done", exit_code: 0, finished: "2026-10-26T10:01:00Z" }).exit_code).toBe(0);
  expect(PrivilegedReport.safeParse({ proposal: grant.proposal, job: grant.job, status: "done", finished: "2026-10-26T10:01:00Z", stdout: "x" }).success).toBe(false);
});
