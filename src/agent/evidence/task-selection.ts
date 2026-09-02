import type { TaskEvidence } from "../../store/plan.js";
import type { ToolCall } from "../../types.js";
import { classifyTaskTitle, isPentestPlanKind, looksLikeInstallTaskTitle, looksLikeScaffoldTaskTitle } from "./task-classification.js";
import { isScaffoldCreateCommand } from "./tool-budgets.js";

export interface TaskWorkLedger extends TaskEvidence {
  taskId: string;
}

export interface CanMarkTaskDoneOpts {
  taskTitle?: string | undefined;
  featureAppRequired?: boolean | undefined;
  sessionFeatureSeen?: boolean | undefined;
  existingProject?: boolean | undefined;
  runtimeVerified?: boolean | undefined;
  planKind?: string | undefined;
  remoteWorkVerified?: boolean | undefined;
}

export function isRuntimeObservationTask(title: string): boolean {
  const t = title.toLowerCase();
  const leaveKeep =
    /\bleave\s+(?:it\s+)?running\b|\bkeep\s+(?:it\s+)?running\b|\bserver\s+(?:is\s+)?running\b|\bfor\s+(?:the\s+)?user\s+to\s+test\b/.test(
      t,
    );
  if (!leaveKeep) return false;
  if (
    /\b(?:start|launch|run)\s+(?:the\s+)?(?:dev\s*)?server\b/.test(t) ||
    /\b(?:probe|curl)\s+(?:localhost|http)\b/.test(t)
  ) {
    if (/\b(start|run|launch)\b/.test(t) && /\b(dev\s*server|npm\s+run\s+dev|shell\.start)\b/.test(t)) {
      return false;
    }
  }
  if (
    /\bleave\s+(?:it\s+)?running\b|\bkeep\s+(?:it\s+)?running\b|\bfor\s+(?:the\s+)?user\s+to\s+test\b/.test(
      t,
    )
  ) {
    if (!/^(?:start|run|launch)\b/.test(t.trim())) return true;
    if (/^leave\b|^keep\b/.test(t.trim())) return true;
  }
  return (
    /\bserver\s+(?:is\s+)?running\b/.test(t) &&
    !/\b(?:start|run|launch)\b/.test(t)
  );
}

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

export function isDevServerCall(call: ToolCall): boolean {
  const cmd = commandOf(call);
  if (isScaffoldCreateCommand(cmd)) return false;

  if (call.name === "shell.start") {
    if (!cmd) return true;
    return (
      /\bnpm\s+run\s+dev\b|\byarn\s+dev\b|\bpnpm\s+(run\s+)?dev\b|\bbun\s+(run\s+)?dev\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\bcargo\s+watch\b|\bflask\s+run\b|\buvicorn\b|\bgunicorn\b|\brails\s+s(?:erver)?\b|\bdjango(-admin)?\s+runserver\b|\bdotnet\s+run\b|\bgo\s+run\b/i.test(
        cmd,
      ) ||
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

export function pickPendingTaskForToolCall<T extends { id: string; title: string }>(
  pending: T[],
  call: ToolCall,
  _allTitles?: string[],
): T | undefined {
  if (pending.length === 0) return undefined;
  const cmd = commandOf(call);

  const score = (title: string): number => {
    let s = 1;
    if (isPackageInstallCommand(cmd)) {
      if (looksLikeInstallTaskTitle(title)) s += 20;
      else if (looksLikeScaffoldTaskTitle(title)) s += 10;
      else s -= 5;
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
