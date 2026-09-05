
import { normalizePlanTaskEntries } from "./plan/handle-plan-tool.js";
export { planContextMessage } from "./plan/context-message.js";
export { handlePlanTool, looksLikeRunOnlyGoal, normalizeCodingPlanTasks, renderPlanForTerminal, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "./plan/handle-plan-tool.js";
export { normalizePlanTaskEntries };
export type { NormalizedPlanTask, PlanToolResult } from "./plan/handle-plan-tool.js";

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
  if (
    /\b(library|cli\b|command[- ]line|npm package|rust crate|go module)\b/.test(blob) &&
    !/\b(react|vite|next|vue|svelte|web\s*app|frontend|dev\s*server|localhost|todo\s*app|dashboard|spa)\b/.test(
      blob,
    )
  ) {
    return false;
  }
  if (kind === "coding") {
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

function normalizePlanTasks(args: Record<string, unknown>): string[] {
  return normalizePlanTaskEntries(args).map((t) => t.title);
}

export const PLAN_CONTEXT_PREFIX = "ACTIVE PLAN";

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
      if (message.content === content) return;
      break;
    }
  }
  messages.push({ role: "system", content });
}

export function removePlanContextMessage(
  messages: Array<{ role: string; content: string }>,
): void {
  const cleared = `${PLAN_CONTEXT_PREFIX}\n(cleared)`;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(PLAN_CONTEXT_PREFIX)
    ) {
      if (message.content === cleared) return;
      messages.push({ role: "system", content: cleared });
      return;
    }
  }
}

