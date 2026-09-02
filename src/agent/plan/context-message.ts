import { readyPlanTasks } from "../../store/plan.js";
import type { SessionPlan } from "../../store/plan.js";

export function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    const aliasHint =
      t.aliases?.length && t.aliases[0] !== t.id
        ? ` [aliases: ${t.aliases.slice(0, 3).join(", ")}]`
        : "";
    const dependencyHint = t.dependencies?.length
      ? ` [depends: ${t.dependencies.join(", ")}]`
      : "";
    const resourceHint = t.resourceLocks?.length
      ? ` [locks: ${t.resourceLocks.join(", ")}]`
      : "";
    const acceptanceHint = t.acceptanceCriteria?.trim()
      ? ` [acceptance: ${t.acceptanceCriteria.trim()}]`
      : "";
    const hierarchyHint = t.parentTaskId ? ` [child of ${t.parentTaskId}]` : "";
    const jobHint = t.jobId
      ? ` [responder job=${t.jobId}${t.processId ? ` pid=${t.processId}` : ""}]`
      : "";
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}${hierarchyHint}${jobHint}${aliasHint}${dependencyHint}${resourceHint}${acceptanceHint}`);
  });
  lines.push(
    "task.update taskId MUST be t1, t2, … from this list (or a listed alias). Use task.add for newly discovered work; it is placed before unfinished report creation. Use task.move with position/beforeTaskId/afterTaskId to rearrange work without changing ids or evidence. Responder-owned job tasks advance automatically; never task.update them. After analyzing a delivered Responder result, job.read its job or notification before finalizing.",
  );
  if (plan.meta?.projectRoot) {
    lines.push(`project_root: ${plan.meta.projectRoot}`);
  }
  if (plan.meta?.packageManager) {
    lines.push(`package_manager: ${plan.meta.packageManager}`);
  }
  if (approved) {
    const inProgress = plan.tasks.find(
      (task) => task.state === "in_progress" && !task.responderOwned,
    );
    const failed = plan.tasks.find(
      (task) => task.state === "failed" && !task.responderOwned,
    );
    const firstPending = readyPlanTasks(plan)[0];
    const hasOpenWork = plan.tasks.some(
      (task) =>
        !task.responderOwned &&
        (task.state === "in_progress" ||
          task.state === "pending" ||
          task.state === "failed"),
    );
    lines.push(
      "The user APPROVED this plan. Execute it NOW. Tasks are checkpoints — you still own the user's requested boundary. Their states are authoritative for tracked work, but a completed phase is not completion of an explicitly requested whole roadmap/program.",
    );
    if (inProgress) {
      lines.push(
        `RESUME TASK ${inProgress.id} (${inProgress.title}) — it was started but interrupted. ` +
          "Retry what was in progress; do NOT restart completed work from scratch. " +
          "Do NOT re-do tasks already marked done.",
      );
    } else if (failed) {
      lines.push(
        `RETRY FAILED TASK ${failed.id} (${failed.title}) — reopen it (task.update in_progress), ` +
          "fix the root cause, then re-verify before marking done. Do NOT re-do tasks already marked done.",
      );
    } else if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done.",
      );
    }
    if (hasOpenWork) {
      lines.push(
        "FIRST THIS TURN — reconcile with this task list before doing anything else. It persists across abort and " +
          "compaction, is re-injected here every turn, and is the CURRENT source of truth for what is done vs pending. " +
          "It OVERRIDES any 'current state', 'remaining work', 'ready to…', or completion wording in the compacted memory " +
          "summary; when the summary and these task states disagree, trust these task states.",
      );
      lines.push(
        "Let task states identify the current foreground outcome and avoid rediscovering settled work. Read that task's " +
          "artifacts plus only the prior evidence needed for its dependencies. One foreground task stays in_progress for " +
          "state integrity, but the plan is a living outcome map rather than an inflexible script: if evidence exposes " +
          "required work or invalidates priority, add the discovery, return the current task to pending when necessary, " +
          "and deliberately open the new highest-priority ready task. Preserve completed evidence and never re-scan the " +
          "whole project merely to recover status. You may stop with open tasks only when genuinely blocked, told to stop, " +
          "or waiting on declared external work; report the exact remainder honestly.",
      );
    }
    lines.push(
      "Flow: task.update in_progress → pursue the task's outcome using the evidence-appropriate method → WAIT for and READ every result → " +
        "verify its acceptance evidence → mark done only when the outcome holds → open the next ready task. " +
        "A launched command is not evidence of completion, and one successful path may not cover the task's relevant edge, integration, or regression surface. " +
        "Capture unrelated or newly required discoveries with task.add; do not silently broaden scope or discard them. " +
        "A durable background launch creates a Responder-owned child task: launch high-value slow work early only when independent work remains, and never busy-poll or duplicate it. " +
        "If only Responder-owned child tasks remain, yield honestly; Responder will inject the durable completion. " +
        "Durable evidence beside a task survives resume; reuse it rather than repeating confirmed work. " +
        "Independent read-only lookups may parallelize when their results do not depend on each other. " +
        "If a tool fails, interpret why, revise the hypothesis or environment, and retry with a materially improved approach instead of ritual repetition. " +
        "Before finalizing, reconcile every requested acceptance criterion, task, affected surface, and material residual uncertainty. " +
        "For software, use applicable automated and runtime/integration proof. For security, use remote target evidence and explicit attack-surface residuals. " +
        "Do not re-open done tasks.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved — do not execute tasks (no scaffold/write/install/exploit). " +
        "User free-text is PLAN REVISION feedback, not approval — even if it sounds like an instruction. " +
        "On revision: call plan.create with the COMPLETE intended checklist (drop obsolete tasks; " +
        "matching titles keep stable ids). Be decisive — one coherent rewrite, then STOP. " +
        "User may Accept, Discard, View, or Suggest changes (or /implement / /discard).",
    );
  }
  return lines.join("\n");
}
