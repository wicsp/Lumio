import { Turn, type Job, type TaskOutcome, type WorkTask } from "@lumio/schema";

export type TurnAction =
  | { kind: "create" | "reopen" }
  | { kind: "hand"; to: "human" | "external" | "nobody"; note?: string }
  | { kind: "finish"; outcome: "done" | "cancelled" }
  | { kind: "dispatch"; to: string; round: number; job: string; stage?: string; note?: string }
  | { kind: "plan"; turn: Turn }
  | { kind: "result"; status: Job["status"]; round: number; job: string; report?: string };

/** Work supplies the planned-delivery transition, including an optional new round. */
export type PlannedDelivery = (task: WorkTask, action: Extract<TurnAction, { kind: "result" }>, at: string) => Turn;

/** The single transition table for commands and round results. */
export function nextTurn(action: TurnAction, at: string, task?: WorkTask, plannedDelivery?: PlannedDelivery): { turn: Turn; outcome?: TaskOutcome } {
  switch (action.kind) {
    case "create": case "reopen": return { turn: Turn.parse({ holder: "human", reason: "todo", since: at }), outcome: "open" };
    case "finish": return { turn: Turn.parse({ holder: "nobody", reason: "on_hold", since: at }), outcome: action.outcome };
    case "hand": return { turn: Turn.parse({ holder: action.to, reason: action.to === "human" ? "todo" : action.to === "external" ? "waiting" : "on_hold", since: at, note: action.note }) };
    case "dispatch": return { turn: Turn.parse({ holder: action.to, reason: "working", since: at, round: action.round, job: action.job, stage: action.stage, note: action.note }) };
    case "plan": return { turn: Turn.parse(action.turn) };
    case "result": {
      if (action.status === "done" && task?.plan && plannedDelivery) return { turn: plannedDelivery(task, action, at) };
      const reason = action.status === "waiting_for_human" ? "answer" : action.status === "done" ? "review" : action.status === "cancelled" ? "todo" : "failed";
      return { turn: Turn.parse({ holder: "human", reason, since: at, round: action.round, job: action.job, stage: task?.plan?.stage }) };
    }
  }
}
