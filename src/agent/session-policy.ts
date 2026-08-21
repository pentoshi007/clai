export interface SessionPolicy {
  /** Tools the user authorized once during this REPL session. Not persisted. */
  allow: Set<string>;
  /** Mutable flag so the runner can flip pentest auth for this session only. */
  pentestAuthorized: { value: boolean };
  /** Stable id used to scope the session's plan/tasks in the plan store. */
  sessionId: string;
  /** When true, the agent must follow its approved plan (set by /implement). */
  planApproved: { value: boolean };
  /** Signature of a multi-task update awaiting the model's re-issue to confirm. */
  pendingTaskBatch: { value: string | undefined };
  /** Signature of an early task-open (unmet dependencies) awaiting confirmation. */
  pendingDependency: { value: string | undefined };
}

export function createSessionPolicy(sessionId?: string): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
    sessionId:
      sessionId ??
      `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
    pendingTaskBatch: { value: undefined },
    pendingDependency: { value: undefined },
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
  "task.move",
  "job.read",
  "task.read",
  "task.update",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "tool.batch",
  "tool.check",
  "net.context",
  "web.search",
  "web.fetch",
  "dns.lookup",
  "whois.lookup",
  "http.fetch",
  "net.scan",
  "pentest.recon",
  "wordlist.find",
  "image.ocr",
  "pdf.read",
  "shell.jobs",
  "shell.tail",
  "shell.wait",
]);

/**
 * Plan mode: gather freely (recon, scans, enum, research, tool installs).
 * Block only project mutation and clear active exploitation — put those in
 * the plan as post-accept tasks.
 */
const PLAN_MODE_BLOCKED_TOOLS = new Set<string>([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.append",
  "fs.replaceLines",
  "fs.delete",
]);

export function isPreApprovalAllowedTool(name: string): boolean {
  return PRE_APPROVAL_ALLOWED_TOOLS.has(name);
}

/** True when the tool is allowed in plan mode (gather-only). */
export function isPlanModeAllowedTool(name: string): boolean {
  if (PLAN_MODE_BLOCKED_TOOLS.has(name)) return false;
  return true;
}

/**
 * Shell commands blocked in plan mode: project scaffold/mutate and active
 * exploit/C2. Recon, enum, fuzz, long nmap, installs of scanners are allowed.
 */
export function isPlanModeAllowedShellCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  if (
    /\b(npm\s+create|npx\s+(?:--yes\s+)?create-|yarn\s+create|pnpm\s+create|bun\s+create|cargo\s+new|rails\s+new|poetry\s+new|flutter\s+create|django-admin\s+startproject|composer\s+create-project|npm\s+init\s+vite|create-next-app|create-react-app)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (
    /\b(fs\.write|tee\s+>|>>\s*\/|cat\s*>\s*|printf\s+.*>\s*)/i.test(c) &&
    !/\b(tee\s+\/tmp|tee\s+\$\{?TMP|>>\s*\/tmp|\/var\/folders)\b/i.test(c)
  ) {
    // Writing into user project trees is blocked; tmp artifact writes OK.
    if (!/\b(\/tmp|TMPDIR|scratch|\.clai\/outputs)\b/i.test(c)) {
      return false;
    }
  }
  if (
    /\b(msfconsole|msfvenom|metasploit|exploit\/|use\s+exploit|revshell|reverse\s+shell|nc\s+-[el].*\d|ncat\s+-[el]|bash\s+-i\s+>&\s*\/dev\/tcp)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (
    /\b(sqlmap\b.*(?:--os-shell|--os-pwn|--sql-shell|--crawl)|hydra\s+.+\s+-l\s|medusa\s+.*-M\s)\b/i.test(
      c,
    )
  ) {
    return false;
  }
  if (/\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r).*(\/|~)/i.test(c)) {
    return false;
  }
  return true;
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

export function shouldEnableImageOcr(
  prompt: string,
  hasAttachedImages: boolean,
  visionProven = true,
): boolean {
  if (!hasAttachedImages) return true;
  if (!visionProven) return true;
  return /\b(?:ocr|optical character recognition|tesseract)\b/i.test(prompt);
}
