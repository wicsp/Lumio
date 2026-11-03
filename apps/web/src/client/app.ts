/** Restore a verified human login; logout/401 clears credentials and module data. */
import { ApiClientError } from "@lumio/api-client";
import { createSession, errorText, LoginError, type Session } from "./api.ts";
import { browserLoginStorage, type LoginStorage, type SavedLogin } from "./credentials.ts";
import { h, loading, toast } from "./dom.ts";
import { ConnectView } from "./views/connect.ts";
import { WorkbenchView } from "./views/workbench.ts";
import { onLang, t } from "./i18n.ts";

export class App {
  private session?: Session;
  private pending?: Session;
  private view?: WorkbenchView;
  private generation = 0;
  private login?: SavedLogin;
  private humans: string[] = [];
  private connectArgs?: [string | undefined, (() => void) | undefined];
  private langPending = false;
  constructor(private root: HTMLElement, private storage: LoginStorage = browserLoginStorage()) {}

  mount(): void {
    onLang(() => this.relabel());
    window.addEventListener("storage", event => {
      if (event.key !== null && event.key !== this.storage.key) return;
      if (!this.login?.remember) return;
      const saved = this.storage.load();
      if (!saved || saved.token !== this.login.token) this.showConnect(t("You signed out or switched accounts in another tab. Connect again."));
    });
    const saved = this.storage.load();
    if (saved) this.restore(saved); else this.showConnect();
  }
  private reset(): void {
    this.generation++; this.view?.dispose(); this.view = undefined;
    this.pending?.close(); this.pending = undefined; this.session?.close(); this.session = undefined; this.login = undefined;
    document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog => { dialog.close(); dialog.remove(); });
    this.root.replaceChildren();
  }
  /** 语言切换（ADR 0028）：没有未保存内容时立即重建界面；有则提示，并在下一次切换模块前重建，不丢草稿。 */
  private relabel(): void {
    if (this.connectArgs && !this.session) { this.showConnect(...this.connectArgs); return; }
    if (!this.view || !this.session) return;
    if (this.view.dirty) { this.langPending = true; toast(t("The language will switch after you save or leave what you're editing.")); return; }
    this.rebuildView();
  }
  private rebuildView(): void {
    if (!this.session) return;
    this.langPending = false;
    this.view?.dispose();
    this.root.replaceChildren();
    this.view = new WorkbenchView(this.root, this.session, this.humans, () => this.logout(), () => this.takePending());
  }
  private takePending(): boolean {
    if (!this.langPending) return false;
    queueMicrotask(() => this.rebuildView());
    return true;
  }
  private showConnect(notice?: string, retry?: () => void): void {
    this.reset();
    this.connectArgs = [notice, retry];
    new ConnectView(this.root, (token, remember) => this.enter(token, remember), notice, retry);
  }
  private logout(): void { this.storage.clear(); this.showConnect(); }
  private restore(saved: SavedLogin): void {
    this.reset(); this.root.append(h("div", { class: "placeholder" }, loading(t("Restoring your session…")), h("button", { type: "button", class: "btn btn-quiet btn-small", onclick: () => this.logout() }, t("Use a new pairing code"))));
    void this.enter(saved.token, saved.remember, true);
  }
  /** actors is human-only. Never persist an unverified agent/runtime/invalid token. */
  private async enter(token: string, remember: boolean, restoring = false): Promise<void> {
    const generation = ++this.generation; this.pending?.close();
    const session = createSession(token, () => {
      if (generation !== this.generation) return;
      this.storage.clear(token); this.showConnect(t("Your session has expired. Pair again."));
    });
    this.pending = session;
    this.login = restoring ? { token, remember } : undefined;
    try {
      const actors = await session.client.actors();
      if (generation !== this.generation) { session.close(); return; }
      let warning: string | undefined;
      let actualRemember = remember;
      if (!restoring) {
        const scope = this.storage.save(token, remember); actualRemember = scope === "device";
        if (scope === "memory") warning = t("This browser won't save your session. You can keep working, but you'll need to pair again after a refresh.");
        else if (remember && scope !== "device") warning = t("This browser won't remember the device. Refreshing this tab works; after closing it you'll need to pair again.");
      }
      this.pending = undefined; this.session = session; this.login = { token, remember: actualRemember };
      this.root.replaceChildren();
      this.humans = actors.filter(actor => actor.role === "human").map(actor => actor.name); this.connectArgs = undefined;
      this.view = new WorkbenchView(this.root, session, this.humans, () => this.logout(), () => this.takePending());
      if (warning) toast(warning, "error");
    } catch (error) {
      session.close(); if (generation !== this.generation) return;
      this.pending = undefined;
      const invalid = error instanceof ApiClientError && (error.status === 401 || error.status === 403);
      if (invalid) this.storage.clear(token);
      const message = error instanceof ApiClientError && error.status === 403 ? t("This token belongs to an agent or runtime. The workbench only accepts a human access token.") : invalid ? t("Your session has expired. Pair again.") : errorText(error);
      if (restoring) this.showConnect(message, invalid ? undefined : () => { const saved = this.storage.load(); if (saved) this.restore(saved); else this.showConnect(); });
      else throw new LoginError(message, !invalid);
    }
  }
}
