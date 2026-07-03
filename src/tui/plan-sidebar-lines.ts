import chalk from "chalk";
import stringWidth from "string-width";
import type { SessionPlan, TaskState } from "../store/plan.js";
import { wrapAnsiLine } from "../ui/markdown.js";

const taskGlyph: Record<TaskState, string> = {
  pending: "○",
  in_progress: "◆",
  done: "✓",
  failed: "!",
  skipped: "–",
};

const taskColorFn: Record<TaskState, (s: string) => string> = {
  pending: chalk.gray,
  in_progress: chalk.cyan,
  done: chalk.green,
  failed: chalk.red,
  skipped: chalk.gray,
};

function padTo(text: string, width: number): string {
  const w = stringWidth(text.replace(/\x1b\[[0-9;]*m/g, ""));
  return w < width ? text + " ".repeat(width - w) : text;
}

export function renderPlanSidebarLines(
  plan: SessionPlan,
  width: number,
  height: number,
): string[] {
  const innerHeight = Math.max(1, height - 2); // top + bottom border
  const contentWidth = Math.max(8, width - 4); // border(1)+pad(1) each side
  const done = plan.tasks.filter((task) => task.state === "done").length;
  const percent = plan.tasks.length
    ? Math.round((done / plan.tasks.length) * 100)
    : 0;

  const rowHeight = (index: number) => {
    const task = plan.tasks[index]!;
    const prefix = `${taskGlyph[task.state]} ${index + 1}. `;
    const prefixWidth = stringWidth(prefix);
    const textWidth = Math.max(4, contentWidth - prefixWidth);
    const fullText = `${task.title}${task.note ? ` — ${task.note}` : ""}`;
    return Math.max(1, wrapAnsiLine(fullText, textWidth).length);
  };

  const rowLines = (index: number): string[] => {
    const task = plan.tasks[index]!;
    const color = taskColorFn[task.state];
    const prefix = `${taskGlyph[task.state]} ${index + 1}. `;
    const prefixWidth = stringWidth(prefix);
    const dim = task.state === "done" || task.state === "skipped";
    const bold = task.state === "in_progress";
    const body = `${task.title}${task.note ? ` — ${task.note}` : ""}`;
    const wrapWidth = Math.max(4, contentWidth - prefixWidth);
    
    const wrapped = wrapAnsiLine(body, wrapWidth);
    const styledPrefix = bold ? chalk.bold(color(prefix)) : color(prefix);
    return wrapped.map((piece, i) => {
      let styledPiece = color(piece);
      if (dim) styledPiece = chalk.dim(styledPiece);
      if (bold) styledPiece = chalk.bold(styledPiece);
      return i === 0
        ? styledPrefix + styledPiece
        : " ".repeat(prefixWidth) + styledPiece;
    });
  };

  const footerText =
    plan.status === "draft"
      ? "/implement to approve · Ctrl+H to hide"
      : "Ctrl+H to hide · Ctrl+P for details";
  const footerLines = wrapAnsiLine(footerText, contentWidth).map((l) => chalk.dim(l));

  const head: string[] = [];
  head.push(chalk.bold.cyan("● LIVE PLAN VIEW"));
  for (const g of wrapAnsiLine(plan.goal, contentWidth)) head.push(chalk.bold(g));
  head.push(
    chalk.dim(
      `${plan.status.replace("_", " ")} · ${done}/${plan.tasks.length} · ${percent}%`,
    ),
  );
  head.push(""); // marginTop before task list

  const tasksSectionBudget = Math.max(1, innerHeight - head.length - footerLines.length);

  const inProgress = plan.tasks.findIndex((t) => t.state === "in_progress");
  const firstPending = plan.tasks.findIndex((t) => t.state === "pending");
  const focus = Math.max(0, inProgress >= 0 ? inProgress : firstPending);

  const getSliceHeight = (startIdx: number, endIdx: number) => {
    let h = 0;
    if (startIdx > 0) h += 1;
    for (let i = startIdx; i <= endIdx; i++) {
      h += rowHeight(i);
    }
    if (endIdx < plan.tasks.length - 1) h += 1;
    return h;
  };

  let start = focus;
  let end = focus;

  if (plan.tasks.length > 0) {
    let currentHeight = getSliceHeight(start, end);
    while (true) {
      let expanded = false;
      if (end < plan.tasks.length - 1) {
        const nextHeight = getSliceHeight(start, end + 1);
        if (nextHeight <= tasksSectionBudget) {
          end += 1;
          currentHeight = nextHeight;
          expanded = true;
        }
      }
      if (start > 0) {
        const nextHeight = getSliceHeight(start - 1, end);
        if (nextHeight <= tasksSectionBudget) {
          start -= 1;
          currentHeight = nextHeight;
          expanded = true;
        }
      }
      if (!expanded) break;
    }
  }

  const taskSection: string[] = [];
  if (start > 0) {
    taskSection.push(
      chalk.dim(`↑ ${start} earlier task${start === 1 ? "" : "s"}`),
    );
  }
  for (let index = start; index <= end; index++) {
    taskSection.push(...rowLines(index));
  }
  const hiddenBelow = plan.tasks.length - end - 1;
  if (hiddenBelow > 0) {
    taskSection.push(
      chalk.dim(`↓ ${hiddenBelow} more task${hiddenBelow === 1 ? "" : "s"}`),
    );
  }

  const body: string[] = [...head, ...taskSection];
  const spacer = Math.max(0, innerHeight - body.length - footerLines.length);
  for (let i = 0; i < spacer; i += 1) body.push("");
  body.push(...footerLines);

  while (body.length > innerHeight) {
    body.splice(body.length - footerLines.length - 1, 1);
  }

  const gray = chalk.gray;
  const horizontal = gray("─".repeat(Math.max(0, width - 2)));
  const out: string[] = [gray("┌") + horizontal + gray("┐")];
  for (let i = 0; i < innerHeight; i += 1) {
    const content = body[i] ?? "";
    const inner = " " + padTo(content, contentWidth) + " ";
    out.push(gray("│") + padTo(inner, width - 2) + gray("│"));
  }
  out.push(gray("└") + horizontal + gray("┘"));
  return out;
}
