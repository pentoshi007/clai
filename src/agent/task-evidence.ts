import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../types.js";
import { getActiveProjectRoot } from "./project-root.js";
import type { TaskEvidence } from "../store/plan.js";

/** Successful non-meta work under the open plan task (typed evidence for done). */
export type TaskClass =
  | "explore"
  | "scaffold"
  | "install"
  | "implement"
  | "verify"
  | "recon"
  | "exploit"
  | "report"
  | "generic";

export interface TaskWorkLedger extends TaskEvidence {
  taskId: string;
}

/** Rehydrate the live task ledger from durable plan evidence after a resume. */
export function ledgerFromTaskEvidence(
  taskId: string,
  evidence?: TaskEvidence | undefined,
): TaskWorkLedger {
  return {
    taskId,
    successWorkCount: evidence?.successWorkCount ?? 0,
    ...(evidence ?? {}),
  };
}

/** Store only serializable evidence on the plan; the task id is already its key. */
export function taskEvidenceFromLedger(
  ledger: TaskWorkLedger,
): TaskEvidence {
  const { taskId: _taskId, ...evidence } = ledger;
  return evidence;
}

/** Optional signals recorded from a successful tool call. */
export interface TaskWorkSignals {
  sourceWrite?: boolean;
  featureWrite?: boolean;
  installOk?: boolean;
  scaffoldOk?: boolean;
  devServerStart?: boolean;
  localHttpProbeOk?: boolean;
  serverReady?: boolean;
  portListening?: boolean;
  remoteReconOk?: boolean;
  remoteActiveTestOk?: boolean;
}

export function isMetaPlanTool(name: string): boolean {
  return (
    name === "plan.create" ||
    name === "task.move" ||
    name === "job.read" ||
    name === "task.read" ||
    name === "task.update" ||
    name === "agent.handoff"
  );
}

/** Tools that count as real work/verify evidence for the open task. */
export function isEvidenceWorkTool(name: string): boolean {
  return !isMetaPlanTool(name);
}

export function isPentestPlanKind(kind: string | undefined): boolean {
  return (kind ?? "").toLowerCase() === "pentest";
}

export function classifyTaskTitle(
  title: string,
  opts?: { planKind?: string | undefined },
): TaskClass {
  const t = title.toLowerCase();
  const pentest = isPentestPlanKind(opts?.planKind);

  // Pentest plans: never map security work onto coding verify/implement gates.
  if (pentest) {
    if (/\b(report|write.?up|finding|summar|document|residual)\b/.test(t)) {
      return "report";
    }
    if (
      /\b(exploit|poc|payload|privesc|lateral|inject|bruteforce|sqlmap|listener|reverse\s+shell|c2)\b/.test(
        t,
      )
    ) {
      return "exploit";
    }
    if (
      /\b(recon|enumerat|fingerprint|osint|whois|dns|nmap|discover|probe|scan|fuzz|content\s+discover|subdomain|port)\b/.test(
        t,
      )
    ) {
      return "recon";
    }
    if (/\b(explore|inspect|list|read|survey|map)\b/.test(t)) {
      return "explore";
    }
    return "generic";
  }

  if (
    /\b(dev\s*server|run\s+dev|start\s+.*server|localhost|shell\.start|leave\s+.*running|probe|verify\s+in\s+browser)\b/.test(
      t,
    ) ||
    (/\b(start|run)\b/.test(t) && /\b(server|dev|app|verify)\b/.test(t))
  ) {
    return "verify";
  }
  if (looksLikeInstallTaskTitle(title)) return "install";
  if (looksLikeScaffoldTaskTitle(title)) return "scaffold";
  if (
    /\b(implement|integrate|feature|rewrite|component|todo|persist|localstorage|styling|styles?|ui|page)\b/.test(
      t,
    ) ||
    // endpoint/route only count as implement for product apps, not bare "API routes" recon phrasing
    (/\b(endpoint|route)\b/.test(t) &&
      /\b(implement|build|add|create|feature|component|ui|page)\b/.test(t))
  ) {
    return "implement";
  }
  if (/\b(recon|enumerat|fingerprint|osint|whois|dns|nmap|discover)\b/.test(t)) {
    return "recon";
  }
  if (
    /\b(exploit|poc|payload|privesc|lateral|inject|bruteforce|sqlmap)\b/.test(t)
  ) {
    return "exploit";
  }
  if (/\b(report|write.?up|finding|summar|document)\b/.test(t)) {
    return "report";
  }
  if (
    /\b(explore|inspect|list|read|survey|map)\b/.test(t) ||
    /\bcheck\b.+\b(exists?|empty|directory|folder|path)\b/.test(t) ||
    /\b(exists?|empty)\b.+\b(directory|folder|path|project)\b/.test(t) ||
    // "Check Node.js and npm availability", "verify tools present", etc.
    /\bcheck\b.+\b(node|npm|pnpm|yarn|bun|python|availability|available|installed|present|toolchain|tools?)\b/.test(
      t,
    ) ||
    /\b(availability|available|installed|present)\b.+\b(node|npm|toolchain|tools?)\b/.test(
      t,
    ) ||
    /\bverify\b.+\b(tools?|node|npm|setup|environment|prereq)\b/.test(t)
  ) {
    return "explore";
  }
  return "generic";
}

