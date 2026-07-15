import chalk from "chalk";
import type { SessionPlan, PlanTask, TaskState } from "../store/plan.js";

const CHECKBOX: Record<TaskState, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  failed: "[!]",
  skipped: "[-]",
};

const STATE_COLOR: Record<TaskState, (s: string) => string> = {
  pending: chalk.gray,
  in_progress: chalk.cyan,
  done: chalk.green,
  failed: chalk.red,
  skipped: chalk.dim,
};

function renderTaskLine(task: PlanTask, index: number): string {
  const color = STATE_COLOR[task.state];
  const box = color(CHECKBOX[task.state]);
  const num = chalk.dim(`${index + 1}.`);
  const title = task.state === "done" ? chalk.dim(task.title) : task.title;
  const note = task.note ? chalk.dim(` — ${task.note}`) : "";
  return `  ${box} ${num} ${title}${note}`;
}

/**
 * Compact inline checklist shown after the plan is created and as tasks are
 * marked done. Always safe to print (no width assumptions).
 */
export function renderPlanChecklist(plan: SessionPlan): string {
  const done = plan.tasks.filter((t) => t.state === "done").length;
  const total = plan.tasks.length;
  const lines: string[] = [];
  lines.push(
    chalk.bold(`  📋 ${plan.goal}`) +
      chalk.dim(`  [${done}/${total}]`),
  );
  plan.tasks.forEach((task, i) => lines.push(renderTaskLine(task, i)));
  return lines.join("\n");
}

/**
 * Full plan body for the Ctrl+P pager / `/plan` command. Includes the goal,
 * the comprehensive detail, and the checklist with states.
 */
export function renderPlanDocument(plan: SessionPlan): string {
  const done = plan.tasks.filter((t) => t.state === "done").length;
  const total = plan.tasks.length;
  const lines: string[] = [];
  lines.push(chalk.bold.underline(`Plan: ${plan.goal}`));
  lines.push(
    chalk.dim(
      `kind: ${plan.kind}  ·  status: ${plan.status}  ·  progress: ${done}/${total}  ·  updated: ${plan.updatedAt.replace("T", " ").slice(0, 19)}`,
    ),
  );
  lines.push("");
  if (plan.detail.trim()) {
    lines.push(chalk.bold("Approach"));
    for (const line of plan.detail.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }
  lines.push(chalk.bold("Tasks"));
  plan.tasks.forEach((task, i) => lines.push(renderTaskLine(task, i)));
  lines.push("");
  lines.push(
    chalk.dim(
      plan.status === "approved" || plan.status === "in_progress"
        ? "Approved. The agent is following this plan; tasks are marked as they complete."
        : "Type /implement to approve and have the agent execute this plan, or refine it with another message.",
    ),
  );
  return lines.join("\n");
}

/**
 * Right-aligned side pane for wide terminals (Claude-Code style). Returns
 * undefined when the terminal is too narrow; callers fall back to the inline
 * checklist. The pane is a self-contained block the caller prints; we do not
 * try to anchor it to the right column across redraws (that fights the
 * streaming output), instead we render a clearly delimited panel.
 */
export function renderPlanSidePane(plan: SessionPlan, columns: number): string | undefined {
  const PANE_WIDTH = 34;
  if (columns < PANE_WIDTH + 24) return undefined; // not enough room
  const done = plan.tasks.filter((t) => t.state === "done").length;
  const total = plan.tasks.length;
  const inner = PANE_WIDTH - 2;
  const top = "╭" + "─".repeat(inner) + "╮";
  const bottom = "╰" + "─".repeat(inner) + "╯";
  const rows: string[] = [top];
  const header = fit(`Plan  [${done}/${total}]`, inner - 2);
  rows.push("│ " + chalk.bold(header.padEnd(inner - 2)) + " │");
  rows.push("│" + " ".repeat(inner) + "│");
  plan.tasks.forEach((task) => {
    const color = STATE_COLOR[task.state];
    const box = CHECKBOX[task.state];
    const text = fit(`${box} ${task.title}`, inner - 2);
    rows.push("│ " + color(text.padEnd(inner - 2)) + " │");
  });
  rows.push(bottom);
  return rows.join("\n");
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return text.slice(0, width - 1) + "…";
}
