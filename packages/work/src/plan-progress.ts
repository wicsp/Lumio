import { planAncestors, planPredecessors, type HandoffPlan, type PlanRun, type Turn } from "@lumio/schema";

export type PlanBranch = NonNullable<Turn["parallel"]>[number];

export function graphPlan(plan: HandoffPlan): boolean {
  return plan.finish === "auto" || plan.stages.some(stage => stage.after !== undefined);
}

export function workingBranches(turn: Turn): PlanBranch[] {
  if (turn.reason !== "working") return [];
  if (turn.parallel) return turn.parallel;
  if (!turn.stage || !turn.round || !turn.job) return [];
  return [{ stage: turn.stage, agent: turn.holder, round: turn.round, job: turn.job }];
}

export function completedStages(run: PlanRun): Set<string> {
  if (run.done) return new Set(run.done);
  const index = run.plan.stages.findIndex(stage => stage.id === run.stage);
  return new Set(run.plan.stages.slice(0, index < 0 ? run.plan.stages.length : index).map(stage => stage.id));
}

export function readyStages(plan: HandoffPlan, done: ReadonlySet<string>, active: readonly PlanBranch[] = []) {
  const predecessors = planPredecessors(plan.stages);
  return plan.stages.filter(stage => !done.has(stage.id) && !active.some(branch => branch.stage === stage.id)
    && predecessors.get(stage.id)!.every(id => done.has(id)));
}

export function resetStages(plan: HandoffPlan, done: Set<string>, targets: readonly string[]): void {
  const ancestors = planAncestors(plan.stages);
  for (const stage of done) {
    if (targets.some(target => target === stage || ancestors.get(stage)?.has(target))) done.delete(stage);
  }
}

export function graphProgress(run: PlanRun, done: ReadonlySet<string>, stage: string, active: readonly PlanBranch[] = []): PlanRun {
  return { ...run, stage, done: run.plan.stages.map(node => node.id).filter(id => done.has(id)),
    active: active.length > 1 ? active.map(branch => branch.stage) : undefined };
}
