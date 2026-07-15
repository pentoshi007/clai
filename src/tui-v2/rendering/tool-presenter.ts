/**
 * Pure presentation logic for tool cards (CHAT-004/005, V2-054/055).
 *
 * Collapsed cards must stay cheap even when the spool holds multi‑MB output
 * (no full-string split on every render). Full bodies open in the pager.
 */

import type { BoundedTextState } from "../../app/events/event-buffer.js";
import type { ToolItem, ToolStatus } from "../state/transcript-types.js";
import { sanitizeDisplayText } from "./sanitize-display.js";

const STATUS_GLYPH: Record<ToolStatus, string> = {
  running: "●",
  ok: "✓",
  failed: "✗",
  blocked: "⊘",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "running",
  ok: "done",
  failed: "failed",
  blocked: "blocked",
};

export interface ToolPresentation {
  readonly glyph: string;
  readonly statusLabel: string;
  readonly name: string;
  readonly argsLabel: string | undefined;
  readonly argsDisplay: string | undefined;
  readonly detail: string | undefined;
}

export function presentTool(item: ToolItem): ToolPresentation {
  const argsLabel = item.argsDisplay
    ? item.name === "shell.exec"
      ? "command"
      : "input"
    : undefined;
  let detail: string | undefined;
  if (item.status === "blocked") {
    detail = item.reason;
  } else if (item.status === "failed" && item.summary) {
    const short = item.summary.split("\n")[0]?.trim();
    if (short && short.length <= 120 && !/^Full output saved/i.test(short)) {
      detail = short;
    }
  }
  const statusLabel =
    item.exitCode !== undefined
      ? `${STATUS_LABEL[item.status]} (exit ${item.exitCode})`
      : STATUS_LABEL[item.status];
  return {
    glyph: STATUS_GLYPH[item.status],
    statusLabel,
    name: item.name,
    argsLabel,
    argsDisplay: item.argsDisplay || undefined,
    detail,
  };
}

export interface OutputPresentation {
  readonly lines: readonly string[];
  readonly hiddenAboveCount: number;
  readonly truncatedNotice: string | undefined;
}

const COLLAPSED_HEAD_LINES = 4;
const COLLAPSED_TAIL_LINES = 4;
/**
 * Expanded (Ctrl+O) shows the full cleaned body. Safety caps only kick in for
 * multi‑MB spools so the TUI never tries to mount millions of lines.
 */
const EXPANDED_SAFE_CHARS = 400_000;
const EXPANDED_SAFE_LINES = 4_000;
/** Chars to sample from each end when collapsing huge spool bodies. */
const SAMPLE_CHARS = 4_000;
/** Soft wrap budget for a single preview line in the card (pager has full width). */
const PREVIEW_LINE_CHARS = 96;
/** Slightly wider when expanded so more of each line stays inside the border. */
const EXPANDED_LINE_CHARS = 120;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isSpoolNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t === "ok" || t === "failed" || t === "✓" || t === "✗") return true;
  if (/^full output saved to\b/i.test(t)) return true;
  if (/^Full output saved to:\s*/i.test(t)) return true;
  if (/^\.\.\. full output saved to\b/i.test(t)) return true;
  if (/^\.\.\. live preview truncated/i.test(t)) return true;
  if (/^\(tool still running/i.test(t)) return true;
  if (t === "...") return true;
  if (/^artifact:\s+/i.test(t)) return true;
  // tool.batch progress heartbeats (live only; final body replaces spool).
  if (/^\[batch\]\b/i.test(t)) return true;
  return false;
}

/**
 * Sample start+end of a huge string so we never `.split("\n")` a multi‑MB body
 * just to draw a collapsed card.
 */
export function sampleEnds(raw: string, eachEnd = SAMPLE_CHARS): string {
  if (raw.length <= eachEnd * 2) return raw;
  return `${raw.slice(0, eachEnd)}\n…\n${raw.slice(-eachEnd)}`;
}

