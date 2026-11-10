/**
 * 资源锚点（ADR 0051）：正文里的 `[文字](lumio:<ID>)` 与知识的 `derived_from`。
 * 只存 ID；打开时经 Hub 的 `/v2/resources/<id>` 按当前身份判断可见性，再跳到所属模块。
 */
import type { ResourceSummary } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { toast } from "./dom.ts";
import { t } from "./i18n.ts";
import type { Navigate, Section } from "./navigation.ts";

const KNOWLEDGE = new Set(["pap", "idea", "src", "exp", "post", "ast", "rpt", "ain"]);
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const AI_NOTE_ID = new RegExp(`^ain_${ULID}$`);

export const prefixOf = (id: string): string => id.slice(0, id.indexOf("_"));

/** 对话内定位到消息时使用的打开参数：`conv_…@amsg_…`。 */
export const MESSAGE_SEPARATOR = "@";

/** 打开一个可见资源应去的模块与参数；没有可打开的页面时返回 undefined。 */
export function resourceRoute(summary: Extract<ResourceSummary, { status: "visible" }>): [Section, string | undefined] | undefined {
  const { id, parent } = summary, prefix = prefixOf(id);
  if (KNOWLEDGE.has(prefix)) return ["knowledge", id];
  if (prefix === "conv") return ["assistant", id];
  if (prefix === "amsg") return ["assistant", parent ? `${parent}${MESSAGE_SEPARATOR}${id}` : undefined];
  if (prefix === "turn" || prefix === "tool") return ["assistant", parent];
  if (prefix === "task" || prefix === "prj") return ["work", id];
  if (prefix === "wmsg") return ["work", parent];
  if (prefix === "job") return ["execution", id];
  if (prefix === "evt" || prefix === "art") return parent?.startsWith("job_") ? ["execution", parent] : ["execution", undefined];
  if (prefix === "rtn") return ["execution", undefined];
  if (prefix === "prop") return ["approvals", undefined];
  return undefined;
}

/** 不可打开时给人看的说明。 */
export function resourceStatusText(status: Exclude<ResourceSummary["status"], "visible">): string {
  return status === "trashed" ? t("This item is in Recently deleted.")
    : status === "deleted" ? t("This item was deleted.")
    : t("This item isn't available to you.");
}

/** 点击 lumio: 链接或来源：先问 Hub，再跳转。 */
export async function openResource(client: Client, navigate: Navigate, id: string): Promise<void> {
  let summary: ResourceSummary;
  try { summary = await client.resource(id); }
  catch (cause) { toast(t("Couldn't open {0}: {1}", id, errorText(cause)), "error"); return; }
  if (summary.status !== "visible") { toast(resourceStatusText(summary.status)); return; }
  const route = resourceRoute(summary);
  if (!route) { toast(t("{0} has no page to open.", summary.title)); return; }
  navigate(route[0], route[1]);
}

/** 工作台内所有 `[data-resource]` 链接（含编辑器里的预览）都在捕获阶段统一处理，先于编辑器自己的点击处理。 */
export function resourceLinks(root: HTMLElement, client: Client, navigate: Navigate): () => void {
  const click = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.<HTMLElement>("[data-resource]");
    if (!link || !root.contains(link)) return;
    event.preventDefault(); event.stopPropagation();
    void openResource(client, navigate, link.dataset.resource!);
  };
  root.addEventListener("click", click, true);
  return () => root.removeEventListener("click", click, true);
}

/**
 * 指向 AI 笔记的链接目标：AI 笔记的文件名就是它的 ID（`ai/notes/ain_….md`），
 * 所以 `[[ain_…]]`、`ain_…`、`…/ain_….md` 都能直接认出来，不需要先查询。
 */
export function aiNoteIdOf(target: string): string | undefined {
  const name = target.split("/").pop()!.replace(/\.md$/, "");
  return AI_NOTE_ID.test(name) ? name : undefined;
}

/** 删除前查询被多少知识引用（只对对话与任务返回）；查不到时不阻止删除。 */
export async function knowledgeReferences(client: Client, id: string): Promise<number | undefined> {
  try {
    const summary = await client.resource(id);
    return summary.status === "visible" ? summary.knowledge_references : undefined;
  } catch { return undefined; }
}

/** 删除确认里的后果说明。 */
export function referenceConsequence(count: number | undefined): string[] {
  return count ? [t("{0} knowledge notes cite it as a source. They keep the reference and will show it as deleted until you restore it.", count)] : [];
}
