import {
  foregroundRemaining,
  loadPlan,
  planProgress,
  responderOpenTasks,
} from "../store/plan.js";
import { jobManager } from "../tools/jobs.js";
import type { SessionPolicy } from "./session-policy.js";
import type { ChatMessage } from "../types.js";

export async function buildRichStopSummary(
  messages: ChatMessage[],
  session: SessionPolicy,
  steps: number,
): Promise<string> {
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  const parts: string[] = [];

  parts.push(
    `Session paused after ${steps} steps` +
      (steps > 0 ? " (user chose stop, or a hard limit was reached)." : ".") +
      "\n",
  );

  if (plan) {
    parts.push("## Plan Status");
    parts.push(`Goal: ${plan.goal}`);
    for (const task of plan.tasks) {
      const icon =
        task.state === "done"
          ? "✓"
          : task.state === "in_progress"
            ? "▶"
            : task.state === "failed"
              ? "✗"
              : task.state === "skipped"
                ? "↷"
                : "·";
      parts.push(
        `  ${icon} [${task.id}] (${task.state}) ${task.title}${task.note ? ` — ${task.note}` : ""}`,
      );
    }
    const remaining = foregroundRemaining(plan);
    const inProgress = remaining.find((task) => task.state === "in_progress");
    const next = remaining[0];
    if (inProgress) {
      parts.push(
        `\nResume open task first: ${inProgress.id} — "${inProgress.title}" (do not skip to later tasks).`,
      );
    } else if (next) {
      parts.push(`\nNext task to resume: ${next.id} — "${next.title}"`);
    }
    const progress = planProgress(plan);
    parts.push(`\nProgress: ${progress.done}/${progress.total} tasks done.`);
    const openChildren = responderOpenTasks(plan);
    if (openChildren.length > 0) {
      parts.push(
        `\nResponder subtasks still open (they advance on their own): ` +
          openChildren.map((task) => `[${task.id}] ${task.title}`).join(", "),
      );
    }
  }

  const running = jobManager.getRunningJobs(session.sessionId);
  const recent = jobManager.getRecentJobs(8, session.sessionId);
  if (running.length > 0 || recent.length > 0) {
    parts.push("\n## Background Jobs");
    for (const job of running.slice(0, 8)) {
      parts.push(
        `  ▶ [${job.id}] ${job.status} — ${(job.commandDisplay || job.command).slice(0, 80)}`,
      );
    }
    if (running.length === 0) {
      for (const job of recent.slice(0, 5)) {
        parts.push(
          `  · [${job.id}] ${job.status} — ${(job.commandDisplay || job.command).slice(0, 80)}`,
        );
      }
    }
    parts.push(
      "On continue: shell.jobs / shell.tail relevant ids before re-running the same work.",
    );
  }

  const toolMsgs = messages.filter((m) => m.role === "tool").slice(-20);
  if (toolMsgs.length > 0) {
    parts.push("\n## Key Findings So Far");
    for (const msg of toolMsgs) {
      const firstLine = msg.content.split("\n")[0] ?? "";
      const toolMatch = firstLine.match(/^Tool (\S+) result/);
      if (toolMatch) {
        parts.push(`- ${toolMatch[1]}: ${firstLine.slice(0, 150)}`);
      } else {
        parts.push(`- ${firstLine.slice(0, 150)}`);
      }
    }
  }

  parts.push("\n## To Resume");
  parts.push(
    'Type "continue" to pick up mid-work: re-check jobs and the open task, harvest results, then proceed — do not mark tasks done without evidence.',
  );

  return parts.join("\n");
}
