import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "@lumio/schema";
import { startHub } from "../src/server.ts";
import { readConfig } from "../src/config.ts";

test("Hub request languages remain independent, including library errors, without changing codes", async () => {
  const state = await mkdtemp(join(tmpdir(), "lumio-i18n-")), logs: string[] = [];
  const saved = process.env.LUMIO_LANG; process.env.LUMIO_LANG = "zh";
  const hub = await startHub({ ...readConfig({ LUMIO_STATE_DIR: state }), port: 0 }, { log: line => logs.push(line) });
  try {
    hub.store.createActor("synthetic-owner", "human");
    const token = hub.store.createToken("synthetic-token", "synthetic-owner");
    const url = hub.server.url.href.replace(/\/$/, "");
    await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const language = index % 2 ? "zh-CN" : "en";
      const response = await fetch(`${url}/v2/work/tasks/task_00000000000000000000000001`, { headers: { Authorization: `Bearer ${token}`, "Accept-Language": language } });
      const error = ApiError.parse(await response.json()).error;
      expect(response.status).toBe(404); expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe(language === "en" ? "Task not found" : "找不到任务");
    }));
    for (const language of [undefined, "en", "zh-CN", "fr"] as const) {
      const response = await fetch(`${url}/v1/search`, { headers: language ? { "Accept-Language": language } : {} });
      const error = ApiError.parse(await response.json()).error;
      expect(error.code).toBe("UNAUTHENTICATED");
      expect(error.message).toBe(language === "zh-CN" ? "需要有效的 Bearer 令牌" : "A valid Bearer token is required");
    }
    expect(logs.length).toBeGreaterThan(0); expect(logs.some(line => /\p{Script=Han}/u.test(line))).toBe(false);
  } finally {
    await hub.stop(); await rm(state, { recursive: true, force: true });
    if (saved === undefined) delete process.env.LUMIO_LANG; else process.env.LUMIO_LANG = saved;
  }
});
