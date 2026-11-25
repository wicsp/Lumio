/**
 * 工作台共用的实时数据（Today、侧栏计数、未读提醒共用一次读取）。
 *
 * 刷新规则只有一处（WorkbenchView.refresh）：
 * - 触发：页面可见时每 15 秒、回到前台或窗口重新获得焦点、收到推送、任何操作改了数据（changed）。
 * - 每次刷新共享同一次读取，Today 可逐区显示，侧栏用本轮完整快照更新计数与提醒；隐藏的模块在切回来时刷新。
 * - 同时发起的读取合并成一个请求；changed 之后的读取一定在操作完成之后发起，不复用旧结果。
 * 只有「正在进行的东西」另有快速轮询：打开中的运行详情、运行中的进度徽标、处理中的 Inbox 条目。
 */
import type { ExecutionOverview, JobAttention, Notice, Proposal, WorkAttention, WorkTask } from "@lumio/schema";
import type { Client, HubExtras } from "./api.ts";

export interface LiveSnapshot {
  at: number;
  tasks: PromiseSettledResult<WorkTask[]>;
  execution: PromiseSettledResult<ExecutionOverview>;
  proposals: PromiseSettledResult<Proposal[]>;
  /** undefined：旧 Hub 没有这个接口。 */
  attention: PromiseSettledResult<WorkAttention[] | undefined>;
  notices: PromiseSettledResult<Notice[]>;
  jobAttention: PromiseSettledResult<JobAttention>;
}

type Source = Pick<Client, "workTasks" | "executionOverview" | "proposals" | "notices" | "jobAttention">;

export function settleRead<T>(request: Promise<T>): Promise<PromiseSettledResult<T>> {
  return request.then(value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
}

export type AttentionSnapshot = Pick<LiveSnapshot, "execution" | "attention" | "proposals" | "jobAttention">;
type LiveRead = {
  execution: Promise<LiveSnapshot["execution"]>;
  attention: Promise<AttentionSnapshot>;
  tasks: Promise<LiveSnapshot["tasks"]>;
  notices: Promise<LiveSnapshot["notices"]>;
  snapshot: Promise<LiveSnapshot>;
};

export class LiveData {
  private last?: LiveSnapshot;
  private inflight?: LiveRead;
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
    return this.read(maxAge).snapshot;
  }

  /** Today can render work and notices independently while the sidebar waits for the complete snapshot. */
  read(maxAge = 0): LiveRead {
    if (this.inflight && this.inflightEpoch === this.epoch) return this.inflight;
    if (this.last && this.now() - this.last.at <= maxAge) {
      return {
        tasks: Promise.resolve(this.last.tasks), notices: Promise.resolve(this.last.notices),
        execution: Promise.resolve(this.last.execution), attention: Promise.resolve(this.last), snapshot: Promise.resolve(this.last),
      };
    }
    const epoch = this.epoch;
    const tasks = settleRead(this.client.workTasks());
    const notices = settleRead(this.client.notices({ unread: true, limit: 100 }).then(value => value.notices));
    const execution = settleRead(this.client.executionOverview());
    const attention = Promise.all([execution, settleRead(this.client.proposals("pending")),
      settleRead(this.hub.attention()), settleRead(this.client.jobAttention()),
    ]).then(([execution, proposals, attention, jobAttention]) => ({ execution, proposals, attention, jobAttention }));
    const snapshot = Promise.all([tasks, notices, attention]).then(([tasks, notices, attention]): LiveSnapshot => {
      const value = { at: this.now(), tasks, notices, ...attention };
      if (epoch === this.epoch) this.last = value;
      return value;
    }).finally(() => { if (this.inflightEpoch === epoch) this.inflight = undefined; });
    this.inflightEpoch = epoch;
    this.inflight = { tasks, notices, execution, attention, snapshot };
    return this.inflight;
  }
}

/** 取 fulfilled 的值，失败时为 undefined。 */
export function settled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}
