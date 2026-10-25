import { z } from "zod";
import { AGENTS, Assignee, Base, Id, Timestamp, idOf, optional, withDefault } from "./common.ts";
import { containsCardNumber } from "./secrets.ts";

/**
 * 论文 citekey：`<第一作者姓>_<年份>_<标题缩写>`，例如 `He_2020_LightGCN`。
 * 同时是文件名、笔记链接和 `\cite{}` 的 key。规则见 ADR 0004。
 */
export const CITEKEY_PATTERN = /^[A-Z][A-Za-z]*_[0-9]{4}_[A-Za-z0-9]+$/;
export const Citekey = z
  .string()
  .regex(CITEKEY_PATTERN, "citekey 必须是 姓_年份_缩写，例如 He_2020_LightGCN");

/** 论文笔记，文件位于 `library/papers/<citekey>.md`（ADR 0012）。 */
export const Paper = Base.extend({
  type: z.literal("paper"),
  id: idOf("pap"),
  citekey: Citekey,
  authors: z.array(z.string().min(1)).min(1),
  year: z.number().int(),
  venue: optional(z.string()),
  arxiv: optional(z.string()),
  doi: optional(z.string()),
  url: optional(z.url()),
  status: withDefault(z.enum(["to-read", "reading", "read"]), "to-read"),
});

/** 想法 / 灵感，可以链接论文和其他想法，最后被串进报告。 */
export const Idea = Base.extend({
  type: z.literal("idea"),
  id: idOf("idea"),
  status: withDefault(z.enum(["seed", "developing", "used", "dropped"]), "seed"),
  project: optional(idOf("prj")),
});

export const Project = Base.extend({
  type: z.literal("project"),
  id: idOf("prj"),
  status: withDefault(z.enum(["planning", "active", "paused", "done"]), "planning"),
  goal: optional(z.string()),
  repo: optional(z.string()).describe("关联代码仓库的路径或 URL"),
  deadline: optional(Timestamp),
});

/**
 * 派给 AI 时的执行配置，任务和例行任务共用（ADR 0019 第 3 节）。都是人写的平铺字段；
 * 每一轮实际用了什么记在 Hub 的 Job 记录里，不写回笔记。
 */
const RunConfig = {
  workdir: optional(z.string().min(1)).describe("执行器上的工作目录（绝对路径或以 ~/ 开头）；不能在笔记库里"),
  model: optional(z.string().min(1)).describe("可选：指定模型，原样交给 agent"),
  gpus: optional(z.array(z.number().int().nonnegative())).describe("可选：只把这些 GPU 暴露给这一轮"),
  timeout_minutes: optional(z.number().int().positive()).describe("可选：每一轮最长运行时间，缺省时用执行器的默认值"),
};

/**
 * 任务的生命周期，人和 AI 的任务通用，只由人改（ADR 0019 第 2 节）。
 * 例外：Hub 第一次派出时把 todo 改为 active。
 */
export const TASK_STATUSES = ["todo", "active", "waiting", "paused", "done", "cancelled"] as const;
/** 现在轮到谁动手。只有负责人是 agent 的任务才有：人只能改成 agent，Hub 只能改成 human。 */
export const TASK_TURNS = ["human", "agent"] as const;

export const Task = Base.extend({
  type: z.literal("task"),
  id: idOf("task"),
  status: withDefault(z.enum(TASK_STATUSES), "todo"),
  turn: optional(z.enum(TASK_TURNS)).describe("agent：请 AI 开始或继续；human：轮到你。由 Hub 维护，见 ADR 0019"),
  project: optional(idOf("prj")),
  assignee: withDefault(Assignee, "human"),
  due: optional(Timestamp),
  routine: optional(idOf("rtn")).describe("由某个例行任务的某一次结果追问而来（routine followup）"),
  ...RunConfig,
});

/** 5 段 cron 表达式：分 时 日 月 周，例如 `0 9 * * 1` 表示每周一 9:00。 */
export const CRON_PATTERN = /^\s*[0-9*,\/-]+(\s+[0-9*,\/-]+){4}\s*$/;

