import { PlanTask, SessionPlan } from "./sqlite-backend.js";

export function normalizeTaskDependencies(tasks: PlanTask[]): boolean {
  let changed = false;
  const known = new Set(tasks.map((task) => task.id));
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const wouldCycle = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === from) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (byId.get(id)?.dependencies ?? []).some(walk);
    };
    return walk(to);
  };

  for (const [index, task] of tasks.entries()) {
    const declared = task.dependencies;
    const cleaned: string[] = [];
    for (const dependency of declared ?? []) {
      if (dependency === task.id || !known.has(dependency)) continue;
      if (cleaned.includes(dependency)) continue;
      if (wouldCycle(task.id, dependency)) continue;
      cleaned.push(dependency);
    }
    let next = cleaned;
    if (declared === undefined && !task.responderOwned && cleaned.length === 0) {
      const previousForeground = tasks
        .slice(0, index)
        .reverse()
        .find((candidate) => !candidate.responderOwned);
      if (previousForeground && !wouldCycle(task.id, previousForeground.id)) {
        next = [previousForeground.id];
      }
    }
    const previous = declared ?? [];
    if (
      declared === undefined ||
      previous.length !== next.length ||
      previous.some((id, position) => id !== next[position])
    ) {
      task.dependencies = next;
      changed = true;
    }
  }
  return changed;
}

const PLAN_GOAL_MAX_CHARS = 80;

const PLAN_GOAL_HARD_CHARS = 140;

export function shortenPlanGoal(raw: string): string {
  const goal = raw.replace(/\s+/g, " ").trim();
  if (!goal || goal.length <= PLAN_GOAL_MAX_CHARS) return goal;

  const firstSentence = goal.match(/^.+?[.!?](?:\s|$)/);
  if (firstSentence) {
    const candidate = firstSentence[0].trim();
    if (candidate.length >= 12 && candidate.length <= PLAN_GOAL_HARD_CHARS) {
      return candidate;
    }
  }

  const window = goal.slice(0, PLAN_GOAL_MAX_CHARS);
  const boundaryRe = /[,;:]|\s[-–—(]/g;
  let lastBoundaryEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = boundaryRe.exec(window)) !== null) {
    lastBoundaryEnd = m.index;
  }
  if (lastBoundaryEnd >= 24) {
    const candidate = window.slice(0, lastBoundaryEnd).trim();
    if (candidate.length >= 24) return candidate;
  }

  if (goal.length <= PLAN_GOAL_HARD_CHARS) return goal;
  let cut = goal.slice(0, PLAN_GOAL_HARD_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > Math.floor(PLAN_GOAL_HARD_CHARS * 0.5)) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}…`;
}

export function nextPlanTaskId(tasks: readonly Pick<PlanTask, "id">[]): string {
  let max = 0;
  for (const task of tasks) {
    const match = /^t(\d+)$/i.exec(task.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `t${max + 1}`;
  const used = new Set(tasks.map((task) => task.id));
  while (used.has(candidate)) candidate = `t${++max + 1}`;
  return candidate;
}

export function appendPlanTask(
  plan: SessionPlan,
  input: Omit<PlanTask, "id"> & { id?: string | undefined },
): PlanTask {
  const task: PlanTask = {
    ...input,
    id: input.id ?? nextPlanTaskId(plan.tasks),
    dependencies: [...(input.dependencies ?? [])],
    resourceLocks: [...(input.resourceLocks ?? [])],
  };
  if (plan.tasks.some((candidate) => candidate.id === task.id)) {
    throw new Error(`duplicate task id: ${task.id}`);
  }
  if (
    task.parentTaskId &&
    !plan.tasks.some((candidate) => candidate.id === task.parentTaskId)
  ) {
    throw new Error(`unknown parent task: ${task.parentTaskId}`);
  }
  let index = plan.tasks.length;
  if (task.parentTaskId) {
    const parentIndex = plan.tasks.findIndex(
      (candidate) => candidate.id === task.parentTaskId,
    );
    index = parentIndex + 1;
    while (
      index < plan.tasks.length &&
      plan.tasks[index]?.parentTaskId === task.parentTaskId
    ) {
      index += 1;
    }
  }
  plan.tasks.splice(index, 0, task);
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  if (plan.status === "completed" || plan.status === "abandoned") {
    plan.status = "in_progress";
  }
  return task;
}

export function applyForegroundSnapshot(
  draft: SessionPlan,
  snapshot: SessionPlan,
): void {
  const stored = new Map(draft.tasks.map((task) => [task.id, task]));
  const next: PlanTask[] = [];
  for (const task of snapshot.tasks) {
    const existing = stored.get(task.id);
    if (existing?.responderOwned) {
      next.push(existing);
      continue;
    }
    next.push({
      ...task,
      ...(task.evidence === undefined && existing?.evidence
        ? { evidence: existing.evidence }
        : {}),
    });
  }
  const kept = new Set(next.map((task) => task.id));
  for (const task of draft.tasks) {
    if (kept.has(task.id)) continue;
    if (!task.responderOwned) continue;
    const parentIndex = task.parentTaskId
      ? next.findIndex((candidate) => candidate.id === task.parentTaskId)
      : -1;
    if (parentIndex >= 0) next.splice(parentIndex + 1, 0, task);
    else next.push(task);
  }
  draft.tasks = next;
  draft.goal = snapshot.goal;
  draft.detail = snapshot.detail;
  draft.status = snapshot.status;
  draft.kind = snapshot.kind;
  if (snapshot.meta) draft.meta = { ...(draft.meta ?? {}), ...snapshot.meta };
}
