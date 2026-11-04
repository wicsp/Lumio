#!/usr/bin/env bun
import { text as msg } from "../apps/cli/src/messages.ts";
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
    const text = msg("web-demo.demo_model_here_is_how_to_move_forward_with_1_review_the_related_tas", last);
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

const paper = (await command({ op: "work.project.create", args: { title: msg("web-demo.paper_rebuttal"), goal: msg("web-demo.complete_the_rebuttal_and_additional_experiments_during_discussion"), tags: ["research"],
  description: msg("web-demo.background_reviews_focus_on_generalization_and_statistical_significa") } })).project;
const lumio = (await command({ op: "work.project.create", args: { title: "Lumio v0.2", goal: msg("web-demo.launch_four_separate_modules"), repo: "https://github.com/wicsp/Lumio" } })).project;
await command({ op: "work.project.create", args: { title: msg("web-demo.phd_proposal"), goal: msg("web-demo.submit_the_proposal_before_december") } });

const seed: Array<[string, string | undefined, string, string?, number?]> = [
  [msg("web-demo.run_experiments_with_three_more_model_families"), paper.id, "active", "codex@demo", 3],
  [msg("web-demo.list_reviewer_r2_s_questions"), paper.id, "done"],
  [msg("web-demo.compute_bootstrap_95_confidence_intervals"), paper.id, "todo", "pi@demo", 2],
  [msg("web-demo.draft_the_first_rebuttal"), paper.id, "waiting", undefined, 6],
  [msg("web-demo.validate_migration_dry_run"), lumio.id, "todo", undefined, 1],
  [msg("web-demo.write_v0_2_release_notes"), lumio.id, "paused", undefined, 9],
  [msg("web-demo.renew_domain"), undefined, "todo", undefined, -1],
];
const tasks: Record<string, any> = {};
for (const [title, project, status, _assignee, due] of seed) {
  tasks[title] = (await command({ op: "work.task.create", args: { title, ...(project ? { project } : {}),
    ...(due !== undefined ? { due: inDays(due) } : {}), description: msg("web-demo.define_completion_criteria_here_markdown_supported_bash_python_run_p") } })).task;
  const task = tasks[title];
  if (status === "done" || status === "cancelled") tasks[title] = (await command({ op: "work.task.finish", args: { task: task.id, expected_revision: task.revision, outcome: status } })).task;
  else if (status === "waiting" || status === "paused") tasks[title] = (await command({ op: "work.task.hand", args: { task: task.id, expected_revision: task.revision,
    to: status === "paused" ? "nobody" : "external", ...(status === "waiting" ? { note: "Synthetic external wait" } : {}) } })).task;
}
await command({ op: "work.task.comment", args: { task: tasks[msg("web-demo.run_experiments_with_three_more_model_families")].id, body: msg("web-demo.the_first_model_has_finished_the_other_two_are_queued") } });

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
const jobs = [await dispatch(msg("web-demo.run_experiments_with_three_more_model_families"), "codex@demo"), await dispatch(msg("web-demo.compute_bootstrap_95_confidence_intervals"), "pi@demo"), await dispatch(msg("web-demo.validate_migration_dry_run"), "codex@demo")];
const sync = await runtime("/v1/runtime/sync", { running: [], queued: [], outbox: 0 });
await runtime("/v1/runtime/ack", { accepted: sync.jobs.map((job: any) => job.id) });
await runtime("/v1/runtime/sync", { running: sync.jobs.map((job: any) => job.id), queued: [], outbox: 0 });
const lease = (id: string) => sync.jobs.find((job: any) => job.id === id).lease;
const now = new Date().toISOString();
await runtime("/v1/runtime/results", { job: jobs[0].spec.id, lease: lease(jobs[0].spec.id), status: "done", exit_code: 0, started: now, finished: now,
  report: msg("web-demo.results_setting_success_rate_a_41_2_b_37_9_c_52_6_two_more_models_ar") });
await runtime("/v1/runtime/results", { job: jobs[1].spec.id, lease: lease(jobs[1].spec.id), status: "waiting_for_human", started: now, finished: now, question: msg("web-demo.use_1_000_or_10_000_bootstrap_samples_the_latter_takes_about_40_minu") });
await dispatch(msg("web-demo.run_experiments_with_three_more_model_families"), "codex@demo"); // 第 2 轮，保持排队

console.log(msg("web-demo.lumio_web_demo_is_running_temporary_data_your_installed_hub_is_unaff", HUB, token));
