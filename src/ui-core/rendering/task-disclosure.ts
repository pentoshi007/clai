import stringWidth from "string-width";
import type { PlanTask, SessionPlan } from "../../store/plan.js";
import { activeTaskId, wrapPlanText } from "./plan-view.js";

export const TASK_DISCLOSURE_BUTTON_WIDTH = 1;

export interface TaskDisclosureState {
  readonly planKey: string;
  readonly expanded: ReadonlySet<string>;
  readonly selectedId: string | undefined;
  readonly keyboardFocusVisible?: boolean;
}

export function taskDetailText(task: PlanTask): string {
  const jobLabel = task.jobId
    ? `job=${task.jobId}${task.processId ? ` pid=${task.processId}` : ""}`
    : undefined;
  return [jobLabel, task.note?.trim()].filter(Boolean).join(" · ");
}

export function hasTaskDetails(task: PlanTask): boolean {
  return Boolean(task.note?.trim() || task.jobId);
}

export function wrapTaskDisclosureTitle(title: string, width: number, expandable: boolean): string[] {
  const lines = wrapPlanText(title, Math.max(1, width - 5));
  if (!expandable) return lines;
  const last = lines[lines.length - 1]!;
  const finalWidth = Math.max(1, width - 6 - TASK_DISCLOSURE_BUTTON_WIDTH);
  if (stringWidth(last) <= finalWidth) return lines;
  const space = last.lastIndexOf(" ");
  if (space > 0 && stringWidth(last.slice(space + 1)) <= finalWidth) {
    return [...lines.slice(0, -1), last.slice(0, space), last.slice(space + 1)];
  }
  return [...lines.slice(0, -1), ...wrapPlanText(last, finalWidth)];
}

export function reconcileTaskDisclosure(
  state: TaskDisclosureState,
  plan: SessionPlan | undefined,
  displayTasks: readonly PlanTask[],
): TaskDisclosureState {
  const planKey = plan ? JSON.stringify([plan.sessionId, plan.createdAt]) : "";
  const samePlan = state.planKey === planKey;
  const selectedId = samePlan && displayTasks.some((task) => task.id === state.selectedId)
    ? state.selectedId
    : (plan ? activeTaskId(plan) : undefined) ?? displayTasks[0]?.id;
  const expanded = new Set(displayTasks.filter((task) => samePlan && state.expanded.has(task.id) && hasTaskDetails(task)).map((task) => task.id));
  if (samePlan && selectedId === state.selectedId && expanded.size === state.expanded.size) return state;
  return { planKey, selectedId, expanded, keyboardFocusVisible: samePlan && state.keyboardFocusVisible === true };
}

export function setTaskDisclosure(
  state: TaskDisclosureState,
  task: PlanTask,
  expanded: boolean = !state.expanded.has(task.id),
): TaskDisclosureState {
  if (!hasTaskDetails(task)) return state;
  const next = new Set(state.expanded);
  if (expanded) next.add(task.id);
  else next.delete(task.id);
  return { ...state, selectedId: task.id, expanded: next };
}

export function setAllTaskDisclosure(
  state: TaskDisclosureState,
  tasks: readonly PlanTask[],
  expanded: boolean,
): TaskDisclosureState {
  return { ...state, expanded: new Set(expanded ? tasks.filter(hasTaskDetails).map((task) => task.id) : []) };
}

export function moveTaskSelection(
  state: TaskDisclosureState,
  tasks: readonly PlanTask[],
  delta: number,
): TaskDisclosureState {
  if (tasks.length === 0) return state;
  const current = Math.max(0, tasks.findIndex((task) => task.id === state.selectedId));
  const index = Math.max(0, Math.min(tasks.length - 1, current + delta));
  return { ...state, selectedId: tasks[index]!.id };
}

export function taskDisclosureSummary(tasks: readonly PlanTask[], expanded: ReadonlySet<string>): {
  readonly total: number;
  readonly expanded: number;
} {
  let total = 0;
  let count = 0;
  for (const task of tasks) {
    if (!hasTaskDetails(task)) continue;
    total += 1;
    if (expanded.has(task.id)) count += 1;
  }
  return { total, expanded: count };
}