/** Successful work observed this turn without a credited open task. */
export interface LooseWorkReceipt {
  readonly toolName: string;
  readonly signals?: TaskWorkSignals | undefined;
}

/**
 * Whether a successful tool can satisfy a task of the given class.
 * Used to retroactively credit preflight work (tool.check before in_progress).
 */
export function toolFitsTaskClass(
  toolName: string,
  taskTitle: string,
  opts?: {
    planKind?: string | undefined;
    signals?: TaskWorkSignals | undefined;
  },
): boolean {
  if (!isEvidenceWorkTool(toolName)) return false;
  const cls = classifyTaskTitle(taskTitle, { planKind: opts?.planKind });
  const s = opts?.signals;
  switch (cls) {
    case "explore":
      return (
        toolName === "tool.check" ||
        toolName === "sysinfo" ||
        toolName === "fs.list" ||
        toolName === "fs.read" ||
        toolName === "fs.search" ||
        toolName === "net.context" ||
        toolName === "shell.exec" // version probes, which/where
      );
    case "scaffold":
      return (
        Boolean(s?.scaffoldOk) ||
        toolName === "fs.write" ||
        toolName === "fs.writeMany" ||
        toolName === "shell.exec" ||
        toolName === "shell.start"
      );
    case "install":
      return Boolean(s?.installOk) || toolName === "pkg.install";
    case "implement":
      return (
        Boolean(s?.sourceWrite || s?.featureWrite) ||
        toolName === "fs.write" ||
        toolName === "fs.writeMany" ||
        toolName === "fs.edit" ||
        toolName === "fs.replaceLines" ||
        toolName === "fs.append"
      );
    case "verify":
      return (
        Boolean(
          s?.devServerStart ||
            s?.localHttpProbeOk ||
            s?.serverReady ||
            s?.portListening,
        ) ||
        toolName === "shell.start" ||
        toolName === "shell.tail" ||
        toolName === "http.fetch" ||
        toolName === "web.fetch"
      );
    case "recon":
      return (
        Boolean(s?.remoteReconOk) ||
        /^(dns\.lookup|whois\.lookup|http\.fetch|web\.fetch|net\.scan|pentest\.recon|net\.pingSweep|net\.context|tool\.batch)$/.test(
          toolName,
        )
      );
    case "exploit":
      return Boolean(s?.remoteActiveTestOk) || isEvidenceWorkTool(toolName);
    default:
      return true;
  }
}

/**
 * Fold turn-level loose successes into a task ledger so preflight work
 * (tool.check / fs.list before in_progress) can satisfy explore/check tasks.
 */
export function absorbLooseWorkIntoLedger(
  ledger: TaskWorkLedger | null,
  taskId: string,
  taskTitle: string,
  loose: readonly LooseWorkReceipt[],
  opts?: { planKind?: string | undefined },
): TaskWorkLedger | null {
  if (!taskId || loose.length === 0) return ledger;
  let led = ledger;
  for (const item of loose) {
    if (
      !toolFitsTaskClass(item.toolName, taskTitle, {
        planKind: opts?.planKind,
        signals: item.signals,
      })
    ) {
      continue;
    }
    led = recordTaskWorkSuccess(led, taskId, item.toolName, item.signals);
  }
  return led;
}

