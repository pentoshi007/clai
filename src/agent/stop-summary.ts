import { loadPlan } from "../store/plan.js";
import type { SessionPolicy } from "./session-policy.js";
import type { ChatMessage } from "../types.js";

/**
 * Build a rich summary when the agent stops (user declined to continue or
 * maxIterations ceiling hit). Includes plan state, key findings, and clear
 * resume instructions so a later "continue" can pick up exactly here.
 */
export async function buildRichStopSummary(
  messages: ChatMessage[],
  session: SessionPolicy,
  steps: number,
): Promise<string> {
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  const parts: string[] = [];

  parts.push(`Session paused after ${steps} steps.\n`);

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
    const next = plan.tasks.find(
      (t) => t.state === "pending" || t.state === "in_progress",
    );
    if (next) {
      parts.push(`\nNext task to resume: ${next.id} — "${next.title}"`);
    }
    const doneCount = plan.tasks.filter((t) => t.state === "done").length;
    parts.push(`\nProgress: ${doneCount}/${plan.tasks.length} tasks done.`);
  }

  // Key findings from tool results (last 20 tool messages)
  const toolMsgs = messages.filter((m) => m.role === "tool").slice(-20);
  if (toolMsgs.length > 0) {
    parts.push("\n## Key Findings So Far");
    for (const msg of toolMsgs) {
      const firstLine = msg.content.split("\n")[0] ?? "";
      // Extract tool name from the structured format "Tool <name> result ..."
      const toolMatch = firstLine.match(/^Tool (\S+) result/);
      if (toolMatch) {
        parts.push(`- ${toolMatch[1]}: ${firstLine.slice(0, 150)}`);
      } else {
        parts.push(`- ${firstLine.slice(0, 150)}`);
      }
    }
  }

  parts.push("\n## To Resume");
  parts.push('Type "continue" to pick up from where this session left off.');

  return parts.join("\n");
}
