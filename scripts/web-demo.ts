#!/usr/bin/env bun
/**
 * Web 工作台试用：一条命令启动「临时 Hub + 合成数据 + Web」，不碰已安装的 Hub 和真实 vault。
 *
 *   bun run demo:web
 *
 * - vault 复制自 fixtures/query-vault，状态放在系统临时目录，退出（Ctrl+C）时删除。
 * - Hub 与网页共用 127.0.0.1:7499，不占用正式 Hub 的 7420。
 * - 助手用本地假模型（只回放固定文字），不调用任何真实模型或 agent。
 * - 合成执行器「demo」上报了完成、失败、等待回答、运行中与排队的几轮，用来看执行页面。
 */
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../packages/api-client/src/index.ts";
import { HubStore } from "../apps/hub/src/store.ts";
import { readConfig } from "../apps/hub/src/config.ts";
import { startHub } from "../apps/hub/src/server.ts";
import { buildWebAssets, webFiles, WEB_CSP } from "../apps/web/src/entry.ts";

const HUB = "127.0.0.1:7499";
const root = await mkdtemp(join(tmpdir(), "lumio-web-demo-"));
const vault = join(root, "vault"), state = join(root, "state");
await cp(new URL("../fixtures/query-vault", import.meta.url).pathname, vault, { recursive: true });

const store = await HubStore.open(state);
const human = store.createActor("demo", "human");
const token = store.replaceToken("web-demo", human.name);
store.createActor("demo-runtime", "runtime");
const runtimeToken = store.replaceToken("demo-runtime", "demo-runtime");
store.close();

const fakeModel = {
  async complete(input: { messages: Array<{ content: string }> }, options: { token(text: string): void }) {
    const last = String(input.messages.at(-1)?.content ?? "").slice(0, 40);
    const text = `（演示用假模型）关于「${last}」，可以这样推进：\n\n1. 先看相关任务的当前状态；\n2. 确认负责人和截止时间；\n3. 需要时把下一步写进任务讨论。`;
    for (const piece of text.match(/.{1,6}/gsu) ?? []) { options.token(piece); await Bun.sleep(25); }
    return { content: text, tool_calls: [] };
  },
};

const hub = await startHub(readConfig({ LUMIO_VAULT: vault, LUMIO_STATE_DIR: state, LUMIO_HUB_LISTEN: HUB }), { web: { files: webFiles(await buildWebAssets(), { apiBase: "" }), csp: WEB_CSP }, assistantModel: fakeModel, log: () => {} });

const stop = async () => { await hub.stop().catch(() => {}); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

// ───────────── 合成数据 ─────────────
const api = createClient({ url: `http://${HUB}`, token });
let n = 0;
const rid = () => `demo-${Date.now()}-${String(n++).padStart(6, "0")}`;
const command = async (operation: unknown) => await api.workCommand({ request_id: rid(), operation } as Parameters<typeof api.workCommand>[0]) as any;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const paper = (await command({ op: "work.project.create", args: { title: "论文 rebuttal", goal: "在讨论期内完成 rebuttal 与补充实验", tags: ["research"],
  description: "## 背景\n\n审稿意见集中在 **泛化性** 与 *统计显著性*。\n\n- 补 3 个模型族\n- 补 bootstrap 置信区间" } })).project;
const lumio = (await command({ op: "work.project.create", args: { title: "Lumio v0.2", goal: "四个模块分离上线", repo: "https://github.com/wicsp/Lumio" } })).project;
await command({ op: "work.project.create", args: { title: "博士开题", goal: "12 月前提交开题报告" } });

const seed: Array<[string, string | undefined, string, string?, number?]> = [
  ["补充三个模型族的实验", paper.id, "active", "codex@demo", 3],
  ["整理审稿人 R2 的问题清单", paper.id, "done"],
  ["计算 bootstrap 95% 置信区间", paper.id, "todo", "pi@demo", 2],
  ["起草 rebuttal 第一版", paper.id, "waiting", undefined, 6],
  ["迁移脚本 dry-run 验证", lumio.id, "todo", undefined, 1],
  ["写 v0.2 发布说明", lumio.id, "paused", undefined, 9],
  ["续费域名", undefined, "todo", undefined, -1],
];
const tasks: Record<string, any> = {};
for (const [title, project, status, assignee, due] of seed) {
  tasks[title] = (await command({ op: "work.task.create", args: { title, status, ...(project ? { project } : {}), ...(assignee ? { assignee } : {}),
    ...(due !== undefined ? { due: inDays(due) } : {}), description: "完成标准写在这里，支持 **Markdown**。\n\n```bash\npython run.py --seeds 5\n```" } })).task;
}
await command({ op: "work.task.comment", args: { task: tasks["补充三个模型族的实验"].id, body: "第一个模型已经跑完，另外两个还在排队。" } });

// 合成执行器：登记、领取并上报几轮结果。
const runtime = async (path: string, body: unknown) => {
  const response = await fetch(`http://${HUB}${path}`, { method: "POST", headers: { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<any>;
};
await runtime("/v1/runtime/register", { protocol_version: 2, name: "demo", engines: [{ name: "codex", version: "demo", sandbox: "os" }, { name: "pi", version: "demo", sandbox: "none" }], tags: ["gpu:4"], max_concurrent: 2 });
const dispatch = async (title: string, to: string) => {
  const task = (await api.workTask(tasks[title].id)).task;
  return (await command({ op: "work.task.dispatch", args: { task: task.id, to, expected_revision: task.revision } })).job;
};
const jobs = [await dispatch("补充三个模型族的实验", "codex@demo"), await dispatch("计算 bootstrap 95% 置信区间", "pi@demo"), await dispatch("迁移脚本 dry-run 验证", "codex@demo")];
const sync = await runtime("/v1/runtime/sync", { running: [], queued: [], outbox: 0 });
await runtime("/v1/runtime/ack", { accepted: sync.jobs.map((job: any) => job.id) });
await runtime("/v1/runtime/sync", { running: sync.jobs.map((job: any) => job.id), queued: [], outbox: 0 });
const lease = (id: string) => sync.jobs.find((job: any) => job.id === id).lease;
const now = new Date().toISOString();
await runtime("/v1/runtime/results", { job: jobs[0].spec.id, lease: lease(jobs[0].spec.id), status: "done", exit_code: 0, started: now, finished: now,
  report: "## 结果\n\n| 设置 | 成功率 |\n|---|---|\n| A | 41.2% |\n| B | 37.9% |\n| C | 52.6% |\n\n另外两个模型还在排队。" });
await runtime("/v1/runtime/results", { job: jobs[1].spec.id, lease: lease(jobs[1].spec.id), status: "waiting_for_human", started: now, finished: now, question: "重采样用 1000 次还是 10000 次？后者大约要 40 分钟。" });
await dispatch("补充三个模型族的实验", "codex@demo"); // 第 2 轮，保持排队

console.log(`
Lumio Web 试用已启动（临时数据，不影响已安装的 Hub）

  打开：      http://${HUB}
  访问令牌：  ${token}

在连接页点「使用已有的访问令牌」，粘贴上面的令牌。按 Ctrl+C 结束并删除临时数据。
`);
