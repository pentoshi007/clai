import type { ToolCallId } from "../../app/events/app-event.js";
import type { BoundedTextState } from "../../app/events/event-buffer.js";
import type { MarkdownStreamCache } from "../../ui-core/rendering/streaming-markdown.js";
import type { TranscriptState } from "../../ui-core/state/transcript-types.js";
import { clipToWidth, joinSeparated, trimTrailingSpaces } from "../render/ansi-text.js";
import type { Glyphs } from "../render/glyphs.js";
import type { InkTheme } from "../render/ink-theme.js";

export interface SpoolReader {
  tail(toolCallId: ToolCallId): string;
  state(toolCallId: ToolCallId): BoundedTextState | undefined;
}

export const EMPTY_SPOOL: SpoolReader = {
  tail: () => "",
  state: () => undefined,
};

export interface BlockContext {
  readonly width: number;
  readonly ink: InkTheme;
  readonly glyphs: Glyphs;
  readonly now: number;
  readonly state: TranscriptState;
  readonly spool: SpoolReader;
  readonly markdownCache: MarkdownStreamCache | undefined;
}

export const SUFFIX_MIN_COLUMNS = 44;

export function separator(ctx: BlockContext): string {
  return ` ${ctx.glyphs.separator} `;
}

export function joinMeta(ctx: BlockContext, parts: readonly (string | undefined)[]): string {
  return joinSeparated(parts, separator(ctx));
}

export function clipRow(ctx: BlockContext, text: string): string {
  return trimTrailingSpaces(clipToWidth(text, ctx.width, ctx.glyphs.ellipsis));
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function hiddenLinesTrailer(
  ctx: BlockContext,
  hidden: number,
  chord: string,
  extra?: string,
): string | undefined {
  if (hidden <= 0) return undefined;
  const body = joinMeta(ctx, [
    `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`,
    chord,
    extra,
  ]);
  return clipRow(ctx, ctx.ink.fg("muted", body));
}
