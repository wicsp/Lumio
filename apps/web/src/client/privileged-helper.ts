/**
 * 高权限助手（ADR 0020）在哪台执行器上装了、没装时怎么装。
 * 执行器登记 privileged_helper 能力表示已配置；旧执行器不登记任何能力时无法判断。
 * 这条命令每台机器只需在该机器的终端里运行一次（会要求输入那台机器的密码），网页只负责提示和复制。
 */
import type { RuntimeInfo } from "@lumio/schema";
import { h, icon, toast } from "./dom.ts";
import { t } from "./i18n.ts";

export const INSTALL_HELPER_COMMAND = "sudo lumio-runtime install-sudo-helper";

export type HelperState = "installed" | "missing" | "unknown";
export function helperState(registration: Pick<RuntimeInfo["registration"], "features">): HelperState {
  if (!registration.features) return "unknown";
  return registration.features.includes("privileged_helper") ? "installed" : "missing";
}

/** 可复制的安装命令。 */
export function installCommandBlock(): HTMLElement {
  return h("div", { class: "helper-command" },
    h("code", {}, INSTALL_HELPER_COMMAND),
    h("button", { type: "button", class: "btn btn-small", onclick: () => void navigator.clipboard?.writeText(INSTALL_HELPER_COMMAND).then(() => toast(t("Copied"))) }, icon("copy"), t("Copy")));
}

/** 一轮里 agent 想用管理员权限、但这台机器没装助手时的提示（任务卡片上显示）。 */
export function helperMissingNotice(agent: string | undefined, program: string): HTMLElement {
  const machine = agent?.includes("@") ? agent.split("@")[1]! : undefined;
  return h("div", { class: "helper-notice" },
    h("p", { class: "helper-notice-title" }, icon("lock"),
      machine ? t("{0} wanted to run {1} as administrator, but {2} has no administrator helper yet.", agent!, program, machine)
        : t("The agent wanted to run {0} as administrator, but this runtime has no administrator helper yet.", program)),
    h("p", { class: "field-hint" }, machine
      ? t("To allow requests like this, run the line below once in a terminal on {0} (it asks for that machine's password). Each request still needs your approval. Then retry or answer to continue.", machine)
      : t("To allow requests like this, run the line below once in a terminal on that machine (it asks for its password). Each request still needs your approval. Then retry or answer to continue.")),
    installCommandBlock());
}
