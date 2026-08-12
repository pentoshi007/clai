import type { ResponderRuntimeState } from "../../app/controllers/session-responder.js";
import type { Mode } from "../../types.js";
import type { StatusDensity } from "./context-limit.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export const ASCII_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

export interface StatusHint {
  readonly short: string;
  readonly expand: string;
}

export function busyCancelHint(_density: StatusDensity): StatusHint {
  return { short: "esc: cancel", expand: "cancel active work" };
}

export function armedCancelHint(): string {
  return "esc again to cancel";
}

export type IdleHintId =
  | "commands"
  | "thinking"
  | "output"
  | "cut-draft"
  | "clear-draft";

export function idleHintIds(
  density: StatusDensity,
  hasDraft = false,
): readonly IdleHintId[] {
  const draft: IdleHintId[] = hasDraft ? ["cut-draft", "clear-draft"] : [];
  if (density === "xs") return [];
  if (density === "sm") return draft;
  if (density === "md") return ["commands", ...draft, "thinking", "output"];
  return ["commands", ...draft, "thinking", "output"];
}

export function statusDensityForWidth(width: number): StatusDensity {
  if (width < 48) return "xs";
  if (width < 68) return "sm";
  if (width < 96) return "md";
  return "lg";
}

export interface ModeIndicatorPresentation {
  readonly label: string;
  readonly description: string;
}

export function modeIndicatorPresentation(mode: Mode): ModeIndicatorPresentation {
  return { label: mode.toUpperCase(), description: "" };
}

export function tasksToggleLabel(
  visible: boolean,
  density: StatusDensity | boolean = "lg",
): string {
  const d: StatusDensity = typeof density === "boolean" ? (density ? "sm" : "lg") : density;
  if (d === "xs") return "^H";
  return "Tasks";
}

export function responderStatusText(
  state: ResponderRuntimeState,
  compact = false,
): string {
  if (state.mode === "idle") return compact ? "R: idle" : "Responder: idle";
  if (state.mode === "off") {
    const pending = state.running + state.ready + state.delivered + state.archived;
    const body = pending > 0 ? `off · ${pending} pending` : "off";
    return compact ? `R: ${body}` : `Responder: ${body}`;
  }
  const parts = [`${state.running} running`];
  if (state.ready > 0) parts.push(`${state.ready} ready`);
  if (state.delivered > 0) parts.push(`${state.delivered} delivered`);
  const body = `listening · ${parts.join(" · ")}`;
  return compact ? `R: ${body}` : `Responder: ${body}`;
}

export function clipSegment(value: string, max: number): string {
  if (max <= 1) return "…";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function cwdViewportWidth(
  width: number,
  density: StatusDensity,
  contentWidth?: number,
): number {
  if (density === "xs") return 0;
  const cap = density === "sm" ? 12 : density === "md" ? 22 : 36;
  const available = Math.max(8, Math.min(cap, Math.floor(width * 0.28)));
  if (contentWidth === undefined) return available;
  return Math.max(1, Math.min(available, Math.floor(contentWidth)));
}

export function formatActivity(activity: string | undefined, maxLen: number): string {
  let base = (activity ?? "waiting for model").replace(/\s+/g, " ").trim() || "working";
  base = base.replace(/^[⏳·•\s]+/, "").replace(/\n/g, " ").trim();
  if (/\/output\b|open full output|Ctrl\+O or|full output saved|\.clai\/outputs/i.test(base)) {
    base = "tool finished";
  }
  if (base.length > maxLen) {
    const toolish = base.match(/^[\w.-]+/);
    base = toolish ? toolish[0]! : `${base.slice(0, Math.max(0, maxLen - 1))}…`;
  }
  if (/rate limited|retrying in/i.test(base) && !base.startsWith("⏳")) {
    base = `⏳ ${base}`;
  }
  return base;
}

export function spinnerFrame(tick: number, unicode: boolean): string {
  const frames = unicode ? SPINNER_FRAMES : ASCII_SPINNER_FRAMES;
  return frames[((tick % frames.length) + frames.length) % frames.length]!;
}
