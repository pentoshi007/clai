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
