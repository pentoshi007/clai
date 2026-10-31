import type { GoalReport, GoalUpdate, GoalView } from "../../app/controllers/goal-types.js";
import { formatTokenCount } from "../../llm/token-usage.js";
import type { NoticeLevel } from "../state/transcript-types.js";

export const GOAL_GLYPH = "◎";
export const GOAL_GLYPH_ASCII = "o";

export function formatGoalElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ${minutes % 60}m`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function resumeHint(resumeOnPrompt: boolean | undefined): string {
  return resumeOnPrompt === false
    ? "Run /goal resume to continue."
    : "Send a message or run /goal resume to continue.";
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface GoalNotice {
  readonly level: NoticeLevel;
  readonly text: string;
}

export function formatGoalUpdate(update: GoalUpdate): GoalNotice {
  const reason = update.reason?.trim() ?? "";
  switch (update.kind) {
    case "continuing":
      return { level: "info", text: `Goal not met yet · turn ${update.turns ?? 0}: ${reason}` };
    case "achieved": {
      const stats = [
        formatGoalElapsed(update.durationMs ?? 0),
        plural(update.turns ?? 0, "turn"),
        `${formatTokenCount(update.tokens ?? 0, true)} tokens`,
      ].join(" · ");
      return { level: "info", text: `Goal achieved · ${stats}${reason ? `\n${reason}` : ""}` };
    }
    case "failed":
      return { level: "error", text: `Goal failed: ${update.objective}${reason ? `\n${reason}` : ""}` };
    case "paused":
      return { level: "warn", text: `Goal paused: ${sentence(reason || "paused")} ${resumeHint(update.resumeOnPrompt)}` };
    case "resumed":
      return { level: "info", text: `Goal resumed: ${update.objective}` };
    case "cleared":
      return { level: "info", text: `Goal cleared: ${update.objective}` };
    case "replaced":
      return { level: "info", text: `Goal replaced: ${update.objective}` };
    case "unrecoverable":
      return {
        level: "warn",
        text: `Goal cleared after an unrecoverable error: ${sentence(reason || "unknown error")} Run /goal again to continue`,
      };
    case "retrying":
      return {
        level: "warn",
        text: `Goal still active · retrying in ${formatGoalElapsed(update.delayMs ?? 0)} after: ${reason}`,
      };
    case "waiting":
      return reason === "plan mode"
        ? { level: "info", text: "Goal evaluation waits until you leave plan mode." }
        : { level: "info", text: `Goal evaluation deferred until background work finishes: ${reason}` };
  }
}

export type GoalStripTone = "active" | "busy" | "paused";

export interface GoalStripModel {
  readonly tone: GoalStripTone;
  readonly label: string;
  readonly details: readonly string[];
  readonly objective: string;
}

function phaseDetail(view: GoalView, now: number, running: boolean): string | undefined {
  if (view.phase === "evaluating") return "checking";
  if (view.phase === "retrying") {
    return view.retryAt === undefined ? "retrying" : `retrying in ${formatGoalElapsed(Math.max(0, view.retryAt - now))}`;
  }
  if (view.phase === "waiting") {
    return view.waitingFor?.length === 1 && view.waitingFor[0] === "plan mode"
      ? "waits for plan mode to end"
      : "waiting for background work";
  }
  return running ? "working" : undefined;
}

export function goalStripModel(view: GoalView, now: number, running: boolean): GoalStripModel {
  if (view.status === "paused") {
    return {
      tone: "paused",
      label: "goal paused",
      details: ["/goal resume"],
      objective: view.objective,
    };
  }
  const phase = phaseDetail(view, now, running);
  return {
    tone: phase && phase !== "working" ? "busy" : "active",
    label: "goal active",
    details: [
      formatGoalElapsed(now - view.startedAt),
      ...(view.turns > 0 ? [plural(view.turns, "turn")] : []),
      ...(phase ? [phase] : []),
    ],
    objective: view.objective,
  };
}

export function goalStripText(model: GoalStripModel, glyph: string = GOAL_GLYPH, separator = "·"): string {
  return [`${glyph} ${model.label}`, ...model.details, model.objective.replace(/\s+/g, " ")].join(` ${separator} `);
}

function statusLabel(report: GoalReport): string {
  if (report.status === "achieved") return "achieved";
  if (report.status === "paused") return "paused";
  if (report.phase === "evaluating") return "active · checking";
  if (report.phase === "retrying") return "active · retrying";
  if (report.phase === "waiting") return "active · waiting";
  return "active";
}

export function formatGoalStatus(report: GoalReport): string {
  const lines = [
    `**Goal ${statusLabel(report)}**`,
    "",
    `- Condition: ${report.objective}`,
    `- ${report.status === "achieved" ? "Duration" : "Running for"}: ${formatGoalElapsed(report.durationMs)}`,
    `- Turns evaluated: ${report.turns}`,
    `- Tokens: ${formatTokenCount(report.tokens, true)}`,
  ];
  if (report.lastReason) lines.push(`- Last evaluator reason: ${report.lastReason}`);
  if (report.status === "paused" && report.pauseReason) {
    lines.push(`- Paused: ${sentence(report.pauseReason)} ${resumeHint(report.resumeOnPrompt)}`);
  }
  if (report.status !== "achieved") {
    lines.push("", "Commands: `/goal pause`, `/goal resume`, `/goal clear`, `/goal <condition>` to replace it.");
  }
  return lines.join("\n");
}
