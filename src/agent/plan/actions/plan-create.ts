import chalk from "chalk";
import {
  appendPlanTask,
  applyForegroundSnapshot,
  createPlan,
  foregroundTasks,
  isBareTaskIdTitle,
  isPlanTerminal,
  loadPlan,
  mutatePlan,
  nextPlanTaskId,
  normalizeTaskDependencies,
  readyPlanTasks,
  savePlan,
  validateSessionPlan,
  type PlanTask,
  type SessionPlan,
} from "../../../store/plan.js";
import type { ToolCall } from "../../../types.js";
import { getActiveProjectRoot } from "../../project-root.js";
import type { SessionPolicy } from "../../session-policy.js";
import { isLumpedSingleTask } from "../../tool-call-parser.js";
import { detectPackageManager } from "../../workspace-orient.js";
import { renderPlanForTerminal, type PlanToolResult } from "../handle-plan-tool.js";
import {
  looksLikeRunOnlyGoal,
  normalizePlanDetail,
  normalizePlanGoal,
  normalizePlanKind,
  normalizePlanTaskEntries,
  resolvePlanTaskId,
  titlesMatchForPlan,
  type NormalizedPlanTask,
} from "../normalization.js";

type Proposal = { goal: string; detail: string; kind: string; entries: NormalizedPlanTask[] };

function readProposal(args: ToolCall["args"]): Proposal | string {
  const goal = normalizePlanGoal(args);
  const entries = normalizePlanTaskEntries(args).filter(entry => !isBareTaskIdTitle(entry.title));
  if (!goal || !entries.length) return "provide a string goal and a non-empty tasks array.";
  if (isLumpedSingleTask(entries.map(task => task.title))) {
    return "that single task lumps the whole build into one step. Break it into distinct outcomes (implementation, checks, and runtime verification).";
  }
  return { goal, detail: normalizePlanDetail(args), kind: normalizePlanKind(args), entries };
}

function createFailure(reason: string): PlanToolResult {
  return { handled: true, ok: false, display: chalk.red(`  ✗ plan.create: ${reason}\n`), modelNote: `plan.create failed: ${reason}` };
}

function appendProposal(draft: SessionPlan, entries: NormalizedPlanTask[]): PlanTask[] | string {
  if (draft.status === "draft") return "the plan changed. Reload it before retrying.";
  const added: PlanTask[] = [];
  let previousId = foregroundTasks(draft).at(-1)?.id;
  for (const entry of entries) {
    if (draft.tasks.some(task => titlesMatchForPlan(task.title, entry.title))) continue;
    const references = entry.dependenciesSpecified ? entry.dependencies : [previousId].filter(id => id !== undefined);
    const dependencies: string[] = [];
    for (const reference of references) {
      const id = resolvePlanTaskId(draft, reference);
      if (!id) return `unknown dependency "${reference}".`;
      dependencies.push(id);
    }
    const { title, aliases, resourceLocks, acceptanceCriteria } = entry;
    const task = appendPlanTask(draft, { title, aliases, resourceLocks, acceptanceCriteria, state: "pending", dependencies: [...new Set(dependencies)] });
    added.push(task);
    previousId = task.id;
  }
  return added;
}

async function extendExistingPlan(session: SessionPolicy, entries: NormalizedPlanTask[]): Promise<PlanToolResult> {
  let appended: PlanTask[] | string = [];
  const saved = await mutatePlan(session.sessionId, (draft) => {
    appended = appendProposal(draft, entries);
    return typeof appended !== "string" && appended.length > 0;
  });
  if (typeof appended === "string") return createFailure(`${appended} Use plan.update to extend ACTIVE PLAN.`);
  if (!saved.ok || !saved.plan) {
    const reason = saved.reason === "no-change" ? "every proposed task already exists in ACTIVE PLAN" : saved.reason;
    return createFailure(`kept the existing plan (${reason}). Use one plan.update for revised metadata and genuine additions.`);
  }
  session.planApproved.value = true;
  return {
    handled: true,
    ok: true,
    plan: saved.plan,
    display: chalk.cyan("  ● active plan extended (append-only)\n") + renderPlanForTerminal(saved.plan) + "\n",
    modelNote: `Preserved ACTIVE PLAN and appended ${appended.map(task => `[${task.id}]`).join(", ")}. ` +
      "Do NOT re-execute completed work. Continue the current task or open the next ready one. For future follow-ups, use one plan.update to refresh the title/detail and append all new tasks together.",
  };
}

