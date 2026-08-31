
import type {
  PlanStatus,
  PlanTask,
  SessionPlan,
  TaskState,
} from "../../store/plan.js";
import { foregroundActiveTask, planProgress } from "../../store/plan.js";

export interface PlanProgressView {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

export const TASK_GLYPH: Record<TaskState, string> = {
  pending: "○",
  in_progress: "◉",
  done: "✓",
  failed: "✗",
  skipped: "–",
};

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  pending: "pending",
  in_progress: "active",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

export const STATUS_LABEL: Record<PlanStatus, string> = {
  draft: "draft",
  approved: "approved",
  in_progress: "in progress",
  completed: "completed",
  abandoned: "abandoned",
};

export type PlanColorToken =
  | "muted"
  | "foreground"
  | "accent"
  | "success"
  | "activity"
  | "cyan"
  | "magenta"
  | "mode"
  | "response"
  | "diffDel";

export function planStatusColor(status: PlanStatus): PlanColorToken {
  switch (status) {
    case "completed":
      return "success";
    case "in_progress":
    case "approved":
      return "activity";
    case "draft":
      return "cyan";
    case "abandoned":
      return "muted";
    default:
      return "foreground";
  }
}

export function taskStateColor(state: TaskState): PlanColorToken {
  switch (state) {
    case "done":
      return "success";
    case "in_progress":
      return "activity";
    case "failed":
      return "diffDel";
    case "skipped":
      return "muted";
    case "pending":
    default:
      return "foreground";
  }
}

export function progressView(plan: SessionPlan): PlanProgressView {
  const { done, total } = planProgress(plan);
  if (total === 0) return { done: 0, total: 0, label: "no tasks" };
  if (done === total) return { done, total, label: `${done}/${total} complete` };
  return { done, total, label: `${done}/${total} tasks` };
}

export function progressBar(done: number, total: number, width: number): string {
  const w = Math.max(4, Math.min(24, Math.floor(width)));
  if (total <= 0) return "░".repeat(w);
  const filled = Math.max(0, Math.min(w, Math.round((done / total) * w)));
  return `${"█".repeat(filled)}${"░".repeat(w - filled)}`;
}

export function planStatusChip(status: PlanStatus): string {
  switch (status) {
    case "draft":
      return "DRAFT";
    case "approved":
      return "READY";
    case "in_progress":
      return "ACTIVE";
    case "completed":
      return "DONE";
    case "abandoned":
      return "DROPPED";
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive).toUpperCase() || "PLAN";
    }
  }
}

export function taskStateChip(state: TaskState): string {
  switch (state) {
    case "in_progress":
      return "ACTIVE";
    case "done":
      return "DONE";
    case "failed":
      return "FAIL";
    case "skipped":
      return "SKIP";
    case "pending":
    default:
      return "TODO";
  }
}

export function taskLabel(task: PlanTask): string {
  return `${TASK_GLYPH[task.state]} ${task.id}  ${task.title}`;
}

export function activeTaskId(plan: SessionPlan): string | undefined {
  return foregroundActiveTask(plan)?.id;
}

export function orderPlanTasksForDisplay(tasks: readonly PlanTask[]): PlanTask[] {
  const knownIds = new Set(tasks.map((task) => task.id));
  const children = new Map<string, PlanTask[]>();
  const roots: PlanTask[] = [];

  for (const task of tasks) {
    const parentId = task.parentTaskId;
    if (!parentId || parentId === task.id || !knownIds.has(parentId)) {
      roots.push(task);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(task);
    children.set(parentId, siblings);
  }

  const ordered: PlanTask[] = [];
  const visited = new Set<string>();
  const append = (task: PlanTask): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    ordered.push(task);
    for (const child of children.get(task.id) ?? []) append(child);
  };

  for (const root of roots) append(root);
  for (const task of tasks) append(task);
  return ordered;
}

export function taskRowColor(task: PlanTask): PlanColorToken {
  if (!task.responderOwned) return taskStateColor(task.state);
  if (task.state === "pending" || task.state === "in_progress") return "cyan";
  return taskStateColor(task.state);
}

