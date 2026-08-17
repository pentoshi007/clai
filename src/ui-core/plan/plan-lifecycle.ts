/**
 * Plan approval/implement/discard/suggest orchestration (PLAN-004, F-021/023, V2-070/073).
 *
 * Mirrors the classic TUI's `/implement` path: approve the persisted plan, flip
 * the session policy flag the agent gate reads, switch to agent mode, then run
 * the implement prompt. Kept out of `PlanController` (persistence only) and out
 * of components.
 */

import { setDefaultMode } from "../../store/config.js";
import { buildPlanRevisionPrompt } from "../../agent/plan-decision.js";
import { estimateMessagesTokens } from "../../agent/context-manager.js";
import {
  acceptPlanImplementCompaction,
  extractCompactionSummaryBody,
  PLAN_IMPLEMENT_COMPACT_MIN_TOKENS,
} from "../../agent/plan-implement-compact.js";
import { isPlanSuccessful, type SessionPlan } from "../../store/plan.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import { serializeTranscriptForCompaction } from "../state/transcript-compaction.js";
import { notify, notifyWarn } from "../notify.js";

/** Coding / build plans — scaffold + verify. */
export const IMPLEMENT_PROMPT_CODING =
  "Plan approved. Execute it. " +
  "Work through pending tasks in dependency order. For each: mark in_progress → do real work → verify → mark done (or failed and recover). " +
  "Skip tasks already done. Adapt if reality differs from the plan. " +
  "Do not claim done without tool evidence. Build for real with fs.write / fs.writeMany when needed. " +
  "For local apps: shell.start, leave the server running, report URL + port + job id.";

/** Pentest / security plans — no local dev-server assumption. */
export const IMPLEMENT_PROMPT_PENTEST =
  "Plan approved. Execute the engagement tasks. " +
  "Work through pending tasks: in_progress → recon/testing with tools → done (or failed with a note). " +
  "Prefer tool.batch / dns / http.fetch / net.scan for recon; continue when one lookup fails. " +
  "Do NOT start a local dev server, npm run dev, bun run, vite, next, or shell.start. " +
  "Do NOT list or read the clai workspace/package.json as a follow-up. Stay on the remote engagement target/scope. " +
  "When all tasks are done, write the report if needed and STOP with findings — no localhost step.";

export const IMPLEMENT_PROMPT = IMPLEMENT_PROMPT_CODING;

/**
 * When the user implements/discards from the plan pane, the chat plan-ready
 * confirm must not also run implement/discard (double-queue / double-discard).
 */
let planDecisionHandled = false;

/** After user presses `s`, the next free-text submit is a plan revision (not implement). */
let awaitingPlanSuggestion = false;

function dismissPlanConfirmIfOpen(
  services: AppServices,
  result: "implement" | "discard" | "suggest" | "dismiss",
): void {
  const state = services.overlay.getState();
  if (state.kind === "confirm" && state.request.kind === "plan") {
    services.overlay.answerPlanConfirm(result);
  }
}

export function buildImplementPrompt(plan: SessionPlan): string {
  if (plan.kind === "pentest") return IMPLEMENT_PROMPT_PENTEST;
  return IMPLEMENT_PROMPT_CODING;
}

/** True when plan-ready UI asked the user to type revision feedback next. */
export function isAwaitingPlanSuggestion(): boolean {
  return awaitingPlanSuggestion;
}

export function clearAwaitingPlanSuggestion(): void {
  awaitingPlanSuggestion = false;
}

export interface PlanSuggestionSubmit {
  /** Full model-facing revision directive (backend only). */
  readonly modelPrompt: string;
  /** Short YOU bubble — the user's raw feedback only. */
  readonly displayPrompt: string;
}

/**
 * If the user was prompted to suggest changes, wrap their free-text as a
 * plan-revision request and keep plan mode. Returns submit payloads, or
 * undefined if this was not a suggestion capture.
 */
export function consumePlanSuggestionInput(
  services: AppServices,
  text: string,
): PlanSuggestionSubmit | undefined {
  if (!awaitingPlanSuggestion) return undefined;
  awaitingPlanSuggestion = false;
  const feedback = text.trim();
  if (!feedback) {
    services.session.notice("info", "no plan changes entered — draft unchanged");
    return undefined;
  }
  const plan = services.plan.current();
  services.session.notice("info", "revising plan from your feedback…");
  // Stay in plan mode for revision
  if (services.session.getState().mode !== "plan") {
    services.session.setMode("plan");
    setDefaultMode("plan");
  }
  return {
    modelPrompt: buildPlanRevisionPrompt(feedback, {
      planVersion: plan?.version,
    }),
    displayPrompt: feedback,
  };
}

/**
 * Best-effort research compaction before agent implement.
 * Accept-by-default structural gate only; never blocks implement.
 * On hard reject: restore pre-compact history (and re-persist) so disk matches.
 */
