import type { TaskEvidence } from "../../store/plan.js";
import type { ToolCall } from "../../types.js";
import { classifyTaskTitle, isPentestPlanKind, looksLikeInstallTaskTitle, looksLikeScaffoldTaskTitle } from "./task-classification.js";
import { isScaffoldCreateCommand } from "./tool-budgets.js";

export interface TaskWorkLedger extends TaskEvidence {
  taskId: string;
}

export interface CanMarkTaskDoneOpts {
  taskTitle?: string | undefined;
  /** User asked for a product feature app (todo/blog/…). */
  featureAppRequired?: boolean | undefined;
  /** Session-level flag: feature write observed any time this turn. */
  sessionFeatureSeen?: boolean | undefined;
  /** A real project root was discovered, so a scaffold checkpoint is already satisfied. */
  existingProject?: boolean | undefined;
  /** An earlier plan task already proved the local server is ready and running. */
  runtimeVerified?: boolean | undefined;
  /** Plan kind: coding | pentest | general — selects domain gates. */
  planKind?: string | undefined;
  /** Any plan task already has successful remote recon/active test evidence. */
  remoteWorkVerified?: boolean | undefined;
}

/**
 * Leave/keep-running observational tasks may inherit already-proven runtime.
 * "for user to test" must NOT block inheritance (prior brittle exclusion of "test").
 */
export function isRuntimeObservationTask(title: string): boolean {
  const t = title.toLowerCase();
  const leaveKeep =
    /\bleave\s+(?:it\s+)?running\b|\bkeep\s+(?:it\s+)?running\b|\bserver\s+(?:is\s+)?running\b|\bfor\s+(?:the\s+)?user\s+to\s+test\b/.test(
      t,
    );
  if (!leaveKeep) return false;
  // Primary action is still start/launch/probe → not pure observation
  if (
    /\b(?:start|launch|run)\s+(?:the\s+)?(?:dev\s*)?server\b/.test(t) ||
    /\b(?:probe|curl)\s+(?:localhost|http)\b/.test(t)
  ) {
    // Combined "start … leave running" is verify work, not pure observation
    if (/\b(start|run|launch)\b/.test(t) && /\b(dev\s*server|npm\s+run\s+dev|shell\.start)\b/.test(t)) {
      return false;
    }
  }
  // Titles that are ONLY leave/keep running (optionally "for user to test")
  if (
    /\bleave\s+(?:it\s+)?running\b|\bkeep\s+(?:it\s+)?running\b|\bfor\s+(?:the\s+)?user\s+to\s+test\b/.test(
      t,
    )
  ) {
    // If title is primarily leave-running without requiring a fresh start as the main verb first
    if (!/^(?:start|run|launch)\b/.test(t.trim())) return true;
    // "Leave server running for user to test" — leave is the head intent
    if (/^leave\b|^keep\b/.test(t.trim())) return true;
  }
  return (
    /\bserver\s+(?:is\s+)?running\b/.test(t) &&
    !/\b(?:start|run|launch)\b/.test(t)
  );
}

