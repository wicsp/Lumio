/** Restore a verified human login; logout/401 clears credentials and module data. */
import { ApiClientError } from "@lumio/api-client";
import { createSession, errorText, LoginError, type Session } from "./api.ts";
import { browserLoginStorage, type LoginStorage, type SavedLogin } from "./credentials.ts";
import { h, loading } from "./dom.ts";
import { ConnectView } from "./views/connect.ts";
import { WorkbenchView } from "./views/workbench.ts";

export class App {
  private session?: Session;
  private pending?: Session;
  private view?: WorkbenchView;
  private generation = 0;
  private login?: SavedLogin;
  constructor(private root: HTMLElement, private storage: LoginStorage = browserLoginStorage()) {}

  mount(): void {
    window.addEventListener("storage", event => {
      if (event.key !== null && event.key !== this.storage.key) return;
      if (!this.login?.remember) return;
      const saved = this.storage.load();
      if (!saved || saved.token !== this.login.token) this.showConnect("登录已在另一个页面退出或更换，请重新连接");
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
  private showConnect(notice?: string, retry?: () => void): void {
    this.reset();
    new ConnectView(this.root, (token, remember) => this.enter(token, remember), notice, retry);
  }
  private logout(): void { this.storage.clear(); this.showConnect(); }
  private restore(saved: SavedLogin): void {
    this.reset(); this.root.append(loading("正在恢复登录…"), h("button", { type: "button", class: "btn", onclick: () => this.logout() }, "重新配对"));
    void this.enter(saved.token, saved.remember, true);
  }
  /** actors is human-only. Never persist an unverified agent/runtime/invalid token. */
  private async enter(token: string, remember: boolean, restoring = false): Promise<void> {
    const generation = ++this.generation; this.pending?.close();
    const session = createSession(token, () => {
      if (generation !== this.generation) return;
      this.storage.clear(token); this.showConnect("登录已失效，请重新配对");
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
        if (scope === "memory") warning = "浏览器不允许保存登录。本次可以继续使用，刷新后需要重新配对。";
        else if (remember && scope !== "device") warning = "浏览器不允许记住设备。当前标签页刷新仍可使用，关闭后需重新配对。";
      }
      this.pending = undefined; this.session = session; this.login = { token, remember: actualRemember };
      this.root.replaceChildren();
      if (warning) this.root.append(h("p", { class: "state state-error", role: "alert" }, warning));
      this.view = new WorkbenchView(this.root, session, actors.filter(actor => actor.role === "human").map(actor => actor.name), () => this.logout());
    } catch (error) {
      session.close(); if (generation !== this.generation) return;
      this.pending = undefined;
      const invalid = error instanceof ApiClientError && (error.status === 401 || error.status === 403);
      if (invalid) this.storage.clear(token);
      const message = error instanceof ApiClientError && error.status === 403 ? "这个令牌属于 AI 或执行器，工作台只接受人的访问令牌" : invalid ? "登录已失效，请重新配对" : errorText(error);
      if (restoring) this.showConnect(message, invalid ? undefined : () => { const saved = this.storage.load(); if (saved) this.restore(saved); else this.showConnect(); });
      else throw new LoginError(message, !invalid);
    }
  }
}