async function compactResearchForImplement(
  services: AppServices,
): Promise<void> {
  const session = services.session;
  if (session.getState().running || session.getState().compacting) return;

  const beforeMessages = [...session.messages];
  const beforeContextSnapshot = session.getState().contextSnapshot;
  const beforeContextUsage = session.getState().contextUsage;
  const beforeTranscript = services.transcript.getState();
  const restoreBeforeCompaction = (): void => {
    services.transcript.hydrate(beforeTranscript, { rebaseSequence: false });
    session.restoreMessages(
      beforeMessages,
      beforeContextSnapshot ?? beforeContextUsage,
    );
  };
  const beforeTokens = estimateMessagesTokens(beforeMessages);
  if (beforeTokens < PLAN_IMPLEMENT_COMPACT_MIN_TOKENS) return;
  if (beforeMessages.length < 4) return;

  const transcript = serializeTranscriptForCompaction(
    services.transcript.getState(),
    (id) => session.spool.tail(id),
  );

  try {
    const result = await session.compact(transcript || undefined, 2, undefined, {
      purpose: "plan-implement",
    });

    if (!result.summarized) return;

    const decision = acceptPlanImplementCompaction({
      summarized: result.summarized,
      summaryBody: extractCompactionSummaryBody(result.messages),
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      afterMessages: result.messages,
    });

    if (!decision.accept) {
      restoreBeforeCompaction();
      // Overwrite any compacted save with one coherent pre-compact snapshot.
      await session.persistNow().catch(() => undefined);
      notifyWarn(
        services,
        "plan context compaction skipped — keeping full research history",
        { key: "plan-compact", durationMs: 2800 },
      );
      return;
    }

    const freed = Math.max(0, result.beforeTokens - result.afterTokens);
    const pct =
      result.beforeTokens > 0
        ? Math.round((freed / result.beforeTokens) * 100)
        : 0;
    notify(services, `context compacted for implement · −${pct}%`, {
      key: "plan-compact",
      durationMs: 2200,
    });
  } catch {
    // Restore all three persisted facets even if compaction emitted before failing.
    restoreBeforeCompaction();
    await session.persistNow().catch(() => undefined);
    notifyWarn(
      services,
      "plan context compaction failed — keeping full research history",
      { key: "plan-compact", durationMs: 2800 },
    );
  }
}

export async function implementPlan(services: AppServices): Promise<void> {
  const plan = services.plan.current();
  if (!plan) return;
  if (isPlanSuccessful(plan)) return;

  // Pane click wins: mark handled, close chat confirm so Y/N can't re-queue.
  planDecisionHandled = true;
  awaitingPlanSuggestion = false;
  dismissPlanConfirmIfOpen(services, "implement");

  // Compact research while still in plan mode (before mutates unlock).
  // Never blocks implement — fail-open to full history.
  await compactResearchForImplement(services);

  // Critical: leave gather-only plan mode so shell/fs mutates are allowed.
  services.session.setMode("agent");
  setDefaultMode("agent");
  await services.plan.approve();
  services.session.setPlanApproved(true);
  services.session.notice(
    "info",
    "plan accepted — switching to agent mode to execute",
  );

  const prompt = buildImplementPrompt(plan);
  // Model gets full implement directive; chat must NOT show it as a YOU bubble.
  if (services.session.getState().running) {
    services.session.enqueue(prompt, { displayPrompt: null });
  } else {
    await services.session.submit(prompt, { displayPrompt: null });
  }
}

export async function discardPlan(services: AppServices): Promise<void> {
  planDecisionHandled = true;
  awaitingPlanSuggestion = false;
  dismissPlanConfirmIfOpen(services, "discard");
  await services.plan.discard();
  services.session.setPlanApproved(false);
}

/**
 * Enter suggestion capture: next composer submit revises the draft plan.
 * Mode stays plan; plan-ready reappears after the revision turn if still draft.
 */
export function beginPlanSuggestion(services: AppServices): void {
  planDecisionHandled = true;
  awaitingPlanSuggestion = true;
  dismissPlanConfirmIfOpen(services, "suggest");
  if (services.session.getState().mode !== "plan") {
    services.session.setMode("plan");
    setDefaultMode("plan");
  }
  services.session.notice(
    "info",
    "type plan changes in the input and press enter — agent will revise the draft (or ask if unclear)",
  );
}

/**
 * After a turn ends, if a draft plan is waiting, open the plan-ready confirm.
 * "P" views full plan detail via the suspended-over-confirm pager path.
 * "S" suggests changes via free-text in the composer.
 */
export async function promptPlanApprovalIfNeeded(services: AppServices): Promise<void> {
  if (services.session.isPlanApproved()) return;
  if (services.overlay.isOpen()) return;
  if (awaitingPlanSuggestion) return;

  const plan = services.plan.current();
  if (!plan || plan.status !== "draft" || plan.tasks.length === 0) return;

  planDecisionHandled = false;

  const decision = await services.overlay.openPlanConfirm(
    {
      kind: "plan",
      prompt: `Implement this plan now? "${plan.goal}" — ${plan.tasks.length} task(s). (Y implement · S suggest · P view · N discard · Esc dismiss)`,
    },
    async () => {
      const { formatPlanPagerDocument } = await import(
        "../rendering/plan-view.js"
      );
      services.overlay.openPager(
        `Plan · ${plan.goal}`,
        formatPlanPagerDocument(plan),
        undefined,
        undefined,
        "force",
      );
    },
  );

  // Plan pane already implemented/discarded while this confirm was open.
  if (planDecisionHandled) return;

  if (decision === "implement") await implementPlan(services);
  else if (decision === "discard") await discardPlan(services);
  else if (decision === "suggest") beginPlanSuggestion(services);
  // dismiss: leave draft pending; user can /implement, type feedback, or reopen
}
