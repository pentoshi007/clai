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
