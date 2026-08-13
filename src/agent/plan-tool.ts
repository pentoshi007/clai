import chalk from "chalk";
import {
  createPlan,
  deletePlan,
  loadPlan,
  savePlan,
  mutatePlan,
  applyForegroundSnapshot,
  markTask,
  isBareTaskIdTitle,
  isPlanTerminal,
  isPlanSuccessful,
  readyPlanTasks,
  appendPlanTask,
  applySessionPlanOperation,
  validateSessionPlan,
  normalizeTaskDependencies,
  type SessionPlan,
  type TaskState,
} from "../store/plan.js";
import { evaluateTaskTransition } from "../store/task-transitions.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import type { LoopGuard } from "./loop-guard.js";
import type { SessionPolicy } from "./session-policy.js";
import { isLumpedSingleTask } from "./tool-call-parser.js";
import { buildDependencyReminder, dependencyToast } from "./task-sync.js";
import type { ToolCall } from "../types.js";
import { getActiveProjectRoot } from "./project-root.js";
import { classifyTaskTitle } from "./task-evidence.js";
import { detectPackageManager } from "./workspace-orient.js";

/** Titles match for plan merge (exact or mutual long substring). */
export function titlesMatchForPlan(a: string, b: string): boolean {
  const t1 = a.trim().toLowerCase();
  const t2 = b.trim().toLowerCase();
  return (
    t1 === t2 ||
    (t1.length > 8 && t2.length > 8 && (t1.includes(t2) || t2.includes(t1)))
  );
}

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

/** Preserve the model/user-authored checklist exactly for fresh coding plans. */
export function normalizeCodingPlanTasks(
  _kind: string,
  _goal: string,
  _detail: string,
  tasks: string[],
): string[] {
  return [...tasks];
}

/** Goal is only "run/start the existing app" — do not open a new plan. */
export function looksLikeRunOnlyGoal(goal: string, detail: string): boolean {
  const blob = `${goal} ${detail}`.toLowerCase();
  if (!/\b(run|start|launch|serve|dev\s*server|npm\s+run\s+dev)\b/.test(blob)) {
    return false;
  }
  // Exclude fresh scaffold goals
  if (/\b(scaffold|create|build|implement|add feature|from scratch|new app)\b/.test(blob)) {
    return false;
  }
  return /\b(existing|already|the app|dev server|server|verify|test it|open it)\b/.test(blob)
    || /^(run|start)\b/.test(blob.trim());
}

