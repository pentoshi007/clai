import { Chalk } from "chalk";
import type { ColorMode } from "../../app/ports/terminal-port.js";
import type { ToolStatus, TranscriptState } from "../state/transcript-types.js";
import type { Theme } from "./theme.js";

export const TOOL_BALL_WIDTH = 1;
export const TOOL_BALL_INTERVAL_MS = 600;

type RGB = readonly [number, number, number];
const CYCLE: readonly RGB[] = [[240, 82, 78], [64, 204, 123], [250, 204, 21]];
const COLOR_LEVEL = { none: 0, "16": 1, "256": 2, truecolor: 3 } as const;

export function toolBallColorIndex(now: number): number {
  return Math.floor(Math.max(0, now) / TOOL_BALL_INTERVAL_MS) % CYCLE.length;
}

export function toolStatusBall(status: ToolStatus, now: number, theme: Theme, colorMode: ColorMode, unicode = true): string {
  const paint = new Chalk({ level: COLOR_LEVEL[colorMode] });
  const glyph = ballGlyph(status, unicode);
  if (status === "queued" || status === "running") return paint.rgb(...CYCLE[toolBallColorIndex(now)]!)(glyph);
  return paint.hex(status === "ok" ? theme.success : theme.diffDel)(glyph);
}

function ballGlyph(status: ToolStatus, unicode: boolean): string {
  if (unicode) return "●";
  return status === "failed" || status === "blocked" ? "x" : "*";
}

export function hasAnimatedTools(state: TranscriptState): boolean {
  for (const item of state.byId.values()) {
    if (item.kind === "tool" && (item.pending || item.status === "queued" || item.status === "running")) return true;
  }
  return false;
}