/**
 * 例行任务：按时间自动交给 AI 的模板，位于 `plan/routines/`（ADR 0019 第 6 节）。
 * 每次触发都是独立的新会话；结果按时间追加在这篇笔记里。
 */
export const Routine = Base.extend({
  type: z.literal("routine"),
  id: idOf("rtn"),
  schedule: z.string().regex(CRON_PATTERN, "schedule 必须是 5 段 cron 表达式，例如 0 9 * * 1"),
  timezone: optional(z.string().min(1)).describe("IANA 时区，如 Asia/Singapore；缺省时用 Hub 所在机器的时区"),
  status: withDefault(z.enum(["active", "paused"]), "active"),
  assignee: z.strictObject({
    agent: z.enum(AGENTS),
    device: z.string().optional().describe("指定设备；省略则由调度决定"),
  }),
  context: withDefault(z.enum(["none", "previous"]), "none").describe("previous：带上上一次结果的摘要"),
  project: optional(idOf("prj")),
  ...RunConfig,
});

export const Experiment = Base.extend({
  type: z.literal("experiment"),
  id: idOf("exp"),
  project: idOf("prj"),
  status: withDefault(z.enum(["planned", "running", "done", "failed"]), "planned"),
  hypothesis: optional(z.string()),
  config_ref: optional(z.string()).describe("配置文件路径或 git commit"),
  device: optional(z.string()),
  metrics: optional(z.record(z.string(), z.number())),
  artifacts: optional(z.array(z.string())),
});

// ───────────────────────── ADR 0012：source、post、asset ─────────────────────────

/** 外部资料（网页、视频、播客、课程、书），位于 `library/sources/`。 */
export const Source = Base.extend({
  type: z.literal("source"),
  id: idOf("src"),
  kind: withDefault(z.enum(["web", "video", "podcast", "course", "book"]), "web"),
  url: optional(z.url()),
  author: optional(z.string()),
  site: optional(z.string()).describe("来源站点或平台名"),
  status: withDefault(z.enum(["to-read", "reading", "read"]), "to-read"),
});

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** 相对路径：非空，不以 `/` 开头，不含 `..` 段、空段、反斜杠或任何 URL scheme（如 `https:`、`file:`）。 */
function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || URL_SCHEME.test(path)) return false;
  return path.split("/").every((segment) => segment !== ".." && segment !== "");
}

/**
 * 媒体引用：vault 内的相对路径（如 `files/attachments/cover.png`），
 * 或 `media://<相对路径>`，指向各设备本机配置的媒体根目录（ADR 0012 第 4 节）。
 */
export const MediaRef = z
  .string()
  .refine((value) => {
    return isSafeRelativePath(value.startsWith("media://") ? value.slice("media://".length) : value);
  }, "媒体引用必须是 vault 内的相对路径，或 media://<相对路径>；不能以 / 开头，也不能含 ..");

export const POST_FORMATS = ["video", "gallery", "article", "text"] as const;

/** 发布到某一个平台。归属为"程序"的字段（ADR 0009 程序字段例外）由发布流程经 Hub 写入。 */
export const PostTarget = z.strictObject({
  platform: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "platform 必须是小写 kebab-case，例如 bilibili、xiaohongshu"),
  format: optional(z.enum(POST_FORMATS)).describe("覆盖 post 的 format"),
  media: optional(z.string().min(1)).describe("post.media 中的角色名"),
  schedule: optional(Timestamp),
  // 以下为程序字段
  status: withDefault(z.enum(["pending", "scheduled", "published", "failed"]), "pending"),
  url: optional(z.url()),
  published_at: optional(Timestamp),
  error: optional(z.string()),
});