export function recordTaskWorkSuccess(
  ledger: TaskWorkLedger | null,
  taskId: string | undefined,
  toolName: string,
  signals?: TaskWorkSignals,
): TaskWorkLedger | null {
  if (!taskId || !isEvidenceWorkTool(toolName)) return ledger;
  const base: TaskWorkLedger =
    !ledger || ledger.taskId !== taskId
      ? { taskId, successWorkCount: 1, lastOkTool: toolName }
      : {
          ...ledger,
          successWorkCount: ledger.successWorkCount + 1,
          lastOkTool: toolName,
        };
  if (signals?.sourceWrite) base.sawSourceWrite = true;
  if (signals?.featureWrite) base.sawFeatureWrite = true;
  if (signals?.installOk) base.sawInstallOk = true;
  if (signals?.scaffoldOk) base.sawScaffoldOk = true;
  if (signals?.devServerStart) base.sawDevServerStart = true;
  if (signals?.localHttpProbeOk) base.sawLocalHttpProbeOk = true;
  if (signals?.serverReady) base.sawServerReady = true;
  if (signals?.portListening) base.sawPortListening = true;
  if (signals?.remoteReconOk) base.sawRemoteReconOk = true;
  if (signals?.remoteActiveTestOk) base.sawRemoteActiveTestOk = true;
  return base;
}

export function openTaskLedger(taskId: string): TaskWorkLedger {
  return { taskId, successWorkCount: 0 };
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

/** Local app runtime is proven by any strong independent signal. */
export function hasLocalRuntimeProof(
  evidence?: Pick<
    TaskEvidence,
    | "sawDevServerStart"
    | "sawLocalHttpProbeOk"
    | "sawServerReady"
    | "sawPortListening"
  > | null,
): boolean {
  return Boolean(
    evidence?.sawDevServerStart ||
      evidence?.sawLocalHttpProbeOk ||
      evidence?.sawServerReady ||
      evidence?.sawPortListening,
  );
}

export function hasRemoteWorkProof(
  evidence?: Pick<
    TaskEvidence,
    "sawRemoteReconOk" | "sawRemoteActiveTestOk"
  > | null,
): boolean {
  return Boolean(evidence?.sawRemoteReconOk || evidence?.sawRemoteActiveTestOk);
}

/** Dev-server job log shows ready + local URL. */
export function isServerReadyOutput(output: string): boolean {
  if (!output) return false;
  const hasUrl =
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\b/i.test(output) ||
    /➜\s*Local:\s*https?:\/\//i.test(output);
  const hasReady =
    /\b(?:ready in|VITE\s+v?\d|compiled successfully|started server|listening on|Local:\s*http)\b/i.test(
      output,
    );
  return hasUrl || hasReady;
}

/** lsof/ss (or similar) shows a process LISTENing on a local port. */
export function isPortListeningOutput(command: string, output: string): boolean {
  if (!output || !/\bLISTEN(?:ING)?\b/i.test(output)) return false;
  const cmd = command.toLowerCase();
  if (/\b(lsof|ss\b|netstat)\b/.test(cmd)) return true;
  // Output-only: node/… LISTEN with a localhost/port line
  return (
    /\b(?:localhost|127\.0\.0\.1|\[::1\]|\*:)\S*\d+/i.test(output) ||
    /\bTCP\b.+\bLISTEN/i.test(output)
  );
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

  const evidence =
    ledger && ledger.taskId === taskId ? ledger : openTaskLedger(taskId);

  // Feature implement gate is coding-only.
  if (!pentest && cls === "implement" && opts?.featureAppRequired) {
    const featureOk =
      Boolean(evidence.sawFeatureWrite) || Boolean(opts.sessionFeatureSeen);
    if (!featureOk) {
      return {
        ok: false,
        reason:
          `Cannot mark [${taskId}] done: this is a feature/implement task for a product app, ` +
          `but no real feature code was written yet (starter boilerplate does not count). ` +
          `Replace the default starter with the requested feature (e.g. todo add/list/toggle), then mark done.`,
      };
    }
  }

  if (!pentest && cls === "install" && !evidence.sawInstallOk) {
    if (evidence.successWorkCount < 1) {
      return {
        ok: false,
        reason:
          `Cannot mark [${taskId}] done: install task needs a successful package install ` +
          `(npm/pnpm/yarn/bun install, etc.) under this task.`,
      };
    }
  }

  // Local app runtime: multi-signal proof. Never apply to pentest plans.
  if (!pentest && (cls === "verify" || leaveRunningIntent)) {
    const wantsServer =
      leaveRunningIntent ||
      /\b(dev\s*server|localhost|shell\.start|run\s+dev|leave\s+.*running)\b/i.test(
        title,
      );
    if (wantsServer) {
      const proof =
        hasLocalRuntimeProof(evidence) || Boolean(opts?.runtimeVerified);
      if (!proof) {
        return {
          ok: false,
          reason:
            `Cannot mark [${taskId}] done: local app runtime not proven yet. ` +
            `Accept any of: shell.start (dev server), shell.tail ready+URL, port LISTEN (lsof/ss), ` +
            `or successful localhost GET probe. If an earlier plan task already proved the server, ` +
            `confirm it is still alive once then mark done — do not thrash ports with restarts.`,
        };
      }
    }
  }

  // Pentest recon: need real remote recon, not local fs noise alone.
  if (pentest && cls === "recon") {
    const remoteOk =
      hasRemoteWorkProof(evidence) || Boolean(opts?.remoteWorkVerified);
    if (!remoteOk) {
      // Allow if last tool was a recon tool name even without typed flag (soft)
      const last = evidence.lastOkTool ?? "";
      const lastLooksRecon =
        /^(dns\.lookup|whois\.lookup|http\.fetch|web\.fetch|net\.scan|pentest\.recon|net\.pingSweep|tool\.batch)$/.test(
          last,
        );
      if (!lastLooksRecon) {
        return {
          ok: false,
          reason:
            `Cannot mark [${taskId}] done: recon needs successful remote evidence ` +
            `(dns/http/net.scan/pentest.recon/whois against the target), not local-only tools.`,
        };
      }
    }
  }

  if (pentest && cls === "exploit" && !evidence.sawRemoteActiveTestOk) {
    return {
      ok: false,
      reason:
        `Cannot mark [${taskId}] done: an exploit task needs successful active-test evidence ` +
        `(a non-GET/mutating request, injection, sqlmap/hydra/nuclei, or a landed PoC) against the target. ` +
        `Passive recon or local file work does not prove exploitation — run the active test and read its result first.`,
    };
  }

  return { ok: true };
}

/** True when a tool call is remote recon (not local app tooling). */
export function isRemoteReconToolCall(call: ToolCall): boolean {
  if (
    call.name === "dns.lookup" ||
    call.name === "whois.lookup" ||
    call.name === "net.scan" ||
    call.name === "pentest.recon" ||
    call.name === "net.pingSweep" ||
    call.name === "net.context"
  ) {
    return true;
  }
  if (call.name === "http.fetch" || call.name === "web.fetch") {
    const url = typeof call.args.url === "string" ? call.args.url : "";
    // Localhost is coding probe, not remote recon
    if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url)) {
      return false;
    }
    return Boolean(url);
  }
  if (call.name === "shell.exec" || call.name === "shell.start") {
    const cmd = commandOf(call);
    return /\b(?:nmap|masscan|ffuf|gobuster|feroxbuster|nikto|nuclei|httpx|subfinder|amass|dig|whois|whatweb)\b/i.test(
      cmd,
    );
  }
  return false;
}

