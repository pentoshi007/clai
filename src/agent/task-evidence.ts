import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../types.js";
import { getActiveProjectRoot } from "./project-root.js";
import type { TaskEvidence } from "../store/plan.js";
import { TaskWorkSignals, classifyTaskTitle, isEvidenceWorkTool, isPentestPlanKind, looksLikeInstallTaskTitle, looksLikeScaffoldTaskTitle, toolFitsTaskClass } from "./evidence/task-classification.js";
import { isScaffoldCreateCommand } from "./evidence/tool-budgets.js";
import { TaskWorkLedger, commandOf } from "./evidence/task-selection.js";
export { canMarkTaskDone, isDevServerCall, isPackageInstallCommand, isRemoteObservationTask, isRuntimeObservationTask, pickPendingTaskForToolCall } from "./evidence/task-selection.js";
export type { CanMarkTaskDoneOpts, TaskWorkLedger } from "./evidence/task-selection.js";
export { DEFAULT_TOOL_TIMEOUT_MS, isLongQuietInstallOrScaffoldCommand, isLongRunningTestOrBuildCommand, toolHardBudgetMs, toolStallBudgetMs } from "./evidence/tool-budgets.js";
export { isScaffoldCreateCommand };
export { isMetaPlanTool } from "./evidence/task-classification.js";
export { classifyTaskTitle, isEvidenceWorkTool, isPentestPlanKind, looksLikeInstallTaskTitle, looksLikeScaffoldTaskTitle, toolFitsTaskClass };
export type { TaskClass, TaskWorkSignals } from "./evidence/task-classification.js";

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

/** Successful work observed this turn without a credited open task. */
export interface LooseWorkReceipt {
  readonly toolName: string;
  readonly signals?: TaskWorkSignals | undefined;
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
