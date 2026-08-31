
import { normalizePlanTaskEntries } from "./plan/handle-plan-tool.js";
export { planContextMessage } from "./plan/context-message.js";
export { handlePlanTool, looksLikeRunOnlyGoal, normalizeCodingPlanTasks, renderPlanForTerminal, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "./plan/handle-plan-tool.js";
export { normalizePlanTaskEntries };
export type { NormalizedPlanTask, PlanToolResult } from "./plan/handle-plan-tool.js";

/** Final coding-plan task: start server / probe localhost / leave running. */
export function looksLikeRunServerTask(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (
    /\b(dev\s*server|npm\s+run\s+dev|pnpm\s+(run\s+)?dev|yarn\s+dev|bun\s+run\s+dev|shell\.start|localhost|leave\s+(it\s+)?running|verify\s+in\s+browser|open\s+in\s+browser|probe\s+(localhost|http)|http:\/\/localhost)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(start|run)\b.+\b(server|dev|vite|next|preview)\b/.test(t)) return true;
  if (/\b(server|dev|vite|next|preview)\b.+\b(start|run|verify|tail|probe)\b/.test(t)) {
    return true;
  }
  // "run and verify" / "start app" style finals
  if (/\b(run|start)\b.+\b(app|verify)\b/.test(t) && /\b(server|dev|browser|localhost|url|port|job)\b/.test(t)) {
    return true;
  }
  return false;
}

export function looksLikeLocalAppScaffold(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): boolean {
  if (kind === "pentest") return false;
  const blob = `${kind} ${goal} ${detail} ${tasks.join(" ")}`.toLowerCase();
  // Pure libraries / CLIs with no server surface
  if (
    /\b(library|cli\b|command[- ]line|npm package|rust crate|go module)\b/.test(blob) &&
    !/\b(react|vite|next|vue|svelte|web\s*app|frontend|dev\s*server|localhost|todo\s*app|dashboard|spa)\b/.test(
      blob,
    )
  ) {
    return false;
  }
  if (kind === "coding") {
    // coding + no library-only signal → require run/verify when app-like
    return /\b(app|react|vite|next|vue|svelte|nuxt|angular|frontend|web|ui|todo|blog|dashboard|spa|server|localhost|scaffold)\b/.test(
      blob,
    );
  }
  return /\b(react|vite|next\.?js?|vue|svelte|nuxt|angular|web\s*app|frontend|spa|todo\s*app|blog\s*app|dashboard)\b/.test(
    blob,
  );
}

export function codingPlanNeedsRunVerifyTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): boolean {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return false;
  return !tasks.some(looksLikeRunServerTask);
}

function looksLikeInstallTask(title: string): boolean {
  const t = title.toLowerCase();
  return (
    /\b(install|dependencies|deps|packages)\b/.test(t) &&
    !/\b(dev\s*server|localhost|probe|run\s+dev)\b/.test(t)
  );
}

function looksLikeScaffoldishTask(title: string): boolean {
  return /\b(scaffold|create|init|vite|next|bootstrap|cargo\s+new)\b/i.test(
    title,
  );
}

/**
 * Ensure coding app plans have an explicit install step after scaffold.
 * Avoids "implement blocked from npm install" + install attributed to wrong task.
 */
export function ensureCodingPlanInstallTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): string[] {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return tasks;
  if (tasks.some(looksLikeInstallTask)) return tasks;
  if (!tasks.some(looksLikeScaffoldishTask)) return tasks;
  const out = [...tasks];
  const scaffoldIdx = out.findIndex(looksLikeScaffoldishTask);
  const insertAt = scaffoldIdx >= 0 ? scaffoldIdx + 1 : 0;
  out.splice(
    insertAt,
    0,
    "Install project dependencies (npm/yarn/pnpm/bun install in project root)",
  );
  return out;
}

