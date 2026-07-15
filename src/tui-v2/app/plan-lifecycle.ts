/**
 * Plan approval/implement/discard orchestration (PLAN-004, F-021/023, V2-070/073).
 *
 * Mirrors the classic TUI's `/implement` path: approve the persisted plan, flip
 * the session policy flag the agent gate reads, then run the implement prompt.
 * Kept out of `PlanController` (persistence only) and out of components.
 */

import type { AppServices } from "../bootstrap/composition-root.js";

export const IMPLEMENT_PROMPT =
  "I approve the plan. Execute it now in STRICT ORDER. Task 1 (explore) is ALREADY COMPLETE from the planning phase — " +
  "do NOT re-list or re-read the directory. Start with the FIRST pending task that still needs implementation work. " +
  "For each task: call task.update {taskId, state:'in_progress'} → do the real work → VERIFY it succeeded → " +
  "call task.update {taskId, state:'done'}, then move to the NEXT task. " +
  "If a tool call FAILS, mark the task 'failed', fix the problem, and retry. Do NOT mark a task done when it failed. " +
  "Build the project for real with fs.writeMany (create all files in as few calls as possible). " +
  "Do NOT call web.search — you already know everything needed. " +
  "Run real commands (installs, servers, verification) — do not claim anything ran without a successful tool call.";

export async function implementPlan(services: AppServices): Promise<void> {
  const plan = services.plan.current();
  if (!plan) return;
  if (plan.tasks.length > 0 && plan.tasks.every((t) => t.state === "done")) return;

  await services.plan.approve();
  services.session.setPlanApproved(true);

  if (services.session.getState().running) {
    services.session.enqueue(IMPLEMENT_PROMPT);
  } else {
    await services.session.submit(IMPLEMENT_PROMPT);
  }
}

export async function discardPlan(services: AppServices): Promise<void> {
  await services.plan.discard();
  services.session.setPlanApproved(false);
}

/**
 * After a turn ends, if a draft plan is waiting, open the plan-ready confirm.
 * "P" views full plan detail via the suspended-over-confirm pager path.
 */
export async function promptPlanApprovalIfNeeded(services: AppServices): Promise<void> {
  if (services.session.isPlanApproved()) return;
  if (services.overlay.isOpen()) return;

  const plan = services.plan.current();
  if (!plan || plan.status !== "draft" || plan.tasks.length === 0) return;

  const ok = await services.overlay.openConfirm(
    {
      kind: "plan",
      prompt: `Implement this plan now? "${plan.goal}" — ${plan.tasks.length} task(s). (Y to implement · N to discard)`,
    },
    async () => {
      const { formatPlanPagerDocument } = await import(
        "../rendering/plan-view.js"
      );
      services.overlay.openPager(
        `Plan · ${plan.goal}`,
        formatPlanPagerDocument(plan),
      );
    },
  );

  if (ok) await implementPlan(services);
  else await discardPlan(services);
}
