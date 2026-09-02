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

export function isPlanTerminal(plan: TaskPlan): boolean {
  return plan.steps
    .filter((s) => s.required !== false)
    .every((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
}

export function isPlanSuccessful(plan: TaskPlan): boolean {
  return plan.steps
    .filter((s) => s.required !== false)
    .every((s) => s.status === "done" || s.status === "skipped");
}

/** @deprecated Use isPlanTerminal or isPlanSuccessful explicitly. */
export function isPlanComplete(plan: TaskPlan): boolean {
  return isPlanSuccessful(plan);
}

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


export interface VersionedPlanStep extends PlanStep {
  dependencies?: string[] | undefined;
  resourceLocks?: string[] | undefined;
  supersededBy?: string | undefined;
  parentTaskId?: string | undefined;
  jobId?: string | undefined;
  processId?: number | undefined;
  responderOwned?: boolean | undefined;
}

export interface VersionedTaskPlan extends Omit<TaskPlan, "steps"> {
  schemaVersion: 2;
  version: number;
  steps: VersionedPlanStep[];
}

interface VersionedPlanOperation {
  expectedVersion: number;
}

export type PlanOperation = VersionedPlanOperation & (
  | { type: "addTask"; step: VersionedPlanStep; index?: number }
  | { type: "editTask"; stepId: string; changes: Partial<Omit<VersionedPlanStep, "id">> }
  | { type: "removeTask"; stepId: string }
  | { type: "moveTask"; stepId: string; index: number }
  | { type: "supersedeTask"; stepId: string; replacement: VersionedPlanStep }
  | { type: "splitTask"; stepId: string; steps: VersionedPlanStep[] }
  | { type: "mergeTasks"; stepIds: string[]; step: VersionedPlanStep }
  | { type: "setDependencies"; stepId: string; dependencies: string[] }
);

export function deserializeTaskPlan(value: unknown): VersionedTaskPlan {
  if (!value || typeof value !== "object") throw new Error("invalid task plan");
  const raw = value as Partial<TaskPlan & VersionedTaskPlan>;
  if (!Array.isArray(raw.steps) || typeof raw.id !== "string" || typeof raw.goal !== "string") {
    throw new Error("invalid task plan");
  }
  const plan: VersionedTaskPlan = {
    id: raw.id,
    goal: raw.goal,
    complexity: raw.complexity ?? "standard",
    currentStepId: raw.currentStepId,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
    schemaVersion: 2,
    version: typeof raw.version === "number" && raw.version >= 1 ? raw.version : 1,
    steps: (raw.steps as VersionedPlanStep[]).map((step) => ({
      ...step,
      dependencies: [...(step.dependencies ?? [])],
      resourceLocks: [...(step.resourceLocks ?? [])],
    })),
  };
  assertValidPlanDag(plan);
  return plan;
}

export function validatePlanDag(plan: Pick<VersionedTaskPlan, "steps">): { ok: true } | { ok: false; reason: string } {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) return { ok: false, reason: `duplicate step id: ${step.id}` };
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependencies ?? []) {
      if (!ids.has(dependency)) return { ok: false, reason: `unknown dependency ${dependency} for ${step.id}` };
      if (dependency === step.id) return { ok: false, reason: `self dependency: ${step.id}` };
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  for (const id of ids) if (!visit(id)) return { ok: false, reason: "dependency cycle detected" };
  return { ok: true };
}

export function assertValidPlanDag(plan: Pick<VersionedTaskPlan, "steps">): void {
  const result = validatePlanDag(plan);
  if (!result.ok) throw new Error(result.reason);
}

export function readyPlanSteps(plan: Pick<VersionedTaskPlan, "steps">): VersionedPlanStep[] {
  const done = new Set(plan.steps.filter((step) => step.status === "done" || step.status === "skipped").map((step) => step.id));
  const held = new Set(plan.steps.filter((step) => step.status === "running").flatMap((step) => step.resourceLocks ?? []));
  return plan.steps.filter((step) =>
    step.status === "pending" &&
    !step.supersededBy &&
    (step.dependencies ?? []).every((id) => done.has(id)) &&
    !(step.resourceLocks ?? []).some((resource) => held.has(resource)),
  );
}

export function applyPlanOperation(plan: VersionedTaskPlan, operation: PlanOperation): VersionedTaskPlan {
  if (operation.expectedVersion !== plan.version) {
    throw new Error(`plan version mismatch: expected ${operation.expectedVersion}, current ${plan.version}`);
  }
  const normalizeStep = (step: VersionedPlanStep): VersionedPlanStep => ({
    ...step,
    dependencies: [...(step.dependencies ?? [])],
    resourceLocks: [...(step.resourceLocks ?? [])],
  });
  let steps: VersionedPlanStep[] = plan.steps.map(normalizeStep);
  const indexOf = (id: string): number => {
    const index = steps.findIndex((step) => step.id === id);
    if (index < 0) throw new Error(`unknown step: ${id}`);
    return index;
  };
  if (operation.type === "addTask") steps.splice(operation.index ?? steps.length, 0, normalizeStep(operation.step));
  else if (operation.type === "editTask") { const index = indexOf(operation.stepId); steps[index] = normalizeStep({ ...steps[index]!, ...operation.changes, id: operation.stepId }); }
  else if (operation.type === "moveTask") {
    const from = indexOf(operation.stepId);
    if (!Number.isInteger(operation.index)) throw new Error("move index must be an integer");
    const [moved] = steps.splice(from, 1);
    const to = Math.max(0, Math.min(operation.index, steps.length));
    steps.splice(to, 0, moved!);
  } else if (operation.type === "removeTask") {
    indexOf(operation.stepId);
    if (steps.some((step) => (step.dependencies ?? []).includes(operation.stepId))) throw new Error(`cannot remove depended-on step: ${operation.stepId}`);
    steps = steps.filter((step) => step.id !== operation.stepId);
  } else if (operation.type === "setDependencies") {
    const index = indexOf(operation.stepId); steps[index] = { ...steps[index]!, dependencies: [...new Set(operation.dependencies)] };
  } else if (operation.type === "supersedeTask") {
    const index = indexOf(operation.stepId); steps[index] = { ...steps[index]!, status: "skipped", supersededBy: operation.replacement.id };
    steps.splice(index + 1, 0, normalizeStep({ ...operation.replacement, dependencies: operation.replacement.dependencies ?? steps[index]!.dependencies }));
    steps = steps.map((step) => ({ ...step, dependencies: (step.dependencies ?? []).map((id) => id === operation.stepId ? operation.replacement.id : id) }));
  } else if (operation.type === "splitTask") {
    const index = indexOf(operation.stepId); const original = steps[index]!;
    if (operation.steps.length < 2) throw new Error("split requires at least two replacement steps");
    const replacements = operation.steps.map((step, i) => normalizeStep({ ...step, dependencies: (step.dependencies?.length ?? 0) > 0 ? step.dependencies : (i === 0 ? original.dependencies : [operation.steps[i - 1]!.id]) }));
    steps.splice(index, 1, ...replacements);
    const finalId = replacements.at(-1)!.id;
    steps = steps.map((step) => ({ ...step, dependencies: (step.dependencies ?? []).map((id) => id === operation.stepId ? finalId : id) }));
  } else {
    if (operation.stepIds.length < 2) throw new Error("merge requires at least two steps");
    const indexes = operation.stepIds.map(indexOf); const selected = new Set(operation.stepIds); const first = Math.min(...indexes);
    const dependencies = [...new Set(operation.stepIds.flatMap((id) => steps[indexOf(id)]!.dependencies ?? []).filter((id) => !selected.has(id)))];
    steps = steps.filter((step) => !selected.has(step.id));
    steps.splice(first, 0, normalizeStep({ ...operation.step, dependencies: operation.step.dependencies ?? dependencies }));
    steps = steps.map((step) => ({ ...step, dependencies: (step.dependencies ?? []).map((id) => selected.has(id) ? operation.step.id : id) }));
  }
  const next = { ...plan, steps, version: plan.version + 1, updatedAt: new Date().toISOString() };
  assertValidPlanDag(next);
  return next;
}
