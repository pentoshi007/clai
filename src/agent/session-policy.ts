export interface SessionPolicy {
  /** Tools the user authorized once during this REPL session. Not persisted. */
  allow: Set<string>;
  /** Mutable flag so the runner can flip pentest auth for this session only. */
  pentestAuthorized: { value: boolean };
  /** Stable id used to scope the session's plan/tasks in the plan store. */
  sessionId: string;
  /** When true, the agent must follow its approved plan (set by /implement). */
  planApproved: { value: boolean };
}

export function createSessionPolicy(sessionId?: string): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
    sessionId:
      sessionId ??
      `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
  };
}

/**
 * Tools allowed while an UN-approved plan is active. Before the user runs
 * /implement, the agent may only (re)create the plan and do read-only
 * exploration to refine it — never execute. Everything else is blocked by
 * the plan-awaiting-approval gate so a stray/recovered tool call can't start
 * running the plan, and so free-text after a plan is treated as a revision.
 */
const PRE_APPROVAL_ALLOWED_TOOLS = new Set<string>([
  "plan.create",
  "task.update",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "tool.batch",
  "net.context",
]);

export function isPreApprovalAllowedTool(name: string): boolean {
  return PRE_APPROVAL_ALLOWED_TOOLS.has(name);
}

/**
 * A plan's persisted status is the durable source of truth for "has this
 * plan been approved" — session.planApproved is in-memory only and resets to
 * false on every fresh SessionPolicy (a /history resume, or a new policy
 * created after context compaction). Without re-deriving from the plan's own
 * status, a resumed session for an already-approved/executed/completed plan
 * would re-block every tool call behind the "awaiting approval" gate even
 * though /implement already ran before the app was closed.
 */
export function isPlanApprovedByStatus(status: PlanStatusLike): boolean {
  return status !== "draft";
}

/**
 * Whether a plan still has work left to force via the "act, don't narrate"
 * nudge. A plan whose persisted status is "completed" should be treated like
 * having no active plan for that purpose — otherwise a plain follow-up
 * question after the plan finished (e.g. "what do you know so far") keeps
 * getting pushed to emit another tool call instead of being answered.
 */
export function planHasOpenWork(status: PlanStatusLike | undefined): boolean {
  return status !== undefined && status !== "completed";
}

/** Subset of PlanStatus this module needs, kept local to avoid a store import. */
type PlanStatusLike = "draft" | "approved" | "in_progress" | "completed" | "abandoned";

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** OCR is opt-in when real image pixels are already attached to the model. */
export function shouldEnableImageOcr(
  prompt: string,
  hasAttachedImages: boolean,
): boolean {
  if (!hasAttachedImages) return true;
  return /\b(?:ocr|optical character recognition|tesseract)\b/i.test(prompt);
}