/** Active/offensive test (not passive recon). */
export function isRemoteActiveTestCall(call: ToolCall): boolean {
  if (call.name === "http.fetch") {
    const method = String(call.args.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      return true;
    }
    const url = typeof call.args.url === "string" ? call.args.url : "";
    return /\b(?:union\s+select|<\s*script|javascript:|file:\/\/|169\.254\.169\.254)\b/i.test(
      url,
    );
  }
  if (call.name === "shell.exec" || call.name === "shell.start") {
    const cmd = commandOf(call);
    return /\b(?:sqlmap|hydra|nikto|nuclei|msfconsole|exploit|payload|reverse\s+shell)\b/i.test(
      cmd,
    );
  }
  return false;
}

function commandOf(call: ToolCall): string {
  return typeof call.args.command === "string" ? call.args.command : "";
}

/** One-shot scaffolders — must NEVER be treated as "start the dev server". Stack-agnostic. */
export function isScaffoldCreateCommand(cmd: string): boolean {
  return /\b(?:npm\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+(?:--yes\s+)?create-[\w-]+|create-vite|create-next-app|create-react-app|cargo\s+new|cargo\s+init|go\s+mod\s+init|poetry\s+new|django-admin\s+startproject|rails\s+new|composer\s+create-project|mix\s+new|flutter\s+create|dotnet\s+new)\b/i.test(
    cmd,
  );
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

/** Inspect tools allowed without opening a plan task. */
export function isPlanPreflightTool(name: string): boolean {
  return (
    name === "tool.check" ||
    name === "sysinfo" ||
    name === "fs.list" ||
    name === "fs.read" ||
    name === "fs.search" ||
    name === "net.context"
  );
}

/** Read-only recon tools that may run without an in_progress task on pentest plans. */
export function isReadOnlyReconTool(name: string): boolean {
  return (
    isPlanPreflightTool(name) ||
    name === "tool.batch" ||
    name === "dns.lookup" ||
    name === "whois.lookup" ||
    name === "http.fetch" ||
    name === "web.fetch" ||
    name === "web.search" ||
    name === "net.scan" ||
    name === "pentest.recon" ||
    name === "wordlist.find"
  );
}

/**
 * Tools whose failure must NOT cancel later siblings in the same model turn.
 * Plan bookkeeping failures (task.update done-gate, etc.) and independent
 * recon lookups should never wipe a whole batch of http.fetch / dns calls.
 */
export function isBatchSoftFailTool(name: string): boolean {
  if (
    name === "plan.create" ||
    name === "task.move" ||
    name === "job.read" ||
    name === "task.read" ||
    name === "task.update"
  ) return true;
  if (name === "tool.batch" || name === "tool.check") return true;
  if (isReadOnlyReconTool(name)) return true;
  if (
    name === "net.pingSweep" ||
    name === "shell.jobs" ||
    name === "shell.tail" ||
    name === "sysinfo"
  ) {
    return true;
  }
  return false;
}

/** Tools allowed on a coding build turn before plan.create exists. */
export function isBuildPrePlanAllowedTool(name: string): boolean {
  return (
    name === "plan.create" ||
    isPlanPreflightTool(name) ||
    name === "tool.batch" ||
    name === "fs.search" ||
    name === "web.search" ||
    name === "web.fetch"
  );
}

/**
 * Commands that legitimately sit quiet for minutes (npm install, create-next-app).
 * Must not be killed by the short "no output" stall watchdog.
 */
export function isLongQuietInstallOrScaffoldCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (isScaffoldCreateCommand(cmd)) return true;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i.test(cmd) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|update)\b/i.test(cmd) ||
    /\bpip(?:3)?\s+install\b/i.test(cmd) ||
    /\bpoetry\s+install\b/i.test(cmd) ||
    /\bcomposer\s+install\b/i.test(cmd) ||
    /\bbundle\s+install\b/i.test(cmd) ||
    /\bcargo\s+(?:build|fetch|install)\b/i.test(cmd) ||
    /\bgo\s+mod\s+(?:download|tidy)\b/i.test(cmd) ||
    /\bdotnet\s+restore\b/i.test(cmd)
  );
}

