/**
 * Pure display helpers for the plan pane + Ctrl+P pager body (PLAN-001, V2-070).
 */

import type {
  PlanStatus,
  PlanTask,
  SessionPlan,
  TaskState,
} from "../../store/plan.js";
import { planProgress } from "../../store/plan.js";

export interface PlanProgressView {
  readonly done: number;
  readonly total: number;
  /** Single compact label, e.g. "8/8 complete" — no bar, no duplication. */
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
  | "mode";

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
      return "accent";
    case "skipped":
      return "muted";
    case "pending":
    default:
      return "muted";
  }
}

export function progressView(plan: SessionPlan): PlanProgressView {
  const { done, total } = planProgress(plan);
  if (total === 0) return { done: 0, total: 0, label: "no tasks" };
  if (done === total) return { done, total, label: `${done}/${total} complete` };
  return { done, total, label: `${done}/${total} tasks` };
}

export function taskLabel(task: PlanTask): string {
  return `${TASK_GLYPH[task.state]} ${task.id}  ${task.title}`;
}

export function activeTaskId(plan: SessionPlan): string | undefined {
  return plan.tasks.find(
    (t) => t.state === "pending" || t.state === "in_progress",
  )?.id;
}

/** Soft-wrap without ellipsis — full text, never truncated. */
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

/**
 * Strip redundant `t1:` / `t1 -` prefixes when the model baked the task id
 * into the title (keeps the pager readable).
 */
export function cleanTaskTitle(task: PlanTask): string {
  let title = task.title.replace(/\s+/g, " ").trim();
  const id = task.id.trim();
  if (!id) return title;
  // t1: … | t1 - … | t1. … | [t1] …
  const re = new RegExp(
    `^\\[?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]?\\s*[:.\\-)–—]\\s*`,
    "i",
  );
  title = title.replace(re, "");
  return title || task.title.trim();
}

const PAGER_WIDTH = 76;
const RULE = "─".repeat(PAGER_WIDTH);

function pushWrapped(
  lines: string[],
  text: string,
  prefix: string,
  width: number,
): void {
  const bodyWidth = Math.max(12, width - prefix.length);
  const wrapped = wrapPlanText(text, bodyWidth);
  for (let i = 0; i < wrapped.length; i++) {
    lines.push(i === 0 ? `${prefix}${wrapped[i]}` : `${" ".repeat(prefix.length)}${wrapped[i]}`);
  }
}

/**
 * Full plan body for the OpenTUI pager (Ctrl+P / /plan).
 * Plain text only — no chalk/ANSI (those look messy in the pager).
 * Tasks are card-like blocks with clear rules between them.
 */
export function formatPlanPagerDocument(plan: SessionPlan): string {
  const { done, total } = planProgress(plan);
  const lines: string[] = [];

  lines.push(plan.goal.trim() || "Untitled plan");
  lines.push("");
  lines.push(
    `Status   ${STATUS_LABEL[plan.status]}    Progress   ${done}/${total}    Kind   ${plan.kind || "general"}`,
  );
  lines.push(`Updated  ${plan.updatedAt.replace("T", " ").slice(0, 19)}`);
  lines.push("");
  lines.push(RULE);
  lines.push("");

  const detail = plan.detail.trim();
  if (detail) {
    lines.push("Approach");
    lines.push("");
    for (const raw of detail.split(/\r?\n/)) {
      const line = raw.replace(/\t/g, "  ");
      if (line.trim() === "") {
        lines.push("");
      } else if (/^#{1,6}\s/.test(line.trim())) {
        lines.push(line.trim().replace(/^#+\s*/, ""));
      } else if (/^[-*•]\s/.test(line.trim()) || /^\d+[.)]\s/.test(line.trim())) {
        pushWrapped(lines, line.trim(), "  ", PAGER_WIDTH);
      } else {
        pushWrapped(lines, line.trim(), "  ", PAGER_WIDTH);
      }
    }
    lines.push("");
    lines.push(RULE);
    lines.push("");
  }

  lines.push(`Tasks  (${total})`);
  lines.push("");

  if (plan.tasks.length === 0) {
    lines.push("  (no tasks)");
  } else {
    plan.tasks.forEach((task, i) => {
      const glyph = TASK_GLYPH[task.state] ?? "○";
      const state = TASK_STATE_LABEL[task.state] ?? task.state;
      const num = String(i + 1).padStart(2, " ");
      const title = cleanTaskTitle(task);

      // Card header: glyph + index + title (wrapped)
      pushWrapped(lines, title, `${glyph}  ${num}.  `, PAGER_WIDTH);
      // State as a clean tag line (not free-floating "done")
      lines.push(`      [${state}]  ${task.id}`);
      if (task.note?.trim()) {
        pushWrapped(lines, task.note.trim(), "      note  ", PAGER_WIDTH);
      }
      // Boundary between tasks
      if (i < plan.tasks.length - 1) {
        lines.push("");
        lines.push(RULE);
        lines.push("");
      }
    });
  }

  lines.push("");
  lines.push(RULE);
  lines.push("");
  if (plan.status === "draft") {
    lines.push("Next: /implement to approve and run, or refine the plan in chat.");
  } else if (plan.status === "approved" || plan.status === "in_progress") {
    lines.push("Plan is approved — the agent marks tasks as they complete.");
  } else if (plan.status === "completed") {
    lines.push("All tasks completed.");
  } else {
    lines.push(`Plan status: ${STATUS_LABEL[plan.status]}.`);
  }
  lines.push("q/esc:close  ·  ↑↓:scroll  ·  ^r:search");

  return lines.join("\n");
}