function nextTaskId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^t(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t${max + 1}`;
}

/** Coerce model-sloppy plan.create fields into clean titles. */
function normalizePlanGoal(args: Record<string, unknown>): string {
  const raw = args.goal ?? args.objective ?? args.title ?? args.name;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["title", "text", "goal", "name", "summary"]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

function normalizePlanDetail(args: Record<string, unknown>): string {
  const raw = args.detail ?? args.description ?? args.approach ?? args.notes;
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join("\n")
      .trim();
  }
  return "";
}

function normalizePlanKind(args: Record<string, unknown>): string {
  const raw = args.kind ?? args.type ?? args.category;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  return "general";
}

function normalizeTaskTitle(t: unknown): string {
  if (typeof t === "string") return t.trim();
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  if (t && typeof t === "object") {
    const o = t as Record<string, unknown>;
    for (const k of [
      "title",
      "task",
      "name",
      "text",
      "description",
      "label",
      "step",
      "summary",
    ]) {
      if (typeof o[k] === "string" && o[k]!.toString().trim()) {
        return String(o[k]).trim();
      }
    }
  }
  return "";
}

export function slugifyTaskId(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export interface NormalizedPlanTask {
  title: string;
  aliases: string[];
  dependencies: string[];
  dependenciesSpecified: boolean;
  resourceLocks: string[];
}

/**
 * Accept tasks as string[], object[], or a single newline/comma-separated string.
 * Models frequently emit `[{id,title}]` instead of plain strings.
 */
function normalizePlanTasks(args: Record<string, unknown>): string[] {
  return normalizePlanTaskEntries(args).map((t) => t.title);
}

/** Full entries including model-supplied id/name aliases (X3). */
export function normalizePlanTaskEntries(
  args: Record<string, unknown>,
): NormalizedPlanTask[] {
  const raw =
    args.tasks ?? args.steps ?? args.checklist ?? args.items ?? args.todos;
  if (typeof raw === "string") {
    return raw
      .split(/\n|;|(?:,\s*(?=[A-Z0-9\-]))/)
      .map((s) => s.replace(/^\s*[-*\d.)]+\s*/, "").trim())
      .filter(Boolean)
      .map((title) => ({
        title,
        aliases: [] as string[],
        dependencies: [] as string[],
        dependenciesSpecified: false,
        resourceLocks: [] as string[],
      }));
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const title = normalizeTaskTitle(t);
      if (!title || isBareTaskIdTitle(title)) return null;
      const aliases: string[] = [];
      if (t && typeof t === "object") {
        const o = t as Record<string, unknown>;
        for (const k of ["id", "taskId", "key", "slug"]) {
          if (typeof o[k] === "string" && o[k]!.toString().trim()) {
            aliases.push(String(o[k]).trim());
          }
        }
        // `name` is often the title; only alias if it differs.
        if (
          typeof o.name === "string" &&
          o.name.trim() &&
          o.name.trim().toLowerCase() !== title.toLowerCase()
        ) {
          aliases.push(o.name.trim());
        }
      }
      const slug = slugifyTaskId(title);
      if (slug && !aliases.includes(slug)) aliases.push(slug);
      const object = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
      const stringArray = (value: unknown): string[] =>
        Array.isArray(value)
          ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
          : [];
      return {
        title,
        aliases: [...new Set(aliases)],
        dependencies: stringArray(object.dependencies ?? object.dependsOn),
        dependenciesSpecified:
          Object.prototype.hasOwnProperty.call(object, "dependencies") ||
          Object.prototype.hasOwnProperty.call(object, "dependsOn"),
        resourceLocks: stringArray(object.resourceLocks ?? object.resources),
      };
    })
    .filter((x): x is NormalizedPlanTask => Boolean(x));
}

/** Resolve model taskId (t1 or slug) to the canonical plan task id. */
export function resolvePlanTaskId(
  plan: SessionPlan,
  taskId: string,
): string | undefined {
  const raw = taskId.trim();
  if (!raw) return undefined;
  if (plan.tasks.some((t) => t.id === raw)) return raw;
  const lower = raw.toLowerCase();
  const slug = slugifyTaskId(raw);
  for (const t of plan.tasks) {
    if (t.aliases?.some((a) => a === raw || a.toLowerCase() === lower)) {
      return t.id;
    }
  }
  return undefined;
}

/** Render the portable inline form; the Ink TUI owns its responsive sidebar. */
export function renderPlanForTerminal(plan: SessionPlan): string {
  return renderPlanChecklist(plan);
}

export interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  cleared?: boolean | undefined;
  /** What to print to the user's terminal. */
  display: string;
  /** What to feed back to the model as the tool result. */
  modelNote: string;
  /** Soft reminder (held, not applied) — skip loop-guard accounting. */
  reminder?: boolean | undefined;
  /** Short identifiable toast to surface when this result is a reminder. */
  toast?: string | undefined;
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

export function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN v${plan.version ?? 1} for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    const aliasHint =
      t.aliases?.length && t.aliases[0] !== t.id
        ? ` [aliases: ${t.aliases.slice(0, 3).join(", ")}]`
        : "";
    const dependencyHint = t.dependencies?.length
      ? ` [depends: ${t.dependencies.join(", ")}]`
      : "";
    const resourceHint = t.resourceLocks?.length
      ? ` [locks: ${t.resourceLocks.join(", ")}]`
      : "";
    const evidenceHint = t.evidence?.successWorkCount
      ? ` [evidence: ${t.evidence.successWorkCount} successful tool${t.evidence.successWorkCount === 1 ? "" : "s"}${t.evidence.lastOkTool ? `; last ${t.evidence.lastOkTool}` : ""}]`
      : "";
    const hierarchyHint = t.parentTaskId ? ` [child of ${t.parentTaskId}]` : "";
    const jobHint = t.jobId
      ? ` [responder job=${t.jobId}${t.processId ? ` pid=${t.processId}` : ""}]`
      : "";
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}${hierarchyHint}${jobHint}${aliasHint}${dependencyHint}${resourceHint}${evidenceHint}`);
  });
  lines.push(
    "task.update taskId MUST be t1, t2, … from this list (or a listed alias). Use task.add for newly discovered work; it is placed before unfinished report creation. Use task.move with position/beforeTaskId/afterTaskId to rearrange work without changing ids or evidence. Responder-owned job tasks advance automatically; never task.update them. After analyzing a delivered Responder result, job.read its job or notification before finalizing.",
  );
  if (plan.meta?.projectRoot) {
    lines.push(`project_root: ${plan.meta.projectRoot}`);
  }
  if (plan.meta?.packageManager) {
    lines.push(`package_manager: ${plan.meta.packageManager}`);
  }
  if (approved) {
    const inProgress = plan.tasks.find(
      (task) => task.state === "in_progress" && !task.responderOwned,
    );
    const failed = plan.tasks.find(
      (task) => task.state === "failed" && !task.responderOwned,
    );
    const firstPending = readyPlanTasks(plan)[0];
    const hasOpenWork = plan.tasks.some(
      (task) =>
        !task.responderOwned &&
        (task.state === "in_progress" ||
          task.state === "pending" ||
          task.state === "failed"),
    );
    lines.push(
      "The user APPROVED this plan. Execute it NOW. Tasks are checkpoints — you still own the user's requested boundary. Their states are authoritative for tracked work, but a completed phase is not completion of an explicitly requested whole roadmap/program.",
    );
    if (inProgress) {
      lines.push(
        `RESUME TASK ${inProgress.id} (${inProgress.title}) — it was started but interrupted. ` +
          "Retry what was in progress; do NOT restart completed work from scratch. " +
          "Do NOT re-do tasks already marked done.",
      );
    } else if (failed) {
      lines.push(
        `RETRY FAILED TASK ${failed.id} (${failed.title}) — reopen it (task.update in_progress), ` +
          "fix the root cause, then re-verify before marking done. Do NOT re-do tasks already marked done.",
      );
    } else if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done.",
      );
    }
    if (hasOpenWork) {
      lines.push(
        "FIRST THIS TURN — reconcile with this task list before doing anything else. It persists across abort and " +
          "compaction, is re-injected here every turn, and is the CURRENT source of truth for what is done vs pending. " +
          "It OVERRIDES any 'current state', 'remaining work', 'ready to…', or completion wording in the compacted memory " +
          "summary; when the summary and these task states disagree, trust these task states.",
      );
      lines.push(
        "Let the task states drive your next action and next reads: open the in_progress or failed task, read only its " +
          "own artifacts plus the specific earlier-task outputs you need to confirm what is already done, then continue " +
          "strictly task-by-task from there. Do NOT re-scan the whole project or read unrelated files to rediscover " +
          "status. You are advised to work through every task, but you may stop without finishing all of them when " +
          "genuinely blocked or when the situation requires it — report the remaining tasks honestly instead of " +
          "forcing completion.",
      );
    }
    lines.push(
      "Flow: task.update in_progress → real work → WAIT for and READ every tool result for that task → " +
        "only then mark done when the task outcome is satisfied → immediately open the next task. " +
        "Never mark done right after firing a foreground command on the hope it will succeed — analyze the actual output first. " +
        "A durable background launch creates a Responder-owned child task: launch high-value slow enumeration/fuzzing early, continue independent fast work, and never busy-poll or start a duplicate. " +
        "If only Responder-owned child tasks remain, yield honestly; Responder will inject the durable completion and wake the session without forcing an empty turn. " +
        "Durable evidence shown beside a task survives resume; use it to close that task rather than repeating already-confirmed work. " +
        "Independent read-only lookups may parallelize within a task. " +
        "If a tool fails: mark failed or stay in progress, fix, retry until the task is truly done. " +
        "For software builds: run automated checks (typecheck/build/tests when applicable) then live/runtime proof. " +
        "For run/verify: prove runtime (shell.start, ready tail, LISTEN, or localhost GET), leave server running, final message includes URL, port, and job id. " +
        "Do not re-open done tasks. If mid-task evidence shows the plan is wrong, adapt (fix root cause; for pentest, revise plan with completed tasks preserved).",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved — do not execute tasks (no scaffold/write/install/exploit). " +
        "User free-text is PLAN REVISION feedback, not approval — even if it sounds like an instruction. " +
        "On revision: call plan.create with the COMPLETE intended checklist (drop obsolete tasks; " +
        "matching titles keep stable ids). Be decisive — one coherent rewrite, then STOP. " +
        "User may Accept, Discard, View, or Suggest changes (or /implement / /discard).",
    );
  }
  return lines.join("\n");
}