/** 一篇要发布的内容；发到每个平台算一个 target。位于 `create/posts/`。 */
export const Post = Base.extend({
  type: z.literal("post"),
  id: idOf("post"),
  format: z.enum(POST_FORMATS).describe("默认形态，target 可以覆盖"),
  status: withDefault(z.enum(["idea", "drafting", "ready", "done"]), "idea"),
  derived_from: withDefault(z.array(Id), []).describe("来源的 source / idea / paper"),
  media: withDefault(
    z.record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/, "媒体角色名只能用小写字母、数字、- 和 _，例如 main、cover"),
      z.union([MediaRef, z.array(MediaRef)]),
    ),
    {},
  ).describe(
    "按用途命名的媒体，例如 main、vertical、cover、images",
  ),
  targets: withDefault(z.array(PostTarget), []),
}).superRefine((post, ctx) => {
  post.targets.forEach((target, index) => {
    if (target.media !== undefined && !Object.hasOwn(post.media, target.media)) {
      ctx.addIssue({
        code: "custom",
        path: ["targets", index, "media"],
        message: `media 中没有名为"${target.media}"的角色`,
      });
    }
  });
});

export const ASSET_KINDS = [
  "subscription", "domain", "card", "bank-account", "account", "server", "insurance", "document", "other",
] as const;

/** 后四位。YAML 中不加引号的 `0123` 会被解析成数字 123，这里补回前导零。 */
const Last4 = z.union([
  z.string().regex(/^\d{4}$/, "last4 必须正好是 4 位数字"),
  z.number().int().min(0).max(9999).transform((n) => String(n).padStart(4, "0")),
]);

const CARD_NUMBER_MESSAGE = "疑似完整卡号：vault 中只能记后四位（last4），完整卡号请放在密码管理器中";

/**
 * 订阅、卡、账户、域名、保险、证件等资产，位于 `life/assets/`（私密，ADR 0012 第 5、6 节）。
 * 禁止存放完整卡号或账号、CVV、密码、密钥、余额、证件号码。
 */
export const Asset = Base.extend({
  type: z.literal("asset"),
  id: idOf("ast"),
  kind: z.enum(ASSET_KINDS),
  provider: optional(z.string()).describe("服务商、发卡行、注册商"),
  status: withDefault(z.enum(["active", "paused", "cancelled", "expired"]), "active"),
  cost: optional(z.number().nonnegative()).describe("每个周期的金额"),
  currency: optional(z.string().regex(/^[A-Z]{3}$/, "currency 必须是 ISO 4217 代码，例如 CNY、USD")),
  cycle: optional(z.union([z.enum(["monthly", "yearly", "once"]), z.number().int().positive()])).describe(
    "monthly、yearly、once，或周期天数",
  ),
  renews_on: optional(z.iso.date()).describe("下次扣费日，YYYY-MM-DD；程序字段（自动续费时顺延）"),
  expires: optional(
    z.union([z.iso.date(), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)], "expires 必须是 YYYY-MM-DD 或 YYYY-MM"),
  ),
  auto_renew: optional(z.boolean()),
  paid_with: optional(idOf("ast")).describe("由哪张卡或哪个账户支付"),
  login: optional(z.string()).describe("登录用的邮箱或用户名"),
  last4: optional(Last4),
  vault_item: optional(z.string()).describe("密码管理器中对应条目的名称"),
  manage_url: optional(z.url()),
}).superRefine((asset, ctx) => {
  // 检查所有键，包括 schema 之外的未知字段（Base 是 looseObject）。
  for (const [key, value] of Object.entries(asset)) {
    if (containsCardNumber(value)) ctx.addIssue({ code: "custom", path: [key], message: CARD_NUMBER_MESSAGE });
  }
});

/** 任意 vault 实体，按 `type` 字段区分。 */
export const Entity = z.discriminatedUnion("type", [
  Paper, Idea, Project, Task, Routine, Experiment, Source, Post, Asset,
]);

export type Paper = z.infer<typeof Paper>;
export type Idea = z.infer<typeof Idea>;
export type Project = z.infer<typeof Project>;
export type Task = z.infer<typeof Task>;
export type Routine = z.infer<typeof Routine>;
export type Experiment = z.infer<typeof Experiment>;
export type Source = z.infer<typeof Source>;
export type MediaRef = z.infer<typeof MediaRef>;
export type PostTarget = z.infer<typeof PostTarget>;
export type Post = z.infer<typeof Post>;
export type Asset = z.infer<typeof Asset>;
export type Entity = z.infer<typeof Entity>;
