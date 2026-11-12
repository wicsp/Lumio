import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError, SecurityReviewRequest, SecurityReviewResult, WorkCommandResult } from "@lumio/schema";
import { readConfig } from "../src/config.ts";
import { startHub } from "../src/server.ts";

test("security review requires a human, respects note privacy, and reports positions without content", async () => {
  const root = await mkdtemp(join(tmpdir(), "lumio-security-review-")), vault = join(root, "vault");
  await cp(new URL("../../../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });
  const asset = "ast_00000000000000000000000007";
  const card = "4111 1111 1111 1111", key = "sk-" + "synthetic".repeat(4), privateKeyHeader = "-----BEGIN PRIVATE KEY-----";
  const assetFile = join(vault, "life/assets/Private.md");
  const hub = await startHub(readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: join(root, "state"), LUMIO_HUB_LISTEN: "127.0.0.1:0" }), { log() {} });
  try {
    const tokens = Object.fromEntries((["human", "agent", "runtime"] as const).map(role => {
      hub.store.createActor(role, role);
      return [role, hub.store.createToken(role, role)];
    }));
    const post = (path: string, body: unknown, token = tokens.human) => fetch(new URL(path, hub.server.url), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const review = (body: unknown, token?: string) => post("/v2/security/review", body, token);
    const input = SecurityReviewRequest.parse({ kind: "note", ref: asset, include_private: true });
    expect((await review({ ...input, include_private: false })).status).toBe(404);
    for (const token of [tokens.agent, tokens.runtime]) {
      const denied = await review(input, token);
      expect(denied.status).toBe(403);
      expect(ApiError.parse(await denied.json()).error.code).toBe("FORBIDDEN");
    }
    expect((await review(input, "invalid-token")).status).toBe(401);
    expect((await review({ ...input, path: "../outside.md" })).status).toBe(400);

    // Edit after the index has been built, so review must read the current file.
    const note = (await readFile(assetFile, "utf8")).trimEnd();
    const updated = [note, `ID ${card}`, key, privateKeyHeader, "4111 1111 1111 1112", ""].join("\n");
    await writeFile(assetFile, updated);
    const response = await review(input);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const result = SecurityReviewResult.parse(JSON.parse(raw));
    const firstLine = note.split("\n").length + 1;
    expect(result).toEqual({ resource: input, truncated: false, findings: [
      { field: "file", line: firstLine, column: 4, reason: "possible-card-number" },
      { field: "file", line: firstLine + 1, column: 1, reason: "possible-api-key" },
      { field: "file", line: firstLine + 2, column: 1, reason: "possible-private-key" },
    ] });
    for (const value of [card, key, privateKeyHeader]) expect(raw).not.toContain(value);
    expect(await readFile(assetFile, "utf8")).toBe(updated);

    const task = WorkCommandResult.parse(await (await post("/v2/work/commands", {
      request_id: randomUUID(), operation: { op: "work.task.create", args: { title: "Synthetic review task", description: `Order: ${card}` } },
    })).json());
    if (task.kind !== "task") throw new Error("expected a task");
    const comment = WorkCommandResult.parse(await (await post("/v2/work/commands", {
      request_id: randomUUID(), operation: { op: "work.task.comment", args: { task: task.task.id, body: key } },
    })).json());
    if (comment.kind !== "comment") throw new Error("expected a comment");
    const taskResult = SecurityReviewResult.parse(await (await review({ kind: "task", ref: task.task.id })).json());
    expect(taskResult.findings).toEqual([
      { field: "description", line: 1, column: 8, reason: "possible-card-number" },
      { field: "comment", comment: comment.comment.id, line: 1, column: 1, reason: "possible-api-key" },
    ]);
  } finally {
    await hub.stop();
    await rm(root, { recursive: true, force: true });
  }
});
