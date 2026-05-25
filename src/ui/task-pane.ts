import chalk from "chalk";
import type { TaskPlan, PlanStep, TaskStatus } from "../agent/task-plan.js";

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: chalk.gray("·"),
  running: chalk.cyan("▶"),
  done: chalk.green("✓"),
  failed: chalk.red("✗"),
  skipped: chalk.dim("↷"),
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: chalk.gray("pending"),
  running: chalk.cyan("running"),
  done: chalk.green("done"),
  failed: chalk.red("failed"),
  skipped: chalk.dim("skipped"),
};

function formatStep(step: PlanStep, index: number): string {
  const icon = STATUS_ICONS[step.status];
  const label = step.title;
  const note = step.notes ? chalk.dim(` — ${step.notes}`) : "";
  return `  ${icon} ${chalk.dim(`${index + 1}.`)} ${label}${note}`;
}

/**
 * Render the task plan as an inline block for the terminal. Called after
 * each tool result to show current progress.  The output is compact:
 * typically 3-8 lines for a standard plan.
 */
export function renderTaskPane(plan: TaskPlan): string {
  const lines: string[] = [];
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;
  const failed = plan.steps.filter((s) => s.status === "failed").length;
  const pct = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;

  lines.push(
    chalk.bold(`  📋 ${plan.goal}`) +
      chalk.dim(` [${done}/${total}] ${pct}%`),
  );
  for (let i = 0; i < plan.steps.length; i += 1) {
    lines.push(formatStep(plan.steps[i]!, i));
  }
  return lines.join("\n");
}

/**
 * Render a minimal one-line progress bar suitable for inserting between
 * tool calls. Shows just the current step.
 */
export function renderProgressLine(plan: TaskPlan): string {
  const current = plan.steps.find((s) => s.status === "running");
  if (!current) return "";
  const idx = plan.steps.indexOf(current) + 1;
  const total = plan.steps.length;
  return chalk.dim(`  ◉ step ${idx}/${total}: ${current.title}`);
}

/**
 * Format the full plan for `/tasks` or `/plan` slash commands.
 * More detailed than the inline progress pane.
 */
export function renderTaskPaneDetailed(plan: TaskPlan): string {
  const lines: string[] = [];
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "done").length;

  lines.push("  " + chalk.bold.underline(`Plan: ${plan.goal}`));
  lines.push(
    chalk.dim(`  complexity: ${plan.complexity} | progress: ${done}/${total}`),
  );
  lines.push("");

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!;
    const icon = STATUS_ICONS[step.status];
    const status = STATUS_LABELS[step.status];
    lines.push(`  ${icon} ${chalk.dim(`${i + 1}.`)} ${step.title} ${chalk.dim(`[${status}]`)}`);
    if (step.toolHint) {
      lines.push(chalk.dim(`      tool: ${step.toolHint}`));
    }
    if (step.notes) {
      lines.push(chalk.dim(`      note: ${step.notes}`));
    }
    if (step.successCriteria) {
      lines.push(chalk.dim(`      done when: ${step.successCriteria}`));
    }
  }
  return lines.join("\n");
}
