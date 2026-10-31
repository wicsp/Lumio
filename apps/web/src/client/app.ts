/**
 * 应用主控制器（ADR 0026）：登录状态与屏幕切换。令牌只在内存里，刷新页面后需重新连接。
 * 登出或任何 401 时关闭会话（中止未完成请求）并丢弃全部模块数据。
 */
import { ApiClientError } from "@lumio/api-client";
import { createSession, errorText, type Session } from "./api.ts";
import { ConnectView } from "./views/connect.ts";
import { WorkbenchView } from "./views/workbench.ts";

export class App {
  private session: Session | undefined;
  private pending?:Session;
  private view?:WorkbenchView;
  private generation=0;

  constructor(private root: HTMLElement) {}

  mount(): void { this.showConnect(); }

  private showConnect(notice?: string): void {
    this.generation++;this.view?.dispose();this.view=undefined;this.pending?.close();this.pending=undefined;
    this.session?.close(); this.session = undefined;
    document.querySelectorAll<HTMLDialogElement>("dialog").forEach(dialog=>{dialog.close();dialog.remove();});
    this.root.replaceChildren();
    new ConnectView(this.root, (token) => this.enter(token), notice);
  }

  /** 用 actors 查询验证令牌；agent/runtime 令牌会被 Hub 以 403 拒绝。 */
  private async enter(token: string): Promise<void> {
    const generation=++this.generation;this.pending?.close();
    const session = createSession(token, () => {if(generation===this.generation)this.showConnect("登录已失效，请重新连接");});
    this.pending=session;
    try {
      const actors = await session.client.actors();
      if(generation!==this.generation){session.close();return;}
      this.pending=undefined;this.session = session;
      this.root.replaceChildren();
      this.view=new WorkbenchView(this.root, session, actors.filter((a) => a.role === "human").map((a) => a.name), () => this.showConnect());
    } catch (error) {
      session.close();
      if (error instanceof ApiClientError && error.status === 403) throw new Error("这个令牌属于 AI 或执行器，工作台只接受人的访问令牌");
      if (error instanceof ApiClientError && error.status === 401) throw new Error("令牌无效或已被吊销");
      throw new Error(errorText(error));
    }
  }
}
