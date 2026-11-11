import type { WorkTask } from "@lumio/schema";
import { errorText, isConflict, type Client } from "./api.ts";
import { confirmDialog, icon, openMenu, promptDialog, toast } from "./dom.ts";
import { t } from "./i18n.ts";
import { TURN_ACTION_DONE, TURN_ACTION_ICONS, TURN_ACTION_LABELS, turnActionCommand, turnActions, type TurnAction } from "./turn.ts";

/** Today and Work use the same revision-aware task decisions and confirmations. */
export function taskTurnMenu(client: Client, task: WorkTask, anchor: HTMLElement, changed: () => void | Promise<void>, failed: () => void): void {
  openMenu(anchor, turnActions(task).map(action => ({
    value: action, label: TURN_ACTION_LABELS[action], icon: icon(TURN_ACTION_ICONS[action]),
  })), async value => {
    const action = value as TurnAction;
    let note: string | undefined;
    if (action === "external") {
      note = await promptDialog({ title: t("What are you waiting for?"), placeholder: t("e.g. a reply from someone, a delivery…"), confirm: t("Continue") });
      if (!note) return;
    }
    if (task.turn.reason === "working" && action !== "external" && !(await confirmDialog({
      title: t("Stop the running round?"), message: t("An agent is still working on this task. Stop its round and continue?"), confirm: t("Continue"), danger: true,
    }))) return;
    try {
      await client.workCommand(turnActionCommand(task, action, note));
      toast(TURN_ACTION_DONE[action]);
      await changed();
    } catch (cause) {
      toast(isConflict(cause) ? t("The task changed elsewhere; the list was refreshed") : errorText(cause), "error");
      failed();
    }
  });
}