function looksLikeFeatureImplementTask(title: string): boolean {
  const t = title.toLowerCase();
  if (looksLikeInstallTask(title) || looksLikeRunServerTask(title)) return false;
  if (looksLikeScaffoldishTask(title) && !/\b(feature|todo|component|ui)\b/.test(t)) {
    return false;
  }
  return (
    /\b(implement|feature|todo|component|ui|crud|auth|localstorage|persist|integrate)\b/.test(
      t,
    ) ||
    (/\b(add|build|write|create)\b/.test(t) &&
      /\b(todo|feature|component|page|ui|list|form)\b/.test(t))
  );
}

function looksLikeFeatureAppPlan(
  goal: string,
  detail: string,
  tasks: string[],
): boolean {
  const blob = `${goal}\n${detail}\n${tasks.join("\n")}`.toLowerCase();
  if (/\b(just|only)\s+(scaffold|init|boilerplate|starter)\b/.test(blob)) {
    return false;
  }
  return (
    /\b(todo|to-?do|blog|dashboard|chat|kanban|notes?|crm|shop|auth|login|crud|portfolio)\b/.test(
      blob,
    ) &&
    /\b(app|application|project|site|ui|feature)\b/.test(blob)
  );
}

/**
 * Ensure feature-app plans include an implement-feature task (not scaffold-only).
 */
export function ensureCodingPlanFeatureTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): string[] {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return tasks;
  if (!looksLikeFeatureAppPlan(goal, detail, tasks)) return tasks;
  if (tasks.some(looksLikeFeatureImplementTask)) return tasks;
  const out = [...tasks];
  // Insert after install if present, else after scaffold, else before last (verify)
  const installIdx = out.findIndex(looksLikeInstallTask);
  const scaffoldIdx = out.findIndex(looksLikeScaffoldishTask);
  const runIdx = out.findIndex(looksLikeRunServerTask);
  let insertAt: number;
  if (installIdx >= 0) insertAt = installIdx + 1;
  else if (scaffoldIdx >= 0) insertAt = scaffoldIdx + 1;
  else if (runIdx >= 0) insertAt = runIdx;
  else insertAt = out.length;
  out.splice(
    insertAt,
    0,
    "Implement the requested product feature (replace starter boilerplate with real UI/state)",
  );
  return out;
}

/** Ensure local app plans end with shell.start + probe + leave running. */
export function ensureCodingPlanRunVerifyTask(
  kind: string,
  goal: string,
  detail: string,
  tasks: string[],
): string[] {
  if (!looksLikeLocalAppScaffold(kind, goal, detail, tasks)) return tasks;
  if (tasks.some(looksLikeRunServerTask)) return tasks;
  return [
    ...tasks,
    "Start dev server with shell.start, probe localhost, leave running, report URL/port/job id",
  ];
}

/**
 * Accept tasks as string[], object[], or a single newline/comma-separated string.
 * Models frequently emit `[{id,title}]` instead of plain strings.
 */
function normalizePlanTasks(args: Record<string, unknown>): string[] {
  return normalizePlanTaskEntries(args).map((t) => t.title);
}

/** Build the system-context block describing the session's active plan. */
// Marker that identifies the single live plan message in a request.
export const PLAN_CONTEXT_PREFIX = "ACTIVE PLAN";

// Keep exactly one live ACTIVE PLAN copy in the request, as a suffix. The plan
// is mutable state: a snapshot frozen into the stable system prefix goes stale
// as tasks advance, and a second re-injected copy lets the model see two
// disagreeing plans. Every prior copy is dropped before the current one is
// appended. Call only at protocol-safe points (never between an assistant tool
// call and its results).
export function upsertPlanContextMessage(
  messages: Array<{ role: string; content: string }>,
  content: string,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(PLAN_CONTEXT_PREFIX)
    ) {
      messages.splice(index, 1);
    }
  }
  messages.push({ role: "system", content });
}

export function removePlanContextMessage(
  messages: Array<{ role: string; content: string }>,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(PLAN_CONTEXT_PREFIX)
    ) {
      messages.splice(index, 1);
    }
  }
}