function preserveDraftTasks(plan: SessionPlan, previous: SessionPlan): void {
  const matched = new Map<string, PlanTask>();
  const used = new Set<string>();
  for (const task of plan.tasks) {
    const prior = previous.tasks.find(old => !used.has(old.id) && titlesMatchForPlan(old.title, task.title));
    if (!prior) continue;
    matched.set(task.id, prior);
    used.add(prior.id);
  }
  const reserved = [...previous.tasks, ...plan.tasks];
  plan.tasks = plan.tasks.map(task => {
    const prior = matched.get(task.id);
    if (prior) return { ...prior, ...task, id: prior.id, state: prior.state };
    if (!used.has(task.id)) return task;
    const id = nextPlanTaskId(reserved);
    reserved.push({ ...task, id });
    return { ...task, id };
  });
}

function setDraftTaskDetails(plan: SessionPlan, entries: NormalizedPlanTask[]): void {
  for (const [i, task] of plan.tasks.entries()) {
    const input = entries[i]!;
    task.aliases = input.aliases;
    task.resourceLocks = input.resourceLocks;
    task.acceptanceCriteria = input.acceptanceCriteria ?? task.acceptanceCriteria;
  }
  const positional = new Map(plan.tasks.map((task, index) => [`t${index + 1}`, task.id]));
  for (const [i, task] of plan.tasks.entries()) {
    const input = entries[i]!;
    task.dependencies = input.dependenciesSpecified
      ? input.dependencies.map(ref => positional.get(ref) ?? resolvePlanTaskId(plan, ref) ?? ref)
      : plan.tasks.slice(Math.max(0, i - 1), i).map(previous => previous.id);
  }
  normalizeTaskDependencies(plan.tasks);
}

function buildDraft(sessionId: string, proposal: Proposal, previous: SessionPlan | undefined, autoApprove: boolean): SessionPlan {
  const projectRoot = getActiveProjectRoot();
  const packageManager = projectRoot ? detectPackageManager(projectRoot) : undefined;
  const plan = createPlan({
    sessionId,
    goal: proposal.goal,
    detail: proposal.detail,
    kind: proposal.kind,
    taskTitles: proposal.entries.map(entry => entry.title),
    meta: { ...previous?.meta, ...(projectRoot ? { projectRoot } : {}), ...(packageManager ? { packageManager } : {}) },
  });
  if (previous) preserveDraftTasks(plan, previous);
  setDraftTaskDetails(plan, proposal.entries);
  if (autoApprove) plan.status = "approved";
  return plan;
}

async function saveDraft(plan: SessionPlan, previous: SessionPlan | undefined): Promise<SessionPlan | undefined> {
  if (!previous) {
    await savePlan(plan);
    return loadPlan(plan.sessionId);
  }
  const revised = await mutatePlan(plan.sessionId, draft => {
    if (draft.status !== "draft") return false;
    applyForegroundSnapshot(draft, plan);
    return true;
  }, { expectedVersion: previous.version });
  return revised.ok ? revised.plan : undefined;
}

function describeCreatedPlan(plan: SessionPlan, autoApprove: boolean): PlanToolResult {
  const first = readyPlanTasks(plan)[0];
  const heading = autoApprove ? "plan created (auto-approved)" : "planning";
  const next = autoApprove
    ? `Execute now.${first ? ` Start with [${first.id}] "${first.title}".` : ""} task.update in_progress → work → verify → done.`
    : "STOP here and wait for approval. On revision feedback, call plan.create once with the COMPLETE updated goal/detail/tasks; omit obsolete work. Then STOP again for Accept, Discard, View, or Suggest changes.";
  return {
    handled: true,
    ok: true,
    plan,
    display: chalk.cyan(`  ● ${heading}\n`) + renderPlanForTerminal(plan) + "\n",
    modelNote: `Plan saved with ${plan.tasks.length} task(s). ${next} When run/verify completes: report URL, port, job id, and that the server is still running.`,
  };
}

export async function handlePlanCreate(call: ToolCall, session: SessionPolicy, autoApprove: boolean): Promise<PlanToolResult> {
  const proposal = readProposal(call.args);
  if (typeof proposal === "string") return createFailure(proposal);
  const previous = await loadPlan(session.sessionId);
  if (previous && previous.status !== "draft") {
    if (isPlanTerminal(previous) && looksLikeRunOnlyGoal(proposal.goal, proposal.detail)) {
      return createFailure("Do NOT create a new plan just to run or verify the existing app. Use the runtime tools and preserve completed work.");
    }
    return extendExistingPlan(session, proposal.entries);
  }
  const draft = buildDraft(session.sessionId, proposal, previous, autoApprove);
  const validation = validateSessionPlan(draft);
  if (!validation.ok) return createFailure(`${validation.reason}. Use declared task ids or aliases and remove dependency cycles.`);
  const saved = await saveDraft(draft, previous);
  if (!saved) return createFailure("revision was not durably committed. Reload the plan before retrying.");
  session.planApproved.value = autoApprove;
  return describeCreatedPlan(saved, autoApprove);
}
