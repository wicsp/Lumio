/**
 * 删除与撤销（ADR 0038）。删除即移入回收站：确认框写清后果，成功后给出带「撤销」的提示。
 * 只有人能删除；Hub 对 agent 直接拒绝，这里不做额外判断。
 */
import type { TrashItem } from "@lumio/schema";
import { errorText, type Client } from "./api.ts";
import { newRequestId } from "./commands.ts";
import { clear, failure, h, icon, openDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";

export interface DeleteOptions {
  /** Dialog title, e.g. "Delete this task?" */
  title: string;
  /** The object's title, shown in bold. */
  name: string;
  /** Extra consequences shown above the standard retention line. */
  consequences?: string[];
  run(requestId: string): Promise<TrashItem>;
  /** Called after the object is in the trash (close the detail, refresh lists…). */
  deleted(item: TrashItem): void;
  /** Called after Undo restored it. */
  restored?(item: TrashItem): void;
}

export function confirmDelete(client: Client, options: DeleteOptions): void {
  const error = h("div", { role: "alert" });
  // One request ID per dialog: retrying after an unclear failure can't delete twice.
  const requestId = newRequestId("delete");
  const button = h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
    button.disabled = true; clear(error);
    try {
      const item = await options.run(requestId);
      dialog.close();
      options.deleted(item);
      toast(t("Moved to Recently deleted"), "ok", { label: t("Undo"), run: () => void restoreItem(client, item, options.restored) });
    } catch (cause) {
      clear(error, failure(errorText(cause)));
      button.disabled = false;
    }
  } }, icon("trash"), t("Delete"));
  const dialog = openDialog(options.title, h("div", { class: "form-stack delete-confirm" },
    h("p", { class: "delete-name" }, options.name),
    ...(options.consequences ?? []).map(text => h("p", { class: "delete-consequence" }, icon("alert"), h("span", {}, text))),
    h("p", { class: "muted" }, t("It stays in Recently deleted for 30 days, where you can restore it or delete it permanently.")),
    error), [button]);
}

export async function restoreItem(client: Client, item: TrashItem, restored?: (item: TrashItem) => void, quiet = false): Promise<boolean> {
  try {
    const result = await client.restoreTrash(item.id, { request_id: newRequestId("restore") });
    if (result.renamed && result.path) toast(t("Restored as {0}", result.path));
    else if (!quiet) toast(t("Restored"));
    restored?.(item);
    return true;
  } catch (cause) {
    toast(t("Couldn't restore: {0}", errorText(cause)), "error");
    return false;
  }
}
