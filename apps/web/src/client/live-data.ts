/**
 * 工作台共用的实时数据（Today、侧栏计数、未读提醒共用一次读取）。
 *
 * 刷新规则只有一处（WorkbenchView.refresh）：
 * - 触发：页面可见时每 15 秒、回到前台或窗口重新获得焦点、收到推送、任何操作改了数据（changed）。
 * - 每次刷新先读这份快照一次，再更新计数与提醒，最后让当前模块静默刷新；隐藏的模块在切回来时刷新。
 * - 同时发起的读取合并成一个请求；changed 之后的读取一定在操作完成之后发起，不复用旧结果。
 * 只有「正在进行的东西」另有快速轮询：打开中的运行详情、运行中的进度徽标、处理中的 Inbox 条目。
 */
import type { Job, JobAttention, Notice, Proposal, WorkAttention, WorkTask } from "@lumio/schema";
import type { Client, HubExtras } from "./api.ts";

export interface LiveSnapshot {
  at: number;
  tasks: PromiseSettledResult<WorkTask[]>;
  jobs: PromiseSettledResult<Job[]>;
  proposals: PromiseSettledResult<Proposal[]>;
  /** undefined：旧 Hub 没有这个接口。 */
  attention: PromiseSettledResult<WorkAttention[] | undefined>;
  notices: PromiseSettledResult<Notice[]>;
  jobAttention: PromiseSettledResult<JobAttention>;
}

type Source = Pick<Client, "workTasks" | "jobs" | "proposals" | "notices" | "jobAttention">;

export class LiveData {
  private last?: LiveSnapshot;
  private inflight?: Promise<LiveSnapshot>;
  /** 每次 invalidate 递增；在途读取开始得比它早时不能复用。 */
  private epoch = 0;
  private inflightEpoch = -1;

  constructor(private client: Source, private hub: Pick<HubExtras, "attention">, private now: () => number = Date.now) {}

  /** 最近一次的快照（可能为空）；渲染时先用它，避免空白闪烁。 */
  get latest(): LiveSnapshot | undefined { return this.last; }

  /** 数据刚被改过：之后的 get 必须重新读取。 */
  invalidate(): void { this.epoch++; this.last = undefined; }

  /** maxAge 毫秒内的结果直接复用；同时进行的读取合并。 */
  get(maxAge = 0): Promise<LiveSnapshot> {
    if (this.last && this.now() - this.last.at <= maxAge) return Promise.resolve(this.last);
    if (this.inflight && this.inflightEpoch === this.epoch) return this.inflight;
    const epoch = this.epoch;
    const request = this.fetch().then(snapshot => {
      if (epoch === this.epoch) this.last = snapshot;
      return snapshot;
    }).finally(() => { if (this.inflight === request) this.inflight = undefined; });
    this.inflight = request; this.inflightEpoch = epoch;
    return request;
  }

  private async fetch(): Promise<LiveSnapshot> {
    const [tasks, jobs, proposals, attention, notices, jobAttention] = await Promise.allSettled([
      this.client.workTasks(), this.client.jobs(), this.client.proposals("pending"), this.hub.attention(),
      this.client.notices({ unread: true, limit: 100 }).then(value => value.notices), this.client.jobAttention(),
    ]);
    return { at: this.now(), tasks, jobs, proposals, attention, notices, jobAttention };
  }
}

/** 取 fulfilled 的值，失败时为 undefined。 */
export function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}
