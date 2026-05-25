import { randomUUID } from "node:crypto";

export type TaskComplexity = "simple" | "standard" | "complex";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type TaskKind =
  | "answer"
  | "shell"
  | "filesystem"
  | "network-discovery"
  | "dns"
  | "whois"
  | "web-enum"
  | "pentest-recon"
  | "package"
  | "other";

export interface PlanStep {
  id: string;
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  successCriteria?: string | undefined;
  required?: boolean | undefined;
  notes?: string | undefined;
  toolHint?: string | undefined;
}

export interface TaskPlan {
  id: string;
  goal: string;
  complexity: TaskComplexity;
  steps: PlanStep[];
  currentStepId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export function createPlanStep(
  title: string,
  kind: TaskKind,
  extra: Partial<Omit<PlanStep, "id" | "title" | "kind" | "status">> = {},
): PlanStep {
  return {
    id: randomUUID(),
    title,
    kind,
    status: "pending",
    ...extra,
  };
}

export function createTaskPlan(
  goal: string,
  complexity: TaskComplexity,
  steps: PlanStep[],
): TaskPlan {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    goal,
    complexity,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function markStepRunning(plan: TaskPlan, stepId: string): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = "running";
    plan.currentStepId = stepId;
    plan.updatedAt = new Date().toISOString();
  }
}

export function markStepDone(
  plan: TaskPlan,
  stepId: string,
  note?: string | undefined,
): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = "done";
    if (note) step.notes = note;
    plan.updatedAt = new Date().toISOString();
  }
}

export function markStepFailed(
  plan: TaskPlan,
  stepId: string,
  note?: string | undefined,
): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (step) {
    step.status = "failed";
    if (note) step.notes = note;
    plan.updatedAt = new Date().toISOString();
  }
}

export function nextPendingStep(plan: TaskPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
}

export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.steps
    .filter((s) => s.required !== false)
    .every((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
}

/**
 * Compact plan summary for LLM context injection. Keeps token count low.
 */
export function formatPlanForPrompt(plan: TaskPlan): string {
  const lines = [`PLAN: ${plan.goal} (${plan.complexity})`];
  for (const step of plan.steps) {
    const marker =
      step.status === "done"
        ? "[x]"
        : step.status === "running"
          ? "[>]"
          : step.status === "failed"
            ? "[!]"
            : step.status === "skipped"
              ? "[-]"
              : "[ ]";
    const note = step.notes ? ` (${step.notes})` : "";
    lines.push(`  ${marker} ${step.title}${note}`);
  }
  return lines.join("\n");
}

/**
 * Terminal-formatted plan for user display. Uses Unicode box-drawing.
 */
export function formatPlanForDisplay(plan: TaskPlan): string {
  const icons: Record<TaskStatus, string> = {
    pending: "·",
    running: "▶",
    done: "✓",
    failed: "✗",
    skipped: "↷",
  };
  const lines = [`📋 ${plan.goal} (${plan.complexity})`];
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!;
    const icon = icons[step.status];
    const note = step.notes ? ` — ${step.notes}` : "";
    lines.push(`  ${icon} ${i + 1}. ${step.title}${note}`);
  }
  const done = plan.steps.filter((s) => s.status === "done").length;
  lines.push(`  Progress: ${done}/${plan.steps.length}`);
  return lines.join("\n");
}
