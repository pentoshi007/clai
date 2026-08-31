import { PlanTask, SessionPlan } from "./sqlite-backend.js";

/**
 * Heal dependency edges without inventing scheduling.
 *
 * Only genuinely broken edges are removed: self-references, ids that no longer
 * exist, and edges that would close a cycle. Valid forward references are kept
 * so an authored DAG keeps its parallelism. `dependencies: []` is an explicit
 * statement of independence and is never replaced; only a legacy row with no
 * dependency field at all falls back to the previous foreground task, and a
 * responder child never becomes a blocker.
 *
 * Returns true when any task's dependencies changed.
 */
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

/** Plan header goal: keep it a short title, never a full paragraph. */
const PLAN_GOAL_MAX_CHARS = 80;

/** Hard ceiling — beyond this even a clause-boundary cut still applies. */
const PLAN_GOAL_HARD_CHARS = 140;

/**
 * Collapse whitespace and shorten an overlong plan goal to a title.
 * Models sometimes echo the user's full multi-clause request as the goal.
 * Prefer cutting at a natural boundary (sentence end, then comma/paren/dash)
 * so the result still reads as a sensible phrase — never a mid-word or
 * mid-clause fragment with a dangling ellipsis.
 */
export function shortenPlanGoal(raw: string): string {
  const goal = raw.replace(/\s+/g, " ").trim();
  if (!goal || goal.length <= PLAN_GOAL_MAX_CHARS) return goal;

  // 1) First full sentence, if it's already a reasonable title length.
  const firstSentence = goal.match(/^.+?[.!?](?:\s|$)/);
  if (firstSentence) {
    const candidate = firstSentence[0].trim();
    if (candidate.length >= 12 && candidate.length <= PLAN_GOAL_HARD_CHARS) {
      return candidate;
    }
  }

  // 2) Cut at the last clause boundary (, ; : ( — –) at or before the max
  // length, so we keep as much of the meaningful phrase as fits — not the
  // first comma we see (which can land after just 2-3 words).
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

  // 3) No good boundary within range — leave it as-is rather than risk a
  // mangled, meaningless fragment. Only hard-cut if truly excessive.
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

/**
 * Apply a foreground-authored plan snapshot onto fresh state.
 *
 * Whole-plan writes (plan.create, revisions, task.add reordering) are authored
 * against a loaded copy. Replacing the stored plan with that copy dropped
 * anything an asynchronous writer changed in the meantime. This applies the
 * snapshot's foreground intent while treating responder children as owned by
 * process settlement:
 *
 * - responder-owned rows keep their stored state/note/job linkage;
 * - responder children created concurrently are retained;
 * - stored evidence is kept when the snapshot has none for that task.
 */
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
    // Only responder children may appear from a concurrent writer; a foreground
    // task missing from the snapshot was intentionally removed by the author.
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