function roughLineCount(raw: string): number {
  if (!raw) return 0;
  let n = 1;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

/** Soft-clip a single preview line so long rows never paint past the card border. */
function clipPreviewLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars - 1)}…`;
}

export function cleanToolOutputLines(
  raw: string,
  options: { readonly maxLineChars?: number } = {},
): string[] {
  const maxLineChars = options.maxLineChars ?? PREVIEW_LINE_CHARS;
  const safe = sanitizeDisplayText(raw);
  if (safe.length === 0) return [];
  const out: string[] = [];
  let lastKept: string | undefined;
  for (const line of safe.split("\n")) {
    if (isSpoolNoiseLine(line)) continue;
    if (line.trim() === "" && (out.length === 0 || lastKept === "")) continue;
    if (line === lastKept) continue;
    // Prefer human-readable markdown link titles in the compact card:
    //   [Liz Truss](https://…)  →  Liz Truss
    const deLinked = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    out.push(clipPreviewLine(deLinked, maxLineChars));
    lastKept = line;
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

/**
 * Card body presentation.
 *
 * Collapsed: head + tail with a mid-body “··· N lines more ···” gap so the end
 * of streaming output stays visible. Expanded (Ctrl+O): full cleaned body in
 * place (classic parity). The unbounded raw body always lives in the spool /
 * artifact and the click-to-open pager modal.
 */
export function presentOutput(
  tail: string,
  state: BoundedTextState | undefined,
  expanded: boolean,
): OutputPresentation {
  const totalLines = roughLineCount(tail);
  const truncatedNotice = state?.truncated
    ? `output truncated in memory (${formatBytes(state.droppedBytes)} dropped; full output saved to disk)`
    : undefined;

  if (expanded) {
    // Full in-place body. Only sample when the spool is pathologically large.
    const source =
      tail.length <= EXPANDED_SAFE_CHARS
        ? tail
        : sampleEnds(tail, Math.floor(EXPANDED_SAFE_CHARS / 2));
    const cleaned = cleanToolOutputLines(source, {
      maxLineChars: EXPANDED_LINE_CHARS,
    });
    if (cleaned.length <= EXPANDED_SAFE_LINES) {
      const hidden =
        source !== tail
          ? Math.max(0, totalLines - cleaned.length)
          : 0;
      return { lines: cleaned, hiddenAboveCount: hidden, truncatedNotice };
    }
    // Extreme line counts: keep head+tail so the UI stays responsive.
    const head = cleaned.slice(0, COLLAPSED_HEAD_LINES);
    const visibleTail = cleaned.slice(-COLLAPSED_TAIL_LINES);
    const hiddenAboveCount = Math.max(
      0,
      cleaned.length - COLLAPSED_HEAD_LINES - COLLAPSED_TAIL_LINES,
    );
    return {
      lines: [...head, `··· ${hiddenAboveCount} lines more · open pager ···`, ...visibleTail],
      hiddenAboveCount,
      truncatedNotice,
    };
  }

  // Collapsed: cheap sample + head/tail preview.
  const source = sampleEnds(tail, SAMPLE_CHARS);
  const cleaned = cleanToolOutputLines(source, {
    maxLineChars: PREVIEW_LINE_CHARS,
  });
  const headCount = COLLAPSED_HEAD_LINES;
  const tailCount = COLLAPSED_TAIL_LINES;
  const budget = headCount + tailCount;

  let lines: string[];
  let hiddenAboveCount = 0;

  if (cleaned.length <= budget) {
    lines = cleaned;
    if (source !== tail && totalLines > cleaned.length) {
      hiddenAboveCount = Math.max(0, totalLines - cleaned.length);
    }
  } else {
    const head = cleaned.slice(0, headCount);
    const visibleTail = cleaned.slice(-tailCount);
    hiddenAboveCount = Math.max(
      totalLines - headCount - tailCount,
      cleaned.length - headCount - tailCount,
    );
    lines =
      hiddenAboveCount > 0
        ? [...head, `··· ${hiddenAboveCount} lines more ···`, ...visibleTail]
        : [...head, ...visibleTail];
  }

  return { lines, hiddenAboveCount, truncatedNotice };
}
