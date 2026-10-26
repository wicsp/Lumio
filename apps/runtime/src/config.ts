import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JOB_PROTOCOL_VERSION, RuntimeRegistration } from "@lumio/schema";

export class RuntimeError extends Error {
  readonly code = "INVALID";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!env.LUMIO_HUB_URL || !env.LUMIO_TOKEN) throw new RuntimeError("请设置非空的 LUMIO_HUB_URL 和 LUMIO_TOKEN");
  let url: URL;
  try { url = new URL(env.LUMIO_HUB_URL); } catch { throw new RuntimeError("LUMIO_HUB_URL 必须是 HTTP(S) 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RuntimeError("LUMIO_HUB_URL 必须是无凭据、查询或片段的 HTTP(S) 地址");
  }
  const registration = RuntimeRegistration.safeParse({
    protocol_version: JOB_PROTOCOL_VERSION, name: env.LUMIO_RUNTIME_NAME, engines: [],
    tags: env.LUMIO_RUNTIME_TAGS ? env.LUMIO_RUNTIME_TAGS.split(",").map((tag) => tag.trim()) : [],
    max_concurrent: Number(env.LUMIO_RUNTIME_MAX_CONCURRENT ?? 1),
  });
  if (!registration.success) throw new RuntimeError("LUMIO_RUNTIME_NAME、LUMIO_RUNTIME_TAGS 或 LUMIO_RUNTIME_MAX_CONCURRENT 不合法");
  const pollSeconds = Number(env.LUMIO_RUNTIME_POLL_SECONDS ?? 5);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || pollSeconds * 1000 > 2_147_483_647) {
    throw new RuntimeError("LUMIO_RUNTIME_POLL_SECONDS 必须是有效的正秒数");
  }
  if (env.LUMIO_RUNTIME_STATE_DIR === "") throw new RuntimeError("LUMIO_RUNTIME_STATE_DIR 不能为空");
  return { url: url.href.replace(/\/+$/, ""), token: env.LUMIO_TOKEN, registration: registration.data, pollSeconds,
    stateDir: resolve(env.LUMIO_RUNTIME_STATE_DIR ?? join(homedir(), ".local", "share", "lumio-runtime")) };
}
export type RuntimeConfig = ReturnType<typeof readConfig>;