/** Report / residual documentation that can inherit prior remote evidence. */
export function isRemoteObservationTask(title: string): boolean {
  const t = title.toLowerCase();
  if (/\b(report|write.?up|summar|document|residual|findings?\s+summary)\b/.test(t)) {
    return true;
  }
  if (
    /\bleave\s+(?:the\s+)?(?:listener|job|tunnel)\s+running\b|\bkeep\s+(?:the\s+)?listener\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Typed evidence gate: base rule is ≥1 successful work tool; implement/install/verify
 * (and pentest recon) require stronger signals when classified. Existing project and
 * already-proven runtime/remote facts satisfy corresponding observational tasks.
 */
export function canMarkTaskDone(
  ledger: TaskWorkLedger | null,
  taskId: string,
  opts?: CanMarkTaskDoneOpts,
): { ok: true } | { ok: false; reason: string } {
  const title = opts?.taskTitle ?? "";
  const planKind = opts?.planKind;
  const pentest = isPentestPlanKind(planKind);
  const cls = title ? classifyTaskTitle(title, { planKind }) : "generic";
  const leaveRunningIntent =
    isRuntimeObservationTask(title) ||
    /\bleave\s+(?:it\s+)?running\b|\bkeep\s+(?:it\s+)?running\b|\bfor\s+(?:the\s+)?user\s+to\s+test\b/i.test(
      title,
    );
  const inheritedCompletion =
    (cls === "scaffold" && Boolean(opts?.existingProject)) ||
    (!pentest && leaveRunningIntent && Boolean(opts?.runtimeVerified)) ||
    (pentest &&
      isRemoteObservationTask(title) &&
      Boolean(opts?.remoteWorkVerified));
  if ((!ledger || ledger.taskId !== taskId) && !inheritedCompletion) {
    return {
      ok: false,
      reason:
        `Cannot mark [${taskId}] done: no work ledger for this task. ` +
        `Call task.update {taskId:"${taskId}", state:"in_progress"}, do the real work, ` +
        `inspect the tool result, and only then mark done if you are satisfied.`,
    };
  }
  if ((ledger?.successWorkCount ?? 0) < 1 && !inheritedCompletion) {
    return {
      ok: false,
      reason:
        `Cannot mark [${taskId}] done: no successful tool result observed since it went in_progress. ` +
        `Do the work, wait for the tool output, verify it succeeded, and only mark done when satisfied. ` +
        (ledger?.lastOkTool
          ? ""
          : "Example: fs.write / shell.exec / shell.start must return ok first."),
    };
  }

  return { ok: true };
}

export function commandOf(call: ToolCall): string {
  return typeof call.args.command === "string" ? call.args.command : "";
}

/**
 * True only for actually running a long-lived dev server — not create-vite /
 * npm create which merely contain the word "vite".
 */
export function isDevServerCall(call: ToolCall): boolean {
  const cmd = commandOf(call);
  if (isScaffoldCreateCommand(cmd)) return false;

  if (call.name === "shell.start") {
    // Explicit background job is usually a server; still exclude create-*.
    if (!cmd) return true;
    return (
      /\bnpm\s+run\s+dev\b|\byarn\s+dev\b|\bpnpm\s+(run\s+)?dev\b|\bbun\s+(run\s+)?dev\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\bcargo\s+watch\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\brails\s+s(?:erver)?\b|\bdjango(-admin)?\s+runserver\b|\bdotnet\s+run\b|\bgo\s+run\b/i.test(
        cmd,
      ) ||
      // bare `vite` / `vite --host` as the process — not `create vite`
      /(?:^|[;&|]\s*)vite(?:\s|$)/i.test(cmd) ||
      /\b(python3?\s+-m\s+http\.server|php\s+-S)\b/i.test(cmd)
    );
  }

  return (
    /\bnpm\s+run\s+dev\b|\byarn\s+dev\b|\bpnpm\s+(run\s+)?dev\b|\bbun\s+(run\s+)?dev\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\brails\s+s(?:erver)?\b|\bdjango(-admin)?\s+runserver\b/i.test(
      cmd,
    ) || /(?:^|[;&|]\s*)vite(?:\s|$)/i.test(cmd)
  );
}

function isLocalHttpProbe(call: ToolCall): boolean {
  const blob = `${call.name} ${commandOf(call)} ${JSON.stringify(call.args)}`;
  return (
    /\b(localhost|127\.0\.0\.1)\b/i.test(blob) &&
    (call.name === "shell.exec" ||
      call.name === "http.fetch" ||
      call.name === "web.fetch" ||
      /\bcurl\b/i.test(blob))
  );
}

export function isPackageInstallCommand(cmd: string): boolean {
  return /\bnpm\s+i(nstall)?\b|\byarn\s+install\b|\bpnpm\s+i(nstall)?\b|\bbun\s+install\b|\bpip\s+install\b|\bpoetry\s+install\b|\bcargo\s+build\b|\bcomposer\s+install\b|\bbundle\s+install\b|\bgo\s+mod\s+tidy\b/.test(
    cmd,
  );
}

/**
 * Choose which pending plan task should own this tool call (auto-start).
 * Prevents npm install from being attributed to "localStorage" / style tasks.
 */
export function pickPendingTaskForToolCall<T extends { id: string; title: string }>(
  pending: T[],
  call: ToolCall,
  _allTitles?: string[],
): T | undefined {
  if (pending.length === 0) return undefined;
  const cmd = commandOf(call);

  const score = (title: string): number => {
    // Heuristics rank likely ownership only. They must never make a pending
    // task ineligible or authorize/block the underlying tool call.
    let s = 1;
    if (isPackageInstallCommand(cmd)) {
      if (looksLikeInstallTaskTitle(title)) s += 20;
      else if (looksLikeScaffoldTaskTitle(title)) s += 10;
      else s -= 5; // prefer not to attach install to feature tasks
    }
    if (isDevServerCall(call) || isLocalHttpProbe(call)) {
      if (
        /\b(dev\s*server|run\s+dev|localhost|shell\.start|probe|verify)\b/i.test(
          title,
        )
      ) {
        s += 20;
      } else s -= 10;
    }
    if (
      call.name === "fs.write" ||
      call.name === "fs.writeMany" ||
      call.name === "fs.edit"
    ) {
      if (looksLikeInstallTaskTitle(title)) s -= 15;
      if (
        /\b(component|feature|todo|implement|style|persist|localstorage|ui|page)\b/i.test(
          title,
        )
      ) {
        s += 12;
      }
    }
    // Keyword overlap (SSRF task ↔ /api/og-image fetch, fuzz ↔ /api/*, …)
    const blob =
      `${call.name} ${cmd} ${JSON.stringify(call.args ?? {})}`.toLowerCase();
    const words = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);
    let hits = 0;
    for (const w of words) {
      if (blob.includes(w)) hits += 1;
    }
    if (hits > 0) s += Math.min(12, hits * 3);
    return s;
  };

  let best: T | undefined;
  let bestScore = -Infinity;
  for (const p of pending) {
    const sc = score(p.title);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }
  return best ?? pending[0];
}