/**
 * Commands that are long-running but produce output (tests, builds, lint).
 * These need a longer hard timeout than the 40s default, but should still
 * be killed by the stall watchdog if they go quiet.
 */
export function isLongRunningTestOrBuildCommand(cmd: string): boolean {
  if (!cmd.trim()) return false;
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test|run\s+build|build|lint)\b/i.test(cmd) ||
    /\bvitest\b/i.test(cmd) ||
    /\bjest\b/i.test(cmd) ||
    /\bmocha\b/i.test(cmd) ||
    /\bplaywright\s+test\b/i.test(cmd) ||
    /\bcypress\s+run\b/i.test(cmd) ||
    /\btsc\b.*--noEmit/i.test(cmd) ||
    /\bnpx\s+tsc\b/i.test(cmd)
  );
}

/** Default wall-clock budget for every tool unless the model overrides it. */
export const DEFAULT_TOOL_TIMEOUT_MS = 40_000;
const MIN_TOOL_TIMEOUT_MS = 1_000;
const MAX_TOOL_TIMEOUT_MS = 30 * 60_000;

function requestedToolTimeoutMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  let requested: number | undefined;
  const raw = call.args.timeoutMs;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    requested = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) requested = parsed;
  }
  if (requested !== undefined) {
    // Heuristic: if value is small (< 1000) and looks like seconds (e.g. 300 for 300s),
    // treat it as seconds and convert to ms. This handles models that confuse units.
    // Values >= 1000 are treated as ms (e.g. 300000 for 300s).
    // We only apply this for values that would otherwise be clamped to 1s but
    // the command is long-running - otherwise respect the ms value.
    let ms = Math.floor(requested);
    // If value is between 1 and 1000, it could be seconds (e.g. 300 = 300s) or ms (300ms)
    // For long-running commands, treat small values as seconds to avoid 0.3s timeout for 300s intent
    const cmd = typeof call.args.command === "string" ? call.args.command : "";
    const isLongRunning = isLongRunningTestOrBuildCommand(cmd) || isLongQuietInstallOrScaffoldCommand(cmd);
    if (isLongRunning && ms > 0 && ms < 1000) {
      // Likely seconds - convert to ms (e.g. 300 -> 300000ms = 300s)
      // But if it's 60, that would be 60s = 60000ms, which is reasonable
      // If it's 300, that would be 300s = 300000ms
      ms = ms * 1000;
    }
    return Math.max(
      MIN_TOOL_TIMEOUT_MS,
      Math.min(MAX_TOOL_TIMEOUT_MS, ms),
    );
  }

  const cmd = typeof call.args.command === "string" ? call.args.command : "";
  if (
    call.name === "pkg.install" ||
    (call.name === "shell.exec" && isLongQuietInstallOrScaffoldCommand(cmd))
  ) {
    return 15 * 60_000;
  }
  if (call.name === "net.scan" || call.name === "pentest.recon") {
    return 15 * 60_000;
  }
  if (call.name === "pentest.webDiscover") return 8 * 60_000;
  if (call.name === "pentest.apiEnumerate") return 2 * 60_000;
  if (call.name === "pentest.authCompare") return 3 * 60_000;
  if (call.name === "shell.exec" && isLongRunningTestOrBuildCommand(cmd)) {
    return 120_000;
  }
  if (call.name.startsWith("mcp.")) return 60_000;
  return DEFAULT_TOOL_TIMEOUT_MS;
}

