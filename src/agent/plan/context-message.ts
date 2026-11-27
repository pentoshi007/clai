import { readyPlanTasks } from "../../store/plan.js";
import type { PlanTask, SessionPlan } from "../../store/plan.js";

function listHint(label: string, values: string[] | undefined): string {
  return values?.length ? ` [${label}: ${values.join(", ")}]` : "";
}

function taskLine(task: PlanTask, index: number): string {
  const hierarchy = task.parentTaskId ? ` [child of ${task.parentTaskId}]` : "";
  const pid = task.processId ? ` pid=${task.processId}` : "";
  const job = task.jobId ? ` [responder job=${task.jobId}${pid}]` : "";
  const aliases = task.aliases?.[0] === task.id ? undefined : task.aliases?.slice(0, 3);
  const acceptance = task.acceptanceCriteria?.trim();
  const done = acceptance ? ` [acceptance: ${acceptance}]` : "";
  return `  ${index + 1}. [${task.id}] (${task.state}) ${task.title}${hierarchy}${job}` +
    listHint("aliases", aliases) + listHint("depends", task.dependencies) + listHint("locks", task.resourceLocks) + done;
}

export function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines = [`ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`];
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:", ...plan.tasks.map(taskLine));
  lines.push(
    "task.update taskId MUST be t1, t2, … from this list (or a listed alias). Use task.move with position/beforeTaskId/afterTaskId to rearrange work without changing ids or evidence. Responder-owned job tasks advance automatically; never task.update them. After analyzing a delivered Responder result, job.read its job or notification before finalizing.",
  );
  if (plan.meta?.projectRoot) lines.push(`project_root: ${plan.meta.projectRoot}`);
  if (plan.meta?.packageManager) lines.push(`package_manager: ${plan.meta.packageManager}`);
  if (approved) lines.push(...approvedPlanGuidance(plan));
  else lines.push(
    "This plan is NOT yet approved — do not execute tasks (no scaffold/write/install/exploit). " +
      "User free-text is PLAN REVISION feedback, not approval — even if it sounds like an instruction. " +
      "On revision: call plan.create with the COMPLETE intended checklist (drop obsolete tasks; " +
      "matching titles keep stable ids). Be decisive — one coherent rewrite, then STOP. " +
      "User may Accept, Discard, View, or Suggest changes (or /implement / /discard).",
  );
  return lines.join("\n");
}

export function planNextDirective(plan: SessionPlan): string | undefined {
  if (plan.status === "completed") return undefined;
  const open = plan.tasks.filter(task => !task.responderOwned);
  const inProgress = open.find(task => task.state === "in_progress");
  if (inProgress) {
    return `RESUME TASK ${inProgress.id} (${inProgress.title}) — it was started but interrupted. Retry what was in progress; do NOT restart completed work from scratch.`;
  }
  const failed = open.find(task => task.state === "failed");
  if (failed) {
    return `RETRY FAILED TASK ${failed.id} (${failed.title}) — reopen it (task.update in_progress), fix the root cause, then re-verify before marking done.`;
  }
  const firstPending = readyPlanTasks(plan)[0];
  return firstPending ? `START WITH TASK ${firstPending.id} (${firstPending.title}).` : undefined;
}

function approvedPlanGuidance(plan: SessionPlan): string[] {
  const lines = [
    "Capture unrelated or newly required discoveries with task.add in one tasks array; do not silently broaden scope. " +
      "For follow-ups that expand scope, including after completion, use one plan.update with all new tasks and a concise goal covering old and new scope. Do not recreate the plan or re-list finished tasks.",
  ];
  if (plan.status === "completed") return lines;
  const open = plan.tasks.filter(task => !task.responderOwned);
  const next = planNextDirective(plan);
  lines.push(
    "The user APPROVED this plan. Execute it NOW. Tasks are checkpoints — you still own the user's requested boundary. Their states are authoritative for tracked work, but a completed phase is not completion of an explicitly requested whole roadmap/program.",
  );
  if (next) lines.push(next);
  if (open.some(task => task.state === "in_progress" || task.state === "failed" || task.state === "pending")) {
    lines.push(
      "FIRST THIS TURN — reconcile with this task list before doing anything else. It persists across abort and compaction and overrides older task states or completion wording. " +
        "Read the current task's artifacts and its dependencies' evidence rather than rediscovering settled work. Keep one foreground task in_progress. " +
        "The plan is a living outcome map rather than an inflexible script: if evidence changes priority, return the current task to pending and open the highest-priority ready task. " +
        "Stop with tasks unfinished only for a real blocker, user request, or declared external dependency; report the exact remainder.",
    );
  }
  lines.push(
    "Flow: task.update in_progress → pursue the outcome → WAIT for and READ every result → verify its acceptance evidence → mark done → open the next ready task. " +
      "A launched command is not proof; check relevant edge, integration, and regression behavior. Do not re-open done tasks. " +
      "A durable background launch creates a Responder-owned child task: launch high-value slow work early only when independent work remains, and never busy-poll or duplicate it. " +
      "If only Responder-owned child tasks remain, yield honestly; Responder will inject the durable completion. " +
      "Durable evidence beside a task survives resume; reuse it. Parallelize independent reads. If a tool fails, interpret why and change approach before retrying. " +
      "Before finalizing, reconcile every requested acceptance criterion, task, affected surface, and material residual uncertainty. " +
      "For software, use applicable automated and runtime/integration proof. For security, use remote target evidence and explicit attack-surface residuals.",
  );
  return lines;
}