/**
 * Handle plan.create / task.update inline. These are session-scoped and
 * persisted via the plan store so the user can view the plan (Ctrl+P) and
 * the agent keeps it in context across the whole session.
 */
export async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number; autoApprove?: boolean },
): Promise<PlanToolResult> {
  const autoApprove = Boolean(ctx.autoApprove);
  void ctx.loopGuard;
  void ctx.step;
  // Defensive init for the sync-guard holders (legacy/hand-built policies).
  if (!session.pendingDependency) session.pendingDependency = { value: undefined };
  if (!session.pendingTaskBatch) session.pendingTaskBatch = { value: undefined };
  if (call.name === "plan.create") {
    const goal = normalizePlanGoal(call.args);
    const detail = normalizePlanDetail(call.args);
    const kind = normalizePlanKind(call.args);
    const taskEntries = normalizePlanTaskEntries(call.args);
    const taskTitles = taskEntries.map((t) => t.title);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array. " +
          'Accepted task shapes: ["step 1","step 2"] or [{"title":"step 1"},{"id":"t1","title":"step 2"}]. ' +
          'Example: {"name":"plan.create","args":{"goal":"Assess example.com","detail":"…","tasks":["DNS enum","Port scan","HTTP fingerprint"],"kind":"pentest"}}',
      };
    }
    // Reject a low-quality "everything in one step" plan. A single task that
    // itself enumerates many files/actions (commas, "and", slashes) is a sign
    // the model lumped the whole build into one checkbox — split it so the
    // user gets a real, trackable checklist and the executor works step by step.
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into separate " +
          "ordered tasks — each a distinct action (scaffold, implement feature, install, run/verify). " +
          "Call plan.create again with a proper tasks array.",
      };
    }

    const existingPlan = await loadPlan(session.sessionId).catch(() => undefined);

    // X12: do not open a second full plan just to run an existing app.
    if (
      existingPlan &&
      (existingPlan.status === "completed" ||
        existingPlan.tasks.every(
          (t) =>
            t.state === "done" || t.state === "skipped" || t.state === "failed",
        )) &&
      looksLikeRunOnlyGoal(goal, detail)
    ) {
      return {
        handled: true,
        ok: false,
        display: chalk.yellow(
          "  ⚠ plan.create skipped — use tools to run the existing app\n",
        ),
        modelNote:
          "plan.create rejected: the previous plan is already finished and this goal is only run/verify. " +
          "Do NOT create a new plan or re-list old scaffold tasks. " +
          "Just shell.start the dev server, shell.tail until ready, probe localhost " +
          "(curl or http.fetch with iOwnThis:true), LEAVE the server running, and tell the user " +
          "the URL (http://localhost:<port>), port, and job id.",
      };
    }

    const appendingToActivePlan =
      existingPlan &&
      existingPlan.status !== "draft" &&
      !isPlanTerminal(existingPlan) &&
      (session.planApproved.value ||
        existingPlan.status === "approved" ||
        existingPlan.status === "in_progress");
    if (appendingToActivePlan) {
      const priorIds = new Set(existingPlan.tasks.map((task) => task.id));
      let invalidDependency: string | undefined;
      const appended = await mutatePlan(existingPlan.sessionId, (draft) => {
        let changed = false;
        let previousForegroundId = [...draft.tasks]
          .reverse()
          .find((task) => !task.responderOwned)?.id;
        for (const entry of taskEntries) {
          if (
            isBareTaskIdTitle(entry.title) ||
            draft.tasks.some((task) =>
              titlesMatchForPlan(task.title, entry.title),
            )
          ) {
            continue;
          }
          const dependencies = entry.dependenciesSpecified
            ? entry.dependencies.map((reference) => {
                const resolved = resolvePlanTaskId(draft, reference);
                if (!resolved) invalidDependency = reference;
                return resolved;
              })
            : previousForegroundId
              ? [previousForegroundId]
              : [];
          if (invalidDependency) return false;
          const task = appendPlanTask(draft, {
            title: entry.title,
            state: "pending",
            aliases: entry.aliases,
            dependencies: dependencies.filter(
              (dependency): dependency is string => Boolean(dependency),
            ),
            resourceLocks: entry.resourceLocks,
          });
          previousForegroundId = task.id;
          changed = true;
        }
        return changed;
      }).catch(() => undefined);

      if (!appended?.ok || !appended.plan) {
        const reason = invalidDependency
          ? `unknown dependency "${invalidDependency}"`
          : "every proposed task already exists in ACTIVE PLAN";
        return {
          handled: true,
          ok: false,
          display: chalk.yellow(
            `  ⚠ plan.create kept the active plan — ${reason}\n`,
          ),
          modelNote:
            `plan.create did not replace ACTIVE PLAN: ${reason}. ` +
            "Continue its current in_progress task. Use task.add once per genuinely new task; never recreate or renumber active work.",
        };
      }

      session.planApproved.value = true;
      const addedTasks = appended.plan.tasks.filter(
        (task) => !priorIds.has(task.id),
      );
      const checklist = renderPlanForTerminal(appended.plan);
      return {
        handled: true,
        ok: true,
        plan: appended.plan,
        display:
          chalk.cyan("  ● active plan extended (append-only)\n") +
          checklist +
          "\n" +
          chalk.dim(
            `  ✦ preserved all existing ids/states; appended ${addedTasks.length} new task(s).\n`,
          ),
        modelNote:
          `ACTIVE PLAN was preserved and ${addedTasks.length} genuinely new task(s) were appended as ${addedTasks.map((task) => task.id).join(", ")}. ` +
          "Continue the existing in_progress task first. For later discoveries use task.add, not plan.create; never re-run completed work.",
      };
    }

    const revisablePlan =
      existingPlan &&
      (!isPlanTerminal(existingPlan) ||
        titlesMatchForPlan(existingPlan.goal, goal))
        ? existingPlan
        : undefined;

    // Preserve authored task count/order. Build, install, and verification
    // evidence may span tasks; the runtime must not inject regex-derived
    // checkpoints that change IDs or make progress diverge from the plan.
    const normalizedTitles = revisablePlan
      ? taskTitles
      : normalizeCodingPlanTasks(kind, goal, detail, taskTitles);

    const root = getActiveProjectRoot();
    const pm = root ? detectPackageManager(root) : undefined;
    const meta =
      root || revisablePlan?.meta
        ? {
            ...(revisablePlan?.meta ?? {}),
            ...(root ? { projectRoot: root } : {}),
            ...(pm ? { packageManager: pm } : {}),
          }
        : undefined;

    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles: normalizedTitles,
      kind,
      meta,
    });
    // Attach model-supplied slug aliases so task.update can resolve them (X3).
    for (let i = 0; i < plan.tasks.length; i++) {
      const aliases = taskEntries[i]?.aliases ?? [];
      if (aliases.length) plan.tasks[i]!.aliases = aliases;
      const locks = taskEntries[i]?.resourceLocks ?? [];
      if (locks.length) plan.tasks[i]!.resourceLocks = locks;
    }
    for (let i = 0; i < plan.tasks.length; i++) {
      const rawDependencies = taskEntries[i]?.dependencies ?? [];
      const dependencies = rawDependencies.map(
        (dependency) => resolvePlanTaskId(plan, dependency) ?? dependency,
      );
      if (taskEntries[i]?.dependenciesSpecified) {
        plan.tasks[i]!.dependencies = [...new Set(dependencies)];
      }
    }

    let additiveOnly = false;
    if (revisablePlan) {
      plan.version = (revisablePlan.version ?? 1) + 1;
      const usedOldIds = new Set<string>();
      const matchedIndices = new Set<number>();
      const mappedNewTasks = plan.tasks.map((task, index) => {
        const match = revisablePlan.tasks.find(
          (t) =>
            !usedOldIds.has(t.id) && titlesMatchForPlan(t.title, task.title),
        );
        if (match) {
          usedOldIds.add(match.id);
          matchedIndices.add(index);
          return {
            ...task,
            id: match.id,
            state: match.state,
            note: match.note,
            evidence: match.evidence,
            parentTaskId: match.parentTaskId,
            jobId: match.jobId,
            processId: match.processId,
            responderOwned: match.responderOwned,
          };
        }
        return task;
      });

      // Free ids for unmatched tasks only. Matched tasks keep prior ids;
      // new createPlan ids must not collide (e.g. t3 new step vs remapped Verify→t3).
      const taken = new Set(
        [...matchedIndices].map((i) => mappedNewTasks[i]!.id),
      );
      for (let i = 0; i < mappedNewTasks.length; i++) {
        if (matchedIndices.has(i)) continue;
        const task = mappedNewTasks[i]!;
        if (taken.has(task.id)) {
          let id = nextTaskId([...taken]);
          while (taken.has(id)) id = nextTaskId([...taken, id]);
          task.id = id;
        }
        taken.add(task.id);
      }

      // Draft (awaiting accept): plan.create is an authoritative rewrite.
      // Keeping unmatched old pending tasks made "suggest changes" leave
      // obsolete steps (e.g. Prisma/JWT) beside the revised frontend list.
      const isDraftRewrite =
        revisablePlan.status === "draft" && !session.planApproved.value;

      if (isDraftRewrite) {
        plan.tasks = mappedNewTasks.filter((t) => !isBareTaskIdTitle(t.title));
      } else {
        // Post-approval / mid-execution: preserve finished work not re-listed;
        // drop unmatched pending; soft-skip unmatched in_progress.
        const oldTasksToKeep = revisablePlan.tasks
          .filter(
            (oldTask) =>
              !isBareTaskIdTitle(oldTask.title) &&
              !mappedNewTasks.some((newTask) =>
                titlesMatchForPlan(oldTask.title, newTask.title),
              ),
          )
          .map((oldTask) => {
            if (oldTask.responderOwned) return oldTask;
            if (
              oldTask.state === "done" ||
              oldTask.state === "skipped" ||
              oldTask.state === "failed"
            ) {
              return oldTask;
            }
            if (oldTask.state === "in_progress") {
              return {
                ...oldTask,
                state: "skipped" as const,
                note: oldTask.note ?? "superseded by plan revision",
              };
            }
            // Unmatched pending → obsolete after rewrite; drop.
            return null;
          })
          .filter((t): t is NonNullable<typeof t> => Boolean(t));

        plan.tasks = [...oldTasksToKeep, ...mappedNewTasks].filter(
          (t) => !isBareTaskIdTitle(t.title),
        );
      }

      // Map input-facing references (positional t1.., aliases, titles) → final ids.
      // Positional keys must win over identity: a remapped task may keep id "t3"
      // while input "t3" still means "third item in this plan.create call".
      const finalIdByInputReference = new Map<string, string>();
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        const task = mappedNewTasks[index]!;
        const entry = taskEntries[index];
        finalIdByInputReference.set(task.id, task.id);
        finalIdByInputReference.set(slugifyTaskId(task.title), task.id);
        for (const alias of entry?.aliases ?? []) {
          finalIdByInputReference.set(alias, task.id);
        }
      }
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        finalIdByInputReference.set(`t${index + 1}`, mappedNewTasks[index]!.id);
      }
      for (let index = 0; index < mappedNewTasks.length; index += 1) {
        const task = mappedNewTasks[index]!;
        const entry = taskEntries[index];
        // Default chain: depend on the previous task in THIS create call by
        // its final id (not positional tN, which collides after id remap).
        const references = entry?.dependenciesSpecified
          ? entry.dependencies
          : index > 0
            ? [mappedNewTasks[index - 1]!.id]
            : [];
        task.dependencies = [
          ...new Set(
            references
              .map(
                (reference) =>
                  finalIdByInputReference.get(reference) ??
                  resolvePlanTaskId(plan, reference) ??
                  reference,
              )
              .filter((id) => id !== task.id),
          ),
        ];
      }

      // X7: keep approval when only additive pending work remains.
      const priorFinished = revisablePlan.tasks.filter(
        (t) =>
          t.state === "done" || t.state === "skipped" || t.state === "failed",
      );
      const finishedStillFinished =
        priorFinished.length > 0 &&
        priorFinished.every((old) =>
          plan.tasks.some(
            (n) =>
              titlesMatchForPlan(old.title, n.title) &&
              (n.state === "done" ||
                n.state === "skipped" ||
                n.state === "failed"),
          ),
        );
      const hasNewPending = plan.tasks.some((t) => t.state === "pending");
      const noDoneReopened = !plan.tasks.some((n) => {
        const old = revisablePlan.tasks.find((t) =>
          titlesMatchForPlan(t.title, n.title),
        );
        return (
          old &&
          (old.state === "done" || old.state === "skipped") &&
          n.state === "pending"
        );
      });
      additiveOnly =
        finishedStillFinished &&
        hasNewPending &&
        noDoneReopened &&
        (session.planApproved.value ||
          revisablePlan.status === "approved" ||
          revisablePlan.status === "in_progress" ||
          revisablePlan.status === "completed");

      if (additiveOnly) {
        plan.status = "in_progress";
        plan.createdAt = revisablePlan.createdAt;
      }
    }

    // After id remaps, re-derive a sane sequential DAG from list order so
    // remapped ids never leave edges like t2 → t9 (forward / circular mess).
    normalizeTaskDependencies(plan.tasks);

    const dag = validateSessionPlan(plan);
    if (!dag.ok) {
      // Last resort: pure linear chain by list order, then re-validate.
      for (let i = 0; i < plan.tasks.length; i++) {
        plan.tasks[i]!.dependencies = i > 0 ? [plan.tasks[i - 1]!.id] : [];
      }
      const again = validateSessionPlan(plan);
      if (!again.ok) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ plan.create: invalid dependency graph — ${again.reason}\n`,
          ),
          modelNote: `plan.create failed: ${again.reason}. Use only declared task ids/aliases and remove dependency cycles.`,
        };
      }
    }

    if (additiveOnly) {
      session.planApproved.value = true;
      plan.status = "in_progress";
    } else if (autoApprove) {
      session.planApproved.value = true;
      plan.status = "approved";
    } else {
      session.planApproved.value = false;
    }

    // A revision is a foreground snapshot; responder children keep
    // their process-authoritative state. A brand-new plan has nothing stored
    // yet, so fall back to a plain create.
    const revised = await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, plan);
      return true;
    }).catch(() => undefined);
    if (!revised?.ok) {
      await savePlan(plan).catch(() => undefined);
    } else if (revised.plan) {
      plan.tasks = revised.plan.tasks;
      plan.version = revised.plan.version;
    }

    const checklist = renderPlanForTerminal(plan);
    const display = additiveOnly
      ? chalk.cyan("  ● plan updated (additive)\n") +
        checklist +
        "\n" +
        chalk.dim(
          "  ✦ done tasks preserved — continue from the first pending task only.\n" +
            "    Do NOT re-run completed scaffold/build work.\n",
        )
      : autoApprove
        ? chalk.cyan("  ● plan created (auto-approved)\n") +
          checklist +
          "\n" +
          chalk.dim(
            "  ✦ plan approved in agent mode — continue executing task by task.\n",
          )
        : chalk.cyan("  ● planning\n") +
          checklist +
          "\n" +
          chalk.dim(
            "  ✦ plan created — Accept to run, Discard, View, or Suggest changes\n" +
              "    (/implement, /discard, Ctrl+P also work).\n",
          );

    const firstPending = readyPlanTasks(plan)[0];
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote: additiveOnly
        ? `Plan updated with additive task(s); ${plan.tasks.filter((t) => t.state === "done" || t.state === "skipped").length} prior task(s) stay done. ` +
          "Do NOT re-execute completed tasks (no re-scaffold). " +
          (firstPending
            ? `Continue from [${firstPending.id}] "${firstPending.title}" only. `
            : "") +
          "If the only new work is run/verify on an existing app, prefer shell.start + probe + report URL — " +
          "do not reboot the world. When the run/verify task finishes, final message MUST include " +
          "http://localhost:<port>, port, job id, and that the server is still running."
        : autoApprove
          ? `Plan saved and approved with ${plan.tasks.length} task(s). Execute now. ` +
            (firstPending
              ? `Start with [${firstPending.id}] "${firstPending.title}". `
              : "") +
            "task.update in_progress → work → verify → done. When run/verify completes: report URL, port, job id, server still running."
          : `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
            "Do NOT start executing until the user accepts the plan. " +
            "If the user's next message gives feedback, that is a REVISION: call plan.create once with the COMPLETE " +
            "updated goal/detail/tasks (full list — omit obsolete steps; do not leave old backend/DB tasks when " +
            "the user dropped them). Then STOP again. Be decisive; do not monologue alternatives. " +
            "The user may discard the plan. After acceptance: task.update in_progress → work → verify → done. " +
            "When run/verify completes: report URL, port, job id, and that the server is still running.",
    };
  }

  if (call.name === "plan.clear") {
    const plan = await loadPlan(session.sessionId).catch(() => undefined);
    if (!plan) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ plan.clear: no active plan to clear\n"),
        modelNote: "plan.clear failed: there is no active plan.",
      };
    }
    const activeResponder = plan.tasks.find(
      (task) =>
        task.responderOwned &&
        (task.state === "pending" || task.state === "in_progress"),
    );
    if (activeResponder) {
      return {
        handled: true,
        ok: false,
        display: chalk.yellow(
          `  ⚠ plan.clear: [${activeResponder.id}] is still owned by an active Responder job\n`,
        ),
        modelNote:
          `plan.clear held: [${activeResponder.id}] "${activeResponder.title}" is still responder-owned and active. ` +
          "Wait for it to settle before clearing the plan so its result is not orphaned.",
      };
    }
    try {
      await deletePlan(session.sessionId);
    } catch {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ plan.clear: could not remove the active plan\n"),
        modelNote:
          "plan.clear failed: the plan could not be durably removed. The active plan remains unchanged.",
      };
    }
    session.planApproved.value = false;
    return {
      handled: true,
      ok: true,
      cleared: true,
      display: chalk.dim("  ✦ plan cleared — no active plan\n"),
      modelNote:
        "Plan cleared. No active plan exists for this session; the task checklist and approval state were discarded. " +
        "Continue without a plan, or call plan.create only if a fresh durable plan is genuinely needed.",
    };
  }

  // task.add / task.update
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ ${call.name}: no active plan — call plan.create first\n`,
      ),
      modelNote:
        `${call.name} failed: there is no active plan. Call plan.create first.`,
    };
  }

  if (call.name === "task.move") {
    const taskRaw =
      typeof call.args.taskId === "string" ? call.args.taskId.trim() : "";
    const taskId = resolvePlanTaskId(plan, taskRaw) ?? taskRaw;
    const beforeRaw =
      typeof call.args.beforeTaskId === "string"
        ? call.args.beforeTaskId.trim()
        : "";
    const afterRaw =
      typeof call.args.afterTaskId === "string"
        ? call.args.afterTaskId.trim()
        : "";
    const position =
      typeof call.args.position === "number" ? call.args.position : undefined;
    const selectors = [Boolean(beforeRaw), Boolean(afterRaw), position !== undefined]
      .filter(Boolean).length;
    if (!plan.tasks.some((task) => task.id === taskId) || selectors !== 1) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ task.move needs a valid taskId and exactly one destination\n"),
        modelNote:
          "task.move failed: use a valid taskId plus exactly one of position, beforeTaskId, or afterTaskId.",
      };
    }
    const remaining = plan.tasks.filter((task) => task.id !== taskId);
    let index = 0;
    if (position !== undefined) {
      if (!Number.isInteger(position) || position < 1) {
        return {
          handled: true,
          ok: false,
          display: chalk.red("  ✗ task.move position must be a positive integer\n"),
          modelNote: "task.move failed: position is one-based and must be a positive integer.",
        };
      }
      index = Math.min(position - 1, remaining.length);
    } else {
      const anchorRaw = beforeRaw || afterRaw;
      const anchorId = resolvePlanTaskId(plan, anchorRaw) ?? anchorRaw;
      if (anchorId === taskId || !remaining.some((task) => task.id === anchorId)) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(`  ✗ task.move: invalid anchor "${anchorRaw}"\n`),
          modelNote: `task.move failed: "${anchorRaw}" is not a different task in ACTIVE PLAN.`,
        };
      }
      const anchorIndex = remaining.findIndex((task) => task.id === anchorId);
      index = beforeRaw ? anchorIndex : anchorIndex + 1;
    }
    const updated = applySessionPlanOperation(plan, {
      type: "moveTask",
      expectedVersion: plan.version ?? 1,
      stepId: taskId,
      index,
    });
    await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, updated);
      return true;
    }).catch(() => undefined);
    return {
      handled: true,
      ok: true,
      plan: updated,
      display: renderPlanForTerminal(updated) + "\n",
      modelNote:
        `Moved [${taskId}] to position ${updated.tasks.findIndex((task) => task.id === taskId) + 1}. ` +
        "Task id, state, evidence, dependencies, and responder linkage were preserved.",
    };
  }

  if (call.name === "task.add") {
    const title = normalizeTaskTitle(
      call.args.title ?? call.args.task ?? call.args.name,
    );
    if (!title || isBareTaskIdTitle(title)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ task.add needs a descriptive title\n"),
        modelNote: "task.add failed: provide a descriptive title, not a bare task id.",
      };
    }
    const parentRaw =
      typeof call.args.parentTaskId === "string"
        ? call.args.parentTaskId
        : typeof call.args.parentId === "string"
          ? call.args.parentId
          : undefined;
    const parentTaskId = parentRaw
      ? resolvePlanTaskId(plan, parentRaw)
      : undefined;
    if (parentRaw && !parentTaskId) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: unknown parent "${parentRaw}"\n`),
        modelNote: `task.add failed: unknown parentTaskId "${parentRaw}". Use a canonical id from ACTIVE PLAN.`,
      };
    }
    const stringArray = (value: unknown): string[] =>
      Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
        : [];
    const dependencies = stringArray(
      call.args.dependencies ?? call.args.dependsOn,
    ).map((dependency) => resolvePlanTaskId(plan, dependency) ?? dependency);
    const unknownDependency = dependencies.find(
      (dependency) => !plan.tasks.some((task) => task.id === dependency),
    );
    if (unknownDependency) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: unknown dependency "${unknownDependency}"\n`),
        modelNote: `task.add failed: unknown dependency "${unknownDependency}". Use canonical ids from ACTIVE PLAN.`,
      };
    }
    const tasksBeforeAdd = plan.tasks.map((candidate) => ({
      ...candidate,
      dependencies: [...(candidate.dependencies ?? [])],
      resourceLocks: [...(candidate.resourceLocks ?? [])],
    }));
    const statusBeforeAdd = plan.status;
    const versionBeforeAdd = plan.version;
    const updatedAtBeforeAdd = plan.updatedAt;
    const task = appendPlanTask(plan, {
      title,
      state: "pending",
      note: typeof call.args.note === "string" ? call.args.note : undefined,
      aliases: [slugifyTaskId(title)].filter(Boolean),
      dependencies,
      resourceLocks: stringArray(
        call.args.resourceLocks ?? call.args.resources,
      ),
      parentTaskId,
    });
    let reportDeferral = "";
    if (classifyTaskTitle(task.title, { planKind: plan.kind }) !== "report") {
      const report = plan.tasks.find(
        (candidate) =>
          !candidate.responderOwned &&
          classifyTaskTitle(candidate.title, { planKind: plan.kind }) === "report",
      );
      if (
        report &&
        report.id !== task.id &&
        report.state !== "done" &&
        report.state !== "skipped" &&
        !task.dependencies?.includes(report.id)
      ) {
        const taskIndex = plan.tasks.findIndex((candidate) => candidate.id === task.id);
        plan.tasks.splice(taskIndex, 1);
        const reportIndex = plan.tasks.findIndex((candidate) => candidate.id === report.id);
        plan.tasks.splice(reportIndex, 0, task);
        report.dependencies = [...new Set([...(report.dependencies ?? []), task.id])];
        if (report.state === "in_progress") report.state = "pending";
        report.note = report.note
          ? `${report.note}; deferred for newly discovered work ${task.id}`
          : `deferred for newly discovered work ${task.id}`;
        reportDeferral = ` Report [${report.id}] was deferred behind this new work.`;
      } else if (report?.state === "done") {
        const update = appendPlanTask(plan, {
          title: `Update final report with findings from ${task.id}`,
          state: "pending",
          aliases: [],
          dependencies: [task.id],
          resourceLocks: [],
          note: `final report update after newly discovered work ${task.id}`,
        });
        reportDeferral = ` Added [${update.id}] to update the completed report after this work.`;
      }
    }
    if (
      session.planApproved.value &&
      (plan.status === "approved" || plan.status === "completed" || plan.status === "abandoned")
    ) {
      plan.status = "in_progress";
    }
    const validation = validateSessionPlan(plan);
    if (!validation.ok) {
      plan.tasks = tasksBeforeAdd;
      plan.status = statusBeforeAdd;
      plan.version = versionBeforeAdd;
      plan.updatedAt = updatedAtBeforeAdd;
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: ${validation.reason}\n`),
        modelNote: `task.add failed: ${validation.reason}.`,
      };
    }
    // Apply the authored foreground layout onto fresh state so a
    // concurrent responder settlement is preserved.
    await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, plan);
      return true;
    }).catch(() => undefined);
    return {
      handled: true,
      ok: true,
      plan,
      display: renderPlanForTerminal(plan) + "\n",
      modelNote:
        `Added [${task.id}] "${task.title}"${parentTaskId ? ` under [${parentTaskId}]` : ""} without rewriting existing tasks.${reportDeferral} ` +
        `Open it with task.update when it becomes ready. Preserve completed work and continue the current task unless this new task is the immediate evidence-driven next action.`,
    };
  }

  const taskIdRaw =
    typeof call.args.taskId === "string"
      ? call.args.taskId
      : typeof call.args.id === "string"
        ? call.args.id
        : "";
  const stateRaw = typeof call.args.state === "string" ? call.args.state : "";
  const note = typeof call.args.note === "string" ? call.args.note : undefined;
  const validStates: TaskState[] = [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];
  if (!validStates.includes(stateRaw as TaskState)) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: state must be one of ${validStates.join(", ")}\n`,
      ),
      modelNote: `task.update failed: state must be one of ${validStates.join(", ")}.`,
    };
  }
  // X3: accept t1..tn or model slug aliases / title slugs.
  const taskId = resolvePlanTaskId(plan, taskIdRaw) ?? taskIdRaw;
  const taskTarget = plan.tasks.find((task) => task.id === taskId);
  if (taskTarget?.responderOwned) {
    return {
      handled: true,
      ok: false,
      display: chalk.yellow(
        `  ⚠ task.update: [${taskId}] is owned by Responder job ${taskTarget.jobId ?? "?"}\n`,
      ),
      modelNote:
        `task.update held: [${taskId}] is a Responder-owned background-job subtask. ` +
        `Do not change it manually; continue independent work or yield. Responder will advance it from the real process result and wake you when analysis is actionable.`,
    };
  }
  
  let dependencyWarning: string | undefined;
  let dependencyWarningToast: string | undefined;

  if (stateRaw === "in_progress") {
    const target = plan.tasks.find((task) => task.id === taskId);
    const ready = readyPlanTasks(plan).some((task) => task.id === taskId);
    const retryingFailedTask = target?.state === "failed";
    if (target?.state === "done" || target?.state === "skipped") {
      const nextPending = readyPlanTasks(plan)[0];
      const nextHint = nextPending
        ? ` Continue with task.update {taskId:"${nextPending.id}", state:"in_progress"} ("${nextPending.title}").`
        : " All ready work is finished — write the final summary if needed.";
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  ✗ task.update: [${taskId}] is already ${target.state} — do not re-open\n`,
        ),
        modelNote:
          `task.update failed: [${taskId}] is already ${target.state}. ` +
          `Do not re-run completed tasks.${nextHint}`,
      };
    }
    if (target?.state !== "in_progress") {
      const otherActive = plan.tasks.find(
        (task) =>
          task.id !== taskId &&
          task.state === "in_progress" &&
          !task.responderOwned,
      );
      if (otherActive) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${otherActive.id}] is still in progress — only one foreground task may be active\n`,
          ),
          modelNote:
            `task.update failed: [${otherActive.id}] "${otherActive.title}" is still in_progress. ` +
            `Defer it first with task.update {taskId:"${otherActive.id}", state:"pending"} (or finish it with "done"; use "failed"/"skipped" with a reason), then open [${taskId}]. ` +
            `Exactly one foreground task may be active at a time; Responder-owned subtasks are exempt.`,
        };
      }
      const incompleteDependencies = (target?.dependencies ?? []).filter((dependency) => {
        const dependencyTask = plan.tasks.find((task) => task.id === dependency);
        return !dependencyTask || (dependencyTask.state !== "done" && dependencyTask.state !== "skipped");
      });
      const heldLocks = new Set(
        plan.tasks
          .filter((task) => task.state === "in_progress" && task.id !== taskId)
          .flatMap((task) => task.resourceLocks ?? []),
      );
      const conflictingLocks = (target?.resourceLocks ?? []).filter((lock) => heldLocks.has(lock));
      if (
        target &&
        incompleteDependencies.length > 0 &&
        !retryingFailedTask &&
        conflictingLocks.length === 0
      ) {
        dependencyWarning = buildDependencyReminder({
          taskId,
          title: target.title,
          targetState: stateRaw,
          blockers: incompleteDependencies.map((id) => ({
            id,
            title: plan.tasks.find((task) => task.id === id)?.title ?? "",
          })),
        });
        dependencyWarningToast = dependencyToast(taskId);
      } else if ((!ready && !retryingFailedTask) || conflictingLocks.length > 0) {
        const nextReady = readyPlanTasks(plan)[0];
        return {
          handled: true,
          ok: false,
          display: chalk.red(`  ✗ task.update: [${taskId}] is not dependency/resource ready\n`),
          modelNote:
            `task.update failed: [${taskId}] is not ready. ` +
            (incompleteDependencies.length ? `Incomplete dependencies: ${incompleteDependencies.join(", ")}. ` : "") +
            (conflictingLocks.length ? `Resources currently locked: ${conflictingLocks.join(", ")}. ` : "") +
            (nextReady
              ? `Open the next ready task first: ${nextReady.id} ("${nextReady.title}").`
              : ""),
        };
      }
    }
    // A retry is a new execution attempt. Previous receipts proved only the
    // failed attempt and must not close the task before recovery work succeeds.
    if (retryingFailedTask && target) target.evidence = undefined;
  }
  if (stateRaw === "done") {
    const target = plan.tasks.find((task) => task.id === taskId);
    const incompleteDependencies = (target?.dependencies ?? []).filter((dependency) => {
      const dependencyTask = plan.tasks.find((task) => task.id === dependency);
      return !dependencyTask || (dependencyTask.state !== "done" && dependencyTask.state !== "skipped");
    });
    if (incompleteDependencies.length > 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.update: cannot complete [${taskId}] before dependencies\n`),
        modelNote: `task.update failed: earlier task/dependency ${incompleteDependencies.join(", ")} is not complete for [${taskId}].`,
      };
    }
    if (target && target.state !== "in_progress") {
      // Soft-auto: pending + dependency-ready → open then complete in one call.
      // Models often skip the ritual in_progress step after work already landed.
      if (target.state === "pending" && incompleteDependencies.length === 0) {
        const opened = markTask(plan, taskId, "in_progress", note);
        if (!opened) {
          return {
            handled: true,
            ok: false,
            display: chalk.red(
              `  ✗ task.update: could not auto-open [${taskId}] before completion\n`,
            ),
            modelNote: `task.update failed: could not auto-open pending [${taskId}].`,
          };
        }
        // Fall through to mark done below (state is now in_progress).
      } else if (target.state === "failed") {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${taskId}] is failed — retry with in_progress first\n`,
          ),
          modelNote:
            `task.update failed: [${taskId}] is failed. ` +
            `Call task.update {taskId:"${taskId}", state:"in_progress"} to retry, then mark done after recovery work.`,
        };
      } else {
        const nextReady = readyPlanTasks(plan)[0];
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${taskId}] must be in_progress before completion\n`,
          ),
          modelNote:
            `task.update failed: [${taskId}] is ${target.state}. ` +
            "Start or retry it, perform fresh work, then mark it done." +
            (nextReady
              ? ` Open next ready: ${nextReady.id} ("${nextReady.title}").`
              : ""),
        };
      }
    }
  }
  const transitionTarget = plan.tasks.find((task) => task.id === taskId);
  if (transitionTarget) {
    const verdict = evaluateTaskTransition(
      transitionTarget.state,
      stateRaw as TaskState,
    );
    if (!verdict.allowed) {
      const nextReady = readyPlanTasks(plan)[0];
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  ✗ task.update: [${taskId}] ${transitionTarget.state} → ${stateRaw} is not a valid transition\n`,
        ),
        modelNote:
          `task.update failed: [${taskId}] ${verdict.reason}. ` +
          (nextReady
            ? `Continue with ${nextReady.id} ("${nextReady.title}").`
            : "All ready work is finished — write the final summary if needed."),
      };
    }
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const idMap = plan.tasks
      .map(
        (t) =>
          `${t.id}="${t.title}"` +
          (t.aliases?.length ? ` (also: ${t.aliases.join(", ")})` : ""),
      )
      .join("; ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskIdRaw}" (have: ${plan.tasks.map((t) => t.id).join(", ")})\n`,
      ),
      modelNote:
        `task.update failed: unknown taskId "${taskIdRaw}". ` +
        `Valid ids (use these, not title text): ${idMap}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const terminal = isPlanTerminal(plan);
  const successful = isPlanSuccessful(plan);
  if (terminal) plan.status = successful ? "completed" : "abandoned";
  // Persist the transition (not the whole snapshot) so a concurrent
  // responder settlement or evidence patch survives.
  const committedStates = new Map(
    plan.tasks.map((task) => [
      task.id,
      { state: task.state, note: task.note },
    ]),
  );
  await mutatePlan(plan.sessionId, (draft) => {
    for (const task of draft.tasks) {
      const desired = committedStates.get(task.id);
      if (!desired) continue;
      // Responder children are owned by process settlement, never by task.update.
      if (task.responderOwned) continue;
      task.state = desired.state;
      if (desired.note !== undefined) task.note = desired.note;
    }
    draft.status = plan.status;
    return true;
  }).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  const nextPending = readyPlanTasks(plan)[0];
  let modelNote: string;
  if (successful) {
    modelNote =
      "Task updated. All required tasks succeeded or were explicitly skipped. Verify the result and give your final summary. " +
      "If a dev server was started: report URL, port, job id, and that it is still running.";
  } else if (terminal) {
    const failed = plan.tasks.filter((task) => task.state === "failed");
    modelNote =
      `Task updated. The plan is terminal but NOT successful: ${failed.length} task(s) failed. ` +
      "Do not claim completion. Report a failed/partial outcome with the failed tasks and remaining user outcome.";
  } else if (stateRaw === "done" && nextPending) {
    modelNote =
      `Task [${taskId}] marked done after verified work. ` +
      `NEXT: open only the next task with task.update {taskId:"${nextPending.id}", state:"in_progress"}, ` +
      `then do work for "${nextPending.title}" only. Wait for tool results before marking that one done. ` +
      "Do not batch later tasks. Do not start a later task's tools early.";
  } else if (stateRaw === "in_progress") {
    modelNote =
      `Task [${taskId}] is now in_progress. Do ONLY this task's work, wait for tool results, ` +
      `and mark done only when you are satisfied the results prove success. ` +
      `Then task.update {taskId:"${taskId}", state:"done"}. Do not open or work on later tasks yet.`;
  } else if (stateRaw === "pending") {
    modelNote =
      `Task [${taskId}] is pending. If you deferred it to switch priorities, ` +
      `explicitly open the intended task with task.update {taskId:"...", state:"in_progress"} before doing work.`;
  } else {
    modelNote = "Task updated. Continue with the next pending task.";
  }
  return {
    handled: true,
    ok: true,
    plan,
    display:
      checklist +
      "\n" +
      (dependencyWarning
        ? chalk.yellow(`  ⚠ ${dependencyWarning}\n`)
        : ""),
    modelNote: dependencyWarning
      ? `${dependencyWarning}\n${modelNote}`
      : modelNote,
    ...(dependencyWarningToast ? { toast: dependencyWarningToast } : {}),
  };
}