const OUTER_STALL_SETTLE_MARGIN_MS = 2_500;

/**
 * Silence cancellation leaves a short margin for a tool's own timeout handler
 * to return its richer result. The hard wall-clock watchdog still enforces the
 * exact model-selected deadline.
 */
export function toolStallBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}

/**
 * Hard wall-clock watchdog for every tool call. Local implementations enforce
 * the selected deadline; this outer fallback waits through the same short
 * settlement margin so their timeout/abort handlers can return a rich result
 * before the runner force-settles an ignored AbortSignal.
 */
export function toolHardBudgetMs(call: {
  name: string;
  args: Record<string, unknown>;
}): number {
  return requestedToolTimeoutMs(call) + OUTER_STALL_SETTLE_MARGIN_MS;
}

/** Grace period after abort before force-settling a hung tool promise. */
export const TOOL_ABORT_GRACE_MS = 2_500;

/** Harmless version/which probes models use instead of tool.check before planning. */
export function isReadOnlyVersionProbeCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || /[;&|`]/.test(c)) return false; // no chains
  return (
    /^(?:node|nodejs|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|go|rustc|cargo|ruby|php|java|dotnet|flutter|swift)\s+(?:-v|--version|version)\s*$/i.test(
      c,
    ) || /^(?:which|command\s+-v|type)\s+[A-Za-z0-9._-]+\s*$/i.test(c)
  );
}

/**
 * Multi-step coding builds must plan before mutate (scaffold/write/install).
 * Trivial one-liners and non-build prompts skip this.
 */
export function codingBuildRequiresPlan(
  prompt: string,
  opts?: { informational?: boolean; idle?: boolean; pentest?: boolean },
): boolean {
  if (opts?.informational || opts?.idle || opts?.pentest) return false;
  const p = prompt.trim();
  if (!p) return false;
  // Explicit single-file micro edits can skip the plan
  if (
    p.length < 100 &&
    /\b(fix|typo|rename|bump|tweak)\b/i.test(p) &&
    !/\b(app|project|scaffold|create|build|todo|blog)\b/i.test(p)
  ) {
    return false;
  }
  return true; // caller already checked looksLikeBuildTask
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

export function looksLikeInstallTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(install|dependencies|deps|packages)\b/.test(t) &&
    !/\b(dev\s*server|localhost|probe|run\s+dev)\b/.test(t)
  );
}

export function looksLikeScaffoldTaskTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(scaffold|create-vite|create vite|create-next|init project|bootstrap|cargo\s+new|rails\s+new|poetry\s+new)\b/.test(
      t,
    ) ||
    (/\b(create|init|generate)\b/.test(t) &&
      /\b(project|app|package|crate|module|vite)\b/.test(t) &&
      !/\b(feature|component|endpoint|todo|style|persist)\b/.test(t))
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

/**
 * User asked for a product feature app (todo, blog, …), not "just scaffold framework X".
 * Stack-agnostic: detects intent, not a particular framework.
 */
export function userAskedForFeatureApp(prompt: string): boolean {
  const p = prompt.trim().toLowerCase();
  if (!p) return false;
  if (/\b(just|only)\s+(scaffold|init|initialize|boilerplate|starter|template)\b/.test(p)) {
    return false;
  }
  // Named product feature + app/project shape
  if (
    /\b(todo|to-?do|blog|dashboard|chat|kanban|notes?|crm|shop|store|cart|auth|login|signup|crud|calendar|inbox|quiz|portfolio|gallery|tracker|inventory|booking|counter|timer|weather)\b/.test(
      p,
    ) &&
    /\b(app|application|project|site|page|ui|list|board|service|api)\b/.test(p)
  ) {
    return true;
  }
  // "build a full … with X feature"
  if (
    /\b(?:with|including|that\s+has|that\s+supports)\b[\s\S]{0,40}\b(todo|auth|crud|login|dashboard|blog)\b/.test(
      p,
    )
  ) {
    return true;
  }
  return false;
}

/** Paths that look like application source (not lockfiles / build output). */
export function isAppSourcePath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (
    /(?:^|\/)(?:node_modules|\.next|dist|build|coverage|\.git|vendor|target)(?:\/|$)/i.test(
      p,
    )
  ) {
    return false;
  }
  if (/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(p)) {
    return false;
  }
  return /\.(jsx?|tsx?|vue|svelte|py|go|rs|java|kt|rb|php|swift|cs|css|scss|sass|less|html|mdx)$/i.test(
    p,
  );
}

export function extractWritePathsFromCall(call: ToolCall): string[] {
  const paths: string[] = [];
  if (
    call.name === "fs.write" ||
    call.name === "fs.edit" ||
    call.name === "fs.replaceLines" ||
    call.name === "fs.append"
  ) {
    if (typeof call.args.path === "string") paths.push(call.args.path);
  }
  if (call.name === "fs.writeMany" && Array.isArray(call.args.files)) {
    for (const f of call.args.files) {
      if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
        paths.push((f as { path: string }).path);
      }
    }
  }
  return paths;
}

/** Default framework starter / marketing copy — not the product feature. */
export function looksLikeStarterBoilerplate(content: string): boolean {
  const c = content.slice(0, 8_000);
  return (
    /\bWelcome to (?:Vite|React|Next\.js|Create React App|Nuxt|SvelteKit|Angular)\b/i.test(
      c,
    ) ||
    /\bGet started by editing\b/i.test(c) ||
    /\bEdit\s+`?(?:src\/)?App\.(?:tsx?|jsx?)`?\s+and save to (?:test|reload)/i.test(
      c,
    ) ||
    /\blogos?\/(?:react|vite|next)\.svg\b/i.test(c) ||
    /\bnext\.js logo\b/i.test(c) ||
    /https?:\/\/(?:react\.dev|vitejs\.dev|nextjs\.org)\/(?:learn|docs)?/i.test(
      c,
    ) && /\b(?:Deploy|Learn|Templates|create-next-app)\b/i.test(c)
  );
}

/** Content that looks like real product UI/logic for common feature apps. */
export function looksLikeFeatureProductCode(content: string): boolean {
  const c = content.slice(0, 12_000);
  if (looksLikeStarterBoilerplate(c)) return false;
  // Interactive product signals (todo/crud/auth/etc.)
  if (
    /\b(?:useState|useReducer|createContext|signal\(|createSignal|ref\()\b/.test(
      c,
    ) &&
    /\b(?:todo|todos|onClick|onSubmit|addTodo|toggle|complete|delete|remove|login|signup|password|fetch\(|axios|localStorage)\b/i.test(
      c,
    )
  ) {
    return true;
  }
  if (
    /\b(?:add|create|toggle|delete|remove|update)\b/i.test(c) &&
    /\b(?:todo|item|task|post|note|user|cart)\b/i.test(c) &&
    /\b(?:map\s*\(|filter\s*\(|set[A-Z]\w+|useState)\b/.test(c)
  ) {
    return true;
  }
  // API/backend feature
  if (
    /\b(?:app\.(?:get|post|put|patch|delete)|router\.(?:get|post)|@(?:Get|Post|Put|Delete)|def\s+\w+\(.*request)/i.test(
      c,
    ) &&
    !looksLikeStarterBoilerplate(c)
  ) {
    return true;
  }
  return false;
}

function extractWriteContentsFromCall(call: ToolCall): string[] {
  const out: string[] = [];
  if (
    (call.name === "fs.write" ||
      call.name === "fs.append" ||
      call.name === "fs.replaceLines") &&
    typeof call.args.content === "string"
  ) {
    out.push(call.args.content);
  }
  if (call.name === "fs.edit" && typeof call.args.newText === "string") {
    out.push(call.args.newText);
  }
  if (call.name === "fs.writeMany" && Array.isArray(call.args.files)) {
    for (const f of call.args.files) {
      if (
        f &&
        typeof f === "object" &&
        typeof (f as { content?: unknown }).content === "string"
      ) {
        out.push((f as { content: string }).content);
      }
    }
  }
  return out;
}

/**
 * True when a successful tool call implements product feature code (not only scaffold).
 * Starter boilerplate alone does not count.
 */
export function isFeatureImplementationCall(call: ToolCall): boolean {
  const paths = extractWritePathsFromCall(call);
  const contents = extractWriteContentsFromCall(call);
  if (contents.some(looksLikeFeatureProductCode)) return true;
  // Content present but only starter → not feature
  if (
    contents.length > 0 &&
    contents.every((c) => looksLikeStarterBoilerplate(c) || c.trim().length < 40)
  ) {
    return false;
  }
  // Path-only signal: source write without inspectable content still counts
  // (e.g. truncated args) but not lockfiles/config alone.
  if (paths.some(isAppSourcePath) && contents.length === 0) return true;
  if (
    paths.some(isAppSourcePath) &&
    contents.some((c) => !looksLikeStarterBoilerplate(c) && c.trim().length >= 80)
  ) {
    return true;
  }
  // Hand-written multi-file setup with non-starter content
  if (
    call.name === "fs.writeMany" &&
    paths.length >= 2 &&
    contents.some((c) => !looksLikeStarterBoilerplate(c))
  ) {
    return true;
  }
  return false;
}

/**
 * User said work belongs on the Desktop (or similar). Returns absolute path.
 */
export function resolveUserDestinationHint(
  prompt: string,
  home = homedir(),
): string | undefined {
  const p = prompt.trim();
  if (!p) return undefined;

  // Explicit absolute /Users/.../Desktop/... already in the prompt — prefer that root
  const absDesktop = p.match(
    /((?:\/Users\/[^/\s]+|~)\/Desktop(?:\/[\w.-]+)?)/i,
  );
  if (absDesktop?.[1]) {
    const raw = absDesktop[1].replace(/^~(?=\/|$)/, home);
    // If they named a subfolder in the path, use parent Desktop for cwd default
    if (/\/Desktop$/i.test(raw) || /\/Desktop\//i.test(raw)) {
      const desk = raw.match(/^(.*?\/Desktop)/i);
      return desk?.[1] ?? raw;
    }
  }

  if (
    /\b(?:in|on|into|under|to)\s+(?:the\s+)?desktop(?:\s+directory|\s+folder)?\b/i.test(
      p,
    ) ||
    /\bdesktop\s+(?:directory|folder)\b/i.test(p) ||
    /\bcreate\b.+\b(?:on|in)\s+desktop\b/i.test(p)
  ) {
    return join(home, "Desktop");
  }
  return undefined;
}

/**
 * Default shell cwd when the model omitted it but a project root / Desktop hint exists.
 */
export function applyDestinationCwd(
  call: ToolCall,
  destinationHint: string | undefined,
): ToolCall {
  if (call.name !== "shell.exec" && call.name !== "shell.start") return call;
  if (typeof call.args.cwd === "string" && call.args.cwd.trim()) return call;
  const cmd = commandOf(call);
  // Prefer sticky project root (todo-app) over bare Desktop for install/dev.
  const cwd = getActiveProjectRoot() ?? destinationHint;
  if (!cwd) return call;

  const looksCreate = isScaffoldCreateCommand(cmd);
  // create into named subfolder: cwd should be parent of project if sticky root is the project
  if (looksCreate) {
    const nameMatch = cmd.match(
      /(?:create-vite(?:@\S+)?|create-next-app(?:@\S+)?|cargo\s+new|rails\s+new|poetry\s+new|flutter\s+create|mix\s+new|django-admin\s+startproject)\s+([A-Za-z0-9._-]+)/i,
    );
    if (nameMatch?.[1] && !nameMatch[1].startsWith("-")) {
      const parent = cwd.replace(/[/\\][^/\\]+$/, "");
      const useParent =
        cwd.endsWith(nameMatch[1]) ||
        cwd.endsWith("/" + nameMatch[1]) ||
        cwd.endsWith("\\" + nameMatch[1]);
      return {
        ...call,
        args: { ...call.args, cwd: useParent && parent ? parent : cwd },
      };
    }
    // Prefer destination parent (Desktop) for create when sticky root is already a project
    return { ...call, args: { ...call.args, cwd: destinationHint ?? cwd } };
  }

  const looksProjectLocal =
    /\b(npm\s+i(nstall)?|npm\s+run|yarn\s|pnpm\s|bun\s|pip\s+install|poetry\s+|cargo\s+|go\s+run|go\s+build|composer\s+|bundle\s+|dotnet\s+|flutter\s+|mix\s+|rails\s+|django)/i.test(
      cmd,
    ) || call.name === "shell.start";
  if (!looksProjectLocal) return call;
  return {
    ...call,
    args: { ...call.args, cwd },
  };
}