const RESPONDER_GLYPH: Record<TaskState, string> = {
  pending: "◌",
  in_progress: "⟳",
  done: "✓",
  failed: "✗",
  skipped: "–",
};

export function taskGlyph(task: PlanTask): string {
  const glyphs = task.responderOwned ? RESPONDER_GLYPH : TASK_GLYPH;
  return glyphs[task.state] ?? "○";
}

const RESPONDER_PHASE: Record<TaskState, string> = {
  pending: "QUEUED",
  in_progress: "RUNNING",
  done: "DELIVERED",
  failed: "FAILED",
  skipped: "DROPPED",
};

export function taskOwnerChip(task: PlanTask): string | undefined {
  if (!task.responderOwned) return undefined;
  return `RESPONDER · ${RESPONDER_PHASE[task.state] ?? "BACKGROUND"}`;
}

export function wrapPlanText(text: string, width: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const max = Math.max(8, width);
  if (clean.length <= max) return [clean];
  const lines: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    let breakAt = rest.lastIndexOf(" ", max);
    if (breakAt < Math.floor(max * 0.35)) breakAt = max;
    lines.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

export function cleanTaskTitle(task: PlanTask): string {
  let title = task.title.replace(/\s+/g, " ").trim();
  const id = task.id.trim();
  if (!id) return title;
  const re = new RegExp(
    `^\\[?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?\\s*[:.\\-)–—]\\s*`,
    "i",
  );
  title = title.replace(re, "");
  return title || task.title.trim();
}

export function formatPlanPagerDocument(plan: SessionPlan): string {
  const { done, total } = planProgress(plan);
  const goal = plan.goal.trim() || "Untitled plan";
  const updated = plan.updatedAt.replace("T", " ").slice(0, 19);
  const lines: string[] = [];

  lines.push(`# ${goal}`);
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| **Status** | ${STATUS_LABEL[plan.status]} |`);
  lines.push(`| **Progress** | ${done}/${total} tasks |`);
  lines.push(`| **Kind** | ${plan.kind || "general"} |`);
  lines.push(`| **Updated** | ${updated} |`);
  lines.push("");

  const detail = plan.detail.trim();
  if (detail) {
    lines.push("## Approach");
    lines.push("");
    const looksMd =
      /^#{1,6}\s/m.test(detail) ||
      /^[-*]\s/m.test(detail) ||
      /```/.test(detail) ||
      /\*\*/.test(detail);
    if (looksMd) {
      lines.push(detail);
    } else {
      for (const raw of detail.split(/\r?\n/)) {
        const line = raw.replace(/\t/g, "  ").trimEnd();
        lines.push(line.length === 0 ? "" : line);
      }
    }
    lines.push("");
  }

  lines.push(`## Tasks (${total})`);
  lines.push("");

  if (plan.tasks.length === 0) {
    lines.push("*No tasks yet.*");
  } else {
    lines.push("| # | State | Task | Id |");
    lines.push("| ---: | --- | --- | --- |");
    plan.tasks.forEach((task, i) => {
      const glyph = TASK_GLYPH[task.state] ?? "○";
      const state = TASK_STATE_LABEL[task.state] ?? task.state;
      const title = cleanTaskTitle(task).replace(/\|/g, "\\|");
      const note = task.note?.trim()
        ? `<br>*${task.note.trim().replace(/\|/g, "\\|")}*`
        : "";
      lines.push(
        `| ${i + 1} | ${glyph} ${state} | ${title}${note} | \`${task.id}\` |`,
      );
    });
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  if (plan.status === "draft") {
    lines.push(
      "**Next:** `y` / `i` or `/implement` to run · `s` + feedback to revise · `n` discard · or refine in chat.",
    );
  } else if (plan.status === "approved" || plan.status === "in_progress") {
    lines.push("Plan is **approved** — the agent marks tasks as they complete.");
  } else if (plan.status === "completed") {
    lines.push("All tasks **completed**.");
  } else {
    lines.push(`Plan status: **${STATUS_LABEL[plan.status]}**.`);
  }
  lines.push("");
  lines.push("`q`/`Esc` close · `↑↓` scroll · `^r` search");

  return lines.join("\n");
}
